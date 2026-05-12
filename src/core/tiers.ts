import { parseAtomicGroups } from './atomicGroup.js'
import { defaultThresholds } from './thresholds.js'
import type { Message, Tier1, Tier2, Tier3 } from './types.js'

export type TierizeResult = {
  tier1: Tier1
  tier2: Tier2
  tier3: Tier3
}

export type TierizeOptions = {
  kRecent?: number
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
  const startIndex = expandWindowForAtomicPairs(remaining, kRecent)
  const recent = remaining.slice(startIndex)

  const { inflight } = parseAtomicGroups(recent)

  const tier2: Tier2 = {
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

// Default window is "last K". Expand backward if any tool_result in the window
// has its matching tool_use outside — atomic pairs must not split across the
// Tier-2/Tier-3 boundary (§5.1 atomicity invariant).
function expandWindowForAtomicPairs(remaining: Message[], kRecent: number): number {
  let startIndex = Math.max(0, remaining.length - kRecent)
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
