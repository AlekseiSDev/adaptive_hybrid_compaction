import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LLMClient, LLMResponse, RunnerResponse } from '../types.js'
import {
  buildLocomoJudgeRequest,
  createLoCoMoGrader,
  locomoAdapter,
  locomoJudge,
  type LoCoMoTask,
} from './locomo-med.js'

function makeTask(overrides: Partial<LoCoMoTask> = {}): LoCoMoTask {
  return {
    sample_id: 'conv-43',
    qa_idx: 48,
    category: 1,
    category_name: 'single-hop',
    question: 'When did John get an ankle injury in 2023?',
    answer: 'around November 16, 2023',
    evidence: ['D18:2'],
    conversation: {
      speaker_a: 'John',
      speaker_b: 'Alice',
      session_1: [
        { speaker: 'John', text: 'Hi Alice, I twisted my ankle last week.', dia_id: 'D18:1' },
        { speaker: 'Alice', text: 'When did it happen?', dia_id: 'D18:2' },
      ],
      session_1_date_time: '2023-11-23',
      session_2: [
        { speaker: 'John', text: 'It happened around Nov 16, jumping at the gym.', dia_id: 'D18:3' },
      ],
      session_2_date_time: '2023-11-30',
    },
    ...overrides,
  }
}

function fakeResp(text: string, tokens = 50): LLMResponse {
  return {
    text,
    raw_usage: { prompt_tokens: tokens, completion_tokens: 5 },
    finish_reason: 'stop',
    latency_ms: 10,
  }
}

function client(text: string): LLMClient {
  return vi.fn().mockResolvedValue(fakeResp(text))
}

function fakeRunnerResponse(text: string): RunnerResponse {
  return {
    text,
    turns: [],
    errors: [],
    totals: { input: 0, output: 0 },
    cost_usd: 0,
  }
}

let testDir: string
let originalCwd: string

beforeEach(() => {
  originalCwd = process.cwd()
  testDir = mkdtempSync(join(tmpdir(), 'ahc-locomo-'))
  mkdirSync(join(testDir, 'benchmarks/locomo/tasks'), { recursive: true })
  process.chdir(testDir)
})

afterEach(() => {
  process.chdir(originalCwd)
  rmSync(testDir, { recursive: true, force: true })
})

describe('locomoAdapter.loadTasks', () => {
  it('returns empty list when tasks/ dir empty', async () => {
    expect(await locomoAdapter.loadTasks(42)).toEqual([])
  })

  it('reads JSON files into Task[] with id=sample_id_qa<idx>', async () => {
    const t = makeTask()
    writeFileSync(
      join(testDir, 'benchmarks/locomo/tasks/lo_001.json'),
      JSON.stringify(t),
    )
    const tasks = await locomoAdapter.loadTasks(42)
    expect(tasks).toHaveLength(1)
    expect(tasks[0]?.id).toBe('conv-43_qa48')
    expect(tasks[0]?.expected).toBe('around November 16, 2023')
  })
})

describe('locomoAdapter.prepare', () => {
  it('flattens multi-session conversation to user-turn segments + final question', () => {
    const task = makeTask()
    const conv = locomoAdapter.prepare({
      id: `${task.sample_id}_qa${String(task.qa_idx)}`,
      input: task,
      expected: task.answer,
    })
    expect(conv.messages).toHaveLength(2)
    const historyText = (conv.messages[0]?.content[0] as { type: string; text: string }).text
    expect(historyText).toContain('session_1')
    expect(historyText).toContain('session_2')
    expect(historyText).toContain('2023-11-23')
    expect(historyText).toContain('John: Hi Alice')
    expect(historyText).toContain('Alice: When did it happen?')
    const questionText = (conv.messages[1]?.content[0] as { type: string; text: string }).text
    expect(questionText).toBe(task.question)
  })

  it('orders sessions numerically (session_2 after session_10 would fail string-sort)', () => {
    const task = makeTask({
      conversation: {
        speaker_a: 'A',
        speaker_b: 'B',
        session_1: [{ speaker: 'A', text: 'first session' }],
        session_10: [{ speaker: 'A', text: 'tenth session' }],
        session_2: [{ speaker: 'A', text: 'second session' }],
      },
    })
    const conv = locomoAdapter.prepare({ id: 'x', input: task, expected: '' })
    const historyText = (conv.messages[0]?.content[0] as { type: string; text: string }).text
    const i1 = historyText.indexOf('first session')
    const i2 = historyText.indexOf('second session')
    const i10 = historyText.indexOf('tenth session')
    expect(i1).toBeGreaterThanOrEqual(0)
    expect(i2).toBeGreaterThan(i1)
    expect(i10).toBeGreaterThan(i2)
  })
})

describe('buildLocomoJudgeRequest', () => {
  it('produces single user message with reasonable-equivalence prompt', () => {
    const req = buildLocomoJudgeRequest(makeTask(), 'November 16', 'anthropic/claude-sonnet-4.6')
    expect(req.model).toBe('anthropic/claude-sonnet-4.6')
    expect(req.temperature).toBe(0)
    expect(req.max_tokens).toBe(10)
    expect(req.messages).toHaveLength(1)
    const content = req.messages[0]?.content as string
    expect(content).toContain('reasonable')
    expect(content).toContain('equivalence')
    expect(content).toContain(makeTask().question)
    expect(content).toContain('November 16')
  })
})

describe('locomoJudge', () => {
  it('maps "yes" to 1 with sonnet cost', async () => {
    const r = await locomoJudge(makeTask(), 'around Nov 16', {
      llmClient: client('yes'),
      persist: false,
    })
    expect(r.score).toBe(1)
    expect(r.cost_usd).toBeCloseTo(0.000225, 6)
  })

  it('maps "no" to 0', async () => {
    const r = await locomoJudge(makeTask(), 'wrong', { llmClient: client('no'), persist: false })
    expect(r.score).toBe(0)
  })
})

describe('LoCoMo Grader', () => {
  it('stub returns primary=0', async () => {
    const grader = createLoCoMoGrader()
    const score = await grader.score(
      { id: 'x', input: makeTask(), expected: '' },
      fakeRunnerResponse('whatever'),
    )
    expect(score.primary).toBe(0)
  })

  it('with judge: propagates score + justification + cost', async () => {
    const fakeJudge = vi.fn().mockResolvedValue({
      score: 1,
      justification: 'equivalent',
      cost_usd: 0.0003,
    })
    const grader = createLoCoMoGrader({ llmJudge: fakeJudge })
    const score = await grader.score(
      { id: 'x', input: makeTask(), expected: '' },
      fakeRunnerResponse('Nov 16'),
    )
    expect(score.primary).toBe(1)
    expect(score.judge_explanation).toBe('equivalent')
    expect(score.judge_cost_usd).toBe(0.0003)
  })
})
