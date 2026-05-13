import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { LLMClient, LLMRequest, LLMResponse } from '../types.js'
import {
  judgeCacheKey,
  loadCache,
  parseThreeLevelJson,
  parseYesNo,
  runJudgeRequest,
  saveCache,
  type JudgeCache,
} from './_judge-core.js'

function tmpCachePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ahc-judge-core-'))
  return join(dir, 'judge_cache.json')
}

function fakeLLMResponse(text: string, tokens = 100): LLMResponse {
  return {
    text,
    raw_usage: { prompt_tokens: tokens, completion_tokens: tokens },
    finish_reason: 'stop',
    latency_ms: 10,
  }
}

function fakeRequest(model = 'anthropic/claude-sonnet-4.6'): LLMRequest {
  return {
    model,
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'q' },
    ],
    temperature: 0,
  }
}

function llmClientReturning(text: string): LLMClient {
  return vi.fn().mockResolvedValue(fakeLLMResponse(text))
}

describe('parseThreeLevelJson', () => {
  it('parses 0 / 0.5 / 1.0 scores', () => {
    expect(parseThreeLevelJson('{"score": 1.0, "justification": "good"}')).toEqual({
      score: 1.0,
      justification: 'good',
    })
    expect(parseThreeLevelJson('{"score": 0.5, "justification": "ok"}')).toEqual({
      score: 0.5,
      justification: 'ok',
    })
    expect(parseThreeLevelJson('{"score": 0.0, "justification": "fail"}')).toEqual({
      score: 0,
      justification: 'fail',
    })
  })

  it('extracts JSON wrapped in prose', () => {
    expect(
      parseThreeLevelJson('Sure! {"score": 0.5, "justification": "ok"} cheers'),
    ).toEqual({ score: 0.5, justification: 'ok' })
  })

  it('rejects out-of-range / non-numeric scores', () => {
    expect(parseThreeLevelJson('{"score": 0.7, "justification": "x"}')).toBeNull()
    expect(parseThreeLevelJson('{"score": "high"}')).toBeNull()
  })

  it('returns null on malformed JSON', () => {
    expect(parseThreeLevelJson('no json')).toBeNull()
    expect(parseThreeLevelJson('{not json}')).toBeNull()
  })

  it('tolerates missing justification', () => {
    expect(parseThreeLevelJson('{"score": 0.0}')).toEqual({ score: 0, justification: '' })
  })
})

describe('parseYesNo', () => {
  it('maps yes/no first-word to 1.0/0.0', () => {
    expect(parseYesNo('yes')?.score).toBe(1.0)
    expect(parseYesNo('Yes, the response is correct.')?.score).toBe(1.0)
    expect(parseYesNo('no')?.score).toBe(0.0)
    expect(parseYesNo('No.')?.score).toBe(0.0)
  })

  it('case-insensitive + whitespace-tolerant', () => {
    expect(parseYesNo('  YES  ')?.score).toBe(1.0)
    expect(parseYesNo('\n\nno  ')?.score).toBe(0.0)
  })

  it('preserves response as justification (trimmed)', () => {
    expect(parseYesNo('Yes, perfectly correct')?.justification).toBe('Yes, perfectly correct')
  })

  it('returns null on ambiguous / non-yes-no responses', () => {
    expect(parseYesNo('maybe')).toBeNull()
    expect(parseYesNo('')).toBeNull()
    expect(parseYesNo('I think the answer is incorrect')).toBeNull()
  })
})

describe('judgeCacheKey', () => {
  it('produces stable sha256 hex string', () => {
    const req = fakeRequest()
    const k1 = judgeCacheKey('prefix-001', req)
    const k2 = judgeCacheKey('prefix-001', req)
    expect(k1).toBe(k2)
    expect(k1).toMatch(/^[a-f0-9]{64}$/)
  })

  it('changes when prefix changes', () => {
    const req = fakeRequest()
    expect(judgeCacheKey('a', req)).not.toBe(judgeCacheKey('b', req))
  })

  it('changes when request changes', () => {
    expect(
      judgeCacheKey('p', fakeRequest('model-a')),
    ).not.toBe(judgeCacheKey('p', fakeRequest('model-b')))
  })

  it('is order-independent for object keys (canonical JSON)', () => {
    // Same logical request, different key order — must produce same key.
    const reqA: LLMRequest = {
      model: 'm',
      temperature: 0,
      messages: [{ role: 'user', content: 'q' }],
    }
    const reqB: LLMRequest = {
      messages: [{ role: 'user', content: 'q' }],
      temperature: 0,
      model: 'm',
    }
    expect(judgeCacheKey('p', reqA)).toBe(judgeCacheKey('p', reqB))
  })
})

describe('loadCache / saveCache', () => {
  it('round-trips an entry', async () => {
    const path = tmpCachePath()
    try {
      const cache: JudgeCache = {
        abc123: {
          score: 0.5,
          justification: 'ok',
          cost_usd: 0.001,
          model: 'anthropic/claude-sonnet-4.6',
          ts: '2026-05-13T00:00:00.000Z',
        },
      }
      await saveCache(path, cache)
      const loaded = await loadCache(path)
      expect(loaded).toEqual(cache)
    } finally {
      rmSync(path, { force: true })
    }
  })

  it('returns {} when file missing', async () => {
    const path = tmpCachePath()
    expect(await loadCache(path)).toEqual({})
  })

  it('recovers from corrupt JSON (returns {})', async () => {
    const path = tmpCachePath()
    writeFileSync(path, 'not json at all', 'utf8')
    try {
      const result = await loadCache(path)
      expect(result).toEqual({})
    } finally {
      rmSync(path, { force: true })
    }
  })

  it('returns {} when JSON root is array (not object)', async () => {
    const path = tmpCachePath()
    writeFileSync(path, '[1,2,3]', 'utf8')
    try {
      expect(await loadCache(path)).toEqual({})
    } finally {
      rmSync(path, { force: true })
    }
  })
})

