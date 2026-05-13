import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RunRecord, RunSummary } from '../src/eval/types.js'
import { checkRun, formatReport } from './check-run.js'

let workspace: string

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'ahc-check-'))
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

describe('checkRun — happy path', () => {
  test('clean records → no issues, ok exit shape', async () => {
    await writeCell(
      workspace,
      'synthetic',
      'cfg-aaaa',
      42,
      [
        baseRecord({ task_id: 't1', score: { primary: 1 } }),
        baseRecord({ task_id: 't2', score: { primary: 0 } }),
        baseRecord({ task_id: 't3', score: { primary: 0.5 } }),
      ],
      baseSummary({ n_completed: 3, n_total: 3 }),
    )
    const result = await checkRun(workspace)
    expect(result.cells_checked).toBe(1)
    expect(result.records_checked).toBe(3)
    expect(result.issues).toEqual([])
  })
})

describe('checkRun — empty / missing inputs', () => {
  test('empty runDir → single error', async () => {
    const result = await checkRun(workspace)
    expect(result.issues.some((i) => i.message.includes('no cell records.ndjson'))).toBe(true)
  })

  test('missing summary.json → warning, but records still checked', async () => {
    await writeCell(workspace, 'synthetic', 'cfg-aaaa', 42, [baseRecord()])
    const result = await checkRun(workspace)
    expect(result.issues.some((i) => i.severity === 'warn' && i.message.includes('summary.json missing'))).toBe(true)
  })
})

describe('checkRun — per-record validity', () => {
  test('cost_usd <= 0 → error', async () => {
    await writeCell(
      workspace,
      'synthetic',
      'cfg-aaaa',
      42,
      [baseRecord({ cost_usd: 0 })],
      baseSummary({ n_total: 1, n_completed: 1 }),
    )
    const result = await checkRun(workspace)
    expect(result.issues.some((i) => i.severity === 'error' && i.message.includes('cost_usd'))).toBe(true)
  })

  test('zero tokens → error', async () => {
    await writeCell(
      workspace,
      'synthetic',
      'cfg-aaaa',
      42,
      [baseRecord({ totals: { input: 0, output: 0 } })],
      baseSummary({ n_total: 1, n_completed: 1 }),
    )
    const result = await checkRun(workspace)
    expect(result.issues.some((i) => i.severity === 'error' && i.message.includes('no LLM call'))).toBe(true)
  })

  test('NaN score.primary → error', async () => {
    await writeCell(
      workspace,
      'synthetic',
      'cfg-aaaa',
      42,
      [baseRecord({ score: { primary: NaN } })],
      baseSummary({ n_total: 1, n_completed: 1 }),
    )
    const result = await checkRun(workspace)
    expect(result.issues.some((i) => i.severity === 'error' && i.message.includes('not finite'))).toBe(true)
  })
})

describe('checkRun — judged benches', () => {
  test('assistant-traj missing judge_cost_usd → warn (stub-grader hint)', async () => {
    await writeCell(
      workspace,
      'assistant-traj',
      'cfg-aaaa',
      42,
      [baseRecord({ bench: 'assistant-traj', score: { primary: 0.5 } })],
      baseSummary({ bench: 'assistant-traj', n_total: 1, n_completed: 1 }),
    )
    const result = await checkRun(workspace)
    expect(result.issues.some((i) => i.severity === 'warn' && i.message.includes('judge_cost_usd'))).toBe(true)
  })

  test('assistant-traj with valid judge cost + explanation → no judge warnings', async () => {
    await writeCell(
      workspace,
      'assistant-traj',
      'cfg-aaaa',
      42,
      [
        baseRecord({
          bench: 'assistant-traj',
          score: { primary: 0.5, judge_cost_usd: 0.0001, judge_explanation: 'matched' },
        }),
      ],
      baseSummary({ bench: 'assistant-traj', n_total: 1, n_completed: 1 }),
    )
    const result = await checkRun(workspace)
    const judgeIssues = result.issues.filter((i) => i.message.includes('judge'))
    expect(judgeIssues).toHaveLength(0)
  })
})

