import { randomUUID } from 'node:crypto'
import { context, SpanStatusCode, trace, type Tracer } from '@opentelemetry/api'
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
import { syntheticAdapter, syntheticGrader } from './adapters/synthetic.js'
import {
  makeTauBenchRunner,
  taubenchAdapter,
  taubenchGrader,
} from './adapters/tau-bench-retail/index.js'
import { buildRunnerFromBaseline } from './baseline.js'
import { anthropicCompactBaseline } from './baselines/anthropic_compact.js'
import { fullContextBaseline } from './baselines/full_context.js'
import { mastraOmBaseline } from './baselines/mastra_om.js'
import { CostTracker } from './cost.js'
import { createOpenRouterClient } from './llm.js'
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
}

const TASK_INPUT_ATTR = 'langfuse.observation.input'
const TASK_OUTPUT_ATTR = 'langfuse.observation.output'

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
    if (bench === 'locomo-med') {
      return {
        adapter: locomoAdapter,
        grader: createLoCoMoGrader({ llmJudge: defaultLocomoJudge() }),
      }
    }
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (bench === 'tau-bench-retail-med') {
      return { adapter: taubenchAdapter, grader: taubenchGrader }
    }
    // Defensive: unreachable under TS narrowing, but runtime catches type
    // casts (eg. test's `'fake-bench' as Bench` push-through).
    throw new Error(`bench not registered: ${String(bench)}`)
  },
}

const FULL_CONTEXT_DEFAULT_MODEL = 'google/gemini-3-flash-preview'

function makeFullContextRunner(): Runner {
  const apiKey = process.env['OPENROUTER_API_KEY']
  if (!apiKey) {
    throw new Error(
      'OPENROUTER_API_KEY env var is required for baseline=full_context (real LLM wire)',
    )
  }
  const llmClient = createOpenRouterClient({
    apiKey,
    appName: 'AHC',
    httpReferer: 'https://github.com/AlekseiSDev/adaptive_hybrid_compaction',
  })
  const baseline = fullContextBaseline({
    llmClient,
    model: FULL_CONTEXT_DEFAULT_MODEL,
  })
  return buildRunnerFromBaseline(baseline)
}

function makeMastraOmRunner(): Runner {
  const apiKey = process.env['OPENROUTER_API_KEY']
  if (!apiKey) {
    throw new Error(
      'OPENROUTER_API_KEY env var is required for baseline=mastra_om (Mastra wraps OpenRouter via OpenAI-compatible config)',
    )
  }
  const baseline = mastraOmBaseline({ apiKey })
  return buildRunnerFromBaseline(baseline)
}

// LiteLLM proxy uses Anthropic's `model_name` field with dot-form aliases
// (e.g. `claude-sonnet-4.6` → upstream `anthropic/claude-sonnet-4-6`). Sending
// the raw dash-form to the proxy yields 400 "Invalid model name". Pinned to
// 4.6 for parity with the direct-Anthropic default; bump together when both
// are upgraded.
const LITELLM_MODEL = 'claude-sonnet-4.6'

function makeAhcCoreRunner(config: ConfigDef): Runner {
  // E0: provider switch (`'openrouter'` default, `'anthropic_direct'` for E3
  // cache-hit subset). Env var + actor model resolution diverge per provider.
  const provider = config.provider ?? 'openrouter'
  const apiKey =
    provider === 'anthropic_direct'
      ? process.env['ANTHROPIC_API_KEY']
      : process.env['OPENROUTER_API_KEY']
  if (!apiKey) {
    const envName = provider === 'anthropic_direct' ? 'ANTHROPIC_API_KEY' : 'OPENROUTER_API_KEY'
    throw new Error(
      `ahc_core runner with provider=${provider} requires ${envName} env var.`,
    )
  }
  const flagsFromConfig = (config.ahc_flags ?? {})
  const modelOverride = flagsFromConfig['model']
  // Strip ahc_core-runner-specific keys (`model`) from FeatureFlags pass-through.
  const { model: _omitModel, ...featureFlagsRaw } = flagsFromConfig
  const baseline = ahcCoreBaseline({
    apiKey,
    provider,
    // baseURL only meaningful for OpenRouter path; @ai-sdk/anthropic uses SDK default.
    ...(provider === 'openrouter' ? { baseURL: 'https://openrouter.ai/api/v1' } : {}),
    ...(typeof modelOverride === 'string' ? { model: modelOverride } : {}),
    // Other ahc_flags keys (TRAJECTORY_CLASSIFIER, REFLECTION, etc.) map to
    // FeatureFlags — pass through directly; createAhcMiddleware merges with defaults.
    ahcFlags: featureFlagsRaw,
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
      })
    : hasOauth
      ? anthropicCompactBaseline({ authToken: oauthToken })
      : anthropicCompactBaseline({ apiKey: apiKey ?? '' })
  return buildRunnerFromBaseline(baseline)
}

function makeTauBenchAgentRunner(config: ConfigDef): Runner {
  const apiKey = process.env['OPENROUTER_API_KEY']
  if (!apiKey || apiKey.length === 0) {
    throw new Error('tau_bench_agent requires OPENROUTER_API_KEY')
  }
  const ahcFlagsRaw = config.ahc_flags ?? {}
  // For `tau_bench_agent_ahc` baseline, ahc_flags from sweep YAML control
  // AHC middleware behavior (TRAJECTORY_CLASSIFIER, REFLECTION, etc.).
  // For vanilla `tau_bench_agent`, ahcFlags stays undefined → actor unwrapped.
  return makeTauBenchRunner({
    apiKey,
    baseURL: 'https://openrouter.ai/api/v1',
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
    if (config.baseline === 'anthropic_compact') {
      return makeAnthropicCompactRunner()
    }
    if (config.baseline === 'tau_bench_agent' || config.baseline === 'tau_bench_agent_ahc') {
      return makeTauBenchAgentRunner(config)
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
): Promise<number> {
  let total = 0
  for (const bench of plan.benches) {
    const { adapter } = adapters.resolve(bench)
    for (const seed of plan.seeds) {
      const tasks = await adapter.loadTasks(seed)
      total += tasks.length * plan.configs.length
    }
  }
  return total
}

function enrichTurnsWithEvents(
  turns: readonly TurnRecord[],
  events: readonly InstrumentationEvent[],
): TurnRecord[] {
  return turns.map((turn) => {
    const part = aggregateTurnEvents(events, turn.turn_index)
    return {
      ...turn,
      recall_events: [...turn.recall_events, ...part.recall_events],
      compaction_events: [...turn.compaction_events, ...part.compaction_events],
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
  const taskSpan = tracer.startSpan('eval.task', {
    attributes: {
      'task.id': task.id,
      bench,
      config_id,
      seed: String(seed),
      [TASK_INPUT_ATTR]: JSON.stringify(conv.messages),
    },
  })
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
  const totalTasks = await computeTotalTasks(plan, adapters)
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
        // Dry-run skips resume logic — every cell starts fresh, no NDJSON read.
        const completed = dryRun ? new Set<string>() : await readCompletedTaskIds(runDir)
        const tasks = await adapter.loadTasks(seed)

        let n_completed = 0

        // Filter out already-completed tasks, apply caps before chunking.
        const pending = tasks.filter((t) => !completed.has(t.id))
        const n_skipped = tasks.length - pending.length
        let cap: number = pending.length
        if (dryRun) cap = Math.min(cap, dryRun.nTasksPerCell)
        if (maxTasksPerCell !== undefined) cap = Math.min(cap, maxTasksPerCell)
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
