import { describe, expect, test } from 'vitest'
import {
  createAssistantTrajGrader,
  evaluateToolCalls,
} from './assistant-traj.js'
import type { AssistantTrajTask } from './assistant-traj.schema.js'
import type { RunnerResponse, Task } from '../types.js'

const taskWithGoogleSearch: AssistantTrajTask = {
  task_id: 'at_research_write_001',
  category: 'research_write',
  source: 'opensource',
  turns: [
    {
      role: 'user',
      content: [{ type: 'text', text: 'Find news on TypeScript 5.5.' }],
      expected_tool_calls: [{ tool_name: 'google_search', required: true }],
    },
  ],
  tools_available: [
    {
      name: 'google_search',
      description: 'Web search',
      input_schema: { type: 'object' },
    },
  ],
  evaluation: {
    strategy: 'regex',
    pattern: 'TypeScript',
  },
  provenance: {},
}

const taskMultiRequired: AssistantTrajTask = {
  task_id: 'at_mixed_001',
  category: 'mixed',
  source: 'opensource',
  turns: [
    {
      role: 'user',
      content: [{ type: 'text', text: 'Search, fetch, then plot.' }],
      expected_tool_calls: [
        { tool_name: 'google_search', required: true },
        { tool_name: 'web_fetch', required: true },
        { tool_name: 'code_interpreter', required: true },
      ],
    },
  ],
  tools_available: [
    { name: 'google_search', description: 's', input_schema: {} },
    { name: 'web_fetch', description: 'f', input_schema: {} },
    { name: 'code_interpreter', description: 'c', input_schema: {} },
  ],
  evaluation: { strategy: 'regex', pattern: '.+' },
  provenance: {},
}

function buildResponse(overrides: Partial<RunnerResponse>): RunnerResponse {
  return {
    text: '',
    turns: [],
    errors: [],
    totals: { input: 0, output: 0 },
    cost_usd: 0,
    ...overrides,
  }
}

describe('evaluateToolCalls — presence check', () => {
  test('pass when required tool observed', () => {
    const result = evaluateToolCalls(taskWithGoogleSearch, [
      { name: 'google_search', args: { q: 'ts 5.5' } },
    ])
    expect(result).toEqual({ required_called: 1, required_total: 1, pass: true })
  })

  test('fail when required tool absent', () => {
    const result = evaluateToolCalls(taskWithGoogleSearch, [
      { name: 'web_fetch', args: { url: 'https://x' } },
    ])
    expect(result).toEqual({ required_called: 0, required_total: 1, pass: false })
  })

  test('fail when no toolCalls observed at all', () => {
    const result = evaluateToolCalls(taskWithGoogleSearch, undefined)
    expect(result.pass).toBe(false)
  })

  test('partial pass with multi-required', () => {
    const result = evaluateToolCalls(taskMultiRequired, [
      { name: 'google_search', args: { q: 'x' } },
      { name: 'code_interpreter', args: { code: 'print(1)' } },
    ])
    expect(result).toEqual({
      required_called: 2,
      required_total: 3,
      pass: false,
    })
  })

  test('all required called → pass', () => {
    const result = evaluateToolCalls(taskMultiRequired, [
      { name: 'google_search', args: {} },
      { name: 'web_fetch', args: {} },
      { name: 'code_interpreter', args: {} },
    ])
    expect(result).toEqual({
      required_called: 3,
      required_total: 3,
      pass: true,
    })
  })

  test('task with no required tools → pass trivially', () => {
    const noRequired: AssistantTrajTask = {
      ...taskWithGoogleSearch,
      turns: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'hi' }],
          expected_tool_calls: [{ tool_name: 'google_search', required: false }],
        },
      ],
    }
    const result = evaluateToolCalls(noRequired, [])
    expect(result.pass).toBe(true)
  })

  test('extra non-required observed calls do not break pass', () => {
    const result = evaluateToolCalls(taskWithGoogleSearch, [
      { name: 'google_search', args: { q: 'ts' } },
      { name: 'web_fetch', args: { url: 'https://x' } },
    ])
    expect(result.pass).toBe(true)
  })
})

describe('createAssistantTrajGrader — hard-gate aggregation', () => {
  const grader = createAssistantTrajGrader()

  function asTask(at: AssistantTrajTask): Task {
    return { id: at.task_id, input: at, expected: at.evaluation }
  }

  test('content pass + tool pass → primary=1', async () => {
    const score = await grader.score(
      asTask(taskWithGoogleSearch),
      buildResponse({
        text: 'TypeScript 5.5 ships ...',
        toolCalls: [{ name: 'google_search', args: { q: 'ts 5.5' } }],
      }),
    )
    expect(score.primary).toBe(1)
    expect(score.tool_coherence?.pass).toBe(true)
  })

  test('content pass but tool miss → primary=0 (hard-gate)', async () => {
    const score = await grader.score(
      asTask(taskWithGoogleSearch),
      buildResponse({
        text: 'TypeScript 5.5 ships ...',
        toolCalls: [],
      }),
    )
    expect(score.primary).toBe(0)
    expect(score.tool_coherence).toEqual({
      required_called: 0,
      required_total: 1,
      pass: false,
    })
  })

  test('content fail + tool pass → primary still 0 (content × tool)', async () => {
    const score = await grader.score(
      asTask(taskWithGoogleSearch),
      buildResponse({
        text: 'random unrelated text',
        toolCalls: [{ name: 'google_search', args: { q: 'ts' } }],
      }),
    )
    expect(score.primary).toBe(0)
    expect(score.tool_coherence?.pass).toBe(true)
  })

  test('tool_coherence always populated even on text-only legacy task (no required tools)', async () => {
    const legacy: AssistantTrajTask = {
      ...taskWithGoogleSearch,
      turns: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'just answer' }],
        },
      ],
      tools_available: [],
    }
    const score = await grader.score(
      asTask(legacy),
      buildResponse({ text: 'TypeScript hello' }),
    )
    // No required tools → coherence trivially passes; content score
    // (regex match on "TypeScript") gets through.
    expect(score.tool_coherence).toEqual({
      required_called: 0,
      required_total: 0,
      pass: true,
    })
    expect(score.primary).toBe(1)
  })
})
