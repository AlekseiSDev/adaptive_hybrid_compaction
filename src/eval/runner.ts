import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { context, ROOT_CONTEXT, SpanStatusCode, trace, type Tracer } from '@opentelemetry/api'
import {
  appendRecord,
  computeConfigId,
  readAllRecords,
  readCompletedTaskIds,
  runDirFor,
  writeMeta,
  writeSummary,
} from './persist.js'
import {
  assistantTrajAdapter,
  createAssistantTrajGrader,
} from './adapters/assistant-traj.js'
import { defaultLlmJudge } from './adapters/assistant-traj.judge.js'
import { gaiaAdapter, gaiaGrader } from './adapters/gaia-med.js'
import {
  makeGaiaMastraAgentRunner,
  resolveGaiaAnthropicCompactRunner,
  resolveGaiaRunner,
} from './adapters/gaia-med/index.js'
import {
  createLoCoMoGrader,
  defaultLocomoJudge,
  locomoAdapter,
} from './adapters/locomo-med.js'
import {
  createLongMemEvalGrader,
  longmemevalAdapter,
} from './adapters/longmemeval-med.js'
import { defaultLmeJudge } from './adapters/longmemeval-med.judge.js'
import { longmemevalMultiturnAdapter } from './adapters/longmemeval-multiturn.js'
import { syntheticAdapter, syntheticGrader } from './adapters/synthetic.js'
import {
  makeTauBenchMastraAgentRunner,
  makeTauBenchRunner,
  taubenchAdapter,
  taubenchGrader,
} from './adapters/tau-bench-retail/index.js'
import { buildRunnerFromBaseline } from './baseline.js'
import { DEFAULT_AGENT_SYSTEM_PROMPT } from '../core/prompts.js'
import { anthropicCompactBaseline } from './baselines/anthropic_compact.js'
import { fullContextBaseline } from './baselines/full_context.js'
import { mastraAgentBaseline } from './baselines/mastra_agent.js'
import { mastraOmBaseline } from './baselines/mastra_om.js'
import { CostTracker } from './cost.js'
import {
  createOpenRouterClient,
  resolveActorModel,
  resolveLLMClient,
} from './llm.js'
import { ahcCoreBaseline } from './runners/ahc_core.js'
import { noopAhcBaseline, noopBaseline } from './runners/stub.js'
import { aggregateTurnEvents } from './telemetry.js'
import type {
  Bench,
  BenchAdapter,
  ConfigDef,
  Grader,
  InstrumentationEvent,
  RunRecord,
  Runner,
  SweepPlan,
  Task,
  TurnRecord,
} from './types.js'

export type AdapterRegistry = {
  resolve: (bench: Bench) => { adapter: BenchAdapter; grader: Grader }
}

export type RunnerRegistry = {
  resolve: (config: ConfigDef) => Runner
}

export type RunSweepOptions = {
  rootDir: string
  gitSha?: string
  // Optional tracer override (for tests). Defaults to globally-registered
  // OTel tracer (set up in src/eval/observability/langfuse.ts); becomes a
  // noop tracer when observability is disabled.
  tracer?: Tracer
  // E0: dry-run mode for pre-flight (E_main-runs §8). When set, cap each
  // (bench × config × seed) cell at `nTasksPerCell` tasks AND skip NDJSON
  // / meta.json / summary.json persistence (results returned in-memory only).
  // CostTracker still observes — caller asserts on result.total_cost_usd /
  // result.halted to verify circuit-breaker behavior.
  dryRun?: { nTasksPerCell: number }
  // E1: task-level parallelism within each (bench × config × seed) cell.
  // Default 1 (sequential — backwards-compat). When >1, tasks within a cell
  // execute in chunks of size `concurrency` via Promise.all; halt poll runs
  // after each chunk (so up to (concurrency-1) extra tasks may complete past
  // the halt threshold). Cells themselves remain sequential — file lock /
  // CostTracker projection accounting easier to reason about.
  concurrency?: number
  // E1: live cap on tasks per cell, orthogonal to `dryRun`. Persists records
  // (unlike dryRun.nTasksPerCell). Used for "mini-smoke" mode: 1 task per
  // cell live spend → validity check → auto-resume to full sweep skips those.
  maxTasksPerCell?: number
  // Escape hatch for "code changed but YAML didn't" scenario. `config_hash` is
  // computed from sweep YAML only, not from baseline source code — so editing
  // e.g. `src/core/observer.ts` and re-running silently appends new-code
  // records to old-code records.ndjson. Listing a `config.id` here deletes the
  // cell-dir (all bench × seed combinations for that config) before the run.
  // CLI flag: `--force=<config_id>[,<id>...]` in scripts/eval.ts.
  forceCellsForConfigs?: ReadonlySet<string>
}

