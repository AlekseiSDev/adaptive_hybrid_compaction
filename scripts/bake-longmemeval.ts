#!/usr/bin/env tsx
// One-shot data import for LongMemEval-med. Per D5 plan Step 2.
//
// Usage:
//   pnpm tsx scripts/bake-longmemeval.ts <path/to/longmemeval_s.json>
//
// Downloads stratified med-subset (n=120, seed=42) from a user-supplied copy
// of upstream `longmemeval_s.json`. The full dataset isn't redistributable
// in our repo (size + license caution) — user obtains it from upstream:
//   github.com/xiaowu0162/LongMemEval (data hosted there or on HF — README links)
//
// Output:
//   benchmarks/longmemeval/tasks/lme_<question_id>.json × ~120
//   benchmarks/longmemeval/subset_ids.json (frozen seed=42 selection)
//
// stratified_sample is a verbatim port of `references/mle-harness/code/
// run_main.py:46-66` to TS. Per D5 plan risk #5: spot-check first 5
// question_ids vs upstream `references/mle-harness/results/longmemeval_main.jsonl`
// first 5 rows для parity.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

type LmeItem = {
  question_id: string
  question_type: string
  haystack_sessions: { role: string; content: string }[][]
  haystack_session_ids?: string[]
  haystack_dates?: string[]
  question: string
  answer: string
}

// Mulberry32 — small reproducible 32-bit PRNG. Python's random.Random(seed) uses
// Mersenne Twister; we don't aim для byte-exact parity (verify в Risk #5
// instructs spot-check + commit `subset_ids.json` если mismatch).
function mulberry32(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function shuffleInPlace<T>(arr: T[], rng: () => number): void {
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j] as T, arr[i] as T]
  }
}

function stratifiedSample(items: LmeItem[], n: number, seed: number): LmeItem[] {
  const rng = mulberry32(seed)
  const byType: Record<string, LmeItem[]> = {}
  for (const it of items) {
    const arr = byType[it.question_type] ?? []
    arr.push(it)
    byType[it.question_type] = arr
  }
  const total = items.length
  const raw: Record<string, number> = {}
  for (const [qt, lst] of Object.entries(byType)) {
    raw[qt] = (n * lst.length) / total
  }
  const base: Record<string, number> = {}
  for (const qt of Object.keys(raw)) {
    base[qt] = Math.floor(raw[qt] ?? 0)
  }
  const deficit = n - Object.values(base).reduce((a, b) => a + b, 0)
  const rems = Object.entries(raw).sort(
    (a, b) => b[1] - Math.floor(b[1]) - (a[1] - Math.floor(a[1])),
  )
  for (let i = 0; i < deficit; i += 1) {
    const qt = rems[i]?.[0]
    if (qt !== undefined) base[qt] = (base[qt] ?? 0) + 1
  }
  const sampled: LmeItem[] = []
  for (const [qt, q] of Object.entries(base)) {
    const pool = [...(byType[qt] ?? [])]
    shuffleInPlace(pool, rng)
    sampled.push(...pool.slice(0, q))
  }
  shuffleInPlace(sampled, rng)
  return sampled
}

function repoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..')
}

async function main(): Promise<void> {
  const [, , inputPath] = process.argv
  if (!inputPath) {
    console.error(
      'usage: pnpm tsx scripts/bake-longmemeval.ts <path/to/longmemeval_s.json>',
    )
    process.exit(1)
  }
  const abs = resolve(inputPath)
  const raw = readFileSync(abs, 'utf8')
  const items = JSON.parse(raw) as LmeItem[]
  console.log(`[bake-lme] loaded ${String(items.length)} items from ${abs}`)

  const sampled = stratifiedSample(items, 120, 42)
  const byType: Record<string, number> = {}
  for (const it of sampled) {
    byType[it.question_type] = (byType[it.question_type] ?? 0) + 1
  }
  console.log(
    `[bake-lme] stratified sample: n=${String(sampled.length)} by_type=${JSON.stringify(byType)}`,
  )

  const outDir = join(repoRoot(), 'benchmarks/longmemeval/tasks')
  mkdirSync(outDir, { recursive: true })

  const ids: string[] = []
  for (const item of sampled) {
    const fn = `lme_${item.question_id}.json`
    writeFileSync(join(outDir, fn), JSON.stringify(item, null, 2) + '\n')
    ids.push(item.question_id)
  }
  writeFileSync(
    join(repoRoot(), 'benchmarks/longmemeval/subset_ids.json'),
    JSON.stringify(ids, null, 2) + '\n',
  )
  console.log(
    `[bake-lme] wrote ${String(ids.length)} task files to benchmarks/longmemeval/tasks/`,
  )
  console.log(`[bake-lme] frozen selection: benchmarks/longmemeval/subset_ids.json`)
}

await main()