describe('runJudgeRequest — cache + parse + cost paths', () => {
  it('cache miss → calls LLM, parses, writes entry, returns score', async () => {
    const cache: JudgeCache = {}
    const client = llmClientReturning('{"score": 1.0, "justification": "yes"}')
    const r = await runJudgeRequest('task-001', fakeRequest(), {
      llmClient: client,
      cachePath: '/dev/null',
      cache,
      persist: false,
      parseFn: parseThreeLevelJson,
    })
    expect(r.score).toBe(1.0)
    expect(r.justification).toBe('yes')
    expect(Object.keys(cache).length).toBe(1)
    expect(client).toHaveBeenCalledTimes(1)
  })

  it('cache hit short-circuits LLM call; cost_usd=0', async () => {
    const cache: JudgeCache = {}
    const client1 = llmClientReturning('{"score": 1.0, "justification": "yes"}')
    const req = fakeRequest()
    await runJudgeRequest('task-001', req, {
      llmClient: client1,
      cachePath: '/dev/null',
      cache,
      persist: false,
      parseFn: parseThreeLevelJson,
    })

    const client2 = vi.fn() as unknown as LLMClient
    const r = await runJudgeRequest('task-001', req, {
      llmClient: client2,
      cachePath: '/dev/null',
      cache,
      persist: false,
      parseFn: parseThreeLevelJson,
    })
    expect(r.score).toBe(1.0)
    expect(r.cost_usd).toBe(0)
    expect(client2).not.toHaveBeenCalled()
  })

  it('parse failure → score=0, no cache write', async () => {
    const cache: JudgeCache = {}
    const r = await runJudgeRequest('task-001', fakeRequest(), {
      llmClient: llmClientReturning('not json at all'),
      cachePath: '/dev/null',
      cache,
      persist: false,
      parseFn: parseThreeLevelJson,
    })
    expect(r.score).toBe(0)
    expect(r.justification).toMatch(/parse failed/i)
    expect(r.cost_usd).toBe(0)
    expect(Object.keys(cache).length).toBe(0)
  })

  it('LLM error → score=0 + error description, no cache write', async () => {
    const cache: JudgeCache = {}
    const errClient: LLMClient = () =>
      Promise.resolve({
        text: '',
        raw_usage: null,
        finish_reason: 'error',
        latency_ms: 1,
        error: { kind: 'auth', message: 'bad key' },
      })
    const r = await runJudgeRequest('task-001', fakeRequest(), {
      llmClient: errClient,
      cachePath: '/dev/null',
      cache,
      persist: false,
      parseFn: parseThreeLevelJson,
    })
    expect(r.score).toBe(0)
    expect(r.justification).toContain('auth')
    expect(r.justification).toContain('bad key')
    expect(Object.keys(cache).length).toBe(0)
  })

  it('cost computed from raw_usage + OPENROUTER_PRICING by request.model', async () => {
    // sonnet-4.6: $3/M input + $15/M output; 100 + 100 tokens = 0.0018
    const r = await runJudgeRequest('task-001', fakeRequest('anthropic/claude-sonnet-4.6'), {
      llmClient: llmClientReturning('{"score": 0.5, "justification": "ok"}'),
      cachePath: '/dev/null',
      cache: {},
      persist: false,
      parseFn: parseThreeLevelJson,
    })
    expect(r.cost_usd).toBeCloseTo(0.0018, 6)
  })

  it('parseFn pluggable: parseYesNo maps yes/no to 1/0', async () => {
    const cache: JudgeCache = {}
    const rYes = await runJudgeRequest('q-001', fakeRequest(), {
      llmClient: llmClientReturning('yes'),
      cachePath: '/dev/null',
      cache,
      persist: false,
      parseFn: parseYesNo,
    })
    expect(rYes.score).toBe(1.0)

    const rNo = await runJudgeRequest('q-002', fakeRequest(), {
      llmClient: llmClientReturning('no'),
      cachePath: '/dev/null',
      cache,
      persist: false,
      parseFn: parseYesNo,
    })
    expect(rNo.score).toBe(0.0)
  })

  it('persists to disk when persist=true', async () => {
    const path = tmpCachePath()
    try {
      await runJudgeRequest('task-001', fakeRequest(), {
        llmClient: llmClientReturning('{"score": 1.0, "justification": "yes"}'),
        cachePath: path,
        persist: true,
        parseFn: parseThreeLevelJson,
      })
      const loaded = await loadCache(path)
      expect(Object.keys(loaded).length).toBe(1)
    } finally {
      rmSync(path, { force: true })
    }
  })

  it('loads cache from disk when cache option not provided', async () => {
    const path = tmpCachePath()
    try {
      const req = fakeRequest()
      const key = judgeCacheKey('task-001', req)
      const seed: JudgeCache = {
        [key]: {
          score: 0.5,
          justification: 'preseeded',
          cost_usd: 0.005,
          model: 'anthropic/claude-sonnet-4.6',
          ts: '2026-05-13T00:00:00.000Z',
        },
      }
      await saveCache(path, seed)

      const client = vi.fn() as unknown as LLMClient
      const r = await runJudgeRequest('task-001', req, {
        llmClient: client,
        cachePath: path,
        persist: false,
        parseFn: parseThreeLevelJson,
      })
      expect(r.score).toBe(0.5)
      expect(r.justification).toBe('preseeded')
      expect(client).not.toHaveBeenCalled()
    } finally {
      rmSync(path, { force: true })
    }
  })
})
