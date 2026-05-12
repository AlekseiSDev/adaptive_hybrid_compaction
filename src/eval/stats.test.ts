import { describe, expect, test } from 'vitest'
import {
  modeClassOfTask,
  pairedPermutation,
  perClassBreakdown,
} from './stats.js'
import type { RunRecord, TrajectoryClass, TurnRecord } from './types.js'

const makeTurn = (
  turn_index: number,
  cls?: TrajectoryClass,
  confidence = 0.9,
): TurnRecord => ({
  turn_index,
  input_tokens: 0,
  output_tokens: 0,
  wall_clock_ms: 0,
  recall_events: [],
  compaction_events: [],
  ...(cls !== undefined ? { class_signal: { class: cls, confidence } } : {}),
})

const makeRecord = (
  task_id: string,
  primary: number,
  turns: TurnRecord[] = [],
): RunRecord => ({
  run_id: 'r-' + task_id,
  bench: 'synthetic',
  config_id: 'c1',
  seed: 0,
  task_id,
  started_at: 0,
  completed_at: 1,
  score: { primary },
  totals: { input: 0, output: 0 },
  cost_usd: 0,
  turns,
  errors: [],
})

describe('modeClassOfTask', () => {
  test('majority class wins across turns', () => {
    const r = makeRecord('t', 1, [
      makeTurn(0, 'conversational'),
      makeTurn(1, 'conversational'),
      makeTurn(2, 'conversational'),
      makeTurn(3, 'tool_heavy'),
      makeTurn(4, 'tool_heavy'),
    ])
    expect(modeClassOfTask(r)).toBe('conversational')
  })

  test('no class_signal anywhere → null', () => {
    const r = makeRecord('t', 1, [makeTurn(0), makeTurn(1)])
    expect(modeClassOfTask(r)).toBeNull()
  })

  test('empty turns → null', () => {
    expect(modeClassOfTask(makeRecord('t', 1, []))).toBeNull()
  })

  test('tie broken alphabetically (deterministic)', () => {
    const r = makeRecord('t', 1, [
      makeTurn(0, 'tool_heavy'),
      makeTurn(1, 'mixed'),
      makeTurn(2, 'conversational'),
    ])
    // All classes 1×1; sorted keys ['conversational', 'mixed', 'tool_heavy'];
    // first wins.
    expect(modeClassOfTask(r)).toBe('conversational')
  })

  test('turns without class_signal are skipped (do not count)', () => {
    const r = makeRecord('t', 1, [
      makeTurn(0, 'tool_heavy'),
      makeTurn(1),
      makeTurn(2, 'tool_heavy'),
      makeTurn(3),
    ])
    expect(modeClassOfTask(r)).toBe('tool_heavy')
  })
})

describe('perClassBreakdown — TDD seed', () => {
  test('aggregate matches mode-class on synthetic NDJSON (B3 TDD seed)', () => {
    const records = [
      // 3 conversational tasks, scores 1, 1, 0 → mean=2/3, n=3
      makeRecord('t1', 1, [makeTurn(0, 'conversational'), makeTurn(1, 'conversational')]),
      makeRecord('t2', 1, [makeTurn(0, 'conversational')]),
      makeRecord('t3', 0, [makeTurn(0, 'conversational'), makeTurn(1, 'conversational')]),
      // 2 tool_heavy tasks, scores 1, 1
      makeRecord('t4', 1, [makeTurn(0, 'tool_heavy')]),
      makeRecord('t5', 1, [makeTurn(0, 'tool_heavy'), makeTurn(1, 'tool_heavy')]),
      // 1 task w/o class_signal → 'unknown' bucket
      makeRecord('t6', 0, [makeTurn(0)]),
    ]

    const breakdown = perClassBreakdown(records, modeClassOfTask)
    const conv = breakdown.get('conversational')
    const tool = breakdown.get('tool_heavy')
    const unknown = breakdown.get('unknown')
    expect(conv?.n).toBe(3)
    expect(conv?.mean_primary).toBeCloseTo(2 / 3, 5)
    expect(tool?.n).toBe(2)
    expect(tool?.mean_primary).toBe(1)
    expect(unknown?.n).toBe(1)
    expect(unknown?.mean_primary).toBe(0)
  })

  test('stderr is 0 for single-record bucket', () => {
    const records = [makeRecord('t', 1, [makeTurn(0, 'conversational')])]
    const breakdown = perClassBreakdown(records, modeClassOfTask)
    expect(breakdown.get('conversational')?.stderr).toBe(0)
  })

  test('empty input → empty Map', () => {
    expect(perClassBreakdown([], modeClassOfTask).size).toBe(0)
  })
})

describe('pairedPermutation', () => {
  test('identical record sets → delta=0, p_value=1', () => {
    const records = [
      makeRecord('t1', 1),
      makeRecord('t2', 0),
      makeRecord('t3', 1),
    ]
    const result = pairedPermutation(records, records, (r) => r.score.primary, 1000)
    expect(result.delta).toBe(0)
    expect(result.p_value).toBe(1)
    expect(result.n_pairs).toBe(3)
  })

  test('large signal: A all 1, B all 0 → delta=1, p_value < 0.01', () => {
    const a = Array.from({ length: 20 }, (_, i) => makeRecord('t' + String(i), 1))
    const b = Array.from({ length: 20 }, (_, i) => makeRecord('t' + String(i), 0))
    const result = pairedPermutation(a, b, (r) => r.score.primary, 5000)
    expect(result.delta).toBe(1)
    // Probability of all 20 sign-flips landing same direction ≈ 2^-19 ≈ 2e-6 → p_value ~0
    expect(result.p_value).toBeLessThan(0.01)
    expect(result.n_pairs).toBe(20)
  })

  test('only intersect by task_id (drop unmatched)', () => {
    const a = [makeRecord('t1', 1), makeRecord('t2', 1)]
    const b = [makeRecord('t1', 0), makeRecord('t3', 0)]
    const result = pairedPermutation(a, b, (r) => r.score.primary, 100)
    expect(result.n_pairs).toBe(1)
    expect(result.delta).toBe(1)
  })

  test('no overlap → n_pairs=0, delta=0, p_value=1', () => {
    const a = [makeRecord('t1', 1)]
    const b = [makeRecord('t2', 0)]
    const result = pairedPermutation(a, b, (r) => r.score.primary, 100)
    expect(result.n_pairs).toBe(0)
    expect(result.delta).toBe(0)
    expect(result.p_value).toBe(1)
  })
})
