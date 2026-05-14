import { describe, expect, test } from 'vitest'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { parseArgs, sweepRootDir, validateSweep, VALID_PROVIDERS } from './eval.js'

// validateSweep — sweep YAML schema sanity. Tests the optional E0 `provider`
// per-row enum check + the pre-existing required-keys check, so future
// schema additions land with TDD coverage.

const baseSweep = {
  name: 'test_sweep',
  benches: ['synthetic'],
  configs: [{ id: 'c0', baseline: 'noop_baseline' }],
  seeds: [42],
  budget_usd: 1,
}

describe('validateSweep — required keys', () => {
  test('accepts a minimal valid sweep', () => {
    expect(() => validateSweep(baseSweep, 'test.yaml')).not.toThrow()
  })

  test('rejects when required key is missing', () => {
    const noBudget = { ...baseSweep } as Record<string, unknown>
    delete noBudget['budget_usd']
    expect(() => validateSweep(noBudget, 'test.yaml')).toThrow(/budget_usd/)
  })

  test('rejects non-object input', () => {
    expect(() => validateSweep('not an object', 'test.yaml')).toThrow(/YAML object/)
    expect(() => validateSweep([1, 2, 3], 'test.yaml')).toThrow(/YAML object/)
  })
})

describe('validateSweep — provider per-row enum (E0)', () => {
  test('accepts row with provider:"anthropic_direct"', () => {
    const sweep = {
      ...baseSweep,
      configs: [{ id: 'c0', ahc_flags: {}, provider: 'anthropic_direct' }],
    }
    expect(() => validateSweep(sweep, 'test.yaml')).not.toThrow()
  })

  test('accepts row with provider:"openrouter"', () => {
    const sweep = {
      ...baseSweep,
      configs: [{ id: 'c0', ahc_flags: {}, provider: 'openrouter' }],
    }
    expect(() => validateSweep(sweep, 'test.yaml')).not.toThrow()
  })

  test('accepts row without provider field (optional)', () => {
    const sweep = {
      ...baseSweep,
      configs: [{ id: 'c0', baseline: 'noop_baseline' }],
    }
    expect(() => validateSweep(sweep, 'test.yaml')).not.toThrow()
  })

  test('rejects invalid provider value', () => {
    const sweep = {
      ...baseSweep,
      configs: [{ id: 'c0', ahc_flags: {}, provider: 'fake_provider' }],
    }
    expect(() => validateSweep(sweep, 'test.yaml')).toThrow(/invalid provider "fake_provider"/)
  })

  test('lists valid providers in error message', () => {
    const sweep = {
      ...baseSweep,
      configs: [{ id: 'c0', ahc_flags: {}, provider: 'azure' }],
    }
    expect(() => validateSweep(sweep, 'test.yaml')).toThrow(/openrouter|anthropic_direct/)
  })
})

describe('VALID_PROVIDERS constant', () => {
  test('contains all 3 supported providers', () => {
    expect(VALID_PROVIDERS.has('openrouter')).toBe(true)
    expect(VALID_PROVIDERS.has('anthropic_direct')).toBe(true)
    // Track H P4 (2026-05-14) — google_direct for honest Gemini cache_read.
    expect(VALID_PROVIDERS.has('google_direct')).toBe(true)
    expect(VALID_PROVIDERS.size).toBe(3)
  })
})

