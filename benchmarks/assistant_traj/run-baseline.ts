#!/usr/bin/env tsx
// Run the full_context baseline against AssistantTraj tasks and save the
// final assistant reply to calibration/responses/<task_id>.txt. Used to
// generate human-labelable responses for the D4 §6.1 calibration gate.
//
// Usage:
//   pnpm tsx benchmarks/assistant_traj/run-baseline.ts --task <id>
//   pnpm tsx benchmarks/assistant_traj/run-baseline.ts --tasks at_image_qa_005,at_code_iter_005,at_research_write_005
//
// Requires OPENROUTER_API_KEY in env. Reads model from BASELINE_MODEL env if
// set (default = same actor model as system_design §6.1).

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assistantTrajAdapter } from '../../src/eval/adapters/assistant-traj.js'
import { defaultRunnerRegistry } from '../../src/eval/runner.js'
import type { RunnerContext, Task } from '../../src/eval/types.js'

function repoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
}

function responsesDir(): string {
  return join(repoRoot(), 'benchmarks/assistant_traj/calibration/responses')
}

function parseArgs(argv: string[]): { taskIds: string[] } {
  const ids: string[] = []
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--task') {
      const v = argv[i + 1]
      if (!v) {
        console.error('error: --task requires an id argument')
        process.exit(1)
      }
      ids.push(v)
      i += 1
    } else if (a === '--tasks') {
      const v = argv[i + 1]
      if (!v) {
        console.error('error: --tasks requires a comma-separated list')
        process.exit(1)
      }
      ids.push(...v.split(',').map((s) => s.trim()).filter((s) => s.length > 0))
      i += 1
    } else if (a === '--help' || a === '-h') {
      console.log(
        'usage: tsx benchmarks/assistant_traj/run-baseline.ts --task <id> | --tasks <id1,id2,...>',
      )
      process.exit(0)
    } else if (a !== undefined) {
      console.error(`error: unknown argument: ${a}`)
      process.exit(1)
    }
  }
  if (ids.length === 0) {
    console.error('error: at least one --task or --tasks argument required')
    process.exit(1)
  }
  return { taskIds: ids }
}

async function runOne(task: Task): Promise<{ text: string; cost_usd: number }> {
  const config = { id: 'full_context', baseline: 'full_context' }
  const runner = defaultRunnerRegistry.resolve(config)
  const conv = assistantTrajAdapter.prepare(task)
  const ctx: RunnerContext = {
    bench: 'assistant-traj',
    config,
    seed: 42,
    task,
  }
  const response = await runner.execute(conv, ctx)
  return { text: response.text, cost_usd: response.cost_usd }
}

async function main(): Promise<void> {
  const { taskIds } = parseArgs(process.argv.slice(2))
  const allTasks = await assistantTrajAdapter.loadTasks(42)
  await mkdir(responsesDir(), { recursive: true })
  let totalCost = 0
  for (const taskId of taskIds) {
    const task = allTasks.find((t) => t.id === taskId)
    if (!task) {
      console.error(`✗ ${taskId}: not found in tasks/`)
      process.exit(1)
    }
    console.log(`→ ${taskId} ...`)
    const start = Date.now()
    const { text, cost_usd } = await runOne(task)
    totalCost += cost_usd
    const outPath = join(responsesDir(), `${taskId}.txt`)
    await writeFile(outPath, text, 'utf8')
    const elapsed = Date.now() - start
    console.log(
      `✓ ${taskId} → ${outPath} (${String(text.length)} chars, $${cost_usd.toFixed(4)}, ${String(elapsed)}ms)`,
    )
  }
  console.log(`\nTotal baseline cost: $${totalCost.toFixed(4)}`)
}

await main()
