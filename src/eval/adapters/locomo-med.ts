// LoCoMo-med BenchAdapter + Grader + inline judge. Per docs/design/D_assistant-traj.md §9
// (passive recall axis — dialog variant) + D5 plan Step 3.
//
// Multi-session dialog memory bench: task.conversation contains session_1,
// session_2, ... each with turn[]. Adapter.prepare() flattens conversation
// to user-turn segments + final question. Judge — single «reasonable
// equivalence» prompt (verbatim из `references/mle-harness/code/run_locomo.py:53-60`).

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createOpenRouterClient } from '../llm.js'
import type {
  BenchAdapter,
  Conversation,
  Grader,
  LLMClient,
  LLMMessage,
  LLMRequest,
  Message,
  RunnerResponse,
  Score,
  Task,
} from '../types.js'
import { parseYesNo, runJudgeRequest } from './_judge-core.js'

export type LoCoMoTurn = {
  speaker: string
  text: string
  dia_id?: string
}

export type LoCoMoConversation = {
  speaker_a: string
  speaker_b: string
  [sessionKey: string]: string | LoCoMoTurn[]
}

export type LoCoMoTask = {
  sample_id: string
  qa_idx: number
  category: 1 | 2 | 3 | 4
  category_name?: string
  question: string
  answer: string
  evidence?: string[]
  conversation: LoCoMoConversation
}

export const LOCOMO_JUDGE_DEFAULT_MODEL = 'anthropic/claude-sonnet-4.6'

// Driver system prompt verbatim from `run_locomo.py:47-50`.
export const LOCOMO_DRIVER_SYSTEM =
  'You are a helpful assistant. Use the conversation history below to answer ' +
  "the user's question. Be concise: respond with the direct answer in <=2 " +
  'sentences. If the answer is not in the history, say so.'

// Judge template verbatim from `run_locomo.py:53-60`.
function locomoJudgePrompt(question: string, answer: string, response: string): string {
  return (
    `I will give you a question, a correct answer, and a response from a model. ` +
    `Please answer yes if the response matches the correct answer with reasonable ` +
    `equivalence allowed. The response is correct if it conveys the same factual ` +
    `content, even if the wording differs. Otherwise, answer no.\n\n` +
    `Question: ${question}\nCorrect Answer: ${answer}\nModel Response: ${response}\n\n` +
    `Is the model response correct? Answer yes or no only.`
  )
}

export function buildLocomoJudgeRequest(
  task: LoCoMoTask,
  responseText: string,
  model: string = LOCOMO_JUDGE_DEFAULT_MODEL,
): LLMRequest {
  const prompt = locomoJudgePrompt(task.question, task.answer, responseText)
  const messages: LLMMessage[] = [{ role: 'user', content: prompt }]
  return { model, messages, temperature: 0, max_tokens: 10 }
}

function judgeCachePath(): string {
  return join(process.cwd(), 'benchmarks/locomo/judge_cache.json')
}

function tasksDir(): string {
  return join(process.cwd(), 'benchmarks/locomo/tasks')
}

function isSessionKey(k: string): boolean {
  if (!k.startsWith('session_')) return false
  if (k.endsWith('date_time')) return false
  const idx = Number(k.split('_')[1])
  return Number.isFinite(idx) && idx > 0
}

function sortedSessionKeys(conv: LoCoMoConversation): string[] {
  const keys = Object.keys(conv).filter(isSessionKey)
  keys.sort((a, b) => {
    const ai = Number(a.split('_')[1])
    const bi = Number(b.split('_')[1])
    return ai - bi
  })
  return keys
}

function flattenConversationToText(task: LoCoMoTask): string {
  // Mirrors conversation_to_segments from `run_locomo.py:71-117`:
  // for each session in order, emit `[date] speaker: text` lines.
  const conv = task.conversation
  const parts: string[] = []
  for (const sk of sortedSessionKeys(conv)) {
    const turns = conv[sk]
    if (!Array.isArray(turns)) continue
    const dateKey = `${sk}_date_time`
    const dateRaw = conv[dateKey]
    const date = typeof dateRaw === 'string' ? dateRaw : ''
    parts.push(date.length > 0 ? `[${sk} | ${date}]` : `[${sk}]`)
    for (const turn of turns) {
      const speaker = turn.speaker
      const text = turn.text
      const line = date.length > 0
        ? `[${date}] ${speaker}: ${text}`
        : `${speaker}: ${text}`
      parts.push(line)
    }
    parts.push('')
  }
  return parts.join('\n')
}

export const locomoAdapter: BenchAdapter = {
  name: 'locomo-med',
  async loadTasks(_seed: number): Promise<Task[]> {
    let entries: string[]
    try {
      entries = await readdir(tasksDir())
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw err
    }
    const out: Task[] = []
    for (const f of entries.filter((x) => x.endsWith('.json')).sort()) {
      const raw = await readFile(join(tasksDir(), f), 'utf8')
      const item = JSON.parse(raw) as LoCoMoTask
      out.push({
        id: `${item.sample_id}_qa${String(item.qa_idx)}`,
        input: item,
        expected: item.answer,
      })
    }
    return out
  },
  prepare(task: Task): Conversation {
    const item = task.input as LoCoMoTask
    const historyText = flattenConversationToText(item)
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: historyText }] },
      { role: 'user', content: [{ type: 'text', text: item.question }] },
    ]
    return { messages }
  },
}

export type LocomoJudgeDeps = {
  llmClient: LLMClient
  model?: string
  persist?: boolean
}

export async function locomoJudge(
  task: LoCoMoTask,
  responseText: string,
  deps: LocomoJudgeDeps,
): Promise<{ score: number; justification: string; cost_usd: number }> {
  const model = deps.model ?? LOCOMO_JUDGE_DEFAULT_MODEL
  const request = buildLocomoJudgeRequest(task, responseText, model)
  const prefix = `${task.sample_id}:${String(task.qa_idx)}`
  return runJudgeRequest(prefix, request, {
    llmClient: deps.llmClient,
    cachePath: judgeCachePath(),
    ...(deps.persist !== undefined ? { persist: deps.persist } : {}),
    parseFn: parseYesNo,
  })
}

export type LocomoLlmJudgeFn = (
  task: LoCoMoTask,
  responseText: string,
) => Promise<{ score: number; justification: string; cost_usd: number }>

export function defaultLocomoJudge(
  opts: { apiKey?: string; model?: string } = {},
): LocomoLlmJudgeFn {
  const apiKey = opts.apiKey ?? process.env['OPENROUTER_API_KEY']
  if (!apiKey || apiKey.length === 0) {
    throw new Error(
      'OPENROUTER_API_KEY env var is required for bench=locomo-med judge.',
    )
  }
  const llmClient = createOpenRouterClient({ apiKey, appName: 'AHC' })
  const model = opts.model ?? LOCOMO_JUDGE_DEFAULT_MODEL
  return async (task, responseText) => locomoJudge(task, responseText, { llmClient, model })
}

export type LoCoMoGraderDeps = {
  llmJudge?: LocomoLlmJudgeFn
}

export function createLoCoMoGrader(deps: LoCoMoGraderDeps = {}): Grader {
  return {
    score: async (task: Task, response: RunnerResponse): Promise<Score> => {
      const item = task.input as LoCoMoTask
      if (!deps.llmJudge) return { primary: 0 }
      const r = await deps.llmJudge(item, response.text)
      return {
        primary: r.score,
        judge_explanation: r.justification,
        judge_cost_usd: r.cost_usd,
      }
    },
  }
}

export const locomoGrader: Grader = createLoCoMoGrader()
