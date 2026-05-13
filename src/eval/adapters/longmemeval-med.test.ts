import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunnerResponse } from '../types.js'
import {
  createLongMemEvalGrader,
  longmemevalAdapter,
  type LongMemEvalTask,
} from './longmemeval-med.js'

function makeTask(overrides: Partial<LongMemEvalTask> = {}): LongMemEvalTask {
  return {
    question_id: 'lme_q_001',
    question_type: 'single-session-user',
    haystack_sessions: [
      [
        { role: 'user', content: 'I went to Berlin last week.' },
        { role: 'assistant', content: 'Nice, how was the trip?' },
      ],
    ],
    haystack_session_ids: ['session_1'],
    haystack_dates: ['2024-05-10'],
    question: 'Where did the user go last week?',
    answer: 'Berlin',
    ...overrides,
  }
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
  testDir = mkdtempSync(join(tmpdir(), 'ahc-lme-adapter-'))
  mkdirSync(join(testDir, 'benchmarks/longmemeval/tasks'), { recursive: true })
  process.chdir(testDir)
})

afterEach(() => {
  process.chdir(originalCwd)
  rmSync(testDir, { recursive: true, force: true })
})

describe('longmemevalAdapter.loadTasks', () => {
  it('returns empty list when tasks/ dir empty', async () => {
    const tasks = await longmemevalAdapter.loadTasks(42)
    expect(tasks).toEqual([])
  })

  it('reads JSON files into Task[] with id=question_id', async () => {
    const t1 = makeTask({ question_id: 'lme_001' })
    const t2 = makeTask({ question_id: 'lme_002', answer: 'Paris' })
    writeFileSync(
      join(testDir, 'benchmarks/longmemeval/tasks/lme_001.json'),
      JSON.stringify(t1),
    )
    writeFileSync(
      join(testDir, 'benchmarks/longmemeval/tasks/lme_002.json'),
      JSON.stringify(t2),
    )
    const tasks = await longmemevalAdapter.loadTasks(42)
    expect(tasks).toHaveLength(2)
    expect(tasks.map((t) => t.id).sort()).toEqual(['lme_001', 'lme_002'])
  })
})

describe('longmemevalAdapter.prepare', () => {
  it('returns 2-message Conversation: flattened history + final question', () => {
    const task = makeTask()
    const conv = longmemevalAdapter.prepare({ id: task.question_id, input: task, expected: task.answer })
    expect(conv.messages).toHaveLength(2)
    expect(conv.messages[0]?.role).toBe('user')
    expect(conv.messages[1]?.role).toBe('user')
    const historyText = (conv.messages[0]?.content[0] as { type: string; text: string }).text
    expect(historyText).toContain('Berlin')
    expect(historyText).toContain('session_1')
    expect(historyText).toContain('2024-05-10')
    const questionText = (conv.messages[1]?.content[0] as { type: string; text: string }).text
    expect(questionText).toBe('Where did the user go last week?')
  })

  it('handles missing haystack_session_ids / haystack_dates gracefully', () => {
    const task = makeTask({ haystack_session_ids: undefined, haystack_dates: undefined })
    const conv = longmemevalAdapter.prepare({ id: task.question_id, input: task, expected: task.answer })
    const historyText = (conv.messages[0]?.content[0] as { type: string; text: string }).text
    // Default session label is `[session_N]`
    expect(historyText).toContain('[session_1]')
  })
})

describe('LongMemEval Grader', () => {
  it('stub grader (no judge dep) returns primary=0', async () => {
    const grader = createLongMemEvalGrader()
    const task = makeTask()
    const score = await grader.score(
      { id: task.question_id, input: task, expected: task.answer },
      fakeRunnerResponse('Berlin'),
    )
    expect(score.primary).toBe(0)
  })

  it('with injected judge fn: yes→1, propagates justification + cost', async () => {
    const fakeJudge = vi.fn().mockResolvedValue({
      score: 1,
      justification: 'matched',
      cost_usd: 0.000225,
    })
    const grader = createLongMemEvalGrader({ llmJudge: fakeJudge })
    const task = makeTask()
    const score = await grader.score(
      { id: task.question_id, input: task, expected: task.answer },
      fakeRunnerResponse('Berlin'),
    )
    expect(score.primary).toBe(1)
    expect(score.judge_explanation).toBe('matched')
    expect(score.judge_cost_usd).toBe(0.000225)
    expect(fakeJudge).toHaveBeenCalledTimes(1)
  })
})
