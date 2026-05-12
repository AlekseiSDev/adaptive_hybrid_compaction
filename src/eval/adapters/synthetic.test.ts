import { describe, expect, test } from 'vitest'
import { syntheticAdapter, syntheticGrader } from './synthetic.js'
import type { RunnerResponse } from '../types.js'

const emptyResponse = (text: string): RunnerResponse => ({
  text,
  turns: [],
  errors: [],
  totals: { input: 0, output: 0 },
  cost_usd: 0,
})

describe('synthetic bench adapter', () => {
  test('loadTasks(42) returns deterministic 2-task set', async () => {
    const a = await syntheticAdapter.loadTasks(42)
    const b = await syntheticAdapter.loadTasks(42)
    expect(a).toHaveLength(2)
    expect(a.map((t) => t.id)).toEqual(['syn-001', 'syn-002'])
    expect(a).toEqual(b)
  })

  test('prepare wraps task.input as a single user text message', async () => {
    const [task] = await syntheticAdapter.loadTasks(42)
    if (!task) throw new Error('expected task')
    const conv = syntheticAdapter.prepare(task)
    expect(conv.messages).toHaveLength(1)
    expect(conv.messages[0]?.role).toBe('user')
    const part = conv.messages[0]?.content[0]
    expect(part?.type).toBe('text')
    if (part?.type === 'text') expect(part.text).toBe(String(task.input))
  })
})

describe('synthetic grader', () => {
  test('exact-match scoring returns 1 on match, 0 on mismatch', async () => {
    const [task] = await syntheticAdapter.loadTasks(42)
    if (!task) throw new Error('expected task')

    const matchScore = syntheticGrader.score(task, emptyResponse(String(task.expected)))
    expect(matchScore.primary).toBe(1)

    const missScore = syntheticGrader.score(task, emptyResponse('wrong'))
    expect(missScore.primary).toBe(0)
  })
})
