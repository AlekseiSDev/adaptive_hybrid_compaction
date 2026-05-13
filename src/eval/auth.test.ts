import { describe, expect, test } from 'vitest'
import { pingLiteLLM, pingOpenRouter } from './auth.js'

type FetchInput = string | URL | Request

function urlOf(input: FetchInput): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.toString()
  return input.url
}

type MockResponseSpec = {
  ok: boolean
  status?: number
  body?: unknown
  text?: string
  throwOn?: (url: string) => boolean
}

function makeMockResponse(spec: MockResponseSpec): Response {
  const partial = {
    ok: spec.ok,
    status: spec.status ?? (spec.ok ? 200 : 500),
    json: () => Promise.resolve(spec.body ?? {}),
    text: () => Promise.resolve(spec.text ?? ''),
  }
  return partial as unknown as Response
}

function mockFetch(spec: MockResponseSpec): typeof fetch {
  const impl: typeof fetch = (input) => {
    if (spec.throwOn?.(urlOf(input))) {
      return Promise.reject(new TypeError('network error (mock)'))
    }
    return Promise.resolve(makeMockResponse(spec))
  }
  return impl
}

describe('pingOpenRouter', () => {
  test('returns ok=true with detail when /auth/key returns 200 + data', async () => {
    const fetchImpl = mockFetch({
      ok: true,
      body: {
        data: { label: 'test-key', usage: 1.23, limit: 100 },
      },
    })
    const result = await pingOpenRouter('sk-fake', fetchImpl)
    expect(result.ok).toBe(true)
    expect(result.detail).toContain('test-key')
    expect(result.detail).toContain('1.23')
    expect(result.detail).toContain('100')
  })

  test('returns ok=true with "unlimited" when limit is null', async () => {
    const fetchImpl = mockFetch({
      ok: true,
      body: { data: { label: 'pay-as-go', usage: 5.0, limit: null } },
    })
    const result = await pingOpenRouter('sk-fake', fetchImpl)
    expect(result.ok).toBe(true)
    expect(result.detail).toContain('unlimited')
  })

  test('returns ok=false on 401 with error text snippet', async () => {
    const fetchImpl = mockFetch({
      ok: false,
      status: 401,
      text: 'invalid api key',
    })
    const result = await pingOpenRouter('sk-bad', fetchImpl)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('401')
    expect(result.error).toContain('invalid api key')
  })

  test('returns ok=false on 500', async () => {
    const fetchImpl = mockFetch({ ok: false, status: 500 })
    const result = await pingOpenRouter('sk-fake', fetchImpl)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('500')
  })

  test('returns ok=false on network failure', async () => {
    const fetchImpl = mockFetch({ ok: false, throwOn: () => true })
    const result = await pingOpenRouter('sk-fake', fetchImpl)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('network')
  })

  test('returns ok=false when body lacks data field', async () => {
    const fetchImpl = mockFetch({ ok: true, body: {} })
    const result = await pingOpenRouter('sk-fake', fetchImpl)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('no `data`')
  })
})

describe('pingLiteLLM', () => {
  test('returns ok=true when /health/liveliness responds 200', async () => {
    const fetchImpl = mockFetch({ ok: true })
    const result = await pingLiteLLM('http://localhost:4400', 'sk-master', fetchImpl)
    expect(result.ok).toBe(true)
    expect(result.detail).toContain('localhost:4400')
  })

  test('returns ok=false with auth error on 401', async () => {
    const fetchImpl = mockFetch({ ok: false, status: 401, text: 'invalid' })
    const result = await pingLiteLLM('http://localhost:4400', 'sk-bad', fetchImpl)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('401')
  })

  test('returns ok=false when all paths fail', async () => {
    // 404 on all candidate paths.
    const fetchImpl = mockFetch({ ok: false, status: 404 })
    const result = await pingLiteLLM('http://localhost:4400', 'sk-master', fetchImpl)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/none of.*responded/)
  })

  test('falls back to next path when first 404s but later succeeds', async () => {
    // Simulate /health/liveliness 404 → /health 200.
    let calls = 0
    const impl = (input: FetchInput): Promise<Response> => {
      calls += 1
      const path = urlOf(input)
      if (path.endsWith('/health/liveliness')) {
        return Promise.resolve(makeMockResponse({ ok: false, status: 404, text: 'not found' }))
      }
      if (path.endsWith('/health')) {
        return Promise.resolve(makeMockResponse({ ok: true }))
      }
      return Promise.reject(new Error('unreachable'))
    }
    const fImpl: typeof fetch = impl
    const result = await pingLiteLLM('http://localhost:4400', 'sk', fImpl)
    expect(result.ok).toBe(true)
    expect(calls).toBe(2)
  })

  test('strips trailing slashes from baseUrl before concatenating path', async () => {
    let lastUrl = ''
    const impl = (input: FetchInput): Promise<Response> => {
      lastUrl = urlOf(input)
      return Promise.resolve(makeMockResponse({ ok: true }))
    }
    const fImpl: typeof fetch = impl
    await pingLiteLLM('http://localhost:4400///', 'sk', fImpl)
    expect(lastUrl).toBe('http://localhost:4400/health/liveliness')
  })
})
