import { describe, expect, test, vi } from 'vitest'
import { buildRunnerFromBaseline } from './baseline.js'
import type {
  Baseline,
  BaselineState,
  Conversation,
  InstrumentationEvent,
  Message,
  RunnerContext,
  Task,
  TurnRecord,
} from './types.js'

const makeTask = (id = 't1'): Task => ({
  id,
  input: 'hi',
  expected: 'hello',
})

const makeUser = (text: string): Message => ({
  role: 'user',
  content: [{ type: 'text', text }],
})

const makeAssistant = (text: string): Message => ({
  role: 'assistant',
  content: [{ type: 'text', text }],
})

const makeCtx = (task: Task = makeTask()): RunnerContext => ({
  bench: 'synthetic',
  config: { id: 'test' },
  seed: 42,
  task,
})

const makeTurn = (turn_index: number): TurnRecord => ({
  turn_index,
  input_tokens: 10,
  output_tokens: 5,
  wall_clock_ms: 1,
  recall_events: [],
  compaction_events: [],
})

describe('buildRunnerFromBaseline', () => {
  test('exposes baseline.name as Runner.name', () => {
    const baseline: Baseline = {
      name: 'mock_baseline',
      prepare: (task) => ({ task_id: task.id, history: [] }),
      step: (state, userMsg) =>
        Promise.resolve({
          response: makeAssistant('ok'),
          state: {
            ...state,
            history: [...state.history, userMsg, makeAssistant('ok')],
          } satisfies BaselineState,
          telemetry: makeTurn(0),
          cost_usd: 0.01,
        }),
    }
    const runner = buildRunnerFromBaseline(baseline)
    expect(runner.name).toBe('mock_baseline')
  })

  test('single-user-message conversation → 1 turn produced', async () => {
    const baseline: Baseline = {
      name: 'mock',
      prepare: (task) => ({ task_id: task.id, history: [] }),
      step: (state, userMsg) =>
        Promise.resolve({
          response: makeAssistant('answer'),
          state: {
            ...state,
            history: [...state.history, userMsg, makeAssistant('answer')],
          },
          telemetry: makeTurn(0),
          cost_usd: 0.005,
        }),
    }
    const runner = buildRunnerFromBaseline(baseline)
    const conv: Conversation = { messages: [makeUser('q')] }
    const result = await runner.execute(conv, makeCtx())
    expect(result.turns).toHaveLength(1)
    expect(result.text).toBe('answer')
    expect(result.cost_usd).toBe(0.005)
    expect(result.totals.input).toBe(10)
    expect(result.totals.output).toBe(5)
    expect(result.errors).toHaveLength(0)
  })

  test('multi-user-message conversation → loop, totals sum, last response wins', async () => {
    let stepCount = 0
    const baseline: Baseline = {
      name: 'multi',
      prepare: (task) => ({ task_id: task.id, history: [] }),
      step: (state, userMsg) => {
        const idx = stepCount
        stepCount += 1
        const a = makeAssistant(`a${String(idx)}`)
        return Promise.resolve({
          response: a,
          state: { ...state, history: [...state.history, userMsg, a] },
          telemetry: makeTurn(idx),
          cost_usd: 0.01,
        })
      },
    }
    const runner = buildRunnerFromBaseline(baseline)
    const conv: Conversation = {
      messages: [makeUser('q1'), makeUser('q2'), makeUser('q3')],
    }
    const result = await runner.execute(conv, makeCtx())
    expect(result.turns).toHaveLength(3)
    expect(result.text).toBe('a2')
    expect(result.cost_usd).toBeCloseTo(0.03, 5)
    expect(result.totals.input).toBe(30)
  })

  test('non-user messages in Conversation are skipped', async () => {
    let stepCount = 0
    const baseline: Baseline = {
      name: 'skipper',
      prepare: (task) => ({ task_id: task.id, history: [] }),
      step: (state, userMsg) => {
        stepCount += 1
        return Promise.resolve({
          response: makeAssistant('ok'),
          state: { ...state, history: [...state.history, userMsg, makeAssistant('ok')] },
          telemetry: makeTurn(stepCount - 1),
          cost_usd: 0,
        })
      },
    }
    const runner = buildRunnerFromBaseline(baseline)
    const conv: Conversation = {
      messages: [
        { role: 'system', content: [{ type: 'text', text: 'sys' }] },
        makeUser('q1'),
        makeAssistant('prior'),
        makeUser('q2'),
      ],
    }
    await runner.execute(conv, makeCtx())
    expect(stepCount).toBe(2)
  })

  test('finalize called on success', async () => {
    const finalize = vi.fn(() => Promise.resolve())
    const baseline: Baseline = {
      name: 'final_ok',
      prepare: (task) => ({ task_id: task.id, history: [] }),
      step: (state, userMsg) =>
        Promise.resolve({
          response: makeAssistant('ok'),
          state: { ...state, history: [...state.history, userMsg, makeAssistant('ok')] },
          telemetry: makeTurn(0),
          cost_usd: 0,
        }),
      finalize,
    }
    const runner = buildRunnerFromBaseline(baseline)
    await runner.execute({ messages: [makeUser('q')] }, makeCtx())
    expect(finalize).toHaveBeenCalledOnce()
  })

  test('finalize called on step error (try/finally); error captured in RunnerResponse.errors', async () => {
    const finalize = vi.fn(() => Promise.resolve())
    const baseline: Baseline = {
      name: 'failing',
      prepare: (task) => ({ task_id: task.id, history: [] }),
      step: () => Promise.reject(new Error('llm boom')),
      finalize,
    }
    const runner = buildRunnerFromBaseline(baseline)
    const result = await runner.execute({ messages: [makeUser('q')] }, makeCtx())
    expect(finalize).toHaveBeenCalledOnce()
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]?.kind).toBe('api_error')
    expect(result.errors[0]?.message).toBe('llm boom')
    expect(result.turns).toHaveLength(0)
  })

  test('ctx.instrumentation forwarded to baseline.step opts', async () => {
    const events: InstrumentationEvent[] = []
    const baseline: Baseline = {
      name: 'emit',
      prepare: (task) => ({ task_id: task.id, history: [] }),
      step: (state, userMsg, opts) => {
        opts?.instrumentation?.({
          kind: 'compaction',
          payload: {
            type: 'offload',
            turn_index: 0,
            before_bytes: 1000,
            after_bytes: 100,
          },
        })
        return Promise.resolve({
          response: makeAssistant('ok'),
          state: { ...state, history: [...state.history, userMsg, makeAssistant('ok')] },
          telemetry: makeTurn(0),
          cost_usd: 0,
        })
      },
    }
    const runner = buildRunnerFromBaseline(baseline)
    const ctx: RunnerContext = {
      ...makeCtx(),
      instrumentation: (e) => events.push(e),
    }
    await runner.execute({ messages: [makeUser('q')] }, ctx)
    expect(events).toHaveLength(1)
    expect(events[0]?.kind).toBe('compaction')
  })

  test('finalize errors are swallowed but logged (does not mask step success)', async () => {
    const finalize = vi.fn(() => Promise.reject(new Error('cleanup boom')))
    const baseline: Baseline = {
      name: 'flaky_finalize',
      prepare: (task) => ({ task_id: task.id, history: [] }),
      step: (state, userMsg) =>
        Promise.resolve({
          response: makeAssistant('ok'),
          state: { ...state, history: [...state.history, userMsg, makeAssistant('ok')] },
          telemetry: makeTurn(0),
          cost_usd: 0,
        }),
      finalize,
    }
    const runner = buildRunnerFromBaseline(baseline)
    const result = await runner.execute({ messages: [makeUser('q')] }, makeCtx())
    expect(finalize).toHaveBeenCalledOnce()
    expect(result.turns).toHaveLength(1)
    expect(result.text).toBe('ok')
  })
})
