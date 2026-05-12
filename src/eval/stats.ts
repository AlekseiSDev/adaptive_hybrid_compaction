import type { RunRecord, TrajectoryClass } from './types.js'

// Statistical pipeline. Pure functions over RunRecord[]. Source of truth:
// design/B_eval-harness.md §5 (stats) + §7 (per-class breakdown).
// B3 ships perClassBreakdown + pairedPermutation; bootstrapCI deferred (orthogonal).

export type ClassBucket = TrajectoryClass | 'unknown'

export type ClassStats = {
  n: number
  mean_primary: number
  stderr: number
}

export function modeClassOfTask(record: RunRecord): TrajectoryClass | null {
  const counts = new Map<TrajectoryClass, number>()
  for (const turn of record.turns) {
    if (!turn.class_signal) continue
    const c = turn.class_signal.class
    counts.set(c, (counts.get(c) ?? 0) + 1)
  }
  if (counts.size === 0) return null
  // Ties broken alphabetically для determinism (per decisions.md 2026-05-13 B3 entry).
  const sortedKeys = [...counts.keys()].sort()
  let maxCount = -1
  let maxClass: TrajectoryClass | null = null
  for (const k of sortedKeys) {
    const c = counts.get(k) ?? 0
    if (c > maxCount) {
      maxCount = c
      maxClass = k
    }
  }
  return maxClass
}

export function perClassBreakdown(
  records: readonly RunRecord[],
  classExtractor: (r: RunRecord) => TrajectoryClass | null,
): Map<ClassBucket, ClassStats> {
  const buckets = new Map<ClassBucket, number[]>()
  for (const r of records) {
    const c: ClassBucket = classExtractor(r) ?? 'unknown'
    const arr = buckets.get(c) ?? []
    arr.push(r.score.primary)
    buckets.set(c, arr)
  }
  const result = new Map<ClassBucket, ClassStats>()
  for (const [k, scores] of buckets) {
    const n = scores.length
    const mean = scores.reduce((s, x) => s + x, 0) / n
    const variance =
      n > 1
        ? scores.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1)
        : 0
    const stderr = Math.sqrt(variance / n)
    result.set(k, { n, mean_primary: mean, stderr })
  }
  return result
}

export type PairedPermutationResult = {
  delta: number
  p_value: number
  n_pairs: number
}

// Paired permutation test. Pivot = task_id (per design/B_eval-harness.md §5
// "Парные тесты — paired по task_id, не по subjects"). Drop unmatched. Two-sided.
export function pairedPermutation(
  records_a: readonly RunRecord[],
  records_b: readonly RunRecord[],
  metric: (r: RunRecord) => number,
  n_perm = 10000,
): PairedPermutationResult {
  const aMap = new Map<string, number>()
  const bMap = new Map<string, number>()
  for (const r of records_a) aMap.set(r.task_id, metric(r))
  for (const r of records_b) bMap.set(r.task_id, metric(r))

  const diffs: number[] = []
  for (const [task_id, vA] of aMap) {
    const vB = bMap.get(task_id)
    if (vB === undefined) continue
    diffs.push(vA - vB)
  }

  const n = diffs.length
  if (n === 0) return { delta: 0, p_value: 1, n_pairs: 0 }

  const observedDelta = diffs.reduce((s, x) => s + x, 0) / n
  const observedAbs = Math.abs(observedDelta)

  let extremeCount = 0
  for (let i = 0; i < n_perm; i += 1) {
    let sum = 0
    for (const d of diffs) {
      sum += Math.random() < 0.5 ? d : -d
    }
    const mean = sum / n
    if (Math.abs(mean) >= observedAbs) extremeCount += 1
  }

  return {
    delta: observedDelta,
    p_value: extremeCount / n_perm,
    n_pairs: n,
  }
}
