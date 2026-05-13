import { describe, expect, test, vi } from 'vitest'
import { fullContextBaseline } from './full_context.js'
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
      model: 'google/gemini-3.1-flash-lite',
    })
    const state = baseline.prepare(makeTask())
    expect(state.task_id).toBe('t1')
    expect(state.history).toEqual([])
    expect(state.scratch?.['model']).toBe('google/gemini-3.1-flash-lite')
  })

  test('step adds user + assistant to history; TurnRecord populated with tokens', async () => {
    const llm = okLlm('answer', 100, 50)
    const baseline = fullContextBaseline({
      llmClient: llm,
      model: 'google/gemini-3.1-flash-lite',
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
      model: 'google/gemini-3.1-flash-lite',
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
      model: 'google/gemini-3.1-flash-lite',
    })
    const state = baseline.prepare(makeTask())
    await expect(baseline.step(state, makeUser('q'))).rejects.toThrow(/rate_limit/)
  })

  test('LLMRequest.messages includes prior history (full_context property)', async () => {
    const llm = okLlm('a', 10, 5)
    const baseline = fullContextBaseline({
      llmClient: llm,
      model: 'google/gemini-3.1-flash-lite',
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
})
