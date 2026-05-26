import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RunnerResponse, Task } from '../types.js'
import {
  answerScorer,
  gaiaAdapter,
  gaiaGrader,
  getFinalAnswer,
  renderGaiaPrompt,
} from './gaia-med.js'
import type { GaiaTask } from './gaia-med.schema.js'

function makeTask(overrides: Partial<GaiaTask> = {}): GaiaTask {
  return {
    idx: 0,
    question: 'What is the answer?',
    answer: '17',
    level: '1',
    has_file: false,
    file_path: '',
    ...overrides,
  }
}

function fakeResp(text: string): RunnerResponse {
  return { text, turns: [], errors: [], totals: { input: 0, output: 0 }, cost_usd: 0 }
}

describe('GAIA normalization helpers', () => {
  describe('answerScorer numeric', () => {
    it('matches integer answer exactly', () => {
      expect(answerScorer('17', '17')).toBe(true)
    })
    it('handles $ and , in model answer', () => {
      expect(answerScorer('$1,000', '1000')).toBe(true)
    })
    it('handles % suffix in model answer', () => {
      expect(answerScorer('86%', '86')).toBe(true)
    })
    it('rejects numeric mismatch', () => {
      expect(answerScorer('17', '42')).toBe(false)
    })
    it('rejects non-numeric model answer for numeric gt', () => {
      expect(answerScorer('seventeen', '17')).toBe(false)
    })
  })

  describe('answerScorer list', () => {
    it('matches same-order list', () => {
      expect(answerScorer('34689,12345', '34689,12345')).toBe(true)
    })
    it('rejects different-order list (strict positional per design §3.4)', () => {
      expect(answerScorer('12345, 34689', '34689,12345')).toBe(false)
    })
    it('rejects different-length list', () => {
      expect(answerScorer('1,2', '1,2,3')).toBe(false)
    })
    it('tolerates whitespace around commas', () => {
      expect(answerScorer('17 ,  42', '17,42')).toBe(true)
    })
    it('handles semicolon-separated lists', () => {
      expect(answerScorer('a;b;c', 'a;b;c')).toBe(true)
    })
  })

  describe('answerScorer text', () => {
    it('matches case-insensitive with trailing punctuation', () => {
      expect(answerScorer('Egalitarian.', 'egalitarian')).toBe(true)
    })
    it('strips spaces and punctuation', () => {
      expect(answerScorer('  egalitarian!! ', 'egalitarian')).toBe(true)
    })
    it('rejects different word', () => {
      expect(answerScorer('libertarian', 'egalitarian')).toBe(false)
    })
  })

  describe('getFinalAnswer', () => {
    it('extracts text after plain "Final answer:" prefix', () => {
      expect(getFinalAnswer('Reasoning...\nFinal answer: 17')).toBe('17')
    })
    it('extracts text after bold "Final answer:**" prefix', () => {
      expect(getFinalAnswer('**Final answer:** 17')).toBe('17')
    })
    it('takes last segment when multiple "Final answer:" present', () => {
      expect(getFinalAnswer('Final answer: 1\nthen Final answer: 2')).toBe('2')
    })
    it('falls back to full text when prefix absent', () => {
      expect(getFinalAnswer('17')).toBe('17')
    })
    it('trims whitespace', () => {
      expect(getFinalAnswer('Final answer:   42   ')).toBe('42')
    })
  })
})

describe('gaiaGrader.score', () => {
  it('returns primary=1.0 for matching numeric (with prefix)', async () => {
    const task: Task = { id: 'gaia_000', input: makeTask({ answer: '17' }), expected: '17' }
    const score = await gaiaGrader.score(task, fakeResp('Final answer: 17'))
    expect(score.primary).toBe(1.0)
    expect(score.judge_cost_usd).toBe(0)
    expect(score.secondary).toEqual({ level: 1 })
  })

  it('returns primary=1.0 for case-insensitive text', async () => {
    const task: Task = {
      id: 'gaia_001',
      input: makeTask({ idx: 1, answer: 'egalitarian', level: '2' }),
      expected: 'egalitarian',
    }
    const score = await gaiaGrader.score(task, fakeResp('...Final answer: Egalitarian.'))
    expect(score.primary).toBe(1.0)
    expect(score.secondary).toEqual({ level: 2 })
  })

  it('returns primary=0.0 for mismatch', async () => {
    const task: Task = { id: 'gaia_000', input: makeTask({ answer: '17' }), expected: '17' }
    const score = await gaiaGrader.score(task, fakeResp('Final answer: 42'))
    expect(score.primary).toBe(0.0)
  })

  it('returns primary=1.0 with fallback when prefix missing (full text match)', async () => {
    const task: Task = { id: 'gaia_000', input: makeTask({ answer: '17' }), expected: '17' }
    const score = await gaiaGrader.score(task, fakeResp('17'))
    expect(score.primary).toBe(1.0)
  })

  it('returns primary=0.0 with extracted_empty marker on empty response', async () => {
    const task: Task = { id: 'gaia_000', input: makeTask({ answer: '17' }), expected: '17' }
    const score = await gaiaGrader.score(task, fakeResp(''))
    expect(score.primary).toBe(0.0)
    expect(score.secondary?.['extracted_empty']).toBe(1)
  })
})

describe('renderGaiaPrompt', () => {
  it('wraps question in ===-delimited block', () => {
    const out = renderGaiaPrompt(makeTask({ question: 'How many?' }))
    expect(out).toContain('How many?')
    expect(out).toContain('===')
  })
})

describe('gaiaAdapter', () => {
  let testDir: string
  let originalCwd: string

  beforeEach(() => {
    originalCwd = process.cwd()
    testDir = mkdtempSync(join(tmpdir(), 'ahc-gaia-adapter-'))
    mkdirSync(join(testDir, 'benchmarks/gaia/tasks'), { recursive: true })
    process.chdir(testDir)
  })

  afterEach(() => {
    process.chdir(originalCwd)
    rmSync(testDir, { recursive: true, force: true })
  })

  it('loadTasks returns empty when dir empty', async () => {
    const tasks = await gaiaAdapter.loadTasks(42)
    expect(tasks).toEqual([])
  })

  it('loadTasks reads JSON files into Task[] with zero-padded id', async () => {
    const t1 = makeTask({ idx: 0 })
    const t2 = makeTask({ idx: 5, answer: 'Paris', level: '2' })
    writeFileSync(
      join(testDir, 'benchmarks/gaia/tasks/gaia_000.json'),
      JSON.stringify(t1),
    )
    writeFileSync(
      join(testDir, 'benchmarks/gaia/tasks/gaia_005.json'),
      JSON.stringify(t2),
    )
    const tasks = await gaiaAdapter.loadTasks(42)
    expect(tasks).toHaveLength(2)
    expect(tasks.map((t) => t.id).sort()).toEqual(['gaia_000', 'gaia_005'])
    expect(tasks[0]?.expected).toBe('17')
    expect(tasks[1]?.expected).toBe('Paris')
  })

  it('prepare returns 1-message Conversation with rendered prompt', () => {
    const task = makeTask()
    const conv = gaiaAdapter.prepare({ id: 'gaia_000', input: task, expected: task.answer })
    expect(conv.messages).toHaveLength(1)
    expect(conv.messages[0]?.role).toBe('user')
    const text = (conv.messages[0]?.content[0] as { type: string; text: string }).text
    expect(text).toContain('What is the answer?')
  })
})
