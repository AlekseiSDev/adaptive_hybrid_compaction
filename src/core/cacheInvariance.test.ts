// Cache invariance contract §9.1 — promoted to bytewise via serializeForCache().
// Supersedes A1's JSON.stringify proxy (decisions.md 2026-05-13). The serializer
// uses canonical (sorted-key) JSON so JS property insertion order does not affect
// the byte stream — the same logical Tier-1 / Tier-2 produces identical bytes
// regardless of how it was constructed.
import { describe, expect, test, vi } from 'vitest'
import { compact } from './compact.js'
import { compactWithOffload } from './offloader.js'
import { createInMemoryScratchpad } from './scratchpad.js'
import { defaultFeatureFlags } from './featureFlags.js'
import { defaultThresholds } from './thresholds.js'
import { canonicalJSON, serializeForCache } from './serializeForCache.js'
import { tierize } from './tiers.js'
import { byteLengthOfContent, charsOver4TokenCounter } from './tokenCounter.js'
import type { LLMCaller } from './llm.js'
import type { AtomicGroup, Message, Observation, Tier2 } from './types.js'

const sysMsg: Message = { role: 'system', content: [{ type: 'text', text: 'be helpful' }] }
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

const baseHistory: Message[] = [
  sysMsg,
  userMsg('first q', 0),
  asstMsg('first a', 0),
  userMsg('second q', 1),
  asstMsg('second a', 1),
]

const extendedHistory: Message[] = [
  ...baseHistory,
  userMsg('third q', 2),
  asstMsg('third a', 2),
]

