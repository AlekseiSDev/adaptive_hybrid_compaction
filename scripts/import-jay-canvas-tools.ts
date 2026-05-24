#!/usr/bin/env tsx
// Track J3 — bulk import jay-canvas golden-set scenarios into AT-v2 corpus.
//
// Inputs (read-only):
//   /Users/Aleksei/Projects/jay-canvas/apps/platform/api/e2e/golden-set/runs/v2.8-*.json
//
// Outputs:
//   benchmarks/assistant_traj/tasks/at_<cat>_<NNN>.json    (1 user-turn drafts)
//   benchmarks/assistant_traj/tool_fixtures/at_<cat>_<NNN>.json   (paired stub)
//
// Flags:
//   --dry-run   list scenarios + allocated task_ids; emit nothing.
//   --source-file PATH  override default v2.8 postsanitize file.
//
// J doc §5.1 distribution target: image_qa:8 / code_iter:14 / research_write:14 / mixed:14 (50 total).
// Achievable from jay-canvas (mapped tools only): image_qa ~7, code_iter ~4,
// research_write ~5, mixed ~11 (≈ 27 drafts). J4 synthetic top-up fills the rest.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  allocateTaskIds,
  importGoldenSetScenario,
  inferCategoryFromGoldenId,
  type GoldenSetRunFile,
} from '../src/eval/adapters/assistant-traj.import.js'

const DEFAULT_SOURCE =
  '/Users/Aleksei/Projects/jay-canvas/apps/platform/api/e2e/golden-set/runs/v2.8-20260508-postsanitize.json'

// Target caps per design J §5.1; J4 synthetic top-up fills shortfall.
const PER_CATEGORY_CAP = {
  image_qa: 8,
  code_iter: 14,
  research_write: 14,
  mixed: 14,
} as const

type Args = {
  dryRun: boolean
  sourceFile: string
  outRoot: string
}

function parseArgs(argv: string[]): Args {
  let dryRun = false
  let sourceFile = DEFAULT_SOURCE
  let outRoot = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    'benchmarks',
    'assistant_traj',
  )
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--dry-run') {
      dryRun = true
    } else if (a === '--source-file') {
      const v = argv[i + 1]
      if (!v) throw new Error('--source-file requires a path arg')
      sourceFile = v
      i += 1
    } else if (a === '--out-root') {
      const v = argv[i + 1]
      if (!v) throw new Error('--out-root requires a path arg')
      outRoot = v
      i += 1
    } else if (a === '-h' || a === '--help') {
      console.log(
        'usage: tsx scripts/import-jay-canvas-tools.ts [--dry-run] [--source-file PATH] [--out-root PATH]',
      )
      process.exit(0)
    } else if (a !== undefined) {
      throw new Error(`unknown argument: ${a}`)
    }
  }
  return { dryRun, sourceFile, outRoot }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  console.log(`[J3] source: ${args.sourceFile}`)
  console.log(`[J3] out-root: ${args.outRoot}`)
  console.log(`[J3] dry-run: ${String(args.dryRun)}`)

  const raw = await readFile(args.sourceFile, 'utf8')
  const run = JSON.parse(raw) as GoldenSetRunFile
  const scenarios = run.scenarios
  console.log(`[J3] loaded ${String(scenarios.length)} scenarios from run file`)

  // Sort scenarios by id for deterministic allocation order. Within a category
  // we want earlier ids to grab lower NNN slots → stable diffs across re-runs.
  const sorted = [...scenarios].sort((a, b) => a.id.localeCompare(b.id, 'en'))
  const allocation = allocateTaskIds(sorted, { perCategoryCap: PER_CATEGORY_CAP })
  console.log(
    `[J3] allocated ${String(allocation.size)} task_ids (capped per category at ${JSON.stringify(PER_CATEGORY_CAP)})`,
  )

  // Per-category bucket print
  const byCat = new Map<string, number>()
  for (const tid of allocation.values()) {
    const cat = tid.replace(/^at_/, '').replace(/_\d{3}$/, '')
    byCat.set(cat, (byCat.get(cat) ?? 0) + 1)
  }
  console.log(`[J3] per-category: ${JSON.stringify(Object.fromEntries(byCat))}`)

  if (args.dryRun) {
    console.log('\n[J3] dry-run allocation table:')
    for (const s of sorted) {
      const taskId = allocation.get(s.id)
      const cat = inferCategoryFromGoldenId(s.id)
      const tools = s.turns
        .flatMap((t) => t.actual?.tool_calls ?? [])
        .filter((v, i, arr) => arr.indexOf(v) === i)
      if (taskId) {
        console.log(`  ${s.id.padEnd(6)} → ${taskId.padEnd(28)} cat=${String(cat).padEnd(15)} tools=${tools.join(',')}`)
      } else {
        const reason = !cat
          ? 'no category mapping'
          : !tools.some((t) =>
              ['create_image', 'edit_image', 'google_search', 'browse_url', 'get_image_content', 'code_interpreter'].includes(t),
            )
          ? 'no mapped tools'
          : 'cap reached'
        console.log(`  ${s.id.padEnd(6)} SKIP (${reason}) tools=${tools.join(',')}`)
      }
    }
    return
  }

  const tasksDir = join(args.outRoot, 'tasks')
  const fixturesDir = join(args.outRoot, 'tool_fixtures')
  await mkdir(tasksDir, { recursive: true })
  await mkdir(fixturesDir, { recursive: true })

  const sourceBasename = args.sourceFile.split('/').pop() ?? 'unknown'
  let written = 0
  let skipped = 0
  for (const s of sorted) {
    const taskId = allocation.get(s.id)
    if (!taskId) {
      skipped += 1
      continue
    }
    const result = importGoldenSetScenario({
      scenario: s,
      taskId,
      sourceFileBasename: sourceBasename,
    })
    if (!result) {
      console.log(`[J3] SKIP ${s.id} (importer returned null)`)
      skipped += 1
      continue
    }
    const taskPath = join(tasksDir, `${taskId}.json`)
    const fixturePath = join(fixturesDir, `${taskId}.json`)
    await writeFile(taskPath, JSON.stringify(result.task, null, 2) + '\n', 'utf8')
    await writeFile(fixturePath, JSON.stringify(result.fixture, null, 2) + '\n', 'utf8')
    written += 1
    if (result.downloads.length > 0) {
      console.log(`[J3] ✓ ${taskId} (downloads pending: ${String(result.downloads.length)})`)
    } else {
      console.log(`[J3] ✓ ${taskId}`)
    }
  }
  console.log(`\n[J3] wrote ${String(written)} task drafts (skipped ${String(skipped)})`)
  console.log(
    `[J3] next: review benchmarks/assistant_traj/tasks/*.json drafts manually + hand-extend turns to 5–15 per task`,
  )
}

await main()
