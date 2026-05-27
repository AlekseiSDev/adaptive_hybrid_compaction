import { parseAtomicGroups } from './atomicGroup.js'
import { OBSERVER_PROMPT_TEMPLATE, parseObservations } from './observerPrompt.js'
import { charsOver4TokenCounter, type TokenCounter } from './tokenCounter.js'
import type { LLMCaller, LLMRequest, LLMResponse } from './llm.js'
import type { CompactionContext, Message, Observation, Tier2 } from './types.js'

const PREV_OBS_WINDOW_TOKENS = 4000

export type ObserverTier3 = {
  recent: Message[]
  inflight: Message[]
} | {
  recent: Message[]
  inflight: { tool_use: Message }[]
}

export type ClipOptions = {
  targetTokens: number
  tokenCounter?: TokenCounter
}

function messageTokens(message: Message, counter: TokenCounter): number {
  return counter(JSON.stringify(message.content))
}

function totalTokens(messages: readonly Message[], counter: TokenCounter): number {
  let sum = 0
  for (const m of messages) sum += messageTokens(m, counter)
  return sum
}

export function clipTier3KeepingTail(
  recent: Message[],
  opts: ClipOptions,
): Message[] {
  const counter = opts.tokenCounter ?? charsOver4TokenCounter
  if (totalTokens(recent, counter) <= opts.targetTokens) return recent

  // Walk from tail, accumulating until budget would be exceeded.
  let used = 0
  let startIndex = recent.length
  for (let i = recent.length - 1; i >= 0; i--) {
    const msg = recent[i]
    if (msg === undefined) continue
    const cost = messageTokens(msg, counter)
    if (used + cost > opts.targetTokens && startIndex < recent.length) break
    used += cost
    startIndex = i
  }

  // Expand backward to never split atomic pair / never trim inflight tool_use.
  const parsedAll = parseAtomicGroups(recent)
  const groupByToolUse = new Map<Message, Message>()
  for (const group of parsedAll.groups) {
    groupByToolUse.set(group.tool_result, group.tool_use)
  }
  const inflightToolUses = new Set(parsedAll.inflight.map((i) => i.tool_use))

  // If the kept window starts mid-pair (tool_result in kept range, tool_use earlier), extend.
  for (let i = startIndex; i < recent.length; i++) {
    const msg = recent[i]
    if (msg === undefined) continue
    const matchingUse = groupByToolUse.get(msg)
    if (matchingUse !== undefined) {
      const useIdx = recent.indexOf(matchingUse)
      if (useIdx >= 0 && useIdx < startIndex) startIndex = useIdx
    }
  }
  // Ensure every inflight tool_use stays in the kept window.
  for (const use of inflightToolUses) {
    const useIdx = recent.indexOf(use)
    if (useIdx >= 0 && useIdx < startIndex) startIndex = useIdx
  }

  return recent.slice(startIndex)
}

export type ObserverReason =
  | 'below_threshold'
  | 'no_llm_caller'
  | 'parse_error'
  // Throttle path: enough new tokens haven't accumulated since last fire.
  // Prevents re-extraction of essentially the same Tier-3 content turn
  // after turn (see decisions.md [2026-05-27] observer fire throttle).
  | 'delta_too_small'

export type ObserverResult = {
  ran: boolean
  extracted: Observation[]
  clippedTier3: Message[]
  reason?: ObserverReason
  // Captured only when parseObservations silently returned [] — diagnostic for
  // prompt/parser format-drift investigation. Empty when the observer extracted
  // anything successfully; absent on threshold/no-caller short-circuits.
  rawText?: string
}

export type ObserverDeps = {
  tokenCounter: TokenCounter
  currentQuery: string
  llmCaller?: LLMCaller
  // Watermark source for the fire-throttle (decisions.md [2026-05-27]).
  // When provided, observations get `sourceTurn = currentTurnIndex`, and the
  // throttle skips re-firing within `minTurnsBetween` of the last extraction.
  // Adapter (`compact.ts`) passes the turn index it already computes; when
  // absent (offline core tests), throttle is inactive on first-ever fire and
  // falls back to `deriveSourceTurn(tier3)` for sourceTurn.
  currentTurnIndex?: number
}

type Tier3Like = { recent: Message[] }

