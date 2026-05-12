import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { execSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { RunRecord, TrajectoryClass, TurnRecord } from './types.js'

const SCRIPT = resolve(process.cwd(), 'scripts/per-class-report.ts')

let workspace: string

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'ahc-pcr-'))
})

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true })
})

const makeTurn = (i: number, cls?: TrajectoryClass): TurnRecord => ({
  turn_index: i,
  input_tokens: 0,
  output_tokens: 0,
  wall_clock_ms: 0,
  recall_events: [],
  compaction_events: [],
  ...(cls !== undefined ? { class_signal: { class: cls, confidence: 0.9 } } : {}),
})

const makeRecord = (
  task_id: string,
  primary: number,
  turns: TurnRecord[],
): RunRecord => ({
  run_id: 'r-' + task_id,
  bench: 'synthetic',
  config_id: 'c1',
  seed: 42,
  task_id,
  started_at: 0,
  completed_at: 1,
  score: { primary },
  totals: { input: 0, output: 0 },
  cost_usd: 0,
  turns,
  errors: [],
})

async function writeNdjson(records: RunRecord[]): Promise<string> {
  const path = join(workspace, 'records.ndjson')
  const content = records.map((r) => JSON.stringify(r)).join('\n') + '\n'
  await writeFile(path, content, 'utf8')
  return workspace
}

describe('scripts/per-class-report.ts', () => {
  test('prints class buckets with correct n + mean_primary on synthetic NDJSON', async () => {
    await writeNdjson([
      makeRecord('t1', 1, [makeTurn(0, 'conversational'), makeTurn(1, 'conversational')]),
      makeRecord('t2', 0, [makeTurn(0, 'conversational')]),
      makeRecord('t3', 1, [makeTurn(0, 'tool_heavy'), makeTurn(1, 'tool_heavy')]),
      makeRecord('t4', 1, [makeTurn(0)]), // 'unknown'
    ])
    const out = execSync(`pnpm tsx ${SCRIPT} ${workspace}`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    expect(out).toMatch(/total_records=4/)
    expect(out).toMatch(/conversational\s+2\s+0\.5000/)
    expect(out).toMatch(/tool_heavy\s+1\s+1\.0000/)
    expect(out).toMatch(/unknown\s+1\s+1\.0000/)
  })

  test('missing runDir → exit code 1 + stderr message', () => {
    const fakeDir = join(workspace, 'does-not-exist')
    let exitCode = 0
    let stderr = ''
    try {
      execSync(`pnpm tsx ${SCRIPT} ${fakeDir}`, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (err) {
      const e = err as { status?: number; stderr?: string }
      exitCode = e.status ?? 0
      stderr = e.stderr ?? ''
    }
    expect(exitCode).toBe(1)
    expect(stderr).toMatch(/does not exist/)
  })

  test('no args → exit 1 + usage stderr', () => {
    let exitCode = 0
    let stderr = ''
    try {
      execSync(`pnpm tsx ${SCRIPT}`, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (err) {
      const e = err as { status?: number; stderr?: string }
      exitCode = e.status ?? 0
      stderr = e.stderr ?? ''
    }
    expect(exitCode).toBe(1)
    expect(stderr).toMatch(/usage/i)
  })
})
