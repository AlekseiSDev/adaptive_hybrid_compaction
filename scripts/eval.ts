#!/usr/bin/env tsx
import { execSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { pingLiteLLM, pingOpenRouter } from '../src/eval/auth.js'
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
  concurrency: number
  maxTasksPerCell: number | undefined
  skipAuthCheck: boolean
}

const DRY_RUN_DEFAULT_N_PER_CELL = 2
const CONCURRENCY_DEFAULT = 1
const CONCURRENCY_MAX = 50

export function parseArgs(argv: string[]): CliArgs {
  let sweep: string | undefined
  let dryRun = false
  let nPerCell = DRY_RUN_DEFAULT_N_PER_CELL
  let concurrency = CONCURRENCY_DEFAULT
  let maxTasksPerCell: number | undefined
  let skipAuthCheck = false
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
    } else if (a !== undefined && a.startsWith('--concurrency=')) {
      const raw = a.slice('--concurrency='.length)
      const parsed = Number.parseInt(raw, 10)
      if (!Number.isFinite(parsed) || parsed < 1 || parsed > CONCURRENCY_MAX) {
        throw new Error(
          `error: --concurrency expects integer in [1, ${String(CONCURRENCY_MAX)}], got "${raw}"`,
        )
      }
      concurrency = parsed
    } else if (a !== undefined && a.startsWith('--max-tasks-per-cell=')) {
      const raw = a.slice('--max-tasks-per-cell='.length)
      const parsed = Number.parseInt(raw, 10)
      if (!Number.isFinite(parsed) || parsed < 1) {
        throw new Error(
          `error: --max-tasks-per-cell expects positive integer, got "${raw}"`,
        )
      }
      maxTasksPerCell = parsed
    } else if (a === '--skip-auth-check') {
      skipAuthCheck = true
    }
  }
  if (!sweep) {
    throw new Error(
      'usage: tsx scripts/eval.ts --sweep <path/to/sweep.yaml> ' +
        '[--dry-run [--n-per-cell=N]] [--concurrency=N] [--max-tasks-per-cell=N] ' +
        '[--skip-auth-check]',
    )
  }
  return { sweep, dryRun, nPerCell, concurrency, maxTasksPerCell, skipAuthCheck }
}

// Inspects sweep configs to determine which auth paths the run will exercise,
// then pings each one. Returns failure list (empty if all OK or skipped paths).
// Exported for tests; runs in scripts/eval.ts main() before runSweep.
export async function preflightAuthCheck(
  plan: SweepPlan,
): Promise<{ failures: string[]; report: string[] }> {
  const failures: string[] = []
  const report: string[] = []

  const wantsOpenRouter = plan.configs.some(
    (c) =>
      c.baseline === 'full_context' ||
      c.baseline === 'mastra_om' ||
      c.baseline === 'tau_bench_agent' ||
      c.baseline === 'tau_bench_agent_ahc' ||
      (c.provider ?? 'openrouter') === 'openrouter',
  )
  const wantsLitellm = plan.configs.some(
    (c) =>
      c.baseline === 'anthropic_compact' ||
      (c.provider === 'anthropic_direct' &&
        !!process.env['LITELLM_MASTER_KEY'] &&
        !!process.env['LITELLM_BASE_URL']),
  )

  if (wantsOpenRouter) {
    const apiKey = process.env['OPENROUTER_API_KEY']
    if (!apiKey || apiKey.length === 0) {
      failures.push('OPENROUTER_API_KEY is required but not set')
    } else {
      const res = await pingOpenRouter(apiKey)
      if (res.ok) report.push(`✓ ${res.detail ?? 'OpenRouter ok'}`)
      else failures.push(res.error ?? 'OpenRouter ping failed')
    }
  }

  if (wantsLitellm) {
    const masterKey = process.env['LITELLM_MASTER_KEY']
    const baseUrl = process.env['LITELLM_BASE_URL']
    if (!masterKey || !baseUrl) {
      // LiteLLM is an optional auth path for anthropic_compact (it has OAuth /
      // ANTHROPIC_API_KEY fallbacks); skip the ping if the proxy isn't
      // configured. Runner factory will fall back at instantiation time.
      report.push('· LiteLLM forwarder not configured (LITELLM_* unset) — skipping ping')
    } else {
      const res = await pingLiteLLM(baseUrl, masterKey)
      if (res.ok) report.push(`✓ ${res.detail ?? 'LiteLLM ok'}`)
      else failures.push(res.error ?? 'LiteLLM ping failed')
    }
  }

  return { failures, report }
}

export const VALID_PROVIDERS = new Set(['openrouter', 'anthropic_direct', 'google_direct'])

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

  if (!args.skipAuthCheck) {
    const { failures, report } = await preflightAuthCheck(plan)
    for (const line of report) console.log(`[preflight] ${line}`)
    if (failures.length > 0) {
      for (const f of failures) console.error(`[preflight] ✗ ${f}`)
      console.error(
        '[preflight] auth check failed; use --skip-auth-check to bypass',
      )
      process.exit(1)
    }
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
              concurrency: args.concurrency,
              ...(args.maxTasksPerCell !== undefined
                ? { maxTasksPerCell: args.maxTasksPerCell }
                : {}),
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
