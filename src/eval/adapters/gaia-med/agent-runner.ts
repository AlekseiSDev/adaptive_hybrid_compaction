// GAIA agentic task runner. Per Track K (K3), docs/design/K_gaia.md §5.
//
// Single-shot agentic loop (NO user-sim, unlike tau-bench): one user message
// containing the GAIA question, then `generateText({tools, stopWhen:
// stepCountIs(maxSteps)})` drives multi-step ReACT (model → tool_call →
// execute → tool_result → ...) до text-only response or step cap.
//
// AHC middleware wiring mirrors tau-bench/agent-runner.ts:90-125 — when
// `ahcFlags` set, actor model wraps через createAhcMiddleware.

import { mkdir, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LanguageModelV3 } from '@ai-sdk/provider'
import { generateText, stepCountIs, wrapLanguageModel } from 'ai'
import { createAhcMiddleware } from '../../../adapters/ai-sdk-v6.js'
import { SessionScratchpadRegistry } from '../../../adapters/sessionScratchpad.js'
import type { FeatureFlags, HysteresisState, Thresholds } from '../../../core/index.js'
import {
  costFromUsage,
  OPENROUTER_PRICING,
  resolveActorModel,
  type ModelPricing,
} from '../../llm.js'
import {
  mapCoreEventToInstrumentation,
  wrapLlmClientAsLLMCaller,
} from '../../runners/ahc_core.js'
import type { InstrumentationEvent, LLMClient } from '../../types.js'
import { gaiaTools } from '../gaia-tools/index.js'
import { renderGaiaPrompt, type GaiaTask } from '../gaia-med.js'

const GAIA_ACTOR_FLASH_DEFAULT = 'openai/gpt-5.4-mini'
function resolveGaiaActorDefault(): string {
  return resolveActorModel(GAIA_ACTOR_FLASH_DEFAULT)
}
export const GAIA_ACTOR_DEFAULT_MODEL = GAIA_ACTOR_FLASH_DEFAULT

// K-tail-2 (2026-05-26): bumped 20→40 to match Mastra runner (same cap
// ensures cross-baseline comparability). Vanilla `gaia_bench_agent` smoke
// при 20 had 0/25 empty responses, но AHC variant с 20 cap had 11/25
// empty (cap hits 13/25) — AHC's middleware likely consumes some step
// budget on internal LLM calls. Same 40 cap для consistency. Note: AI SDK
// `stopWhen: stepCountIs(N)` counts провайдер-side LLM calls — AHC
// digest/observer/reflection calls идут через separate LLMClient
// (ahcInternalLlmClient), so they shouldn't count. Investigation hook
// if AHC re-run still has cap-hit issue.
const DEFAULT_MAX_STEPS = 40
const FALLBACK_PRICING: ModelPricing = {
  input_per_million_usd: 0,
  output_per_million_usd: 0,
}

export type RunGaiaTaskDeps = {
  actorModel: LanguageModelV3
  actorSystem: string
  actorModelId?: string
  actorPricing?: ModelPricing
  // AHC middleware injection (per design §5.2). When set: wrap actor model
  // through createAhcMiddleware with per-task scratchpad.
  ahcFlags?: Partial<FeatureFlags>
  // K-tail-2 (2026-05-26): optional threshold overrides plumb through к
  // AHC core middleware. Used для experiment "observer 100K / reflector 200K"
  // на GAIA после Mastra-side investigation showed default 30K observer
  // triggers too aggressively на multi-tool tasks (60-95K context windows).
  ahcThresholds?: Partial<Thresholds>
  ahcInternalLlmClient?: LLMClient
  maxSteps?: number
  emit?: (e: InstrumentationEvent) => void
  // Override workspace dir (tests pass a pre-created tmpdir).
  workspaceDir?: string
}

export type GaiaTaskResult = {
  finalText: string
  n_steps: number
  n_tool_calls: number
  cost_usd: number
  totals: { input: number; output: number }
  events: InstrumentationEvent[]
  errors: { turn_index: number; kind: 'api_error'; message: string }[]
}

