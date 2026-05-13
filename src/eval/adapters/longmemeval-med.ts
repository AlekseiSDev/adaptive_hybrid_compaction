// LongMemEval-med BenchAdapter + Grader. Per docs/design/D_assistant-traj.md §9
// (passive recall axis) + D5 plan Step 2.
//
// Single-turn long-context QA bench: task.haystack_sessions is a multi-session
// conversation history (~16k tokens). Adapter.prepare() returns FULL history
// as user-turn segments + final user question — compaction lives at baseline
// layer (full_context = passthrough, ahc_core = adaptive). Per upstream Python
// pattern `references/mle-harness/code/run_main.py:78-99` driver_answer.

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  BenchAdapter,
  Conversation,
  Grader,
  Message,
  RunnerResponse,
  Score,
  Task,
} from '../types.js'
import type { LmeLlmJudgeFn, LongMemEvalTask } from './longmemeval-med.judge.js'

export type { LongMemEvalTask } from './longmemeval-med.judge.js'

// Driver system prompt verbatim from `run_main.py:42-46`.
export const LME_DRIVER_SYSTEM =
  'You are a helpful assistant. Use the conversation history below to answer ' +
  "the user's question. Be concise: respond with the direct answer in <=2 " +
  'sentences. If the answer is not in the history, say so.'

function tasksDir(): string {
  return join(process.cwd(), 'benchmarks/longmemeval/tasks')
}

async function loadAllTaskFiles(): Promise<LongMemEvalTask[]> {
  const dir = tasksDir()
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  const jsons = entries.filter((f) => f.endsWith('.json')).sort()
  const out: LongMemEvalTask[] = []
  for (const f of jsons) {
    const raw = await readFile(join(dir, f), 'utf8')
    out.push(JSON.parse(raw) as LongMemEvalTask)
  }
  return out
}

function flattenHistoryToText(task: LongMemEvalTask): string {
  // Mirror flatten_longmemeval_history from upstream segments.py: each session
  // becomes a labeled block; messages emitted as `role: content` lines.
  const parts: string[] = []
  const sessions = task.haystack_sessions
  const dates = task.haystack_dates ?? []
  const ids = task.haystack_session_ids ?? []
  for (let i = 0; i < sessions.length; i += 1) {
    const sid = ids[i] ?? `session_${String(i + 1)}`
    const date = dates[i] ?? ''
    parts.push(date.length > 0 ? `[${sid} | ${date}]` : `[${sid}]`)
    const session = sessions[i] ?? []
    for (const msg of session) {
      parts.push(`${msg.role}: ${msg.content}`)
    }
    parts.push('')
  }
  return parts.join('\n')
}

export const longmemevalAdapter: BenchAdapter = {
  name: 'longmemeval-med',
  async loadTasks(_seed: number): Promise<Task[]> {
    const items = await loadAllTaskFiles()
    return items.map((item) => ({
      id: item.question_id,
      input: item,
      expected: item.answer,
    }))
  },
  prepare(task: Task): Conversation {
    const item = task.input as LongMemEvalTask
    const historyText = flattenHistoryToText(item)
    // Two user messages: flattened history + the final question. Mirrors
    // upstream `driver_answer`: history as labeled user-style segments, final
    // user-turn = the question. System prompt goes through Baseline's `system`
    // mechanism (full_context baseline prepends it; ahc_core uses generateText
    // `system:` option).
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: historyText }] },
      { role: 'user', content: [{ type: 'text', text: item.question }] },
    ]
    return { messages }
  },
}

export type LongMemEvalGraderDeps = {
  llmJudge?: LmeLlmJudgeFn
}

export function createLongMemEvalGrader(
  deps: LongMemEvalGraderDeps = {},
): Grader {
  return {
    score: async (task: Task, response: RunnerResponse): Promise<Score> => {
      const item = task.input as LongMemEvalTask
      if (!deps.llmJudge) {
        // Sync stub for tests without LLM injection. Real path uses
        // `defaultLmeJudge()` via runner registry.
        return { primary: 0 }
      }
      const r = await deps.llmJudge(item, response.text)
      return {
        primary: r.score,
        judge_explanation: r.justification,
        judge_cost_usd: r.cost_usd,
      }
    },
  }
}

export const longmemevalGrader: Grader = createLongMemEvalGrader()
