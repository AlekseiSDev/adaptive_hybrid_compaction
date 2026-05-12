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
import type {
  Bench,
  BenchAdapter,
  ConfigDef,
  Grader,
  RunRecord,
  Runner,
  SweepPlan,
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
}

const STUB_RUNNERS: Record<string, Runner> = {
  noop_baseline: {
    name: 'noop_baseline',
    execute: (_conv, ctx) =>
      Promise.resolve({
        text: String(ctx.task.expected),
        turns: [],
        errors: [],
        totals: { input: 0, output: 0 },
        cost_usd: 0,
      }),
  },
  noop_ahc: {
    name: 'noop_ahc',
    execute: (_conv, ctx) =>
      Promise.resolve({
        text: String(ctx.task.expected),
        turns: [],
        errors: [],
        totals: { input: 0, output: 0 },
        cost_usd: 0,
      }),
  },
}

export const defaultAdapterRegistry: AdapterRegistry = {
  resolve: (bench) => {
    if (bench === 'synthetic') {
      return { adapter: syntheticAdapter, grader: syntheticGrader }
    }
    throw new Error(`bench not registered: ${bench}`)
  },
}

export const defaultRunnerRegistry: RunnerRegistry = {
  resolve: (config) => {
    const key = config.baseline ?? (config.ahc_flags ? 'noop_ahc' : null)
    if (key === null) {
      throw new Error(`config ${config.id}: must declare baseline or ahc_flags`)
    }
    const runner = STUB_RUNNERS[key]
    if (!runner) throw new Error(`unknown runner: ${key}`)
    return runner
  },
}

export async function runSweep(
  plan: SweepPlan,
  adapters: AdapterRegistry,
  runners: RunnerRegistry,
  options: RunSweepOptions,
): Promise<RunSweepResult> {
  const configResults: RunSweepConfigResult[] = []

  for (const bench of plan.benches) {
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
          const conv = adapter.prepare(task)
          const started_at = Date.now()
          const response = await runner.execute(conv, { bench, config, seed, task })
          const score = grader.score(task, response)
          const completed_at = Date.now()
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
            turns: response.turns,
            errors: response.errors,
          }
          await appendRecord(runDir, record)
          n_completed += 1
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

  return { configs: configResults }
}
