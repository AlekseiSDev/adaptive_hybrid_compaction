import { describe, expect, test } from 'vitest'
import {
  AT_TOOL_NAMES,
  ReplayDispatcher,
  ToolReplayMissError,
  buildReplayTools,
  resolveToolMode,
} from './assistant-traj.tools.js'
import type { ToolFixture } from './assistant-traj.tool-fixtures.schema.js'

describe('ReplayDispatcher — order-based default matcher', () => {
  test('returns first fixture for first call, second fixture for second call', async () => {
    const fixtures: ToolFixture[] = [
      {
        tool_name: 'google_search',
        output_parts: [{ type: 'text', text: 'first result' }],
      },
      {
        tool_name: 'google_search',
        output_parts: [{ type: 'text', text: 'second result' }],
      },
    ]
    const d = new ReplayDispatcher({ task_id: 'at_research_write_001', fixtures })
    const r1 = await d.dispatch('google_search', { q: 'a' })
    const r2 = await d.dispatch('google_search', { q: 'b' })
    expect(r1.content[0]).toEqual({ type: 'text', text: 'first result' })
    expect(r2.content[0]).toEqual({ type: 'text', text: 'second result' })
  })

  test('per-tool indexing independent across tool names', async () => {
    const fixtures: ToolFixture[] = [
      { tool_name: 'google_search', output_parts: [{ type: 'text', text: 'search' }] },
      { tool_name: 'web_fetch', output_parts: [{ type: 'text', text: 'fetched' }] },
    ]
    const d = new ReplayDispatcher({ task_id: 'at_mixed_001', fixtures })
    const r1 = await d.dispatch('web_fetch', { url: 'https://x' })
    const r2 = await d.dispatch('google_search', { q: 'a' })
    expect(r1.content[0]).toEqual({ type: 'text', text: 'fetched' })
    expect(r2.content[0]).toEqual({ type: 'text', text: 'search' })
  })

  test('throws ToolReplayMissError when no fixture remains', async () => {
    const fixtures: ToolFixture[] = [
      { tool_name: 'google_search', output_parts: [{ type: 'text', text: 'only one' }] },
    ]
    const d = new ReplayDispatcher({ task_id: 'at_research_write_002', fixtures })
    await d.dispatch('google_search', { q: 'a' })
    await expect(d.dispatch('google_search', { q: 'b' })).rejects.toBeInstanceOf(
      ToolReplayMissError,
    )
  })

  test('ToolReplayMissError carries diagnostic context', async () => {
    const d = new ReplayDispatcher({ task_id: 'at_code_iter_001', fixtures: [] })
    try {
      await d.dispatch('code_interpreter', { code: 'print(1)' })
      throw new Error('expected throw')
    } catch (e) {
      expect(e).toBeInstanceOf(ToolReplayMissError)
      const err = e as ToolReplayMissError
      expect(err.task_id).toBe('at_code_iter_001')
      expect(err.tool_name).toBe('code_interpreter')
      expect(err.callIndex).toBe(0)
    }
  })

  test('is_error fixture propagates to result', async () => {
    const fixtures: ToolFixture[] = [
      {
        tool_name: 'web_fetch',
        output_parts: [{ type: 'text', text: '404 not found' }],
        is_error: true,
      },
    ]
    const d = new ReplayDispatcher({ task_id: 'at_research_write_003', fixtures })
    const r = await d.dispatch('web_fetch', { url: 'https://x' })
    expect(r.isError).toBe(true)
  })
})

describe('ReplayDispatcher — args_exact / args_subset matchers', () => {
  test("args_exact matches when input deepEqual", async () => {
    const fixtures: ToolFixture[] = [
      {
        tool_name: 'google_search',
        input_match: { kind: 'args_exact', args: { q: 'typescript' } },
        output_parts: [{ type: 'text', text: 'TS results' }],
      },
    ]
    const d = new ReplayDispatcher({ task_id: 'at_research_write_004', fixtures })
    const r = await d.dispatch('google_search', { q: 'typescript' })
    expect(r.content[0]).toEqual({ type: 'text', text: 'TS results' })
  })

  test('args_exact misses when input differs', async () => {
    const fixtures: ToolFixture[] = [
      {
        tool_name: 'google_search',
        input_match: { kind: 'args_exact', args: { q: 'typescript' } },
        output_parts: [{ type: 'text', text: 'TS results' }],
      },
    ]
    const d = new ReplayDispatcher({ task_id: 'at_research_write_005', fixtures })
    await expect(d.dispatch('google_search', { q: 'rust' })).rejects.toBeInstanceOf(
      ToolReplayMissError,
    )
  })

  test('args_subset matches when expected keys ⊆ input', async () => {
    const fixtures: ToolFixture[] = [
      {
        tool_name: 'google_search',
        input_match: { kind: 'args_subset', args: { q: 'typescript' } },
        output_parts: [{ type: 'text', text: 'TS results' }],
      },
    ]
    const d = new ReplayDispatcher({ task_id: 'at_research_write_006', fixtures })
    const r = await d.dispatch('google_search', { q: 'typescript', n: 5, lang: 'en' })
    expect(r.content[0]).toEqual({ type: 'text', text: 'TS results' })
  })

  test('args_subset misses when expected key missing in input', async () => {
    const fixtures: ToolFixture[] = [
      {
        tool_name: 'google_search',
        input_match: { kind: 'args_subset', args: { q: 'typescript', lang: 'en' } },
        output_parts: [{ type: 'text', text: 'TS results' }],
      },
    ]
    const d = new ReplayDispatcher({ task_id: 'at_research_write_007', fixtures })
    await expect(d.dispatch('google_search', { q: 'typescript' })).rejects.toBeInstanceOf(
      ToolReplayMissError,
    )
  })
})

