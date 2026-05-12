import { describe, expect, test } from 'vitest'
import { serializeForCache, canonicalJSON } from './serializeForCache.js'
import { tierize } from './tiers.js'
import type { Message, Tier1, Tier2 } from './types.js'

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

describe('canonicalJSON', () => {
  test('produces identical strings regardless of property insertion order', () => {
    const a = { b: 1, a: 2, c: { y: 3, x: 4 } }
    const b = { c: { x: 4, y: 3 }, a: 2, b: 1 }
    expect(canonicalJSON(a)).toBe(canonicalJSON(b))
  })

  test('preserves array order (arrays are sequence-typed)', () => {
    expect(canonicalJSON([1, 2, 3])).toBe('[1,2,3]')
    expect(canonicalJSON([3, 2, 1])).toBe('[3,2,1]')
  })

  test('handles null, undefined, and primitives', () => {
    expect(canonicalJSON(null)).toBe('null')
    expect(canonicalJSON(42)).toBe('42')
    expect(canonicalJSON('s')).toBe('"s"')
    expect(canonicalJSON(true)).toBe('true')
  })
})

describe('serializeForCache', () => {
  test('returns Uint8Array with stable bytes across calls on the same input', () => {
    const { tier1, tier2 } = tierize([sysMsg, userMsg('q', 0)])
    const a = serializeForCache({ tier1, tier2 })
    const b = serializeForCache({ tier1, tier2 })
    expect(Buffer.compare(a, b)).toBe(0)
  })

  test('property-order independent: shuffled Tier-2 produces identical bytes', () => {
    const tier1: Tier1 = {
      systemPrompt: sysMsg,
      toolDefinitions: [],
      firstUserMessages: [userMsg('q', 0)],
    }
    const tier2A: Tier2 = {
      observations: [],
      pointers: [],
      classSignal: { class: 'mixed', confidence: 0, updatedAt: 0 },
    }
    const tier2B: Tier2 = {
      classSignal: { updatedAt: 0, class: 'mixed', confidence: 0 },
      pointers: [],
      observations: [],
    }
    const a = serializeForCache({ tier1, tier2: tier2A })
    const b = serializeForCache({ tier1, tier2: tier2B })
    expect(Buffer.compare(a, b)).toBe(0)
  })

  test('appending observations grows bytes only at the tail (prefix preserved)', () => {
    const tier1: Tier1 = {
      systemPrompt: sysMsg,
      toolDefinitions: [],
      firstUserMessages: [userMsg('q', 0)],
    }
    const tier2Empty: Tier2 = {
      observations: [],
      pointers: [],
      classSignal: { class: 'mixed', confidence: 0, updatedAt: 0 },
    }
    const tier2WithObs: Tier2 = {
      observations: [
        { timestamp: 1, confidence: 'high', statement: 'user likes TS', sourceTurn: 0 },
      ],
      pointers: [],
      classSignal: { class: 'mixed', confidence: 0, updatedAt: 0 },
    }
    const empty = serializeForCache({ tier1, tier2: tier2Empty })
    const withObs = serializeForCache({ tier1, tier2: tier2WithObs })
    // Both contain the same Tier-1 portion at the start; since canonicalJSON sorts keys,
    // the "tier1" field comes before "tier2" alphabetically.
    // Find where "tier2" begins; bytes before that index must match between the two.
    const text = withObs.toString('utf8')
    const tier2Marker = text.indexOf('"tier2":')
    expect(tier2Marker).toBeGreaterThan(0)
    const emptyText = empty.toString('utf8')
    expect(emptyText.slice(0, tier2Marker)).toBe(text.slice(0, tier2Marker))
  })
})

const baseHistory: Message[] = [
  sysMsg,
  userMsg('q1', 0),
  asstMsg('a1', 0),
  userMsg('q2', 1),
  asstMsg('a2', 1),
]
const extendedHistory: Message[] = [...baseHistory, userMsg('q3', 2), asstMsg('a3', 2)]

describe('serializeForCache integration with tierize', () => {
  test('Tier-1 portion is bytewise-stable across two consecutive turns', () => {
    const i = tierize(baseHistory)
    const ipp = tierize(extendedHistory)
    const a = serializeForCache({ tier1: i.tier1, tier2: i.tier2 })
    const b = serializeForCache({ tier1: ipp.tier1, tier2: ipp.tier2 })
    // Tier-2 is empty in both → full payload is byte-stable
    expect(Buffer.compare(a, b)).toBe(0)
  })
})
