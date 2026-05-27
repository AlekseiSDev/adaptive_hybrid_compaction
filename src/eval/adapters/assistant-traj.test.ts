import { describe, expect, it } from 'vitest'
import type { RunnerResponse, Task } from '../types.js'
import {
  assistantTrajAdapter,
  assistantTrajGrader,
  createAssistantTrajGrader,
  loadAllAssistantTrajTasks,
  type EvaluationSpec,
} from './assistant-traj.js'
import type { AssistantTrajTask } from './assistant-traj.schema.js'

function fakeResponse(text: string): RunnerResponse {
  return { text, turns: [], errors: [], totals: { input: 0, output: 0 }, cost_usd: 0 }
}

function makeAtTask(overrides: Partial<AssistantTrajTask> = {}): AssistantTrajTask {
  const base: AssistantTrajTask = {
    task_id: 'at_mixed_001',
    category: 'mixed',
    source: 'synthetic',
    turns: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    tools_available: [],
    evaluation: { strategy: 'exact_match', expected: 'hi' },
    provenance: {},
  }
  return { ...base, ...overrides }
}

function harnessTask(at: AssistantTrajTask): Task {
  return { id: at.task_id, input: at, expected: at.evaluation }
}

describe('assistantTrajAdapter — loadTasks', () => {
  it('reads tasks/*.json and wires id/input/expected', async () => {
    const tasks = await assistantTrajAdapter.loadTasks(0)
    expect(tasks.length).toBeGreaterThan(0)
    for (const t of tasks) {
      expect(t.id).toMatch(
        /^at_(image_qa|code_iter|research_write|mixed)(?:_jc_[a-z]{1,4})?_\d{3}$/,
      )
      const at = t.input as AssistantTrajTask
      expect(at.task_id).toBe(t.id)
      expect(t.expected).toBe(at.evaluation)
    }
  })

  it('loadAllAssistantTrajTasks parses every file via the schema', async () => {
    const all = await loadAllAssistantTrajTasks()
    expect(all.length).toBeGreaterThan(0)
    for (const t of all) {
      expect(['image_qa', 'code_iter', 'research_write', 'mixed']).toContain(t.category)
    }
  })
})

describe('assistantTrajAdapter — D6 deprecated-filter + AT-v3 multi-turn', () => {
  it('loadAllAssistantTrajTasks default skips provenance.deprecated=true', async () => {
    const visible = await loadAllAssistantTrajTasks()
    const all = await loadAllAssistantTrajTasks({ includeDeprecated: true })
    expect(all.length).toBeGreaterThan(visible.length)
    expect(visible.every((t) => t.provenance.deprecated !== true)).toBe(true)
    expect(all.some((t) => t.provenance.deprecated === true)).toBe(true)
  })

  it('AT-v3 jay-canvas task with N user turns produces N messages in Conversation (reroll-ready)', async () => {
    const all = await loadAllAssistantTrajTasks()
    const multiTurn = all.find(
      (t) =>
        t.task_id.includes('_jc_') &&
        t.turns.filter((tu) => tu.role === 'user').length >= 2,
    )
    if (!multiTurn) {
      // No multi-turn AT-v3 task yet — skip with a clear marker rather than fail.
      console.warn('no multi-turn AT-v3 task found; skip reroll proof')
      return
    }
    const conv = assistantTrajAdapter.prepare(harnessTask(multiTurn))
    const userCount = multiTurn.turns.filter((t) => t.role === 'user').length
    expect(conv.messages).toHaveLength(userCount)
    expect(conv.messages.every((m) => m.role === 'user')).toBe(true)
  })
})

describe('assistantTrajAdapter — prepare (replay-only)', () => {
  it('returns user-only Conversation; recorded assistant turns dropped', () => {
    const at = makeAtTask({
      turns: [
        { role: 'user', content: [{ type: 'text', text: 'q1' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'a1' }] },
        { role: 'user', content: [{ type: 'text', text: 'q2' }] },
      ],
    })
    const conv = assistantTrajAdapter.prepare(harnessTask(at))
    expect(conv.messages).toHaveLength(2)
    expect(conv.messages.every((m) => m.role === 'user')).toBe(true)
    expect(conv.messages[0]?.content[0]).toMatchObject({ type: 'text', text: 'q1' })
    expect(conv.messages[1]?.content[0]).toMatchObject({ type: 'text', text: 'q2' })
  })

  it('image content becomes a text placeholder for text-only baselines', () => {
    const at = makeAtTask({
      turns: [
        {
          role: 'user',
          content: [
            { type: 'image', path: 'attachments/at_image_qa_001/1.svg', alt: 'chart' },
            { type: 'text', text: 'describe' },
          ],
        },
      ],
    })
    const conv = assistantTrajAdapter.prepare(harnessTask(at))
    expect(conv.messages).toHaveLength(1)
    const parts = conv.messages[0]?.content ?? []
    expect(parts[0]).toMatchObject({ type: 'text' })
    const placeholder = parts[0] as { type: 'text'; text: string }
    expect(placeholder.text).toContain('Image attachment')
    expect(placeholder.text).toContain('attachments/at_image_qa_001/1.svg')
    expect(placeholder.text).toContain('alt=chart')
    expect(parts[1]).toMatchObject({ type: 'text', text: 'describe' })
  })
})

