import { describe, expect, test } from 'vitest'
import { injectRecallTool, recallToolDefinition } from './recallTool.js'
import { createInMemoryScratchpad } from './scratchpad.js'
import { defaultFeatureFlags } from './featureFlags.js'
import type { AtomicGroup, Message, Tier1 } from './types.js'

const sysMsg: Message = { role: 'system', content: [{ type: 'text', text: 'be helpful' }] }
const baseTier1 = (): Tier1 => ({
  systemPrompt: sysMsg,
  toolDefinitions: [],
  firstUserMessages: [{ role: 'user', content: [{ type: 'text', text: 'q' }] }],
})

const fakeGroup = (id: string): AtomicGroup => ({
  group_id: id,
  tool_use: { role: 'assistant', content: [{ type: 'tool_use', tool_use_id: id, name: 't', input: {} }] },
  tool_result: { role: 'tool', content: [{ type: 'tool_result', tool_use_id: id, output: {} }] },
  turn_index: 0,
})

describe('recallToolDefinition', () => {
  test('has stable reference across imports (cache-prefix safe)', async () => {
    const a = await import('./recallTool.js')
    const b = await import('./recallTool.js')
    expect(a.recallToolDefinition).toBe(b.recallToolDefinition)
  })

  test('is frozen — runtime mutation throws (or is silently no-op in non-strict)', () => {
    const def = recallToolDefinition as unknown as Record<string, unknown>
    expect(Object.isFrozen(def)).toBe(true)
  })
})

describe('injectRecallTool', () => {
  test('returns same Tier1 reference when RECALL_TOOL=false', () => {
    const tier1 = baseTier1()
    const pad = createInMemoryScratchpad<AtomicGroup>()
    pad.put('g_1', fakeGroup('g_1'))
    const out = injectRecallTool(tier1, pad, { ...defaultFeatureFlags, RECALL_TOOL: false })
    expect(out).toBe(tier1)
  })

  test('returns same Tier1 reference when scratchpad is empty', () => {
    const tier1 = baseTier1()
    const pad = createInMemoryScratchpad<AtomicGroup>()
    const out = injectRecallTool(tier1, pad, { ...defaultFeatureFlags, RECALL_TOOL: true })
    expect(out).toBe(tier1)
  })

  test('appends recall tool definition when both conditions met', () => {
    const tier1 = baseTier1()
    const pad = createInMemoryScratchpad<AtomicGroup>()
    pad.put('g_1', fakeGroup('g_1'))
    const out = injectRecallTool(tier1, pad, { ...defaultFeatureFlags, RECALL_TOOL: true })
    expect(out).not.toBe(tier1)
    expect(out.toolDefinitions).toHaveLength(1)
    expect(out.toolDefinitions[0]).toBe(recallToolDefinition)
  })
})