const TASK_INPUT_ATTR = 'langfuse.observation.input'
const TASK_OUTPUT_ATTR = 'langfuse.observation.output'
// B6 (decisions.md 2026-05-26): Langfuse groups traces of one (bench × config ×
// seed) cell under one "session" via this attribute. Recommended key per
// Langfuse OTel convention. Set on eval.task; AI SDK auto-spans inherit through
// OTel context propagation, so we don't dupe it on every child.
const SESSION_ID_ATTR = 'langfuse.session.id'

export function sessionIdFor(bench: Bench, config_id: string, seed: number): string {
  return `${bench}-${config_id}-${String(seed)}`
}

export type RunSweepConfigResult = {
  bench: Bench
  config_id: string
  seed: number
  n_completed: number
  n_skipped: number
  runDir: string
}

export type RunSweepResult = {
  configs: RunSweepConfigResult[]
  halted: boolean
  halt_reason?: string
  total_cost_usd: number
}

// Stub runners are wrapped from Baseline impls in src/eval/runners/stub.ts
// (Step 10 refactor — consistency with Baseline contract; tests in
// src/eval/runner.test.ts cover behavior).
const STUB_RUNNER_FACTORIES: Record<string, () => Runner> = {
  noop_baseline: () => buildRunnerFromBaseline(noopBaseline()),
  noop_ahc: () => buildRunnerFromBaseline(noopAhcBaseline()),
}

export const defaultAdapterRegistry: AdapterRegistry = {
  resolve: (bench) => {
    if (bench === 'synthetic') {
      return { adapter: syntheticAdapter, grader: syntheticGrader }
    }
    if (bench === 'assistant-traj') {
      // Production path: bind real LLM-backed judge from OPENROUTER_API_KEY
      // env. Module-level `assistantTrajGrader` (stub) stays exported for
      // unit tests that don't want to wire an LLM. defaultLlmJudge throws
      // on missing env — symmetric with makeFullContextRunner behavior.
      return {
        adapter: assistantTrajAdapter,
        grader: createAssistantTrajGrader({ llmJudge: defaultLlmJudge() }),
      }
    }
    if (bench === 'longmemeval-med') {
      return {
        adapter: longmemevalAdapter,
        grader: createLongMemEvalGrader({ llmJudge: defaultLmeJudge() }),
      }
    }
    if (bench === 'lme-multiturn') {
      // Same baked LME tasks, same grader — different adapter.prepare shape
      // (multi-turn replay activates AHC observer). Track H P1.
      return {
        adapter: longmemevalMultiturnAdapter,
        grader: createLongMemEvalGrader({ llmJudge: defaultLmeJudge() }),
      }
    }
    if (bench === 'locomo-med') {
      return {
        adapter: locomoAdapter,
        grader: createLoCoMoGrader({ llmJudge: defaultLocomoJudge() }),
      }
    }
    if (bench === 'tau-bench-retail-med') {
      return { adapter: taubenchAdapter, grader: taubenchGrader }
    }
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (bench === 'gaia-med') {
      // Track K. Pure-normalization grader (no LLM judge) — see
      // decisions.md 2026-05-22 (Track K — gaia-med uses pure-normalization).
      return { adapter: gaiaAdapter, grader: gaiaGrader }
    }
    // Defensive: unreachable under TS narrowing, but runtime catches type
    // casts (eg. test's `'fake-bench' as Bench` push-through).
    throw new Error(`bench not registered: ${String(bench)}`)
  },
}

