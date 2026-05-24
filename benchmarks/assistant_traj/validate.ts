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
  if ('skip' in pairResult) return { schemaOk: true }
  if (!pairResult.ok) {
    return { schemaOk: true, failure: { file: path, detail: pairResult.reason } }
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
