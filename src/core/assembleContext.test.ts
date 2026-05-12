import { describe, expect, test } from 'vitest'
import { assembleContext, renderObservationsAsNote } from './assembleContext.js'
import type { Message, Observation, Tier1, Tier2, Tier3 } from './types.js'

const sysMsg: Message = {
  role: 'system',
  content: [{ type: 'text', text: 'be helpful' }],
}
const userMsg = (s: string, turn = 0, step = 0): Message => ({
  role: 'user',
  content: [{ type: 'text', text: s }],
  metadata: { turn_index: turn, step_index: step },
})
const asstMsg = (s: string, turn = 0, step = 0): Message => ({
  role: 'assistant',
  content: [{ type: 'text', text: s }],
  metadata: { turn_index: turn, step_index: step },
})
const useMsg = (id: string, turn: number): Message => ({
  role: 'assistant',
  content: [{ type: 'tool_use', tool_use_id: id, name: 'search', input: {} }],
  metadata: { turn_index: turn, step_index: 1 },
})

const tier1 = (): Tier1 => ({
  systemPrompt: sysMsg,
  toolDefinitions: [],
  firstUserMessages: [userMsg('initial q', 0, 0)],
})

const emptyTier2 = (): Tier2 => ({
  observations: [],
  pointers: [],
  classSignal: { class: 'mixed', confidence: 0, updatedAt: 0 },
})

const tier3Of = (recent: Message[], inflight: Tier3['inflight'] = []): Tier3 => ({
  recent,
  inflight,
})

describe('assembleContext', () => {
  test('empty tier2 → no synthetic note; output = sys + firstUser + tier3.recent', () => {
    const t1 = tier1()
    const t3 = tier3Of([userMsg('q2', 1), asstMsg('a2', 1, 2)])
    const assembled = assembleContext(t1, emptyTier2(), t3)
    expect(assembled).toEqual([t1.systemPrompt, ...t1.firstUserMessages, ...t3.recent])
  })

  test('non-empty observations → synthetic system note inserted between firstUserMessages and tier3.recent', () => {
    const obs: Observation[] = [
      { timestamp: 1700000010, confidence: 'high', statement: 'user wants concise output', sourceTurn: 1 },
      { timestamp: 1700000050, confidence: 'med', statement: 'follow up about auth', sourceTurn: 2 },
    ]
    const t1 = tier1()
    const t2: Tier2 = { ...emptyTier2(), observations: obs }
    const t3 = tier3Of([asstMsg('latest', 3)])
    const assembled = assembleContext(t1, t2, t3)
    // [sys, firstUser..., syntheticNote, tier3.recent...]
    expect(assembled[0]).toBe(t1.systemPrompt)
    expect(assembled[1]).toBe(t1.firstUserMessages[0])
    const note = assembled[2]
    expect(note?.role).toBe('system')
    const noteText = note?.content[0]
    expect(noteText?.type).toBe('text')
    if (noteText?.type === 'text') {
      expect(noteText.text).toContain('user wants concise output')
      expect(noteText.text).toContain('follow up about auth')
    }
    expect(assembled[3]).toBe(t3.recent[0])
  })

  test('observations rendered in deterministic timestamp ascending order', () => {
    const obs: Observation[] = [
      { timestamp: 1700000200, confidence: 'low', statement: 'C-third', sourceTurn: 3 },
      { timestamp: 1700000100, confidence: 'high', statement: 'A-first', sourceTurn: 1 },
      { timestamp: 1700000150, confidence: 'med', statement: 'B-second', sourceTurn: 2 },
    ]
    const text = renderObservationsAsNote(obs)
    const iA = text.indexOf('A-first')
    const iB = text.indexOf('B-second')
    const iC = text.indexOf('C-third')
    expect(iA).toBeGreaterThan(-1)
    expect(iB).toBeGreaterThan(iA)
    expect(iC).toBeGreaterThan(iB)
  })

  test('inflight tool_use messages appended after tier3.recent', () => {
    const t1 = tier1()
    const t3 = tier3Of(
      [asstMsg('done thinking', 4)],
      [{ group_id: 'g_42', tool_use: useMsg('tu_42', 4), turn_index: 4 }],
    )
    const assembled = assembleContext(t1, emptyTier2(), t3)
    const recent0 = t3.recent[0]
    const inflight0 = t3.inflight[0]
    if (recent0 === undefined || inflight0 === undefined) throw new Error('fixture invariant')
    expect(assembled[assembled.length - 1]).toBe(inflight0.tool_use)
    const idxRecent = assembled.indexOf(recent0)
    const idxInflight = assembled.indexOf(inflight0.tool_use)
    expect(idxInflight).toBeGreaterThan(idxRecent)
  })
})