// Per decisions.md 2026-05-13 pivot — supersedes gemini-3-flash-preview.
// OpenAI prompt cache fires automatically (no cache_control plumbing).
// 2026-05-27: dual-mode routing via model-prefix (decisions.md). Default
// `openai/gpt-5.4-mini` → LiteLLM proxy (request sends bare `gpt-5.4-mini`).
// `openrouter/openai/gpt-5.4-mini` (via AHC_ACTOR_MODEL or sweep field) →
// OpenRouter. Helper `resolveLLMClient(modelId)` инкапсулирует диспетч.
const FULL_CONTEXT_DEFAULT_MODEL = 'openai/gpt-5.4-mini'

function makeFullContextRunner(): Runner {
  const modelId = resolveActorModel(FULL_CONTEXT_DEFAULT_MODEL)
  const { apiKey, baseURL, modelForRequest } = resolveLLMClient(modelId)
  const llmClient = createOpenRouterClient({
    apiKey,
    baseUrl: baseURL,
    appName: 'AHC',
    httpReferer: 'https://github.com/AlekseiSDev/adaptive_hybrid_compaction',
  })
  const baseline = fullContextBaseline({
    llmClient,
    model: modelForRequest,
    systemPrompt: DEFAULT_AGENT_SYSTEM_PROMPT,
  })
  return buildRunnerFromBaseline(baseline)
}

function makeMastraOmRunner(): Runner {
  const modelId = resolveActorModel('openai/gpt-5.4-mini')
  const { apiKey, baseURL, modelForRequest } = resolveLLMClient(modelId)
  const baseline = mastraOmBaseline({
    apiKey,
    url: baseURL,
    modelId: modelForRequest,
    systemPrompt: DEFAULT_AGENT_SYSTEM_PROMPT,
  })
  return buildRunnerFromBaseline(baseline)
}

// Track I baseline — full Mastra Agent + tools. Bench-aware dispatch:
//   - tau-bench-retail-med → makeTauBenchMastraAgentRunner (episode loop с
//     registered retail tools, runTauEpisodeMastra)
//   - gaia-med → makeGaiaMastraAgentRunner (single-shot с 5 GAIA tools,
//     Track K-tail 2026-05-26)
//   - text benches (assistant-traj / lme-multiturn / locomo-med) → generic
//     buildRunnerFromBaseline path с пустым tools (tools registration wiring
//     стоит на месте через MastraAgentDeps.tools но не задействован на тексте).
function makeMastraAgentRunner(): Runner {
  const modelId = resolveActorModel('openai/gpt-5.4-mini')
  const { apiKey, baseURL, modelForRequest } = resolveLLMClient(modelId)
  const textBaseline = mastraAgentBaseline({
    apiKey,
    url: baseURL,
    modelId: modelForRequest,
    systemPrompt: DEFAULT_AGENT_SYSTEM_PROMPT,
  })
  const textRunner = buildRunnerFromBaseline(textBaseline)
  // Adapter factories accept the original (pre-resolve) actorModelId — they
  // run resolveLLMClient internally so OpenRouter/LiteLLM dispatch is honored
  // at the bench-specific call site (tau-bench actor model = TAU_ACTOR_DEFAULT,
  // gaia = GAIA_MASTRA_ACTOR_DEFAULT). Pass empty opts → factories use their
  // own defaults + env override.
  const tauRunner = makeTauBenchMastraAgentRunner({})
  const gaiaRunner = makeGaiaMastraAgentRunner({})

  return {
    name: 'mastra-agent',
    async execute(conv, ctx) {
      if (ctx.bench === 'tau-bench-retail-med') {
        return tauRunner.execute(conv, ctx)
      }
      if (ctx.bench === 'gaia-med') {
        return gaiaRunner.execute(conv, ctx)
      }
      return textRunner.execute(conv, ctx)
    },
  }
}

