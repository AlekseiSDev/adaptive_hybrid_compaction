// GAIA bench runner factory + re-exports. Per Track K (K3).
//
// Single factory `makeGaiaBenchRunner(config)` handles all baselines on
// gaia-med — full_context (bare OpenRouter) vs ahc_full (wrapped middleware).
// Dispatch is config.baseline-driven; bench routing happens in runner.ts.

import { createOpenAI } from '@ai-sdk/openai'
import type { FeatureFlags, Thresholds } from '../../../core/index.js'
import { createOpenRouterClient } from '../../llm.js'
import type {
  ConfigDef,
  Conversation,
  RunnerContext,
  RunnerResponse,
  Runner,
} from '../../types.js'
import { type GaiaTask, GAIA_DRIVER_SYSTEM } from '../gaia-med.js'
import {
  GAIA_ACTOR_DEFAULT_MODEL,
  runGaiaTask,
} from './agent-runner.js'
import {
  GAIA_MASTRA_ACTOR_DEFAULT_MODEL,
  runGaiaTaskMastra,
} from './mastra-agent-runner.js'

export { runGaiaTask, GAIA_ACTOR_DEFAULT_MODEL } from './agent-runner.js'
export type { RunGaiaTaskDeps, GaiaTaskResult } from './agent-runner.js'
export { runGaiaTaskMastra, GAIA_MASTRA_ACTOR_DEFAULT_MODEL } from './mastra-agent-runner.js'
export type { RunGaiaTaskMastraDeps, GaiaTaskResultMastra } from './mastra-agent-runner.js'

export type MakeGaiaBenchRunnerOpts = {
  apiKey: string
  baseURL?: string
  actorModelId?: string
  ahcFlags?: Partial<FeatureFlags>
  ahcThresholds?: Partial<Thresholds>
  maxSteps?: number
}

export function makeGaiaBenchRunner(opts: MakeGaiaBenchRunnerOpts): Runner {
  const baseURL = opts.baseURL ?? 'https://openrouter.ai/api/v1'
  const openai = createOpenAI({ apiKey: opts.apiKey, baseURL })
  const envActor = process.env['AHC_ACTOR_MODEL']
  const actorModelId =
    opts.actorModelId ??
    (envActor !== undefined && envActor.length > 0
      ? envActor
      : GAIA_ACTOR_DEFAULT_MODEL)
  const actorModel = openai.chat(actorModelId)
  // AHC internal LLM client (digest/observer/reflection) only when AHC active.
  const ahcInternalLlmClient = opts.ahcFlags
    ? createOpenRouterClient({ apiKey: opts.apiKey, appName: 'AHC' })
    : undefined

  const runnerName = opts.ahcFlags
    ? 'gaia_bench_agent_ahc'
    : 'gaia_bench_agent'

  return {
    name: runnerName,
    async execute(_conv: Conversation, ctx: RunnerContext): Promise<RunnerResponse> {
      const task = ctx.task.input as GaiaTask
      const result = await runGaiaTask(task, {
        actorModel,
        actorSystem: GAIA_DRIVER_SYSTEM,
        actorModelId,
        ...(opts.ahcFlags !== undefined ? { ahcFlags: opts.ahcFlags } : {}),
        ...(opts.ahcThresholds !== undefined ? { ahcThresholds: opts.ahcThresholds } : {}),
        ...(ahcInternalLlmClient !== undefined ? { ahcInternalLlmClient } : {}),
        ...(opts.maxSteps !== undefined ? { maxSteps: opts.maxSteps } : {}),
        ...(ctx.instrumentation !== undefined ? { emit: ctx.instrumentation } : {}),
      })
      return {
        text: result.finalText,
        // GAIA per-step token accounting not split (totals at task level
        // via result.totals → RunRecord.totals). turns[] left empty;
        // future K-tail может wire per-step telemetry если потребуется.
        turns: [],
        errors: result.errors.map((e) => ({
          turn_index: e.turn_index,
          kind: e.kind,
          message: e.message,
        })),
        totals: result.totals,
        cost_usd: result.cost_usd,
        // Diagnostic side-channel — gaiaGrader lifts to Score.secondary.
        bench_extras: {
          n_steps: result.n_steps,
          n_tool_calls: result.n_tool_calls,
        },
      }
    },
  }
}

