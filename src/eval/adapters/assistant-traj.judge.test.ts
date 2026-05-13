import { describe, expect, it, vi } from 'vitest'
import type { LLMClient, LLMRequest, LLMResponse } from '../types.js'
import type { LlmJudgeSpec } from './assistant-traj.js'
import {
  buildJudgeRequest,
  judge,
  judgeCacheKey,
  parseJudgeOutput,
  type JudgeCache,
} from './assistant-traj.judge.js'
import type { AssistantTrajTask } from './assistant-traj.schema.js'

function makeTask(overrides: Partial<AssistantTrajTask> = {}): AssistantTrajTask {
  const base: AssistantTrajTask = {
    task_id: 'at_mixed_001',
    category: 'mixed',
    source: 'synthetic',
    turns: [{ role: 'user', content: [{ type: 'text', text: 'final question' }] }],
    tools_available: [],
    evaluation: { strategy: 'llm_judge', rubric_id: 'mixed', expected_summary: 'a thing' },
    provenance: {},
  }
  return { ...base, ...overrides }
}

const SPEC: LlmJudgeSpec = { rubric_id: 'mixed', expected_summary: 'a thing' }

function fakeLLMResponse(text: string, tokens = 100): LLMResponse {
  return {
    text,
    raw_usage: { prompt_tokens: tokens, completion_tokens: tokens },
    finish_reason: 'stop',
    latency_ms: 10,
  }
}

function llmClientReturning(text: string): LLMClient {
  return vi.fn().mockResolvedValue(fakeLLMResponse(text))
}

describe('parseJudgeOutput', () => {
  it('parses a clean JSON object', () => {
    expect(parseJudgeOutput('{"score": 1.0, "justification": "good"}')).toEqual({
      score: 1.0,
      justification: 'good',
    })
  })

  it('extracts JSON wrapped in prose', () => {
    expect(
      parseJudgeOutput('Sure! Here is my judgement: {"score": 0.5, "justification": "ok"}'),
    ).toEqual({ score: 0.5, justification: 'ok' })
  })

  it('rejects invalid score values', () => {
    expect(parseJudgeOutput('{"score": 0.7, "justification": "x"}')).toBeNull()
    expect(parseJudgeOutput('{"score": "high", "justification": "x"}')).toBeNull()
  })

  it('returns null on malformed JSON', () => {
    expect(parseJudgeOutput('{not really json}')).toBeNull()
    expect(parseJudgeOutput('no json at all')).toBeNull()
  })

  it('tolerates missing justification', () => {
    expect(parseJudgeOutput('{"score": 0.0}')).toEqual({ score: 0, justification: '' })
  })
})

describe('buildJudgeRequest', () => {
  it('produces user message with rubric + question + expected + response (text-only)', () => {
    const task = makeTask()
    const req = buildJudgeRequest(task, 'baseline reply', {
      rubric: '# fake rubric body',
      model: 'anthropic/claude-sonnet-4.6',
      judgeSpec: SPEC,
    })
    expect(req.model).toBe('anthropic/claude-sonnet-4.6')
    expect(req.temperature).toBe(0)
    expect(req.messages).toHaveLength(2)
    expect(req.messages[0]?.role).toBe('system')
    const user = req.messages[1]
    expect(user?.role).toBe('user')
    expect(Array.isArray(user?.content)).toBe(true)
    const blocks = user?.content as { type: string; text?: string }[]
    expect(blocks[0]?.type).toBe('text')
    const text = blocks[0]?.text ?? ''
    expect(text).toContain('# fake rubric body')
    expect(text).toContain('final question')
    expect(text).toContain('a thing')
    expect(text).toContain('baseline reply')
    expect(text).toContain('Output JSON only')
  })

  it('appends image_url blocks when imageDataUrls provided', () => {
    const task = makeTask()
    const req = buildJudgeRequest(task, 'r', {
      rubric: 'r',
      model: 'm',
      judgeSpec: SPEC,
      imageDataUrls: ['data:image/png;base64,AAA', 'data:image/jpeg;base64,BBB'],
    })
    const blocks = req.messages[1]?.content as {
      type: string
      image_url?: { url: string }
    }[]
    expect(blocks).toHaveLength(3)
    expect(blocks[1]?.type).toBe('image_url')
    expect(blocks[1]?.image_url?.url).toBe('data:image/png;base64,AAA')
    expect(blocks[2]?.image_url?.url).toBe('data:image/jpeg;base64,BBB')
  })
})

