// GAIA bench runner factory + re-exports. Per Track K (K3).
//
// Single factory `makeGaiaBenchRunner(config)` handles all baselines on
// gaia-med — full_context (bare OpenRouter) vs ahc_full (wrapped middleware).
// Dispatch is config.baseline-driven; bench routing happens in runner.ts.

import { createOpenAI } from '@ai-sdk/openai'
import type { FeatureFlags, Thresholds } from '../../../core/index.js'
import {
  createOpenRouterClient,
  resolveActorModel,
  resolveLLMClient,
} from '../../llm.js'
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
import {
  GAIA_ANTHROPIC_COMPACT_DEFAULT_MODEL,
  runGaiaTaskAnthropicCompact,
  type GaiaAnthropicCompactModel,
} from './anthropic-compact-runner.js'

export { runGaiaTask, GAIA_ACTOR_DEFAULT_MODEL } from './agent-runner.js'
export type { RunGaiaTaskDeps, GaiaTaskResult } from './agent-runner.js'
export { runGaiaTaskMastra, GAIA_MASTRA_ACTOR_DEFAULT_MODEL } from './mastra-agent-runner.js'
export type { RunGaiaTaskMastraDeps, GaiaTaskResultMastra } from './mastra-agent-runner.js'
export {
  runGaiaTaskAnthropicCompact,
  GAIA_ANTHROPIC_COMPACT_DEFAULT_MODEL,
} from './anthropic-compact-runner.js'
export type {
  RunGaiaTaskAnthropicCompactDeps,
  GaiaTaskResultAnthropicCompact,
  GaiaAnthropicCompactModel,
} from './anthropic-compact-runner.js'

export type MakeGaiaBenchRunnerOpts = {
  actorModelId?: string
  ahcFlags?: Partial<FeatureFlags>
  ahcThresholds?: Partial<Thresholds>
  maxSteps?: number
}

export function makeGaiaBenchRunner(opts: MakeGaiaBenchRunnerOpts): Runner {
  // 2026-05-27 dual-mode: resolveLLMClient dispatches OpenRouter vs LiteLLM via
  // model-prefix naming convention (decisions.md).
  const actorModelId = resolveActorModel(opts.actorModelId ?? GAIA_ACTOR_DEFAULT_MODEL)
  const actorResolved = resolveLLMClient(actorModelId)
  const openai = createOpenAI({
    apiKey: actorResolved.apiKey,
    baseURL: actorResolved.baseURL,
  })
  const actorModel = openai.chat(actorResolved.modelForRequest)
  // AHC internal LLM client (digest/observer/reflection) only when AHC active.
  // Internal calls route through the same endpoint as the actor — keep costs
  // / cache behavior consistent.
  const ahcInternalLlmClient = opts.ahcFlags
    ? createOpenRouterClient({
        apiKey: actorResolved.apiKey,
        baseUrl: actorResolved.baseURL,
        appName: 'AHC',
      })
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
        actorModelId: actorResolved.modelForRequest,
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
  actorModelId?: string
  maxSteps?: number
}