export async function runGaiaTask(
  task: GaiaTask,
  deps: RunGaiaTaskDeps,
): Promise<GaiaTaskResult> {
  const actorModelId = deps.actorModelId ?? resolveGaiaActorDefault()
  const actorPricing =
    deps.actorPricing ?? OPENROUTER_PRICING[actorModelId] ?? FALLBACK_PRICING
  const events: InstrumentationEvent[] = []
  const errors: GaiaTaskResult['errors'] = []

  // Per-task workspace for python_exec / text_editor / describe_image.
  // Caller may pre-create (tests); else we make a fresh tmpdir.
  const workspaceDir =
    deps.workspaceDir ?? join(tmpdir(), `gaia-task-${randomUUID()}`)
  const ownsWorkspace = deps.workspaceDir === undefined
  if (ownsWorkspace) await mkdir(workspaceDir, { recursive: true })

  let actorModel: LanguageModelV3 = deps.actorModel
  let internalCostUsd = 0
  if (deps.ahcFlags) {
    if (!deps.ahcInternalLlmClient) {
      throw new Error(
        'ahcFlags requires ahcInternalLlmClient for digest/observer calls',
      )
    }
    const scratchpadRegistry = new SessionScratchpadRegistry()
    const hysteresisStateOverride = new Map<string, HysteresisState>()
    const sessionId = `gaia_${String(task.idx).padStart(3, '0')}`
    const baseLlmCaller = wrapLlmClientAsLLMCaller(
      deps.ahcInternalLlmClient,
      actorModelId,
    )
    const middleware = createAhcMiddleware({
      flags: deps.ahcFlags,
      ...(deps.ahcThresholds !== undefined ? { thresholds: deps.ahcThresholds } : {}),
      llmCaller: async (req) => {
        const resp = await baseLlmCaller(req)
        const usd =
          ((resp.usage?.promptTokens ?? 0) * actorPricing.input_per_million_usd +
            (resp.usage?.completionTokens ?? 0) * actorPricing.output_per_million_usd) /
          1_000_000
        if (usd > 0) internalCostUsd += usd
        return resp
      },
      sessionId: () => sessionId,
      scratchpadRegistry,
      hysteresisStateOverride,
      emit: (e) => {
        const mapped = mapCoreEventToInstrumentation(e)
        events.push(mapped)
        deps.emit?.(mapped)
      },
    })
    actorModel = wrapLanguageModel({ model: deps.actorModel, middleware })
  }

  const maxSteps = deps.maxSteps ?? DEFAULT_MAX_STEPS
  const tools = gaiaTools(workspaceDir)
  const userMessage = renderGaiaPrompt(task)

  let finalText = ''
  let toolCallsTotal = 0
  let inputTokens = 0
  let outputTokens = 0
  let mainCostUsd = 0
  let stepsUsed = 0

  try {
    const result = await generateText({
      model: actorModel,
      system: deps.actorSystem,
      messages: [{ role: 'user', content: userMessage }],
      tools,
      stopWhen: stepCountIs(maxSteps),
      temperature: 0,
      // B6: emit AI SDK auto-spans (ai.generateText.*, ai.toolCall × M) under
      // the active eval.task OTel context — Langfuse sees full ReACT tree.
      experimental_telemetry: { isEnabled: true, functionId: 'gaia.agent' },
    })
    finalText = result.text
    stepsUsed = result.steps.length
    for (const s of result.steps) {
      toolCallsTotal += s.toolCalls.length
    }
    inputTokens = result.totalUsage.inputTokens ?? 0
    outputTokens = result.totalUsage.outputTokens ?? 0
    mainCostUsd = costFromUsage(actorModelId, {
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
    })
  } catch (err) {
    errors.push({
      turn_index: 0,
      kind: 'api_error',
      message: `actor (gaia): ${err instanceof Error ? err.message : String(err)}`,
    })
  } finally {
    if (ownsWorkspace) {
      await rm(workspaceDir, { recursive: true, force: true })
    }
  }

  return {
    finalText,
    n_steps: stepsUsed,
    n_tool_calls: toolCallsTotal,
    cost_usd: mainCostUsd + internalCostUsd,
    totals: { input: inputTokens, output: outputTokens },
    events,
    errors,
  }
}
