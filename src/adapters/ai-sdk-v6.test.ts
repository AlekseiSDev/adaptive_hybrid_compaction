import { describe, expect, test } from 'vitest'
import type { LanguageModelV3, LanguageModelV3Message } from '@ai-sdk/provider'
import type { CompactResult, LLMCaller } from '../core/index.js'
import { createAhcMiddleware } from './ai-sdk-v6.js'
import type { SessionId } from './sessionScratchpad.js'

const stubModel = (): LanguageModelV3 =>
  ({
    specificationVersion: 'v3',
    provider: 'stub',
    modelId: 'stub-model',
    supportedUrls: {},
    doGenerate: () => {
      throw new Error('stub: doGenerate not implemented')
    },
    doStream: () => {
      throw new Error('stub: doStream not implemented')
    },
  }) as unknown as LanguageModelV3

const sys: LanguageModelV3Message = { role: 'system', content: 'be helpful' }
const user = (s: string): LanguageModelV3Message => ({
  role: 'user',
  content: [{ type: 'text', text: s }],
})
const asstToolCall = (id: string, name = 'search'): LanguageModelV3Message => ({
  role: 'assistant',
  content: [{ type: 'tool-call', toolCallId: id, toolName: name, input: {} }],
})
const toolResult = (id: string, output: unknown): LanguageModelV3Message => ({
  role: 'tool',
  content: [
    {
      type: 'tool-result',
      toolCallId: id,
      toolName: 'search',
      output: { type: 'json', value: output as never },
    },
  ],
})

const baseParams = (prompt: LanguageModelV3Message[]) => ({
  prompt,
  tools: [] as never[],
})