export function makeGaiaMastraAgentRunner(
  opts: MakeGaiaMastraAgentRunnerOpts,
): Runner {
  // 2026-05-27 dual-mode: model-prefix naming convention selects OpenRouter
  // vs LiteLLM.
  const actorModelId = resolveActorModel(
    opts.actorModelId ?? GAIA_MASTRA_ACTOR_DEFAULT_MODEL,
  )
  const actorResolved = resolveLLMClient(actorModelId)

  return {
    name: 'mastra-agent',
    async execute(_conv: Conversation, ctx: RunnerContext): Promise<RunnerResponse> {
      const task = ctx.task.input as GaiaTask
      const result = await runGaiaTaskMastra(task, {
        actorModel: {
          apiKey: actorResolved.apiKey,
          providerId: actorResolved.provider,
          modelId: actorResolved.modelForRequest,
          url: actorResolved.baseURL,
        },
        // System prompt = GAIA_DRIVER_SYSTEM faithful — same that
        // gaia_bench_agent uses → apples-to-apples cross-baseline.
        actorSystem: GAIA_DRIVER_SYSTEM,
        actorModelId: actorResolved.modelForRequest,
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
// 2026-05-27: dispatch lives entirely in resolveLLMClient (model-prefix
// naming). Env-key validation moved to that helper.
export function resolveGaiaRunner(config: ConfigDef): Runner {
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
    ...(ahcFlags !== undefined ? { ahcFlags } : {}),
    ...(ahcThresholds !== undefined ? { ahcThresholds } : {}),
  })
}

// Track K-tail-4 (2026-05-27): Anthropic /compact agent variant для GAIA.
// Uses native Anthropic SDK (см. anthropic-compact-runner.ts) — separate from
// AI SDK v6 path (vanilla/AHC) because beta context_management knobs require
// raw SDK access. Auth priority (mirrors makeAnthropicCompactRunner на AT):
// LITELLM_MASTER_KEY + LITELLM_BASE_URL → ANTHROPIC_API_KEY (direct console
// billing). CLAUDE_CODE_OAUTH_TOKEN не используется здесь — Pro/Max subscription
// rate-limited на programmatic use, не подходит для bench sweeps. Model per-
// config через `actor_model` field в sweep YAML (haiku-4-5 / sonnet-4-6).
export type MakeGaiaAnthropicCompactRunnerOpts = {
  apiKey: string
  baseURL?: string
  model?: GaiaAnthropicCompactModel
  maxSteps?: number
}

export function makeGaiaAnthropicCompactRunner(
  opts: MakeGaiaAnthropicCompactRunnerOpts,
): Runner {
  const model = opts.model ?? GAIA_ANTHROPIC_COMPACT_DEFAULT_MODEL
  return {
    name: 'gaia_bench_agent_anthropic_compact',
    async execute(_conv: Conversation, ctx: RunnerContext): Promise<RunnerResponse> {
      const task = ctx.task.input as GaiaTask
      const result = await runGaiaTaskAnthropicCompact(task, {
        apiKey: opts.apiKey,
        ...(opts.baseURL !== undefined ? { baseURL: opts.baseURL } : {}),
        model,
        actorSystem: GAIA_DRIVER_SYSTEM,
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
        // Diagnostic side-channel — gaiaGrader lifts to Score.secondary.
        bench_extras: {
          n_steps: result.n_steps,
          n_tool_calls: result.n_tool_calls,
          n_compactions: result.n_compactions,
        },
      }
    },
  }
}

// Resolver для baseline=`gaia_bench_agent_anthropic_compact`. Auth priority
// mirrors makeAnthropicCompactRunner на AT path: LiteLLM forwarder (preferred —
// проектный proxy upstream-billet a corporate Anthropic key) → ANTHROPIC_API_KEY
// direct console billing. CLAUDE_CODE_OAUTH_TOKEN не поддерживается здесь
// (Pro/Max subscription rate-limited на programmatic bench use).
export function resolveGaiaAnthropicCompactRunner(config: ConfigDef): Runner {
  const litellmKey = process.env['LITELLM_MASTER_KEY']
  const litellmUrl = process.env['LITELLM_BASE_URL']
  const directKey = process.env['ANTHROPIC_API_KEY']
  const hasLitellm =
    litellmKey !== undefined &&
    litellmKey.length > 0 &&
    litellmUrl !== undefined &&
    litellmUrl.length > 0
  const hasDirect = directKey !== undefined && directKey.length > 0
  if (!hasLitellm && !hasDirect) {
    throw new Error(
      'baseline=gaia_bench_agent_anthropic_compact requires one of: ' +
        'LITELLM_MASTER_KEY + LITELLM_BASE_URL (proxy, preferred) or ' +
        'ANTHROPIC_API_KEY (console direct). Neither is set.',
    )
  }
  // Sweep YAML `actor_model: claude-haiku-4-5-20251001` etc. lands as
  // config.actor_model (a known optional field per ConfigDef schema).
  const modelRaw = config.actor_model
  // LiteLLM path uses dot-form aliases (claude-sonnet-4.6, claude-haiku-4.5).
  // Direct path uses dash-form (claude-sonnet-4-6, claude-haiku-4-5-20251001).
  // Pass model as-is — caller specifies форму подходящую её auth path в YAML.
  if (hasLitellm) {
    return makeGaiaAnthropicCompactRunner({
      apiKey: litellmKey,
      baseURL: litellmUrl,
      ...(modelRaw !== undefined ? { model: modelRaw } : {}),
    })
  }
  return makeGaiaAnthropicCompactRunner({
    apiKey: directKey ?? '',
    ...(modelRaw !== undefined ? { model: modelRaw } : {}),
  })
}
