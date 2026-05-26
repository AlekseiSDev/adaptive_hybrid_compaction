import { describe, expect, test, vi } from 'vitest'
import { anthropicCompactBaseline } from './anthropic_compact.js'
import type { InstrumentationEvent, Message, Task } from '../types.js'

// Anthropic SDK is constructed inside the factory — for unit tests we stub
// the network via `vi.mock`. The mocked client returns a fake
// `BetaMessage` shape; we assert on baseline output / instrumentation
// behavior, not on Anthropic's wire protocol (covered by the SDK itself).

const makeTask = (id = 'a1'): Task => ({ id, input: 'hi', expected: 'hello' })

const makeUser = (text: string): Message => ({
  role: 'user',
  content: [{ type: 'text', text }],
})

type FakeContentBlock =
  | { type: 'text'; text: string; citations: null }
  | {
      type: 'compaction'
      content: string | null
      encrypted_content: string | null
    }

type FakeBetaMessage = {
  id: string
  content: FakeContentBlock[]
  model: string
  role: 'assistant'
  stop_reason: 'end_turn'
  stop_sequence: null
  type: 'message'
  usage: {
    input_tokens: number
    output_tokens: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
  }
}

const fakeMessage = (
  text: string,
  opts: {
    inputTokens?: number
    outputTokens?: number
    compactionContent?: string
  } = {},
): FakeBetaMessage => {
  const content: FakeBetaMessage['content'] = []
  if (opts.compactionContent !== undefined) {
    content.push({
      type: 'compaction',
      content: opts.compactionContent,
      encrypted_content: 'enc-' + opts.compactionContent.slice(0, 4),
    })
  }
  content.push({ type: 'text', text, citations: null })
  return {
    id: 'msg-' + text.slice(0, 6),
    content,
    model: 'claude-sonnet-4-6',
    role: 'assistant',
    stop_reason: 'end_turn',
    stop_sequence: null,
    type: 'message',
    usage: {
      input_tokens: opts.inputTokens ?? 50,
      output_tokens: opts.outputTokens ?? 10,
    },
  }
}

// Mock the @anthropic-ai/sdk default export. The factory we test calls
// `new Anthropic(...)` and then `client.beta.messages.create(...)`.
type CreateFn = (req: unknown) => Promise<FakeBetaMessage>
let mockCreate: ReturnType<typeof vi.fn<CreateFn>>

vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: class FakeAnthropic {
      beta = {
        messages: {
          create: (req: unknown): Promise<FakeBetaMessage> => mockCreate(req),
        },
      }
    },
  }
})

describe('anthropicCompactBaseline.name + prepare', () => {
  test('name is "anthropic_compact"', () => {
    mockCreate = vi.fn().mockResolvedValue(fakeMessage('x'))
    const baseline = anthropicCompactBaseline({ apiKey: 'sk-fake' })
    expect(baseline.name).toBe('anthropic_compact')
  })

  test('prepare returns empty history + scratch with model + empty compaction_blocks', () => {
    mockCreate = vi.fn().mockResolvedValue(fakeMessage('x'))
    const baseline = anthropicCompactBaseline({ apiKey: 'sk-fake' })
    const state = baseline.prepare(makeTask())
    expect(state.task_id).toBe('a1')
    expect(state.history).toEqual([])
    expect(state.scratch).toBeDefined()
    if (!state.scratch) return
    expect(state.scratch['model']).toBe('claude-sonnet-4-6')
    expect(state.scratch['compaction_blocks']).toEqual([])
  })
})

describe('anthropicCompactBaseline auth modes', () => {
  test('factory accepts authToken instead of apiKey (Pro/Max OAuth path)', () => {
    mockCreate = vi.fn().mockResolvedValue(fakeMessage('x'))
    const baseline = anthropicCompactBaseline({ authToken: 'sk-ant-oat-fake' })
    expect(baseline.name).toBe('anthropic_compact')
    const state = baseline.prepare(makeTask())
    expect(state.scratch?.['model']).toBe('claude-sonnet-4-6')
  })

  test('factory throws when neither apiKey nor authToken supplied', () => {
    mockCreate = vi.fn().mockResolvedValue(fakeMessage('x'))
    expect(() => anthropicCompactBaseline({})).toThrow(/apiKey or authToken/)
  })

  test('factory throws when both apiKey AND authToken supplied (ambiguous billing)', () => {
    mockCreate = vi.fn().mockResolvedValue(fakeMessage('x'))
    expect(() =>
      anthropicCompactBaseline({
        apiKey: 'sk-fake',
        authToken: 'sk-ant-oat-fake',
      }),
    ).toThrow(/only one of/i)
  })
})

