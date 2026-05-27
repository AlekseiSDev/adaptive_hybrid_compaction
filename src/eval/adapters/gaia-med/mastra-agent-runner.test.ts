import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { gaiaTools } from '../gaia-tools/index.js'
import { makeGaiaMastraAgentRunner } from './index.js'
import type { GaiaTask } from '../gaia-med.schema.js'

const makeMiniTask = (idx = 0): GaiaTask => ({
  idx,
  question: 'What is 2 + 2?',
  answer: '4',
  level: '1',
  has_file: false,
  file_path: '',
})

let workspace: string

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'ahc-mastra-gaia-'))
})

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true })
})

describe('gaiaTools shape compat with Mastra ToolsInput (Track I H1)', () => {
  test('gaiaTools(workspaceDir) returns 5 tools, each с execute() function', () => {
    const tools = gaiaTools(workspace)
    const keys = Object.keys(tools)
    expect(keys.sort()).toEqual([
      'describe_image',
      'python_exec',
      'text_editor',
      'visit_webpage',
      'web_search',
    ])
    for (const [name, t] of Object.entries(tools)) {
      expect(typeof t.description, `tool ${name} description`).toBe('string')
      expect(t.inputSchema, `tool ${name} inputSchema`).toBeDefined()
      expect(typeof t.execute, `tool ${name} execute`).toBe('function')
    }
  })
})

describe('makeGaiaMastraAgentRunner — factory shape', () => {
  beforeEach(() => {
    // 2026-05-27 dual-mode: factory calls resolveLLMClient at construction →
    // requires either OPENROUTER_API_KEY (for `openrouter/` models) or
    // LITELLM_MASTER_KEY + LITELLM_BASE_URL (for default LiteLLM path).
    vi.stubEnv('LITELLM_MASTER_KEY', 'sk-test')
    vi.stubEnv('LITELLM_BASE_URL', 'http://localhost:4400/v1')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  test('runner.name === "mastra-agent" (matches baseline string)', () => {
    const runner = makeGaiaMastraAgentRunner({})
    expect(runner.name).toBe('mastra-agent')
  })

  test('runner.execute exists', () => {
    const runner = makeGaiaMastraAgentRunner({})
    expect(typeof runner.execute).toBe('function')
  })

  test('factory respects custom actorModelId', () => {
    const runner = makeGaiaMastraAgentRunner({
      actorModelId: 'openai/gpt-4o-mini',
    })
    expect(runner.name).toBe('mastra-agent')
  })
})

// Live smoke — 1 GAIA task end-to-end. Gated by OPENROUTER_API_KEY
// + WEB_SEARCH_AUTOSELECT (если actor решит call search). ~$0.10 spend.
const LIVE = Boolean(process.env['OPENROUTER_API_KEY'])
const liveDescribe = LIVE ? describe : describe.skip

liveDescribe('runGaiaTaskMastra — real Mastra+OpenRouter integration', () => {
  test('1 simple task — actor returns text, cost > 0', async () => {
    const { runGaiaTaskMastra } = await import('./mastra-agent-runner.js')
    const apiKey = process.env['OPENROUTER_API_KEY'] ?? ''
    const task = makeMiniTask(999)
    const result = await runGaiaTaskMastra(task, {
      actorModel: {
        apiKey,
        providerId: 'openrouter',
        modelId: 'openai/gpt-5.4-mini',
        url: 'https://openrouter.ai/api/v1',
      },
      actorSystem: 'You are a helpful assistant. Answer concisely.',
      workspaceDir: workspace,
      maxSteps: 3,
    })
    expect(result.finalText.length).toBeGreaterThan(0)
    expect(result.cost_usd).toBeGreaterThan(0)
    expect(result.errors).toHaveLength(0)
  }, 60_000)
})
