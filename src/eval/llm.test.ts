import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  costFromUsage,
  createOpenRouterClient,
  OPENROUTER_PRICING,
} from './llm.js'
import type { OpenRouterUsage } from './types.js'

const fetchMock = vi.fn<typeof fetch>()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const okBody = (
  text: string,
  usage: OpenRouterUsage = { prompt_tokens: 10, completion_tokens: 5 },
): unknown => ({
  id: 'chatcmpl-1',
  choices: [
    {
      index: 0,
      message: { role: 'assistant', content: text },
      finish_reason: 'stop',
    },
  ],
  usage,
})

const okResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

const errResponse = (status: number, body = 'oops'): Response =>
  new Response(body, {
    status,
    headers: { 'content-type': 'text/plain' },
  })

describe('createOpenRouterClient — request shape + headers', () => {
  test('Authorization Bearer + Content-Type sent on POST to /chat/completions', async () => {
    fetchMock.mockResolvedValueOnce(okResponse(okBody('hi')))
    const client = createOpenRouterClient({ apiKey: 'sk-test' })
    await client({
      model: 'google/gemini-3.1-flash-lite',
      messages: [{ role: 'user', content: 'q' }],
    })
    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0] ?? []
    if (typeof url !== 'string') throw new Error('expected string url in fetch call')
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions')
    expect(init?.method).toBe('POST')
    const headers = init?.headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer sk-test')
    expect(headers['Content-Type']).toBe('application/json')
    expect(headers['HTTP-Referer']).toBeUndefined()
  })

  test('optional HTTP-Referer + X-Title headers passed when provided', async () => {
    fetchMock.mockResolvedValueOnce(okResponse(okBody('hi')))
    const client = createOpenRouterClient({
      apiKey: 'sk-test',
      httpReferer: 'https://example.com',
      appName: 'AHC',
    })
    await client({ model: 'google/gemini-3.1-flash-lite', messages: [] })
    const [, init] = fetchMock.mock.calls[0] ?? []
    const headers = init?.headers as Record<string, string>
    expect(headers['HTTP-Referer']).toBe('https://example.com')
    expect(headers['X-Title']).toBe('AHC')
  })

  test('temperature + max_tokens forwarded in body', async () => {
    fetchMock.mockResolvedValueOnce(okResponse(okBody('hi')))
    const client = createOpenRouterClient({ apiKey: 'sk-test' })
    await client({
      model: 'google/gemini-3.1-flash-lite',
      messages: [{ role: 'user', content: 'q' }],
      temperature: 0,
      max_tokens: 100,
    })
    const [, init] = fetchMock.mock.calls[0] ?? []
    const rawBody = init?.body
    if (typeof rawBody !== 'string') throw new Error('expected string body in fetch call')
    const body = JSON.parse(rawBody) as Record<string, unknown>
    expect(body['model']).toBe('google/gemini-3.1-flash-lite')
    expect(body['temperature']).toBe(0)
    expect(body['max_tokens']).toBe(100)
  })
})

describe('createOpenRouterClient — response parsing', () => {
  test('200 OK → parses text + usage + finish_reason; latency_ms set', async () => {
    fetchMock.mockResolvedValueOnce(
      okResponse(
        okBody('hello world', { prompt_tokens: 50, completion_tokens: 12 }),
      ),
    )
    const client = createOpenRouterClient({ apiKey: 'sk-test' })
    const resp = await client({
      model: 'google/gemini-3.1-flash-lite',
      messages: [{ role: 'user', content: 'q' }],
    })
    expect(resp.text).toBe('hello world')
    expect(resp.finish_reason).toBe('stop')
    expect(resp.error).toBeUndefined()
    expect(resp.raw_usage).toEqual({ prompt_tokens: 50, completion_tokens: 12 })
    expect(resp.latency_ms).toBeGreaterThanOrEqual(0)
  })

  test('429 → error.kind=rate_limit, text empty, no throw', async () => {
    fetchMock.mockResolvedValueOnce(errResponse(429, 'too many requests'))
    const client = createOpenRouterClient({ apiKey: 'sk-test' })
    const resp = await client({
      model: 'google/gemini-3.1-flash-lite',
      messages: [{ role: 'user', content: 'q' }],
    })
    expect(resp.error?.kind).toBe('rate_limit')
    expect(resp.error?.status).toBe(429)
    expect(resp.text).toBe('')
  })

  test('500 → error.kind=server_error', async () => {
    fetchMock.mockResolvedValueOnce(errResponse(503, 'unavailable'))
    const client = createOpenRouterClient({ apiKey: 'sk-test' })
    const resp = await client({
      model: 'google/gemini-3.1-flash-lite',
      messages: [{ role: 'user', content: 'q' }],
    })
    expect(resp.error?.kind).toBe('server_error')
  })

  test('401 → error.kind=auth', async () => {
    fetchMock.mockResolvedValueOnce(errResponse(401, 'invalid api key'))
    const client = createOpenRouterClient({ apiKey: 'sk-bad' })
    const resp = await client({
      model: 'google/gemini-3.1-flash-lite',
      messages: [{ role: 'user', content: 'q' }],
    })
    expect(resp.error?.kind).toBe('auth')
  })

  test('fetch throws → error.kind=network, no throw to caller', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'))
    const client = createOpenRouterClient({ apiKey: 'sk-test' })
    const resp = await client({
      model: 'google/gemini-3.1-flash-lite',
      messages: [{ role: 'user', content: 'q' }],
    })
    expect(resp.error?.kind).toBe('network')
    expect(resp.error?.message).toContain('ECONNREFUSED')
  })

  test('200 with malformed JSON → error.kind=parse', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('not json', { status: 200 }),
    )
    const client = createOpenRouterClient({ apiKey: 'sk-test' })
    const resp = await client({
      model: 'google/gemini-3.1-flash-lite',
      messages: [{ role: 'user', content: 'q' }],
    })
    expect(resp.error?.kind).toBe('parse')
  })
})

describe('costFromUsage', () => {
  test('Gemini-3.1-Flash usage produces non-zero cost matching pricing snapshot', () => {
    const pricing = OPENROUTER_PRICING['google/gemini-3.1-flash-lite']
    expect(pricing).toBeDefined()
    if (!pricing) return
    const usage: OpenRouterUsage = { prompt_tokens: 1000, completion_tokens: 500 }
    const cost = costFromUsage('google/gemini-3.1-flash-lite', usage)
    const expected =
      (1000 * pricing.input_per_million_usd + 500 * pricing.output_per_million_usd) /
      1_000_000
    expect(cost).toBeCloseTo(expected, 9)
  })

  test('unknown model → cost 0 (silent, not throw)', () => {
    const usage: OpenRouterUsage = { prompt_tokens: 100, completion_tokens: 50 }
    const cost = costFromUsage('unknown/model', usage)
    expect(cost).toBe(0)
  })
})
