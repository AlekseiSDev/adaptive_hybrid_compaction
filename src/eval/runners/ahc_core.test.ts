import { describe, expect, test, vi } from 'vitest'
import type { CoreEvent, LLMCaller, LLMRequest, LLMResponse } from '../../core/index.js'
import {
  ahcCoreBaseline,
  makeCostAwareLLMCaller,
  mapCoreEventToInstrumentation,
  wrapLlmClientAsLLMCaller,
} from './ahc_core.js'
import type { LLMClient } from '../types.js'

// AI SDK pipeline is exercised by ahc_core.live.test.ts against a real
// OpenRouter endpoint. Unit tests cover surface that doesn't touch the
// network: factory shape, the cost-aware wrapper math, the LLMClient bridge,
// and the CoreEvent → InstrumentationEvent mapper.

describe('ahcCoreBaseline factory', () => {
  test('prepare(task) yields state with task.id, empty history, scratchpad+hysteresis in scratch', () => {
    const baseline = ahcCoreBaseline({
      apiKey: 'sk-fake',
      baseURL: 'http://localhost:9999',
      model: 'google/gemini-3-flash-preview',
    })
    expect(baseline.name).toBe('ahc_core')
    const state = baseline.prepare({ id: 'tsk-1', input: 'x', expected: 'y' })
    expect(state.task_id).toBe('tsk-1')
    expect(state.history).toEqual([])
    expect(state.scratch).toBeDefined()
    const scratch = state.scratch as unknown as {
      registry: { size?: () => number }
      hysteresis: Map<string, unknown>
      internalCostUsdSinceLastStep: number
    }
    expect(scratch.hysteresis).toBeInstanceOf(Map)
    expect(scratch.internalCostUsdSinceLastStep).toBe(0)
  })
})

describe('makeCostAwareLLMCaller', () => {
  const pricing = { input_per_million_usd: 2, output_per_million_usd: 4 }

  test('accumulates cost across multiple calls via onCost callback', async () => {
    let totalCost = 0
    const mockCaller: LLMCaller = vi
      .fn<(req: LLMRequest) => Promise<LLMResponse>>()
      .mockResolvedValueOnce({
        text: 'first',
        usage: { promptTokens: 1_000_000, completionTokens: 500_000 },
      })
      .mockResolvedValueOnce({
        text: 'second',
        usage: { promptTokens: 2_000_000, completionTokens: 1_000_000 },
      })
    const wrapped = makeCostAwareLLMCaller(mockCaller, pricing, (usd) => {
      totalCost += usd
    })

    await wrapped({ messages: [{ role: 'user', content: 'a' }] })
    // 1M × $2 + 500k × $4 = $2 + $2 = $4
    expect(totalCost).toBeCloseTo(4, 6)

    await wrapped({ messages: [{ role: 'user', content: 'b' }] })
    // additional: 2M × $2 + 1M × $4 = $4 + $4 = $8 → total $12
    expect(totalCost).toBeCloseTo(12, 6)
  })

  test('zero-usage response: no callback invocation', async () => {
    const callback = vi.fn()
    const mockCaller: LLMCaller = () => Promise.resolve({ text: 'no-usage' })
    const wrapped = makeCostAwareLLMCaller(mockCaller, pricing, callback)
    await wrapped({ messages: [{ role: 'user', content: 'x' }] })
    expect(callback).not.toHaveBeenCalled()
  })
})

describe('mapCoreEventToInstrumentation', () => {
  test('compaction event preserves type + bytes + turn_index, drops core kind', () => {
    const e: CoreEvent = {
      kind: 'compaction',
      type: 'offload',
      turn_index: 3,
      before_bytes: 5000,
      after_bytes: 800,
    }
    const out = mapCoreEventToInstrumentation(e)
    expect(out).toEqual({
      kind: 'compaction',
      payload: { type: 'offload', turn_index: 3, before_bytes: 5000, after_bytes: 800 },
    })
  })

  test('compaction event with llm_cost_usd: cost preserved', () => {
    const e: CoreEvent = {
      kind: 'compaction',
      type: 'observer',
      turn_index: 0,
      before_bytes: 1000,
      after_bytes: 200,
      llm_cost_usd: 0.0003,
    }
    const out = mapCoreEventToInstrumentation(e)
    if (out.kind !== 'compaction') throw new Error('expected compaction')
    expect(out.payload.llm_cost_usd).toBe(0.0003)
  })

  test('recall event preserves fields', () => {
    const e: CoreEvent = {
      kind: 'recall',
      recall_id: 'rec-7',
      tool_name: 'recall',
      reason: 'follow-up',
      turn_index: 2,
    }
    const out = mapCoreEventToInstrumentation(e)
    expect(out).toEqual({
      kind: 'recall',
      payload: {
        recall_id: 'rec-7',
        tool_name: 'recall',
        reason: 'follow-up',
        turn_index: 2,
      },
    })
  })

  test('classifier_signal → class_signal rename, flat shape preserved', () => {
    const e: CoreEvent = {
      kind: 'classifier_signal',
      turn_index: 1,
      class: 'tool_heavy',
      confidence: 0.92,
    }
    const out = mapCoreEventToInstrumentation(e)
    expect(out).toEqual({
      kind: 'class_signal',
      turn_index: 1,
      class: 'tool_heavy',
      confidence: 0.92,
    })
  })
})

describe('wrapLlmClientAsLLMCaller bridge', () => {
  test('binds model, translates request → eval shape, projects usage → core shape', async () => {
    const observed: { model?: string; messages?: unknown; max_tokens?: number }[] = []
    const fake: LLMClient = (req) => {
      observed.push({
        model: req.model,
        messages: req.messages,
        ...(req.max_tokens !== undefined ? { max_tokens: req.max_tokens } : {}),
      })
      return Promise.resolve({
        text: 'ok',
        raw_usage: { prompt_tokens: 12, completion_tokens: 8 },
        finish_reason: 'stop',
        latency_ms: 1,
      })
    }
    const caller = wrapLlmClientAsLLMCaller(fake, 'foo/bar')
    const resp = await caller({
      messages: [{ role: 'user', content: 'hi' }],
      maxOutputTokens: 64,
    })
    expect(observed).toHaveLength(1)
    expect(observed[0]?.model).toBe('foo/bar')
    expect(observed[0]?.max_tokens).toBe(64)
    expect(resp.text).toBe('ok')
    expect(resp.usage).toEqual({ promptTokens: 12, completionTokens: 8 })
  })

  test('propagates upstream error as thrown Error', async () => {
    const fake: LLMClient = () =>
      Promise.resolve({
        text: '',
        raw_usage: null,
        finish_reason: 'error',
        latency_ms: 0,
        error: { kind: 'rate_limit' as const, message: '429' },
      })
    const caller = wrapLlmClientAsLLMCaller(fake, 'foo/bar')
    await expect(caller({ messages: [{ role: 'user', content: 'x' }] })).rejects.toThrow(
      /rate_limit/,
    )
  })
})
