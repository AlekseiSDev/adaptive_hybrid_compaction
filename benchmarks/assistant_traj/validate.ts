#!/usr/bin/env tsx
// AssistantTraj task-file validator.
// Modes:
//   no-arg          → validate every benchmarks/assistant_traj/tasks/*.json
//   --fixtures      → validate fixtures/{valid,invalid}/*.json (D1 self-test)
//   --task <id>     → validate exactly benchmarks/assistant_traj/tasks/<id>.json
//
// Exit 0 on success. Exit 1 with a per-file failure summary otherwise.

import { readFile, readdir, stat } from 'node:fs/promises'
import { resolve, dirname, basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  AssistantTrajTaskSchema,
  type AssistantTrajTask,
} from '../../src/eval/adapters/assistant-traj.schema.js'
import { ToolFixtureFileSchema } from '../../src/eval/adapters/assistant-traj.tool-fixtures.schema.js'

type Args = { mode: 'all' | 'fixtures' | 'one'; taskId?: string }

function parseArgs(argv: string[]): Args {
  let mode: Args['mode'] = 'all'
  let taskId: string | undefined
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--fixtures') {
      mode = 'fixtures'
    } else if (a === '--task') {
      const v = argv[i + 1]
      if (!v) {
        console.error('error: --task requires a task_id argument')
        process.exit(1)
      }
      mode = 'one'
      taskId = v
      i += 1
    } else if (a === '--help' || a === '-h') {
      printUsage()
      process.exit(0)
    } else if (a !== undefined) {
      console.error(`error: unknown argument: ${a}`)
      printUsage()
      process.exit(1)
    }
  }
  return taskId === undefined ? { mode } : { mode, taskId }
}

function printUsage(): void {
  console.error(
    'usage: tsx benchmarks/assistant_traj/validate.ts [--fixtures | --task <id>]',
  )
}

function rootDir(): string {
  return dirname(fileURLToPath(import.meta.url))
}

async function listJson(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir)
    return entries.filter((e) => e.endsWith('.json')).map((e) => join(dir, e))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
}

async function parseFile(path: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (err) {
    return { ok: false, reason: `read error: ${(err as Error).message}` }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    return { ok: false, reason: `JSON parse error: ${(err as Error).message}` }
  }
  const result = AssistantTrajTaskSchema.safeParse(parsed)
  if (result.success) return { ok: true }
  return { ok: false, reason: result.error.message }
}

// Track J — Sidecar fixture cross-check. Only runs for tasks that declare at
// least one required tool. Verifies: (a) sidecar file exists at expected path,
// (b) sidecar parses against ToolFixtureFileSchema, (c) sidecar's task_id
// matches the task. Default sidecar location is
// benchmarks/assistant_traj/tool_fixtures/<task_id>.json — overridable per task
// via the optional tool_fixtures_ref pointer (repo-relative).
async function parseFixturePair(
  taskPath: string,
): Promise<{ ok: true } | { ok: false; reason: string } | { skip: true }> {
  const rawTask = await readFile(taskPath, 'utf8')
  const taskJson = JSON.parse(rawTask) as unknown
  const taskResult = AssistantTrajTaskSchema.safeParse(taskJson)
  if (!taskResult.success) {
    return { skip: true } // task itself invalid — parseFile already surfaces the error
  }
  const task: AssistantTrajTask = taskResult.data
  const hasRequiredTool = task.turns.some(
    (turn) => (turn.expected_tool_calls ?? []).some((c) => c.required === true),
  )
  if (!hasRequiredTool) return { skip: true }

  const repoRoot = resolve(rootDir(), '..', '..')
  const fixturePath = task.tool_fixtures_ref
    ? resolve(repoRoot, task.tool_fixtures_ref)
    : join(rootDir(), 'tool_fixtures', `${task.task_id}.json`)

  try {
    await stat(fixturePath)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        ok: false,
        reason: `missing sidecar tool_fixtures file: ${fixturePath} (task declares required tool)`,
      }
    }
    return { ok: false, reason: `fixture stat error: ${(err as Error).message}` }
  }

  let fixtureRaw: string
  try {
    fixtureRaw = await readFile(fixturePath, 'utf8')
  } catch (err) {
    return { ok: false, reason: `fixture read error: ${(err as Error).message}` }
  }
  let fixtureJson: unknown
  try {
    fixtureJson = JSON.parse(fixtureRaw)
  } catch (err) {
    return { ok: false, reason: `fixture JSON parse error: ${(err as Error).message}` }
  }
  const fixtureResult = ToolFixtureFileSchema.safeParse(fixtureJson)
  if (!fixtureResult.success) {
    return { ok: false, reason: `fixture schema: ${fixtureResult.error.message}` }
  }
  if (fixtureResult.data.task_id !== task.task_id) {
    return {
      ok: false,
      reason: `fixture task_id '${fixtureResult.data.task_id}' does not match task '${task.task_id}'`,
    }
  }
  // D6 — production-readiness gate: fixture must not carry placeholder text or
  // needs_bake marker. Non-deprecated tasks fail; deprecated tasks pass with
  // a warning so the legacy AT-v2 opensource subset can keep its existing
  // placeholders without forcing a re-bake.
  const isDeprecated = task.provenance.deprecated === true
  for (const fx of fixtureResult.data.fixtures) {
    if (fx.needs_bake === true) {
      if (isDeprecated) continue
      return {
        ok: false,
        reason: `fixture entry for ${fx.tool_name} marked needs_bake — run bake-fixtures.ts before sweep`,
      }
    }
    const textBlob = fx.output_parts
      .map((p) => (p.type === 'text' ? p.text : ''))
      .join('\n')
    if (!isDeprecated && /placeholder/i.test(textBlob)) {
      return {
        ok: false,
        reason: `fixture entry for ${fx.tool_name} contains 'placeholder' literal — needs real output`,
      }
    }
  }
  return { ok: true }
}

