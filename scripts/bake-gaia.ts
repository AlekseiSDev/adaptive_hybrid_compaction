#!/usr/bin/env tsx
// One-shot data import for GAIA-med (Track K, K1). Per docs/design/K_gaia.md.
//
// Usage:
//   pnpm tsx scripts/bake-gaia.ts [<path/to/gaia_validation_30.json>]
//
// Default source: references/gaia/data/gaia_validation_30.json (Holosophus
// snapshot, see references/gaia/README.md for provenance). Per-task JSON
// files emitted to benchmarks/gaia/tasks/gaia_<NNN>.json, idempotent
// (overwrites preserve directory state — re-running produces same bytes).
//
// Attachment filter (Medium scope per K_gaia.md §7 Q5): tasks with
// has_file:true are filtered out (xlsx/pdf/pdb/jsonld/docx/png — image
// attachments referenced on gated HF, not vendored).
// Effective n on validation_30 snapshot ≈ 25/30.

import { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { GaiaTaskSchema, type GaiaTask } from '../src/eval/adapters/gaia-med.schema.js'

function repoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..')
}

async function main(): Promise<void> {
  const [, , inputArg] = process.argv
  const defaultSource = join(repoRoot(), 'references/gaia/data/gaia_validation_30.json')
  const inputPath = inputArg ?? defaultSource

  const abs = resolve(inputPath)
  let raw: string
  try {
    raw = readFileSync(abs, 'utf8')
  } catch (err) {
    console.error(`[bake-gaia] failed to read ${abs}: ${(err as Error).message}`)
    process.exit(1)
  }

  const parsed = JSON.parse(raw) as unknown
  if (!Array.isArray(parsed)) {
    console.error(`[bake-gaia] expected JSON array, got ${typeof parsed}`)
    process.exit(1)
  }
  console.log(`[bake-gaia] loaded ${String(parsed.length)} items from ${abs}`)

  const valid: GaiaTask[] = []
  let skippedAttachment = 0
  let skippedInvalid = 0
  for (const item of parsed) {
    const r = GaiaTaskSchema.safeParse(item)
    if (!r.success) {
      console.warn(`[bake-gaia] invalid item: ${r.error.message}`)
      skippedInvalid += 1
      continue
    }
    if (r.data.has_file) {
      skippedAttachment += 1
      continue
    }
    valid.push(r.data)
  }

  const outDir = join(repoRoot(), 'benchmarks/gaia/tasks')
  mkdirSync(outDir, { recursive: true })

  // Clean stale files (idempotency under input changes).
  const stale = readdirSync(outDir).filter((f) => f.startsWith('gaia_') && f.endsWith('.json'))
  for (const f of stale) unlinkSync(join(outDir, f))

  for (const t of valid) {
    const fn = `gaia_${String(t.idx).padStart(3, '0')}.json`
    writeFileSync(join(outDir, fn), JSON.stringify(t, null, 2) + '\n')
  }
  console.log(
    `[bake-gaia] wrote ${String(valid.length)} tasks to ${outDir} ` +
      `(skipped: attachment=${String(skippedAttachment)} invalid=${String(skippedInvalid)})`,
  )
}

await main()