describe('judgeCacheKey', () => {
  it('produces a stable sha256 hex string', () => {
    const task = makeTask()
    const req = buildJudgeRequest(task, 'r', {
      rubric: 'r',
      model: 'm',
      judgeSpec: SPEC,
    })
    const k1 = judgeCacheKey(task.task_id, req)
    const k2 = judgeCacheKey(task.task_id, req)
    expect(k1).toBe(k2)
    expect(k1).toMatch(/^[a-f0-9]{64}$/)
  })

  it('changes when task_id changes', () => {
    const a = makeTask({ task_id: 'at_mixed_001' })
    const b = makeTask({ task_id: 'at_mixed_002' })
    const req = buildJudgeRequest(a, 'r', { rubric: 'r', model: 'm', judgeSpec: SPEC })
    expect(judgeCacheKey(a.task_id, req)).not.toBe(judgeCacheKey(b.task_id, req))
  })
})

describe('judge — cache + parse paths', () => {
  it('cache hit short-circuits LLM call; cost_usd=0', async () => {
    const task = makeTask()
    const client = vi.fn() as unknown as LLMClient
    // Pre-compute the key the judge would use
    const dummyReq = buildJudgeRequest(task, 'baseline reply', {
      rubric: '',
      model: 'anthropic/claude-sonnet-4.6',
      judgeSpec: SPEC,
    })
    // We can't easily pre-compute the key without first calling the judge
    // (rubric body affects the request hash). Instead, seed the cache with
    // ANY entry and verify cache.length===0 after wouldn't help.
    // Strategy: call judge twice with persist=false, second hit pulls from
    // the cache mutated by first call.
    const cache: JudgeCache = {}
    void dummyReq
    const r1 = await judge(task, 'baseline reply', SPEC, {
      llmClient: llmClientReturning('{"score": 1.0, "justification": "yes"}'),
      cache,
      persist: false,
    })
    expect(r1.score).toBe(1.0)
    expect(Object.keys(cache).length).toBe(1)

    const r2 = await judge(task, 'baseline reply', SPEC, {
      llmClient: client,
      cache,
      persist: false,
    })
    expect(r2.score).toBe(1.0)
    expect(r2.cost_usd).toBe(0)
    expect(client).not.toHaveBeenCalled()
  })

  it('LLM parse failure → primary=0 + parse error in justification', async () => {
    const cache: JudgeCache = {}
    const r = await judge(makeTask(), 'whatever', SPEC, {
      llmClient: llmClientReturning('no JSON here at all'),
      cache,
      persist: false,
    })
    expect(r.score).toBe(0)
    expect(r.justification).toMatch(/parse failed/i)
    expect(r.cost_usd).toBe(0)
    // Failed judgements not cached (no entry written)
    expect(Object.keys(cache).length).toBe(0)
  })

  it('LLM error → primary=0 + error description in justification', async () => {
    const cache: JudgeCache = {}
    const errClient: LLMClient = () =>
      Promise.resolve({
        text: '',
        raw_usage: null,
        finish_reason: 'error',
        latency_ms: 1,
        error: { kind: 'auth', message: 'bad key' },
      })
    const r = await judge(makeTask(), 'response', SPEC, {
      llmClient: errClient,
      cache,
      persist: false,
    })
    expect(r.score).toBe(0)
    expect(r.justification).toContain('auth')
    expect(r.justification).toContain('bad key')
  })

  it('successful judge call computes cost from usage + sonnet-4.6 pricing', async () => {
    const cache: JudgeCache = {}
    const r = await judge(makeTask(), 'baseline reply', SPEC, {
      llmClient: llmClientReturning('{"score": 0.5, "justification": "ok"}'),
      model: 'anthropic/claude-sonnet-4.6',
      cache,
      persist: false,
    })
    expect(r.score).toBe(0.5)
    expect(r.justification).toBe('ok')
    // 100 prompt + 100 completion at $3/M + $15/M = (100*3 + 100*15)/1e6 = 0.0018
    expect(r.cost_usd).toBeCloseTo(0.0018, 6)
  })

  it('rubric_id fallback to category when rubric_id markdown not found', async () => {
    // 'image_qa' rubric exists; 'nonexistent_rubric' will fall back to category='mixed'
    const task = makeTask({ category: 'mixed' })
    const captured: LLMRequest[] = []
    const client: LLMClient = (req) => {
      captured.push(req)
      return Promise.resolve(fakeLLMResponse('{"score": 1.0, "justification": "x"}'))
    }
    const cache: JudgeCache = {}
    await judge(task, 'r', { rubric_id: 'nonexistent_rubric', expected_summary: 'x' }, {
      llmClient: client,
      cache,
      persist: false,
    })
    expect(captured).toHaveLength(1)
    const text = (captured[0]?.messages[1]?.content as { text?: string }[])[0]?.text
    // mixed rubric content marker
    expect(text).toContain('Rubric — mixed')
  })
})
