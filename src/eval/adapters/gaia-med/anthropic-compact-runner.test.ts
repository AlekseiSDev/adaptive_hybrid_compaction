// Tests for runGaiaTaskAnthropicCompact (K-tail-4 GAIA Anthropic /compact).
//
// Anthropic SDK mocked at module level — никакого live API calls. Verify (a)
// tools forwarded to client.beta.messages.create, (b) tool_use → dispatch →
// tool_result echo на next call, (c) compaction_block accumulation, (d) cost
// computed по haiku pricing.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type * as GaiaToolsModule from '../gaia-tools/index.js'
import type { GaiaTask } from '../gaia-med.schema.js'

// Module-level mock — must be hoisted via vi.mock в самом начале.
type MockCallArgs = Record<string, unknown>
const createCalls: MockCallArgs[] = []
const createMock = vi.fn<(args: MockCallArgs) => Promise<unknown>>()
vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: class MockAnthropic {
      beta = {
        messages: {
          create: (args: MockCallArgs) => {
            createCalls.push(args)
            return createMock(args)
          },
        },
      }
    },
  }
})

const baseTask: GaiaTask = {
  idx: 1,
  question: 'What is 7 * 6?',
  answer: '42',
  level: '1',
  has_file: false,
  file_path: '',
}

let workspace: string

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'ahc-anthropic-gaia-'))
  createCalls.length = 0
  createMock.mockReset()
})

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true })
})

describe('runGaiaTaskAnthropicCompact — tool dispatch + compaction echo', () => {
  test('simple end_turn — extracts final text, computes cost on haiku', async () => {
    createMock.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'Final answer: 42' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 100, output_tokens: 8 },
    })
    const { runGaiaTaskAnthropicCompact } = await import('./anthropic-compact-runner.js')
    const result = await runGaiaTaskAnthropicCompact(baseTask, {
      apiKey: 'sk-test',
      model: 'claude-haiku-4-5',
      actorSystem: 'You answer GAIA questions.',
      workspaceDir: workspace,
      maxSteps: 5,
    })
    expect(result.finalText).toBe('Final answer: 42')
    expect(result.n_steps).toBe(1)
    expect(result.n_tool_calls).toBe(0)
    expect(result.cost_usd).toBeCloseTo(
      (100 * 1.0 + 8 * 5.0) / 1_000_000,
      10,
    )
    expect(createCalls).toHaveLength(1)
    const first = createCalls[0] as { tools?: unknown[]; betas?: string[] }
    expect(first.tools).toBeDefined()
    expect(first.tools).toHaveLength(5)
    expect(first.betas).toEqual(['compact-2026-01-12'])
  })

  test('tool_use → dispatch → tool_result echoed on next request', async () => {
    // Step 1: tool_use (web_search) — but mock web_search exec через monkey-
    // patch chain. Instead, use python_exec which хотя бы не зовёт сеть. Tool
    // dispatch goes through gaia-tools/index.ts → real impls. python_exec
    // requires Python — fall back to text_editor read which is filesystem
    // only. We'll create a file and ask the agent to "read" it via text_editor.
    const filePath = join(workspace, 'answer.txt')
    await (await import('node:fs/promises')).writeFile(filePath, 'hello-42', 'utf8')

    createMock
      .mockResolvedValueOnce({
        content: [
          {
            type: 'tool_use',
            id: 'toolu_1',
            name: 'text_editor',
            input: { path: 'answer.txt' },
          },
        ],
        stop_reason: 'tool_use',
        usage: { input_tokens: 50, output_tokens: 12 },
      })
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: 'Final answer: hello-42' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 80, output_tokens: 6 },
      })

    const { runGaiaTaskAnthropicCompact } = await import('./anthropic-compact-runner.js')
    const result = await runGaiaTaskAnthropicCompact(baseTask, {
      apiKey: 'sk-test',
      model: 'claude-haiku-4-5',
      actorSystem: 'sys',
      workspaceDir: workspace,
      maxSteps: 5,
    })

    expect(result.finalText).toBe('Final answer: hello-42')
    expect(result.n_steps).toBe(2)
    expect(result.n_tool_calls).toBe(1)

    // 2nd call payload must include the tool_result message
    expect(createCalls).toHaveLength(2)
    const second = createCalls[1] as { messages: { role: string; content: unknown }[] }
    const lastUserMsg = second.messages[second.messages.length - 1]
    if (lastUserMsg === undefined) throw new Error('no last user message')
    expect(lastUserMsg.role).toBe('user')
    const toolResults = lastUserMsg.content as {
      type: string
      tool_use_id: string
      content: string
    }[]
    const firstToolResult = toolResults[0]
    if (firstToolResult === undefined) throw new Error('no tool_result emitted')
    expect(firstToolResult.type).toBe('tool_result')
    expect(firstToolResult.tool_use_id).toBe('toolu_1')
    expect(firstToolResult.content).toContain('hello-42')
  })

  test('compaction block accumulates as synthetic user prefix on subsequent request', async () => {
    createMock
      .mockResolvedValueOnce({
        content: [
          { type: 'compaction', content: 'compacted-prefix', encrypted_content: 'enc-xyz' },
          {
            type: 'tool_use',
            id: 'toolu_2',
            name: 'web_search',
            input: { query: 'test' },
          },
        ],
        stop_reason: 'tool_use',
        usage: { input_tokens: 110_000, output_tokens: 100 },
      })
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: 'Final answer: done' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 200, output_tokens: 10 },
      })

    // Stub webSearch so it doesn't hit the network — replace at module level.
    vi.doMock('../gaia-tools/index.js', async () => {
      const actual = await vi.importActual<typeof GaiaToolsModule>(
        '../gaia-tools/index.js',
      )
      return {
        ...actual,
        webSearch: () =>
          Promise.resolve({ results: [{ title: 't', url: 'u', snippet: 's' }] }),
      }
    })
    vi.resetModules()
    const { runGaiaTaskAnthropicCompact } = await import('./anthropic-compact-runner.js')

    const result = await runGaiaTaskAnthropicCompact(baseTask, {
      apiKey: 'sk-test',
      model: 'claude-haiku-4-5',
      actorSystem: 'sys',
      workspaceDir: workspace,
      maxSteps: 5,
    })

    expect(result.n_compactions).toBe(1)
    expect(result.finalText).toBe('Final answer: done')

    // 2nd request payload first message — must be the compaction prefix
    expect(createCalls).toHaveLength(2)
    const second = createCalls[1] as { messages: { role: string; content: unknown }[] }
    const firstMsg = second.messages[0]
    if (firstMsg === undefined) throw new Error('no messages in 2nd call')
    expect(firstMsg.role).toBe('user')
    const prefix = firstMsg.content as {
      type: string
      content?: string
      encrypted_content?: string
    }[]
    const firstPrefix = prefix[0]
    if (firstPrefix === undefined) throw new Error('no compaction prefix')
    expect(firstPrefix.type).toBe('compaction')
    expect(firstPrefix.content).toBe('compacted-prefix')
    expect(firstPrefix.encrypted_content).toBe('enc-xyz')

    vi.doUnmock('../gaia-tools/index.js')
  })
})