describe('E1/E2/E3 sweep YAML scaffolds (E0)', () => {
  const repoRoot = resolve(__dirname, '..')

  test('main_e1_text.yaml: 3 text benches × 4 baselines × 2 seeds', async () => {
    const raw = parseYaml(
      await readFile(resolve(repoRoot, 'eval/sweeps/main_e1_text.yaml'), 'utf8'),
    ) as unknown
    const plan = validateSweep(raw, 'main_e1_text.yaml')
    expect(plan.name).toBe('main_e1_text')
    expect(plan.benches).toEqual(['assistant-traj', 'longmemeval-med', 'locomo-med'])
    expect(plan.configs).toHaveLength(4)
    expect(plan.seeds).toEqual([42]) // Phase D fast-track: seed=43 deferred (see docs/runs/e_phase_d_todos.md)
    expect(plan.budget_usd).toBe(90)
    const ids = plan.configs.map((c) => c.id).sort()
    expect(ids).toEqual(['ahc_full', 'anthropic_compact', 'full_context', 'mastra_om'])
  })

  test('main_e1_tau.yaml: tau-bench × 2 agent variants × 2 seeds', async () => {
    const raw = parseYaml(
      await readFile(resolve(repoRoot, 'eval/sweeps/main_e1_tau.yaml'), 'utf8'),
    ) as unknown
    const plan = validateSweep(raw, 'main_e1_tau.yaml')
    expect(plan.benches).toEqual(['tau-bench-retail-med'])
    const ids = plan.configs.map((c) => c.id).sort()
    expect(ids).toEqual(['tau_bench_agent', 'tau_bench_agent_ahc'])
    expect(plan.budget_usd).toBe(30)
  })

  test('ablation_e2.yaml: 3 AHC variants × 2 text benches × 2 seeds (E1 budget hedge)', async () => {
    const raw = parseYaml(
      await readFile(resolve(repoRoot, 'eval/sweeps/ablation_e2.yaml'), 'utf8'),
    ) as unknown
    const plan = validateSweep(raw, 'ablation_e2.yaml')
    expect(plan.benches).toEqual(['assistant-traj', 'longmemeval-med'])
    // E1 budget cut: dropped ahc_no_async_buffer (lowest-signal ablation).
    expect(plan.configs).toHaveLength(3)
    const ids = plan.configs.map((c) => c.id).sort()
    expect(ids).toEqual(['ahc_full', 'ahc_no_observer', 'ahc_no_offloader'])
    // Each non-baseline config sets exactly one flag to false (except ahc_full).
    for (const c of plan.configs) {
      if (c.id === 'ahc_full') continue
      const flags = c.ahc_flags as Record<string, unknown>
      const falsies = Object.values(flags).filter((v) => v === false)
      expect(falsies).toHaveLength(1)
    }
  })

  test('cache_hit_e3.yaml: LME × 2 configs (ahc_full_anthropic + anthropic_compact), seed 42 only', async () => {
    const raw = parseYaml(
      await readFile(resolve(repoRoot, 'eval/sweeps/cache_hit_e3.yaml'), 'utf8'),
    ) as unknown
    const plan = validateSweep(raw, 'cache_hit_e3.yaml')
    expect(plan.benches).toEqual(['longmemeval-med'])
    expect(plan.configs).toHaveLength(2)
    expect(plan.seeds).toEqual([42])
    // anthropic_direct provider on ahc_full config — E3 cache-hit dispatch.
    const ahcConfig = plan.configs.find((c) => c.id === 'ahc_full_anthropic')
    expect(ahcConfig?.provider).toBe('anthropic_direct')
  })
})

describe('sweepRootDir — per-sweep output convention (E0)', () => {
  test('appends plan.name segment between rootDir and bench subdirs', () => {
    const result = sweepRootDir('/work', 'main_e1')
    expect(result).toBe('/work/benchmarks/runs/main_e1')
  })

  test('distinguishes sweeps with same configs but different names', () => {
    expect(sweepRootDir('/w', 'e1')).not.toBe(sweepRootDir('/w', 'e2'))
  })

  test('resolves relative cwd to absolute', () => {
    const result = sweepRootDir('relative/path', 'test_sweep')
    expect(result.startsWith('/')).toBe(true)
    expect(result.endsWith('benchmarks/runs/test_sweep')).toBe(true)
  })
})

