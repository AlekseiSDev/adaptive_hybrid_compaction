// Tau-bench agentic episode runner. Per D5 plan Step 5.
//
// Outer alternation loop: user-sim emits next user message → actor `generateText`
// runs internal multi-step ReACT (tool calls dispatched via AI SDK `tool({execute})`
// closures over envState) → checks терминальный текст → user-sim again → repeat
// until ##STOP## or step budget exhausted.
//
// AHC integration (per D5 plan design decision #4 + user pushback): if
// `ahcFlags` set, actor model wraps через `wrapLanguageModel({middleware:
// createAhcMiddleware({sessionId: episode.episode_id, scratchpadRegistry,
// hysteresisStateOverride, ...})})`. User-sim NOT wrapped — customer не under
// test. Mirrors `ahc_core.ts:70-189` pattern.

import type { LanguageModelV3 } from '@ai-sdk/provider'
import {
  generateText,
  stepCountIs,
  wrapLanguageModel,
  type ModelMessage,
} from 'ai'
import { createAhcMiddleware } from '../../../adapters/ai-sdk-v6.js'
import { SessionScratchpadRegistry } from '../../../adapters/sessionScratchpad.js'
import type { FeatureFlags, HysteresisState } from '../../../core/index.js'
import { costFromUsage, OPENROUTER_PRICING, resolveActorModel, type ModelPricing } from '../../llm.js'
import {
  mapCoreEventToInstrumentation,
  wrapLlmClientAsLLMCaller,
} from '../../runners/ahc_core.js'
import type { InstrumentationEvent, LLMClient } from '../../types.js'
import { cloneEnvState, calculateReward } from './env.js'
import { retailTools } from './tools.js'
import type { Episode, EnvState } from './types.js'
import { userSimStep } from './user-sim.js'

// AHC_ACTOR_MODEL env override → shared helper `resolveActorModel`
// (Track H H1, src/eval/llm.ts). User-sim model NOT subject to override
// — customer behavior should stay consistent across sweeps for comparable
// success rates.
// Per decisions.md 2026-05-13 pivot — supersedes gemini-3-flash-preview.
const TAU_ACTOR_FLASH_DEFAULT = 'openai/gpt-5.4-mini'
function resolveTauActorDefault(): string {
  return resolveActorModel(TAU_ACTOR_FLASH_DEFAULT)
}
export const TAU_ACTOR_DEFAULT_MODEL = TAU_ACTOR_FLASH_DEFAULT
export const TAU_USER_SIM_DEFAULT_MODEL = 'openai/gpt-4o-mini'

export type RunTauEpisodeDeps = {
  actorModel: LanguageModelV3
  userSimModel: LanguageModelV3
  actorSystem: string
  actorModelId?: string
  userSimModelId?: string
  actorPricing?: ModelPricing
  // Optional AHC middleware injection. When set: wrap actor model through
  // createAhcMiddleware с per-episode scratchpad. user-sim stays vanilla.
  ahcFlags?: Partial<FeatureFlags>
  // For ahc_core internal calls (digest/observer/reflection) when ahcFlags set.
  // Required if ahcFlags provided.
  ahcInternalLlmClient?: LLMClient
  maxSteps?: number
  emit?: (e: InstrumentationEvent) => void
}

export type EpisodeResult = {
  finalText: string
  envState: EnvState
  reward: number
  n_steps: number
  n_tool_calls: number
  cost_usd: number
  totals: { input: number; output: number }
  events: InstrumentationEvent[]
  errors: { turn_index: number; kind: 'api_error'; message: string }[]
}

const FALLBACK_PRICING: ModelPricing = { input_per_million_usd: 0, output_per_million_usd: 0 }

