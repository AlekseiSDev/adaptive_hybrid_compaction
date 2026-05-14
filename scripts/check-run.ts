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
      const tokens = (r.totals?.input ?? 0) + (r.totals?.output ?? 0)
      if (tokens <= 0) {
        issues.push({
          severity: 'error',
          path: recPath,
          message: 'totals.input + totals.output is 0 — no LLM call observed',
        })
      }
      // cost_usd = 0 with tokens > 0 is legitimate for baselines that don't
      // self-track cost (e.g., mastra_om — Mastra owns the provider call).
      // Surface as warn so we know to back-fill from tokens × pricing on the
      // F-side; not a hard error.
      if (!isFiniteNumber(r.cost_usd) || r.cost_usd < 0) {
        issues.push({
          severity: 'error',
          path: recPath,
          message: `cost_usd not finite/negative (${String(r.cost_usd)})`,
        })
      } else if (r.cost_usd === 0 && tokens > 0) {
        issues.push({
          severity: 'warn',
          path: recPath,
          message: `cost_usd=0 with tokens=${String(tokens)} — baseline likely does not self-track cost (e.g., mastra_om); back-fill from tokens × pricing on the F-side`,
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
        // judge_cost_usd = 0 with non-empty judge_explanation is a legitimate
        // cache HIT (see _judge-core.ts:109). Stub-grader fallback returns
        // primary=0 with judge_explanation='judge-stub' (assistant-traj.ts:153)
        // or no judge_explanation field (lme/locomo stub returns {primary:0}).
        // So flag only when judge_explanation is also empty.
        const je = r.score?.judge_explanation
        const hasExplanation = typeof je === 'string' && je.length > 0 && je !== 'judge-stub'
        if ((!isFiniteNumber(jc) || jc < 0) && !hasExplanation) {
          issues.push({
            severity: 'warn',
            path: recPath,
            message: `bench=${bench} expects LLM judge but judge_cost_usd=${String(jc)} AND judge_explanation absent/empty — possible stub-grader fallback`,
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

    // AHC feature-dormancy detection (H6.5/H6.7 audit, 2026-05-14).
    // If the cell looks like an AHC config but no compaction events fired
    // across any record, the sweep YAML likely shipped `ahc_flags: {}` —
    // defaultFeatureFlags has TASK_AWARE_EXTRACTION/TYPE_AWARE_OFFLOAD/etc. at
    // false, so dispatch skips them silently. Surfaces as warn (cell still
    // produces accuracy numbers; just none of the AHC mechanisms exercised).
    const looksAhc = /(^ahc_)|(_ahc(?:$|_))/.test(cell.cellRel.split('/')[1] ?? '')
    if (looksAhc && records.length >= 3) {
      const totalCompactionEvents = records.reduce(
        (acc, r) => acc + (r.turns ?? []).reduce((a, t) => a + (t.compaction_events?.length ?? 0), 0),
        0,
      )
      if (totalCompactionEvents === 0) {
        issues.push({
          severity: 'warn',
          path: cell.cellRel,
          message: `AHC dormancy: 0 compaction events across ${String(records.length)} records — verify ahc_flags in sweep YAML (defaults are mostly OFF; H6.5 audit)`,
        })
      }
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
