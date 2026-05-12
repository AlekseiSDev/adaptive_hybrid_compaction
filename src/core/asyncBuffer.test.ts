import { describe, expect, test, vi } from 'vitest'
import { AsyncBuffer } from './asyncBuffer.js'
import { defaultFeatureFlags } from './featureFlags.js'
import { defaultThresholds } from './thresholds.js'
import { charsOver4TokenCounter } from './tokenCounter.js'
import type { LLMCaller } from './llm.js'
import type { CompactionContext, Message, Tier2, Tier3 } from './types.js'

const userMsg = (s: string, turn: number, step = 0): Message => ({
  role: 'user',
  content: [{ type: 'text', text: s }],
  metadata: { turn_index: turn, step_index: step },
})

const emptyTier2 = (): Tier2 => ({
  observations: [],
  pointers: [],
  classSignal: { class: 'mixed', confidence: 0, updatedAt: 0 },
})

const ctxFor = (): CompactionContext => ({
  flags: defaultFeatureFlags,
  groups_after_this: 0,
  cumulative_kept_tool_result_bytes: 0,
  current_class: 'conversational',
  thresholds: defaultThresholds,
})

const heavyTier3 = (): Tier3 => ({
  recent: [userMsg('x'.repeat(50000), 1)],
  inflight: [],
})

describe('AsyncBuffer — §4.5 pre-emptive Observer + activation hooks', () => {
  test('pre_compact twice consecutively → llmCaller invoked once (idempotent)', async () => {
    const llmCaller = vi.fn<LLMCaller>().mockResolvedValue({
      text: '- 1700000000 (high) buffered observation',
    })
    const buf = new AsyncBuffer()
    const tier3 = heavyTier3()
    await buf.pre_compact(tier3, emptyTier2(), ctxFor(), {
      tokenCounter: charsOver4TokenCounter,
      currentQuery: 'q',
      llmCaller,
    })
    await buf.pre_compact(tier3, emptyTier2(), ctxFor(), {
      tokenCounter: charsOver4TokenCounter,
      currentQuery: 'q',
      llmCaller,
    })
    expect(llmCaller).toHaveBeenCalledTimes(1)
    const consumed = buf.consume(buf.hashTier3(tier3))
    expect(consumed).not.toBeNull()
    expect(consumed?.extracted).toHaveLength(1)
  })

  test('consume after tier3 mutation → returns null (hash mismatch)', async () => {
    const llmCaller = vi.fn<LLMCaller>().mockResolvedValue({
      text: '- 1700000000 (high) buffered',
    })
    const buf = new AsyncBuffer()
    const tier3a = heavyTier3()
    await buf.pre_compact(tier3a, emptyTier2(), ctxFor(), {
      tokenCounter: charsOver4TokenCounter,
      currentQuery: 'q',
      llmCaller,
    })
    const tier3b: Tier3 = {
      recent: [...tier3a.recent, userMsg('newer', 2)],
      inflight: [],
    }
    expect(buf.consume(buf.hashTier3(tier3b))).toBeNull()
  })

  test('consume without prior pre_compact → returns null', () => {
    const buf = new AsyncBuffer()
    const tier3 = heavyTier3()
    expect(buf.consume(buf.hashTier3(tier3))).toBeNull()
  })

  test('blockAfter: tier3 > 1.2 × OBSERVER_THRESHOLD → true; below → false', () => {
    const buf = new AsyncBuffer()
    // 1.2 × 8000 = 9600 tokens × 4 chars/token = 38400 chars budget
    const huge: Tier3 = { recent: [userMsg('y'.repeat(50000), 1)], inflight: [] }
    const small: Tier3 = { recent: [userMsg('hi', 1)], inflight: [] }
    expect(
      buf.blockAfter(huge, charsOver4TokenCounter, defaultThresholds.OBSERVER_THRESHOLD),
    ).toBe(true)
    expect(
      buf.blockAfter(small, charsOver4TokenCounter, defaultThresholds.OBSERVER_THRESHOLD),
    ).toBe(false)
  })

  test('activateAfterIdle: idleMs > 5min → true, else false', () => {
    const buf = new AsyncBuffer()
    expect(buf.activateAfterIdle(4 * 60 * 1000)).toBe(false)
    expect(buf.activateAfterIdle(6 * 60 * 1000)).toBe(true)
  })

  test('invalidate clears any buffered state', async () => {
    const llmCaller = vi.fn<LLMCaller>().mockResolvedValue({
      text: '- 1700000000 (high) buffered',
    })
    const buf = new AsyncBuffer()
    const tier3 = heavyTier3()
    await buf.pre_compact(tier3, emptyTier2(), ctxFor(), {
      tokenCounter: charsOver4TokenCounter,
      currentQuery: 'q',
      llmCaller,
    })
    buf.invalidate()
    expect(buf.consume(buf.hashTier3(tier3))).toBeNull()
  })
})
