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
  return { group_id: 'g_1', tool_use_id: 'tu_1', tool_use: tu, tool_result: tr, turn_index: 0 }
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

// K-tail-3 (2026-05-26): per-tool-name content-aware projection.
describe('generateDigest — content_aware strategy', () => {
  const groupForTool = (name: string, input: unknown, output: unknown): AtomicGroup => ({
    group_id: 'g_x',
    tool_use_id: 'tu_x',
    tool_use: {
      role: 'assistant',
      content: [{ type: 'tool_use', tool_use_id: 'tu_x', name, input }],
      metadata: { turn_index: 0, step_index: 1 },
    },
    tool_result: {
      role: 'tool',
      content: [{ type: 'tool_result', tool_use_id: 'tu_x', output }],
      metadata: { turn_index: 0, step_index: 2 },
    },
    turn_index: 0,
  })
  const flags = { ...defaultFeatureFlags, CONTENT_AWARE_DIGEST: true }

  test('web_search → JSON with query + top urls + snippet heads', async () => {
    const longSnippet = 'A'.repeat(500)
    const output = Array.from({ length: 12 }, (_, i) => ({
      title: `Result ${String(i)}`,
      url: `https://example.com/${String(i)}`,
      snippet: longSnippet,
    }))
    const g = groupForTool('web_search', { query: 'Kipchoge moon' }, output)
    const out = await generateDigest(g, { flags })
    const parsed = JSON.parse(out) as { query: string; n_results: number; top: unknown[] }
    expect(parsed.query).toBe('Kipchoge moon')
    expect(parsed.n_results).toBe(12)
    expect(parsed.top).toHaveLength(8)
    // Snippet truncated to 300 chars
    const firstSnippet = (parsed.top[0] as { snippet: string }).snippet
    expect(firstSnippet.length).toBe(300)
    // Original urls preserved verbatim
    expect((parsed.top[0] as { url: string }).url).toBe('https://example.com/0')
  })

  test('visit_webpage → title + head/tail of text_content + full_length_chars', async () => {
    const text = 'Lorem'.repeat(1000)
    const g = groupForTool(
      'visit_webpage',
      { url: 'https://example.com' },
      { title: 'My Page', text_content: text },
    )
    const out = await generateDigest(g, { flags })
    const parsed = JSON.parse(out) as { title: string; text_excerpt: string; full_length_chars: number }
    expect(parsed.title).toBe('My Page')
    expect(parsed.full_length_chars).toBe(text.length)
    expect(parsed.text_excerpt).toContain('[…truncated…]')
    expect(parsed.text_excerpt.length).toBeLessThan(text.length)
  })

  test('python_exec → stdout head + stderr + exit_code', async () => {
    const stdout = 'X'.repeat(3000)
    const g = groupForTool(
      'python_exec',
      { code: 'print(1)' },
      { stdout, stderr: 'warning: deprecation', exit_code: 0 },
    )
    const out = await generateDigest(g, { flags })
    const parsed = JSON.parse(out) as {
      stdout_head: string
      stdout_truncated: boolean
      stderr: string
      exit_code: number
    }
    expect(parsed.stdout_head.length).toBe(1000)
    expect(parsed.stdout_truncated).toBe(true)
    expect(parsed.stderr).toBe('warning: deprecation')
    expect(parsed.exit_code).toBe(0)
  })

  test('text_editor → path + total_size + content head + truncated flag', async () => {
    const content = 'CONTENT_'.repeat(500)
    const g = groupForTool(
      'text_editor',
      { path: 'task.txt' },
      { content, original_size: content.length },
    )
    const out = await generateDigest(g, { flags })
    const parsed = JSON.parse(out) as {
      path: string
      total_size: number
      content_head: string
      truncated: boolean
    }
    expect(parsed.path).toBe('task.txt')
    expect(parsed.total_size).toBe(content.length)
    expect(parsed.content_head.length).toBe(600)
    expect(parsed.truncated).toBe(true)
  })

  test('describe_image short → full description verbatim', async () => {
    const description = 'A red apple on a wooden table'
    const g = groupForTool(
      'describe_image',
      { image_path: 'pic.jpg', question: 'what is this?' },
      { description, cost_usd: 0.001 },
    )
    const out = await generateDigest(g, { flags })
    const parsed = JSON.parse(out) as { description: string }
    expect(parsed.description).toBe(description)
  })

  test('describe_image long → head/tail with truncation marker', async () => {
    const description = 'long visual description '.repeat(200)
    const g = groupForTool(
      'describe_image',
      { image_path: 'pic.jpg', question: 'detail?' },
      { description, cost_usd: 0.001 },
    )
    const out = await generateDigest(g, { flags })
    const parsed = JSON.parse(out) as { description: string }
    expect(parsed.description).toContain('[…truncated…]')
    expect(parsed.description.length).toBeLessThan(description.length)
  })

  test('unknown tool name → falls back to rule-based when no llmCaller', async () => {
    const g = groupForTool('mystery_tool', {}, { data: 'x'.repeat(2000) })
    const out = await generateDigest(g, { flags })
    expect(out).toContain('[…truncated…]')
  })

  test('CONTENT_AWARE_DIGEST=false → ignores per-tool projector even for web_search', async () => {
    const llmCaller = vi.fn<LLMCaller>().mockResolvedValue({ text: 'llm summary' })
    const g = groupForTool('web_search', { query: 'x' }, [{ title: 't', url: 'u', snippet: 's' }])
    const out = await generateDigest(g, { flags: defaultFeatureFlags, llmCaller })
    expect(llmCaller).toHaveBeenCalledTimes(1)
    expect(out).toBe('llm summary')
  })
})