// LiteLLM proxy uses Anthropic's `model_name` field with dot-form aliases
// (e.g. `claude-sonnet-4.6` → upstream `anthropic/claude-sonnet-4-6`). Sending
// the raw dash-form to the proxy yields 400 "Invalid model name". Pinned to
// 4.6 for parity with the direct-Anthropic default; bump together when both
// are upgraded.
const LITELLM_MODEL = 'claude-sonnet-4.6'

function makeAhcCoreRunner(config: ConfigDef): Runner {
  // Provider switch:
  //   - `'openrouter'` (default) / `'litellm'` — generic LLM dispatch through
  //     resolveLLMClient(modelId), naming-convention-driven (2026-05-27).
  //   - `'google_direct'` — Track H P4 cache verification on Gemini direct API.
  //   - `'anthropic_direct'` — E3 cache-hit subset через Anthropic SDK; supports
  //     LiteLLM forwarder (preferred) or ANTHROPIC_API_KEY direct.
  const provider = config.provider ?? 'openrouter'

  let apiKey: string
  let baseURL: string | undefined
  let resolvedModelDefault: string | undefined

  if (provider === 'openrouter' || provider === 'litellm') {
    // Naming convention is single source of truth: `openrouter/...` prefix
    // → OpenRouter; otherwise → LiteLLM. `provider` field здесь — historical
    // label (kept for back-compat in old YAMLs), не override routing. Чтобы
    // переключить endpoint, измените `ahc_flags.model` или AHC_ACTOR_MODEL env.
    const requestedModelRaw =
      (config.ahc_flags?.['model'] as string | undefined) ?? 'openai/gpt-5.4-mini'
    const resolved = resolveLLMClient(resolveActorModel(requestedModelRaw))
    apiKey = resolved.apiKey
    baseURL = resolved.baseURL
    resolvedModelDefault = resolved.modelForRequest
  } else if (provider === 'google_direct') {
    // Track H P4 (2026-05-14): @ai-sdk/google reads GOOGLE_GENERATIVE_AI_API_KEY
    // by default, but our project's .env uses GOOGLE_GENAI_API_KEY (alias).
    // Accept both — alias-key-rename in env was rejected during D fast-track.
    const directKey = process.env['GOOGLE_GENERATIVE_AI_API_KEY']
      ?? process.env['GOOGLE_GENAI_API_KEY']
    if (directKey === undefined || directKey.length === 0) {
      throw new Error(
        'ahc_core runner with provider=google_direct requires ' +
          'GOOGLE_GENERATIVE_AI_API_KEY or GOOGLE_GENAI_API_KEY env var.',
      )
    }
    apiKey = directKey
    // No baseURL — defaults to https://generativelanguage.googleapis.com/v1beta.
    resolvedModelDefault = 'gemini-3-flash-preview'
  } else {
    // provider === 'anthropic_direct': prefer LiteLLM forwarder → fall back to
    // direct ANTHROPIC_API_KEY. CLAUDE_CODE_OAUTH_TOKEN unsupported here
    // (no streaming/cache support through OAuth surface).
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
        'ahc_core runner with provider=anthropic_direct requires one of: ' +
          'LITELLM_MASTER_KEY + LITELLM_BASE_URL (forwarder, preferred) or ' +
          'ANTHROPIC_API_KEY (console direct). Neither is set.',
      )
    }
    if (hasLitellm) {
      apiKey = litellmKey
      baseURL = litellmUrl
      // Default model on LiteLLM path uses dot-form alias (proxy rewrite).
      resolvedModelDefault = 'claude-sonnet-4.6'
    } else {
      apiKey = directKey ?? ''
    }
  }

  const flagsFromConfig = (config.ahc_flags ?? {})
  const modelOverride = flagsFromConfig['model']
  // Strip ahc_core-runner-specific keys (`model`) from FeatureFlags pass-through.
  const { model: _omitModel, ...featureFlagsRaw } = flagsFromConfig
  // For openrouter|litellm provider the modelOverride was already folded into
  // resolveLLMClient above (resolvedModelDefault = post-resolve form). For
  // google_direct / anthropic_direct paths modelOverride still flows through
  // raw (those provider branches don't go through resolveLLMClient).
  const baselineModel =
    provider === 'openrouter' || provider === 'litellm'
      ? resolvedModelDefault
      : typeof modelOverride === 'string'
        ? modelOverride
        : resolvedModelDefault
  const baseline = ahcCoreBaseline({
    apiKey,
    provider,
    ...(baseURL !== undefined ? { baseURL } : {}),
    ...(baselineModel !== undefined ? { model: baselineModel } : {}),
    // Other ahc_flags keys (TRAJECTORY_CLASSIFIER, REFLECTION, etc.) map to
    // FeatureFlags — pass through directly; createAhcMiddleware merges with defaults.
    ahcFlags: featureFlagsRaw,
    // Threshold overrides (e.g. OBSERVER_THRESHOLD=4000 for lme-multiturn sweep).
    // createAhcMiddleware merges with defaultThresholds. Track H P1 plumbing.
    ...(config.thresholds !== undefined ? { thresholds: config.thresholds } : {}),
    // Separate model for AHC internal LLM calls (observer/reflection/digest).
    // Defaults to main actor model — set in sweep YAML when extraction can use
    // a cheaper LLM than the actor. Added 2026-05-27 (Step B observer overhead).
    ...(config.internal_model !== undefined ? { internalModel: config.internal_model } : {}),
    systemPrompt: DEFAULT_AGENT_SYSTEM_PROMPT,
  })
  return buildRunnerFromBaseline(baseline)
}

