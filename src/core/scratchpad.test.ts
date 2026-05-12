import { describe, expect, test } from 'vitest'
import { createInMemoryScratchpad } from './scratchpad.js'
import type { AtomicGroup, Message } from './types.js'

const tu: Message = {
  role: 'assistant',
  content: [{ type: 'tool_use', tool_use_id: 'tu_1', name: 'search', input: {} }],
  metadata: { turn_index: 0, step_index: 1 },
}
const tr: Message = {
  role: 'tool',
  content: [{ type: 'tool_result', tool_use_id: 'tu_1', output: { ok: true } }],
  metadata: { turn_index: 0, step_index: 2 },
}
const group: AtomicGroup = {
  group_id: 'g_1',
  tool_use: tu,
  tool_result: tr,
  turn_index: 0,
}

describe('createInMemoryScratchpad', () => {
  test('put then get returns identical reference', () => {
    const pad = createInMemoryScratchpad<AtomicGroup>()
    pad.put(group.group_id, group)
    expect(pad.get(group.group_id)).toBe(group)
  })

  test('get of unknown id returns null', () => {
    const pad = createInMemoryScratchpad<AtomicGroup>()
    expect(pad.get('missing')).toBeNull()
  })

  test('size reflects put count', () => {
    const pad = createInMemoryScratchpad<AtomicGroup>()
    expect(pad.size()).toBe(0)
    pad.put('g_1', group)
    expect(pad.size()).toBe(1)
    pad.put('g_2', { ...group, group_id: 'g_2' })
    expect(pad.size()).toBe(2)
  })

  test('overwriting same id keeps size stable', () => {
    const pad = createInMemoryScratchpad<AtomicGroup>()
    pad.put('g_1', group)
    pad.put('g_1', { ...group, turn_index: 99 })
    expect(pad.size()).toBe(1)
    expect(pad.get('g_1')?.turn_index).toBe(99)
  })
})
