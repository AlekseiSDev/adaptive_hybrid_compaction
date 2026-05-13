#!/usr/bin/env tsx
// Sanity-aggregator: prints a per-sweep markdown table from summary.json
// files to spot fantastical numbers (e.g. AHC=0% accuracy while
// full_context=80% → AHC broken; cost/task=$10 → stuck retry loop).
//
// NOT a stat pipeline — Track F handles paired permutation / bootstrap.
// This is a fast eyeball check (per user 2026-05-13: "базовые агрегации
// простые, чтоб чекнуть что чиселки не фантастические, но не прям все
// считать").

import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { RunRecord, RunSummary } from '../src/eval/types.js'

export type CellRow = {
  bench: string
  config_id: string
  seed: number
  n: number
  accuracy: number
  cost_usd: number
  err_rate: number
  judge_cost_usd: number
  status: 'complete' | 'partial' | 'missing'
}

async function findCells(runDir: string): Promise<{ summary: string; records: string; bench: string; config_id: string; seed: number }[]> {
  const cells: { summary: string; records: string; bench: string; config_id: string; seed: number }[] = []
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
        const seedNum = Number.parseInt(seed, 10)
        if (!Number.isFinite(seedNum)) continue
        cells.push({
          summary: join(cellDir, 'summary.json'),
          records: join(cellDir, 'records.ndjson'),
          bench,
          config_id: cfg,
          seed: seedNum,
        })
      }
    }
  }
  return cells
}

async function readRecords(path: string): Promise<RunRecord[]> {
  if (!existsSync(path)) return []
  try {
    const content = await readFile(path, 'utf8')
    const out: RunRecord[] = []
    for (const line of content.split('\n')) {
      if (!line.trim()) continue
      try {
        out.push(JSON.parse(line) as RunRecord)
      } catch {
        // skip
      }
    }
    return out
  } catch {
    return []
  }
}

async function readSummary(path: string): Promise<RunSummary | undefined> {
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(await readFile(path, 'utf8')) as RunSummary
  } catch {
    return undefined
  }
}

export async function aggregateRun(runDir: string): Promise<CellRow[]> {
  const cells = await findCells(runDir)
  const rows: CellRow[] = []
  for (const cell of cells) {
    const summary = await readSummary(cell.summary)
    const records = await readRecords(cell.records)
    const totalErrors = records.reduce((acc, r) => acc + (r.errors?.length ?? 0), 0)
    const judgeCost = records.reduce(
      (acc, r) => acc + (r.score?.judge_cost_usd ?? 0),
      0,
    )
    const status: CellRow['status'] = summary?.status ?? 'missing'
    rows.push({
      bench: cell.bench,
      config_id: cell.config_id,
      seed: cell.seed,
      n: summary?.n_completed ?? records.length,
      accuracy: summary?.mean_primary_score ?? 0,
      cost_usd: summary?.total_cost_usd ?? records.reduce((a, r) => a + (r.cost_usd ?? 0), 0),
      err_rate: records.length > 0 ? totalErrors / records.length : 0,
      judge_cost_usd: judgeCost,
      status,
    })
  }
  rows.sort((a, b) => {
    if (a.bench !== b.bench) return a.bench.localeCompare(b.bench)
    if (a.config_id !== b.config_id) return a.config_id.localeCompare(b.config_id)
    return a.seed - b.seed
  })
  return rows
}

export function formatTable(rows: CellRow[]): string {
  const lines: string[] = []
  lines.push('| bench | config | seed | n | accuracy | cost ($) | err_rate | judge ($) | status |')
  lines.push('|-------|--------|------|---|----------|----------|----------|-----------|--------|')
  for (const r of rows) {
    lines.push(
      `| ${r.bench} | ${r.config_id} | ${String(r.seed)} | ${String(r.n)} | ` +
        `${r.accuracy.toFixed(3)} | ${r.cost_usd.toFixed(4)} | ` +
        `${(r.err_rate * 100).toFixed(1)}% | ${r.judge_cost_usd.toFixed(4)} | ` +
        `${r.status} |`,
    )
  }
  if (rows.length === 0) {
    lines.push('| (no cells found) | | | | | | | | |')
  }
  // Tail: total row.
  const total = rows.reduce(
    (acc, r) => ({
      n: acc.n + r.n,
      cost: acc.cost + r.cost_usd,
      judge: acc.judge + r.judge_cost_usd,
    }),
    { n: 0, cost: 0, judge: 0 },
  )
  lines.push('')
  lines.push(
    `**Totals:** cells=${String(rows.length)}, records=${String(total.n)}, ` +
      `cost=$${total.cost.toFixed(4)}, judge=$${total.judge.toFixed(4)}`,
  )
  return lines.join('\n')
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  if (argv.length === 0) {
    console.error('usage: tsx scripts/sanity-aggregate.ts <runDir>')
    process.exit(1)
  }
  const runDir = resolve(argv[0] ?? '.')
  const rows = await aggregateRun(runDir)
  console.log(formatTable(rows))
}

const entryUrl = `file://${process.argv[1] ?? ''}`
if (import.meta.url === entryUrl) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  })
}
