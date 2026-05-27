// Recall execute path tests — verifies recall_tool_summary / recall_tool_full
// dispatch through the scratchpad + pointers registry plumbed by gaia
// agent-runner. K-tail-3 (2026-05-26).

import { describe, expect, test } from 'vitest'
import { createInMemoryScratchpad } from '../../../core/index.js'
import type { AtomicGroup, PointerPlaceholder } from '../../../core/index.js'
import { gaiaTools } from './index.js'

type ExecutableTool = {
  execute: (args: { recall_id: string; reason: string }, opts?: unknown) => Promise<unknown>
}

function asExecutable(t: unknown): ExecutableTool {
  return t as ExecutableTool
}

const groupFor = (id: string, name: string, output: unknown): AtomicGroup => ({
  group_id: id,
  tool_use_id: id,
  tool_use: {
    role: 'assistant',
    content: [{ type: 'tool_use', tool_use_id: id, name, input: { query: 'q' } }],
    metadata: { turn_index: 0, step_index: 1 },
  },
  tool_result: {
    role: 'tool',
    content: [{ type: 'tool_result', tool_use_id: id, output }],
    metadata: { turn_index: 0, step_index: 2 },
  },
  turn_index: 0,
})

const pointer = (id: string, name: string, digest: string, size = 1234): PointerPlaceholder => ({
  recall_id: id,
  tool_name: name,
  original_size_bytes: size,
  digest,
  turn_index: 0,
})

describe('gaiaTools — recall_tool_summary / recall_tool_full', () => {
  test('without recallDeps → no recall tools exposed', () => {
    const tools = gaiaTools('/tmp/wd') as Record<string, unknown>
    expect(tools['recall_tool_summary']).toBeUndefined()
    expect(tools['recall_tool_full']).toBeUndefined()
    // Base tools still present
    expect(tools['web_search']).toBeDefined()
    expect(tools['python_exec']).toBeDefined()
  })

  test('with recallDeps → both recall tools exposed', () => {
    const scratchpad = createInMemoryScratchpad<AtomicGroup>()
    const tools = gaiaTools('/tmp/wd', {
      scratchpad,
      getPointers: () => [],
    }) as Record<string, unknown>
    expect(tools['recall_tool_summary']).toBeDefined()
    expect(tools['recall_tool_full']).toBeDefined()
  })

  test('recall_tool_summary returns pointer digest as summary', async () => {
    const scratchpad = createInMemoryScratchpad<AtomicGroup>()
    const pointers = [pointer('G1', 'web_search', '{"top":[{"url":"a"}]}', 9999)]
    const tools = gaiaTools('/tmp/wd', {
      scratchpad,
      getPointers: () => pointers,
    }) as Record<string, unknown>
    const out = await asExecutable(tools['recall_tool_summary']).execute({
      recall_id: 'G1',
      reason: 'need urls',
    })
    expect(out).toEqual({
      recall_id: 'G1',
      tool_name: 'web_search',
      original_size_bytes: 9999,
      summary: '{"top":[{"url":"a"}]}',
    })
  })

  test('recall_tool_summary on unknown id → error + available_ids', async () => {
    const scratchpad = createInMemoryScratchpad<AtomicGroup>()
    const pointers = [pointer('G1', 'web_search', 'foo')]
    const tools = gaiaTools('/tmp/wd', {
      scratchpad,
      getPointers: () => pointers,
    }) as Record<string, unknown>
    const out = (await asExecutable(tools['recall_tool_summary']).execute({
      recall_id: 'G_MISSING',
      reason: 'try',
    })) as { error: string; available_ids: string[] }
    expect(out.error).toContain('G_MISSING')
    expect(out.available_ids).toEqual(['G1'])
  })

  test('recall_tool_full returns scratchpad raw tool_result output', async () => {
    const scratchpad = createInMemoryScratchpad<AtomicGroup>()
    const raw = [{ title: 'A', url: 'https://a', snippet: 'long snippet' }]
    scratchpad.put('G1', groupFor('G1', 'web_search', raw))
    const tools = gaiaTools('/tmp/wd', {
      scratchpad,
      getPointers: () => [],
    }) as Record<string, unknown>
    const out = (await asExecutable(tools['recall_tool_full']).execute({
      recall_id: 'G1',
      reason: 'need raw',
    })) as { recall_id: string; tool_name: string; output: unknown }
    expect(out.recall_id).toBe('G1')
    expect(out.tool_name).toBe('web_search')
    expect(out.output).toEqual(raw)
  })

  test('recall_tool_full on unknown id → error (no scratchpad entry)', async () => {
    const scratchpad = createInMemoryScratchpad<AtomicGroup>()
    const tools = gaiaTools('/tmp/wd', {
      scratchpad,
      getPointers: () => [],
    }) as Record<string, unknown>
    const out = (await asExecutable(tools['recall_tool_full']).execute({
      recall_id: 'G_GONE',
      reason: 'try',
    })) as { error: string }
    expect(out.error).toContain('G_GONE')
  })

  test('two-stage flow: summary first, then full for the same id', async () => {
    const scratchpad = createInMemoryScratchpad<AtomicGroup>()
    const raw = { stdout: 'PRINT 42', stderr: '', exit_code: 0 }
    scratchpad.put('G2', groupFor('G2', 'python_exec', raw))
    const pointers = [pointer('G2', 'python_exec', '{"stdout_head":"PRINT 42"}')]
    const tools = gaiaTools('/tmp/wd', {
      scratchpad,
      getPointers: () => pointers,
    }) as Record<string, unknown>
    const summary = (await asExecutable(tools['recall_tool_summary']).execute({
      recall_id: 'G2',
      reason: 'cheap first',
    })) as { summary: string }
    expect(summary.summary).toContain('PRINT 42')
    const full = (await asExecutable(tools['recall_tool_full']).execute({
      recall_id: 'G2',
      reason: 'need exact',
    })) as { output: unknown }
    expect(full.output).toEqual(raw)
  })
})
