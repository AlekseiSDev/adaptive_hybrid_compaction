import { createHash } from 'node:crypto'
import type { LLMCaller } from './llm.js'
import { maybeExtractObservations, type ObserverDeps } from './observer.js'
import { canonicalJSON } from './serializeForCache.js'
import { charsOver4TokenCounter, type TokenCounter } from './tokenCounter.js'
import type { CompactionContext, Message, Observation, Tier2, Tier3 } from './types.js'

const IDLE_THRESHOLD_MS = 5 * 60 * 1000
const BLOCK_AFTER_MULTIPLIER = 1.2

export type PreparedCompaction = {
  extracted: Observation[]
  clippedTier3: Message[]
  forTier3Hash: string
  preparedAt: number
}

export type PreCompactDeps = {
  tokenCounter: TokenCounter
  currentQuery: string
  llmCaller?: LLMCaller
  now?: () => number
}

export class AsyncBuffer {
  private prepared: PreparedCompaction | null = null
  private inflight: Promise<void> | null = null

  hashTier3(tier3: Tier3): string {
    const payload = {
      recent: tier3.recent,
      inflight: tier3.inflight.map((i) => ({ group_id: i.group_id, turn_index: i.turn_index })),
    }
    return createHash('sha256').update(canonicalJSON(payload)).digest('hex').slice(0, 16)
  }

  async pre_compact(
    tier3: Tier3,
    tier2: Tier2,
    ctx: CompactionContext,
    deps: PreCompactDeps,
  ): Promise<void> {
    if (this.prepared !== null) return
    if (this.inflight !== null) {
      await this.inflight
      return
    }
    const targetHash = this.hashTier3(tier3)
    this.inflight = (async () => {
      const observerDeps: ObserverDeps = {
        tokenCounter: deps.tokenCounter,
        currentQuery: deps.currentQuery,
        ...(deps.llmCaller !== undefined ? { llmCaller: deps.llmCaller } : {}),
      }
      const result = await maybeExtractObservations(tier3, tier2, ctx, observerDeps)
      if (result.ran) {
        const now = deps.now ?? Date.now
        this.prepared = {
          extracted: result.extracted,
          clippedTier3: result.clippedTier3,
          forTier3Hash: targetHash,
          preparedAt: now(),
        }
      }
    })()
    try {
      await this.inflight
    } finally {
      this.inflight = null
    }
  }

  consume(currentTier3Hash: string): PreparedCompaction | null {
    const out = this.prepared
    this.prepared = null
    if (out === null) return null
    if (out.forTier3Hash !== currentTier3Hash) return null
    return out
  }

  invalidate(): void {
    this.prepared = null
  }

  activateAfterIdle(idleMs: number, thresholdMs: number = IDLE_THRESHOLD_MS): boolean {
    return idleMs > thresholdMs
  }

  blockAfter(tier3: Tier3, tokenCounter: TokenCounter, observerThreshold: number): boolean {
    const limit = BLOCK_AFTER_MULTIPLIER * observerThreshold
    let used = 0
    for (const m of tier3.recent) {
      used += tokenCounter(JSON.stringify(m.content))
      if (used > limit) return true
    }
    return false
  }
}

export const DEFAULT_TOKEN_COUNTER: TokenCounter = charsOver4TokenCounter