// D6 — referenced image / file attachments must exist on disk. Catches the
// at_mixed_001 class of bug (task pointed at attachments/at_mixed_001/1.svg
// but the directory never shipped) by walking every ContentPart in every turn
// and stat'ing the path. Attachment paths are repo-relative
// (resolved against benchmarks/assistant_traj/).
type AttachedPart = { kind: 'image' | 'file'; path: string }

function collectAttachments(task: AssistantTrajTask): AttachedPart[] {
  const out: AttachedPart[] = []
  const walk = (part: unknown): void => {
    if (!part || typeof part !== 'object') return
    const p = part as { type?: unknown; path?: unknown; content?: unknown }
    if (p.type === 'image' && typeof p.path === 'string') {
      out.push({ kind: 'image', path: p.path })
    } else if (p.type === 'file' && typeof p.path === 'string') {
      out.push({ kind: 'file', path: p.path })
    } else if (p.type === 'tool_result' && Array.isArray(p.content)) {
      for (const c of p.content) walk(c)
    }
  }
  for (const turn of task.turns) {
    for (const part of turn.content) walk(part)
  }
  return out
}

async function parseAttachments(
  taskPath: string,
): Promise<{ ok: true } | { ok: false; reason: string } | { skip: true }> {
  const raw = await readFile(taskPath, 'utf8')
  const parsed = JSON.parse(raw) as unknown
  const taskResult = AssistantTrajTaskSchema.safeParse(parsed)
  if (!taskResult.success) return { skip: true } // already caught by parseFile
  const task = taskResult.data
  // Deprecated AT-v2 legacy tasks are quarantined — broken attachments stay
  // documented but don't gate the rest of the corpus.
  if (task.provenance.deprecated === true) return { skip: true }
  const parts = collectAttachments(task)
  if (parts.length === 0) return { skip: true }
  const benchRoot = rootDir() // benchmarks/assistant_traj
  const missing: string[] = []
  for (const p of parts) {
    const abs = join(benchRoot, p.path)
    try {
      await stat(abs)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        missing.push(`${p.kind}: ${p.path}`)
      } else {
        return { ok: false, reason: `attachment stat error: ${(err as Error).message}` }
      }
    }
  }
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `missing attachment file(s):\n  ${missing.join('\n  ')}`,
    }
  }
  return { ok: true }
}

// D6 — real-source provenance gate: anonymized_at + original_session_hash
// non-null required. Schema already enforces anonymized_at via cross-field
// rule; this adds the session_hash lineage check, separately.
function checkRealProvenance(
  task: AssistantTrajTask,
): { ok: true } | { ok: false; reason: string } {
  if (task.source !== 'real') return { ok: true }
  if (task.provenance.deprecated === true) return { ok: true }
  if (!task.provenance.original_session_hash) {
    return {
      ok: false,
      reason:
        "source='real' requires non-empty provenance.original_session_hash (lineage trace)",
    }
  }
  return { ok: true }
}

