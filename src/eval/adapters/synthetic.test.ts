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

  test('prepare emits [system, user] — system needed for AHC middleware to engage', async () => {
    const [task] = await syntheticAdapter.loadTasks(42)
    if (!task) throw new Error('expected task')
    const conv = syntheticAdapter.prepare(task)
    expect(conv.messages).toHaveLength(2)
    expect(conv.messages[0]?.role).toBe('system')
    expect(conv.messages[1]?.role).toBe('user')
    const userPart = conv.messages[1]?.content[0]
    expect(userPart?.type).toBe('text')
    if (userPart?.type === 'text') expect(userPart.text).toBe(String(task.input))
  })
})

describe('synthetic grader', () => {
  test('exact-match scoring returns 1 on match, 0 on mismatch', async () => {
    const [task] = await syntheticAdapter.loadTasks(42)
    if (!task) throw new Error('expected task')

    const matchScore = await syntheticGrader.score(task, emptyResponse(String(task.expected)))
    expect(matchScore.primary).toBe(1)

    const missScore = await syntheticGrader.score(task, emptyResponse('wrong'))
    expect(missScore.primary).toBe(0)
  })
})