// Render an Observation's stored numeric timestamp back to the ISO date shape
// the prompt asks the LLM to emit. Keeps the in-prompt previous-observations
// listing consistent with the OUTPUT FORMAT spec — otherwise the LLM sees raw
// integers (e.g. `1701302400`) in prior obs and mirrors that opaque shape.
// Heuristic: <=10-digit → seconds, longer → ms; anything that doesn't yield a
// valid Date falls back to raw `String(n)` (e.g. small synthetic test values).
function formatTimestampForPrompt(n: number): string {
  const ms = n < 1e12 ? n * 1000 : n
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return String(n)
  const iso = d.toISOString().slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return String(n)
  return iso
}

function buildLLMRequest(
  recent: readonly Message[],
  tier2: Tier2,
  query: string,
  tokenCounter: TokenCounter,
): LLMRequest {
  const tier3Snapshot = recent
    .map((m) => `${m.role}: ${JSON.stringify(m.content)}`)
    .join('\n')
  const prevObsAll = tier2.observations
    .map((o) => `- ${formatTimestampForPrompt(o.timestamp)} (${o.confidence}) ${o.statement}`)
    .join('\n')
  const prevObsWindow = (() => {
    let used = 0
    const lines = prevObsAll.split('\n')
    const kept: string[] = []
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]
      if (line === undefined) continue
      const cost = tokenCounter(line)
      if (used + cost > PREV_OBS_WINDOW_TOKENS) break
      kept.unshift(line)
      used += cost
    }
    return kept.join('\n')
  })()

  return {
    messages: [
      { role: 'system', content: OBSERVER_PROMPT_TEMPLATE },
      {
        role: 'user',
        content: `Recent messages:\n${tier3Snapshot}\n\nCurrent user query: ${query}\n\nPrevious observations:\n${prevObsWindow}`,
      },
    ],
  }
}

function deriveSourceTurn(tier3: Tier3Like): number {
  for (let i = tier3.recent.length - 1; i >= 0; i--) {
    const msg = tier3.recent[i]
    if (msg?.metadata !== undefined) return msg.metadata.turn_index
  }
  return 0
}

function applyExtraction(
  tier3: Tier3Like,
  ctx: CompactionContext,
  raw: string,
  deps: ObserverDeps,
): ObserverResult {
  const sourceTurn = deps.currentTurnIndex ?? deriveSourceTurn(tier3)
  let extracted: Observation[]
  try {
    extracted = parseObservations(raw, sourceTurn)
  } catch {
    return {
      ran: false,
      extracted: [],
      clippedTier3: tier3.recent,
      reason: 'parse_error',
    }
  }
  const clipped = clipTier3KeepingTail(tier3.recent, {
    targetTokens: 0.2 * ctx.thresholds.OBSERVER_THRESHOLD,
    tokenCounter: deps.tokenCounter,
  })
  return {
    ran: true,
    extracted,
    clippedTier3: clipped,
    ...(extracted.length === 0 ? { rawText: raw } : {}),
  }
}

// Watermark-based observer scoping — extracted from `tier2.observations[].sourceTurn`.
// Solves the dual problem found 2026-05-27:
//   (1) Without scoping, observer LLM saw the full Tier-3 every turn (≤64k);
//       LLM tends to summarise the LATEST messages and skip the older ones,
//       so content from skipped turns silently dropped. Aggregate cost: 72%
//       observer overhead, plus regressions on questions about mid-window
//       content.
//   (2) A naive count-throttle (skip N turns between fires) made it worse —
//       sessions arriving between fires never got into Tier-2 at all (the
//       LLM still ignored them on the next fire because it focused on the
//       latest tail).
// Fix: each fire sees ONLY messages with metadata.turn_index > lastObservedTurn.
// Smaller observer prompt (one batch of new sessions, not full window),
// nothing is missed, no count-based skip needed. Fall back to fire-the-whole-
// thing when metadata is absent (synthetic tests) so existing core tests
// keep their semantics.
function computeLastObservedTurn(tier2: Tier2): number {
  let last = -1
  for (const o of tier2.observations) {
    if (o.sourceTurn > last) last = o.sourceTurn
  }
  return last
}

function filterNewMessages(
  messages: readonly Message[],
  lastObservedTurn: number,
): Message[] {
  if (lastObservedTurn < 0) return [...messages]
  const out: Message[] = []
  for (const m of messages) {
    // Messages without metadata treated as "new" — preserves existing core
    // test semantics where synthetic Tier-3 has no turn_index hooks.
    const ti = m.metadata?.turn_index
    if (ti === undefined || ti > lastObservedTurn) out.push(m)
  }
  return out
}

