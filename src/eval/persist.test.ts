import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { mkdtemp, readFile, rm, writeFile, appendFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appendRecord,
  computeConfigId,
  readCompletedTaskIds,
  runDirFor,
  writeMeta,
  writeSummary,
} from './persist.js'
import type { ConfigDef, RunMeta, RunRecord } from './types.js'

let workspace: string

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'ahc-persist-'))
})

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true })
})

const sampleRecord = (overrides: Partial<RunRecord> = {}): RunRecord => ({
  run_id: 'r_' + Math.random().toString(36).slice(2, 10),
  bench: 'synthetic',
  config_id: '0123456789abcdef',
  seed: 42,
  task_id: 'syn-001',
  started_at: 1_000,
  completed_at: 2_000,
  score: { primary: 1 },
  totals: { input: 0, output: 0 },
  cost_usd: 0,
  turns: [],
  errors: [],
  ...overrides,
})

describe('computeConfigId', () => {
  test('is deterministic and 16-hex', () => {
    const config: ConfigDef = { id: 'noop', baseline: 'noop_baseline' }
    const a = computeConfigId(config)
    const b = computeConfigId(config)
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{16}$/)
  })

  test('differs across different configs and is invariant to key order', () => {
    const c1: ConfigDef = { id: 'a', baseline: 'noop_baseline' }
    const c2: ConfigDef = { id: 'b', baseline: 'noop_baseline' }
    expect(computeConfigId(c1)).not.toBe(computeConfigId(c2))

    const reorderedKeys: ConfigDef = { baseline: 'noop_baseline', id: 'a' }
    expect(computeConfigId(reorderedKeys)).toBe(computeConfigId(c1))

    const nested1: ConfigDef = {
      id: 'ahc',
      ahc_flags: { TASK_AWARE: true, TYPE_AWARE: false },
    }
    const nested2: ConfigDef = {
      id: 'ahc',
      ahc_flags: { TYPE_AWARE: false, TASK_AWARE: true },
    }
    expect(computeConfigId(nested1)).toBe(computeConfigId(nested2))
  })
})

describe('appendRecord + readCompletedTaskIds', () => {
  test('writes NDJSON and surfaces task_ids on read; creates directory', async () => {
    const runDir = runDirFor(workspace, 'synthetic', 'abc1234567890def', 42)
    expect(existsSync(runDir)).toBe(false)

    await appendRecord(runDir, sampleRecord({ task_id: 'syn-001' }))
    await appendRecord(runDir, sampleRecord({ task_id: 'syn-002' }))

    expect(existsSync(runDir)).toBe(true)
    const ids = await readCompletedTaskIds(runDir)
    expect(ids).toEqual(new Set(['syn-001', 'syn-002']))

    const ndjson = await readFile(join(runDir, 'records.ndjson'), 'utf8')
    const lines = ndjson.trim().split('\n')
    expect(lines).toHaveLength(2)
    for (const line of lines) {
      const parsed = JSON.parse(line) as RunRecord
      expect(parsed.bench).toBe('synthetic')
    }
  })

  test('readCompletedTaskIds returns empty set when runDir is missing', async () => {
    const ids = await readCompletedTaskIds(join(workspace, 'nope'))
    expect(ids).toEqual(new Set())
  })

  test('skips malformed NDJSON lines without throwing', async () => {
    const runDir = runDirFor(workspace, 'synthetic', 'deadbeefdeadbeef', 42)
    await appendRecord(runDir, sampleRecord({ task_id: 'syn-001' }))
    await appendFile(join(runDir, 'records.ndjson'), '{not json mid-write\n')
    await appendRecord(runDir, sampleRecord({ task_id: 'syn-002' }))

    const ids = await readCompletedTaskIds(runDir)
    expect(ids).toEqual(new Set(['syn-001', 'syn-002']))
  })
})

describe('writeMeta + writeSummary', () => {
  test('writeMeta produces valid JSON with config snapshot', async () => {
    const runDir = runDirFor(workspace, 'synthetic', '0123456789abcdef', 42)
    await writeFile(join(workspace, 'placeholder'), '')

    const meta: RunMeta = {
      config: { id: 'noop', baseline: 'noop_baseline' },
      bench: 'synthetic',
      seed: 42,
      git_sha: 'abc123',
      timestamp: new Date(0).toISOString(),
    }
    await writeMeta(runDir, meta)

    const json = JSON.parse(await readFile(join(runDir, 'meta.json'), 'utf8')) as RunMeta
    expect(json.config.id).toBe('noop')
    expect(json.bench).toBe('synthetic')
    expect(json.git_sha).toBe('abc123')
  })

  test('writeSummary aggregates n_total / n_completed / mean_primary_score / total_cost_usd', async () => {
    const runDir = runDirFor(workspace, 'synthetic', '0123456789abcdef', 42)
    const records: RunRecord[] = [
      sampleRecord({ task_id: 'a', score: { primary: 1 }, cost_usd: 0.01 }),
      sampleRecord({ task_id: 'b', score: { primary: 0 }, cost_usd: 0.02 }),
    ]
    await writeSummary(
      runDir,
      { bench: 'synthetic', config_id: '0123456789abcdef', seed: 42 },
      records,
      { status: 'complete' },
    )

    const summary = JSON.parse(await readFile(join(runDir, 'summary.json'), 'utf8')) as {
      bench: string
      config_id: string
      seed: number
      n_total: number
      n_completed: number
      mean_primary_score: number
      total_cost_usd: number
      status: string
      halt_reason?: string
    }
    expect(summary.bench).toBe('synthetic')
    expect(summary.config_id).toBe('0123456789abcdef')
    expect(summary.seed).toBe(42)
    expect(summary.n_total).toBe(2)
    expect(summary.n_completed).toBe(2)
    expect(summary.mean_primary_score).toBe(0.5)
    expect(summary.total_cost_usd).toBeCloseTo(0.03, 5)
    expect(summary.status).toBe('complete')
    expect(summary.halt_reason).toBeUndefined()
  })

  test('writeSummary persists status:"partial" + halt_reason on halted close', async () => {
    const runDir = runDirFor(workspace, 'synthetic', '0123456789abcdef', 42)
    const records: RunRecord[] = [
      sampleRecord({ task_id: 'a', score: { primary: 0 }, cost_usd: 5 }),
    ]
    await writeSummary(
      runDir,
      { bench: 'synthetic', config_id: '0123456789abcdef', seed: 42 },
      records,
      { status: 'partial', halt_reason: 'projected $123.00 > 1.5× budget $50.00 after 1 tasks' },
    )

    const summary = JSON.parse(await readFile(join(runDir, 'summary.json'), 'utf8')) as {
      status: string
      halt_reason: string
      n_completed: number
    }
    expect(summary.status).toBe('partial')
    expect(summary.halt_reason).toContain('1.5× budget')
    expect(summary.n_completed).toBe(1)
  })

  test('writeSummary status:"complete" with no halt_reason omits halt_reason key', async () => {
    const runDir = runDirFor(workspace, 'synthetic', '0123456789abcdef', 42)
    await writeSummary(
      runDir,
      { bench: 'synthetic', config_id: '0123456789abcdef', seed: 42 },
      [],
      { status: 'complete' },
    )

    const raw = await readFile(join(runDir, 'summary.json'), 'utf8')
    expect(raw).not.toContain('halt_reason')
  })
})
