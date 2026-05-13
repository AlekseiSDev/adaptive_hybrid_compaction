// Shared LLM-judge core. Per docs/design/D_assistant-traj.md §6.2 + D5 plan
// Step 1 — extracted from assistant-traj.judge.ts so D5 benches (LongMemEval,
// LoCoMo) can reuse cache + cost + parse machinery с собственными prompt
// builders + parse functions.
//
// Generic over task shape: cache key префикс — opaque string (`task_id`,
// `question_id`, `${sample_id}:${qa_idx}`). Parse function pluggable: AT
// uses parseThreeLevelJson (0/0.5/1.0), LME/LoCoMo use parseYesNo. Cache
// file path bench-specific (`benchmarks/<bench>/judge_cache.json`).

import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { costFromUsage, OPENROUTER_PRICING } from '../llm.js'
import { canonicalJson } from '../persist.js'
import type { LLMClient, LLMRequest } from '../types.js'

export type JudgeCacheEntry = {
  score: number
  justification: string
  cost_usd: number
  model: string
  ts: string
}

export type JudgeCache = Record<string, JudgeCacheEntry>

export type ParseJudgeFn = (
  text: string,
) => { score: number; justification: string } | null

export type RunJudgeDeps = {
  llmClient: LLMClient
  cachePath: string
  cache?: JudgeCache
  persist?: boolean
  parseFn: ParseJudgeFn
}

const THREE_LEVEL_VALID = new Set([0, 0.5, 1])

export const parseThreeLevelJson: ParseJudgeFn = (text) => {
  const match = /\{[\s\S]*\}/.exec(text)
  if (!match) return null
  let obj: { score?: unknown; justification?: unknown }
  try {
    obj = JSON.parse(match[0]) as { score?: unknown; justification?: unknown }
  } catch {
    return null
  }
  if (typeof obj.score !== 'number') return null
  if (!THREE_LEVEL_VALID.has(obj.score)) return null
  const justification =
    typeof obj.justification === 'string' ? obj.justification : ''
  return { score: obj.score, justification }
}

export const parseYesNo: ParseJudgeFn = (text) => {
  const trimmed = text.trim()
  if (trimmed.length === 0) return null
  const lower = trimmed.toLowerCase()
  if (/^yes\b/.test(lower)) {
    return { score: 1.0, justification: trimmed.slice(0, 200) }
  }
  if (/^no\b/.test(lower)) {
    return { score: 0.0, justification: trimmed.slice(0, 200) }
  }
  return null
}

export function judgeCacheKey(prefix: string, request: LLMRequest): string {
  return createHash('sha256')
    .update(prefix + canonicalJson(request))
    .digest('hex')
}

export async function loadCache(cachePath: string): Promise<JudgeCache> {
  try {
    const raw = await readFile(cachePath, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as JudgeCache
    }
    return {}
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    console.warn(
      `[judge-core] cache corrupt at ${cachePath}, starting fresh: ${err instanceof Error ? err.message : String(err)}`,
    )
    return {}
  }
}

export async function saveCache(
  cachePath: string,
  cache: JudgeCache,
): Promise<void> {
  await writeFile(cachePath, JSON.stringify(cache, null, 2) + '\n', 'utf8')
}

export async function runJudgeRequest(
  prefix: string,
  request: LLMRequest,
  deps: RunJudgeDeps,
): Promise<{ score: number; justification: string; cost_usd: number }> {
  const cache = deps.cache ?? (await loadCache(deps.cachePath))
  const key = judgeCacheKey(prefix, request)
  const hit = cache[key]
  if (hit) {
    return { score: hit.score, justification: hit.justification, cost_usd: 0 }
  }

  const llmResponse = await deps.llmClient(request)
  if (llmResponse.error) {
    return {
      score: 0,
      justification: `judge LLM error: ${llmResponse.error.kind} ${llmResponse.error.message}`,
      cost_usd: 0,
    }
  }
  const parsed = deps.parseFn(llmResponse.text)
  if (!parsed) {
    return {
      score: 0,
      justification: `judge parse failed: ${llmResponse.text.slice(0, 200)}`,
      cost_usd: 0,
    }
  }

  let cost_usd = 0
  if (
    llmResponse.raw_usage &&
    'prompt_tokens' in llmResponse.raw_usage &&
    Object.hasOwn(OPENROUTER_PRICING, request.model)
  ) {
    cost_usd = costFromUsage(request.model, llmResponse.raw_usage)
  }

  const entry: JudgeCacheEntry = {
    score: parsed.score,
    justification: parsed.justification,
    cost_usd,
    model: request.model,
    ts: new Date().toISOString(),
  }
  cache[key] = entry
  if (deps.persist !== false) {
    await saveCache(deps.cachePath, cache)
  }
  return { score: parsed.score, justification: parsed.justification, cost_usd }
}
