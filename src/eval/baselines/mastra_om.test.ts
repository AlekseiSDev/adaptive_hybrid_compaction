import { mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { mastraOmBaseline } from './mastra_om.js'
import type { Message, Task } from '../types.js'

const makeTask = (id = 'mastra-t1'): Task => ({
  id,
  input: 'hi',
  expected: 'hello',
})

const makeUser = (text: string): Message => ({
  role: 'user',
  content: [{ type: 'text', text }],
})

let workspace: string

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'ahc-mastra-om-'))
})

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true })
})

describe('mastraOmBaseline.name + prepare', () => {
  test('name is "mastra_om"', () => {
    const baseline = mastraOmBaseline({
      apiKey: 'placeholder',
      storageRootDir: workspace,
    })
    expect(baseline.name).toBe('mastra_om')
  })

  test('prepare returns state with thread_id derived from task.id', () => {
    const baseline = mastraOmBaseline({
      apiKey: 'placeholder',
      storageRootDir: workspace,
    })
    const state = baseline.prepare(makeTask('task-abc'))
    expect(state.task_id).toBe('task-abc')
    expect(state.history).toEqual([])
    const scratch = state.scratch
    expect(scratch?.['thread_id']).toBe('mastra_task-abc')
    expect(scratch?.['storage_path']).toMatch(/c1_task-abc\.db$/)
  })

  test('prepare records mastra_config in scratch for reproducibility (§4.3)', () => {
    const baseline = mastraOmBaseline({
      apiKey: 'placeholder',
      storageRootDir: workspace,
    })
    const state = baseline.prepare(makeTask())
    const scratch = state.scratch
    const config = scratch?.['mastra_config'] as Record<string, unknown> | undefined
    expect(config).toBeDefined()
    expect(config?.['model']).toBe('openrouter/google/gemini-3-flash-preview')
    expect(config?.['provider_id']).toBe('openrouter')
    expect(config?.['storage_kind']).toBe('libsql')
    expect(config?.['mastra_version']).toBe('1.32.1')
  })

  test('prepare sanitizes unsafe chars in task.id for file safety', () => {
    const baseline = mastraOmBaseline({
      apiKey: 'placeholder',
      storageRootDir: workspace,
    })
    const state = baseline.prepare(makeTask('foo/bar baz!'))
    const scratch = state.scratch
    expect(scratch?.['storage_path']).toMatch(/c1_foo_bar_baz_\.db$/)
    expect(scratch?.['thread_id']).toBe('mastra_foo_bar_baz_')
    expect(state.task_id).toBe('foo/bar baz!')
  })

  test('two prepare calls for distinct task.ids → distinct thread_ids + storage_paths', () => {
    const baseline = mastraOmBaseline({
      apiKey: 'placeholder',
      storageRootDir: workspace,
    })
    const a = baseline.prepare(makeTask('task-a'))
    const b = baseline.prepare(makeTask('task-b'))
    expect(a.scratch).toBeDefined()
    expect(b.scratch).toBeDefined()
    if (!a.scratch || !b.scratch) return
    expect(a.scratch['thread_id']).not.toBe(b.scratch['thread_id'])
    expect(a.scratch['storage_path']).not.toBe(b.scratch['storage_path'])
  })

  test('finalize removes per-task SQLite file (idempotent if file absent)', async () => {
    const baseline = mastraOmBaseline({
      apiKey: 'placeholder',
      storageRootDir: workspace,
    })
    const state = baseline.prepare(makeTask())
    // No step → no file created → finalize must not throw.
    await expect(baseline.finalize?.(state)).resolves.toBeUndefined()
    expect(state.scratch).toBeDefined()
    if (!state.scratch) return
    expect(existsSync(state.scratch['storage_path'] as string)).toBe(false)
  })
})

// Real-LLM integration test (skip-marked: needs OPENROUTER_API_KEY in env).
// Per memory feedback "real-LLM-early" + design exit criterion §4: step()
// roundtrip with real Mastra + Gemini, thread persistence across turns.
const LIVE = Boolean(process.env['OPENROUTER_API_KEY'])
const liveDescribe = LIVE ? describe : describe.skip

liveDescribe('mastraOmBaseline.step — real Mastra+OpenRouter integration', () => {
  test(
    'single step: response.content has non-empty text + history grows 2',
    async () => {
      const baseline = mastraOmBaseline({
        apiKey: process.env['OPENROUTER_API_KEY'] ?? '',
        storageRootDir: workspace,
      })
      const state0 = baseline.prepare(makeTask('live-1'))
      try {
        const r = await baseline.step(state0, makeUser('Say the word "ready" verbatim.'))
        const text =
          r.response.content.find((p) => p.type === 'text')?.text ?? ''
        expect(text.length).toBeGreaterThan(0)
        expect(r.state.history).toHaveLength(2)
        expect(r.telemetry.input_tokens).toBeGreaterThan(0)
        expect(r.telemetry.output_tokens).toBeGreaterThan(0)
        expect(r.cost_usd).toBe(0) // Mastra owns provider call, cost not tracked here
      } finally {
        await baseline.finalize?.(state0)
      }
    },
    30_000,
  )

  test(
    'two steps to same thread: Mastra remembers prior turn (memory works)',
    async () => {
      const baseline = mastraOmBaseline({
        apiKey: process.env['OPENROUTER_API_KEY'] ?? '',
        storageRootDir: workspace,
      })
      let state = baseline.prepare(makeTask('live-2'))
      try {
        const r1 = await baseline.step(
          state,
          makeUser('My favorite color is teal. Just acknowledge.'),
        )
        state = r1.state
        const r2 = await baseline.step(state, makeUser('What is my favorite color?'))
        state = r2.state
        const text2 =
          r2.response.content.find((p) => p.type === 'text')?.text ?? ''
        expect(text2.toLowerCase()).toContain('teal')
        expect(state.history).toHaveLength(4)
        // thread_id stable across both steps
        expect(state.scratch).toBeDefined()
        if (!state.scratch) return
        expect(state.scratch['thread_id']).toBe('mastra_live-2')
      } finally {
        await baseline.finalize?.(state)
      }
    },
    60_000,
  )

  test(
    'three-turn pin-recall through Mastra OM (distractor in middle)',
    async () => {
      const baseline = mastraOmBaseline({
        apiKey: process.env['OPENROUTER_API_KEY'] ?? '',
        storageRootDir: workspace,
      })
      let state = baseline.prepare(makeTask('live-3'))
      try {
        const r1 = await baseline.step(
          state,
          makeUser('Remember: my pin code is 4271. Just acknowledge it.'),
        )
        state = r1.state
        const r2 = await baseline.step(
          state,
          makeUser('Unrelated: what is 2 plus 2?'),
        )
        state = r2.state
        const r3 = await baseline.step(
          state,
          makeUser(
            'What pin code did I tell you earlier? Reply with just the digits.',
          ),
        )
        state = r3.state

        const text3 =
          r3.response.content.find((p) => p.type === 'text')?.text ?? ''
        expect(text3).toContain('4271')
        expect(state.history).toHaveLength(6)
        expect(state.scratch).toBeDefined()
        if (!state.scratch) return
        expect(state.scratch['thread_id']).toBe('mastra_live-3')
      } finally {
        await baseline.finalize?.(state)
      }
    },
    90_000,
  )
})
