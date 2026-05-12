import { describe, expect, test, vi } from 'vitest'
import { reflect } from './reflection.js'
import { REFLECTOR_PROMPT_TEMPLATE } from './reflectorPrompt.js'
import { charsOver4TokenCounter } from './tokenCounter.js'
import type { LLMCaller } from './llm.js'
import type { Observation, PointerPlaceholder, Tier2 } from './types.js'

const obs = (ts: number, conf: Observation['confidence'], stmt: string, src = 0): Observation => ({
  timestamp: ts,
  confidence: conf,
  statement: stmt,
  sourceTurn: src,
})

const tier2With = (observations: Observation[], pointers: PointerPlaceholder[] = []): Tier2 => ({
  observations,
  pointers,
  classSignal: { class: 'mixed', confidence: 0, updatedAt: 0 },
})

describe('reflect — A5 reflection layer (§8)', () => {
  test('exports REFLECTOR_PROMPT_TEMPLATE with §8.2 ingredients', () => {
    expect(REFLECTOR_PROMPT_TEMPLATE).toContain('reflection engine')
    expect(REFLECTOR_PROMPT_TEMPLATE).toContain('Merge related observations')
    expect(REFLECTOR_PROMPT_TEMPLATE).toContain('Drop outdated entries')
  })

  test('without llmCaller → ran=false, reason=no_llm_caller, tier2 unchanged', async () => {
    const original = tier2With([
      obs(1700000000, 'high', 'fact-A'),
      obs(1700000050, 'med', 'fact-B'),
    ])
    const result = await reflect(original, { tokenCounter: charsOver4TokenCounter })
    expect(result.ran).toBe(false)
    expect(result.reason).toBe('no_llm_caller')
    expect(result.newTier2).toBe(original)
  })

  test('canonical 3-obs LLM output → newTier2.observations.length === 3, pointers preserved unchanged', async () => {
    const ptr: PointerPlaceholder = {
      recall_id: 'g_abc',
      tool_name: 'search',
      original_size_bytes: 9000,
      digest: 'head…tail',
      turn_index: 4,
    }
    const original = tier2With(
      [
        obs(1, 'high', 'a'),
        obs(2, 'med', 'b'),
        obs(3, 'low', 'c'),
        obs(4, 'high', 'd'),
        obs(5, 'med', 'e'),
      ],
      [ptr],
    )
    const llmCaller = vi.fn<LLMCaller>().mockResolvedValue({
      text: `- 1700000000 (high) merged-1
- 1700000050 (med) merged-2
- 1700000099 (low) merged-3`,
    })
    const result = await reflect(original, { tokenCounter: charsOver4TokenCounter, llmCaller })
    expect(result.ran).toBe(true)
    expect(result.newTier2.observations).toHaveLength(3)
    expect(result.newTier2.pointers).toEqual([ptr])
    expect(result.newTier2.pointers[0]).toBe(ptr)
  })

  test('malformed LLM output → ran=false, reason=parse_error, tier2 unchanged', async () => {
    const original = tier2With([obs(1, 'high', 'x')])
    const llmCaller = vi.fn<LLMCaller>().mockResolvedValue({
      text: 'this is not in observation format\n- 12 (totally-bogus) bad',
    })
    const result = await reflect(original, { tokenCounter: charsOver4TokenCounter, llmCaller })
    expect(result.ran).toBe(false)
    expect(result.reason).toBe('parse_error')
    expect(result.newTier2).toBe(original)
  })

  test('beforeBytes / afterBytes reflect token-proxy size before/after reflection', async () => {
    const original = tier2With([
      obs(1, 'high', 'x'.repeat(200)),
      obs(2, 'med', 'y'.repeat(200)),
      obs(3, 'low', 'z'.repeat(200)),
    ])
    const llmCaller = vi.fn<LLMCaller>().mockResolvedValue({
      text: '- 1 (high) compressed',
    })
    const result = await reflect(original, { tokenCounter: charsOver4TokenCounter, llmCaller })
    expect(result.ran).toBe(true)
    expect(result.beforeTokens).toBeGreaterThan(result.afterTokens)
  })
})
