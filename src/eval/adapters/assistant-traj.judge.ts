// AssistantTraj LLM judge. Per docs/design/D_assistant-traj.md §6 + decisions.md
// [2026-05-13] D4 judge model + vision LLMClient + Score extension.
//
// Wires the `llm_judge` evaluation strategy through OpenRouter's Sonnet 4.6
// (fallback from 4-7 — not yet on OpenRouter, see decisions.md). For image_qa
// tasks the judge sees attachments as base64 data URLs alongside the rubric +
// expected_summary + assistant response.

import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  costFromUsage,
  createOpenRouterClient,
  OPENROUTER_PRICING,
} from '../llm.js'
import { canonicalJson } from '../persist.js'
import type {
  ContentBlock,
  LLMClient,
  LLMMessage,
  LLMRequest,
} from '../types.js'
import type { LlmJudgeFn, LlmJudgeSpec } from './assistant-traj.js'
import type { AssistantTrajTask } from './assistant-traj.schema.js'

export const JUDGE_DEFAULT_MODEL = 'anthropic/claude-sonnet-4.6'

export type JudgeCacheEntry = {
  score: number
  justification: string
  cost_usd: number
  model: string
  ts: string
}

export type JudgeCache = Record<string, JudgeCacheEntry>

function repoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
}

function rubricPath(name: string): string {
  return join(repoRoot(), 'benchmarks/assistant_traj/rubrics', `${name}.md`)
}

export function judgeCachePath(): string {
  return join(repoRoot(), 'benchmarks/assistant_traj/judge_cache.json')
}

export async function loadRubric(
  rubricId: string,
  fallbackCategory: string,
): Promise<string> {
  try {
    return await readFile(rubricPath(rubricId), 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    return readFile(rubricPath(fallbackCategory), 'utf8')
  }
}

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
}

async function loadImageAsDataUrl(relPath: string): Promise<string> {
  const abs = relPath.startsWith('/')
    ? relPath
    : join(repoRoot(), 'benchmarks/assistant_traj', relPath)
  const buf = await readFile(abs)
  const ext = extname(abs).toLowerCase()
  const mime = MIME_BY_EXT[ext] ?? 'application/octet-stream'
  return `data:${mime};base64,${buf.toString('base64')}`
}

function extractLastUserText(task: AssistantTrajTask): string {
  for (let i = task.turns.length - 1; i >= 0; i--) {
    const turn = task.turns[i]
    if (turn?.role !== 'user') continue
    const parts: string[] = []
    const content = turn.content as { type: string; text?: string }[]
    for (const p of content) {
      if (p.type === 'text' && typeof p.text === 'string') parts.push(p.text)
    }
    return parts.join('\n')
  }
  return ''
}

function collectImagePaths(task: AssistantTrajTask): string[] {
  const out: string[] = []
  for (const turn of task.turns) {
    const content = turn.content as { type: string; path?: string }[]
    for (const p of content) {
      if (p.type === 'image' && typeof p.path === 'string') out.push(p.path)
    }
  }
  return out
}

export type BuildJudgeRequestOpts = {
  rubric: string
  model: string
  judgeSpec: LlmJudgeSpec
  imageDataUrls?: string[]
}

export function buildJudgeRequest(
  task: AssistantTrajTask,
  responseText: string,
  opts: BuildJudgeRequestOpts,
): LLMRequest {
  const lastQuestion = extractLastUserText(task)
  const userBlocks: ContentBlock[] = [
    {
      type: 'text',
      text:
        `${opts.rubric}\n\n---\n` +
        `User instruction (final turn): ${lastQuestion}\n\n` +
        `Expected summary (ground truth): ${opts.judgeSpec.expected_summary}\n\n` +
        `Assistant response:\n${responseText}\n\n` +
        `Output JSON only, no prose: ` +
        `{"score": 0.0 | 0.5 | 1.0, "justification": "<≤2 sentences>"}`,
    },
  ]
  for (const dataUrl of opts.imageDataUrls ?? []) {
    userBlocks.push({ type: 'image_url', image_url: { url: dataUrl } })
  }
  const messages: LLMMessage[] = [
    {
      role: 'system',
      content:
        'You are a strict, calibrated grader. Score assistant responses per the supplied rubric. Reply with JSON only.',
    },
    { role: 'user', content: userBlocks },
  ]
  return { model: opts.model, messages, temperature: 0 }
}

const VALID_SCORES = new Set([0, 0.5, 1])

