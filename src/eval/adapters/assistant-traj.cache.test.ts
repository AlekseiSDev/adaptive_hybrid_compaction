// Track J §10.1 — cache invariance for replay tool output bytes.
// Reproducible dispatch (replay mode) must produce byte-identical content
// across runs so the prompt-cache prefix on tool_result blocks is stable.
// Without this, AHC A/B becomes apples-to-oranges (cache_read% drifts due
// to fixture flips, not compaction policy).

import { describe, expect, test } from 'vitest'
import { ReplayDispatcher } from './assistant-traj.tools.js'
import type { ToolFixture } from './assistant-traj.tool-fixtures.schema.js'

describe('replay tool output — bit-stability', () => {
  const fixtures: ToolFixture[] = [
    {
      tool_name: 'google_search',
      output_parts: [
        { type: 'text', text: 'Top 3 results:\n1. Foo — bar\n   https://foo.example' },
      ],
    },
    {
      tool_name: 'web_fetch',
      output_parts: [{ type: 'text', text: '# Page title\n\nLorem ipsum.' }],
    },
    {
      tool_name: 'code_interpreter',
      output_parts: [{ type: 'text', text: 'STDOUT:\n42\n\nSTDERR:\n\nExit: 0' }],
    },
  ]

  test('two fresh dispatchers produce identical serialized outputs', async () => {
    const d1 = new ReplayDispatcher({ task_id: 'at_mixed_007', fixtures })
    const d2 = new ReplayDispatcher({ task_id: 'at_mixed_007', fixtures })

    const r1a = await d1.dispatch('google_search', { q: 'foo' })
    const r2a = await d2.dispatch('google_search', { q: 'foo' })
    expect(JSON.stringify(r1a)).toBe(JSON.stringify(r2a))

    const r1b = await d1.dispatch('web_fetch', { url: 'https://x' })
    const r2b = await d2.dispatch('web_fetch', { url: 'https://x' })
    expect(JSON.stringify(r1b)).toBe(JSON.stringify(r2b))

    const r1c = await d1.dispatch('code_interpreter', { code: 'print(42)' })
    const r2c = await d2.dispatch('code_interpreter', { code: 'print(42)' })
    expect(JSON.stringify(r1c)).toBe(JSON.stringify(r2c))
  })

  test('per-tool ordering identical across dispatcher instances', async () => {
    const repeated: ToolFixture[] = [
      { tool_name: 'google_search', output_parts: [{ type: 'text', text: 'first' }] },
      { tool_name: 'google_search', output_parts: [{ type: 'text', text: 'second' }] },
      { tool_name: 'google_search', output_parts: [{ type: 'text', text: 'third' }] },
    ]
    const d1 = new ReplayDispatcher({ task_id: 'at_mixed_008', fixtures: repeated })
    const d2 = new ReplayDispatcher({ task_id: 'at_mixed_008', fixtures: repeated })
    const seq1: string[] = []
    const seq2: string[] = []
    for (let i = 0; i < 3; i += 1) {
      seq1.push(JSON.stringify(await d1.dispatch('google_search', { q: 'q' })))
      seq2.push(JSON.stringify(await d2.dispatch('google_search', { q: 'q' })))
    }
    expect(seq1).toEqual(seq2)
  })

  test('different input.q does not change output bytes under default first-matcher', async () => {
    // Replay default matcher is order-based, not arg-based — so calling
    // google_search({q:'a'}) vs google_search({q:'b'}) yields the same first
    // fixture entry. This is intentional: prompt-cache key uses output bytes,
    // not args; bit-stability hinges on per-tool call ordering being arg-blind
    // by default.
    const single: ToolFixture[] = [
      { tool_name: 'google_search', output_parts: [{ type: 'text', text: 'stable' }] },
    ]
    const dA = new ReplayDispatcher({ task_id: 'at_mixed_009', fixtures: single })
    const dB = new ReplayDispatcher({ task_id: 'at_mixed_009', fixtures: single })
    const rA = await dA.dispatch('google_search', { q: 'alpha' })
    const rB = await dB.dispatch('google_search', { q: 'beta' })
    expect(JSON.stringify(rA)).toBe(JSON.stringify(rB))
  })
})
