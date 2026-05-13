import { describe, expect, it, vi } from 'vitest'
import type { LLMClient, LLMResponse } from '../types.js'
import {
  buildLmeJudgeRequest,
  lmeJudge,
  selectJudgeTemplate,
  type LongMemEvalTask,
} from './longmemeval-med.judge.js'

function makeTask(overrides: Partial<LongMemEvalTask> = {}): LongMemEvalTask {
  return {
    question_id: 'q1',
    question_type: 'single-session-user',
    haystack_sessions: [],
    question: 'When did Alice arrive?',
    answer: 'On Tuesday.',
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

describe('selectJudgeTemplate', () => {
  it('picks abstention template when question_id ends with _abs', () => {
    const tpl = selectJudgeTemplate('single-session-user', 'q1_abs')
    expect(tpl('Q', 'A', 'R')).toContain('correctly identify the question as unanswerable')
  })

  it('picks temporal template for temporal-reasoning', () => {
    const tpl = selectJudgeTemplate('temporal-reasoning', 'q1')
    expect(tpl('Q', 'A', 'R')).toContain('off-by-one errors')
  })

  it('picks knowledge-update template', () => {
    const tpl = selectJudgeTemplate('knowledge-update', 'q1')
    expect(tpl('Q', 'A', 'R')).toContain('previous information along with an updated answer')
  })

  it('picks preference template', () => {
    const tpl = selectJudgeTemplate('single-session-preference', 'q1')
    expect(tpl('Q', 'A', 'R')).toContain('rubric for desired personalized response')
  })

  it('picks base template for single-session-user / single-session-assistant / multi-session', () => {
    for (const qt of [
      'single-session-user',
      'single-session-assistant',
      'multi-session',
    ] as const) {
      const tpl = selectJudgeTemplate(qt, 'q1')
      // Base template lacks the distinctive markers of the other 4 templates
      const text = tpl('Q', 'A', 'R')
      expect(text).not.toContain('off-by-one')
      expect(text).not.toContain('rubric for desired')
      expect(text).not.toContain('previous information along with')
      expect(text).not.toContain('correctly identify the question as unanswerable')
    }
  })
})

describe('buildLmeJudgeRequest', () => {
  it('produces single-message user request with prompt, temp 0, max_tokens 10', () => {
    const req = buildLmeJudgeRequest(makeTask(), 'On Tue.', 'anthropic/claude-sonnet-4.6')
    expect(req.model).toBe('anthropic/claude-sonnet-4.6')
    expect(req.temperature).toBe(0)
    expect(req.max_tokens).toBe(10)
    expect(req.messages).toHaveLength(1)
    expect(req.messages[0]?.role).toBe('user')
    const content = req.messages[0]?.content
    expect(typeof content).toBe('string')
    expect(content as string).toContain('When did Alice arrive?')
    expect(content as string).toContain('On Tuesday.')
    expect(content as string).toContain('On Tue.')
  })
})

describe('lmeJudge — end-to-end', () => {
  it('maps "yes" response to score 1.0 + cost from sonnet pricing', async () => {
    const r = await lmeJudge(makeTask(), 'On Tue.', {
      llmClient: client('yes'),
      persist: false,
    })
    expect(r.score).toBe(1.0)
    // 50 prompt + 5 completion at $3/M + $15/M = (50*3 + 5*15)/1e6 = 0.000225
    expect(r.cost_usd).toBeCloseTo(0.000225, 6)
  })

  it('maps "no" response to score 0.0', async () => {
    const r = await lmeJudge(makeTask(), 'wrong', {
      llmClient: client('no'),
      persist: false,
    })
    expect(r.score).toBe(0.0)
  })

  it('parse failure on ambiguous response → score 0 + diag', async () => {
    const r = await lmeJudge(makeTask(), 'something', {
      llmClient: client('I think the answer is correct'),
      persist: false,
    })
    expect(r.score).toBe(0)
    expect(r.justification).toMatch(/parse failed/i)
    expect(r.cost_usd).toBe(0)
  })
})