// Fire-floor 2026-05-27 v2: skip only when there's truly no new content.
// Earlier attempt batched 0.1×OBSERVER_THRESHOLD before firing — but LLM
// observer turned out to be MYOPIC (focuses on the tail of its input even
// when the input is a 10-session batch), so old-end sessions in each batch
// were silently dropped. Smaller batches keep more sessions in the LLM's
// attention window. With OBSERVER_THRESHOLD=64k on lme-mt, this means
// firing roughly every turn on a ~2.6k single-session window — each fire
// is cheap (~$0.007) and no session is skipped. Total observer overhead
// halves vs. the count-throttle attempt while preserving content coverage.
const NEW_TOKENS_FIRE_FLOOR = 1

function throttleResult(
  tier3: Tier3Like,
  ctx: CompactionContext,
  tokenCounter: TokenCounter,
): ObserverResult {
  // Even when we skip the LLM call, clip Tier-3 so the actor still sees the
  // compacted tail — otherwise throttle would inflate per-turn actor input
  // (tierize re-fills to threshold every turn from full history).
  const clipped = clipTier3KeepingTail(tier3.recent, {
    targetTokens: 0.2 * ctx.thresholds.OBSERVER_THRESHOLD,
    tokenCounter,
  })
  return { ran: false, extracted: [], clippedTier3: clipped, reason: 'delta_too_small' }
}

export async function maybeExtractObservations(
  tier3: Tier3Like,
  tier2: Tier2,
  ctx: CompactionContext,
  deps: ObserverDeps,
): Promise<ObserverResult> {
  const tokens = totalTokens(tier3.recent, deps.tokenCounter)
  if (tokens < ctx.thresholds.OBSERVER_THRESHOLD) {
    return { ran: false, extracted: [], clippedTier3: tier3.recent, reason: 'below_threshold' }
  }
  if (deps.llmCaller === undefined) {
    return { ran: false, extracted: [], clippedTier3: tier3.recent, reason: 'no_llm_caller' }
  }
  const lastObservedTurn = computeLastObservedTurn(tier2)
  const newMessages = filterNewMessages(tier3.recent, lastObservedTurn)
  const newTokens = totalTokens(newMessages, deps.tokenCounter)
  if (newTokens < NEW_TOKENS_FIRE_FLOOR) {
    return throttleResult(tier3, ctx, deps.tokenCounter)
  }
  const request = buildLLMRequest(newMessages, tier2, deps.currentQuery, deps.tokenCounter)
  const response = await deps.llmCaller(request)
  return applyExtraction(tier3, ctx, response.text, deps)
}

export type SyncLLMCaller = (req: LLMRequest) => LLMResponse

export type ObserverDepsSync = {
  tokenCounter: TokenCounter
  currentQuery: string
  syncLLMCaller?: SyncLLMCaller
  // Mirror of ObserverDeps.currentTurnIndex for the sync path. Same throttle
  // semantics; see ObserverDeps for the contract.
  currentTurnIndex?: number
}

export function extractObservationsSync(
  tier3: Tier3Like,
  tier2: Tier2,
  ctx: CompactionContext,
  deps: ObserverDepsSync,
): ObserverResult {
  const tokens = totalTokens(tier3.recent, deps.tokenCounter)
  if (tokens < ctx.thresholds.OBSERVER_THRESHOLD) {
    return { ran: false, extracted: [], clippedTier3: tier3.recent, reason: 'below_threshold' }
  }
  if (deps.syncLLMCaller === undefined) {
    return { ran: false, extracted: [], clippedTier3: tier3.recent, reason: 'no_llm_caller' }
  }
  const lastObservedTurn = computeLastObservedTurn(tier2)
  const newMessages = filterNewMessages(tier3.recent, lastObservedTurn)
  const newTokens = totalTokens(newMessages, deps.tokenCounter)
  if (newTokens < NEW_TOKENS_FIRE_FLOOR) {
    return throttleResult(tier3, ctx, deps.tokenCounter)
  }
  const request = buildLLMRequest(newMessages, tier2, deps.currentQuery, deps.tokenCounter)
  const response = deps.syncLLMCaller(request)
  return applyExtraction(tier3, ctx, response.text, {
    tokenCounter: deps.tokenCounter,
    currentQuery: deps.currentQuery,
    ...(deps.currentTurnIndex !== undefined ? { currentTurnIndex: deps.currentTurnIndex } : {}),
  })
}
