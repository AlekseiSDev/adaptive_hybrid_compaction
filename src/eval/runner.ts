import { randomUUID } from 'node:crypto'
import {
  appendRecord,
  computeConfigId,
  readAllRecords,
  readCompletedTaskIds,
  runDirFor,
  writeMeta,
  writeSummary,
} from './persist.js'
import { syntheticAdapter, syntheticGrader } from './adapters/synthetic.js'
import { buildRunnerFromBaseline } from './baseline.js'
import { anthropicCompactBaseline } from './baselines/anthropic_compact.js'
import { fullContextBaseline } from './baselines/full_context.js'
import { mastraOmBaseline } from './baselines/mastra_om.js'
import { CostTracker } from './cost.js'
import { createOpenRouterClient } from './llm.js'
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
    throw new Error(`bench not registered: ${bench}`)
  },
}

const FULL_CONTEXT_DEFAULT_MODEL = 'google/gemini-3.1-flash-lite'

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

function makeAnthropicCompactRunner(): Runner {
  const apiKey = process.env['ANTHROPIC_API_KEY']
  if (!apiKey) {
    throw new Error(
      'ANTHROPIC_API_KEY env var is required for baseline=anthropic_compact (vendor exception — server-side compact_20260112 lives only on Anthropic; see decisions.md 2026-05-13)',
    )
  }
  const baseline = anthropicCompactBaseline({ apiKey })
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
    const key = config.baseline ?? (config.ahc_flags ? 'noop_ahc' : null)
    if (key === null) {
      throw new Error(`config ${config.id}: must declare baseline or ahc_flags`)
    }
    const factory = STUB_RUNNER_FACTORIES[key]
    if (!factory) throw new Error(`unknown runner: ${key}`)
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
          const response = await runner.execute(conv, {
            bench,
            config,
            seed,
            task,
            instrumentation: (e) => events.push(e),
          })
          const score = grader.score(task, response)
          const completed_at = Date.now()
          const enrichedTurns = enrichTurnsWithEvents(response.turns, events)
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
            cost_usd: response.cost_usd,
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