export function parseJudgeOutput(
  text: string,
): { score: number; justification: string } | null {
  const match = /\{[\s\S]*\}/.exec(text)
  if (!match) return null
  let obj: { score?: unknown; justification?: unknown }
  try {
    obj = JSON.parse(match[0]) as { score?: unknown; justification?: unknown }
  } catch {
    return null
  }
  if (typeof obj.score !== 'number') return null
  if (!VALID_SCORES.has(obj.score)) return null
  const justification =
    typeof obj.justification === 'string' ? obj.justification : ''
  return { score: obj.score, justification }
}

export async function loadCache(): Promise<JudgeCache> {
  try {
    const raw = await readFile(judgeCachePath(), 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as JudgeCache
    }
    return {}
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    console.warn(
      `[judge] cache corrupt, starting fresh: ${err instanceof Error ? err.message : String(err)}`,
    )
    return {}
  }
}

export async function saveCache(cache: JudgeCache): Promise<void> {
  await writeFile(
    judgeCachePath(),
    JSON.stringify(cache, null, 2) + '\n',
    'utf8',
  )
}

export function judgeCacheKey(task: AssistantTrajTask, request: LLMRequest): string {
  return createHash('sha256')
    .update(task.task_id + canonicalJson(request))
    .digest('hex')
}

export type JudgeDeps = {
  llmClient: LLMClient
  model?: string
  // Optional pre-loaded cache (for tests / batch scenarios that load once).
  cache?: JudgeCache
  // If false, do not write cache to disk after a fresh judgement. Useful for
  // tests that pre-load and re-check cache state without touching FS.
  persist?: boolean
}

export async function judge(
  task: AssistantTrajTask,
  responseText: string,
  spec: LlmJudgeSpec,
  deps: JudgeDeps,
): Promise<{ score: number; justification: string; cost_usd: number }> {
  const model = deps.model ?? JUDGE_DEFAULT_MODEL
  const rubric = await loadRubric(spec.rubric_id, task.category)
  const imagePaths = collectImagePaths(task)
  const imageDataUrls: string[] = []
  for (const p of imagePaths) {
    try {
      imageDataUrls.push(await loadImageAsDataUrl(p))
    } catch (err) {
      console.warn(
        `[judge] image load failed for ${p}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }
  const request = buildJudgeRequest(task, responseText, {
    rubric,
    model,
    judgeSpec: spec,
    imageDataUrls,
  })

  const cache = deps.cache ?? (await loadCache())
  const key = judgeCacheKey(task, request)
  const hit = cache[key]
  if (hit) {
    return {
      score: hit.score,
      justification: hit.justification,
      cost_usd: 0,
    }
  }

  const llmResponse = await deps.llmClient(request)
  if (llmResponse.error) {
    return {
      score: 0,
      justification: `judge LLM error: ${llmResponse.error.kind} ${llmResponse.error.message}`,
      cost_usd: 0,
    }
  }
  const parsed = parseJudgeOutput(llmResponse.text)
  if (!parsed) {
    return {
      score: 0,
      justification: `judge JSON parse failed: ${llmResponse.text.slice(0, 200)}`,
      cost_usd: 0,
    }
  }

  let cost_usd = 0
  if (
    llmResponse.raw_usage &&
    'prompt_tokens' in llmResponse.raw_usage &&
    Object.hasOwn(OPENROUTER_PRICING, model)
  ) {
    cost_usd = costFromUsage(model, llmResponse.raw_usage)
  }

  const entry: JudgeCacheEntry = {
    score: parsed.score,
    justification: parsed.justification,
    cost_usd,
    model,
    ts: new Date().toISOString(),
  }
  cache[key] = entry
  if (deps.persist !== false) {
    await saveCache(cache)
  }
  return { score: parsed.score, justification: parsed.justification, cost_usd }
}

export type DefaultLlmJudgeOptions = {
  apiKey?: string
  model?: string
}

// Factory used by defaultAdapterRegistry.resolve('assistant-traj') when a
// real LLM-bound judge is required. Throws on missing OPENROUTER_API_KEY —
// symmetric with makeFullContextRunner's behavior.
export function defaultLlmJudge(opts: DefaultLlmJudgeOptions = {}): LlmJudgeFn {
  const apiKey = opts.apiKey ?? process.env['OPENROUTER_API_KEY']
  if (!apiKey || apiKey.length === 0) {
    throw new Error(
      'OPENROUTER_API_KEY env var is required for bench=assistant-traj (D4 LLM judge). ' +
        'Set it in .env.local or export it before invoking the sweep.',
    )
  }
  const llmClient = createOpenRouterClient({ apiKey, appName: 'AHC' })
  const model = opts.model ?? JUDGE_DEFAULT_MODEL
  return async (task, responseText, spec) => judge(task, responseText, spec, { llmClient, model })
}