describe('ReplayDispatcher — bit-stability (cache invariance)', () => {
  test('two dispatch calls with same fixture produce structurally identical results', async () => {
    const fixtures: ToolFixture[] = [
      { tool_name: 'google_search', output_parts: [{ type: 'text', text: 'stable' }] },
    ]
    const d1 = new ReplayDispatcher({ task_id: 'at_mixed_007', fixtures })
    const d2 = new ReplayDispatcher({ task_id: 'at_mixed_007', fixtures })
    const r1 = await d1.dispatch('google_search', { q: 'x' })
    const r2 = await d2.dispatch('google_search', { q: 'x' })
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2))
  })
})

describe('buildReplayTools — AI SDK v6 tool() interop', () => {
  test('produces a Record keyed by AT_TOOL_NAMES', () => {
    const tools = buildReplayTools(
      new ReplayDispatcher({ task_id: 'at_mixed_008', fixtures: [] }),
    )
    for (const name of AT_TOOL_NAMES) {
      expect(tools[name]).toBeDefined()
      expect(typeof tools[name].execute).toBe('function')
    }
  })

  test('tool.execute routes to dispatcher and returns ToolHandle-shaped result', async () => {
    const dispatcher = new ReplayDispatcher({
      task_id: 'at_research_write_008',
      fixtures: [
        { tool_name: 'google_search', output_parts: [{ type: 'text', text: 'r1' }] },
      ],
    })
    const tools = buildReplayTools(dispatcher)
    const result = await tools.google_search.execute({ q: 'foo' })
    expect(result.content[0]).toEqual({ type: 'text', text: 'r1' })
  })

  test('only AT_TOOL_NAMES tools are exposed (no extra keys)', () => {
    const tools = buildReplayTools(
      new ReplayDispatcher({ task_id: 'at_mixed_009', fixtures: [] }),
    )
    expect(Object.keys(tools).sort()).toEqual([...AT_TOOL_NAMES].sort())
  })
})

describe('resolveToolMode — replay default, live opt-in', () => {
  test('default = replay when AT_TOOL_MODE unset', () => {
    const prev = process.env['AT_TOOL_MODE']
    delete process.env['AT_TOOL_MODE']
    try {
      expect(resolveToolMode()).toBe('replay')
    } finally {
      if (prev !== undefined) process.env['AT_TOOL_MODE'] = prev
    }
  })

  test('AT_TOOL_MODE=live → live', () => {
    const prev = process.env['AT_TOOL_MODE']
    process.env['AT_TOOL_MODE'] = 'live'
    try {
      expect(resolveToolMode()).toBe('live')
    } finally {
      if (prev === undefined) delete process.env['AT_TOOL_MODE']
      else process.env['AT_TOOL_MODE'] = prev
    }
  })

  test('AT_TOOL_MODE=live + CI=true → throws (CI guard)', () => {
    const prevMode = process.env['AT_TOOL_MODE']
    const prevCi = process.env['CI']
    process.env['AT_TOOL_MODE'] = 'live'
    process.env['CI'] = 'true'
    try {
      expect(() => resolveToolMode()).toThrow(/CI/)
    } finally {
      if (prevMode === undefined) delete process.env['AT_TOOL_MODE']
      else process.env['AT_TOOL_MODE'] = prevMode
      if (prevCi === undefined) delete process.env['CI']
      else process.env['CI'] = prevCi
    }
  })

  test('AT_TOOL_MODE=replay + CI=true → ok (no guard for replay)', () => {
    const prevMode = process.env['AT_TOOL_MODE']
    const prevCi = process.env['CI']
    process.env['AT_TOOL_MODE'] = 'replay'
    process.env['CI'] = 'true'
    try {
      expect(resolveToolMode()).toBe('replay')
    } finally {
      if (prevMode === undefined) delete process.env['AT_TOOL_MODE']
      else process.env['AT_TOOL_MODE'] = prevMode
      if (prevCi === undefined) delete process.env['CI']
      else process.env['CI'] = prevCi
    }
  })
})
