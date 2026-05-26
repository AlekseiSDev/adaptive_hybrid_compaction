// GAIA Mastra Agent runner. Per Track K-tail (2026-05-26).
//
// Single-shot Mastra Agent over GAIA — NO user-sim (unlike tau-bench),
// just one `agent.generate(promptText, {...})` driving Mastra's internal
// ReACT loop (model → tool_call → execute → tool_result → ... → text).
//
// Mastra accepts AI SDK ToolV5 объекты напрямую (docs/investigations/
// mastra-tools-api.md H1, Track I) — `gaiaTools(workspaceDir)` forwarded
// as-is, cast в `ToolsInput`.
//
// AHC middleware NOT wired here — `mastra-agent` baseline excludes AHC
// (Track I design §2.5). This is framework-native competitor vs
// `gaia_bench_agent_ahc`, не AHC variant.

import { mkdir, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { Agent } from '@mastra/core/agent'
import type { ToolsInput } from '@mastra/core/agent'
import { LibSQLStore } from '@mastra/libsql'
import { Memory } from '@mastra/memory'
import {
  costFromUsage,
  OPENROUTER_PRICING,
  resolveActorModel,
  type ModelPricing,
} from '../../llm.js'
import type { InstrumentationEvent } from '../../types.js'
import { gaiaTools } from '../gaia-tools/index.js'
import { renderGaiaPrompt, type GaiaTask } from '../gaia-med.js'

const GAIA_ACTOR_DEFAULT = 'openai/gpt-5.4-mini'
export { GAIA_ACTOR_DEFAULT as GAIA_MASTRA_ACTOR_DEFAULT_MODEL }

function resolveGaiaActorDefault(): string {
  return resolveActorModel(GAIA_ACTOR_DEFAULT)
}

const FALLBACK_PRICING: ModelPricing = {
  input_per_million_usd: 0,
  output_per_million_usd: 0,
}

const DEFAULT_STORAGE_ROOT = './.mastra'
const DEFAULT_MAX_STEPS = 20

function safeTaskFile(taskId: string): string {
  return taskId.replace(/[^a-zA-Z0-9_-]/g, '_')
}

export type RunGaiaTaskMastraDeps = {
  // Mastra wires actor model itself через OpenAI-compatible config
  // (apiKey + provider + model + url).
  actorModel: {
    apiKey: string
    providerId: string
    modelId: string
    url: string
  }
  actorSystem: string
  actorModelId?: string
  actorPricing?: ModelPricing
  storageRootDir?: string
  workspaceDir?: string
  maxSteps?: number
  emit?: (e: InstrumentationEvent) => void
}

export type GaiaTaskResultMastra = {
  finalText: string
  n_steps: number
  n_tool_calls: number
  cost_usd: number
  totals: { input: number; output: number }
  events: InstrumentationEvent[]
  errors: { turn_index: number; kind: 'api_error'; message: string }[]
}

export async function runGaiaTaskMastra(
  task: GaiaTask,
  deps: RunGaiaTaskMastraDeps,
): Promise<GaiaTaskResultMastra> {
  const events: InstrumentationEvent[] = []
  const errors: GaiaTaskResultMastra['errors'] = []

  const actorModelId = deps.actorModelId ?? resolveGaiaActorDefault()
  const actorPricing =
    deps.actorPricing ?? OPENROUTER_PRICING[actorModelId] ?? FALLBACK_PRICING
  void actorPricing

  // Per-task workspace для filesystem tools (text_editor, python_exec,
  // describe_image). Caller may pre-create (tests); else fresh tmpdir.
  const workspaceDir =
    deps.workspaceDir ?? join(tmpdir(), `gaia-mastra-${randomUUID()}`)
  const ownsWorkspace = deps.workspaceDir === undefined
  if (ownsWorkspace) await mkdir(workspaceDir, { recursive: true })

  // Per-task Mastra Agent с LibSQL storage. `task.idx` — unique per-bench
  // subset; параллельные tasks не сталкиваются.
  const safeId = safeTaskFile(`gaia_${String(task.idx).padStart(3, '0')}`)
  const storageRoot = resolve(deps.storageRootDir ?? DEFAULT_STORAGE_ROOT)
  const storagePath = resolve(storageRoot, `c1_mastra_agent_gaia_${safeId}.db`)
  await mkdir(dirname(storagePath), { recursive: true })

  // Mastra принимает AI SDK ToolV5 напрямую — cast только для типа.
  const tools = gaiaTools(workspaceDir) as unknown as ToolsInput

  const storage = new LibSQLStore({
    id: `mastra_agent_gaia_${safeId}`,
    url: `file:${storagePath}`,
  })
  const memory = new Memory({
    storage,
    options: {
      observationalMemory: {
        model: {
          providerId: deps.actorModel.providerId,
          modelId: actorModelId,
          url: deps.actorModel.url,
          apiKey: deps.actorModel.apiKey,
        },
      },
    },
  })
  const agent = new Agent({
    id: 'ahc_mastra_agent_gaia',
    name: 'AHC Mastra Agent (GAIA cross-domain)',
    instructions: deps.actorSystem,
    model: {
      providerId: deps.actorModel.providerId,
      modelId: actorModelId,
      url: deps.actorModel.url,
      apiKey: deps.actorModel.apiKey,
    },
    memory,
    tools,
  })

  const threadId = `mastra_agent_gaia_${safeId}`
  const resourceId = `ahc_resource_gaia_${safeId}`

  const maxSteps = deps.maxSteps ?? DEFAULT_MAX_STEPS
  const userMessage = renderGaiaPrompt(task)

  let finalText = ''
  let stepsUsed = 0
  let toolCallsTotal = 0
  let mainCostUsd = 0
  let totalInput = 0
  let totalOutput = 0

  try {
    let actorResult
    try {
      // Mastra's agent.generate() doesn't expose experimental_telemetry
      // option (unlike AI SDK generateText). AI SDK auto-spans от Mastra's
      // internal generateText calls всё равно подцепятся к active eval.task
      // OTel context — telemetry работает на уровне OTel context propagation.
      actorResult = await agent.generate(
        [{ role: 'user', content: userMessage }],
        {
          memory: { thread: threadId, resource: resourceId },
          maxSteps,
          modelSettings: { temperature: 0 },
        },
      )
    } catch (err) {
      errors.push({
        turn_index: 0,
        kind: 'api_error',
        message: `actor (mastra-gaia): ${err instanceof Error ? err.message : String(err)}`,
      })
      throw err
    }

    finalText = actorResult.text
    stepsUsed = actorResult.steps.length
    for (const s of actorResult.steps) {
      toolCallsTotal += s.toolCalls.length
    }
    const aggUsage = actorResult.totalUsage
    totalInput = aggUsage.inputTokens ?? 0
    totalOutput = aggUsage.outputTokens ?? 0
    mainCostUsd = costFromUsage(actorModelId, {
      prompt_tokens: totalInput,
      completion_tokens: totalOutput,
    })
  } catch {
    // Error already captured в errors[] above. Swallow re-throw so
    // runner returns partial result (consistent с tau-mastra-agent
    // pattern для error capture без exception bubbling).
  } finally {
    // Cleanup SQLite + workspace. Idempotent — both with force.
    await rm(storagePath, { force: true })
    if (ownsWorkspace) {
      await rm(workspaceDir, { recursive: true, force: true })
    }
  }

  return {
    finalText,
    n_steps: stepsUsed,
    n_tool_calls: toolCallsTotal,
    cost_usd: mainCostUsd,
    totals: { input: totalInput, output: totalOutput },
    events,
    errors,
  }
}
