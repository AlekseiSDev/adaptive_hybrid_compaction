import { describe, expect, test } from 'vitest'
import { computeFeatures } from './classifierFeatures.js'
import type { Message } from './types.js'

const sysMsg = (): Message => ({ role: 'system', content: [{ type: 'text', text: 'be helpful' }] })
const userMsg = (s: string, turn: number): Message => ({
  role: 'user',
  content: [{ type: 'text', text: s }],
  metadata: { turn_index: turn, step_index: 0 },
})
const asstMsg = (s: string, turn: number): Message => ({
  role: 'assistant',
  content: [{ type: 'text', text: s }],
  metadata: { turn_index: turn, step_index: 0 },
})
const useMsg = (id: string, turn: number): Message => ({
  role: 'assistant',
  content: [{ type: 'tool_use', tool_use_id: id, name: 'search', input: { q: id } }],
  metadata: { turn_index: turn, step_index: 1 },
})
const resultMsg = (id: string, turn: number, output: unknown = { ok: true }): Message => ({
  role: 'tool',
  content: [{ type: 'tool_result', tool_use_id: id, output }],
  metadata: { turn_index: turn, step_index: 2 },
})
const imageMsg = (turn: number): Message => ({
  role: 'user',
  content: [{ type: 'image', mimeType: 'image/png', data: 'b64data' }],
  metadata: { turn_index: turn, step_index: 0 },
})

describe('computeFeatures', () => {
  test('tool_call_density = tool_uses_total / turns_total on 4-turn / 2-tool-use fixture', () => {
    const history: Message[] = [
      sysMsg(),
      userMsg('q0', 0),
      asstMsg('a0', 0),
      userMsg('q1', 1),
      useMsg('tu_1', 1),
      resultMsg('tu_1', 1),
      asstMsg('a1', 1),
      userMsg('q2', 2),
      asstMsg('a2', 2),
      userMsg('q3', 3),
      useMsg('tu_2', 3),
      resultMsg('tu_2', 3),
      asstMsg('a3', 3),
    ]
    const f = computeFeatures(history)
    expect(f.turns_total).toBe(4)
    expect(f.tool_call_density).toBeCloseTo(2 / 4, 5)
  })

  test('recent_tool_density counts tool_uses in last 3 turns only', () => {
    const history: Message[] = [
      sysMsg(),
      userMsg('q0', 0),
      useMsg('tu_a', 0),
      resultMsg('tu_a', 0),
      userMsg('q1', 1),
      asstMsg('a1', 1),
      userMsg('q2', 2),
      asstMsg('a2', 2),
      userMsg('q3', 3),
      useMsg('tu_b', 3),
      resultMsg('tu_b', 3),
      useMsg('tu_c', 3),
      resultMsg('tu_c', 3),
      asstMsg('a3', 3),
    ]
    const f = computeFeatures(history)
    expect(f.turns_total).toBe(4)
    expect(f.recent_tool_density).toBeCloseTo(2 / 3, 5)
  })

  test('user_turn_ratio = user messages / total messages', () => {
    const history: Message[] = [
      sysMsg(),
      userMsg('q0', 0),
      asstMsg('a0', 0),
      userMsg('q1', 1),
      asstMsg('a1', 1),
    ]
    const f = computeFeatures(history)
    expect(f.user_turn_ratio).toBeCloseTo(2 / 5, 5)
  })

  test('multimodal_flag is true iff any image or file ContentPart exists', () => {
    const textOnly: Message[] = [sysMsg(), userMsg('q', 0), asstMsg('a', 0)]
    expect(computeFeatures(textOnly).multimodal_flag).toBe(false)

    const withImage: Message[] = [sysMsg(), imageMsg(0), asstMsg('a', 0)]
    expect(computeFeatures(withImage).multimodal_flag).toBe(true)
  })

  test('turns_total derives from max metadata.turn_index + 1', () => {
    const history: Message[] = [
      sysMsg(),
      userMsg('q0', 0),
      userMsg('q5', 5),
      asstMsg('a5', 5),
    ]
    const f = computeFeatures(history)
    expect(f.turns_total).toBe(6)
  })

  test('avg_tool_result_size averages byte length of tool_result content', () => {
    const small = resultMsg('s', 0, { x: 'small' })
    const big = resultMsg('b', 0, { x: 'a much larger payload string that takes more bytes' })
    const history: Message[] = [sysMsg(), userMsg('q', 0), useMsg('s', 0), small, useMsg('b', 0), big]
    const f = computeFeatures(history)
    expect(f.avg_tool_result_size).toBeGreaterThan(0)
    // Two results — average should be > smallest and < largest individually
    const smallBytes = Buffer.byteLength(JSON.stringify(small.content), 'utf8')
    const bigBytes = Buffer.byteLength(JSON.stringify(big.content), 'utf8')
    expect(f.avg_tool_result_size).toBeCloseTo((smallBytes + bigBytes) / 2, 0)
  })

  test('cumulative_tokens is non-zero on non-empty history', () => {
    const history: Message[] = [sysMsg(), userMsg('hello world', 0), asstMsg('hi there', 0)]
    const f = computeFeatures(history)
    expect(f.cumulative_tokens).toBeGreaterThan(0)
  })
})
