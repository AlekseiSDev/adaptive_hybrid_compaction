import type { BenchAdapter, Grader, Task } from '../types.js'

const TASKS: readonly Task[] = [
  { id: 'syn-001', input: '2+2', expected: '4' },
  { id: 'syn-002', input: 'capital of France', expected: 'Paris' },
]

export const syntheticAdapter: BenchAdapter = {
  name: 'synthetic',
  loadTasks: (_seed) => Promise.resolve(TASKS.map((t) => ({ ...t }))),
  prepare: (task) => ({
    messages: [{ role: 'user', content: [{ type: 'text', text: String(task.input) }] }],
  }),
}

export const syntheticGrader: Grader = {
  score: (task, response) =>
    Promise.resolve({ primary: response.text === task.expected ? 1 : 0 }),
}
