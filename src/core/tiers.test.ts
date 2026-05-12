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
const useMsg = (id: string, turn: number): Message => ({
  role: 'assistant',
  content: [{ type: 'tool_use', tool_use_id: id, name: 'search', input: {} }],
  metadata: { turn_index: turn, step_index: 1 },
})
const resultMsg = (id: string, turn: number): Message => ({
  role: 'tool',
  content: [{ type: 'tool_result', tool_use_id: id, output: { ok: true } }],
  metadata: { turn_index: turn, step_index: 2 },
})

describe('tierize', () => {
  test('extracts systemPrompt and firstUserMessage into Tier-1', () => {
    const history: Message[] = [
      sysMsg,
      userMsg('q1', 0),
      asstMsg('a1', 0),
      userMsg('q2', 1),
      asstMsg('a2', 1),
    ]
    const { tier1, tier2, tier3 } = tierize(history)
    expect(tier1.systemPrompt).toBe(sysMsg)
    expect(tier1.firstUserMessages).toHaveLength(1)
    expect(tier1.firstUserMessages[0]).toBe(history[1])
    expect(tier1.toolDefinitions).toEqual([])
    expect(tier2.observations).toEqual([])
    expect(tier2.pointers).toEqual([])
    expect(tier2.classSignal).toEqual({ class: 'mixed', confidence: 0, updatedAt: 0 })
    expect(tier3.recent).toEqual([history[2], history[3], history[4]])
  })

  test('never splits a tool_use from its tool_result across K_RECENT boundary', () => {
    // 10 messages after Tier-1; default K=6 → window covers indices 4..9.
    // Put a tool_use at index 1 of remaining and its tool_result at index 7 — far apart.
    // Window expansion must pull index 1 in so the pair stays together.
    const tu = useMsg('tu_x', 1)
    const tr = resultMsg('tu_x', 1)
    const filler = (i: number): Message => asstMsg(`filler-${String(i)}`, i)
    const history: Message[] = [
      sysMsg,
      userMsg('start', 0),
      filler(0), // remaining[0]
      tu, //         remaining[1]  ← tool_use
      filler(2), // remaining[2]
      filler(3), // remaining[3]
      filler(4), // remaining[4]
      filler(5), // remaining[5]
      filler(6), // remaining[6]
      tr, //         remaining[7]  ← tool_result
      filler(8), // remaining[8]
      filler(9), // remaining[9]
    ]
    const { tier3 } = tierize(history, { kRecent: 6 })
    // Window must include both tu and tr
    expect(tier3.recent).toContain(tu)
    expect(tier3.recent).toContain(tr)
    // And no atomic pair leaks: parseAtomicGroups inside tierize → no inflight here
    expect(tier3.inflight).toHaveLength(0)
  })

  test('populates Tier-3.inflight when tool_use lacks tool_result', () => {
    const tu = useMsg('tu_pending', 1)
    const history: Message[] = [
      sysMsg,
      userMsg('start', 0),
      asstMsg('thinking', 1),
      tu,
    ]
    const { tier3 } = tierize(history)
    expect(tier3.inflight).toHaveLength(1)
    expect(tier3.inflight[0]?.tool_use).toBe(tu)
    expect(tier3.inflight[0]?.turn_index).toBe(1)
  })

  test('is deterministic — repeated calls produce identical JSON', () => {
    const history: Message[] = [
      sysMsg,
      userMsg('q1', 0),
      asstMsg('a1', 0),
      useMsg('tu_1', 1),
      resultMsg('tu_1', 1),
      asstMsg('a2', 1),
    ]
    const a = tierize(history)
    const b = tierize(history)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  test('throws when no system message present', () => {
    const history: Message[] = [userMsg('q', 0)]
    expect(() => tierize(history)).toThrow(/system message/)
  })

  test('throws when no user message present', () => {
    const history: Message[] = [sysMsg]
    expect(() => tierize(history)).toThrow(/user message/)
  })
})
