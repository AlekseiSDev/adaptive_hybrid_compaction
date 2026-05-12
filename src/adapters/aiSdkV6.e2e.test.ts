import { describe, expect, test } from 'vitest'
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3FunctionTool,
  LanguageModelV3Message,
} from '@ai-sdk/provider'
import type { CoreEvent } from '../core/index.js'
import { createAhcMiddleware } from './ai-sdk-v6.js'

// Lightweight in-memory provider that records the prompts it sees and replies
// according to a scripted sequence. Returns deterministic short answers.
type MockState = {
  seenPrompts: LanguageModelV3Message[][]
  seenTools: string[][]
  replyCursor: number
  replies: readonly string[]
}

function createMockProvider(replies: readonly string[]): {
  state: MockState
  model: LanguageModelV3
} {
  const state: MockState = {
    seenPrompts: [],
    seenTools: [],
    replyCursor: 0,
    replies,
  }
  const model = {
    specificationVersion: 'v3',
    provider: 'mock',
    modelId: 'mock-test',
    supportedUrls: {},
    // eslint-disable-next-line @typescript-eslint/require-await
    doGenerate: async (params: LanguageModelV3CallOptions) => {
      state.seenPrompts.push([...params.prompt])
      const toolNames = (params.tools ?? [])
        .filter((t): t is LanguageModelV3FunctionTool => t.type === 'function')
        .map((t) => t.name)
      state.seenTools.push(toolNames)
      const text = state.replies[state.replyCursor++] ?? ''
      return {
        content: [{ type: 'text' as const, text }],
        finishReason: 'stop' as const,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        warnings: [],
      }
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    doStream: async () => {
      throw new Error('mock: doStream not used in E2E')
    },
  } as unknown as LanguageModelV3
  return { state, model }
}

const sys: LanguageModelV3Message = { role: 'system', content: 'You answer concisely.' }
const u = (s: string): LanguageModelV3Message => ({
  role: 'user',
  content: [{ type: 'text', text: s }],
})
const tc = (id: string): LanguageModelV3Message => ({
  role: 'assistant',
  content: [{ type: 'tool-call', toolCallId: id, toolName: 'search', input: { q: 'x' } }],
})
const tr = (id: string, val: unknown): LanguageModelV3Message => ({
  role: 'tool',
  content: [
    {
      type: 'tool-result',
      toolCallId: id,
      toolName: 'search',
      output: { type: 'json', value: val as never },
    },
  ],
})

describe('AI SDK v6 adapter E2E — 8-turn trajectory with one offload + recall', () => {
  test('scratchpad populated after offload turn; recall tool present on subsequent calls; tool_use_id consistency', async () => {
    const events: CoreEvent[] = []
    const middleware = createAhcMiddleware({
      flags: {
        TYPE_AWARE_OFFLOAD: true,
        RECALL_TOOL: true,
      },
      thresholds: { K_RECENT: 30 },
      configuredClass: 'tool_heavy',
      emit: (e) => events.push(e),
      sessionId: () => 'e2e-session',
    })

    // 8-turn trajectory: 4 turns with tool calls; first one has heavy output → offload.
    const heavy = 'H'.repeat(8000)
    const turn1: LanguageModelV3Message[] = [
      sys,
      u('search foo'),
      tc('tu_1'),
      tr('tu_1', { large: heavy }),
    ]
    const turn2: LanguageModelV3Message[] = [
      ...turn1,
      u('next q'),
      tc('tu_2'),
      tr('tu_2', 'small-2'),
    ]
    const turn3: LanguageModelV3Message[] = [
      ...turn2,
      u('and again'),
      tc('tu_3'),
      tr('tu_3', 'small-3'),
    ]
    const turn4: LanguageModelV3Message[] = [
      ...turn3,
      u('what was the heavy result?'),
      tc('tu_4'),
      tr('tu_4', 'small-4'),
    ]

    const { state, model } = createMockProvider(['reply-1', 'reply-2', 'reply-3', 'reply-4'])
    const stubParams = (prompt: LanguageModelV3Message[]): LanguageModelV3CallOptions => ({
      prompt,
      tools: [],
    })

    for (const traj of [turn1, turn2, turn3, turn4]) {
      const transformed = await middleware.transformParams?.({
        type: 'generate',
        params: stubParams(traj),
        model,
      })
      expect(transformed).toBeDefined()
      if (transformed === undefined) continue
      await model.doGenerate(transformed)
    }

    // 1. At least one offload event emitted.
    const offloadEvents = events.filter((e) => e.kind === 'compaction' && e.type === 'offload')
    expect(offloadEvents.length).toBeGreaterThanOrEqual(1)

    // 2. Recall tool present in tools on at least one of the calls after offload.
    const recallSeen = state.seenTools.some((names) => names.includes('recall_tool_result'))
    expect(recallSeen).toBe(true)

    // 3. Tool_use_id consistency: scratchpad pointer for tu_1 appears in the prompt sent
    //    to the provider on a later call (as a "[Offloaded tool_result #tu_1..." string).
    const allSerialized = state.seenPrompts.map((p) => JSON.stringify(p)).join('\n')
    expect(allSerialized).toContain('tu_1')
    // The pointer placeholder text from the offloader includes "Offloaded tool_result".
    expect(allSerialized).toContain('Offloaded tool_result')
  })
})
