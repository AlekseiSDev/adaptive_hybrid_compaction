#!/usr/bin/env tsx
// AssistantTraj LLM-judge CLI. Per docs/design/D_assistant-traj.md §§6, 6.1.
//
// Modes:
//   --task <id> --response-file <path>
//     Run judge on one task with the response read from <path>. Prints
//     {score, justification, cost_usd}. Requires top-level llm_judge spec on
//     the task; composite-with-nested-judge tasks should use --calibrate.
//
//   --calibrate
//     Read calibration/human_scores.json and calibration/responses/<task_id>.txt
//     pairs, run judge per (task, response), print |human − judge| table.
//     Exit 0 if ≥70% within 0.5 (D §6.1 acceptance gate). Exit 1 otherwise.
//
// Requires OPENROUTER_API_KEY env. Reads model from JUDGE_MODEL env if set,
// else uses JUDGE_DEFAULT_MODEL from the adapter (anthropic/claude-sonnet-4.6).

import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  defaultLlmJudge,
  JUDGE_DEFAULT_MODEL,
} from '../../src/eval/adapters/assistant-traj.judge.js'
import { AssistantTrajTaskSchema, type AssistantTrajTask } from '../../src/eval/adapters/assistant-traj.schema.js'
import type { LlmJudgeSpec } from '../../src/eval/adapters/assistant-traj.js'

type Args =
  | { mode: 'task'; taskId: string; responseFile: string }
  | { mode: 'calibrate' }

function printUsage(): void {
  console.error(
    'usage:\n' +
      '  tsx benchmarks/assistant_traj/judge.ts --task <id> --response-file <path>\n' +
      '  tsx benchmarks/assistant_traj/judge.ts --calibrate',
  )
}

function parseArgs(argv: string[]): Args {
  let mode: 'task' | 'calibrate' | undefined
  let taskId: string | undefined
  let responseFile: string | undefined
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--task') {
      mode = 'task'
      const v = argv[i + 1]
      if (!v) {
        console.error('error: --task requires an id argument')
        process.exit(1)
      }
      taskId = v
      i += 1
    } else if (a === '--response-file') {
      const v = argv[i + 1]
      if (!v) {
        console.error('error: --response-file requires a path argument')
        process.exit(1)
      }
      responseFile = v
      i += 1
    } else if (a === '--calibrate') {
      mode = 'calibrate'
    } else if (a === '--help' || a === '-h') {
      printUsage()
      process.exit(0)
    } else if (a !== undefined) {
      console.error(`error: unknown argument: ${a}`)
      printUsage()
      process.exit(1)
    }
  }
  if (mode === 'task') {
    if (!taskId || !responseFile) {
      console.error('error: --task requires both --task <id> and --response-file <path>')
      process.exit(1)
    }
    return { mode, taskId, responseFile }
  }
  if (mode === 'calibrate') {
    return { mode }
  }
  printUsage()
  process.exit(1)
}

function repoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
}

async function loadTaskById(taskId: string): Promise<AssistantTrajTask> {
  const path = join(repoRoot(), 'benchmarks/assistant_traj/tasks', `${taskId}.json`)
  const raw = await readFile(path, 'utf8')
  const parsed = JSON.parse(raw) as unknown
  const result = AssistantTrajTaskSchema.safeParse(parsed)
  if (!result.success) {
    throw new Error(`invalid task ${taskId}: ${result.error.message}`)
  }
  return result.data
}

function extractTopLevelJudgeSpec(task: AssistantTrajTask): LlmJudgeSpec | null {
  if (task.evaluation.strategy === 'llm_judge') {
    return {
      rubric_id: task.evaluation.rubric_id,
      expected_summary: task.evaluation.expected_summary,
    }
  }
  return null
}

async function runOne(taskId: string, responseFile: string): Promise<void> {
  const task = await loadTaskById(taskId)
  const spec = extractTopLevelJudgeSpec(task)
  if (!spec) {
    console.error(
      `error: task ${taskId} has strategy=${task.evaluation.strategy} (not top-level llm_judge). ` +
        `Use --calibrate for composite tasks once calibration human_scores.json is populated.`,
    )
    process.exit(1)
  }
  const responseText = await readFile(resolve(responseFile), 'utf8')
  const llmJudge = defaultLlmJudge({ model: process.env['JUDGE_MODEL'] ?? JUDGE_DEFAULT_MODEL })
  const result = await llmJudge(task, responseText, spec)
  console.log(JSON.stringify(result, null, 2))
}

type HumanScoreEntry = { score: number; rationale?: string }
type HumanScores = Record<string, HumanScoreEntry>

async function runCalibrate(): Promise<void> {
  const calibDir = join(repoRoot(), 'benchmarks/assistant_traj/calibration')
  const humanPath = join(calibDir, 'human_scores.json')
  let humanScores: HumanScores
  try {
    const raw = await readFile(humanPath, 'utf8')
    humanScores = JSON.parse(raw) as HumanScores
  } catch (err) {
    console.error(`error: cannot read ${humanPath}: ${(err as Error).message}`)
    console.error(
      'Populate calibration/human_scores.json with {task_id: {score, rationale?}} entries first.',
    )
    process.exit(1)
  }
  const taskIds = Object.keys(humanScores)
  if (taskIds.length === 0) {
    console.error('error: human_scores.json is empty')
    process.exit(1)
  }

  const llmJudge = defaultLlmJudge({ model: process.env['JUDGE_MODEL'] ?? JUDGE_DEFAULT_MODEL })

  console.log('task_id'.padEnd(28) + 'human'.padStart(7) + 'judge'.padStart(7) + 'delta'.padStart(7))
  console.log('-'.repeat(50))

  let withinThreshold = 0
  for (const taskId of taskIds) {
    const human = humanScores[taskId]?.score
    if (human === undefined) continue
    const responsePath = join(calibDir, 'responses', `${taskId}.txt`)
    let responseText: string
    try {
      responseText = await readFile(responsePath, 'utf8')
    } catch (err) {
      console.error(`  skipping ${taskId}: ${(err as Error).message}`)
      continue
    }
    const task = await loadTaskById(taskId)
    const spec = extractTopLevelJudgeSpec(task)
    if (!spec) {
      console.error(`  skipping ${taskId}: not a top-level llm_judge task`)
      continue
    }
    const r = await llmJudge(task, responseText, spec)
    const delta = Math.abs(human - r.score)
    if (delta <= 0.5) withinThreshold += 1
    console.log(
      taskId.padEnd(28) +
        human.toFixed(2).padStart(7) +
        r.score.toFixed(2).padStart(7) +
        delta.toFixed(2).padStart(7),
    )
  }
  const total = taskIds.length
  const pct = (withinThreshold / total) * 100
  console.log('-'.repeat(50))
  console.log(`agreement: ${String(withinThreshold)}/${String(total)} within 0.5 (${pct.toFixed(1)}%)`)
  if (pct >= 70) {
    console.log('✓ calibration gate passed (≥70%)')
    process.exit(0)
  } else {
    console.error('✗ calibration gate FAILED (<70%) — iterate rubric and re-run')
    process.exit(1)
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.mode === 'task') {
    await runOne(args.taskId, args.responseFile)
  } else {
    await runCalibrate()
  }
}

await main()
