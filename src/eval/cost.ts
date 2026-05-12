import type { RunRecord } from './types.js'

// CostTracker — circuit-breaker per design/B_eval-harness.md §6.
// Activated в runSweep с B2 (см. decisions.md 2026-05-13 B2 entries — не каркас).
// Halt = clean break per (config × seed) loop; NDJSON state preserved (resumable).

export type ShouldHaltOpts = {
  budget_usd: number
  total_tasks: number
}

export type ShouldHaltResult =
  | { halt: false }
  | { halt: true; reason: string }

const MIN_OBSERVATIONS = 20
const PROJECTION_FACTOR = 1.5

export class CostTracker {
  private cumulative_usd = 0
  private task_count = 0

  observe(record: RunRecord): void {
    this.cumulative_usd += record.cost_usd
    this.task_count += 1
  }

  shouldHalt(opts: ShouldHaltOpts): ShouldHaltResult {
    if (this.task_count < MIN_OBSERVATIONS) return { halt: false }
    const meanCost = this.cumulative_usd / this.task_count
    const projected = meanCost * opts.total_tasks
    if (projected > PROJECTION_FACTOR * opts.budget_usd) {
      return {
        halt: true,
        reason: `projected $${projected.toFixed(2)} > 1.5× budget $${opts.budget_usd.toFixed(2)} after ${String(this.task_count)} tasks`,
      }
    }
    return { halt: false }
  }

  get totalUsd(): number {
    return this.cumulative_usd
  }

  get count(): number {
    return this.task_count
  }
}
