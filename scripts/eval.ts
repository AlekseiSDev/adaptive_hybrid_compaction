#!/usr/bin/env tsx
import { execSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { setupObservability } from '../src/eval/observability/langfuse.js'
import {
  defaultAdapterRegistry,
  defaultRunnerRegistry,
  runSweep,
  type RunSweepResult,
} from '../src/eval/runner.js'
import type { SweepPlan } from '../src/eval/types.js'

const REQUIRED_KEYS = ['name', 'benches', 'configs', 'seeds', 'budget_usd'] as const

type CliArgs = {
  sweep: string
  dryRun: boolean
  nPerCell: number
}

const DRY_RUN_DEFAULT_N_PER_CELL = 2

export function parseArgs(argv: string[]): CliArgs {
  let sweep: string | undefined
  let dryRun = false
  let nPerCell = DRY_RUN_DEFAULT_N_PER_CELL
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--sweep') {
      const v = argv[i + 1]
      if (!v) {
        throw new Error('error: --sweep requires a path argument')
      }
      sweep = v
      i += 1
    } else if (a === '--dry-run') {
      dryRun = true
    } else if (a !== undefined && a.startsWith('--n-per-cell=')) {
      const raw = a.slice('--n-per-cell='.length)
      const parsed = Number.parseInt(raw, 10)
      if (!Number.isFinite(parsed) || parsed < 1) {
        throw new Error(`error: --n-per-cell expects positive integer, got "${raw}"`)
      }
      nPerCell = parsed
    }
  }
  if (!sweep) {
    throw new Error(
      'usage: tsx scripts/eval.ts --sweep <path/to/sweep.yaml> [--dry-run [--n-per-cell=N]]',
    )
  }
  return { sweep, dryRun, nPerCell }
}

export const VALID_PROVIDERS = new Set(['openrouter', 'anthropic_direct'])

// E0: sweep output dir convention. benchmarks/runs/<plan.name>/<bench>/<cfg>/<seed>
// — per-sweep subdir so E1/E2/E3 outputs don't collide on shared
// (bench, config_id, seed) triples. Exported pure helper so tests can verify
// the path-mapping without invoking the CLI.
export function sweepRootDir(cwd: string, planName: string): string {
  return resolve(cwd, 'benchmarks/runs', planName)
}

export function validateSweep(raw: unknown, source: string): SweepPlan {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`sweep ${source}: must be a YAML object at top level`)
  }
  const obj = raw as Record<string, unknown>
  for (const k of REQUIRED_KEYS) {
    if (!(k in obj)) throw new Error(`sweep ${source}: missing required key: ${k}`)
  }
  // E0: per-row `provider` enum check (optional field; only meaningful for
  // ahc_core baseline, but validated globally so typos surface early).
  const configs = obj['configs']
  if (Array.isArray(configs)) {
    for (const c of configs as Array<Record<string, unknown>>) {
      const provider = c['provider']
      if (provider !== undefined && !VALID_PROVIDERS.has(String(provider))) {
        throw new Error(
          `sweep ${source}: config "${String(c['id'])}" — invalid provider "${String(provider)}", ` +
            `must be one of: ${[...VALID_PROVIDERS].join(', ')}`,
        )
      }
    }
  }
  return obj as unknown as SweepPlan
}

function gitSha(): string {
  try {
    return execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
  } catch {
    return 'unknown'
  }
}

function printSummary(plan: SweepPlan, result: RunSweepResult, langfuseEnabled: boolean): void {
  const status = result.halted ? `HALTED (${result.halt_reason ?? 'unknown'})` : 'complete'
  console.log(
    `[${plan.name}] sweep ${status}: ${String(result.configs.length)} (config × seed) entries; ` +
      `total_cost=$${result.total_cost_usd.toFixed(4)}; langfuse=${langfuseEnabled ? 'enabled' : 'disabled'}`,
  )
  for (const c of result.configs) {
    console.log(
      `  bench=${c.bench} config_id=${c.config_id} seed=${String(c.seed)} ` +
        `n_completed=${String(c.n_completed)} n_skipped=${String(c.n_skipped)} runDir=${c.runDir}`,
    )
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const absSweep = resolve(args.sweep)
  const raw = parseYaml(await readFile(absSweep, 'utf8')) as unknown
  const plan = validateSweep(raw, absSweep)
  const rootDir = sweepRootDir(process.cwd(), plan.name)
  if (args.dryRun) {
    console.log(
      `[eval] DRY-RUN mode: ${String(args.nPerCell)} tasks/cell, no persistence`,
    )
  }
  const obs = setupObservability()
  try {
    // startActiveSpan (vs startSpan) registers eval.sweep as the active span
    // in OTel context — eval.task spans created inside runSweep become its
    // children automatically. Plus eval.task wraps in turn any AI SDK
    // experimental_telemetry spans (ai.generateText.*) → full trace tree
    // in Langfuse UI.
    await obs.tracer.startActiveSpan(
      'eval.sweep',
      {
        attributes: {
          'sweep.name': plan.name,
          'sweep.benches': plan.benches.join(','),
          'sweep.configs_count': plan.configs.length,
          'sweep.seeds': plan.seeds.join(','),
          'sweep.budget_usd': plan.budget_usd,
          'langfuse.observation.input': JSON.stringify({
            name: plan.name,
            benches: plan.benches,
            configs: plan.configs.map((c) => c.id),
            seeds: plan.seeds,
          }),
        },
      },
      async (span) => {
        try {
          const result = await runSweep(
            plan,
            defaultAdapterRegistry,
            defaultRunnerRegistry,
            {
              rootDir,
              gitSha: gitSha(),
              ...(args.dryRun ? { dryRun: { nTasksPerCell: args.nPerCell } } : {}),
            },
          )
          span.setAttribute('sweep.halted', result.halted)
          span.setAttribute('sweep.total_cost_usd', result.total_cost_usd)
          span.setAttribute('sweep.configs_completed', result.configs.length)
          span.setAttribute(
            'langfuse.observation.output',
            JSON.stringify({
              halted: result.halted,
              ...(result.halt_reason !== undefined
                ? { halt_reason: result.halt_reason }
                : {}),
              total_cost_usd: result.total_cost_usd,
              configs_completed: result.configs.length,
            }),
          )
          printSummary(plan, result, obs.enabled)
        } finally {
          span.end()
        }
      },
    )
  } finally {
    await obs.dispose()
  }
}

// Run main() only when invoked as a script (tsx scripts/eval.ts ...), not
// when imported by a test for `validateSweep` / `VALID_PROVIDERS` etc.
// argv[1] resolves to the absolute path of the entry; URL form must match.
const entryUrl = `file://${process.argv[1] ?? ''}`
if (import.meta.url === entryUrl) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  })
}
