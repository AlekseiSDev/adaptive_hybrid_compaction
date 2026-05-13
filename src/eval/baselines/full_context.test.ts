import { describe, expect, test, vi } from 'vitest'
import { fullContextBaseline } from './full_context.js'
import { createOpenRouterClient } from '../llm.js'
import type {
  LLMClient,
  Message,
  Task,
} from '../types.js'

const makeTask = (): Task => ({ id: 't1', input: 'q', expected: 'y' })

const makeUser = (text: string): Message => ({
  role: 'user',
  content: [{ type: 'text', text }],
})

const okLlm = (text: string, prompt = 100, completion = 50): LLMClient =>
  vi.fn().mockResolvedValue({
    text,
    raw_usage: { prompt_tokens: prompt, completion_tokens: completion },
    finish_reason: 'stop',
    latency_ms: 10,
  })

describe('fullContextBaseline', () => {
  test('prepare → state with task_id, empty history, scratch.model', () => {
    const baseline = fullContextBaseline({
      llmClient: okLlm('hi'),
      model: 'google/gemini-3-flash-preview',
    })
    const state = baseline.prepare(makeTask())
    expect(state.task_id).toBe('t1')
    expect(state.history).toEqual([])
    expect(state.scratch?.['model']).toBe('google/gemini-3-flash-preview')
  })

  test('step adds user + assistant to history; TurnRecord populated with tokens', async () => {
    const llm = okLlm('answer', 100, 50)
    const baseline = fullContextBaseline({
      llmClient: llm,
      model: 'google/gemini-3-flash-preview',
    })
    const state0 = baseline.prepare(makeTask())
    const result = await baseline.step(state0, makeUser('q1'))

    expect(result.state.history).toHaveLength(2)
    expect(result.state.history[0]?.role).toBe('user')
    expect(result.state.history[1]?.role).toBe('assistant')
    expect(result.response.role).toBe('assistant')
    expect(result.telemetry.input_tokens).toBe(100)
    expect(result.telemetry.output_tokens).toBe(50)
    expect(result.telemetry.turn_index).toBe(0)
    expect(result.telemetry.recall_events).toEqual([])
    expect(result.telemetry.compaction_events).toEqual([])
    expect(result.cost_usd).toBeGreaterThan(0)
  })

  test('multiple steps grow history (length == 2*N after N turns)', async () => {
    const baseline = fullContextBaseline({
      llmClient: okLlm('reply', 50, 25),
      model: 'google/gemini-3-flash-preview',
    })
    let state = baseline.prepare(makeTask())
    state = (await baseline.step(state, makeUser('q1'))).state
    state = (await baseline.step(state, makeUser('q2'))).state
    state = (await baseline.step(state, makeUser('q3'))).state
    expect(state.history).toHaveLength(6)
  })

  test('step throws on LLM error (caller — buildRunnerFromBaseline — catches)', async () => {
    const errLlm: LLMClient = vi.fn().mockResolvedValue({
      text: '',
      raw_usage: null,
      finish_reason: 'error',
      latency_ms: 5,
      error: { kind: 'rate_limit', message: 'too many' },
    })
    const baseline = fullContextBaseline({
      llmClient: errLlm,
      model: 'google/gemini-3-flash-preview',
    })
    const state = baseline.prepare(makeTask())
    await expect(baseline.step(state, makeUser('q'))).rejects.toThrow(/rate_limit/)
  })

  test('LLMRequest.messages includes prior history (full_context property)', async () => {
    const llm = okLlm('a', 10, 5)
    const baseline = fullContextBaseline({
      llmClient: llm,
      model: 'google/gemini-3-flash-preview',
      systemPrompt: '', // disable auto-prepended system msg for this property test
    })
    let state = baseline.prepare(makeTask())
    state = (await baseline.step(state, makeUser('q1'))).state
    await baseline.step(state, makeUser('q2'))
    // Second call — should include q1 + assistant + q2 (3 messages).
    expect(llm).toHaveBeenCalledTimes(2)
    const firstCall = (llm as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as
      | { messages: { role: string; content: string }[] }
      | undefined
    const secondCall = (llm as ReturnType<typeof vi.fn>).mock.calls[1]?.[0] as
      | { messages: { role: string; content: string }[] }
      | undefined
    expect(firstCall?.messages).toHaveLength(1)
    expect(secondCall?.messages).toHaveLength(3)
    expect(secondCall?.messages[0]?.content).toBe('q1')
    expect(secondCall?.messages[1]?.role).toBe('assistant')
    expect(secondCall?.messages[2]?.content).toBe('q2')
  })

  test('systemPrompt is prepended as {role:"system"} when non-empty (default behavior)', async () => {
    const llm = okLlm('a', 10, 5)
    const baseline = fullContextBaseline({
      llmClient: llm,
      model: 'google/gemini-3-flash-preview',
      systemPrompt: 'You are an agent.',
    })
    const state = baseline.prepare(makeTask())
    await baseline.step(state, makeUser('hello'))
    const firstCall = (llm as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as
      | { messages: { role: string; content: string }[] }
      | undefined
    expect(firstCall?.messages).toHaveLength(2)
    expect(firstCall?.messages[0]?.role).toBe('system')
    expect(firstCall?.messages[0]?.content).toBe('You are an agent.')
    expect(firstCall?.messages[1]?.content).toBe('hello')
  })
})

// Real-LLM integration test (skip-marked: needs OPENROUTER_API_KEY in env).
// Per memory feedback "real-LLM-early": pin-recall trajectory validates the
// full_context property end-to-end — recall must succeed because history
// is passed verbatim, no compaction. Input tokens grow turn-over-turn.
const LIVE = Boolean(process.env['OPENROUTER_API_KEY'])
const liveDescribe = LIVE ? describe : describe.skip

liveDescribe('fullContextBaseline.step — real OpenRouter integration', () => {
  test(
    'three-turn pin-recall trajectory: seed fact → distractor → recall',
    async () => {
      const llmClient = createOpenRouterClient({
        apiKey: process.env['OPENROUTER_API_KEY'] ?? '',
        appName: 'AHC-test',
      })
      const baseline = fullContextBaseline({
        llmClient,
        model: 'google/gemini-3-flash-preview',
      })
      let state = baseline.prepare({
        id: 'live-fc-pin',
        input: 'x',
        expected: 'y',
      })

      const r1 = await baseline.step(
        state,
        makeUser('Remember: my pin code is 4271. Just acknowledge it.'),
      )
      state = r1.state
      const r2 = await baseline.step(
        state,
        makeUser('Unrelated: what is 2 plus 2?'),
      )
      state = r2.state
      const r3 = await baseline.step(
        state,
        makeUser('What pin code did I tell you earlier? Reply with just the digits.'),
      )
      state = r3.state

      const text3 =
        r3.response.content.find((p) => p.type === 'text')?.text ?? ''
      expect(text3).toContain('4271')
      expect(state.history).toHaveLength(6)
      // Full-context invariant: input grows turn-over-turn (no compaction).
      expect(r3.telemetry.input_tokens).toBeGreaterThan(r1.telemetry.input_tokens)
    },
    60_000,
  )
})