export async function runTauEpisode(
  episode: Episode,
  deps: RunTauEpisodeDeps,
): Promise<EpisodeResult> {
  const envState = cloneEnvState(episode.initial_state)
  const tools = retailTools(envState)
  const events: InstrumentationEvent[] = []
  const errors: EpisodeResult['errors'] = []

  const actorModelId = deps.actorModelId ?? resolveTauActorDefault()
  const userSimModelId = deps.userSimModelId ?? TAU_USER_SIM_DEFAULT_MODEL
  const actorPricing = deps.actorPricing ?? OPENROUTER_PRICING[actorModelId] ?? FALLBACK_PRICING

  // AHC middleware wiring per D5 plan decision #4. Per-episode scratch +
  // hysteresis; sessionId = episode.episode_id. ahc_core internal calls
  // (digest/observer/reflection) cost is tracked but not separately reported
  // — folded into total episode cost.
  let actorModel: LanguageModelV3 = deps.actorModel
  let internalCostUsd = 0
  if (deps.ahcFlags) {
    if (!deps.ahcInternalLlmClient) {
      throw new Error('ahcFlags requires ahcInternalLlmClient for digest/observer calls')
    }
    const scratchpadRegistry = new SessionScratchpadRegistry()
    const hysteresisStateOverride = new Map<string, HysteresisState>()
    const baseLlmCaller = wrapLlmClientAsLLMCaller(deps.ahcInternalLlmClient, actorModelId)
    const middleware = createAhcMiddleware({
      flags: deps.ahcFlags,
      llmCaller: async (req) => {
        const resp = await baseLlmCaller(req)
        const usd =
          ((resp.usage?.promptTokens ?? 0) * actorPricing.input_per_million_usd +
            (resp.usage?.completionTokens ?? 0) * actorPricing.output_per_million_usd) /
          1_000_000
        if (usd > 0) internalCostUsd += usd
        return resp
      },
      sessionId: () => episode.episode_id,
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

  const messages: ModelMessage[] = []
  const maxSteps = deps.maxSteps ?? 30
  let stepsUsed = 0
  let toolCallsTotal = 0
  let mainCostUsd = 0
  let lastActorText = ''
  let totalInput = 0
  let totalOutput = 0

  while (stepsUsed < maxSteps) {
    // User-sim turn first (kickoff: provides the customer's opening line based
    // on episode.instruction; subsequent turns react to actor's last reply).
    let userResult
    try {
      userResult = await userSimStep(messages, episode.instruction, {
        model: deps.userSimModel,
        modelId: userSimModelId,
      })
    } catch (err) {
      errors.push({
        turn_index: stepsUsed,
        kind: 'api_error',
        message: `user-sim: ${err instanceof Error ? err.message : String(err)}`,
      })
      break
    }
    mainCostUsd += userResult.cost_usd
    stepsUsed += 1
    if (userResult.done) break
    messages.push({ role: 'user', content: userResult.text })
    if (stepsUsed >= maxSteps) break

    // Actor turn. AI SDK orchestrates the inner ReACT loop: model → tool_calls →
    // execute (mutates envState via closures) → tool_results → model → ...
    // until model emits text-only response OR stepCountIs cap reached.
    const remainingSteps = maxSteps - stepsUsed
    let actorResult
    try {
      actorResult = await generateText({
        model: actorModel,
        system: deps.actorSystem,
        messages,
        tools,
        stopWhen: stepCountIs(remainingSteps),
      })
    } catch (err) {
      errors.push({
        turn_index: stepsUsed,
        kind: 'api_error',
        message: `actor: ${err instanceof Error ? err.message : String(err)}`,
      })
      break
    }
    stepsUsed += actorResult.steps.length
    for (const s of actorResult.steps) {
      toolCallsTotal += s.toolCalls.length
    }
    const inputTokens = actorResult.usage.inputTokens ?? 0
    const outputTokens = actorResult.usage.outputTokens ?? 0
    totalInput += inputTokens
    totalOutput += outputTokens
    mainCostUsd += costFromUsage(actorModelId, {
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
    })
    // Append actor's response chain (assistant + tool_calls + tool_results)
    // to messages so the next user-sim turn sees it.
    messages.push(...actorResult.response.messages)
    lastActorText = actorResult.text
  }

  const reward = calculateReward(envState, episode.expected_end_state)
  return {
    finalText: lastActorText,
    envState,
    reward,
    n_steps: stepsUsed,
    n_tool_calls: toolCallsTotal,
    cost_usd: mainCostUsd + internalCostUsd,
    totals: { input: totalInput, output: totalOutput },
    events,
    errors,
  }
}
