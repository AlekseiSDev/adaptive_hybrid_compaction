import { describe, expect, test, vi } from 'vitest'
import {
  clipTier3KeepingTail,
  maybeExtractObservations,
  extractObservationsSync,
} from './observer.js'
import { defaultFeatureFlags } from './featureFlags.js'
import { defaultThresholds } from './thresholds.js'
import { charsOver4TokenCounter } from './tokenCounter.js'
import { serializeForCache } from './serializeForCache.js'
import type { LLMCaller } from './llm.js'
import type { CompactionContext, Message, Observation, Tier2 } from './types.js'

const userMsg = (s: string, turn: number, step = 0): Message => ({
  role: 'user',
  content: [{ type: 'text', text: s }],
  metadata: { turn_index: turn, step_index: step },
})
const asstMsg = (s: string, turn: number, step = 0): Message => ({
  role: 'assistant',
  content: [{ type: 'text', text: s }],
  metadata: { turn_index: turn, step_index: step },
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

const emptyTier2 = (): Tier2 => ({
  observations: [],
  pointers: [],
  classSignal: { class: 'mixed', confidence: 0, updatedAt: 0 },
})

const ctxFor = (overrides: Partial<CompactionContext> = {}): CompactionContext => ({
  flags: defaultFeatureFlags,
  groups_after_this: 0,
  cumulative_kept_tool_result_bytes: 0,
  current_class: 'conversational',
  thresholds: defaultThresholds,
  ...overrides,
})

describe('clipTier3KeepingTail (§4.3)', () => {
  test('clips down to ≤ 20% of OBSERVER_THRESHOLD by token count', () => {
    // ~80k chars of total tier3, target = 0.2 * 30000 = 6000 tokens ≈ 24000 chars budget.
    const long = 'x'.repeat(200)
    const recent: Message[] = []
    for (let i = 0; i < 400; i++) recent.push(asstMsg(long, i))
    const clipped = clipTier3KeepingTail(recent, {
      targetTokens: 0.2 * defaultThresholds.OBSERVER_THRESHOLD,
      tokenCounter: charsOver4TokenCounter,
    })
    const clippedTokens = clipped.reduce(
      (acc, m) => acc + charsOver4TokenCounter(JSON.stringify(m.content)),
      0,
    )
    expect(clippedTokens).toBeLessThanOrEqual(0.2 * defaultThresholds.OBSERVER_THRESHOLD + 200)
    expect(clipped.length).toBeLessThan(recent.length)
    // Tail preserved — last message must be the last of input
    expect(clipped[clipped.length - 1]).toBe(recent[recent.length - 1])
  })

  test('never splits an atomic pair across the clip boundary', () => {
    // Pair sits where the clip would otherwise cut between use and result.
    const long = 'x'.repeat(200)
    const recent: Message[] = []
    for (let i = 0; i < 20; i++) recent.push(asstMsg(long, i))
    recent.push(useMsg('tu_1', 19))
    recent.push(resultMsg('tu_1', 19))
    const clipped = clipTier3KeepingTail(recent, {
      targetTokens: 50,
      tokenCounter: charsOver4TokenCounter,
    })
    const hasUse = clipped.some((m) => m.content.some((p) => p.type === 'tool_use' && p.tool_use_id === 'tu_1'))
    const hasResult = clipped.some((m) =>
      m.content.some((p) => p.type === 'tool_result' && p.tool_use_id === 'tu_1'),
    )
    expect(hasUse).toBe(hasResult)
  })

  test('never trims an in-flight tool_use (no matching result yet)', () => {
    const filler = (i: number): Message => asstMsg('x'.repeat(200), i)
    const inflight = useMsg('tu_pending', 99)
    const recent: Message[] = []
    for (let i = 0; i < 30; i++) recent.push(filler(i))
    recent.push(inflight)
    const clipped = clipTier3KeepingTail(recent, {
      targetTokens: 30,
      tokenCounter: charsOver4TokenCounter,
    })
    expect(clipped).toContain(inflight)
  })

  test('returns identical reference when already at or below target', () => {
    const recent: Message[] = [userMsg('hi', 0), asstMsg('hello', 0)]
    const clipped = clipTier3KeepingTail(recent, {
      targetTokens: 10000,
      tokenCounter: charsOver4TokenCounter,
    })
    expect(clipped).toBe(recent)
  })
})

describe('maybeExtractObservations — gate + no-LLM no-op', () => {
  test('below OBSERVER_THRESHOLD → ran=false, reason=below_threshold', async () => {
    const tier3 = { recent: [userMsg('q', 0)], inflight: [] }
    const result = await maybeExtractObservations(tier3, emptyTier2(), ctxFor(), {
      tokenCounter: charsOver4TokenCounter,
      currentQuery: 'q',
    })
    expect(result.ran).toBe(false)
    expect(result.reason).toBe('below_threshold')
  })

  test('above threshold but no llmCaller injected → ran=false, reason=no_llm_caller', async () => {
    const long = 'x'.repeat(200000) // exceeds 30000 tokens × 4 chars/token = 120000 chars budget
    const tier3 = { recent: [userMsg(long, 0)], inflight: [] }
    const result = await maybeExtractObservations(tier3, emptyTier2(), ctxFor(), {
      tokenCounter: charsOver4TokenCounter,
      currentQuery: 'q',
    })
    expect(result.ran).toBe(false)
    expect(result.reason).toBe('no_llm_caller')
  })
})

describe('maybeExtractObservations — LLM extraction path', () => {
  test('stub LLM with 2 observations → extracted parsed; Tier-3 clipped shorter', async () => {
    const long = 'x'.repeat(200000)
    const tier3 = { recent: [userMsg(long, 0), asstMsg(long, 0)], inflight: [] }
    const llmCaller = vi.fn<LLMCaller>().mockResolvedValue({
      text: `- 1700000000 (high) user wants strict mode
- 1700000050 (med) discussing auth middleware`,
    })
    const result = await maybeExtractObservations(tier3, emptyTier2(), ctxFor(), {
      tokenCounter: charsOver4TokenCounter,
      currentQuery: 'follow up?',
      llmCaller,
    })
    expect(result.ran).toBe(true)
    expect(result.extracted).toHaveLength(2)
    expect(result.clippedTier3.length).toBeLessThanOrEqual(tier3.recent.length)
    expect(llmCaller).toHaveBeenCalledTimes(1)
  })

  test('LLM returns parser-mismatched text → ran=true, extracted=[], rawText captured for debug', async () => {
    const long = 'x'.repeat(200000)
    const tier3 = { recent: [userMsg(long, 0)], inflight: [] }
    // Wrong bullet (* not -), wrong timestamp shape (ISO date), no (high|med|low)
    // anywhere — does NOT trip CONFIDENCE_LINE_HINT, parser silently returns [].
    // This is the exact 43/48 lme-multiturn failure mode we need to debug.
    const driftedOutput = '* 2024-03-15 user added 25 postcards to collection\n* user lives in Berlin'
    const llmCaller = vi.fn<LLMCaller>().mockResolvedValue({ text: driftedOutput })
    const result = await maybeExtractObservations(tier3, emptyTier2(), ctxFor(), {
      tokenCounter: charsOver4TokenCounter,
      currentQuery: 'q',
      llmCaller,
    })
    expect(result.ran).toBe(true)
    expect(result.extracted).toHaveLength(0)
    expect(result.rawText).toBe(driftedOutput)
  })

  test('successful extraction does not carry rawText (no diagnostic bloat on healthy fires)', async () => {
    const long = 'x'.repeat(200000)
    const tier3 = { recent: [userMsg(long, 0)], inflight: [] }
    const llmCaller = vi.fn<LLMCaller>().mockResolvedValue({
      text: '- 1700000000 (high) user has 2 cats',
    })
    const result = await maybeExtractObservations(tier3, emptyTier2(), ctxFor(), {
      tokenCounter: charsOver4TokenCounter,
      currentQuery: 'q',
      llmCaller,
    })
    expect(result.ran).toBe(true)
    expect(result.extracted).toHaveLength(1)
    expect(result.rawText).toBeUndefined()
  })

  test('stub LLM returns malformed → ran=false, reason=parse_error (no throw)', async () => {
    const long = 'x'.repeat(200000)
    const tier3 = { recent: [userMsg(long, 0)], inflight: [] }
    const llmCaller = vi.fn<LLMCaller>().mockResolvedValue({
      text: 'this is not in the observation format at all\n- 1234 (bogus) bad',
    })
    const result = await maybeExtractObservations(tier3, emptyTier2(), ctxFor(), {
      tokenCounter: charsOver4TokenCounter,
      currentQuery: 'q',
      llmCaller,
    })
    expect(result.ran).toBe(false)
    expect(result.reason).toBe('parse_error')
  })

  test('Tier-2 entries strict append-only (existing entries reference-equal post-extract)', async () => {
    const long = 'x'.repeat(200000)
    // turn_index=5 on new message — strictly > pre-existing sourceTurn=0 so the
    // content-aware filter (decisions.md [2026-05-27]) includes it.
    const tier3 = { recent: [userMsg(long, 5)], inflight: [] }
    const preexisting: Tier2 = {
      observations: [
        { timestamp: 1, confidence: 'high', statement: 'pre', sourceTurn: 0 },
      ],
      pointers: [],
      classSignal: { class: 'mixed', confidence: 0, updatedAt: 0 },
    }
    const llmCaller = vi.fn<LLMCaller>().mockResolvedValue({
      text: '- 1700000000 (high) new fact',
    })
    const result = await maybeExtractObservations(tier3, preexisting, ctxFor(), {
      tokenCounter: charsOver4TokenCounter,
      currentQuery: 'q',
      llmCaller,
    })
    expect(result.ran).toBe(true)
    // Caller appends; verify pre-existing entry reference identity remains for indexing
    const merged = [...preexisting.observations, ...result.extracted]
    expect(merged[0]).toBe(preexisting.observations[0])
  })
})

describe('maybeExtractObservations — content-aware filter via sourceTurn watermark', () => {
  // 2026-05-27 — observer was firing every turn over OBSERVER_THRESHOLD with the
  // FULL Tier-3 as LLM input. 82 fires on 3 lme-mt tasks burned 72% of cost,
  // and the LLM tended to focus on the latest tail — middle-window sessions
  // dropped silently. Fix: each fire sees ONLY messages with turn_index newer
  // than max sourceTurn in current Tier-2 observations. Two consequences:
  //   (1) Per-fire observer LLM input shrinks dramatically (only new content).
  //   (2) Skip the LLM call entirely when delta < 0.1 × OBSERVER_THRESHOLD —
  //       still clip Tier-3 so actor input stays low.
  const long = 'x'.repeat(200000) // ~50k tokens — well above default 30k threshold
  const obsFromTurn = (turn: number, statement = 'old observation'): Observation => ({
    timestamp: 1700000000 + turn,
    confidence: 'high',
    statement,
    sourceTurn: turn,
  })

  test('skips fire when no new messages (all turn_index ≤ lastObservedTurn)', async () => {
    // All tier-3 messages have turn_index ≤ lastObservedTurn (20) → filter yields []
    // → newTokens=0 → skip. Total tier-3 tokens still > OBSERVER_THRESHOLD so the
    // threshold gate passes; content filter is the actual decider.
    const shortMsg = 'x'.repeat(4000)
    const manyRecent: Message[] = []
    // 60 messages, all turn_index ≤ 20 (cycling 0..20). Totalt ~60k tokens.
    for (let i = 0; i < 60; i++) manyRecent.push(userMsg(shortMsg, i % 21))
    const tier3 = { recent: manyRecent, inflight: [] }
    const populatedTier2: Tier2 = {
      observations: [obsFromTurn(20, 'observed turn 20')],
      pointers: [],
      classSignal: { class: 'mixed', confidence: 0, updatedAt: 0 },
    }
    const llmCaller = vi.fn<LLMCaller>().mockResolvedValue({
      text: '- 2024-01-01 (high) should never extract — content already observed',
    })
    const result = await maybeExtractObservations(tier3, populatedTier2, ctxFor(), {
      tokenCounter: charsOver4TokenCounter,
      currentQuery: 'q',
      currentTurnIndex: 21,
      llmCaller,
    })
    expect(result.ran).toBe(false)
    expect(result.reason).toBe('delta_too_small')
    expect(llmCaller).not.toHaveBeenCalled()
    // Skip path still clips Tier-3 — actor input stays low even when LLM was skipped.
    const clippedTokens = result.clippedTier3.reduce(
      (s, m) => s + charsOver4TokenCounter(JSON.stringify(m.content)),
      0,
    )
    expect(clippedTokens).toBeLessThanOrEqual(0.2 * defaultThresholds.OBSERVER_THRESHOLD + 1500)
    expect(result.clippedTier3.length).toBeLessThan(manyRecent.length)
  })

  test('fires when enough new tokens accumulated (newMessages tokens ≥ fireFloor)', async () => {
    // 30 fresh messages × ~1k = 30k tokens of new content, far above fireFloor
    // (0.1 × 30000 = 3000). Should fire.
    const shortMsg = 'x'.repeat(4000)
    const manyRecent: Message[] = []
    for (let i = 21; i <= 50; i++) manyRecent.push(userMsg(shortMsg, i))
    const tier3 = { recent: manyRecent, inflight: [] }
    const populatedTier2: Tier2 = {
      observations: [obsFromTurn(20)],
      pointers: [],
      classSignal: { class: 'mixed', confidence: 0, updatedAt: 0 },
    }
    const llmCaller = vi.fn<LLMCaller>().mockResolvedValue({
      text: '- 2024-06-15 (high) new fact extracted from fresh content',
    })
    const result = await maybeExtractObservations(tier3, populatedTier2, ctxFor(), {
      tokenCounter: charsOver4TokenCounter,
      currentQuery: 'q',
      currentTurnIndex: 50,
      llmCaller,
    })
    expect(result.ran).toBe(true)
    expect(result.extracted).toHaveLength(1)
    expect(llmCaller).toHaveBeenCalledTimes(1)
  })

  test('empty Tier-2 (first-ever fire) processes all Tier-3 content regardless of metadata', async () => {
    const tier3 = { recent: [userMsg(long, 5)], inflight: [] }
    const llmCaller = vi.fn<LLMCaller>().mockResolvedValue({
      text: '- 2024-01-01 (high) first fire',
    })
    const result = await maybeExtractObservations(tier3, emptyTier2(), ctxFor(), {
      tokenCounter: charsOver4TokenCounter,
      currentQuery: 'q',
      currentTurnIndex: 5,
      llmCaller,
    })
    expect(result.ran).toBe(true)
    expect(llmCaller).toHaveBeenCalledTimes(1)
  })

  test('messages without metadata.turn_index are treated as new (backward compat)', async () => {
    // Synthetic core tests build messages without metadata. The filter must
    // treat them as "new" so existing core-only tests keep their semantics.
    const noMetaMsg: Message = {
      role: 'user',
      content: [{ type: 'text', text: long }],
    }
    const tier3 = { recent: [noMetaMsg], inflight: [] }
    const populatedTier2: Tier2 = {
      observations: [obsFromTurn(10)],
      pointers: [],
      classSignal: { class: 'mixed', confidence: 0, updatedAt: 0 },
    }
    const llmCaller = vi.fn<LLMCaller>().mockResolvedValue({
      text: '- 2024-01-01 (high) extracted from no-metadata msg',
    })
    const result = await maybeExtractObservations(tier3, populatedTier2, ctxFor(), {
      tokenCounter: charsOver4TokenCounter,
      currentQuery: 'q',
      llmCaller,
    })
    expect(result.ran).toBe(true)
  })

  test('extractObservationsSync uses the same content-aware filter', () => {
    const shortMsg = 'x'.repeat(4000)
    const manyRecent: Message[] = []
    // Mirror of the async test: 60 messages all turn_index ≤ 20 (cycling), so
    // filter yields [] and skip triggers despite total tokens > threshold.
    for (let i = 0; i < 60; i++) manyRecent.push(userMsg(shortMsg, i % 21))
    const tier3 = { recent: manyRecent, inflight: [] }
    const populatedTier2: Tier2 = {
      observations: [obsFromTurn(20)],
      pointers: [],
      classSignal: { class: 'mixed', confidence: 0, updatedAt: 0 },
    }
    const syncCaller = vi.fn<(_req: unknown) => { text: string }>().mockReturnValue({
      text: '- 2024-01-01 (high) should not be called',
    })
    const result = extractObservationsSync(tier3, populatedTier2, ctxFor(), {
      tokenCounter: charsOver4TokenCounter,
      currentQuery: 'q',
      currentTurnIndex: 21,
      syncLLMCaller: syncCaller,
    })
    expect(result.ran).toBe(false)
    expect(result.reason).toBe('delta_too_small')
    expect(syncCaller).not.toHaveBeenCalled()
  })
})

describe('extractObservationsSync + cache prefix preservation', () => {
  test('appending observations to Tier-2 preserves serializeForCache prefix bytes', () => {
    const tier1 = {
      systemPrompt: { role: 'system' as const, content: [{ type: 'text' as const, text: 'be helpful' }] },
      toolDefinitions: [],
      firstUserMessages: [userMsg('q', 0)],
    }
    const tier2Before: Tier2 = emptyTier2()
    const tier2After: Tier2 = {
      ...tier2Before,
      observations: [
        ...tier2Before.observations,
        { timestamp: 1700000000, confidence: 'high', statement: 's', sourceTurn: 0 },
      ],
    }
    const beforeBytes = serializeForCache({ tier1, tier2: tier2Before })
    const afterBytes = serializeForCache({ tier1, tier2: tier2After })
    const beforeText = beforeBytes.toString('utf8')
    const afterText = afterBytes.toString('utf8')
    const tier2Marker = beforeText.indexOf('"tier2":')
    expect(tier2Marker).toBeGreaterThan(0)
    expect(afterText.slice(0, tier2Marker)).toBe(beforeText.slice(0, tier2Marker))
  })

  test('extractObservationsSync exists and accepts synchronous LLMCaller', () => {
    const long = 'x'.repeat(200000)
    const tier3 = { recent: [userMsg(long, 0)], inflight: [] }
    const sync = (req: { messages: { content: string }[] }): { text: string } => ({
      text: `- 1700000000 (high) sync extracted from ${String(req.messages.length)} messages`,
    })
    const result = extractObservationsSync(tier3, emptyTier2(), ctxFor(), {
      tokenCounter: charsOver4TokenCounter,
      currentQuery: 'q',
      syncLLMCaller: sync,
    })
    expect(result.ran).toBe(true)
    expect(result.extracted).toHaveLength(1)
  })
})
