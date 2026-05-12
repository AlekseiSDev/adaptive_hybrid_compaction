import { describe, expect, test } from 'vitest'
import { compactWithOffload, shouldOffload } from './offloader.js'
import { createInMemoryScratchpad } from './scratchpad.js'
import { defaultFeatureFlags } from './featureFlags.js'
import { defaultThresholds } from './thresholds.js'
import { byteLengthOfContent } from './tokenCounter.js'
import type { AtomicGroup, CompactionContext, Message, TrajectoryClass } from './types.js'

const useMsg = (id: string, turn = 0, step = 1): Message => ({
  role: 'assistant',
  content: [{ type: 'tool_use', tool_use_id: id, name: 'search', input: {} }],
  metadata: { turn_index: turn, step_index: step },
})

const resultMsg = (id: string, output: unknown, turn = 0, step = 2): Message => ({
  role: 'tool',
  content: [{ type: 'tool_result', tool_use_id: id, output }],
  metadata: { turn_index: turn, step_index: step },
})

const group = (id: string, output: unknown, turn = 0): AtomicGroup => ({
  group_id: `g_${id}`,
  tool_use: useMsg(id, turn),
  tool_result: resultMsg(id, output, turn),
  turn_index: turn,
})

const ctx = (overrides: Partial<CompactionContext> = {}): CompactionContext => ({
  flags: defaultFeatureFlags,
  groups_after_this: 0, // unused in compactWithOffload — computed per-group
  cumulative_kept_tool_result_bytes: 0,
  current_class: 'tool_heavy',
  thresholds: defaultThresholds,
  ...overrides,
})

const bigOutput = { data: 'x'.repeat(5000) }

describe('shouldOffload (§5.2)', () => {
  test('groups_after_this < 2 → false even when oversized (always-keep-last-2)', () => {
    const g = group('big', bigOutput)
    expect(shouldOffload(g, ctx({ groups_after_this: 1 }), byteLengthOfContent)).toBe(false)
    expect(shouldOffload(g, ctx({ groups_after_this: 0 }), byteLengthOfContent)).toBe(false)
  })

  test('bytes(tool_result) > T_SIZE → true', () => {
    const g = group('big', bigOutput)
    expect(byteLengthOfContent(g.tool_result.content)).toBeGreaterThan(defaultThresholds.T_SIZE)
    expect(shouldOffload(g, ctx({ groups_after_this: 5 }), byteLengthOfContent)).toBe(true)
  })

  test('cumulative_kept + size > T_CUM → true', () => {
    const small = { ok: true }
    const g = group('small', small)
    const size = byteLengthOfContent(g.tool_result.content)
    const cumulative = defaultThresholds.T_CUM - size + 1
    expect(
      shouldOffload(
        g,
        ctx({ groups_after_this: 5, cumulative_kept_tool_result_bytes: cumulative }),
        byteLengthOfContent,
      ),
    ).toBe(true)
  })

  test('current_class=mixed uses T_SIZE_MIXED (2KB) instead of T_SIZE (4KB)', () => {
    const midOutput = { data: 'x'.repeat(2500) }
    const g = group('mid', midOutput)
    const size = byteLengthOfContent(g.tool_result.content)
    expect(size).toBeGreaterThan(defaultThresholds.T_SIZE_MIXED)
    expect(size).toBeLessThan(defaultThresholds.T_SIZE)
    expect(
      shouldOffload(g, ctx({ groups_after_this: 5, current_class: 'tool_heavy' }), byteLengthOfContent),
    ).toBe(false)
    expect(
      shouldOffload(
        g,
        ctx({ groups_after_this: 5, current_class: 'mixed' as TrajectoryClass }),
        byteLengthOfContent,
      ),
    ).toBe(true)
  })

  test('none of the clauses hit → false', () => {
    const g = group('tiny', { ok: true })
    expect(shouldOffload(g, ctx({ groups_after_this: 5 }), byteLengthOfContent)).toBe(false)
  })
})

