import { describe, expect, test, vi } from 'vitest'
import { compact } from './compact.js'
import { defaultFeatureFlags } from './featureFlags.js'
import { defaultThresholds } from './thresholds.js'
import { byteLengthOfContent, charsOver4TokenCounter } from './tokenCounter.js'
import { createInMemoryScratchpad } from './scratchpad.js'
import { recallToolDefinition } from './recallTool.js'
import type { AtomicGroup, Message, Tier1, Tier2, Tier3 } from './types.js'
import type { LLMCaller } from './llm.js'

const sysMsg: Message = {
  role: 'system',
  content: [{ type: 'text', text: 'be helpful' }],
}
const userMsg = (s: string, turn: number, step = 0): Message => ({
  role: 'user',
  content: [{ type: 'text', text: s }],
  metadata: { turn_index: turn, step_index: step },
})
const asstMsg = (s: string, turn: number, step = 0): Message => ({
  role: 'assistant',
  content: [{ type: 'text', text: s }],
  metadata: { turn_index: turn, step_index: step },
})
const useMsg = (id: string, turn: number, name = 'search'): Message => ({
  role: 'assistant',
  content: [{ type: 'tool_use', tool_use_id: id, name, input: {} }],
  metadata: { turn_index: turn, step_index: 1 },
})
const resultMsg = (id: string, output: unknown, turn: number): Message => ({
  role: 'tool',
  content: [{ type: 'tool_result', tool_use_id: id, output }],
  metadata: { turn_index: turn, step_index: 2 },
})

const baseTier1 = (): Tier1 => ({
  systemPrompt: sysMsg,
  toolDefinitions: [],
  firstUserMessages: [userMsg('initial', 0)],
})
const emptyTier2 = (): Tier2 => ({
  observations: [],
  pointers: [],
  classSignal: { class: 'mixed', confidence: 0, updatedAt: 0 },
})

