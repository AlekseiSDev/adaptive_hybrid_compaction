// Tau-bench retail episode runner — Mastra Agent variant. Per Track I (I2).
//
// Mirror `runTauEpisode` (AI SDK variant in `agent-runner.ts`) but actor =
// Mastra `Agent` с registered retail tools. Mastra accepts AI SDK `ToolV5`
// objects directly (см. `docs/investigations/mastra-tools-api.md` H1) — никакой
// translation layer не нужно, retailTools(envState) forward'ятся as-is.
//
// AHC middleware НЕ wires here — `mastra-agent` baseline исключает AHC по дизайну
// (см. design/I_mastra_agent.md §2.5). Это framework-native competitor против
// `tau_bench_agent_ahc`, не AHC-вариант сам по себе.

import { mkdir, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { Agent } from '@mastra/core/agent'
import type { ToolsInput } from '@mastra/core/agent'
import { LibSQLStore } from '@mastra/libsql'
import { Memory } from '@mastra/memory'
import type { LanguageModelV3 } from '@ai-sdk/provider'
import type { ModelMessage } from 'ai'
import { costFromUsage, OPENROUTER_PRICING, resolveActorModel, type ModelPricing } from '../../llm.js'
import type { InstrumentationEvent } from '../../types.js'
import { cloneEnvState, calculateReward } from './env.js'
import { retailTools } from './tools.js'
import type { Episode, EnvState } from './types.js'
import { userSimStep } from './user-sim.js'

// Same defaults as AI SDK variant. AHC_ACTOR_MODEL env override goes through
// `resolveActorModel` — keep symmetry for cross-model sweeps.
const TAU_ACTOR_DEFAULT = 'openai/gpt-5.4-mini'
const TAU_USER_SIM_DEFAULT = 'openai/gpt-4o-mini'
export { TAU_ACTOR_DEFAULT as TAU_MASTRA_ACTOR_DEFAULT_MODEL }
export { TAU_USER_SIM_DEFAULT as TAU_MASTRA_USER_SIM_DEFAULT_MODEL }

function resolveTauActorDefault(): string {
  return resolveActorModel(TAU_ACTOR_DEFAULT)
}

const FALLBACK_PRICING: ModelPricing = { input_per_million_usd: 0, output_per_million_usd: 0 }

export type RunTauEpisodeMastraDeps = {
  // Mastra wires the actor model itself через resolveMastraModel — we pass the
  // raw OpenAI-compatible config object (api key + provider + model + url).
  actorModel: {
    apiKey: string
    providerId: string
    modelId: string
    url: string
  }
  // User-sim continues through AI SDK provider (vanilla — user behavior must
  // stay consistent across sweeps for comparable success rates).
  userSimModel: LanguageModelV3
  actorSystem: string
  actorModelId?: string
  userSimModelId?: string
  actorPricing?: ModelPricing
  storageRootDir?: string
  maxSteps?: number
  emit?: (e: InstrumentationEvent) => void
}

export type EpisodeResultMastra = {
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

const DEFAULT_STORAGE_ROOT = './.mastra'

function safeEpisodeFile(episodeId: string): string {
  return episodeId.replace(/[^a-zA-Z0-9_-]/g, '_')
}

export async function runTauEpisodeMastra(
  episode: Episode,
  deps: RunTauEpisodeMastraDeps,
): Promise<EpisodeResultMastra> {
  const envState = cloneEnvState(episode.initial_state)
  // Mastra принимает AI SDK ToolV5 объекты напрямую (см. investigations/
  // mastra-tools-api.md H1). Closures over envState сохраняются — retail
  // execute()'ы мутируют envState in-place. Cast — Mastra `ToolsInput`
  // вычислительно совместим с AI SDK `ToolSet` (типы distinct branded, но
  // runtime shapes идентичны).
  const tools = retailTools(envState) as unknown as ToolsInput
  const events: InstrumentationEvent[] = []
  const errors: EpisodeResultMastra['errors'] = []

  const actorModelId = deps.actorModelId ?? resolveTauActorDefault()
  const userSimModelId = deps.userSimModelId ?? TAU_USER_SIM_DEFAULT
  const actorPricing = deps.actorPricing ?? OPENROUTER_PRICING[actorModelId] ?? FALLBACK_PRICING
  void actorPricing

  // Per-episode Mastra Agent с LibSQL storage. `episode.episode_id` — unique
  // key; параллельные episodes не сталкиваются (per-task isolation invariant
  // §7.1 design).
  const storageRoot = resolve(deps.storageRootDir ?? DEFAULT_STORAGE_ROOT)
  const safeId = safeEpisodeFile(episode.episode_id)
  const storagePath = resolve(storageRoot, `c1_mastra_agent_tau_${safeId}.db`)
  await mkdir(dirname(storagePath), { recursive: true })

  const storage = new LibSQLStore({
    id: `mastra_agent_tau_${safeId}`,
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
    id: 'ahc_mastra_agent_tau',
    name: 'AHC Mastra Agent (tau-bench retail)',
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

  const threadId = `mastra_agent_tau_${safeId}`
  const resourceId = `ahc_resource_tau_${safeId}`

  const messages: ModelMessage[] = []
  const maxSteps = deps.maxSteps ?? 30
  let stepsUsed = 0
  let toolCallsTotal = 0
  let mainCostUsd = 0
  let lastActorText = ''
  let totalInput = 0
  let totalOutput = 0

  try {
    while (stepsUsed < maxSteps) {
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

      const remainingSteps = maxSteps - stepsUsed
      // Mastra drives the internal ReACT loop (tool_call → execute → tool_result
      // → model → …) до text-only response ИЛИ `maxSteps` cap. Output shape
      // mirrors AI SDK `generateText` (FullOutput: text / usage / steps / response).
      let actorResult
      try {
        actorResult = await agent.generate(messages, {
          memory: {
            thread: threadId,
            resource: resourceId,
          },
          maxSteps: remainingSteps,
          modelSettings: { temperature: 0 },
        })
      } catch (err) {
        errors.push({
          turn_index: stepsUsed,
          kind: 'api_error',
          message: `actor (mastra): ${err instanceof Error ? err.message : String(err)}`,
        })
        break
      }

      // FullOutput.steps[] — per-LLM-call slice; .toolCalls на каждом step.
      stepsUsed += actorResult.steps.length
      for (const s of actorResult.steps) {
        toolCallsTotal += s.toolCalls.length
      }
      // totalUsage aggregate across all internal steps (Mastra docs).
      const aggUsage = actorResult.totalUsage
      const inputTokens = aggUsage.inputTokens ?? 0
      const outputTokens = aggUsage.outputTokens ?? 0
      totalInput += inputTokens
      totalOutput += outputTokens
      mainCostUsd += costFromUsage(actorModelId, {
        prompt_tokens: inputTokens,
        completion_tokens: outputTokens,
      })
      // Push ТОЛЬКО final assistant text в messages. Mastra `response.messages`
      // включает internal tool_call / tool_result steps; их структура у нас не
      // гарантированно well-formed относительно AI SDK shape (наблюдалось:
      // orphan tool_call без paired tool_result когда maxSteps hits cap — это
      // ломает user-sim's `generateText(messages)` валидацию). User-sim видит
      // только natural-language reply агента — этого достаточно для
      // alternation loop. Mastra's own Memory (LibSQL thread) хранит полный
      // chain, agent.generate() видит её на следующем turn'е.
      lastActorText = actorResult.text
      if (lastActorText.length > 0) {
        messages.push({ role: 'assistant', content: lastActorText })
      }
    }
  } finally {
    // Cleanup per-episode SQLite файл. Idempotent — rm с force.
    await rm(storagePath, { force: true })
  }

  const reward = calculateReward(envState, episode.expected_end_state)
  return {
    finalText: lastActorText,
    envState,
    reward,
    n_steps: stepsUsed,
    n_tool_calls: toolCallsTotal,
    cost_usd: mainCostUsd,
    totals: { input: totalInput, output: totalOutput },
    events,
    errors,
  }
}