describe('anthropicCompactBaseline.step — no compaction triggered', () => {
  test('single step: assistant text in response.content + tokens in TurnRecord', async () => {
    mockCreate = vi.fn().mockResolvedValue(
      fakeMessage('ready', { inputTokens: 100, outputTokens: 5 }),
    )
    const baseline = anthropicCompactBaseline({ apiKey: 'sk-fake' })
    const state = baseline.prepare(makeTask())
    const result = await baseline.step(state, makeUser('Say "ready"'))
    expect(result.response.role).toBe('assistant')
    const text = result.response.content.find((p) => p.type === 'text')?.text
    expect(text).toBe('ready')
    expect(result.telemetry.input_tokens).toBe(100)
    expect(result.telemetry.output_tokens).toBe(5)
    expect(result.telemetry.turn_index).toBe(0)
    expect(result.telemetry.compaction_events).toEqual([])
    // Cost back-filled via anthropicCostFromUsageWithCache:
    // input_tokens = 100 (uncached, non-cached), output_tokens = 5,
    // model = claude-sonnet-4-6 ($3/$15 per 1M, cache factors irrelevant here).
    // Expected = (100 * 3 + 5 * 15) / 1e6 = 0.000375
    expect(result.cost_usd).toBeCloseTo((100 * 3 + 5 * 15) / 1e6, 9)
  })

  test('step passes context_management.edits[compact_20260112] in request body', async () => {
    mockCreate = vi.fn().mockResolvedValue(fakeMessage('ok'))
    const baseline = anthropicCompactBaseline({
      apiKey: 'sk-fake',
      triggerInputTokens: 2500,
      instructions: 'Summarize tool outputs aggressively.',
    })
    const state = baseline.prepare(makeTask())
    await baseline.step(state, makeUser('hi'))
    expect(mockCreate).toHaveBeenCalledTimes(1)
    const firstCall = mockCreate.mock.calls[0]
    expect(firstCall).toBeDefined()
    if (!firstCall) return
    const req = firstCall[0] as {
      model: string
      max_tokens: number
      messages: unknown[]
      context_management: {
        edits: {
          type: string
          trigger?: { type: string; value: number }
          instructions?: string
        }[]
      }
    }
    expect(req.model).toBe('claude-sonnet-4-6')
    expect(req.context_management.edits).toHaveLength(1)
    const edit = req.context_management.edits[0]
    expect(edit?.type).toBe('compact_20260112')
    expect(edit?.trigger).toEqual({ type: 'input_tokens', value: 2500 })
    expect(edit?.instructions).toBe('Summarize tool outputs aggressively.')
  })

  test('cache tokens propagated when Anthropic reports them', async () => {
    mockCreate = vi.fn().mockResolvedValue({
      ...fakeMessage('ok'),
      usage: {
        input_tokens: 1200,
        output_tokens: 25,
        cache_read_input_tokens: 800,
        cache_creation_input_tokens: 0,
      },
    })
    const baseline = anthropicCompactBaseline({ apiKey: 'sk-fake' })
    const state = baseline.prepare(makeTask())
    const result = await baseline.step(state, makeUser('q'))
    expect(result.telemetry.cache_read_input_tokens).toBe(800)
    expect(result.telemetry.cache_creation_input_tokens).toBe(0)
  })

  test('cost_usd back-filled with cache_read discount (claude-sonnet-4-6: 10%)', async () => {
    // input_tokens = 1200 uncached + cache_read = 800 at 10% + cache_creation = 400 at 125%.
    // Effective input = 1200 + 80 + 500 = 1780. Cost = 1780 * $3/M + 25 * $15/M.
    mockCreate = vi.fn().mockResolvedValue({
      ...fakeMessage('ok'),
      usage: {
        input_tokens: 1200,
        output_tokens: 25,
        cache_read_input_tokens: 800,
        cache_creation_input_tokens: 400,
      },
    })
    const baseline = anthropicCompactBaseline({ apiKey: 'sk-fake' })
    const state = baseline.prepare(makeTask())
    const result = await baseline.step(state, makeUser('q'))
    const expected = ((1200 + 800 * 0.1 + 400 * 1.25) * 3 + 25 * 15) / 1e6
    expect(result.cost_usd).toBeCloseTo(expected, 9)
  })

  test('multi-step: history accumulates 2 per step + scratch.compaction_blocks stays empty when not triggered', async () => {
    mockCreate = vi
      .fn()
      .mockResolvedValueOnce(fakeMessage('a1'))
      .mockResolvedValueOnce(fakeMessage('a2'))
    const baseline = anthropicCompactBaseline({ apiKey: 'sk-fake' })
    let state = baseline.prepare(makeTask())
    state = (await baseline.step(state, makeUser('q1'))).state
    state = (await baseline.step(state, makeUser('q2'))).state
    expect(state.history).toHaveLength(4)
    expect(state.scratch?.['compaction_blocks']).toEqual([])
  })
})