function makeAnthropicCompactRunner(): Runner {
  // Auth priority: LiteLLM proxy → OAuth (subscription) → API key (console).
  // LiteLLM path runs through a local proxy (e.g. jay-canvas/llm-proxy on
  // :4400) that upstream-billet a corporate Anthropic key; preferred when
  // available because Pro/Max OAuth is severely rate-limited on programmatic
  // use. CLAUDE_CODE_OAUTH_TOKEN comes from `claude setup-token`.
  // See docs/investigations/anthropic-pro-max-oauth.md.
  const litellmKey = process.env['LITELLM_MASTER_KEY']
  const litellmUrl = process.env['LITELLM_BASE_URL']
  const oauthToken = process.env['CLAUDE_CODE_OAUTH_TOKEN']
  const apiKey = process.env['ANTHROPIC_API_KEY']
  const hasLitellm =
    litellmKey !== undefined &&
    litellmKey.length > 0 &&
    litellmUrl !== undefined &&
    litellmUrl.length > 0
  const hasOauth = oauthToken !== undefined && oauthToken.length > 0
  const hasApiKey = apiKey !== undefined && apiKey.length > 0
  if (!hasLitellm && !hasOauth && !hasApiKey) {
    throw new Error(
      'baseline=anthropic_compact requires one of: LITELLM_MASTER_KEY + LITELLM_BASE_URL (Anthropic-protocol proxy), CLAUDE_CODE_OAUTH_TOKEN (Pro/Max subscription billing, via `claude setup-token`), or ANTHROPIC_API_KEY (console credits). Vendor exception per decisions.md 2026-05-13.',
    )
  }
  const baseline = hasLitellm
    ? anthropicCompactBaseline({
        apiKey: litellmKey,
        baseURL: litellmUrl,
        model: LITELLM_MODEL,
        systemPrompt: DEFAULT_AGENT_SYSTEM_PROMPT,
      })
    : hasOauth
      ? anthropicCompactBaseline({
          authToken: oauthToken,
          systemPrompt: DEFAULT_AGENT_SYSTEM_PROMPT,
        })
      : anthropicCompactBaseline({
          apiKey: apiKey ?? '',
          systemPrompt: DEFAULT_AGENT_SYSTEM_PROMPT,
        })
  return buildRunnerFromBaseline(baseline)
}

