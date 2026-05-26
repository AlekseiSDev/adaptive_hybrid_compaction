import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { webSearch } from './web-search.js'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function fetchUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return input.url
}

const ENV_KEYS = ['SEARXNG_URL', 'TAVILY_API_KEY', 'BRAVE_API_KEY', 'MOCK_WEB_SEARCH'] as const

describe('webSearch fallback chain', () => {
  const saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k]
      Reflect.deleteProperty(process.env, k)
    }
  })
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) Reflect.deleteProperty(process.env, k)
      else process.env[k] = saved[k]
    }
  })

  it('uses SearXNG when SEARXNG_URL set', async () => {
    process.env['SEARXNG_URL'] = 'http://searxng:8080'
    const fetchFn = vi.fn<typeof fetch>((input) => {
      const url = fetchUrl(input)
      expect(url).toContain('http://searxng:8080/search')
      expect(url).toContain('q=test')
      return Promise.resolve(jsonResponse({
        results: [
          { url: 'https://a', title: 'A', content: 'snippet A' },
          { url: 'https://b', title: 'B', content: 'snippet B' },
        ],
      }))
    })
    const r = await webSearch('test', { fetchFn })
    expect(r).toHaveLength(2)
    expect(r[0]).toEqual({ title: 'A', url: 'https://a', snippet: 'snippet A' })
  })

  it('falls back to Tavily when no SearXNG but TAVILY_API_KEY set', async () => {
    process.env['TAVILY_API_KEY'] = 'tvly-test'
    const fetchFn = vi.fn<typeof fetch>((input, init) => {
      expect(fetchUrl(input)).toBe('https://api.tavily.com/search')
      const headers = init?.headers as Record<string, string>
      expect(headers['Authorization']).toBe('Bearer tvly-test')
      return Promise.resolve(jsonResponse({
        results: [{ url: 'https://t', title: 'T', content: 'tavily snippet' }],
      }))
    })
    const r = await webSearch('q', { fetchFn })
    expect(r).toHaveLength(1)
    expect(r[0]?.snippet).toBe('tavily snippet')
  })

  it('falls back to Brave when only BRAVE_API_KEY set', async () => {
    process.env['BRAVE_API_KEY'] = 'brave-test'
    const fetchFn = vi.fn<typeof fetch>((input, init) => {
      expect(fetchUrl(input)).toContain('https://api.search.brave.com')
      const headers = init?.headers as Record<string, string>
      expect(headers['X-Subscription-Token']).toBe('brave-test')
      return Promise.resolve(jsonResponse({
        web: { results: [{ url: 'https://br', title: 'BR', description: 'brave desc' }] },
      }))
    })
    const r = await webSearch('q', { fetchFn })
    expect(r[0]).toEqual({ title: 'BR', url: 'https://br', snippet: 'brave desc' })
  })

  it('uses mock fallback when MOCK_WEB_SEARCH=true', async () => {
    process.env['MOCK_WEB_SEARCH'] = 'true'
    const fetchFn = vi.fn<typeof fetch>()
    const r = await webSearch('rabbits', { fetchFn })
    expect(r.length).toBeGreaterThan(0)
    expect(r[0]?.snippet).toContain('rabbits')
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('throws when no provider configured', async () => {
    await expect(webSearch('q', { fetchFn: vi.fn<typeof fetch>() })).rejects.toThrow(
      /no provider configured/,
    )
  })

  it('throws on non-OK provider response', async () => {
    process.env['TAVILY_API_KEY'] = 'tvly-test'
    const fetchFn = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response('rate-limited', { status: 429 })),
    )
    await expect(webSearch('q', { fetchFn })).rejects.toThrow(/Tavily 429/)
  })

  it('respects maxResults', async () => {
    process.env['SEARXNG_URL'] = 'http://sx'
    const fetchFn = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        jsonResponse({
          results: Array.from({ length: 10 }, (_, i) => ({
            url: `u${String(i)}`,
            title: `t${String(i)}`,
            content: `c${String(i)}`,
          })),
        }),
      ),
    )
    const r = await webSearch('q', { fetchFn, maxResults: 3 })
    expect(r).toHaveLength(3)
  })
})