describe('anthropicCompactBaseline.step — compaction triggered', () => {
  test('compaction block in response → compaction_event emitted with before/after bytes', async () => {
    // Pre-seed history to make beforeBytes > 0
    mockCreate = vi.fn().mockResolvedValue(
      fakeMessage('answer', {
        inputTokens: 4500,
        outputTokens: 10,
        compactionContent: 'Summary of prior context.',
      }),
    )
    const baseline = anthropicCompactBaseline({ apiKey: 'sk-fake' })
    const state = baseline.prepare(makeTask())
    const events: InstrumentationEvent[] = []
    const result = await baseline.step(
      state,
      makeUser('long input that hopefully triggers compact'),
      { instrumentation: (e) => events.push(e) },
    )
    expect(events).toHaveLength(1)
    const evt = events[0]
    expect(evt?.kind).toBe('compaction')
    if (evt?.kind !== 'compaction') return
    expect(evt.payload.type).toBe('reflection')
    expect(evt.payload.turn_index).toBe(0)
    expect(evt.payload.before_bytes).toBeGreaterThan(0)
    // 'Summary of prior context.' = 25 chars
    expect(evt.payload.after_bytes).toBe(25)
    expect(result.response.role).toBe('assistant')
  })

  test('compaction block stored in scratch for next step round-trip', async () => {
    mockCreate = vi.fn().mockResolvedValue(
      fakeMessage('answer', { compactionContent: 'compact-summary' }),
    )
    const baseline = anthropicCompactBaseline({ apiKey: 'sk-fake' })
    const state = baseline.prepare(makeTask())
    const result = await baseline.step(state, makeUser('q'))
    const blocks = result.state.scratch?.['compaction_blocks'] as
      | { content: string; encrypted_content: string }[]
      | undefined
    expect(blocks).toHaveLength(1)
    expect(blocks?.[0]?.content).toBe('compact-summary')
    expect(blocks?.[0]?.encrypted_content).toBe('enc-comp')
  })

  test('second step echoes stored compaction blocks in outgoing messages[0]', async () => {
    mockCreate = vi
      .fn()
      .mockResolvedValueOnce(
        fakeMessage('first', { compactionContent: 'stash-this' }),
      )
      .mockResolvedValueOnce(fakeMessage('second'))
    const baseline = anthropicCompactBaseline({ apiKey: 'sk-fake' })
    let state = baseline.prepare(makeTask())
    state = (await baseline.step(state, makeUser('q1'))).state
    await baseline.step(state, makeUser('q2'))

    // Second call's messages should start with a compaction block.
    const secondCall = mockCreate.mock.calls[1]
    expect(secondCall).toBeDefined()
    if (!secondCall) return
    const secondReq = secondCall[0] as {
      messages: {
        role: string
        content:
          | string
          | (
              | { type: 'text'; text: string }
              | { type: 'compaction'; content: string; encrypted_content: string }
            )[]
      }[]
    }
    expect(secondReq.messages.length).toBeGreaterThan(0)
    const firstMessage = secondReq.messages[0]
    expect(firstMessage?.role).toBe('user')
    expect(Array.isArray(firstMessage?.content)).toBe(true)
    if (typeof firstMessage?.content === 'string' || !firstMessage?.content) return
    const compactBlock = firstMessage.content.find((b) => b.type === 'compaction')
    expect(compactBlock).toBeDefined()
    if (!compactBlock) return
    expect(compactBlock.type).toBe('compaction')
    expect(compactBlock.content).toBe('stash-this')
  })
})

// Live integration test deliberately omitted: vi.mock is module-level and
// vi.importActual at runtime is brittle. Live verification path is manual —
// set ANTHROPIC_API_KEY and run `eval/sweeps/smoke_anthropic_compact.yaml`
// via `pnpm tsx scripts/eval.ts` (the registry resolver gates the real SDK
// usage by ANTHROPIC_API_KEY presence). Investigation doc records the
// rationale: docs/investigations/anthropic-compact-shape.md.
