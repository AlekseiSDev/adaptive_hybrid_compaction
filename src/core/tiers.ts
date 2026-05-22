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
  kRecent?: number
  // Adapter-level Tier-2 persistence (A_ahc-algorithm §2.1): when the caller
  // (middleware) tracks Tier-2 across LLM calls, it threads the prior turn's
  // newTier2 back in so observations/pointers accumulate. Without it tierize
  // returns an empty Tier-2 — used by tests and offline core paths.
  previousTier2?: Tier2
  // Upper bound (tokens) on Tier-3.recent. Tier-3 grows past K_RECENT messages
  // up to this budget. Only honored when canRunObserver === true (D5 of
  // decisions.md 2026-05-22 — without observer, Tier-3 must stay capped to
  // K_RECENT message count to avoid unbounded growth).
  kRecentTokenBudget?: number
  // Signals whether the adapter has an llmCaller wired (i.e., observer can
  // actually fire to clip Tier-3 when budget overflows). UI path passes false
  // by design (`ahc-runtime.ts:66-70`) and relies on the legacy K_RECENT cap.
  canRunObserver?: boolean
  tokenCounter?: TokenCounter
}

export function tierize(history: Message[], opts: TierizeOptions = {}): TierizeResult {
  const kRecent = opts.kRecent ?? defaultThresholds.K_RECENT

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
  const seedIndex = computeSeedIndex(remaining, kRecent, opts)
  const startIndex = expandWindowForAtomicPairs(remaining, seedIndex)
  const recent = remaining.slice(startIndex)

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

// Compute Tier-3 seed start index. Two modes:
//   - canRunObserver=true: walk from tail accumulating tokens; keep going past
//     K_RECENT messages until both kept>=kRecent AND tokens>=kRecentTokenBudget
//     (observer will clip if/when Tier-3 crosses OBSERVER_THRESHOLD).
//   - canRunObserver=false: legacy fixed K_RECENT message-count cap. Without an
//     observer there's nothing to clip Tier-3 back, so we must not let it grow
//     past K_RECENT (D5 of decisions.md 2026-05-22).
function computeSeedIndex(
  remaining: Message[],
  kRecent: number,
  opts: TierizeOptions,
): number {
  if (opts.canRunObserver !== true) {
    return Math.max(0, remaining.length - kRecent)
  }
  const budget = opts.kRecentTokenBudget ?? defaultThresholds.TIER3_TOKEN_BUDGET
  const counter = opts.tokenCounter ?? charsOver4TokenCounter

  let seedIndex = remaining.length
  let kept = 0
  let tokens = 0
  for (let i = remaining.length - 1; i >= 0; i--) {
    if (kept >= kRecent && tokens >= budget) break
    const msg = remaining[i]
    if (msg === undefined) continue
    tokens += messageTokens(msg, counter)
    kept += 1
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
