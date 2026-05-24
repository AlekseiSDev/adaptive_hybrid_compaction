// AssistantTraj BenchAdapter + Grader. Per docs/design/D_assistant-traj.md
// §§2 (Task schema), §5 (eval dispatch), §§6/6.1 (judge — wired in D4 Step 3).
//
// Replay-only contract: prepare() returns a user-only Conversation; baselines
// regenerate intermediate assistant turns from scratch via buildRunnerFromBaseline.
// Recorded assistant turns in the on-disk task file are one valid trajectory,
// not ground truth. Only the *final* assistant reply is scored against
// task.evaluation. See decisions.md [2026-05-13] D4 — replay-only.

import { readFile, readdir, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ContentPart, Message } from '../../core/types.js'
import type { BenchAdapter, Grader, RunnerResponse, Score, Task, ToolHandle } from '../types.js'
import { AssistantTrajTaskSchema, type AssistantTrajTask } from './assistant-traj.schema.js'
import {
  ToolFixtureFileSchema,
  type ToolFixtureFile,
} from './assistant-traj.tool-fixtures.schema.js'
import {
  AT_TOOL_NAMES,
  ReplayDispatcher,
  buildEmptyReplayDispatcher,
  buildReplayTools,
} from './assistant-traj.tools.js'

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

function fixturesDir(): string {
  return join(repoRoot(), 'benchmarks/assistant_traj/tool_fixtures')
}

function defaultFixturePath(task: AssistantTrajTask): string {
  return join(fixturesDir(), `${task.task_id}.json`)
}

