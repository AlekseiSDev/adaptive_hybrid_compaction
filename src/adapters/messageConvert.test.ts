import { describe, expect, test } from 'vitest'
import {
  convertCoreMessagesToSdk,
  convertSdkPromptToCore,
} from './messageConvert.js'
import type { Message } from '../core/index.js'

describe('messageConvert — core ↔ AI SDK v3 prompt', () => {
  test('system message: core ContentPart[] ↔ SDK string', () => {
    const core: Message = {
      role: 'system',
      content: [{ type: 'text', text: 'you are helpful' }],
    }
    const sdk = convertCoreMessagesToSdk([core])
    expect(sdk[0]).toEqual({ role: 'system', content: 'you are helpful' })
    const back = convertSdkPromptToCore(sdk)
    expect(back[0]).toEqual(core)
  })

  test('user text part round-trip', () => {
    const core: Message = {
      role: 'user',
      content: [{ type: 'text', text: 'hello world' }],
      metadata: { turn_index: 1, step_index: 0 },
    }
    const sdk = convertCoreMessagesToSdk([core])
    expect(sdk[0]?.role).toBe('user')
    if (sdk[0]?.role === 'user') {
      expect(sdk[0].content).toEqual([{ type: 'text', text: 'hello world' }])
    }
    const back = convertSdkPromptToCore(sdk)
    expect(back[0]?.role).toBe('user')
    expect(back[0]?.content).toEqual(core.content)
  })

  test('assistant tool_use → SDK tool-call (id + name maps)', () => {
    const core: Message = {
      role: 'assistant',
      content: [
        { type: 'tool_use', tool_use_id: 'call_42', name: 'search', input: { q: 'hi' } },
      ],
      metadata: { turn_index: 2, step_index: 1 },
    }
    const sdk = convertCoreMessagesToSdk([core])
    expect(sdk[0]?.role).toBe('assistant')
    if (sdk[0]?.role === 'assistant') {
      const part = sdk[0].content[0]
      expect(part?.type).toBe('tool-call')
      if (part?.type === 'tool-call') {
        expect(part.toolCallId).toBe('call_42')
        expect(part.toolName).toBe('search')
        expect(part.input).toEqual({ q: 'hi' })
      }
    }
  })

  test('tool tool_result → SDK tool-result (output wrapped as json)', () => {
    const core: Message = {
      role: 'tool',
      content: [
        { type: 'tool_result', tool_use_id: 'call_42', output: { rows: 3 } },
      ],
      metadata: { turn_index: 2, step_index: 2 },
    }
    const sdk = convertCoreMessagesToSdk([core])
    expect(sdk[0]?.role).toBe('tool')
    if (sdk[0]?.role === 'tool') {
      const part = sdk[0].content[0]
      expect(part?.type).toBe('tool-result')
      if (part?.type === 'tool-result') {
        expect(part.toolCallId).toBe('call_42')
        expect(part.output).toEqual({ type: 'json', value: { rows: 3 } })
      }
    }
  })

  test('SDK tool-result with text output → core tool_result output string', () => {
    const sdk = [
      {
        role: 'tool' as const,
        content: [
          {
            type: 'tool-result' as const,
            toolCallId: 'call_99',
            toolName: 'lookup',
            output: { type: 'text' as const, value: 'plain answer' },
          },
        ],
      },
    ]
    const core = convertSdkPromptToCore(sdk)
    expect(core[0]?.content[0]).toEqual({
      type: 'tool_result',
      tool_use_id: 'call_99',
      output: 'plain answer',
    })
  })

  test('round-trip identity: core → sdk → core preserves shape for simple convo', () => {
    const original: Message[] = [
      { role: 'system', content: [{ type: 'text', text: 'sys' }] },
      {
        role: 'user',
        content: [{ type: 'text', text: 'q' }],
        metadata: { turn_index: 0, step_index: 0 },
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'a' }],
        metadata: { turn_index: 0, step_index: 1 },
      },
    ]
    const round = convertSdkPromptToCore(convertCoreMessagesToSdk(original))
    // Note: metadata is dropped through SDK (SDK has no concept of it).
    // We assert content + role match.
    expect(round.map((m) => ({ role: m.role, content: m.content }))).toEqual(
      original.map((m) => ({ role: m.role, content: m.content })),
    )
  })
})