function makeTauBenchAgentRunner(config: ConfigDef): Runner {
  // 2026-05-27 dual-mode: env-key dispatch moved into makeTauBenchRunner via
  // resolveLLMClient(modelId). For `tau_bench_agent_ahc` baseline, ahc_flags
  // from sweep YAML control AHC middleware behavior. For vanilla
  // `tau_bench_agent`, ahcFlags stays undefined → actor unwrapped.
  const ahcFlagsRaw = config.ahc_flags ?? {}
  return makeTauBenchRunner({
    ...(config.baseline === 'tau_bench_agent_ahc'
      ? { ahcFlags: ahcFlagsRaw }
      : {}),
  })
}

export const defaultRunnerRegistry: RunnerRegistry = {
  resolve: (config) => {
    if (config.baseline === 'full_context') {
      return makeFullContextRunner()
    }
    if (config.baseline === 'mastra_om') {
      return makeMastraOmRunner()
    }
    if (config.baseline === 'mastra-agent') {
      return makeMastraAgentRunner()
    }
    if (config.baseline === 'anthropic_compact') {
      return makeAnthropicCompactRunner()
    }
    if (config.baseline === 'tau_bench_agent' || config.baseline === 'tau_bench_agent_ahc') {
      return makeTauBenchAgentRunner(config)
    }
    if (config.baseline === 'gaia_bench_agent' || config.baseline === 'gaia_bench_agent_ahc') {
      // Track K (K3). Agentic single-shot runner over 5 GAIA tools.
      return resolveGaiaRunner(config)
    }
    if (config.baseline === 'gaia_bench_agent_anthropic_compact') {
      // Track K-tail-4 (2026-05-27). Anthropic /compact + tools — native SDK
      // (не AI SDK) для прохождения beta context_management knobs. Model per-
      // config через `actor_model:` field (haiku-4-5 / sonnet-4-6).
      return resolveGaiaAnthropicCompactRunner(config)
    }
    // `ahc_flags`-only configs (no explicit `baseline`) route to the real
    // ahc_core runner — A6 middleware over AI SDK v6 provider, per B5.
    // To use the offline echo stub instead (smoke without API key), set
    // `baseline: noop_ahc` explicitly.
    if (config.baseline === undefined && config.ahc_flags !== undefined) {
      return makeAhcCoreRunner(config)
    }
    if (config.baseline === undefined) {
      throw new Error(`config ${config.id}: must declare baseline or ahc_flags`)
    }
    const factory = STUB_RUNNER_FACTORIES[config.baseline]
    if (!factory) throw new Error(`unknown runner: ${config.baseline}`)
    return factory()
  },
}

export async function computeTotalTasks(
  plan: SweepPlan,
  adapters: AdapterRegistry,
  opts: { maxTasksPerCell?: number } = {},
): Promise<number> {
  let total = 0
  for (const bench of plan.benches) {
    const { adapter } = adapters.resolve(bench)
    for (const seed of plan.seeds) {
      const tasks = await adapter.loadTasks(seed)
      // Track H P1 (2026-05-14): respect --max-tasks-per-cell CLI cap so
      // CostTracker projection doesn't extrapolate from the FULL baked subset
      // when the sweep is intentionally subsetted. Pre-fix: lme-multiturn
      // 120 baked tasks × 3 configs = 360 in projection, but real run was
      // 30 (cap=10) → projection 12× too high, halt triggered after 20 tasks.
      const perCell = opts.maxTasksPerCell !== undefined
        ? Math.min(tasks.length, opts.maxTasksPerCell)
        : tasks.length
      total += perCell * plan.configs.length
    }
  }
  return total
}