describe('compact() orchestrator — A5', () => {
  test('conversational class + observer enabled → tier2 receives observation, recall NOT injected', async () => {
    const long = 'x'.repeat(200000)
    const tier3: Tier3 = {
      recent: [userMsg(long, 1), asstMsg(long, 1, 1)],
      inflight: [],
    }
    const llmCaller = vi.fn<LLMCaller>().mockResolvedValue({
      text: '- 1700000000 (high) user is exploring topic X',
    })
    const scratchpad = createInMemoryScratchpad<AtomicGroup>()
    const result = await compact({
      tier1: baseTier1(),
      tier2: emptyTier2(),
      tier3,
      scratchpad,
      flags: {
        ...defaultFeatureFlags,
        TRAJECTORY_CLASSIFIER: true,
        TASK_AWARE_EXTRACTION: true,
      },
      configuredClass: 'conversational',
      thresholds: defaultThresholds,
      deps: {
        byteCounter: byteLengthOfContent,
        tokenCounter: charsOver4TokenCounter,
        llmCaller,
        currentQuery: 'follow up',
      },
    })
    expect(result.newTier2.observations.length).toBeGreaterThan(0)
    expect(scratchpad.size()).toBe(0)
    expect(result.newTier1.toolDefinitions).not.toContain(recallToolDefinition)
    expect(result.events.some((e) => e.kind === 'compaction' && e.type === 'observer')).toBe(true)
  })

  test('tool_heavy + oversized tool_result → pointer in tier2, scratchpad populated, recall injected', async () => {
    const heavyOutput = 'A'.repeat(8000)
    const tier3: Tier3 = {
      recent: [
        userMsg('search foo', 1),
        useMsg('tu_1', 1),
        resultMsg('tu_1', heavyOutput, 1),
        userMsg('search bar', 2),
        useMsg('tu_2', 2),
        resultMsg('tu_2', 'small', 2),
        userMsg('search baz', 3),
        useMsg('tu_3', 3),
        resultMsg('tu_3', 'small', 3),
      ],
      inflight: [],
    }
    const scratchpad = createInMemoryScratchpad<AtomicGroup>()
    const result = await compact({
      tier1: baseTier1(),
      tier2: emptyTier2(),
      tier3,
      scratchpad,
      flags: {
        ...defaultFeatureFlags,
        TRAJECTORY_CLASSIFIER: true,
        TYPE_AWARE_OFFLOAD: true,
        RECALL_TOOL: true,
      },
      configuredClass: 'tool_heavy',
      thresholds: defaultThresholds,
      deps: {
        byteCounter: byteLengthOfContent,
        tokenCounter: charsOver4TokenCounter,
      },
    })
    expect(result.newTier2.pointers.length).toBeGreaterThan(0)
    expect(scratchpad.size()).toBeGreaterThan(0)
    expect(result.newTier1.toolDefinitions).toContain(recallToolDefinition)
    expect(result.events.some((e) => e.kind === 'compaction' && e.type === 'offload')).toBe(true)
  })

  test('mixed class → BOTH observer and offload events emitted', async () => {
    const longText = 'y'.repeat(150000)
    const heavyOutput = 'B'.repeat(8000)
    const tier3: Tier3 = {
      recent: [
        userMsg(longText, 1),
        useMsg('tu_a', 1),
        resultMsg('tu_a', heavyOutput, 1),
        asstMsg(longText, 1, 3),
        userMsg('again', 2),
        useMsg('tu_b', 2),
        resultMsg('tu_b', 'tiny', 2),
        userMsg('again', 3),
        useMsg('tu_c', 3),
        resultMsg('tu_c', 'tiny', 3),
      ],
      inflight: [],
    }
    const llmCaller = vi.fn<LLMCaller>().mockResolvedValue({
      text: '- 1700000000 (med) mixed run extracted',
    })
    const result = await compact({
      tier1: baseTier1(),
      tier2: emptyTier2(),
      tier3,
      scratchpad: createInMemoryScratchpad<AtomicGroup>(),
      flags: {
        ...defaultFeatureFlags,
        TASK_AWARE_EXTRACTION: true,
        TYPE_AWARE_OFFLOAD: true,
        RECALL_TOOL: true,
      },
      configuredClass: 'mixed',
      thresholds: defaultThresholds,
      deps: {
        byteCounter: byteLengthOfContent,
        tokenCounter: charsOver4TokenCounter,
        llmCaller,
        currentQuery: 'continue',
      },
    })
    const types = result.events
      .filter((e) => e.kind === 'compaction')
      .map((e) => e.type)
    expect(types).toContain('observer')
    expect(types).toContain('offload')
  })

  test('hysteresisState propagates in → newHysteresisState reflects update', async () => {
    const tier3: Tier3 = { recent: [userMsg('q', 1)], inflight: [] }
    const result1 = await compact({
      tier1: baseTier1(),
      tier2: emptyTier2(),
      tier3,
      scratchpad: createInMemoryScratchpad<AtomicGroup>(),
      flags: { ...defaultFeatureFlags, TRAJECTORY_CLASSIFIER: true },
      thresholds: defaultThresholds,
      deps: { byteCounter: byteLengthOfContent, tokenCounter: charsOver4TokenCounter },
    })
    const prevState = result1.newHysteresisState
    expect(prevState).toBeDefined()
    if (prevState === undefined) throw new Error('unreachable')
    const result2 = await compact({
      tier1: baseTier1(),
      tier2: emptyTier2(),
      tier3,
      scratchpad: createInMemoryScratchpad<AtomicGroup>(),
      hysteresisState: prevState,
      flags: { ...defaultFeatureFlags, TRAJECTORY_CLASSIFIER: true },
      thresholds: defaultThresholds,
      deps: { byteCounter: byteLengthOfContent, tokenCounter: charsOver4TokenCounter },
    })
    expect(result2.newHysteresisState?.lastClass).toBe(result1.newHysteresisState?.lastClass)
  })

  test('all flags off → passthrough; events contains only ClassifierSignalEvent', async () => {
    const tier3: Tier3 = {
      recent: [userMsg('hello', 1), asstMsg('hi', 1, 1)],
      inflight: [],
    }
    const result = await compact({
      tier1: baseTier1(),
      tier2: emptyTier2(),
      tier3,
      scratchpad: createInMemoryScratchpad<AtomicGroup>(),
      flags: defaultFeatureFlags,
      configuredClass: 'mixed',
      thresholds: defaultThresholds,
      deps: { byteCounter: byteLengthOfContent, tokenCounter: charsOver4TokenCounter },
    })
    expect(result.newTier2.observations).toEqual([])
    expect(result.newTier2.pointers).toEqual([])
    expect(result.events.filter((e) => e.kind === 'compaction')).toEqual([])
    expect(result.events.some((e) => e.kind === 'classifier_signal')).toBe(true)
    // Assembled = tier1 + tier3 (no synthetic note, no recall injection)
    expect(result.newTier1.toolDefinitions).not.toContain(recallToolDefinition)
  })
})
