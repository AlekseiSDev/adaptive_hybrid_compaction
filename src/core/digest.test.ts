import { describe, expect, test, vi } from 'vitest'
import { generateDigest } from './digest.js'
import { defaultFeatureFlags } from './featureFlags.js'
import type { AtomicGroup, Message } from './types.js'
import type { LLMCaller } from './llm.js'

const groupWith = (output: unknown): AtomicGroup => {
  const tu: Message = {
    role: 'assistant',
    content: [{ type: 'tool_use', tool_use_id: 'tu_1', name: 'search_docs', input: { q: 'auth' } }],
    metadata: { turn_index: 0, step_index: 1 },
  }
  const tr: Message = {
    role: 'tool',
    content: [{ type: 'tool_result', tool_use_id: 'tu_1', output }],
    metadata: { turn_index: 0, step_index: 2 },
  }
  return { group_id: 'g_1', tool_use: tu, tool_result: tr, turn_index: 0 }
}

describe('generateDigest (§5.3)', () => {
  test('no llmCaller, no schema → rule-based fallback with truncation marker', async () => {
    const big = groupWith({ data: 'x'.repeat(2000) })
    const out = await generateDigest(big, { flags: defaultFeatureFlags })
    expect(out).toContain('[…truncated…]')
    expect(out.length).toBeLessThan(2000)
  })

  test('stub llmCaller invoked with summarize prompt, response used', async () => {
    const llmCaller = vi.fn<LLMCaller>().mockResolvedValue({
      text: '3 docs matching auth: doc_237 (0.91), doc_198, doc_452',
    })
    const big = groupWith({ data: 'x'.repeat(2000) })
    const out = await generateDigest(big, { flags: defaultFeatureFlags, llmCaller })
    expect(llmCaller).toHaveBeenCalledTimes(1)
    const req = llmCaller.mock.calls[0]?.[0]
    expect(req?.messages.some((m) => /summarize/i.test(m.content))).toBe(true)
    expect(req?.maxOutputTokens).toBe(80)
    expect(out).toBe('3 docs matching auth: doc_237 (0.91), doc_198, doc_452')
  })

  test('SCHEMA_AWARE_DIGEST=true + toolSchema → schema projection, LLM not called', async () => {
    const llmCaller = vi.fn<LLMCaller>()
    const flags = { ...defaultFeatureFlags, SCHEMA_AWARE_DIGEST: true }
    const big = groupWith({
      results: [
        { id: 'doc_1', score: 0.9, snippet: 'a' },
        { id: 'doc_2', score: 0.8, snippet: 'b' },
        { id: 'doc_3', score: 0.7, snippet: 'c' },
        { id: 'doc_4', score: 0.6, snippet: 'd' },
        { id: 'doc_5', score: 0.5, snippet: 'e' },
        { id: 'doc_6', score: 0.4, snippet: 'f' },
        { id: 'doc_7', score: 0.3, snippet: 'g' },
      ],
    })
    const out = await generateDigest(big, {
      flags,
      llmCaller,
      toolSchema: { importantFields: ['results'] },
    })
    expect(llmCaller).not.toHaveBeenCalled()
    expect(out).toContain('doc_1')
    // Arrays > 5 items truncated
    expect(out).toContain('…')
  })

  test('empty tool_result output → <empty> sentinel', async () => {
    const g = groupWith(null)
    const out = await generateDigest(g, { flags: defaultFeatureFlags })
    expect(out).toBe('<empty>')
  })
})
