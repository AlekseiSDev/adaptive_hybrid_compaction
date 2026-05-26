/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
//
// Unit tests for runGaiaTask. AI SDK `generateText` is mocked at module
// level — we test runner orchestration (workspace lifecycle, cost
// accounting, error capture, tool wiring) without touching a real
// provider. Type lint suppressions above scoped to test-only file: the
// mocked return value is structurally compatible with GenerateTextResult
// but TS can't infer that from `vi.mocked(...)` patterns.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as aiModule from 'ai'
import { runGaiaTask } from './agent-runner.js'
import type { GaiaTask } from '../gaia-med.schema.js'

vi.mock('ai', async () => {
  const actual = await vi.importActual<typeof aiModule>('ai')
  return {
    ...actual,
    generateText: vi.fn(),
  }
})

import { generateText } from 'ai'

const generateTextMock = vi.mocked(generateText)

function makeTask(overrides: Partial<GaiaTask> = {}): GaiaTask {
  return {
    idx: 0,
    question: 'What is 2+2?',
    answer: '4',
    level: '1',
    has_file: false,
    file_path: '',
    ...overrides,
  }
}

describe('runGaiaTask', () => {
  let workspaceDir: string
  const stubModel = {} as any

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), 'ahc-gaia-runner-'))
    generateTextMock.mockReset()
  })
  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true })
  })

  it('returns result with text + cost from generateText', async () => {
    generateTextMock.mockResolvedValue({
      text: 'Final answer: 4',
      steps: [],
      totalUsage: { inputTokens: 100, outputTokens: 10 },
    } as any)
    const result = await runGaiaTask(makeTask(), {
      actorModel: stubModel,
      actorSystem: 'sys',
      actorModelId: 'openai/gpt-5.4-mini',
      workspaceDir,
    })
    expect(result.finalText).toBe('Final answer: 4')
    expect(result.cost_usd).toBeGreaterThan(0)
    expect(result.totals).toEqual({ input: 100, output: 10 })
    expect(result.errors).toHaveLength(0)
    expect(result.n_tool_calls).toBe(0)
  })

  it('counts tool calls across steps', async () => {
    generateTextMock.mockResolvedValue({
      text: 'done',
      steps: [{ toolCalls: [{}, {}] }, { toolCalls: [{}] }],
      totalUsage: { inputTokens: 50, outputTokens: 10 },
    } as any)
    const result = await runGaiaTask(makeTask(), {
      actorModel: stubModel,
      actorSystem: 'sys',
      workspaceDir,
    })
    expect(result.n_tool_calls).toBe(3)
    expect(result.n_steps).toBe(2)
  })

  it('captures generateText error в errors[] (no throw)', async () => {
    generateTextMock.mockRejectedValue(new Error('rate limited'))
    const result = await runGaiaTask(makeTask(), {
      actorModel: stubModel,
      actorSystem: 'sys',
      workspaceDir,
    })
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]?.message).toContain('rate limited')
    expect(result.finalText).toBe('')
  })

  it('passes maxSteps to stopWhen', async () => {
    generateTextMock.mockResolvedValue({
      text: 'x',
      steps: [],
      totalUsage: { inputTokens: 1, outputTokens: 1 },
    } as any)
    await runGaiaTask(makeTask(), {
      actorModel: stubModel,
      actorSystem: 'sys',
      workspaceDir,
      maxSteps: 7,
    })
    const callArgs = generateTextMock.mock.calls[0]?.[0]
    expect(callArgs).toBeDefined()
    expect(callArgs?.stopWhen).toBeDefined()
  })

  it('wires tools into generateText call', async () => {
    generateTextMock.mockResolvedValue({
      text: 'x',
      steps: [],
      totalUsage: { inputTokens: 1, outputTokens: 1 },
    } as any)
    await runGaiaTask(makeTask(), {
      actorModel: stubModel,
      actorSystem: 'sys',
      workspaceDir,
    })
    const callArgs = generateTextMock.mock.calls[0]?.[0]
    const tools = callArgs?.tools as Record<string, unknown> | undefined
    expect(tools).toBeDefined()
    expect(Object.keys(tools ?? {})).toEqual(
      expect.arrayContaining([
        'web_search',
        'visit_webpage',
        'text_editor',
        'python_exec',
        'describe_image',
      ]),
    )
  })

  it('rejects ahcFlags without ahcInternalLlmClient', async () => {
    await expect(
      runGaiaTask(makeTask(), {
        actorModel: stubModel,
        actorSystem: 'sys',
        workspaceDir,
        ahcFlags: { TASK_AWARE_EXTRACTION: true },
      }),
    ).rejects.toThrow(/ahcInternalLlmClient/)
  })
})