// Track K-tail (2026-05-26): Mastra Agent variant for `baseline:
// mastra-agent` × `bench: gaia-med`. Parallel к makeGaiaBenchRunner
// (vanilla / AHC) — separate factory keeps Mastra wiring clean.
export type MakeGaiaMastraAgentRunnerOpts = {
  apiKey: string
  baseURL?: string
  actorModelId?: string
  maxSteps?: number
}

export function makeGaiaMastraAgentRunner(
  opts: MakeGaiaMastraAgentRunnerOpts,
): Runner {
  const baseURL = opts.baseURL ?? 'https://openrouter.ai/api/v1'
  const envActor = process.env['AHC_ACTOR_MODEL']
  const actorModelId =
    opts.actorModelId ??
    (envActor !== undefined && envActor.length > 0
      ? envActor
      : GAIA_MASTRA_ACTOR_DEFAULT_MODEL)

  return {
    name: 'mastra-agent',
    async execute(_conv: Conversation, ctx: RunnerContext): Promise<RunnerResponse> {
      const task = ctx.task.input as GaiaTask
      const result = await runGaiaTaskMastra(task, {
        actorModel: {
          apiKey: opts.apiKey,
          providerId: 'openrouter',
          modelId: actorModelId,
          url: baseURL,
        },
        // System prompt = GAIA_DRIVER_SYSTEM faithful — same that
        // gaia_bench_agent uses → apples-to-apples cross-baseline.
        actorSystem: GAIA_DRIVER_SYSTEM,
        actorModelId,
        ...(opts.maxSteps !== undefined ? { maxSteps: opts.maxSteps } : {}),
        ...(ctx.instrumentation !== undefined ? { emit: ctx.instrumentation } : {}),
      })
      return {
        text: result.finalText,
        turns: [],
        errors: result.errors.map((e) => ({
          turn_index: e.turn_index,
          kind: e.kind,
          message: e.message,
        })),
        totals: result.totals,
        cost_usd: result.cost_usd,
        // K-tail diagnostic — gaiaGrader lifts to Score.secondary.
        bench_extras: {
          n_steps: result.n_steps,
          n_tool_calls: result.n_tool_calls,
        },
      }
    },
  }
}

// Resolve baseline+config → Runner на bench=`gaia-med`. Called from
// src/eval/runner.ts dispatch. Per K_gaia.md §5.2 Option A.
export function resolveGaiaRunner(config: ConfigDef): Runner {
  const apiKey = process.env['OPENROUTER_API_KEY']
  if (apiKey === undefined || apiKey.length === 0) {
    throw new Error('OPENROUTER_API_KEY env required for bench=gaia-med')
  }
  // AHC config: either explicit `baseline: ahc_full` (not used here yet),
  // or `ahc_flags`-only config (per existing pattern in defaultRunnerRegistry).
  // Vanilla `full_context` baseline → no AHC wrapping.
  const ahcFlags =
    config.ahc_flags !== undefined
      ? (config.ahc_flags as Partial<FeatureFlags>)
      : undefined
  // K-tail-2: sweep YAML может задать `thresholds` (`OBSERVER_THRESHOLD`,
  // `REFLECTION_THRESHOLD`, etc.) — plumb через middleware для GAIA AHC
  // variant (`gaia_bench_agent_ahc`).
  const ahcThresholds = config.thresholds
  return makeGaiaBenchRunner({
    apiKey,
    ...(ahcFlags !== undefined ? { ahcFlags } : {}),
    ...(ahcThresholds !== undefined ? { ahcThresholds } : {}),
  })
}
