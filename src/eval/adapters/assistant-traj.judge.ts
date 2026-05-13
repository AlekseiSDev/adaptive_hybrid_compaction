// AssistantTraj LLM judge. Per docs/design/D_assistant-traj.md §6 + decisions.md
// [2026-05-13] D4 judge model + vision LLMClient + Score extension.
//
// Wires the `llm_judge` evaluation strategy through OpenRouter's Sonnet 4.6
// (fallback from 4-7 — not yet on OpenRouter, see decisions.md). For image_qa
// tasks the judge sees attachments as base64 data URLs alongside the rubric +
// expected_summary + assistant response.
//
// D5 Step 1 refactor: cache + parse + cost machinery moved to `_judge-core.ts`
// (shared across D5 benches). This file owns AT-specific request building
// (rubric loading + image attachment loading) and delegates execution to
// `runJudgeRequest`.

import { readFile } from 'node:fs/promises'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createOpenRouterClient } from '../llm.js'
import type {
  ContentBlock,
  LLMClient,
  LLMMessage,
  LLMRequest,
} from '../types.js'
import {
  parseThreeLevelJson,
  runJudgeRequest,
  type JudgeCache,
} from './_judge-core.js'
import type { LlmJudgeFn, LlmJudgeSpec } from './assistant-traj.js'
import type { AssistantTrajTask } from './assistant-traj.schema.js'

export {
  judgeCacheKey,
  loadCache,
  saveCache,
  parseThreeLevelJson as parseJudgeOutput,
  type JudgeCache,
  type JudgeCacheEntry,
} from './_judge-core.js'

export const JUDGE_DEFAULT_MODEL = 'anthropic/claude-sonnet-4.6'

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

export type JudgeDeps = {
  llmClient: LLMClient
  model?: string
  cache?: JudgeCache
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

  return runJudgeRequest(task.task_id, request, {
    llmClient: deps.llmClient,
    cachePath: judgeCachePath(),
    ...(deps.cache !== undefined ? { cache: deps.cache } : {}),
    ...(deps.persist !== undefined ? { persist: deps.persist } : {}),
    parseFn: parseThreeLevelJson,
  })
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
