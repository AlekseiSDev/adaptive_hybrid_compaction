#!/usr/bin/env tsx
// One-shot data import for LoCoMo-med. Per D5 plan Step 3.
//
// Usage:
//   pnpm tsx scripts/bake-locomo.ts <path/to/locomo10.json>
//
// The full LoCoMo dataset isn't redistributable in our repo — user obtains
// `locomo10.json` from upstream (`snap-research/locomo` GitHub release or
// `Percena/locomo-mc10` HF dataset). Bake script combines:
//   - upstream locomo10.json (conversations, full multi-session dialogs)
//   - `references/mle-harness/results/locomo_subset_ids.json` (25 selected
//     QA items from upstream Python harness, frozen @ seed=42 stratified
//     across categories 1-4)
//
// Each selected QA item gets merged with its source conversation → individual
// `lo_<NNN>.json` files.
//
// Output:
//   benchmarks/locomo/tasks/lo_<NNN>.json × 25
//   benchmarks/locomo/subset_ids.json (mirrored from upstream)

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

type SubsetItem = {
  sample_id: string
  qa_idx: number
  category: number
  category_name?: string
  question: string
  answer: string
  evidence?: string[]
}

type UpstreamConv = Record<string, unknown> & {
  sample_id: string
  conversation: Record<string, unknown>
  qa: { question: string; answer: string; category: number; evidence?: string[] }[]
}

function repoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..')
}

async function main(): Promise<void> {
  const [, , locomoPath] = process.argv
  if (!locomoPath) {
    console.error(
      'usage: pnpm tsx scripts/bake-locomo.ts <path/to/locomo10.json>',
    )
    process.exit(1)
  }
  const subsetPath = join(
    repoRoot(),
    'references/mle-harness/results/locomo_subset_ids.json',
  )

  const rawConvs = readFileSync(resolve(locomoPath), 'utf8')
  const conversations = JSON.parse(rawConvs) as UpstreamConv[]
  console.log(`[bake-locomo] loaded ${String(conversations.length)} conversations`)

  const rawSubset = readFileSync(subsetPath, 'utf8')
  const subset = JSON.parse(rawSubset) as SubsetItem[]
  console.log(`[bake-locomo] subset: ${String(subset.length)} items`)

  const convBySampleId = new Map<string, UpstreamConv>()
  for (const c of conversations) convBySampleId.set(c.sample_id, c)

  const outDir = join(repoRoot(), 'benchmarks/locomo/tasks')
  mkdirSync(outDir, { recursive: true })

  let written = 0
  for (let i = 0; i < subset.length; i += 1) {
    const item = subset[i]
    if (!item) continue
    const src = convBySampleId.get(item.sample_id)
    if (!src) {
      console.warn(`[bake-locomo] sample_id ${item.sample_id} not found in upstream — skipping`)
      continue
    }
    const task = {
      sample_id: item.sample_id,
      qa_idx: item.qa_idx,
      category: item.category,
      category_name: item.category_name,
      question: item.question,
      answer: item.answer,
      evidence: item.evidence,
      conversation: src.conversation,
    }
    const seq = String(i + 1).padStart(3, '0')
    writeFileSync(
      join(outDir, `lo_${seq}.json`),
      JSON.stringify(task, null, 2) + '\n',
    )
    written += 1
  }
  writeFileSync(
    join(repoRoot(), 'benchmarks/locomo/subset_ids.json'),
    JSON.stringify(subset, null, 2) + '\n',
  )
  console.log(`[bake-locomo] wrote ${String(written)} task files to benchmarks/locomo/tasks/`)
}

await main()