describe('parseArgs — --dry-run + --n-per-cell (E0)', () => {
  test('--sweep only: dryRun=false, nPerCell default', () => {
    const args = parseArgs(['--sweep', 'plan.yaml'])
    expect(args.sweep).toBe('plan.yaml')
    expect(args.dryRun).toBe(false)
    expect(args.nPerCell).toBe(2)
  })

  test('--dry-run flag: dryRun=true, default n-per-cell still 2', () => {
    const args = parseArgs(['--sweep', 'plan.yaml', '--dry-run'])
    expect(args.dryRun).toBe(true)
    expect(args.nPerCell).toBe(2)
  })

  test('--n-per-cell=N parses positive integer', () => {
    const args = parseArgs(['--sweep', 'plan.yaml', '--dry-run', '--n-per-cell=5'])
    expect(args.nPerCell).toBe(5)
  })

  test('throws on missing --sweep', () => {
    expect(() => parseArgs([])).toThrow(/usage:/)
    expect(() => parseArgs(['--dry-run'])).toThrow(/usage:/)
  })

  test('throws on --n-per-cell with non-integer', () => {
    expect(() => parseArgs(['--sweep', 'p.yaml', '--n-per-cell=abc'])).toThrow(/positive integer/)
  })

  test('throws on --n-per-cell with zero or negative', () => {
    expect(() => parseArgs(['--sweep', 'p.yaml', '--n-per-cell=0'])).toThrow(/positive integer/)
    expect(() => parseArgs(['--sweep', 'p.yaml', '--n-per-cell=-3'])).toThrow(/positive integer/)
  })
})

describe('parseArgs — --concurrency + --max-tasks-per-cell (E1)', () => {
  test('default --concurrency is 1, maxTasksPerCell undefined', () => {
    const args = parseArgs(['--sweep', 'p.yaml'])
    expect(args.concurrency).toBe(1)
    expect(args.maxTasksPerCell).toBeUndefined()
  })

  test('--concurrency=5 parses', () => {
    const args = parseArgs(['--sweep', 'p.yaml', '--concurrency=5'])
    expect(args.concurrency).toBe(5)
  })

  test('--concurrency rejects 0 / negative / > 50', () => {
    expect(() => parseArgs(['--sweep', 'p.yaml', '--concurrency=0'])).toThrow(/integer in/)
    expect(() => parseArgs(['--sweep', 'p.yaml', '--concurrency=-1'])).toThrow(/integer in/)
    expect(() => parseArgs(['--sweep', 'p.yaml', '--concurrency=51'])).toThrow(/integer in/)
  })

  test('--max-tasks-per-cell=N parses positive integer', () => {
    const args = parseArgs(['--sweep', 'p.yaml', '--max-tasks-per-cell=3'])
    expect(args.maxTasksPerCell).toBe(3)
  })

  test('--max-tasks-per-cell rejects 0 / negative', () => {
    expect(() => parseArgs(['--sweep', 'p.yaml', '--max-tasks-per-cell=0'])).toThrow(/positive integer/)
    expect(() => parseArgs(['--sweep', 'p.yaml', '--max-tasks-per-cell=-1'])).toThrow(/positive integer/)
  })

  test('combines with --dry-run independently', () => {
    const args = parseArgs([
      '--sweep', 'p.yaml',
      '--dry-run', '--n-per-cell=2',
      '--concurrency=4',
    ])
    expect(args.dryRun).toBe(true)
    expect(args.nPerCell).toBe(2)
    expect(args.concurrency).toBe(4)
    expect(args.maxTasksPerCell).toBeUndefined()
  })

  test('--skip-auth-check flag parses', () => {
    const args = parseArgs(['--sweep', 'p.yaml', '--skip-auth-check'])
    expect(args.skipAuthCheck).toBe(true)
  })

  test('--skip-auth-check default is false', () => {
    const args = parseArgs(['--sweep', 'p.yaml'])
    expect(args.skipAuthCheck).toBe(false)
  })
})
