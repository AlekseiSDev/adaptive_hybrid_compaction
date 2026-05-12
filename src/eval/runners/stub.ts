import type { Baseline, BaselineStepResult, Message, Task } from '../types.js'

// Stub Baseline impls — used by smoke.yaml regression path (no LLM, no API key).
// Echo task.expected as assistant response → grader scores 1.
//
// noop_baseline: placeholder for "any baseline" smoke; echoes expected.
// noop_ahc: placeholder for AHC integration. Replace when A6 wiring lands —
// at that point this runner becomes a real ahc_core runner that wraps
// createAhcMiddleware (src/adapters/ai-sdk-v6.ts).

function makeEchoStep(): Baseline['step'] {
  return (state, userMsg, _opts): Promise<BaselineStepResult> => {
    const expected = (state.scratch?.['expected'] as string | undefined) ?? ''
    const responseMsg: Message = {
      role: 'assistant',
      content: [{ type: 'text', text: expected }],
    }
    const turn_index = state.history.filter((m) => m.role === 'user').length
    return Promise.resolve({
      response: responseMsg,
      state: {
        ...state,
        history: [...state.history, userMsg, responseMsg],
      },
      telemetry: {
        turn_index,
        input_tokens: 0,
        output_tokens: 0,
        wall_clock_ms: 0,
        recall_events: [],
        compaction_events: [],
      },
      cost_usd: 0,
    })
  }
}

function makeStubBaseline(name: string): Baseline {
  return {
    name,
    prepare: (task: Task) => ({
      task_id: task.id,
      history: [],
      scratch: { expected: String(task.expected) },
    }),
    step: makeEchoStep(),
  }
}

export const noopBaseline = (): Baseline => makeStubBaseline('noop_baseline')
export const noopAhcBaseline = (): Baseline => makeStubBaseline('noop_ahc')