describe('compactWithOffload', () => {
  test('roundtrip: offload → pointer in Tier-3, scratchpad.get returns original AtomicGroup', async () => {
    const tu1 = useMsg('tu_1', 0)
    const tr1 = resultMsg('tu_1', bigOutput, 0)
    const tu2 = useMsg('tu_2', 1)
    const tr2 = resultMsg('tu_2', { ok: 'small_a' }, 1)
    const tu3 = useMsg('tu_3', 2)
    const tr3 = resultMsg('tu_3', { ok: 'small_b' }, 2)
    const recent: Message[] = [tu1, tr1, tu2, tr2, tu3, tr3]
    const pad = createInMemoryScratchpad<AtomicGroup>()
    const result = await compactWithOffload({ recent, inflight: [] }, pad, ctx(), {
      byteCounter: byteLengthOfContent,
    })
    expect(result.pointersAdded).toHaveLength(1)
    const pointer = result.pointersAdded[0]
    expect(pointer).toBeDefined()
    if (pointer === undefined) throw new Error('unreachable')
    expect(pointer.tool_name).toBe('search')
    expect(pad.size()).toBe(1)
    const recovered = pad.get(pointer.recall_id)
    expect(recovered).not.toBeNull()
    expect(recovered?.tool_use).toBe(tu1)
    expect(recovered?.tool_result).toBe(tr1)
    // Tier-3 new: tu1 unchanged, tr1 replaced with pointer-marked message
    expect(result.tier3New.recent[0]).toBe(tu1)
    const replaced = result.tier3New.recent[1]
    expect(replaced?.metadata?.is_offloaded_pointer).toBe(true)
    const part = replaced?.content[0]
    expect(part?.type).toBe('tool_result')
    expect(typeof (part as Extract<Message['content'][number], { type: 'tool_result' }>).output).toBe(
      'string',
    )
  })

  test('last 2 atomic groups untouched even when oversized', async () => {
    const recent: Message[] = []
    for (let i = 0; i < 4; i++) {
      recent.push(useMsg(`tu_${String(i)}`, i), resultMsg(`tu_${String(i)}`, bigOutput, i))
    }
    const pad = createInMemoryScratchpad<AtomicGroup>()
    const result = await compactWithOffload({ recent, inflight: [] }, pad, ctx(), {
      byteCounter: byteLengthOfContent,
    })
    // Only 2 of 4 groups offloaded (the first two; groups_after_this >= 2 only for them).
    expect(result.pointersAdded).toHaveLength(2)
    expect(pad.size()).toBe(2)
    // Last two tool_results stay intact
    const lastResult = result.tier3New.recent[7]
    const secondLastResult = result.tier3New.recent[5]
    expect(lastResult?.metadata?.is_offloaded_pointer).toBeUndefined()
    expect(secondLastResult?.metadata?.is_offloaded_pointer).toBeUndefined()
  })

  test('inflight tool_use (no result) never offloaded', async () => {
    const tu1 = useMsg('tu_1', 0)
    const tr1 = resultMsg('tu_1', bigOutput, 0)
    const tu2 = useMsg('tu_2', 1)
    const tr2 = resultMsg('tu_2', bigOutput, 1)
    const tu3 = useMsg('tu_3', 2)
    const tr3 = resultMsg('tu_3', bigOutput, 2)
    const inflightUse = useMsg('tu_pending', 3)
    const recent: Message[] = [tu1, tr1, tu2, tr2, tu3, tr3, inflightUse]
    const pad = createInMemoryScratchpad<AtomicGroup>()
    const result = await compactWithOffload({ recent, inflight: [] }, pad, ctx(), {
      byteCounter: byteLengthOfContent,
    })
    // Inflight not in groups → not offloaded
    expect(result.tier3New.recent.find((m) => m === inflightUse)).toBe(inflightUse)
    // tier3New.inflight captures inflight tool_use
    expect(result.tier3New.inflight).toHaveLength(1)
    expect(result.tier3New.inflight[0]?.tool_use).toBe(inflightUse)
  })
})
