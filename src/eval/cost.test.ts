import { describe, expect, test } from 'vitest'
import { CostTracker } from './cost.js'
import type { RunRecord } from './types.js'

const makeRecord = (cost_usd: number, task_id = 't'): RunRecord => ({
  run_id: 'r-' + task_id,
  bench: 'synthetic',
  config_id: 'c1',
  seed: 42,
  task_id,
  started_at: 0,
  completed_at: 1,
  score: { primary: 1 },
  totals: { input: 0, output: 0 },
  cost_usd,
  turns: [],
  errors: [],
})

describe('CostTracker', () => {
  test('empty tracker → shouldHalt = false (no observations yet)', () => {
    const ct = new CostTracker()
    expect(ct.shouldHalt({ budget_usd: 100, total_tasks: 200 })).toEqual({
      halt: false,
    })
    expect(ct.totalUsd).toBe(0)
    expect(ct.count).toBe(0)
  })

  test('observe accumulates cumulative_usd and count', () => {
    const ct = new CostTracker()
    ct.observe(makeRecord(0.5))
    ct.observe(makeRecord(0.25))
    expect(ct.totalUsd).toBeCloseTo(0.75, 5)
    expect(ct.count).toBe(2)
  })

  test('19 records → no halt (need ≥ 20 observations)', () => {
    const ct = new CostTracker()
    for (let i = 0; i < 19; i += 1) ct.observe(makeRecord(10, 't' + String(i)))
    // Even with absurdly high per-task cost, halt does not trigger before threshold.
    const decision = ct.shouldHalt({ budget_usd: 1, total_tasks: 100 })
    expect(decision.halt).toBe(false)
  })

  test('20 records, projected > 1.5× budget → halt with reason text', () => {
    const ct = new CostTracker()
    // mean_cost = 1.0; total_tasks = 100 → projected = 100; budget = 50; 100 > 75 → halt
    for (let i = 0; i < 20; i += 1) ct.observe(makeRecord(1, 't' + String(i)))
    const decision = ct.shouldHalt({ budget_usd: 50, total_tasks: 100 })
    expect(decision.halt).toBe(true)
    if (decision.halt) {
      expect(decision.reason).toContain('projected')
      expect(decision.reason).toContain('1.5')
    }
  })

  test('20 records, projected < 1.5× budget → no halt', () => {
    const ct = new CostTracker()
    // mean_cost = 0.5; total_tasks = 100 → projected = 50; budget = 100; 50 < 150 → ok
    for (let i = 0; i < 20; i += 1) ct.observe(makeRecord(0.5, 't' + String(i)))
    const decision = ct.shouldHalt({ budget_usd: 100, total_tasks: 100 })
    expect(decision.halt).toBe(false)
  })

  test('exactly at 1.5× budget → no halt (strict greater-than)', () => {
    const ct = new CostTracker()
    // mean = 1.5; total = 100; projected = 150 = exactly 1.5 × 100 → boundary, not halt
    for (let i = 0; i < 20; i += 1) ct.observe(makeRecord(1.5, 't' + String(i)))
    const decision = ct.shouldHalt({ budget_usd: 100, total_tasks: 100 })
    expect(decision.halt).toBe(false)
  })
})
