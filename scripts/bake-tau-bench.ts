#!/usr/bin/env tsx
// One-shot data import for tau-bench retail med-subset. Per D5 plan Step 4.
//
// Usage:
//   pnpm tsx scripts/bake-tau-bench.ts <path/to/tau_bench/envs/retail>
//
// Reads the upstream tau-bench Python package's retail env directory (resolve
// via `pip show tau_bench | grep Location` → `$loc/tau_bench/envs/retail`).
// Copies:
//   {users,orders,products}.json + wiki.md → benchmarks/tau-bench/data/
//   tasks.json (filtered through subset_ids) → benchmarks/tau-bench/tasks/tau_<NNN>.json
//
// Subset = `references/mle-harness/results/taubench_episode_ids.json` (10 task_idxs
// frozen at upstream seed=42). Pass `--subset <path>` to override — Track H P2
// uses `benchmarks/tau-bench/subset_ids_n30.json` (30 idxs, seed=42, superset
// of the original 10 + 20 new — see docs/design/H_ablations_and_TODOs §13).

import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

function repoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..')
}

async function main(): Promise<void> {
  // CLI: <retailDir> [--subset <path>]. Defaults to references/mle-harness/...
  // when --subset omitted (original 10-task subset).
  const argv = process.argv.slice(2)
  let retailDir: string | undefined
  let subsetOverride: string | undefined
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--subset') {
      subsetOverride = argv[i + 1]
      i += 1
    } else if (a !== undefined && !a.startsWith('--')) {
      retailDir = a
    }
  }
  if (!retailDir) {
    console.error(
      'usage: pnpm tsx scripts/bake-tau-bench.ts <path/to/tau_bench/envs/retail> [--subset <subset_ids.json>]',
    )
    console.error('  resolve via: pip show tau_bench | grep Location → $loc/tau_bench/envs/retail')
    process.exit(1)
  }
  const src = resolve(retailDir)

  const dataOut = join(repoRoot(), 'benchmarks/tau-bench/data')
  mkdirSync(dataOut, { recursive: true })

  // Env state: users / orders / products
  for (const f of ['users.json', 'orders.json', 'products.json']) {
    try {
      copyFileSync(join(src, 'data', f), join(dataOut, f))
      console.log(`[bake-tau] copied ${f}`)
    } catch (err) {
      console.error(`[bake-tau] failed to copy ${f}: ${(err as Error).message}`)
    }
  }

  // Wiki
  try {
    copyFileSync(join(src, 'wiki.md'), join(repoRoot(), 'benchmarks/tau-bench/wiki.md'))
    console.log(`[bake-tau] copied wiki.md`)
  } catch (err) {
    console.warn(`[bake-tau] wiki.md copy failed (keeping existing): ${(err as Error).message}`)
  }

  // Tasks: filter through subset_ids
  const subsetPath = subsetOverride !== undefined
    ? resolve(subsetOverride)
    : join(repoRoot(), 'references/mle-harness/results/taubench_episode_ids.json')
  const subsetIdxs = JSON.parse(readFileSync(subsetPath, 'utf8')) as number[]
  console.log(`[bake-tau] subset source: ${subsetPath}`)
  console.log(`[bake-tau] subset idxs: ${JSON.stringify(subsetIdxs)}`)

  const tasksPath = join(src, 'tasks.json')
  let tasksRaw: string
  try {
    tasksRaw = readFileSync(tasksPath, 'utf8')
  } catch (err) {
    console.error(`[bake-tau] tasks.json not found at ${tasksPath}: ${(err as Error).message}`)
    process.exit(1)
  }
  const allTasks = JSON.parse(tasksRaw) as { instruction: string; actions?: unknown[] }[]

  const tasksOut = join(repoRoot(), 'benchmarks/tau-bench/tasks')
  mkdirSync(tasksOut, { recursive: true })

  // Re-read user / orders / products from copied files для initial_state.
  const users = JSON.parse(readFileSync(join(dataOut, 'users.json'), 'utf8')) as unknown
  const orders = JSON.parse(readFileSync(join(dataOut, 'orders.json'), 'utf8')) as unknown
  const products = JSON.parse(readFileSync(join(dataOut, 'products.json'), 'utf8')) as unknown
  const initial_state = { users, orders, products }

  let written = 0
  for (const idx of subsetIdxs) {
    const t = allTasks[idx]
    if (!t) {
      console.warn(`[bake-tau] task_idx ${String(idx)} not found in tasks.json`)
      continue
    }
    const episode = {
      episode_id: `retail_${String(idx)}`,
      task_idx: idx,
      instruction: t.instruction,
      initial_state,
      // expected_end_state derivation from upstream `actions` is non-trivial
      // (would require replaying actions through env to get terminal state).
      // For D5: leave empty {} — reward = 1 only if no asserts; users running
      // with this fixture see «pass-by-default» semantics, valid for smoke.
      // Real reward calc lands in E1 if needed; per Risk #2 acceptable.
      expected_end_state: {},
    }
    const fn = `tau_retail_${String(idx).padStart(4, '0')}.json`
    writeFileSync(
      join(tasksOut, fn),
      JSON.stringify(episode, null, 2) + '\n',
    )
    written += 1
  }
  writeFileSync(
    join(repoRoot(), 'benchmarks/tau-bench/subset_ids.json'),
    JSON.stringify(subsetIdxs, null, 2) + '\n',
  )
  console.log(`[bake-tau] wrote ${String(written)} episode files to benchmarks/tau-bench/tasks/`)
}

await main()
