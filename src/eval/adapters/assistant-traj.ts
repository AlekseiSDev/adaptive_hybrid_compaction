// AssistantTraj BenchAdapter + Grader. Per docs/design/D_assistant-traj.md
// §§2 (Task schema), §5 (eval dispatch), §§6/6.1 (judge — wired in D4 Step 3).
//
// Replay-only contract: prepare() returns a user-only Conversation; baselines
// regenerate intermediate assistant turns from scratch via buildRunnerFromBaseline.
// Recorded assistant turns in the on-disk task file are one valid trajectory,
// not ground truth. Only the *final* assistant reply is scored against
// task.evaluation. See decisions.md [2026-05-13] D4 — replay-only.

import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ContentPart, Message } from '../../core/types.js'
import type { BenchAdapter, Grader, RunnerResponse, Score, Task } from '../types.js'
import { AssistantTrajTaskSchema, type AssistantTrajTask } from './assistant-traj.schema.js'

export type EvaluationSpec =
  | { strategy: 'exact_match'; expected: string; case_sensitive?: boolean }
  | { strategy: 'regex'; pattern: string; flags?: string }
  | { strategy: 'llm_judge'; rubric_id: string; expected_summary: string }
  | { strategy: 'composite'; rules: EvaluationSpec[]; aggregate: 'all' | 'any' | 'mean' }

// Narrowed on-disk ContentPart shape. The schema uses z.lazy() to support
// recursive tool_result.content, which erodes z.infer down to `unknown` for
// nested arrays. This local type re-asserts the discriminated-union shape so
// `projectContent` can switch on `part.type` without manual casts everywhere.
type ContentPartOnDisk =
  | { type: 'text'; text: string }
  | { type: 'image'; path: string; alt?: string }
  | { type: 'file'; path: string; mime?: string }
  | { type: 'tool_use'; tool_use_id: string; name: string; input: unknown }
  | {
      type: 'tool_result'
      tool_use_id: string
      content: ContentPartOnDisk[]
      is_error?: boolean
    }

function repoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
}

function tasksDir(): string {
  return join(repoRoot(), 'benchmarks/assistant_traj/tasks')
}

async function readTaskFile(path: string): Promise<AssistantTrajTask> {
  const raw = await readFile(path, 'utf8')
  const parsed = JSON.parse(raw) as unknown
  const result = AssistantTrajTaskSchema.safeParse(parsed)
  if (!result.success) {
    throw new Error(`invalid AssistantTraj task at ${path}: ${result.error.message}`)
  }
  return result.data
}

export async function loadAllAssistantTrajTasks(): Promise<AssistantTrajTask[]> {
  const dir = tasksDir()
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  const files = entries.filter((e) => e.endsWith('.json')).sort()
  return Promise.all(files.map((f) => readTaskFile(join(dir, f))))
}

// Project on-disk turn content → in-memory core ContentPart[]. Image / file
// parts become text placeholders (baselines are text-only; vision-capable
// judge consumes attachments directly from disk in D4 Step 3).
function projectContent(content: readonly ContentPartOnDisk[]): ContentPart[] {
  const out: ContentPart[] = []
  for (const part of content) {
    if (part.type === 'text') {
      out.push({ type: 'text', text: part.text })
    } else if (part.type === 'image') {
      const alt = part.alt !== undefined && part.alt.length > 0 ? `; alt=${part.alt}` : ''
      out.push({ type: 'text', text: `[Image attachment: ${part.path}${alt}]` })
    } else if (part.type === 'file') {
      out.push({ type: 'text', text: `[File attachment: ${part.path}]` })
    }
    // tool_use / tool_result skipped from user turns (replay-only — baseline
    // regenerates tool flow). They don't appear in our authored user turns.
  }
  if (out.length === 0) {
    out.push({ type: 'text', text: '' })
  }
  return out
}

export const assistantTrajAdapter: BenchAdapter = {
  name: 'assistant-traj',
  loadTasks: async (_seed) => {
    const tasks = await loadAllAssistantTrajTasks()
    return tasks.map((t) => ({
      id: t.task_id,
      input: t,
      expected: t.evaluation,
    }))
  },
  prepare: (task) => {
    const at = task.input as AssistantTrajTask
    const messages: Message[] = []
    for (const turn of at.turns) {
      if (turn.role !== 'user') continue
      const content = turn.content as readonly ContentPartOnDisk[]
      messages.push({ role: 'user', content: projectContent(content) })
    }
    return { messages }
  },
}

// Grader

export type LlmJudgeFn = (
  task: AssistantTrajTask,
  responseText: string,
) => { score: number; justification: string; cost_usd: number }

export type AssistantTrajGraderDeps = {
  // D4 Step 3 wires a real vision-capable judge here. Default = stub.
  llmJudge?: LlmJudgeFn
}

function evaluateSpec(
  spec: EvaluationSpec,
  responseText: string,
  task: AssistantTrajTask,
  deps: AssistantTrajGraderDeps,
): Score {
  if (spec.strategy === 'exact_match') {
    const lhs = spec.case_sensitive === false ? spec.expected.toLowerCase() : spec.expected
    const rhs = spec.case_sensitive === false ? responseText.toLowerCase() : responseText
    return { primary: rhs === lhs ? 1 : 0 }
  }
  if (spec.strategy === 'regex') {
    const re = new RegExp(spec.pattern, spec.flags ?? '')
    return { primary: re.test(responseText) ? 1 : 0 }
  }
  if (spec.strategy === 'llm_judge') {
    if (!deps.llmJudge) {
      return { primary: 0, judge_explanation: 'judge-stub' }
    }
    const r = deps.llmJudge(task, responseText)
    const score: Score = { primary: r.score, judge_explanation: r.justification }
    if (r.cost_usd > 0) score.judge_cost_usd = r.cost_usd
    return score
  }
  // composite
  const sub = spec.rules.map((r) => evaluateSpec(r, responseText, task, deps))
  let primary: number
  if (spec.aggregate === 'all') {
    primary = sub.every((s) => s.primary === 1) ? 1 : 0
  } else if (spec.aggregate === 'any') {
    primary = sub.some((s) => s.primary === 1) ? 1 : 0
  } else {
    primary = sub.reduce((acc, s) => acc + s.primary, 0) / Math.max(sub.length, 1)
  }
  const judgeCost = sub.reduce((acc, s) => acc + (s.judge_cost_usd ?? 0), 0)
  const result: Score = { primary }
  if (judgeCost > 0) result.judge_cost_usd = judgeCost
  return result
}

export function createAssistantTrajGrader(deps: AssistantTrajGraderDeps = {}): Grader {
  return {
    score: (task: Task, response: RunnerResponse): Score => {
      const at = task.input as AssistantTrajTask
      const spec = task.expected as EvaluationSpec
      return evaluateSpec(spec, response.text, at, deps)
    },
  }
}

export const assistantTrajGrader: Grader = createAssistantTrajGrader()
