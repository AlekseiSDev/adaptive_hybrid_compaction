// Cache invariance contract §9.1 — A1-scoped structural variant.
//
// Full bytewise check requires `serializeForCache()` (A2). Until then we use
// canonical JSON.stringify as a proxy: equal stringification ⇒ equal payload
// shape, which is the contract A1 can honor (no compact(), no offloader yet).
// See `docs/decisions.md` for the rationale + A2 follow-up.
import { describe, expect, test } from 'vitest'
import { tierize } from './tiers.js'
import type { Message } from './types.js'

const sysMsg: Message = { role: 'system', content: [{ type: 'text', text: 'be helpful' }] }
const userMsg = (s: string, turn: number): Message => ({
  role: 'user',
  content: [{ type: 'text', text: s }],
  metadata: { turn_index: turn, step_index: 0 },
})
const asstMsg = (s: string, turn: number): Message => ({
  role: 'assistant',
  content: [{ type: 'text', text: s }],
  metadata: { turn_index: turn, step_index: 0 },
})

const baseHistory: Message[] = [
  sysMsg,
  userMsg('first q', 0),
  asstMsg('first a', 0),
  userMsg('second q', 1),
  asstMsg('second a', 1),
]

const extendedHistory: Message[] = [
  ...baseHistory,
  userMsg('third q', 2),
  asstMsg('third a', 2),
]

describe('Cache invariance (§9.1) — structural A1 variant', () => {
  test('Tier-1 is bytewise-stable across consecutive turns sharing a prefix', () => {
    const turnI = tierize(baseHistory)
    const turnIPlus1 = tierize(extendedHistory)
    expect(JSON.stringify(turnIPlus1.tier1)).toBe(JSON.stringify(turnI.tier1))
  })

  test('Tier-2 is append-only — empty in A1, trivially stable', () => {
    const turnI = tierize(baseHistory)
    const turnIPlus1 = tierize(extendedHistory)
    expect(turnI.tier2.observations).toHaveLength(0)
    expect(turnI.tier2.pointers).toHaveLength(0)
    expect(turnIPlus1.tier2.observations).toHaveLength(0)
    expect(turnIPlus1.tier2.pointers).toHaveLength(0)
    expect(JSON.stringify(turnIPlus1.tier2)).toBe(JSON.stringify(turnI.tier2))
  })
})
