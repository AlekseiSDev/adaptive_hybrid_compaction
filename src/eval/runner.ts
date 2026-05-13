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
    throw new Error(`bench not registered: ${bench}`)
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
  const apiKey = process.env['OPENROUTER_API_KEY']
  if (!apiKey) {
    throw new Error(
      'ahc_core runner requires OPENROUTER_API_KEY env var (primary actor model = Gemini-3-Flash-Preview through OpenRouter, per system_design §6.1).',
    )
  }
  const flagsFromConfig = (config.ahc_flags ?? {}) as Record<string, unknown>
  const modelOverride = flagsFromConfig['model']
  // Strip ahc_core-runner-specific keys (`model`) from FeatureFlags pass-through.
  const { model: _omitModel, ...featureFlagsRaw } = flagsFromConfig
  const baseline = ahcCoreBaseline({
    apiKey,
    baseURL: 'https://openrouter.ai/api/v1',
    ...(typeof modelOverride === 'string' ? { model: modelOverride } : {}),
    // Other ahc_flags keys (TRAJECTORY_CLASSIFIER, REFLECTION, etc.) map to
    // FeatureFlags — pass through directly; createAhcMiddleware merges with defaults.
    ahcFlags: featureFlagsRaw as Partial<
      NonNullable<Parameters<typeof ahcCoreBaseline>[0]['ahcFlags']>
    >,
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

export async function runSweep(
  plan: SweepPlan,
  adapters: AdapterRegistry,
  runners: RunnerRegistry,
  options: RunSweepOptions,
): Promise<RunSweepResult> {
  const configResults: RunSweepConfigResult[] = []
  const costTracker = new CostTracker()
  const totalTasks = await computeTotalTasks(plan, adapters)
  // Noop-safe: when LANGFUSE_ENABLED unset, this is a noop tracer and the
  // span calls below are zero-cost. When enabled, eval.task spans appear as
  // children of the outer eval.sweep span set up in scripts/eval.ts.
  const tracer = options.tracer ?? trace.getTracer('ahc-eval')

  let halted = false
  let halt_reason: string | undefined

  outer: for (const bench of plan.benches) {
    const { adapter, grader } = adapters.resolve(bench)
    for (const config of plan.configs) {
      const runner = runners.resolve(config)
      const config_id = computeConfigId(config)
      for (const seed of plan.seeds) {
        const runDir = runDirFor(options.rootDir, bench, config_id, seed)
        const completed = await readCompletedTaskIds(runDir)
        const tasks = await adapter.loadTasks(seed)

        let n_completed = 0
        let n_skipped = 0

        for (const task of tasks) {
          if (completed.has(task.id)) {
            n_skipped += 1
            continue
          }
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
          // Grader.score is async (D4 Step 3) so llm_judge can call the
          // real LLM. Sync graders (synthetic) wrap in Promise.resolve.
          const score = await grader.score(task, response)
          const completed_at = Date.now()
          const enrichedTurns = enrichTurnsWithEvents(response.turns, events)
          // Roll judge cost (D4) into record.cost_usd so CostTracker.observe()
          // counts it against the sweep budget. See decisions.md [2026-05-13]
          // D4 — Score.judge_cost_usd rolled into record.cost_usd.
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
          await appendRecord(runDir, record)
          n_completed += 1

          costTracker.observe(record)
          const decision = costTracker.shouldHalt({
            budget_usd: plan.budget_usd,
            total_tasks: totalTasks,
          })
          if (decision.halt) {
            halted = true
            halt_reason = decision.reason
            console.warn(`[runSweep] halting: ${decision.reason}`)
            await writeMeta(runDir, {
              config,
              bench,
              seed,
              git_sha: options.gitSha ?? 'unknown',
              timestamp: new Date().toISOString(),
            })
            const allRecords = await readAllRecords(runDir)
            await writeSummary(runDir, { bench, config_id, seed }, allRecords)
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
        }

        await writeMeta(runDir, {
          config,
          bench,
          seed,
          git_sha: options.gitSha ?? 'unknown',
          timestamp: new Date().toISOString(),
        })
        const allRecords = await readAllRecords(runDir)
        await writeSummary(runDir, { bench, config_id, seed }, allRecords)

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
