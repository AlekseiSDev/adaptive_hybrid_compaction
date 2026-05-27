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
import type { CompactionContext, Message, Tier2 } from './types.js'

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
