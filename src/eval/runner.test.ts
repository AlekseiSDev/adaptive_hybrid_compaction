import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  defaultAdapterRegistry,
  defaultRunnerRegistry,
  runSweep,
} from './runner.js'
import type { SweepPlan } from './types.js'

let workspace: string

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'ahc-runner-'))
})

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true })
})

const smokePlan: SweepPlan = {
  name: 'smoke',
  benches: ['synthetic'],
  configs: [
    { id: 'noop_baseline', baseline: 'noop_baseline' },
    { id: 'noop_ahc', ahc_flags: {} },
  ],
  seeds: [42],
  budget_usd: 1,
}

describe('runSweep — lifecycle smoke (synthetic + stub runners)', () => {
  test('first run produces 2 records per config; meta + summary written', async () => {
    const result = await runSweep(smokePlan, defaultAdapterRegistry, defaultRunnerRegistry, {
      rootDir: workspace,
      gitSha: 'test-sha',
    })

    expect(result.configs).toHaveLength(2)
    for (const cfg of result.configs) {
      expect(cfg.bench).toBe('synthetic')
      expect(cfg.seed).toBe(42)
      expect(cfg.n_completed).toBe(2)
      expect(cfg.n_skipped).toBe(0)
      expect(cfg.config_id).toMatch(/^[0-9a-f]{16}$/)

      const ndjson = await readFile(join(cfg.runDir, 'records.ndjson'), 'utf8')
      expect(ndjson.trim().split('\n')).toHaveLength(2)

      expect(existsSync(join(cfg.runDir, 'meta.json'))).toBe(true)
      expect(existsSync(join(cfg.runDir, 'summary.json'))).toBe(true)

      const summary = JSON.parse(await readFile(join(cfg.runDir, 'summary.json'), 'utf8')) as {
        n_completed: number
        mean_primary_score: number
      }
      expect(summary.n_completed).toBe(2)
      // Stub runner echoes task.expected -> grader scores 1 on both -> mean = 1.
      expect(summary.mean_primary_score).toBe(1)
    }

    // Each config gets a distinct config_id directory.
    const ids = new Set(result.configs.map((c) => c.config_id))
    expect(ids.size).toBe(2)
  })

  test('re-run on same rootDir is idempotent (skips completed task_ids)', async () => {
    await runSweep(smokePlan, defaultAdapterRegistry, defaultRunnerRegistry, {
      rootDir: workspace,
      gitSha: 'test-sha',
    })
    const second = await runSweep(smokePlan, defaultAdapterRegistry, defaultRunnerRegistry, {
      rootDir: workspace,
      gitSha: 'test-sha',
    })

    for (const cfg of second.configs) {
      expect(cfg.n_completed).toBe(0)
      expect(cfg.n_skipped).toBe(2)

      const ndjson = await readFile(join(cfg.runDir, 'records.ndjson'), 'utf8')
      // Line count unchanged from first run.
      expect(ndjson.trim().split('\n')).toHaveLength(2)
    }
  })
})

describe('default registries', () => {
  test('adapter registry resolves synthetic; throws on unknown bench', () => {
    const synth = defaultAdapterRegistry.resolve('synthetic')
    expect(synth.adapter.name).toBe('synthetic')
    expect(() => defaultAdapterRegistry.resolve('locomo-med')).toThrow(/not registered/)
  })

  test('runner registry resolves noop_baseline by `baseline` field and noop_ahc by `ahc_flags`', () => {
    const baseline = defaultRunnerRegistry.resolve({
      id: 'x',
      baseline: 'noop_baseline',
    })
    expect(baseline.name).toBe('noop_baseline')

    const ahc = defaultRunnerRegistry.resolve({ id: 'x', ahc_flags: {} })
    expect(ahc.name).toBe('noop_ahc')

    expect(() => defaultRunnerRegistry.resolve({ id: 'x' })).toThrow(/baseline or ahc_flags/)
    expect(() =>
      defaultRunnerRegistry.resolve({ id: 'x', baseline: 'unknown_baseline' }),
    ).toThrow(/unknown runner/)
  })
})
