import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RunRecord, RunSummary } from '../src/eval/types.js'
import { aggregateRun, formatTable } from './sanity-aggregate.js'

let workspace: string

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'ahc-aggregate-'))
})

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true })
})

function baseRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    run_id: 'run-1',
    bench: 'synthetic',
    config_id: 'cfg-aaaa',
    seed: 42,
    task_id: 'tsk-1',
    started_at: 0,
    completed_at: 1,
    score: { primary: 0.5 },
    totals: { input: 100, output: 50 },
    cost_usd: 0.001,
    turns: [],
    errors: [],
    ...overrides,
  }
}

function baseSummary(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    bench: 'synthetic',
    config_id: 'cfg-aaaa',
    seed: 42,
    n_total: 3,
    n_completed: 3,
    mean_primary_score: 0.5,
    total_cost_usd: 0.003,
    status: 'complete',
    ...overrides,
  }
}

async function writeCell(
  workspace: string,
  bench: string,
  cfg: string,
  seed: number,
  records: RunRecord[],
  summary?: RunSummary,
): Promise<void> {
  const dir = join(workspace, bench, cfg, String(seed))
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'records.ndjson'),
    records.map((r) => JSON.stringify(r)).join('\n') + '\n',
  )
  if (summary) {
    await writeFile(join(dir, 'summary.json'), JSON.stringify(summary, null, 2))
  }
}

describe('aggregateRun', () => {
  test('empty runDir → empty array', async () => {
    expect(await aggregateRun(workspace)).toEqual([])
  })

  test('single cell → 1 row with summary fields populated', async () => {
    await writeCell(
      workspace,
      'synthetic',
      'cfg-aaaa',
      42,
      [baseRecord({ task_id: 't1', cost_usd: 0.5, score: { primary: 0.7 } })],
      baseSummary({
        n_total: 1,
        n_completed: 1,
        mean_primary_score: 0.7,
        total_cost_usd: 0.5,
      }),
    )
    const rows = await aggregateRun(workspace)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.bench).toBe('synthetic')
    expect(rows[0]?.seed).toBe(42)
    expect(rows[0]?.n).toBe(1)
    expect(rows[0]?.accuracy).toBeCloseTo(0.7, 6)
    expect(rows[0]?.cost_usd).toBeCloseTo(0.5, 6)
    expect(rows[0]?.status).toBe('complete')
  })

  test('multiple cells sorted by (bench, config, seed) ascending', async () => {
    await writeCell(workspace, 'longmemeval-med', 'cfg-bbbb', 42, [baseRecord()], baseSummary({ bench: 'longmemeval-med', config_id: 'cfg-bbbb' }))
    await writeCell(workspace, 'synthetic', 'cfg-aaaa', 43, [baseRecord({ seed: 43 })], baseSummary({ seed: 43 }))
    await writeCell(workspace, 'synthetic', 'cfg-aaaa', 42, [baseRecord()], baseSummary())
    const rows = await aggregateRun(workspace)
    expect(rows.map((r) => `${r.bench}/${r.config_id}/${String(r.seed)}`)).toEqual([
      'longmemeval-med/cfg-bbbb/42',
      'synthetic/cfg-aaaa/42',
      'synthetic/cfg-aaaa/43',
    ])
  })

  test('partial summary status surfaces', async () => {
    await writeCell(
      workspace,
      'synthetic',
      'cfg-aaaa',
      42,
      [baseRecord()],
      baseSummary({ status: 'partial', halt_reason: 'budget' }),
    )
    const rows = await aggregateRun(workspace)
    expect(rows[0]?.status).toBe('partial')
  })

  test('missing summary.json → status: missing, fields fall back to record data', async () => {
    await writeCell(
      workspace,
      'synthetic',
      'cfg-aaaa',
      42,
      [baseRecord({ cost_usd: 0.5 })],
    )
    const rows = await aggregateRun(workspace)
    expect(rows[0]?.status).toBe('missing')
    expect(rows[0]?.cost_usd).toBeCloseTo(0.5, 6)
  })

  test('judge cost aggregated from records', async () => {
    const r1 = baseRecord({ task_id: 't1', score: { primary: 0.5, judge_cost_usd: 0.001 } })
    const r2 = baseRecord({ task_id: 't2', score: { primary: 0.8, judge_cost_usd: 0.002 } })
    await writeCell(
      workspace,
      'assistant-traj',
      'cfg-aaaa',
      42,
      [r1, r2],
      baseSummary({ bench: 'assistant-traj', n_total: 2, n_completed: 2 }),
    )
    const rows = await aggregateRun(workspace)
    expect(rows[0]?.judge_cost_usd).toBeCloseTo(0.003, 6)
  })

  test('error rate computed from records', async () => {
    const recs = [
      baseRecord({ task_id: 't1' }),
      baseRecord({ task_id: 't2', errors: [{ turn_index: 0, kind: 'api_error', message: 'b' }] }),
      baseRecord({ task_id: 't3' }),
      baseRecord({ task_id: 't4' }),
    ]
    await writeCell(workspace, 'synthetic', 'cfg-aaaa', 42, recs, baseSummary({ n_total: 4, n_completed: 4 }))
    const rows = await aggregateRun(workspace)
    expect(rows[0]?.err_rate).toBeCloseTo(0.25, 6)
  })
})

describe('formatTable', () => {
  test('markdown header + one row + totals tail', () => {
    const text = formatTable([
      {
        bench: 'synthetic',
        config_id: 'cfg-aaaa',
        seed: 42,
        n: 3,
        accuracy: 0.733,
        cost_usd: 0.5,
        err_rate: 0,
        judge_cost_usd: 0.01,
        status: 'complete',
      },
    ])
    expect(text).toContain('| bench | config | seed | n | accuracy')
    expect(text).toContain('| synthetic | cfg-aaaa | 42 | 3 | 0.733 | 0.5000 | 0.0% | 0.0100 | complete |')
    expect(text).toContain('Totals')
    expect(text).toContain('cells=1')
  })

  test('empty rows → placeholder row', () => {
    const text = formatTable([])
    expect(text).toContain('(no cells found)')
    expect(text).toContain('cells=0')
  })

  test('totals sum cost + judge across rows', () => {
    const rows = [
      {
        bench: 'a', config_id: 'c', seed: 42, n: 5,
        accuracy: 0.5, cost_usd: 1.0, err_rate: 0, judge_cost_usd: 0.1,
        status: 'complete' as const,
      },
      {
        bench: 'b', config_id: 'c', seed: 42, n: 5,
        accuracy: 0.5, cost_usd: 2.5, err_rate: 0, judge_cost_usd: 0.25,
        status: 'complete' as const,
      },
    ]
    const text = formatTable(rows)
    expect(text).toContain('records=10')
    expect(text).toContain('cost=$3.5000')
    expect(text).toContain('judge=$0.3500')
  })
})
