import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { makeTauBenchMastraAgentRunner } from './index.js'
import { runTauEpisodeMastra } from './mastra-agent-runner.js'
import { retailTools } from './tools.js'
import type { Episode } from './types.js'

// Minimal Episode fixture — empty initial state. Used for shape tests
// that don't touch live LLMs. retailTools(envState) closure shape must be
// AI-SDK-compatible enough that Mastra accepts it via `ToolsInput` cast (per
// investigation H1).
const makeMiniEpisode = (id = 'mastra-tau-mini'): Episode => ({
  episode_id: id,
  task_idx: 0,
  instruction: 'Hello, this is a smoke test.',
  initial_state: {
    users: {},
    orders: {},
    products: {},
  },
  expected_end_state: {
    users: {},
    orders: {},
    products: {},
  },
})

let workspace: string

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'ahc-mastra-tau-'))
})

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true })
})

describe('retailTools shape compat with Mastra ToolsInput (I2 investigation H1)', () => {
  test('retailTools(envState) returns Record<string, tool-shaped object> with execute()', () => {
    const envState = makeMiniEpisode().initial_state
    const tools = retailTools(envState)
    const keys = Object.keys(tools)
    expect(keys.length).toBeGreaterThanOrEqual(10)
    // Sample 1 tool — verify AI SDK ToolV5 shape fields that Mastra
    // ToolsInput recognizes: description, inputSchema, execute.
    const firstKey = keys[0]
    if (firstKey === undefined) throw new Error('no tools — impossible')
    const first = tools[firstKey]
    if (first === undefined) throw new Error(`tool ${firstKey} missing`)
    expect(typeof first.description).toBe('string')
    expect(first.inputSchema).toBeDefined()
    expect(typeof first.execute).toBe('function')
  })

  test('all retail tools expose execute() — translator-free Mastra registration', () => {
    const tools = retailTools(makeMiniEpisode().initial_state)
    for (const [name, t] of Object.entries(tools)) {
      expect(t.execute, `tool ${name} missing execute()`).toBeDefined()
    }
  })
})

describe('makeTauBenchMastraAgentRunner — factory shape', () => {
  beforeEach(() => {
    // 2026-05-27 dual-mode: factory calls resolveLLMClient at construction.
    vi.stubEnv('LITELLM_MASTER_KEY', 'sk-test')
    vi.stubEnv('LITELLM_BASE_URL', 'http://localhost:4400/v1')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  test('runner.name === "mastra-agent" (matches baseline string)', () => {
    const runner = makeTauBenchMastraAgentRunner({})
    expect(runner.name).toBe('mastra-agent')
  })

  test('runner.execute exists и принимает Conversation + RunnerContext', () => {
    const runner = makeTauBenchMastraAgentRunner({})
    expect(typeof runner.execute).toBe('function')
  })
})

// Live live smoke — 1 retail episode end-to-end.
// Gated by OPENROUTER_API_KEY. ~$0.50-$1 spend per run.
const LIVE = Boolean(process.env['OPENROUTER_API_KEY'])
const liveDescribe = LIVE ? describe : describe.skip

liveDescribe('runTauEpisodeMastra — real Mastra+OpenRouter integration', () => {
  test(
    '1 retail episode produces reward result + ≥0 tool calls (loop runs end-to-end)',
    async () => {
      const apiKey = process.env['OPENROUTER_API_KEY'] ?? ''
      const { createOpenAI } = await import('@ai-sdk/openai')
      const openai = createOpenAI({
        apiKey,
        baseURL: 'https://openrouter.ai/api/v1',
      })
      const userSimModel = openai.chat('openai/gpt-4o-mini')

      const result = await runTauEpisodeMastra(makeMiniEpisode('live-tau-1'), {
        actorModel: {
          apiKey,
          providerId: 'openrouter',
          modelId: 'openai/gpt-5.4-mini',
          url: 'https://openrouter.ai/api/v1',
        },
        userSimModel,
        actorSystem: 'You are a retail support assistant. Be brief.',
        storageRootDir: workspace,
        maxSteps: 4,
      })
      expect(result.reward).toBeGreaterThanOrEqual(0)
      expect(result.reward).toBeLessThanOrEqual(1)
      expect(result.n_steps).toBeGreaterThan(0)
      expect(result.cost_usd).toBeGreaterThanOrEqual(0)
    },
    120_000,
  )
})
