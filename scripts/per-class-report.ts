#!/usr/bin/env tsx
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { readAllRecords } from '../src/eval/persist.js'
import { modeClassOfTask, perClassBreakdown } from '../src/eval/stats.js'

function parseArgs(argv: string[]): { runDir: string } {
  if (argv.length === 0) {
    console.error('usage: tsx scripts/per-class-report.ts <runDir>')
    process.exit(1)
  }
  const runDir = argv[0]
  if (typeof runDir !== 'string' || runDir.length === 0) {
    console.error('error: <runDir> argument is required')
    process.exit(1)
  }
  return { runDir }
}

function pad(s: string, n: number): string {
  if (s.length >= n) return s
  return s + ' '.repeat(n - s.length)
}

async function main(): Promise<void> {
  const { runDir } = parseArgs(process.argv.slice(2))
  const absDir = resolve(runDir)
  if (!existsSync(absDir)) {
    console.error(`error: runDir does not exist: ${absDir}`)
    process.exit(1)
  }

  const records = await readAllRecords(absDir)
  if (records.length === 0) {
    console.error(`warning: no records.ndjson rows under ${absDir}`)
  }

  const breakdown = perClassBreakdown(records, modeClassOfTask)
  const orderedKeys: ReadonlyArray<'conversational' | 'tool_heavy' | 'mixed' | 'unknown'> =
    ['conversational', 'tool_heavy', 'mixed', 'unknown']

  console.log(
    `[per-class-report] runDir=${absDir}  total_records=${String(records.length)}`,
  )
  console.log(
    `${pad('class', 16)}${pad('n', 6)}${pad('mean_primary', 16)}stderr`,
  )
  console.log('-'.repeat(50))
  for (const k of orderedKeys) {
    const stats = breakdown.get(k)
    if (!stats) continue
    console.log(
      `${pad(k, 16)}${pad(String(stats.n), 6)}${pad(stats.mean_primary.toFixed(4), 16)}${stats.stderr.toFixed(4)}`,
    )
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
