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

function parseArgs(argv: string[]): { sweep: string } {
  const out: Record<string, string> = {}
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--sweep') {
      const v = argv[i + 1]
      if (!v) {
        console.error('error: --sweep requires a path argument')
        process.exit(1)
      }
      out['sweep'] = v
      i += 1
    }
  }
  if (!out['sweep']) {
    console.error('usage: tsx scripts/eval.ts --sweep <path/to/sweep.yaml>')
    process.exit(1)
  }
  return { sweep: out['sweep'] }
}

function validateSweep(raw: unknown, source: string): SweepPlan {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`sweep ${source}: must be a YAML object at top level`)
  }
  const obj = raw as Record<string, unknown>
  for (const k of REQUIRED_KEYS) {
    if (!(k in obj)) throw new Error(`sweep ${source}: missing required key: ${k}`)
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
  const { sweep: sweepPath } = parseArgs(process.argv.slice(2))
  const absSweep = resolve(sweepPath)
  const raw = parseYaml(await readFile(absSweep, 'utf8')) as unknown
  const plan = validateSweep(raw, absSweep)
  const rootDir = resolve(process.cwd(), 'benchmarks/runs')
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
            { rootDir, gitSha: gitSha() },
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

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