describe('assistantTrajGrader — exact_match', () => {
  it('1.0 on exact equal; 0.0 otherwise (case-sensitive default)', async () => {
    const at = makeAtTask({ evaluation: { strategy: 'exact_match', expected: 'foo' } })
    expect((await assistantTrajGrader.score(harnessTask(at), fakeResponse('foo'))).primary).toBe(1)
    expect((await assistantTrajGrader.score(harnessTask(at), fakeResponse('Foo'))).primary).toBe(0)
  })

  it('case_sensitive=false lowercases both sides', async () => {
    const at = makeAtTask({
      evaluation: { strategy: 'exact_match', expected: 'FOO', case_sensitive: false },
    })
    expect((await assistantTrajGrader.score(harnessTask(at), fakeResponse('foo'))).primary).toBe(1)
  })
})

describe('assistantTrajGrader — regex', () => {
  it('1.0 on match; 0.0 on miss', async () => {
    const at = makeAtTask({ evaluation: { strategy: 'regex', pattern: '^hello' } })
    expect(
      (await assistantTrajGrader.score(harnessTask(at), fakeResponse('hello world'))).primary,
    ).toBe(1)
    expect(
      (await assistantTrajGrader.score(harnessTask(at), fakeResponse('goodbye'))).primary,
    ).toBe(0)
  })

  it('respects flags', async () => {
    const at = makeAtTask({ evaluation: { strategy: 'regex', pattern: 'hello', flags: 'i' } })
    expect(
      (await assistantTrajGrader.score(harnessTask(at), fakeResponse('HELLO'))).primary,
    ).toBe(1)
  })
})

describe('assistantTrajGrader — composite', () => {
  function spec(aggregate: 'all' | 'any' | 'mean'): EvaluationSpec {
    return {
      strategy: 'composite',
      aggregate,
      rules: [
        { strategy: 'regex', pattern: 'foo' },
        { strategy: 'regex', pattern: 'bar' },
      ],
    }
  }

  it('aggregate=all → 1.0 iff every sub-rule == 1.0', async () => {
    const at = makeAtTask({ evaluation: spec('all') })
    expect(
      (await assistantTrajGrader.score(harnessTask(at), fakeResponse('foo bar'))).primary,
    ).toBe(1)
    expect(
      (await assistantTrajGrader.score(harnessTask(at), fakeResponse('foo'))).primary,
    ).toBe(0)
  })

  it('aggregate=any → 1.0 if any sub-rule == 1.0', async () => {
    const at = makeAtTask({ evaluation: spec('any') })
    expect(
      (await assistantTrajGrader.score(harnessTask(at), fakeResponse('foo'))).primary,
    ).toBe(1)
    expect(
      (await assistantTrajGrader.score(harnessTask(at), fakeResponse('baz'))).primary,
    ).toBe(0)
  })

  it('aggregate=mean → averages sub-primaries', async () => {
    const at = makeAtTask({
      evaluation: {
        strategy: 'composite',
        aggregate: 'mean',
        rules: [
          { strategy: 'regex', pattern: 'foo' },
          { strategy: 'regex', pattern: 'baz' },
        ],
      },
    })
    expect(
      (await assistantTrajGrader.score(harnessTask(at), fakeResponse('foo bar'))).primary,
    ).toBe(0.5)
  })

  it('recurses through nested composites', async () => {
    const at = makeAtTask({
      evaluation: {
        strategy: 'composite',
        aggregate: 'all',
        rules: [
          { strategy: 'regex', pattern: 'foo' },
          {
            strategy: 'composite',
            aggregate: 'any',
            rules: [
              { strategy: 'regex', pattern: 'bar' },
              { strategy: 'regex', pattern: 'baz' },
            ],
          },
        ],
      },
    })
    expect(
      (await assistantTrajGrader.score(harnessTask(at), fakeResponse('foo bar'))).primary,
    ).toBe(1)
    expect(
      (await assistantTrajGrader.score(harnessTask(at), fakeResponse('foo quux'))).primary,
    ).toBe(0)
  })
})

describe('assistantTrajGrader — llm_judge', () => {
  it('default stub → primary=0 + judge_explanation=judge-stub', async () => {
    const at = makeAtTask({
      evaluation: {
        strategy: 'llm_judge',
        rubric_id: 'mixed',
        expected_summary: 'whatever',
      },
    })
    const s = await assistantTrajGrader.score(harnessTask(at), fakeResponse('any'))
    expect(s.primary).toBe(0)
    expect(s.judge_explanation).toBe('judge-stub')
    expect(s.judge_cost_usd).toBeUndefined()
  })

  it('with injected llmJudge dep → score/justification/cost flow through', async () => {
    const at = makeAtTask({
      evaluation: {
        strategy: 'llm_judge',
        rubric_id: 'image_qa',
        expected_summary: 'expected',
      },
    })
    const grader = createAssistantTrajGrader({
      llmJudge: (_task, _resp, _spec) =>
        Promise.resolve({ score: 0.5, justification: 'ok-ish', cost_usd: 0.01 }),
    })
    const s = await grader.score(harnessTask(at), fakeResponse('whatever'))
    expect(s.primary).toBe(0.5)
    expect(s.judge_explanation).toBe('ok-ish')
    expect(s.judge_cost_usd).toBe(0.01)
  })

  it('composite containing llm_judge propagates judge_cost_usd to top score', async () => {
    const at = makeAtTask({
      evaluation: {
        strategy: 'composite',
        aggregate: 'all',
        rules: [
          { strategy: 'regex', pattern: 'foo' },
          { strategy: 'llm_judge', rubric_id: 'mixed', expected_summary: 'sum' },
        ],
      },
    })
    const grader = createAssistantTrajGrader({
      llmJudge: (_task, _resp, _spec) =>
        Promise.resolve({ score: 1, justification: 'good', cost_usd: 0.02 }),
    })
    const s = await grader.score(harnessTask(at), fakeResponse('foo bar'))
    expect(s.primary).toBe(1)
    expect(s.judge_cost_usd).toBe(0.02)
  })
})
