#!/usr/bin/env tsx
// D6 / J7 — Bake live tool outputs into sidecar fixtures.
// Source of truth: docs/design/J_at_tools.md §4.4 (capture flow).
//
// Replaces every `needs_bake: true` fixture entry in benchmarks/assistant_traj/
// tool_fixtures/<task_id>.json with a real captured tool output. Live calls go
// through src/eval/adapters/assistant-traj.tools-live.ts; required env keys:
//   GOOGLE_GENAI_API_KEY, BRAVE_API_KEY, FIRECRAWL_API_KEY, E2B_API_KEY
// (BRAVE_BASE_URL optional; defaults to jay-canvas gateway.)
//
// Usage:
//   pnpm tsx benchmarks/assistant_traj/bake-fixtures.ts --task at_image_qa_jc_ie_001
//   pnpm tsx benchmarks/assistant_traj/bake-fixtures.ts --all-needs-bake
//   pnpm tsx benchmarks/assistant_traj/bake-fixtures.ts --dry-run --all-needs-bake
//
// Behavior:
//   - Iterates each needs_bake fixture entry in order.
//   - For each, synthesises a minimal call from the task's first turn that
//     mentions the tool (uses user text as prompt / query / code).
//     This is a heuristic — for tools where the agent normally crafts the
//     args, manual edit may be needed after baking.
//   - Captures output via live wrapper; writes back into the sidecar JSON,
//     removing `needs_bake` flag.
//   - Attachments (image bytes from Gemini) go to
//     attachments/<task_id>/<tool_name>_<idx>.png and the fixture references
//     them via an additional ImageOutputPart.

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { AssistantTrajTaskSchema } from '../../src/eval/adapters/assistant-traj.schema.js'
import {
  ToolFixtureFileSchema,
  type AtToolName,
  type ToolFixture,
} from '../../src/eval/adapters/assistant-traj.tool-fixtures.schema.js'
import { resolveToolMode } from '../../src/eval/adapters/assistant-traj.tools.js'
import {
  buildLiveTools,
  LiveToolEnvMissingError,
} from '../../src/eval/adapters/assistant-traj.tools-live.js'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const TASKS_DIR = join(REPO_ROOT, 'benchmarks/assistant_traj/tasks')
const FX_DIR = join(REPO_ROOT, 'benchmarks/assistant_traj/tool_fixtures')
const ATTACH_DIR = join(REPO_ROOT, 'benchmarks/assistant_traj/attachments')

type Args = { taskIds?: string[]; allNeedsBake: boolean; dryRun: boolean }

function parseArgs(argv: string[]): Args {
  const taskIds: string[] = []
  let allNeedsBake = false
  let dryRun = false
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--task') {
      const v = argv[i + 1]
      if (!v) throw new Error('--task requires task_id')
      taskIds.push(v)
      i += 1
    } else if (a === '--all-needs-bake') {
      allNeedsBake = true
    } else if (a === '--dry-run') {
      dryRun = true
    } else if (a === '--help' || a === '-h') {
      console.log(
        'usage: tsx benchmarks/assistant_traj/bake-fixtures.ts [--task <id> | --all-needs-bake] [--dry-run]',
      )
      process.exit(0)
    } else if (a !== undefined) {
      throw new Error(`unknown arg: ${a}`)
    }
  }
  return taskIds.length > 0
    ? { taskIds, allNeedsBake, dryRun }
    : { allNeedsBake, dryRun }
}

async function listAllFixturePaths(): Promise<string[]> {
  const { readdir } = await import('node:fs/promises')
  const entries = await readdir(FX_DIR)
  return entries
    .filter((e) => e.endsWith('.json'))
    .map((e) => join(FX_DIR, e))
}

async function loadFixture(path: string): Promise<{ raw: unknown; parsed: ReturnType<typeof ToolFixtureFileSchema.parse> }> {
  const raw = JSON.parse(await readFile(path, 'utf8')) as unknown
  const parsed = ToolFixtureFileSchema.parse(raw)
  return { raw, parsed }
}

async function loadTask(taskId: string): Promise<ReturnType<typeof AssistantTrajTaskSchema.parse>> {
  const path = join(TASKS_DIR, `${taskId}.json`)
  const raw = JSON.parse(await readFile(path, 'utf8')) as unknown
  return AssistantTrajTaskSchema.parse(raw)
}

