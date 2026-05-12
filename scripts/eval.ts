#!/usr/bin/env tsx
import { execSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'
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

function printSummary(plan: SweepPlan, result: RunSweepResult): void {
  console.log(`[${plan.name}] sweep complete: ${result.configs.length} (config × seed) entries`)
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
  const result = await runSweep(plan, defaultAdapterRegistry, defaultRunnerRegistry, {
    rootDir,
    gitSha: gitSha(),
  })
  printSummary(plan, result)
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