// Sidecar fixture loader. Track J §10.4 invariant — paired fixture file must
// exist when the task declares any required tool. Validator guards this at
// authoring time (see benchmarks/assistant_traj/validate.ts); this loader is
// the runtime sibling.
//
// Returns null when (a) task has no expected_tool_calls.required entries AND
// no explicit tool_fixtures_ref, OR (b) sidecar file genuinely missing — we
// tolerate (b) and dispatcher emits ToolReplayMissError on first call so the
// gap surfaces as RunRecord error rather than silent pass.
async function loadFixtureForTask(task: AssistantTrajTask): Promise<ToolFixtureFile | null> {
  const hasRequired = task.turns.some(
    (turn) => (turn.expected_tool_calls ?? []).some((c) => c.required === true),
  )
  if (!hasRequired && (task.tool_fixtures_ref === undefined || task.tool_fixtures_ref.length === 0)) {
    return null
  }
  const path = task.tool_fixtures_ref
    ? resolve(repoRoot(), task.tool_fixtures_ref)
    : defaultFixturePath(task)
  try {
    await stat(path)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
  const raw = await readFile(path, 'utf8')
  const parsed = JSON.parse(raw) as unknown
  const result = ToolFixtureFileSchema.safeParse(parsed)
  if (!result.success) {
    throw new Error(
      `invalid tool fixture for ${task.task_id} at ${path}: ${result.error.message}`,
    )
  }
  return result.data
}

// Cache of preloaded fixtures keyed by task_id. Populated by loadTasks() and
// consumed by sync prepare(). Avoids async prepare signature change to
// BenchAdapter (the whole eval flow is sync at prepare-time).
const fixtureCache = new Map<string, ToolFixtureFile | null>()

function dispatcherForTask(task: AssistantTrajTask): ReplayDispatcher {
  const fixture = fixtureCache.get(task.task_id)
  if (fixture !== undefined && fixture !== null) {
    return new ReplayDispatcher(fixture)
  }
  return buildEmptyReplayDispatcher(task.task_id)
}

function toolsForTask(task: AssistantTrajTask): Record<string, ToolHandle> | undefined {
  if (task.tools_available.length === 0) return undefined
  const declared = new Set(task.tools_available.map((t) => t.name))
  const replay = buildReplayTools(dispatcherForTask(task))
  const out: Record<string, ToolHandle> = {}
  for (const name of AT_TOOL_NAMES) {
    if (declared.has(name)) {
      out[name] = replay[name]
    }
  }
  return Object.keys(out).length > 0 ? out : undefined
}

export const assistantTrajAdapter: BenchAdapter = {
  name: 'assistant-traj',
  loadTasks: async (_seed) => {
    const tasks = await loadAllAssistantTrajTasks()
    // Preload fixtures so sync prepare() can hand out dispatchers without
    // re-reading the file system on every task. Cache survives within the
    // sweep process; cross-process state is irrelevant — each sweep loads
    // tasks fresh.
    await Promise.all(
      tasks.map(async (t) => {
        const f = await loadFixtureForTask(t)
        fixtureCache.set(t.task_id, f)
      }),
    )
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
    const tools = toolsForTask(at)
    return tools ? { messages, tools } : { messages }
  },
}

// Test-only: surface the fixture cache + manual loader so tests can drive
// adapter.prepare() without going through async loadTasks() preload. Kept
// minimal — production code uses loadTasks() exclusively.
export const __testing = {
  fixtureCache,
  loadFixtureForTask,
}

// Grader

// `spec` carries the active llm_judge sub-spec so the judge can read
// rubric_id / expected_summary even when the strategy is nested inside a
// composite parent.
export type LlmJudgeSpec = {
  rubric_id: string
  expected_summary: string
}

export type LlmJudgeFn = (
  task: AssistantTrajTask,
  responseText: string,
  spec: LlmJudgeSpec,
) => Promise<{ score: number; justification: string; cost_usd: number }>

export type AssistantTrajGraderDeps = {
  // D4 Step 3 wires a real vision-capable judge here. Default = stub.
  llmJudge?: LlmJudgeFn
}

async function evaluateSpec(
  spec: EvaluationSpec,
  responseText: string,
  task: AssistantTrajTask,
  deps: AssistantTrajGraderDeps,
): Promise<Score> {
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
    const r = await deps.llmJudge(task, responseText, {
      rubric_id: spec.rubric_id,
      expected_summary: spec.expected_summary,
    })
    const score: Score = { primary: r.score, judge_explanation: r.justification }
    if (r.cost_usd > 0) score.judge_cost_usd = r.cost_usd
    return score
  }
  // composite
  const sub = await Promise.all(
    spec.rules.map((r) => evaluateSpec(r, responseText, task, deps)),
  )
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

// Track J §6 — evaluateToolCalls. Compares emitted toolCalls (from
// RunnerResponse.toolCalls — populated by AI SDK / Mastra agent loop in J2
// plumbing) against task's required expected_tool_calls. Default aggregation
// is hard-gate: `final.primary = content.primary * (pass ? 1 : 0)`. Soft
// proportional aggregation is Q1 in J doc — revisit after first J6 sweep.

export type ToolCallObserved = { name: string; args?: unknown }

export function evaluateToolCalls(
  task: AssistantTrajTask,
  observed: readonly ToolCallObserved[] | undefined,
): { required_called: number; required_total: number; pass: boolean } {
  // Aggregate required tools across all turns. A "required" expectation in
  // any turn must have a matching observed call somewhere in the trace.
  const required: { tool_name: string; args_match?: 'exact' | 'subset' | 'semantic' }[] = []
  for (const turn of task.turns) {
    for (const exp of turn.expected_tool_calls ?? []) {
      if (exp.required === true) {
        required.push({
          tool_name: exp.tool_name,
          ...(exp.args_match !== undefined ? { args_match: exp.args_match } : {}),
        })
      }
    }
  }
  const obs = observed ?? []
  let called = 0
  for (const req of required) {
    if (obs.some((o) => o.name === req.tool_name)) {
      // args_match 'semantic' is deferred (J doc Q2). 'exact' / 'subset'
      // require we have the expected args in the expectation entry — current
      // schema doesn't carry expected args on ToolCallExpectation (importer
      // doesn't have ground-truth args either). Treat as `presence-only` for
      // J5: required tool name must appear at least once.
      called += 1
    }
  }
  return {
    required_called: called,
    required_total: required.length,
    pass: required.length === 0 || called === required.length,
  }
}

export function createAssistantTrajGrader(deps: AssistantTrajGraderDeps = {}): Grader {
  return {
    score: async (task: Task, response: RunnerResponse): Promise<Score> => {
      const at = task.input as AssistantTrajTask
      const spec = task.expected as EvaluationSpec
      const contentScore = await evaluateSpec(spec, response.text, at, deps)
      const toolCoherence = evaluateToolCalls(at, response.toolCalls)

      // Hard-gate aggregation (J doc §6.2 default). Without tool_coherence,
      // content score doesn't count — even a textually correct answer is 0
      // if the required tool wasn't called, because we can't verify the
      // model didn't hallucinate the tool result. Q1 revisit if first J6
      // sweep shows full_context losing >30% signal.
      const score: Score = {
        ...contentScore,
        primary: contentScore.primary * (toolCoherence.pass ? 1 : 0),
        tool_coherence: toolCoherence,
      }
      return score
    },
  }
}

export const assistantTrajGrader: Grader = createAssistantTrajGrader()