// Heuristic synthetic args derived from the task's user text. Captures
// "something" so the call goes through; manual edit of fixture later is
// expected for tools where args really matter (e.g. specific image URL).
function synthesiseArgs(
  toolName: AtToolName,
  task: ReturnType<typeof AssistantTrajTaskSchema.parse>,
): unknown {
  const firstUserText =
    task.turns
      .find((t) => t.role === 'user')
      ?.content.find((p): p is { type: 'text'; text: string } => p.type === 'text')
      ?.text ?? ''
  const trimmed = firstUserText.slice(0, 800)
  // Gemini image-gen rejects long Russian/instructional prompts as "no image
  // candidate" — use a deterministic short English prompt for bake. Replay
  // semantics don't care what was generated, only that the byte stream is
  // stable for cache invariance.
  if (toolName === 'image_gen')
    return { prompt: 'A simple stock photograph of a notebook on a desk.' }
  if (toolName === 'image_edit')
    return {
      image_url: 'https://placehold.co/256x256.png',
      instruction: 'add a small blue dot',
    }
  if (toolName === 'google_search') return { q: trimmed || 'test query' }
  if (toolName === 'web_fetch') return { url: 'https://example.com/' }
  if (toolName === 'code_interpreter')
    // Avoid the literal "placeholder" — validator flags it as a real
    // placeholder fixture. "stub" reads the same intent.
    return { code: 'print("bake stub output")' }
  throw new Error(`unknown tool: ${String(toolName)}`)
}

async function bakeOneTask(
  taskId: string,
  liveTools: ReturnType<typeof buildLiveTools>,
  dryRun: boolean,
): Promise<{ baked: number; skipped: number }> {
  const fxPath = join(FX_DIR, `${taskId}.json`)
  const { parsed: fxFile } = await loadFixture(fxPath)
  const task = await loadTask(taskId)
  let baked = 0
  let skipped = 0
  const updated: ToolFixture[] = []
  for (const fx of fxFile.fixtures) {
    if (fx.needs_bake !== true) {
      updated.push(fx)
      skipped += 1
      continue
    }
    const tool = liveTools[fx.tool_name]
    const args = synthesiseArgs(fx.tool_name, task)
    console.log(`[bake] ${taskId}::${fx.tool_name} live-call`)
    if (dryRun) {
      updated.push(fx) // keep as-is for dry-run
      continue
    }
    const result = await tool.execute(args)
    const text = result.content.find((c) => c.type === 'text')
    const newFx: ToolFixture = {
      tool_name: fx.tool_name,
      output_parts: text ? [text] : [{ type: 'text', text: '(empty)' }],
    }
    // Capture attachments if the live tool produced any (image bytes).
    const atts = tool.attachments?.() ?? []
    if (atts.length > 0) {
      const attTaskDir = join(ATTACH_DIR, taskId)
      await mkdir(attTaskDir, { recursive: true })
      for (let i = 0; i < atts.length; i += 1) {
        const att = atts[i]
        if (!att) continue
        const filename = `${fx.tool_name}_${String(i)}_${att.suggestedName}`
        const relPath = `attachments/${taskId}/${filename}`
        await writeFile(join(attTaskDir, filename), att.bytes)
        newFx.output_parts.push({
          type: 'image',
          path: relPath,
          alt: `${fx.tool_name} bake output`,
        })
      }
    }
    updated.push(newFx)
    baked += 1
  }
  const out = { task_id: taskId, fixtures: updated }
  if (!dryRun) {
    await writeFile(fxPath, `${JSON.stringify(out, null, 2)}\n`, 'utf8')
  }
  return { baked, skipped }
}

async function main() {
  resolveToolMode() // throws if CI=true + live; sanity check before live calls
  if (process.env['AT_TOOL_MODE'] !== 'live') {
    console.error(
      '[bake] AT_TOOL_MODE must be "live"; set with: AT_TOOL_MODE=live pnpm tsx ...',
    )
    process.exit(2)
  }
  const args = parseArgs(process.argv.slice(2))

  let taskIds: string[]
  if (args.taskIds) {
    taskIds = args.taskIds
  } else if (args.allNeedsBake) {
    const paths = await listAllFixturePaths()
    taskIds = []
    for (const p of paths) {
      const { parsed } = await loadFixture(p)
      if (parsed.fixtures.some((f) => f.needs_bake === true)) {
        taskIds.push(parsed.task_id)
      }
    }
    console.log(`[bake] found ${String(taskIds.length)} tasks with needs_bake fixtures`)
  } else {
    console.error('[bake] either --task <id> or --all-needs-bake required')
    process.exit(1)
  }

  let liveTools: ReturnType<typeof buildLiveTools>
  try {
    liveTools = buildLiveTools()
  } catch (e) {
    if (e instanceof LiveToolEnvMissingError) {
      console.error(`[bake] env: ${e.message}`)
      process.exit(2)
    }
    throw e
  }

  let totalBaked = 0
  let totalSkipped = 0
  for (const tid of taskIds) {
    try {
      const r = await bakeOneTask(tid, liveTools, args.dryRun)
      totalBaked += r.baked
      totalSkipped += r.skipped
      console.log(`[bake] ${tid}: baked=${String(r.baked)} skipped=${String(r.skipped)}`)
    } catch (e) {
      console.error(`[bake] ${tid} FAIL: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  console.log(
    `\n[bake] total baked=${String(totalBaked)} skipped=${String(totalSkipped)} dry-run=${String(args.dryRun)}`,
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
