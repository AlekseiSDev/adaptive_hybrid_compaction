import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { buildMemoryOptions, mastraAgentBaseline } from './mastra_agent.js'
import type { Message, Task } from '../types.js'

const makeTask = (id = 'magent-t1'): Task => ({
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
  workspace = await mkdtemp(join(tmpdir(), 'ahc-mastra-agent-'))
})

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true })
})

describe('buildMemoryOptions — OM model override carries through', () => {
  test('observationalMemory.model returns explicit object (matches mastra_om S13 fix)', () => {
    const opts = buildMemoryOptions({
      apiKey: 'sk-test',
      providerId: 'openrouter',
      modelId: 'openai/gpt-5.4-mini',
      url: 'https://openrouter.ai/api/v1',
    })
    const model = opts.observationalMemory.model
    expect(model.providerId).toBe('openrouter')
    expect(model.modelId).toBe('openai/gpt-5.4-mini')
    expect(model.url).toBe('https://openrouter.ai/api/v1')
    expect(model.apiKey).toBe('sk-test')
  })

  test('defaults applied when deps omit provider/model/url', () => {
    const opts = buildMemoryOptions({ apiKey: 'sk-test' })
    const model = opts.observationalMemory.model
    expect(model.providerId).toBe('openrouter')
    expect(model.modelId).toBe('openai/gpt-5.4-mini')
    expect(model.url).toBe('https://openrouter.ai/api/v1')
    expect(model.apiKey).toBe('sk-test')
  })
})

describe('mastraAgentBaseline.name + prepare', () => {
  test('name is "mastra-agent" (dash, per design I_mastra_agent.md §2.4)', () => {
    const baseline = mastraAgentBaseline({
      apiKey: 'placeholder',
      storageRootDir: workspace,
    })
    expect(baseline.name).toBe('mastra-agent')
  })

  test('prepare returns state with thread_id derived from task.id', () => {
    const baseline = mastraAgentBaseline({
      apiKey: 'placeholder',
      storageRootDir: workspace,
    })
    const state = baseline.prepare(makeTask('task-xyz'))
    expect(state.task_id).toBe('task-xyz')
    expect(state.history).toEqual([])
    const scratch = state.scratch
    expect(scratch?.['thread_id']).toBe('mastra_agent_task-xyz')
    expect(scratch?.['resource_id']).toBe('ahc_resource_task-xyz')
    expect(scratch?.['storage_path']).toMatch(/c1_mastra_agent_task-xyz\.db$/)
  })

  test('prepare records mastra_agent_config in scratch (design §3.3)', () => {
    const baseline = mastraAgentBaseline({
      apiKey: 'placeholder',
      storageRootDir: workspace,
    })
    const state = baseline.prepare(makeTask())
    const scratch = state.scratch
    const config = scratch?.['mastra_agent_config'] as
      | Record<string, unknown>
      | undefined
    expect(config).toBeDefined()
    expect(config?.['model']).toBe('openrouter/openai/gpt-5.4-mini')
    expect(config?.['provider_id']).toBe('openrouter')
    expect(config?.['storage_kind']).toBe('libsql')
    expect(config?.['mastra_version']).toBe('1.32.1')
    // text-bench wiring: no tools registered.
    expect(config?.['tools_registered']).toEqual([])
  })

  test('prepare with deps.tools records registered tool names in config', () => {
    const baseline = mastraAgentBaseline({
      apiKey: 'placeholder',
      storageRootDir: workspace,
      tools: {
        get_user_details: {},
        cancel_pending_order: {},
      },
    })
    const state = baseline.prepare(makeTask())
    const config = state.scratch?.['mastra_agent_config'] as
      | Record<string, unknown>
      | undefined
    expect(config?.['tools_registered']).toEqual([
      'get_user_details',
      'cancel_pending_order',
    ])
  })

  test('prepare sanitizes unsafe chars in task.id for file safety', () => {
    const baseline = mastraAgentBaseline({
      apiKey: 'placeholder',
      storageRootDir: workspace,
    })
    const state = baseline.prepare(makeTask('foo/bar baz!'))
    const scratch = state.scratch
    expect(scratch?.['storage_path']).toMatch(
      /c1_mastra_agent_foo_bar_baz_\.db$/,
    )
    expect(scratch?.['thread_id']).toBe('mastra_agent_foo_bar_baz_')
    expect(state.task_id).toBe('foo/bar baz!')
  })

  test('two prepare calls for distinct task.ids → distinct thread_ids + storage_paths', () => {
    const baseline = mastraAgentBaseline({
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

  test('finalize is idempotent when no step ran (file may not exist)', async () => {
    const baseline = mastraAgentBaseline({
      apiKey: 'placeholder',
      storageRootDir: workspace,
    })
    const state = baseline.prepare(makeTask())
    await expect(baseline.finalize?.(state)).resolves.toBeUndefined()
    expect(state.scratch).toBeDefined()
    if (!state.scratch) return
    expect(existsSync(state.scratch['storage_path'] as string)).toBe(false)
  })
})

// Real-LLM live tests — gated by OPENROUTER_API_KEY (memory: real-LLM-early).
// Covers I1 exit criteria: cost > 0, history grows, multi-turn memory works.
const LIVE = Boolean(process.env['OPENROUTER_API_KEY'])
const liveDescribe = LIVE ? describe : describe.skip

liveDescribe('mastraAgentBaseline.step — real Mastra+OpenRouter integration', () => {
  test(
    'single step: response.content has non-empty text + cost > 0',
    async () => {
      const baseline = mastraAgentBaseline({
        apiKey: process.env['OPENROUTER_API_KEY'] ?? '',
        storageRootDir: workspace,
      })
      const state0 = baseline.prepare(makeTask('live-1'))
      try {
        const r = await baseline.step(
          state0,
          makeUser('Say the word "ready" verbatim.'),
        )
        const text =
          r.response.content.find((p) => p.type === 'text')?.text ?? ''
        expect(text.length).toBeGreaterThan(0)
        expect(r.state.history).toHaveLength(2)
        expect(r.telemetry.input_tokens).toBeGreaterThan(0)
        expect(r.telemetry.output_tokens).toBeGreaterThan(0)
        // Cost bubbling — regression guard, mirrors mastra_om 5777796 invariant.
        expect(r.cost_usd).toBeGreaterThan(0)
      } finally {
        await baseline.finalize?.(state0)
      }
    },
    30_000,
  )

  test(
    'two steps to same thread: Mastra Memory recalls prior turn',
    async () => {
      const baseline = mastraAgentBaseline({
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
        expect(state.scratch).toBeDefined()
        if (!state.scratch) return
        expect(state.scratch['thread_id']).toBe('mastra_agent_live-2')
      } finally {
        await baseline.finalize?.(state)
      }
    },
    60_000,
  )
})
