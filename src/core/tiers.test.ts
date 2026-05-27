import { describe, expect, test } from 'vitest'
import { tierize } from './tiers.js'
import type { Message, Tier2 } from './types.js'

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

  test('never splits a tool_use from its tool_result across token-budget boundary', () => {
    // Heavy filler so token-budget walk stops mid-history. tool_use placed
    // before the natural cut, tool_result after — window expansion must pull
    // tool_use back in so the atomic pair stays together (§5.1).
    const tu = useMsg('tu_x', 1)
    const tr = resultMsg('tu_x', 1)
    const heavy = (i: number): Message => asstMsg('h'.repeat(400), i) // ~100 tok each
    const history: Message[] = [
      sysMsg,
      userMsg('start', 0),
      heavy(0), // remaining[0]
      tu, //       remaining[1]  ← tool_use (before natural budget cut)
      heavy(2), // remaining[2]
      heavy(3), // remaining[3]
      heavy(4), // remaining[4]
      heavy(5), // remaining[5]
      heavy(6), // remaining[6]
      tr, //       remaining[7]  ← tool_result (after budget cut)
      heavy(8), // remaining[8]
      heavy(9), // remaining[9]
    ]
    // budget=400 fits ~4 heavy messages from tail; natural cut would land
    // around remaining[6], leaving tr inside the window but tu outside.
    const { tier3 } = tierize(history, { tier3TokenBudget: 400 })
    expect(tier3.recent).toContain(tu)
    expect(tier3.recent).toContain(tr)
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

  test('Tier-3 grows until token budget reached — no message-count floor', () => {
    // 30 tiny messages, large budget → all included.
    const history: Message[] = [sysMsg, userMsg('start', 0)]
    for (let i = 0; i < 30; i++) history.push(asstMsg(`tiny-${String(i)}`, i))
    const { tier3 } = tierize(history, { tier3TokenBudget: 100_000 })
    expect(tier3.recent.length).toBe(30)
  })

  test('Tier-3 walk stops once budget is met — no K_RECENT lower bound', () => {
    const heavy = 'x'.repeat(4000) // ~1000 tokens by chars/4
    const history: Message[] = [sysMsg, userMsg('start', 0)]
    for (let i = 0; i < 30; i++) history.push(asstMsg(`${heavy}${String(i)}`, i))
    const { tier3 } = tierize(history, { tier3TokenBudget: 5000 })
    // budget=5000 fits ~5 messages (each ~1000 tokens). K_RECENT removal means
    // the walk stops as soon as tokens >= budget — no padding to a message floor.
    expect(tier3.recent.length).toBeLessThanOrEqual(6)
    expect(tier3.recent.length).toBeGreaterThanOrEqual(5)
  })

  test('atomic tool_use/tool_result pair pulled in past token budget — §5.1', () => {
    const tu = useMsg('tu_pair', 0)
    const tr = resultMsg('tu_pair', 0)
    const heavy = (i: number): Message => asstMsg('x'.repeat(2000), i) // ~500 tok
    const history: Message[] = [
      sysMsg,
      userMsg('start', 0),
      tu, // remaining[0]
      asstMsg('mid', 0), // remaining[1]
      heavy(1), // remaining[2]
      heavy(2), // remaining[3]
      heavy(3), // remaining[4]
      heavy(4), // remaining[5]
      heavy(5), // remaining[6]
      heavy(6), // remaining[7]
      tr, // remaining[8] ← orphan tool_result
      asstMsg('tail', 7), // remaining[9]
    ]
    const { tier3 } = tierize(history, { tier3TokenBudget: 3000 })
    expect(tier3.recent).toContain(tu)
    expect(tier3.recent).toContain(tr)
  })

  test('observer-absent path (UI) uses the same token-budget cap — single source of truth', () => {
    // Post-K_RECENT-removal: no canRunObserver knob. Whether the caller wires
    // an observer or not, Tier-3 walks to the same token budget. Without an
    // observer, the budget becomes the hard cap (FIFO by tokens).
    const heavy = 'x'.repeat(4000) // ~1000 tok each
    const history: Message[] = [sysMsg, userMsg('start', 0)]
    for (let i = 0; i < 30; i++) history.push(asstMsg(`${heavy}${String(i)}`, i))
    const { tier3 } = tierize(history, { tier3TokenBudget: 3000 })
    expect(tier3.recent.length).toBeLessThanOrEqual(4)
    expect(tier3.recent.length).toBeGreaterThanOrEqual(3)
  })

  test('honors previousTier2 — returned tier2 carries forward observations and pointers', () => {
    const history: Message[] = [sysMsg, userMsg('q1', 0), asstMsg('a1', 0), userMsg('q2', 1)]
    const previousTier2: Tier2 = {
      observations: [
        {
          timestamp: 1,
          confidence: 'high',
          statement: 'user prefers concise responses',
          sourceTurn: 0,
        },
      ],
      pointers: [
        {
          recall_id: 'ptr_1',
          tool_name: 'search',
          original_size_bytes: 1024,
          digest: 'abc123',
          turn_index: 0,
        },
      ],
      classSignal: { class: 'mixed', confidence: 0.5, updatedAt: 3 },
    }
    const { tier2 } = tierize(history, { previousTier2 })
    expect(tier2.observations).toEqual(previousTier2.observations)
    expect(tier2.pointers).toEqual(previousTier2.pointers)
    expect(tier2.classSignal).toEqual(previousTier2.classSignal)
  })

  // 2026-05-27: tier-3 watermark prevents observer from re-firing every turn.
  // Without filtering by lastObservedTurn, tierize re-built Tier-3 from full
  // history each turn → observer always saw ≥threshold tokens → fired every
  // turn (82 fires on 3 lme-mt tasks before fix). With watermark, Tier-3
  // contains only post-watermark messages and grows incrementally.
  describe('lastObservedTurn watermark', () => {
    // Sentinel "no cap" budget — large enough that no test message is ever
    // budget-trimmed. NOT tied to any production threshold; if defaults
    // (TIER3_TOKEN_BUDGET=30000) shift, this value stays the same.
    const NO_BUDGET_CAP = Number.MAX_SAFE_INTEGER

    test('excludes messages with turn_index ≤ lastObservedTurn from Tier-3', () => {
      const history: Message[] = [sysMsg, userMsg('q', 0)]
      for (let t = 1; t <= 10; t++) {
        history.push(userMsg(`session ${String(t)}`, t), asstMsg(`reply ${String(t)}`, t))
      }
      const watermark = 5 // arbitrary mid-range turn; test asserts the filter, not the value
      const { tier3 } = tierize(history, {
        tier3TokenBudget: NO_BUDGET_CAP,
        lastObservedTurn: watermark,
      })
      // Only messages with turn_index > watermark should be in Tier-3.
      for (const m of tier3.recent) {
        expect(m.metadata?.turn_index).toBeGreaterThan(watermark)
      }
      // Sessions 6-10 (5 turns × 2 messages each) = 10 messages in Tier-3.
      expect(tier3.recent).toHaveLength(10)
    })

    test('lastObservedTurn=-1 / undefined includes all messages (backward compat)', () => {
      const history: Message[] = [sysMsg, userMsg('q', 0)]
      for (let t = 1; t <= 5; t++) {
        history.push(userMsg(`session ${String(t)}`, t), asstMsg(`reply ${String(t)}`, t))
      }
      const noWatermark = tierize(history, { tier3TokenBudget: NO_BUDGET_CAP })
      const explicitNegative = tierize(history, {
        tier3TokenBudget: NO_BUDGET_CAP,
        lastObservedTurn: -1,
      })
      expect(noWatermark.tier3.recent.length).toBe(10) // all 5 turns × 2 messages
      expect(explicitNegative.tier3.recent.length).toBe(10)
    })

    test('messages without metadata.turn_index are treated as new (synthetic test compat)', () => {
      // Core-only synthetic tests build messages without metadata. Watermark
      // filter must include them unconditionally regardless of how high the
      // watermark is set.
      const noMetaMsg: Message = {
        role: 'user',
        content: [{ type: 'text', text: 'no metadata content' }],
      }
      const history: Message[] = [sysMsg, userMsg('q', 0), noMetaMsg]
      const { tier3 } = tierize(history, {
        tier3TokenBudget: NO_BUDGET_CAP,
        lastObservedTurn: Number.MAX_SAFE_INTEGER, // would exclude everything with metadata
      })
      // The no-metadata message survives the filter (no turn_index hook to compare against).
      expect(tier3.recent).toContain(noMetaMsg)
    })
  })
})
