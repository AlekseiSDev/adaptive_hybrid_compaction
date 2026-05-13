#!/usr/bin/env tsx
// CLI: read a jay-canvas golden-set scenario file, pick one scenario by id,
// project to an AssistantTrajTask, write benchmarks/assistant_traj/tasks/<task-id>.json,
// and emit `# DOWNLOAD:` markers for any image URLs found in user turns.
//
// Usage:
//   pnpm tsx scripts/import-jay-canvas.ts \
//     --source /abs/path/to/A.json \
//     --scenario A1 \
//     --task-id at_mixed_001 \
//     [--category mixed|code_iter|image_qa|research_write] \
//     [--dry-run]

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, basename, resolve, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  importJayCanvasScenario,
  type JayCanvasScenario,
} from '../src/eval/adapters/assistant-traj.import.js'
import type { AssistantTrajCategory } from '../src/eval/adapters/assistant-traj.schema.js'

type CliArgs = {
  source: string
  scenario: string
  taskId: string
  category?: AssistantTrajCategory
  dryRun: boolean
}

const VALID_CATEGORIES: ReadonlySet<AssistantTrajCategory> = new Set([
  'image_qa',
  'code_iter',
  'research_write',
  'mixed',
])

function fail(msg: string): never {
  console.error(`error: ${msg}`)
  printUsage()
  process.exit(1)
}

function printUsage(): void {
  console.error(
    'usage: tsx scripts/import-jay-canvas.ts --source <file.json> --scenario <id> --task-id <at_xx_NNN> [--category <cat>] [--dry-run]',
  )
}

function parseArgs(argv: string[]): CliArgs {
  let source: string | undefined
  let scenario: string | undefined
  let taskId: string | undefined
  let category: AssistantTrajCategory | undefined
  let dryRun = false

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--source') {
      source = argv[++i]
    } else if (a === '--scenario') {
      scenario = argv[++i]
    } else if (a === '--task-id') {
      taskId = argv[++i]
    } else if (a === '--category') {
      const raw = argv[++i]
      if (!raw || !VALID_CATEGORIES.has(raw as AssistantTrajCategory)) {
        fail(`--category must be one of: ${[...VALID_CATEGORIES].join(', ')}`)
      }
      category = raw as AssistantTrajCategory
    } else if (a === '--dry-run') {
      dryRun = true
    } else if (a === '--help' || a === '-h') {
      printUsage()
      process.exit(0)
    } else if (a !== undefined) {
      fail(`unknown argument: ${a}`)
    }
  }

  if (!source) fail('--source is required')
  if (!scenario) fail('--scenario is required')
  if (!taskId) fail('--task-id is required')

  return category === undefined
    ? { source, scenario, taskId, dryRun }
    : { source, scenario, taskId, category, dryRun }
}

function projectRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..')
}

function tasksDir(): string {
  return resolve(projectRoot(), 'benchmarks/assistant_traj/tasks')
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const sourcePath = isAbsolute(args.source)
    ? args.source
    : resolve(process.cwd(), args.source)
  const raw = await readFile(sourcePath, 'utf8')
  const parsed = JSON.parse(raw) as {
    scenarios?: Record<string, JayCanvasScenario>
  }
  const bucket = parsed.scenarios
  if (!bucket || typeof bucket !== 'object') {
    fail(`source file ${sourcePath} has no top-level 'scenarios' object`)
  }
  const scenario = bucket[args.scenario]
  if (!scenario) {
    fail(
      `scenario '${args.scenario}' not found in ${sourcePath}. Available: ${Object.keys(bucket).join(', ')}`,
    )
  }

  const sourceFileBasename = basename(sourcePath)
  const sourceCategoryFromFile = sourceFileBasename.replace(/\.json$/i, '')

  const result = importJayCanvasScenario(scenario, {
    scenarioId: args.scenario,
    sourceCategory: sourceCategoryFromFile,
    sourceFileBasename,
    taskId: args.taskId,
    ...(args.category ? { category: args.category } : {}),
  })

  const payload = `${JSON.stringify(result.task, null, 2)}\n`

  if (args.dryRun) {
    process.stdout.write(payload)
  } else {
    const outPath = join(tasksDir(), `${args.taskId}.json`)
    await mkdir(dirname(outPath), { recursive: true })
    await writeFile(outPath, payload, 'utf8')
    console.log(`✓ wrote ${outPath}`)
  }

  for (const d of result.downloads) {
    console.log(`# DOWNLOAD: ${d.url} -> ${d.targetPath}`)
  }
}

await main()
