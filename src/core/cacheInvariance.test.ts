// Cache invariance contract §9.1 — promoted to bytewise via serializeForCache().
// Supersedes A1's JSON.stringify proxy (decisions.md 2026-05-13). The serializer
// uses canonical (sorted-key) JSON so JS property insertion order does not affect
// the byte stream — the same logical Tier-1 / Tier-2 produces identical bytes
// regardless of how it was constructed.
import { describe, expect, test } from 'vitest'
import { compactWithOffload } from './offloader.js'
import { createInMemoryScratchpad } from './scratchpad.js'
import { defaultFeatureFlags } from './featureFlags.js'
import { defaultThresholds } from './thresholds.js'
import { serializeForCache } from './serializeForCache.js'
import { tierize } from './tiers.js'
import { byteLengthOfContent } from './tokenCounter.js'
import type { AtomicGroup, Message } from './types.js'

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
})
