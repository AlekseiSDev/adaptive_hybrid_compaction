import { parseAtomicGroups } from './atomicGroup.js'
import { defaultThresholds } from './thresholds.js'
import { charsOver4TokenCounter, messageTokens, type TokenCounter } from './tokenCounter.js'
import type { Message, Tier1, Tier2, Tier3 } from './types.js'

export type TierizeResult = {
  tier1: Tier1
  tier2: Tier2
  tier3: Tier3
}

export type TierizeOptions = {
  // Adapter-level Tier-2 persistence (A_ahc-algorithm §2.1): when the caller
  // (middleware) tracks Tier-2 across LLM calls, it threads the prior turn's
  // newTier2 back in so observations/pointers accumulate. Without it tierize
  // returns an empty Tier-2 — used by tests and offline core paths.
  previousTier2?: Tier2
  // Upper bound (tokens) on Tier-3.recent. tierize walks from tail accumulating
  // tokens until budget is reached. Single source of truth for Tier-3 sizing
  // (K_RECENT dropped 2026-05-26 — TIER3_TOKEN_BUDGET subsumes its role).
  // When observer is wired, it will clip Tier-3 if it overflows
  // OBSERVER_THRESHOLD; when observer is absent (UI path), this budget is the
  // hard cap (oldest messages dropped, FIFO by tokens).
  tier3TokenBudget?: number
  // Watermark for Tier-3 inclusion (2026-05-27 fire-on-threshold fix):
  // messages with `metadata.turn_index <= lastObservedTurn` are considered
  // already-observed and excluded from Tier-3 candidates BEFORE the token
  // budget walk. After an observer fire watermark advances, so next-turn
  // tierize sees only fresh unobserved sessions — Tier-3 grows incrementally
  // and re-crosses OBSERVER_THRESHOLD once per "round". Without the watermark,
  // tierize re-tierizes from full history every turn, observer always sees
  // ≥threshold tokens, fires every turn — 82 fires on 3 lme-mt tasks
  // (see decisions.md [2026-05-27] tier-3 watermark).
  //
  // Messages without `metadata.turn_index` are treated as new (no filter)
  // — preserves core-only synthetic test semantics where messages don't
  // carry the metadata hook.
  //
  // Atomic-pair expansion still applies AFTER watermark filter, so a
  // tool_result whose tool_use is older than the watermark still pulls its
  // pair back into the window (atomicity invariant per §5.1).
  lastObservedTurn?: number
  tokenCounter?: TokenCounter
}

export function tierize(history: Message[], opts: TierizeOptions = {}): TierizeResult {
  const systemMessages = history.filter((m) => m.role === 'system')
  if (systemMessages.length !== 1) {
    throw new Error(
      `tierize: expected exactly one system message, found ${String(systemMessages.length)}`,
    )
  }
  const [systemPrompt] = systemMessages
  if (systemPrompt === undefined) {
    throw new Error('tierize: system message lookup invariant violated')
  }

  const firstUser = history.find((m) => m.role === 'user')
  if (firstUser === undefined) {
    throw new Error('tierize: at least one user message required')
  }

  const tier1: Tier1 = {
    systemPrompt,
    toolDefinitions: [],
    firstUserMessages: [firstUser],
  }

  const remaining = history.filter((m) => m !== systemPrompt && m !== firstUser)
  const watermarked = applyObservedWatermark(remaining, opts.lastObservedTurn)
  const seedIndex = computeSeedIndex(watermarked, opts)
  const startIndex = expandWindowForAtomicPairs(watermarked, seedIndex)
  const recent = watermarked.slice(startIndex)

  const { inflight } = parseAtomicGroups(recent)

  const tier2: Tier2 = opts.previousTier2 ?? {
    observations: [],
    pointers: [],
    classSignal: { class: 'mixed', confidence: 0, updatedAt: 0 },
  }

  const tier3: Tier3 = {
    recent,
    inflight,
  }

  return { tier1, tier2, tier3 }
}

// Exclude messages already covered by Tier-2 observations (turn_index <=
// lastObservedTurn). Messages without metadata are treated as "new" — core-
// only synthetic tests construct messages without metadata and would
// otherwise be filtered out entirely.
function applyObservedWatermark(remaining: Message[], lastObservedTurn?: number): Message[] {
  if (lastObservedTurn === undefined || lastObservedTurn < 0) return remaining
  const out: Message[] = []
  for (const m of remaining) {
    const ti = m.metadata?.turn_index
    if (ti === undefined || ti > lastObservedTurn) out.push(m)
  }
  return out
}

// Walk from tail accumulating tokens until budget is reached. Single path —
// observer-wired and observer-absent share the same logic. When observer is
// present it will further clip Tier-3 on overflow of OBSERVER_THRESHOLD.
function computeSeedIndex(remaining: Message[], opts: TierizeOptions): number {
  const budget = opts.tier3TokenBudget ?? defaultThresholds.TIER3_TOKEN_BUDGET
  const counter = opts.tokenCounter ?? charsOver4TokenCounter

  let seedIndex = remaining.length
  let tokens = 0
  for (let i = remaining.length - 1; i >= 0; i--) {
    if (tokens >= budget) break
    const msg = remaining[i]
    if (msg === undefined) continue
    tokens += messageTokens(msg, counter)
    seedIndex = i
  }
  return seedIndex
}

// Default window is the seed start index (token-budget or count-based).
// Expand backward if any tool_result in the window has its matching tool_use
// outside — atomic pairs must not split across the Tier-2/Tier-3 boundary
// (§5.1 atomicity invariant).
function expandWindowForAtomicPairs(remaining: Message[], seedStartIndex: number): number {
  let startIndex = seedStartIndex
  let changed = true
  while (changed && startIndex > 0) {
    changed = false
    const window = remaining.slice(startIndex)
    const toolUseIds = collectToolUseIds(window)
    const earliestOrphanToolUseId = findFirstOrphanToolResultId(window, toolUseIds)
    if (earliestOrphanToolUseId === undefined) break
    for (let i = startIndex - 1; i >= 0; i--) {
      const msg = remaining[i]
      if (msg !== undefined && hasToolUse(msg, earliestOrphanToolUseId)) {
        startIndex = i
        changed = true
        break
      }
    }
  }
  return startIndex
}

function collectToolUseIds(messages: Message[]): Set<string> {
  const ids = new Set<string>()
  for (const msg of messages) {
    for (const part of msg.content) {
      if (part.type === 'tool_use') ids.add(part.tool_use_id)
    }
  }
  return ids
}

function findFirstOrphanToolResultId(
  messages: Message[],
  toolUseIdsInWindow: Set<string>,
): string | undefined {
  for (const msg of messages) {
    for (const part of msg.content) {
      if (part.type === 'tool_result' && !toolUseIdsInWindow.has(part.tool_use_id)) {
        return part.tool_use_id
      }
    }
  }
  return undefined
}

function hasToolUse(message: Message, toolUseId: string): boolean {
  return message.content.some((p) => p.type === 'tool_use' && p.tool_use_id === toolUseId)
}