// AHC core baselines populate TurnRecord.{recall,compaction}_events themselves
// (PATH A in src/eval/runners/ahc_core.ts) and also emit the same events via
// ctx.instrumentation for trace correlation (PATH B). Unconditionally merging
// both streams double-counted every event — H6.5 audit numbers ran at 2× true
// density. Baselines without their own per-turn aggregation (tau-bench-retail
// per its episode-turns.test.ts:43 note) still rely on instrumentation
// backfill, so the fallback kicks in only when the turn arrives empty.
// class_signal stays instrumentation-only (no PATH A duplicate exists).
function enrichTurnsWithEvents(
  turns: readonly TurnRecord[],
  events: readonly InstrumentationEvent[],
): TurnRecord[] {
  return turns.map((turn) => {
    const part = aggregateTurnEvents(events, turn.turn_index)
    return {
      ...turn,
      recall_events:
        turn.recall_events.length > 0 ? turn.recall_events : part.recall_events,
      compaction_events:
        turn.compaction_events.length > 0 ? turn.compaction_events : part.compaction_events,
      ...(part.class_signal !== undefined ? { class_signal: part.class_signal } : {}),
    }
  })
}

type TaskOutcome = {
  task_id: string
  record: RunRecord
}

async function executeOneTask(args: {
  bench: Bench
  config: ConfigDef
  config_id: string
  seed: number
  task: Task
  runner: Runner
  grader: Grader
  adapter: BenchAdapter
  tracer: Tracer
}): Promise<TaskOutcome> {
  const { bench, config, config_id, seed, task, runner, grader, adapter, tracer } = args
  const events: InstrumentationEvent[] = []
  const conv = adapter.prepare(task)
  const started_at = Date.now()
  // B6: eval.task starts in ROOT_CONTEXT (not inherited active context) so it
  // becomes its own trace root — eval.sweep is no longer a parent ancestor.
  // langfuse.session.id groups all tasks of the same (bench × config × seed)
  // cell into one Langfuse session in the UI.
  const taskSpan = tracer.startSpan(
    'eval.task',
    {
      attributes: {
        'task.id': task.id,
        bench,
        config_id,
        seed: String(seed),
        [SESSION_ID_ATTR]: sessionIdFor(bench, config_id, seed),
        [TASK_INPUT_ATTR]: JSON.stringify(conv.messages),
      },
    },
    ROOT_CONTEXT,
  )
  let response
  try {
    response = await context.with(
      trace.setSpan(context.active(), taskSpan),
      () =>
        runner.execute(conv, {
          bench,
          config,
          seed,
          task,
          instrumentation: (e) => events.push(e),
          tracer,
        }),
    )
    taskSpan.setAttribute(TASK_OUTPUT_ATTR, response.text)
  } catch (err) {
    taskSpan.recordException(err as Error)
    taskSpan.setStatus({ code: SpanStatusCode.ERROR })
    taskSpan.end()
    throw err
  }
  taskSpan.end()
  const score = await grader.score(task, response)
  const completed_at = Date.now()
  const enrichedTurns = enrichTurnsWithEvents(response.turns, events)
  const recordCost = response.cost_usd + (score.judge_cost_usd ?? 0)
  const record: RunRecord = {
    run_id: randomUUID(),
    bench,
    config_id,
    seed,
    task_id: task.id,
    started_at,
    completed_at,
    score,
    totals: response.totals,
    cost_usd: recordCost,
    turns: enrichedTurns,
    errors: response.errors,
    final_response_text: response.text,
  }
  return { task_id: task.id, record }
}