describe('checkRun — error rate gate', () => {
  test('25% error rate → error (above 10% gate)', async () => {
    const recs = [
      baseRecord({ task_id: 't1', errors: [] }),
      baseRecord({ task_id: 't2', errors: [] }),
      baseRecord({ task_id: 't3', errors: [] }),
      baseRecord({ task_id: 't4', errors: [{ turn_index: 0, kind: 'api_error', message: 'boom' }] }),
    ]
    await writeCell(workspace, 'synthetic', 'cfg-aaaa', 42, recs, baseSummary({ n_total: 4, n_completed: 4 }))
    const result = await checkRun(workspace)
    expect(result.issues.some((i) => i.severity === 'error' && i.message.includes('ErrorRecord rate'))).toBe(true)
  })

  test('5% error rate → no gate violation', async () => {
    const recs: RunRecord[] = []
    for (let i = 0; i < 20; i += 1) {
      recs.push(
        baseRecord({
          task_id: `t${String(i)}`,
          errors: i === 0 ? [{ turn_index: 0, kind: 'api_error', message: 'flake' }] : [],
        }),
      )
    }
    await writeCell(workspace, 'synthetic', 'cfg-aaaa', 42, recs, baseSummary({ n_total: 20, n_completed: 20 }))
    const result = await checkRun(workspace)
    expect(result.issues.some((i) => i.message.includes('ErrorRecord rate'))).toBe(false)
  })
})

describe('checkRun — accuracy degeneracy', () => {
  test('all-zero scores across 5 records → warn (stub-grader hint)', async () => {
    const recs = Array.from({ length: 5 }, (_, i) =>
      baseRecord({ task_id: `t${String(i)}`, score: { primary: 0 } }),
    )
    await writeCell(workspace, 'synthetic', 'cfg-aaaa', 42, recs, baseSummary({ n_total: 5, n_completed: 5 }))
    const result = await checkRun(workspace)
    expect(result.issues.some((i) => i.severity === 'warn' && i.message.includes('accuracy distribution constant'))).toBe(true)
  })

  test('mixed scores → no degeneracy warning', async () => {
    const recs = [
      baseRecord({ task_id: 't0', score: { primary: 0 } }),
      baseRecord({ task_id: 't1', score: { primary: 1 } }),
      baseRecord({ task_id: 't2', score: { primary: 0.5 } }),
    ]
    await writeCell(workspace, 'synthetic', 'cfg-aaaa', 42, recs, baseSummary({ n_total: 3, n_completed: 3 }))
    const result = await checkRun(workspace)
    expect(result.issues.some((i) => i.message.includes('accuracy distribution constant'))).toBe(false)
  })

  test('all-zero scores with n=2 → no warning (below stddev gate)', async () => {
    const recs = [
      baseRecord({ task_id: 't0', score: { primary: 0 } }),
      baseRecord({ task_id: 't1', score: { primary: 0 } }),
    ]
    await writeCell(workspace, 'synthetic', 'cfg-aaaa', 42, recs, baseSummary({ n_total: 2, n_completed: 2 }))
    const result = await checkRun(workspace)
    expect(result.issues.some((i) => i.message.includes('accuracy distribution constant'))).toBe(false)
  })
})

describe('checkRun — summary status', () => {
  test('summary.status=partial → warn', async () => {
    await writeCell(
      workspace,
      'synthetic',
      'cfg-aaaa',
      42,
      [baseRecord()],
      baseSummary({ n_total: 1, n_completed: 1, status: 'partial', halt_reason: 'budget' }),
    )
    const result = await checkRun(workspace)
    expect(result.issues.some((i) => i.severity === 'warn' && i.message.includes('status = partial'))).toBe(true)
  })
})

describe('formatReport', () => {
  test('produces lines that contain cell count + record count', () => {
    const text = formatReport({ cells_checked: 2, records_checked: 5, issues: [] })
    expect(text).toContain('cells=2')
    expect(text).toContain('records=5')
    expect(text).toContain('all asserts pass')
  })

  test('lists errors and warnings with severity markers', () => {
    const text = formatReport({
      cells_checked: 1,
      records_checked: 1,
      issues: [
        { severity: 'error', path: 'p', message: 'bad' },
        { severity: 'warn', path: 'p2', message: 'meh' },
      ],
    })
    expect(text).toContain('✗ p: bad')
    expect(text).toContain('! p2: meh')
    expect(text).toContain('1 error(s), 1 warning(s)')
  })
})
