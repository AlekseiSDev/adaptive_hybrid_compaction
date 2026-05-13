#!/usr/bin/env tsx
// Validity checker for sweep output. Scans <runDir>/**/{records.ndjson,
// summary.json} and flags violations of "results look real" invariants:
//   - non-empty token usage (LLM was actually called)
//   - per-record cost_usd > 0 (cost tracking populated)
//   - score.primary is a finite number (grader returned, not undefined/NaN)
//   - judge cost > 0 when grader injected a judge (assistant-traj / lme / locomo)
//   - per-cell error rate < 10% (§9 post-run audit gate)
//   - accuracy distribution non-degenerate (anti all-0 / all-1 stub regression)
//
// Exit 0 if all asserts pass; exit 1 with itemized failures otherwise.

import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { RunRecord, RunSummary } from '../src/eval/types.js'

const ERR_RATE_GATE = 0.10
const ACCURACY_STDDEV_MIN_N = 3 // below this n, allow constant accuracy

export type CheckIssue = {
  severity: 'error' | 'warn'
  path: string
  message: string
}

export type CheckResult = {
  cells_checked: number
  records_checked: number
  issues: CheckIssue[]
}

// Walks runDir three levels: bench/config_id/seed/. Returns paths to summary.json
// and records.ndjson for each cell found.
async function findCells(runDir: string): Promise<{ summary: string; records: string; cellRel: string }[]> {
  const cells: { summary: string; records: string; cellRel: string }[] = []
  let benches: string[]
  try {
    benches = await readdir(runDir, { withFileTypes: true }).then((es) =>
      es.filter((e) => e.isDirectory()).map((e) => e.name),
    )
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  for (const bench of benches) {
    const benchDir = join(runDir, bench)
    const configs = await readdir(benchDir, { withFileTypes: true })
      .then((es) => es.filter((e) => e.isDirectory()).map((e) => e.name))
      .catch(() => [] as string[])
    for (const cfg of configs) {
      const cfgDir = join(benchDir, cfg)
      const seeds = await readdir(cfgDir, { withFileTypes: true })
        .then((es) => es.filter((e) => e.isDirectory()).map((e) => e.name))
        .catch(() => [] as string[])
      for (const seed of seeds) {
        const cellDir = join(cfgDir, seed)
        const summary = join(cellDir, 'summary.json')
        const records = join(cellDir, 'records.ndjson')
        if (existsSync(records)) {
          cells.push({ summary, records, cellRel: `${bench}/${cfg}/${seed}` })
        }
      }
    }
  }
  return cells
}

async function readRecords(path: string): Promise<RunRecord[]> {
  const content = await readFile(path, 'utf8')
  const out: RunRecord[] = []
  for (const line of content.split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line) as RunRecord)
    } catch {
      // Malformed line — caller will see record count mismatch.
    }
  }
  return out
}

async function readSummary(path: string): Promise<RunSummary | undefined> {
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(await readFile(path, 'utf8')) as RunSummary
  } catch {
    return undefined
  }
}

function isFiniteNumber(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x)
}

function stddev(values: number[]): number {
  if (values.length < 2) return 0
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length
  return Math.sqrt(variance)
}

// Detects "judge was expected to run but did not": graders that wrap an LLM
// judge populate score.judge_explanation; absence on benches where it should
// be present is a red flag for stub-grader regression.
function benchHasJudge(bench: string): boolean {
  return (
    bench === 'assistant-traj' ||
    bench === 'longmemeval-med' ||
    bench === 'locomo-med'
  )
}

