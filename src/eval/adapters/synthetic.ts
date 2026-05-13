import type { BenchAdapter, Grader, Task } from '../types.js'

const TASKS: readonly Task[] = [
  { id: 'syn-001', input: '2+2', expected: '4' },
  { id: 'syn-002', input: 'capital of France', expected: 'Paris' },
]

export const syntheticAdapter: BenchAdapter = {
  name: 'synthetic',
  loadTasks: (_seed) => Promise.resolve(TASKS.map((t) => ({ ...t }))),
  prepare: (task) => ({
    // System message is required for AHC middleware to engage — see
    // src/adapters/ai-sdk-v6.ts:94 (transformParams passes through when no
    // system message is present). Single sentence keeps grader simple.
    messages: [
      {
        role: 'system',
        content: [{ type: 'text', text: 'You are a helpful assistant. Answer concisely.' }],
      },
      { role: 'user', content: [{ type: 'text', text: String(task.input) }] },
    ],
  }),
}

export const syntheticGrader: Grader = {
  score: (task, response) =>
    Promise.resolve({ primary: response.text === task.expected ? 1 : 0 }),
}