export async function runSweep(
  plan: SweepPlan,
  adapters: AdapterRegistry,
  runners: RunnerRegistry,
  options: RunSweepOptions,
): Promise<RunSweepResult> {
  const configResults: RunSweepConfigResult[] = []
  const costTracker = new CostTracker()
  const totalTasks = await computeTotalTasks(plan, adapters, {
    ...(options.maxTasksPerCell !== undefined ? { maxTasksPerCell: options.maxTasksPerCell } : {}),
  })
  const tracer = options.tracer ?? trace.getTracer('ahc-eval')

  let halted = false
  let halt_reason: string | undefined
  const dryRun = options.dryRun
  const concurrency = Math.max(1, options.concurrency ?? 1)
  const maxTasksPerCell = options.maxTasksPerCell

  outer: for (const bench of plan.benches) {
    const { adapter, grader } = adapters.resolve(bench)
    for (const config of plan.configs) {
      const runner = runners.resolve(config)
      const config_id = computeConfigId(config)
      for (const seed of plan.seeds) {
        const runDir = runDirFor(options.rootDir, bench, config_id, seed)
        // --force=<config.id>: wipe cell-dir before resume read so old NDJSON
        // can't merge with fresh-code records. No-op if dir doesn't exist.
        if (!dryRun && options.forceCellsForConfigs?.has(config.id) === true) {
          console.warn(`[runSweep] --force: wiping ${runDir}`)
          await rm(runDir, { recursive: true, force: true })
        }
        // Dry-run skips resume logic — every cell starts fresh, no NDJSON read.
        const completed = dryRun ? new Set<string>() : await readCompletedTaskIds(runDir)
        const tasks = await adapter.loadTasks(seed)

        let n_completed = 0

        // Filter out already-completed tasks, apply caps before chunking.
        // maxTasksPerCell is a TOTAL cap (NDJSON-already-completed counts
        // toward it) — pre-fix: cap was applied to pending only, so a cell
        // resumed from N completed + cap=N ran N more tasks (2N total),
        // breaking the contract (Track H P1 surfaced this on lme-multiturn
        // re-launch). Post-fix: cap = max(0, target - already_done).
        const pending = tasks.filter((t) => !completed.has(t.id))
        const n_skipped = tasks.length - pending.length
        let cap: number = pending.length
        if (dryRun) cap = Math.min(cap, dryRun.nTasksPerCell)
        if (maxTasksPerCell !== undefined) {
          const remainingBudget = Math.max(0, maxTasksPerCell - completed.size)
          cap = Math.min(cap, remainingBudget)
        }
        const limited = pending.slice(0, cap)

        // Chunked Promise.all execution. concurrency=1 preserves sequential
        // semantics (chunks of size 1). Halt poll runs after each chunk
        // completes — within-chunk halt cannot interrupt in-flight tasks.
        let cellHalted = false
        for (let i = 0; i < limited.length; i += concurrency) {
          const chunk = limited.slice(i, i + concurrency)
          const outcomes = await Promise.all(
            chunk.map((task) =>
              executeOneTask({
                bench,
                config,
                config_id,
                seed,
                task,
                runner,
                grader,
                adapter,
                tracer,
              }),
            ),
          )
          for (const outcome of outcomes) {
            if (!dryRun) await appendRecord(runDir, outcome.record)
            n_completed += 1
            costTracker.observe(outcome.record)
            const decision = costTracker.shouldHalt({
              budget_usd: plan.budget_usd,
              total_tasks: totalTasks,
            })
            if (decision.halt) {
              halted = true
              halt_reason = decision.reason
              console.warn(`[runSweep] halting: ${decision.reason}`)
              cellHalted = true
            }
          }
          if (cellHalted) break
        }
        if (cellHalted) {
          if (!dryRun) {
            await writeMeta(runDir, {
              config,
              bench,
              seed,
              git_sha: options.gitSha ?? 'unknown',
              timestamp: new Date().toISOString(),
            })
            const allRecords = await readAllRecords(runDir)
            await writeSummary(
              runDir,
              { bench, config_id, seed },
              allRecords,
              { status: 'partial', halt_reason: halt_reason ?? 'unknown' },
            )
          }
          configResults.push({
            bench,
            config_id,
            seed,
            n_completed,
            n_skipped,
            runDir,
          })
          break outer
        }

        if (!dryRun) {
          await writeMeta(runDir, {
            config,
            bench,
            seed,
            git_sha: options.gitSha ?? 'unknown',
            timestamp: new Date().toISOString(),
          })
          const allRecords = await readAllRecords(runDir)
          await writeSummary(
            runDir,
            { bench, config_id, seed },
            allRecords,
            { status: 'complete' },
          )
        }

        configResults.push({
          bench,
          config_id,
          seed,
          n_completed,
          n_skipped,
          runDir,
        })
      }
    }
  }

  return {
    configs: configResults,
    halted,
    ...(halt_reason !== undefined ? { halt_reason } : {}),
    total_cost_usd: costTracker.totalUsd,
  }
}