describe('Cache invariance (§9.1) — bytewise via serializeForCache', () => {
  test('Tier-1 + empty Tier-2 are byte-identical across consecutive turns sharing a prefix', () => {
    const turnI = tierize(baseHistory)
    const turnIPlus1 = tierize(extendedHistory)
    const bytesI = serializeForCache({ tier1: turnI.tier1, tier2: turnI.tier2 })
    const bytesIPlus1 = serializeForCache({ tier1: turnIPlus1.tier1, tier2: turnIPlus1.tier2 })
    expect(Buffer.compare(bytesI, bytesIPlus1)).toBe(0)
  })

  test('Tier-2 append-only: adding pointers after offload extends bytes without reordering Tier-1', async () => {
    // Build a history with enough atomic groups so offloader actually fires.
    const useMsg = (id: string, turn: number): Message => ({
      role: 'assistant',
      content: [{ type: 'tool_use', tool_use_id: id, name: 'search', input: {} }],
      metadata: { turn_index: turn, step_index: 1 },
    })
    const resultMsg = (id: string, turn: number, output: unknown): Message => ({
      role: 'tool',
      content: [{ type: 'tool_result', tool_use_id: id, output }],
      metadata: { turn_index: turn, step_index: 2 },
    })
    const big = { data: 'x'.repeat(5000) }
    const history: Message[] = [sysMsg, userMsg('q', 0)]
    for (let t = 1; t <= 5; t++) {
      history.push(useMsg(`tu_${String(t)}`, t), resultMsg(`tu_${String(t)}`, t, big))
    }
    const { tier1, tier2 } = tierize(history, { kRecent: 20 })
    const baselineBytes = serializeForCache({ tier1, tier2 })

    const pad = createInMemoryScratchpad<AtomicGroup>()
    const out = await compactWithOffload(
      { recent: history.slice(2), inflight: [] },
      pad,
      {
        flags: defaultFeatureFlags,
        groups_after_this: 0,
        cumulative_kept_tool_result_bytes: 0,
        current_class: 'tool_heavy',
        thresholds: defaultThresholds,
      },
      { byteCounter: byteLengthOfContent },
    )
    expect(out.pointersAdded.length).toBeGreaterThan(0)
    const tier2After = { ...tier2, pointers: [...tier2.pointers, ...out.pointersAdded] }
    const afterBytes = serializeForCache({ tier1, tier2: tier2After })

    // Tier-1 portion is bytewise-equal between baseline and after — find "tier2" delimiter
    // in the canonical JSON output (keys are sorted; "tier1" < "tier2" alphabetically).
    const baselineText = baselineBytes.toString('utf8')
    const afterText = afterBytes.toString('utf8')
    const tier2Marker = baselineText.indexOf('"tier2":')
    expect(tier2Marker).toBeGreaterThan(0)
    expect(afterText.slice(0, tier2Marker)).toBe(baselineText.slice(0, tier2Marker))
  })

  test('within-epoch (no reflection): two consecutive compact() runs preserve Tier-1 prefix bytewise', async () => {
    const { tier1, tier2, tier3 } = tierize(baseHistory)
    const scratchpad = createInMemoryScratchpad<AtomicGroup>()
    const turnA = await compact({
      tier1,
      tier2,
      tier3,
      scratchpad,
      flags: defaultFeatureFlags, // REFLECTION=true by default but tier2 is tiny
      configuredClass: 'mixed',
      thresholds: defaultThresholds,
      deps: { byteCounter: byteLengthOfContent, tokenCounter: charsOver4TokenCounter },
    })
    const turnB = await compact({
      tier1: turnA.newTier1,
      tier2: turnA.newTier2,
      tier3: turnA.newTier3,
      scratchpad,
      flags: defaultFeatureFlags,
      configuredClass: 'mixed',
      thresholds: defaultThresholds,
      deps: { byteCounter: byteLengthOfContent, tokenCounter: charsOver4TokenCounter },
    })
    const bytesA = serializeForCache({ tier1: turnA.newTier1, tier2: turnA.newTier2 })
    const bytesB = serializeForCache({ tier1: turnB.newTier1, tier2: turnB.newTier2 })
    const textA = bytesA.toString('utf8')
    const tier2Marker = textA.indexOf('"tier2":')
    expect(tier2Marker).toBeGreaterThan(0)
    expect(bytesB.toString('utf8').slice(0, tier2Marker)).toBe(textA.slice(0, tier2Marker))
    // Reflection should NOT have fired
    expect(
      turnA.events
        .concat(turnB.events)
        .some((e) => e.kind === 'compaction' && e.type === 'reflection'),
    ).toBe(false)
  })

  test('persisted Tier-2 across compact() calls — observations append-only (turn 1 obs survives in turn 2)', async () => {
    // Direct verification of decisions.md 2026-05-22 D7: when adapter persists
    // result.newTier2 across LLM calls (Tier-2 cross-turn contract per §2.1),
    // observations grow append-only — turn 1's observations appear verbatim in
    // turn 2's serialization at the same byte offsets.
    const { tier1, tier2, tier3 } = tierize(baseHistory)
    const scratchpad = createInMemoryScratchpad<AtomicGroup>()
    let callIdx = 0
    const llmCaller = vi.fn<LLMCaller>().mockImplementation(async () => {
      callIdx += 1
      return Promise.resolve({
        text: `- ${String(callIdx)} (high) obs-from-call-${String(callIdx)}`,
      })
    })
    // OBSERVER_THRESHOLD=1 → observer fires on any non-empty Tier-3.
    const lowObs = { ...defaultThresholds, OBSERVER_THRESHOLD: 1 }
    const flagsWithObs = { ...defaultFeatureFlags, TASK_AWARE_EXTRACTION: true }

    const turn1 = await compact({
      tier1,
      tier2,
      tier3,
      scratchpad,
      flags: flagsWithObs,
      configuredClass: 'mixed',
      thresholds: lowObs,
      deps: {
        byteCounter: byteLengthOfContent,
        tokenCounter: charsOver4TokenCounter,
        llmCaller,
        currentQuery: 'q',
      },
    })
    expect(turn1.newTier2.observations.length).toBeGreaterThanOrEqual(1)

    const turn2 = await compact({
      tier1: turn1.newTier1,
      tier2: turn1.newTier2,
      tier3: turn1.newTier3,
      scratchpad,
      flags: flagsWithObs,
      configuredClass: 'mixed',
      thresholds: lowObs,
      deps: {
        byteCounter: byteLengthOfContent,
        tokenCounter: charsOver4TokenCounter,
        llmCaller,
        currentQuery: 'q',
      },
    })
    // Append-only: turn 2 carries all turn 1 observations + at least one more.
    expect(turn2.newTier2.observations.length).toBeGreaterThan(
      turn1.newTier2.observations.length,
    )
    expect(turn2.newTier2.observations[0]).toEqual(turn1.newTier2.observations[0])

    // Bytewise: turn 1's first observation appears at the same byte offset in
    // both serializations (canonical JSON guarantee under append-only growth).
    const bytes1 = serializeForCache({ tier1: turn1.newTier1, tier2: turn1.newTier2 })
    const bytes2 = serializeForCache({ tier1: turn2.newTier1, tier2: turn2.newTier2 })
    const obs1Json = canonicalJSON(turn1.newTier2.observations[0])
    const off1 = bytes1.toString('utf8').indexOf(obs1Json)
    const off2 = bytes2.toString('utf8').indexOf(obs1Json)
    expect(off1).toBeGreaterThan(0)
    expect(off2).toBe(off1)
  })

  test('across-reflection: forced reflection emits exactly one reflection event', async () => {
    // Force reflection via tiny REFLECTION_THRESHOLD so any non-empty Tier-2 trips it.
    const lowReflectionThresholds = { ...defaultThresholds, REFLECTION_THRESHOLD: 1 }
    const oneObs: Observation = {
      timestamp: 1700000000,
      confidence: 'high',
      statement: 'pre-existing observation',
      sourceTurn: 0,
    }
    const tier2WithObs: Tier2 = {
      observations: [oneObs],
      pointers: [],
      classSignal: { class: 'mixed', confidence: 0, updatedAt: 0 },
    }
    const { tier1, tier3 } = tierize(baseHistory)
    const llmCaller = vi.fn<LLMCaller>().mockResolvedValue({
      text: '- 1700000000 (high) reflected: one consolidated fact',
    })
    const result = await compact({
      tier1,
      tier2: tier2WithObs,
      tier3,
      scratchpad: createInMemoryScratchpad<AtomicGroup>(),
      flags: defaultFeatureFlags, // REFLECTION=true by default
      configuredClass: 'mixed',
      thresholds: lowReflectionThresholds,
      deps: {
        byteCounter: byteLengthOfContent,
        tokenCounter: charsOver4TokenCounter,
        llmCaller,
      },
    })
    const reflectionEvents = result.events.filter(
      (e) => e.kind === 'compaction' && e.type === 'reflection',
    )
    expect(reflectionEvents).toHaveLength(1)
  })
})