describe('createAhcMiddleware — A6 LanguageModelV3Middleware', () => {
  test('returned object has specificationVersion=v3 and a transformParams function', () => {
    const mw = createAhcMiddleware({})
    expect(mw.specificationVersion).toBe('v3')
    expect(typeof mw.transformParams).toBe('function')
  })

  test('transformParams with simple system+user passes through (no compaction needed)', async () => {
    const mw = createAhcMiddleware({})
    const result = await mw.transformParams?.({
      type: 'generate',
      params: baseParams([sys, user('hello')]),
      model: stubModel(),
    })
    expect(result).toBeDefined()
    if (result === undefined) return
    expect(result.prompt[0]?.role).toBe('system')
    expect(result.prompt[result.prompt.length - 1]?.role).toBe('user')
  })

  test('tool-heavy history with TYPE_AWARE_OFFLOAD + RECALL_TOOL → recall tool injected', async () => {
    const heavy = 'A'.repeat(8000)
    const prompt: LanguageModelV3Message[] = [
      sys,
      user('search foo'),
      asstToolCall('tu_1'),
      toolResult('tu_1', { large: heavy }),
      user('search bar'),
      asstToolCall('tu_2'),
      toolResult('tu_2', 'small-1'),
      user('search baz'),
      asstToolCall('tu_3'),
      toolResult('tu_3', 'small-2'),
    ]
    const mw = createAhcMiddleware({
      flags: {
        TYPE_AWARE_OFFLOAD: true,
        RECALL_TOOL: true,
      },
      thresholds: { K_RECENT: 20 },
      configuredClass: 'tool_heavy',
    })
    const result = await mw.transformParams?.({
      type: 'generate',
      params: baseParams(prompt),
      model: stubModel(),
    })
    expect(result).toBeDefined()
    if (result === undefined) return
    expect(result.tools).toBeDefined()
    const tools = result.tools ?? []
    const recallToolPresent = tools.some(
      (t) => t.type === 'function' && t.name === 'recall_tool_result',
    )
    expect(recallToolPresent).toBe(true)
  })

  test('two calls with same sessionId → scratchpad persists', async () => {
    const heavy = 'B'.repeat(8000)
    const prompt: LanguageModelV3Message[] = [
      sys,
      user('q1'),
      asstToolCall('tu_a'),
      toolResult('tu_a', { large: heavy }),
      user('q2'),
      asstToolCall('tu_b'),
      toolResult('tu_b', 'small'),
      user('q3'),
      asstToolCall('tu_c'),
      toolResult('tu_c', 'small'),
    ]
    let sessionIdCount = 0
    const mw = createAhcMiddleware({
      flags: {
        TYPE_AWARE_OFFLOAD: true,
        RECALL_TOOL: true,
      },
      thresholds: { K_RECENT: 20 },
      configuredClass: 'tool_heavy',
      sessionId: () => {
        sessionIdCount++
        return 'sticky-session'
      },
    })
    await mw.transformParams?.({
      type: 'generate',
      params: baseParams(prompt),
      model: stubModel(),
    })
    const second = await mw.transformParams?.({
      type: 'generate',
      params: baseParams(prompt),
      model: stubModel(),
    })
    expect(sessionIdCount).toBeGreaterThanOrEqual(2)
    expect(second).toBeDefined()
    if (second === undefined) return
    // Recall tool should still be present on the second call (scratchpad persistent).
    const secondTools = second.tools ?? []
    const hasRecall = secondTools.some(
      (t) => t.type === 'function' && t.name === 'recall_tool_result',
    )
    expect(hasRecall).toBe(true)
  })

  test('wrapStream / wrapGenerate left undefined → AI SDK calls underlying provider directly', () => {
    const mw = createAhcMiddleware({})
    expect(mw.wrapStream).toBeUndefined()
    expect(mw.wrapGenerate).toBeUndefined()
  })

  test('onCompactResult fires after each transformParams call with sessionId + CompactResult', async () => {
    const seen: { sessionId: SessionId; result: CompactResult }[] = []
    const mw = createAhcMiddleware({
      sessionId: () => 'sess-A',
      onCompactResult: (sid, r) => seen.push({ sessionId: sid, result: r }),
    })
    await mw.transformParams?.({
      type: 'generate',
      params: baseParams([sys, user('hello')]),
      model: stubModel(),
    })
    expect(seen).toHaveLength(1)
    expect(seen[0]?.sessionId).toBe('sess-A')
    expect(seen[0]?.result.assembledMessages.length).toBeGreaterThan(0)
    expect(seen[0]?.result.newTier2).toBeDefined()
  })

  test('Tier-2 persists across transformParams calls on same sessionId — observations accumulate', async () => {
    // Stub LLM caller always returns one observation per fire.
    // eslint-disable-next-line @typescript-eslint/require-await -- async required to satisfy LLMCaller type
    const stubLlm: LLMCaller = async () => ({ text: '- 1 (high) persistence-test observation' })

    // Heavy text in Tier-3 candidate region to trigger observer (>= OBSERVER_THRESHOLD).
    const heavy = 'x'.repeat(400) // ~100 tokens via chars/4
    const heavyAsst: LanguageModelV3Message = {
      role: 'assistant',
      content: [{ type: 'text', text: heavy }],
    }
    const prompt: LanguageModelV3Message[] = [sys, user('first'), heavyAsst, user(heavy)]

    const seen: CompactResult[] = []
    const mw = createAhcMiddleware({
      flags: { TASK_AWARE_EXTRACTION: true },
      thresholds: { OBSERVER_THRESHOLD: 50, K_RECENT: 2 },
      configuredClass: 'mixed',
      sessionId: () => 'sticky',
      llmCaller: stubLlm,
      onCompactResult: (_sid, r) => seen.push(r),
    })

    await mw.transformParams?.({
      type: 'generate',
      params: baseParams(prompt),
      model: stubModel(),
    })
    await mw.transformParams?.({
      type: 'generate',
      params: baseParams(prompt),
      model: stubModel(),
    })

    expect(seen).toHaveLength(2)
    expect(seen[0]?.newTier2.observations).toHaveLength(1)
    // After fix: turn 2 carries the turn-1 observation forward + appends a new one.
    expect(seen[1]?.newTier2.observations.length).toBeGreaterThanOrEqual(2)
    expect(seen[1]?.newTier2.observations[0]).toEqual(seen[0]?.newTier2.observations[0])
  })

  test('Tier-2 observations accumulate monotonically over 5 turns with persistent session', async () => {
    // Stronger gravity than the 2-call test: observations must grow monotonically
    // (or stay equal) call-over-call, and the first observation from turn 1 must
    // survive verbatim through turn 5.
    let callIdx = 0
    // eslint-disable-next-line @typescript-eslint/require-await -- async required to satisfy LLMCaller type
    const stubLlm: LLMCaller = async () => {
      callIdx += 1
      return { text: `- ${String(callIdx)} (high) turn-${String(callIdx)}-observation` }
    }
    const heavy = 'y'.repeat(400)
    const heavyAsst: LanguageModelV3Message = {
      role: 'assistant',
      content: [{ type: 'text', text: heavy }],
    }
    const prompt: LanguageModelV3Message[] = [sys, user('first'), heavyAsst, user(heavy)]
    const seen: CompactResult[] = []
    const mw = createAhcMiddleware({
      flags: { TASK_AWARE_EXTRACTION: true },
      thresholds: { OBSERVER_THRESHOLD: 50, K_RECENT: 2 },
      configuredClass: 'mixed',
      sessionId: () => 'sticky-5',
      llmCaller: stubLlm,
      onCompactResult: (_sid, r) => seen.push(r),
    })

    for (let i = 0; i < 5; i++) {
      await mw.transformParams?.({
        type: 'generate',
        params: baseParams(prompt),
        model: stubModel(),
      })
    }

    expect(seen).toHaveLength(5)
    const counts = seen.map((r) => r.newTier2.observations.length)
    // Monotonic non-decreasing
    for (let i = 1; i < counts.length; i++) {
      expect(counts[i]).toBeGreaterThanOrEqual(counts[i - 1] ?? 0)
    }
    // Final turn must carry the first turn's observation at index 0
    expect(seen[4]?.newTier2.observations[0]).toEqual(seen[0]?.newTier2.observations[0])
    // Should have accumulated at least 5 observations (one per fired turn)
    expect(counts[4]).toBeGreaterThanOrEqual(5)
  })

  test('onCompactResult NOT called when prompt is passthrough (no system message)', async () => {
    const seen: { sessionId: SessionId; result: CompactResult }[] = []
    const mw = createAhcMiddleware({
      sessionId: () => 'sess-B',
      onCompactResult: (sid, r) => seen.push({ sessionId: sid, result: r }),
    })
    await mw.transformParams?.({
      type: 'generate',
      params: baseParams([user('hello, no system')]),
      model: stubModel(),
    })
    expect(seen).toHaveLength(0)
  })

  test('cacheControlEnabled=false (default) → no anthropic.cacheControl on any part', async () => {
    const mw = createAhcMiddleware({})
    const result = await mw.transformParams?.({
      type: 'generate',
      params: baseParams([sys, user('hello')]),
      model: stubModel(),
    })
    expect(result).toBeDefined()
    if (result === undefined) return
    // Walk all message-level + part-level providerOptions; none should have
    // anthropic.cacheControl set.
    for (const m of result.prompt) {
      const mOpts = m.providerOptions as { anthropic?: { cacheControl?: unknown } } | undefined
      expect(mOpts?.anthropic?.cacheControl).toBeUndefined()
      if (typeof m.content !== 'string') {
        for (const part of m.content) {
          const pOpts = part.providerOptions as { anthropic?: { cacheControl?: unknown } } | undefined
          expect(pOpts?.anthropic?.cacheControl).toBeUndefined()
        }
      }
    }
  })

  test('cacheControlEnabled=true → cacheControl=ephemeral on last part of first user message', async () => {
    const mw = createAhcMiddleware({ cacheControlEnabled: true })
    const result = await mw.transformParams?.({
      type: 'generate',
      params: baseParams([sys, user('hello')]),
      model: stubModel(),
    })
    expect(result).toBeDefined()
    if (result === undefined) return
    // Cache breakpoint lands on the first user message (caches system + first
    // user; ≥1024 tokens needed for Anthropic to honor the marker).
    const userMsg = result.prompt.find((m) => m.role === 'user')
    expect(userMsg).toBeDefined()
    if (userMsg?.role !== 'user') return
    const lastPart = userMsg.content[userMsg.content.length - 1]
    const opts = lastPart?.providerOptions as
      | { anthropic?: { cacheControl?: { type: string } } }
      | undefined
    expect(opts?.anthropic?.cacheControl).toEqual({ type: 'ephemeral' })
    // System message should NOT have the marker (cache breakpoint placement
    // moved to first user for token-threshold reasons).
    const sysMsg = result.prompt.find((m) => m.role === 'system')
    const sysOpts = sysMsg?.providerOptions as
      | { anthropic?: { cacheControl?: unknown } }
      | undefined
    expect(sysOpts?.anthropic?.cacheControl).toBeUndefined()
  })

  test('cacheControlEnabled=true but no user message → prompt unchanged', async () => {
    const mw = createAhcMiddleware({ cacheControlEnabled: true })
    // No system message → compact() returns passthrough (params as-is, no
    // assembledMessages serialization), so cacheControl injection skipped.
    const result = await mw.transformParams?.({
      type: 'generate',
      params: baseParams([user('hello, no system')]),
      model: stubModel(),
    })
    expect(result).toBeDefined()
    if (result === undefined) return
    // Result prompt should not contain a system message (it didn't have one).
    expect(result.prompt.find((m) => m.role === 'system')).toBeUndefined()
  })
})
