import {
  createInMemoryScratchpad,
  type Scratchpad,
} from '../core/index.js'
import type { AtomicGroup } from '../core/index.js'

const DEFAULT_TTL_MS = 60 * 60 * 1000 // 1h per decisions.md 2026-05-13 persistence policy

export type SessionId = string

export type SessionScratchpadRegistryOptions = {
  ttlMs?: number
}

type Entry = {
  scratchpad: Scratchpad<AtomicGroup>
  lastAccess: number
}

export class SessionScratchpadRegistry {
  private readonly map = new Map<SessionId, Entry>()
  private readonly ttlMs: number

  constructor(opts: SessionScratchpadRegistryOptions = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS
  }

  get(sessionId: SessionId, now: number = Date.now()): Scratchpad<AtomicGroup> {
    const existing = this.map.get(sessionId)
    if (existing) {
      existing.lastAccess = now
      return existing.scratchpad
    }
    const scratchpad = createInMemoryScratchpad<AtomicGroup>()
    this.map.set(sessionId, { scratchpad, lastAccess: now })
    return scratchpad
  }

  evictIdle(now: number = Date.now()): number {
    let count = 0
    for (const [id, entry] of this.map) {
      if (now - entry.lastAccess > this.ttlMs) {
        this.map.delete(id)
        count++
      }
    }
    return count
  }

  size(): number {
    return this.map.size
  }
}
