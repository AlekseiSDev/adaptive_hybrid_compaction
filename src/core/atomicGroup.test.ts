import { describe, expect, test } from 'vitest'
import { hashAtomicGroupId, parseAtomicGroups } from './atomicGroup.js'
import type { Message } from './types.js'

const text = (s: string): Message['content'][number] => ({ type: 'text', text: s })

const useMsg = (id: string, turn: number, step = 1, extraText?: string): Message => ({
  role: 'assistant',
  content: [
    ...(extraText !== undefined ? [text(extraText)] : []),
    { type: 'tool_use', tool_use_id: id, name: 'search', input: { q: id } },
  ],
  metadata: { turn_index: turn, step_index: step },
})

const resultMsg = (id: string, turn: number, step = 2): Message => ({
  role: 'tool',
  content: [{ type: 'tool_result', tool_use_id: id, output: { ok: id } }],
  metadata: { turn_index: turn, step_index: step },
})

const assistantText = (s: string, turn: number, step = 0): Message => ({
  role: 'assistant',
  content: [text(s)],
  metadata: { turn_index: turn, step_index: step },
})

describe('hashAtomicGroupId', () => {
  test('group_id is deterministic for same toolUseId+turnIndex', () => {
    expect(hashAtomicGroupId('tu_1', 4)).toBe(hashAtomicGroupId('tu_1', 4))
  })

  test('group_id differs across turn indices for same toolUseId', () => {
    expect(hashAtomicGroupId('tu_1', 4)).not.toBe(hashAtomicGroupId('tu_1', 5))
  })
})

describe('parseAtomicGroups', () => {
  test('pairs tool_use with tool_result by tool_use_id', () => {
    const messages: Message[] = [useMsg('tu_1', 0), resultMsg('tu_1', 0)]
    const out = parseAtomicGroups(messages)
    expect(out.groups).toHaveLength(1)
    const [g] = out.groups
    expect(g?.tool_use).toBe(messages[0])
    expect(g?.tool_result).toBe(messages[1])
    expect(g?.turn_index).toBe(0)
    expect(g?.group_id).toBe(hashAtomicGroupId('tu_1', 0))
    expect(out.inflight).toHaveLength(0)
    expect(out.orphans).toHaveLength(0)
  })

  test('attaches adjacent assistant text as reasoning_chunk (same message)', () => {
    const messages: Message[] = [useMsg('tu_1', 0, 1, 'thinking about search'), resultMsg('tu_1', 0)]
    const out = parseAtomicGroups(messages)
    const [g] = out.groups
    expect(g?.reasoning_chunk).toBeDefined()
    expect(g?.reasoning_chunk?.role).toBe('assistant')
    const reasoningContent = g?.reasoning_chunk?.content ?? []
    expect(reasoningContent[0]).toEqual({ type: 'text', text: 'thinking about search' })
  })

  test('attaches adjacent assistant text as reasoning_chunk (preceding message)', () => {
    const messages: Message[] = [
      assistantText('let me look that up', 0),
      useMsg('tu_1', 0),
      resultMsg('tu_1', 0),
    ]
    const out = parseAtomicGroups(messages)
    const [g] = out.groups
    expect(g?.reasoning_chunk).toBe(messages[0])
  })

  test('unmatched tool_use produces InflightToolUse entry', () => {
    const messages: Message[] = [useMsg('tu_1', 0)]
    const out = parseAtomicGroups(messages)
    expect(out.groups).toHaveLength(0)
    expect(out.inflight).toHaveLength(1)
    const [inf] = out.inflight
    expect(inf?.tool_use).toBe(messages[0])
    expect(inf?.turn_index).toBe(0)
    expect(inf?.group_id).toBe(hashAtomicGroupId('tu_1', 0))
  })

  test('unmatched tool_result is reported as orphan, not thrown', () => {
    const messages: Message[] = [resultMsg('tu_ghost', 0)]
    expect(() => parseAtomicGroups(messages)).not.toThrow()
    const out = parseAtomicGroups(messages)
    expect(out.groups).toHaveLength(0)
    expect(out.orphans).toHaveLength(1)
    expect(out.orphans[0]).toBe(messages[0])
  })

  test('multiple atomic groups in one turn preserve original order', () => {
    const messages: Message[] = [
      useMsg('tu_a', 0, 1),
      resultMsg('tu_a', 0, 2),
      useMsg('tu_b', 0, 3),
      resultMsg('tu_b', 0, 4),
      useMsg('tu_c', 0, 5),
      resultMsg('tu_c', 0, 6),
    ]
    const out = parseAtomicGroups(messages)
    expect(out.groups).toHaveLength(3)
    expect(out.groups.map((g) => g.tool_use.content[0])).toEqual([
      expect.objectContaining({ tool_use_id: 'tu_a' }),
      expect.objectContaining({ tool_use_id: 'tu_b' }),
      expect.objectContaining({ tool_use_id: 'tu_c' }),
    ])
  })
})