export async function checkRun(runDir: string): Promise<CheckResult> {
  const issues: CheckIssue[] = []
  const cells = await findCells(runDir)
  if (cells.length === 0) {
    issues.push({
      severity: 'error',
      path: runDir,
      message: 'no cell records.ndjson found under runDir',
    })
    return { cells_checked: 0, records_checked: 0, issues }
  }

  let totalRecords = 0
  for (const cell of cells) {
    const records = await readRecords(cell.records)
    const summary = await readSummary(cell.summary)
    totalRecords += records.length

    if (records.length === 0) {
      issues.push({
        severity: 'error',
        path: cell.cellRel,
        message: 'records.ndjson present but empty (0 records)',
      })
      continue
    }

    const bench = records[0]?.bench ?? 'unknown'
    const hasJudge = benchHasJudge(bench)

    // Per-record validity asserts.
    for (let i = 0; i < records.length; i += 1) {
      const r = records[i]
      if (!r) continue
      const recPath = `${cell.cellRel}#${String(i)} (task=${r.task_id})`
      if (!isFiniteNumber(r.cost_usd) || r.cost_usd <= 0) {
        issues.push({
          severity: 'error',
          path: recPath,
          message: `cost_usd not positive (${String(r.cost_usd)})`,
        })
      }
      const tokens = (r.totals?.input ?? 0) + (r.totals?.output ?? 0)
      if (tokens <= 0) {
        issues.push({
          severity: 'error',
          path: recPath,
          message: 'totals.input + totals.output is 0 — no LLM call observed',
        })
      }
      if (!isFiniteNumber(r.score?.primary)) {
        issues.push({
          severity: 'error',
          path: recPath,
          message: `score.primary not finite (${String(r.score?.primary)})`,
        })
      }
      if (hasJudge) {
        const jc = r.score?.judge_cost_usd
        if (!isFiniteNumber(jc) || jc <= 0) {
          issues.push({
            severity: 'warn',
            path: recPath,
            message: `bench=${bench} expects LLM judge but judge_cost_usd not positive (${String(jc)}); possible stub-grader fallback`,
          })
        }
        const je = r.score?.judge_explanation
        if (typeof je !== 'string' || je.length === 0) {
          issues.push({
            severity: 'warn',
            path: recPath,
            message: `bench=${bench} expects judge_explanation but field empty/absent`,
          })
        }
      }
    }

    // Per-summary asserts.
    if (!summary) {
      issues.push({
        severity: 'warn',
        path: cell.cellRel,
        message: 'summary.json missing (cell may not have finalized)',
      })
    } else {
      if (summary.n_completed === 0) {
        issues.push({
          severity: 'error',
          path: cell.cellRel,
          message: 'summary.n_completed = 0',
        })
      }
      if (summary.status === 'partial') {
        issues.push({
          severity: 'warn',
          path: cell.cellRel,
          message: `summary.status = partial (halt_reason: ${summary.halt_reason ?? 'unknown'})`,
        })
      }
    }

    // Error rate gate.
    const totalErrors = records.reduce((acc, r) => acc + (r.errors?.length ?? 0), 0)
    const errRate = totalErrors / records.length
    if (errRate >= ERR_RATE_GATE) {
      issues.push({
        severity: 'error',
        path: cell.cellRel,
        message: `ErrorRecord rate ${(errRate * 100).toFixed(1)}% >= ${(ERR_RATE_GATE * 100).toFixed(0)}% gate (${String(totalErrors)} errs / ${String(records.length)} records)`,
      })
    }

    // Accuracy distribution non-degeneracy. Skip for small n (statistical noise
    // can produce a constant value with only 1-2 tasks).
    if (records.length >= ACCURACY_STDDEV_MIN_N) {
      const scores = records
        .map((r) => r.score?.primary)
        .filter((s): s is number => isFiniteNumber(s))
      if (scores.length >= ACCURACY_STDDEV_MIN_N) {
        const sd = stddev(scores)
        if (sd === 0) {
          // All-zero / all-one / all-same — likely stub grader or trivial bench.
          const constant = scores[0]
          issues.push({
            severity: 'warn',
            path: cell.cellRel,
            message: `accuracy distribution constant (${String(constant)} across ${String(scores.length)} records) — possible stub grader or trivial task set`,
          })
        }
      }
    }
  }

  return { cells_checked: cells.length, records_checked: totalRecords, issues }
}

export function formatReport(result: CheckResult): string {
  const lines: string[] = []
  lines.push(
    `[check-run] cells=${String(result.cells_checked)} records=${String(result.records_checked)}`,
  )
  const errors = result.issues.filter((i) => i.severity === 'error')
  const warns = result.issues.filter((i) => i.severity === 'warn')
  for (const issue of errors) {
    lines.push(`  ✗ ${issue.path}: ${issue.message}`)
  }
  for (const issue of warns) {
    lines.push(`  ! ${issue.path}: ${issue.message}`)
  }
  if (result.issues.length === 0) {
    lines.push('  ✓ all asserts pass')
  } else {
    lines.push(
      `[check-run] ${String(errors.length)} error(s), ${String(warns.length)} warning(s)`,
    )
  }
  return lines.join('\n')
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  if (argv.length === 0) {
    console.error('usage: tsx scripts/check-run.ts <runDir>')
    process.exit(1)
  }
  const runDir = resolve(argv[0] ?? '.')
  const result = await checkRun(runDir)
  console.log(formatReport(result))
  const hasErrors = result.issues.some((i) => i.severity === 'error')
  process.exit(hasErrors ? 1 : 0)
}

const entryUrl = `file://${process.argv[1] ?? ''}`
if (import.meta.url === entryUrl) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  })
}