async function readReason(jsonPath: string): Promise<string | null> {
  const reasonPath = jsonPath.replace(/\.json$/, '.reason.txt')
  try {
    const raw = await readFile(reasonPath, 'utf8')
    return raw.trim()
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

type Failure = { file: string; detail: string }

async function validateTaskWithFixture(path: string): Promise<{
  schemaOk: boolean
  failure?: Failure
}> {
  const schemaResult = await parseFile(path)
  if (!schemaResult.ok) {
    return { schemaOk: false, failure: { file: path, detail: schemaResult.reason } }
  }
  const pairResult = await parseFixturePair(path)
  if (!('skip' in pairResult) && !pairResult.ok) {
    return { schemaOk: true, failure: { file: path, detail: pairResult.reason } }
  }
  const attachResult = await parseAttachments(path)
  if (!('skip' in attachResult) && !attachResult.ok) {
    return { schemaOk: true, failure: { file: path, detail: attachResult.reason } }
  }
  // Re-parse to get the typed task for provenance check (cheap — already in mem).
  const raw = await readFile(path, 'utf8')
  const task = AssistantTrajTaskSchema.parse(JSON.parse(raw) as unknown)
  const provResult = checkRealProvenance(task)
  if (!provResult.ok) {
    return { schemaOk: true, failure: { file: path, detail: provResult.reason } }
  }
  return { schemaOk: true }
}

async function runAll(): Promise<Failure[]> {
  const tasksDir = resolve(rootDir(), 'tasks')
  const files = await listJson(tasksDir)
  const failures: Failure[] = []
  for (const f of files) {
    const { failure } = await validateTaskWithFixture(f)
    if (failure) {
      console.log(`✗ ${basename(f)}`)
      failures.push(failure)
    } else {
      console.log(`✓ ${basename(f)}`)
    }
  }
  if (files.length === 0) {
    console.log('(tasks/ is empty — nothing to validate)')
  }
  return failures
}

async function runOne(taskId: string): Promise<Failure[]> {
  const tasksDir = resolve(rootDir(), 'tasks')
  const path = join(tasksDir, `${taskId}.json`)
  const { failure } = await validateTaskWithFixture(path)
  if (failure) {
    console.log(`✗ ${basename(path)}`)
    return [failure]
  }
  console.log(`✓ ${basename(path)}`)
  return []
}

async function runFixtures(): Promise<Failure[]> {
  const root = rootDir()
  const validDir = resolve(root, 'fixtures/valid')
  const invalidDir = resolve(root, 'fixtures/invalid')
  const failures: Failure[] = []

  const validFiles = await listJson(validDir)
  for (const f of validFiles) {
    const result = await parseFile(f)
    if (result.ok) {
      console.log(`✓ valid/${basename(f)}`)
    } else {
      console.log(`✗ valid/${basename(f)} — expected pass, got error`)
      failures.push({ file: f, detail: `expected pass: ${result.reason}` })
    }
  }

  const invalidFiles = await listJson(invalidDir)
  for (const f of invalidFiles) {
    const result = await parseFile(f)
    const expectedReason = await readReason(f)
    if (result.ok) {
      console.log(`✗ invalid/${basename(f)} — expected fail, parsed OK`)
      failures.push({ file: f, detail: 'expected fail, parsed OK' })
      continue
    }
    if (expectedReason === null) {
      console.log(`✗ invalid/${basename(f)} — missing .reason.txt sidecar`)
      failures.push({ file: f, detail: 'missing .reason.txt sidecar' })
      continue
    }
    if (!result.reason.includes(expectedReason)) {
      console.log(
        `✗ invalid/${basename(f)} — error did not contain expected substring "${expectedReason}"`,
      )
      failures.push({
        file: f,
        detail: `expected substring "${expectedReason}" in: ${result.reason}`,
      })
      continue
    }
    console.log(`✓ invalid/${basename(f)} (rejected with "${expectedReason}")`)
  }

  return failures
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  let failures: Failure[]
  if (args.mode === 'fixtures') {
    failures = await runFixtures()
  } else if (args.mode === 'one' && args.taskId) {
    failures = await runOne(args.taskId)
  } else {
    failures = await runAll()
  }
  if (failures.length > 0) {
    console.error(`\n${String(failures.length)} failure(s):`)
    for (const f of failures) {
      console.error(`  ${f.file}\n    ${f.detail.replace(/\n/g, '\n    ')}`)
    }
    process.exit(1)
  }
}

await main()
