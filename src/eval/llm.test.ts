import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  ACTOR_MODEL_ENV_VAR,
  ANTHROPIC_DIRECT_PRICING,
  anthropicCostFromUsage,
  anthropicCostFromUsageWithCache,
  costFromUsage,
  costFromUsageWithCache,
  createAnthropicClient,
  createOpenRouterClient,
  GOOGLE_DIRECT_PRICING,
  OPENROUTER_PRICING,
  resolveActorModel,
  resolveLLMClient,
} from './llm.js'
import type { AnthropicUsage, OpenRouterUsage } from './types.js'

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
      model: 'google/gemini-3-flash-preview',
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
    await client({ model: 'google/gemini-3-flash-preview', messages: [] })
    const [, init] = fetchMock.mock.calls[0] ?? []
    const headers = init?.headers as Record<string, string>
    expect(headers['HTTP-Referer']).toBe('https://example.com')
    expect(headers['X-Title']).toBe('AHC')
  })

  test('temperature + max_tokens forwarded in body', async () => {
    fetchMock.mockResolvedValueOnce(okResponse(okBody('hi')))
    const client = createOpenRouterClient({ apiKey: 'sk-test' })
    await client({
      model: 'google/gemini-3-flash-preview',
      messages: [{ role: 'user', content: 'q' }],
      temperature: 0,
      max_tokens: 100,
    })
    const [, init] = fetchMock.mock.calls[0] ?? []
    const rawBody = init?.body
    if (typeof rawBody !== 'string') throw new Error('expected string body in fetch call')
    const body = JSON.parse(rawBody) as Record<string, unknown>
    expect(body['model']).toBe('google/gemini-3-flash-preview')
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
      model: 'google/gemini-3-flash-preview',
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
      model: 'google/gemini-3-flash-preview',
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
      model: 'google/gemini-3-flash-preview',
      messages: [{ role: 'user', content: 'q' }],
    })
    expect(resp.error?.kind).toBe('server_error')
  })

  test('401 → error.kind=auth', async () => {
    fetchMock.mockResolvedValueOnce(errResponse(401, 'invalid api key'))
    const client = createOpenRouterClient({ apiKey: 'sk-bad' })
    const resp = await client({
      model: 'google/gemini-3-flash-preview',
      messages: [{ role: 'user', content: 'q' }],
    })
    expect(resp.error?.kind).toBe('auth')
  })

  test('fetch throws → error.kind=network, no throw to caller', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'))
    const client = createOpenRouterClient({ apiKey: 'sk-test' })
    const resp = await client({
      model: 'google/gemini-3-flash-preview',
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
      model: 'google/gemini-3-flash-preview',
      messages: [{ role: 'user', content: 'q' }],
    })
    expect(resp.error?.kind).toBe('parse')
  })
})

describe('costFromUsage', () => {
  test('Gemini-3.1-Flash usage produces non-zero cost matching pricing snapshot', () => {
    const pricing = OPENROUTER_PRICING['google/gemini-3-flash-preview']
    expect(pricing).toBeDefined()
    if (!pricing) return
    const usage: OpenRouterUsage = { prompt_tokens: 1000, completion_tokens: 500 }
    const cost = costFromUsage('google/gemini-3-flash-preview', usage)
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

describe('ANTHROPIC_DIRECT_PRICING + anthropicCostFromUsage', () => {
  test('claude-sonnet-4-6 has $3/$15 per million pricing (dash-form id, not dot)', () => {
    const pricing = ANTHROPIC_DIRECT_PRICING['claude-sonnet-4-6']
    expect(pricing).toBeDefined()
    expect(pricing).toEqual({
      input_per_million_usd: 3.0,
      output_per_million_usd: 15.0,
      cache_read_factor: 0.1,
      cache_write_factor: 1.25,
    })
  })

  test('anthropicCostFromUsage uses input + output tokens; ignores cache fields', () => {
    const usage: AnthropicUsage = {
      input_tokens: 1000,
      output_tokens: 500,
      cache_read_input_tokens: 800,
      cache_creation_input_tokens: 200,
    }
    const cost = anthropicCostFromUsage('claude-sonnet-4-6', usage)
    // Cache rates intentionally not modeled in pricing — F report uses cache_read
    // ratio as the metric, not a per-token cost line. So cost = 1000*$3/M + 500*$15/M.
    expect(cost).toBeCloseTo((1000 * 3 + 500 * 15) / 1_000_000, 9)
  })

  test('anthropicCostFromUsage unknown model → 0 silent', () => {
    const usage: AnthropicUsage = { input_tokens: 100, output_tokens: 50 }
    expect(anthropicCostFromUsage('claude-future-99', usage)).toBe(0)
  })

  test('claude-sonnet-4.6 dot-form alias matches dash-form pricing (E1 LiteLLM path)', () => {
    // LiteLLM forwarder uses dot-form aliases; ahc_core resolvePricing()
    // looks up by exact model id, so both forms must resolve to identical
    // numbers to avoid cost-tracking drift between auth paths.
    const dotted = ANTHROPIC_DIRECT_PRICING['claude-sonnet-4.6']
    const dashed = ANTHROPIC_DIRECT_PRICING['claude-sonnet-4-6']
    expect(dotted).toEqual(dashed)
  })
})

describe('costFromUsageWithCache — OpenRouter shape', () => {
  test('gpt-5.4-mini: cached_tokens discounted by cache_read_factor (0.5)', () => {
    // 10000 total input, 2000 cached → uncached 8000, output 500.
    // 8000 * $0.75/M + 2000 * $0.75/M * 0.5 + 500 * $4.50/M
    //   = 0.006 + 0.00075 + 0.00225 = 0.009
    const usage: OpenRouterUsage = {
      prompt_tokens: 10_000,
      completion_tokens: 500,
      prompt_tokens_details: { cached_tokens: 2_000 },
    }
    const cost = costFromUsageWithCache('openai/gpt-5.4-mini', usage)
    expect(cost).toBeCloseTo((8000 * 0.75 + 2000 * 0.75 * 0.5 + 500 * 4.5) / 1e6, 9)
  })

  test('no cached_tokens → identical to costFromUsage', () => {
    const usage: OpenRouterUsage = { prompt_tokens: 1000, completion_tokens: 500 }
    expect(costFromUsageWithCache('openai/gpt-5.4-mini', usage)).toBeCloseTo(
      costFromUsage('openai/gpt-5.4-mini', usage),
      9,
    )
  })

  test('model without cache_read_factor → discount no-op (factor defaults 1.0)', () => {
    // gemini-3-flash-preview has no cache factor in pricing table.
    const usage: OpenRouterUsage = {
      prompt_tokens: 1000,
      completion_tokens: 200,
      prompt_tokens_details: { cached_tokens: 400 },
    }
    expect(costFromUsageWithCache('google/gemini-3-flash-preview', usage)).toBeCloseTo(
      costFromUsage('google/gemini-3-flash-preview', usage),
      9,
    )
  })

  test('unknown model → 0 silent (mirrors costFromUsage contract)', () => {
    const usage: OpenRouterUsage = { prompt_tokens: 100, completion_tokens: 50 }
    expect(costFromUsageWithCache('unknown/model', usage)).toBe(0)
  })
})

describe('anthropicCostFromUsageWithCache — Anthropic semantics', () => {
  test('claude-sonnet-4-6: input_tokens is non-cached; cache_read at 10%, cache_creation at 125%', () => {
    // Anthropic: input_tokens excludes cached. So billed-input is
    //   input_tokens + cache_read * 0.1 + cache_creation * 1.25 (all × input price).
    // 800 + 600 * 0.1 + 400 * 1.25 = 800 + 60 + 500 = 1360 effective input tokens.
    // 1360 * $3/M + 200 * $15/M = 0.00408 + 0.003 = 0.00708
    const usage: AnthropicUsage = {
      input_tokens: 800,
      output_tokens: 200,
      cache_read_input_tokens: 600,
      cache_creation_input_tokens: 400,
    }
    const cost = anthropicCostFromUsageWithCache('claude-sonnet-4-6', usage)
    const expected = ((800 + 600 * 0.1 + 400 * 1.25) * 3 + 200 * 15) / 1e6
    expect(cost).toBeCloseTo(expected, 9)
  })

  test('cache fields absent → matches anthropicCostFromUsage (cache-naive)', () => {
    const usage: AnthropicUsage = { input_tokens: 1000, output_tokens: 500 }
    expect(anthropicCostFromUsageWithCache('claude-sonnet-4-6', usage)).toBeCloseTo(
      anthropicCostFromUsage('claude-sonnet-4-6', usage),
      9,
    )
  })

  test('unknown model → 0', () => {
    const usage: AnthropicUsage = {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 20,
    }
    expect(anthropicCostFromUsageWithCache('claude-future-99', usage)).toBe(0)
  })
})

describe('GOOGLE_DIRECT_PRICING — H3.1 (Track H P4) shape', () => {
  test('gemini-3-flash-preview entry has cache_read_factor 0.25 (25% of input)', () => {
    const entry = GOOGLE_DIRECT_PRICING['gemini-3-flash-preview']
    expect(entry).toBeDefined()
    expect(entry?.cache_read_factor).toBe(0.25)
    expect(entry?.input_per_million_usd).toBeGreaterThan(0)
    expect(entry?.output_per_million_usd).toBeGreaterThan(0)
  })

  test('gemini-2.5-flash entry exists for fallback / cross-version compare', () => {
    expect(GOOGLE_DIRECT_PRICING['gemini-2.5-flash']).toBeDefined()
  })
})

describe('resolveActorModel — H1 env-override hardening', () => {
  beforeEach(() => {
    vi.stubEnv(ACTOR_MODEL_ENV_VAR, '')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  test('no env → returns default', () => {
    expect(resolveActorModel('openai/gpt-5.4-mini')).toBe('openai/gpt-5.4-mini')
  })

  test('AHC_ACTOR_MODEL set → returns env value', () => {
    vi.stubEnv(ACTOR_MODEL_ENV_VAR, 'google/gemini-3-flash-preview')
    expect(resolveActorModel('openai/gpt-5.4-mini')).toBe('google/gemini-3-flash-preview')
  })

  test('AHC_ACTOR_MODEL empty string → returns default (treats as unset)', () => {
    vi.stubEnv(ACTOR_MODEL_ENV_VAR, '')
    expect(resolveActorModel('openai/gpt-5.4-mini')).toBe('openai/gpt-5.4-mini')
  })

  test('AHC_ACTOR_MODEL identical to default → returns same string', () => {
    vi.stubEnv(ACTOR_MODEL_ENV_VAR, 'openai/gpt-5.4-mini')
    expect(resolveActorModel('openai/gpt-5.4-mini')).toBe('openai/gpt-5.4-mini')
  })
})

describe('resolveLLMClient — dual-mode routing via model prefix (2026-05-27)', () => {
  beforeEach(() => {
    vi.unstubAllEnvs()
    vi.stubEnv('LITELLM_MASTER_KEY', 'sk-litellm')
    vi.stubEnv('LITELLM_BASE_URL', 'http://localhost:4400/v1')
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-or-test')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  test('`openrouter/` prefix → OpenRouter route, strips prefix for request', () => {
    const r = resolveLLMClient('openrouter/openai/gpt-5.4-mini')
    expect(r).toEqual({
      apiKey: 'sk-or-test',
      baseURL: 'https://openrouter.ai/api/v1',
      modelForRequest: 'openai/gpt-5.4-mini',
      provider: 'openrouter',
    })
  })

  test('`openai/` (default) → LiteLLM route, strips provider prefix to bare alias', () => {
    const r = resolveLLMClient('openai/gpt-5.4-mini')
    expect(r).toEqual({
      apiKey: 'sk-litellm',
      baseURL: 'http://localhost:4400/v1',
      modelForRequest: 'gpt-5.4-mini',
      provider: 'litellm',
    })
  })

  test('`google/` non-Gemini prefix → LiteLLM with stripped alias', () => {
    // Gemini models force OpenRouter (separate test below); pick a hypothetical
    // non-Gemini google/* to exercise the plain LiteLLM strip path.
    const r = resolveLLMClient('google/non-gemini-model')
    expect(r.provider).toBe('litellm')
    expect(r.modelForRequest).toBe('non-gemini-model')
  })

  test('`anthropic/` prefix → LiteLLM with stripped alias', () => {
    const r = resolveLLMClient('anthropic/claude-sonnet-4.6')
    expect(r.provider).toBe('litellm')
    expect(r.modelForRequest).toBe('claude-sonnet-4.6')
  })

  test('bare alias (no prefix) → LiteLLM with same id', () => {
    const r = resolveLLMClient('gpt-5.4-mini')
    expect(r.provider).toBe('litellm')
    expect(r.modelForRequest).toBe('gpt-5.4-mini')
  })

  test('`google/gemini-...` auto-routes to OpenRouter (LiteLLM Gemini tool-use breakage workaround)', () => {
    const r = resolveLLMClient('google/gemini-3-flash-preview')
    expect(r.provider).toBe('openrouter')
    expect(r.modelForRequest).toBe('google/gemini-3-flash-preview')
    expect(r.baseURL).toBe('https://openrouter.ai/api/v1')
  })

  test('`openrouter/google/gemini-...` honors explicit prefix (no double-prefix)', () => {
    const r = resolveLLMClient('openrouter/google/gemini-3-flash-preview')
    expect(r.provider).toBe('openrouter')
    expect(r.modelForRequest).toBe('google/gemini-3-flash-preview')
  })

  test('non-Gemini `google/...` (hypothetical) does NOT auto-route to OpenRouter', () => {
    const r = resolveLLMClient('google/some-other-model')
    expect(r.provider).toBe('litellm')
    expect(r.modelForRequest).toBe('some-other-model')
  })

  test('openrouter/ prefix without OPENROUTER_API_KEY → throws', () => {
    vi.stubEnv('OPENROUTER_API_KEY', '')
    expect(() => resolveLLMClient('openrouter/openai/gpt-5.4-mini')).toThrow(
      /OPENROUTER_API_KEY/,
    )
  })

  test('LiteLLM route without LITELLM_MASTER_KEY → throws', () => {
    vi.stubEnv('LITELLM_MASTER_KEY', '')
    expect(() => resolveLLMClient('openai/gpt-5.4-mini')).toThrow(/LITELLM_MASTER_KEY/)
  })

  test('LiteLLM route without LITELLM_BASE_URL → throws', () => {
    vi.stubEnv('LITELLM_BASE_URL', '')
    expect(() => resolveLLMClient('openai/gpt-5.4-mini')).toThrow(/LITELLM_BASE_URL/)
  })
})

describe('OPENROUTER_PRICING — LiteLLM alias entries (2026-05-27)', () => {
  test('gpt-5.4-mini alias has same prices as openai/gpt-5.4-mini', () => {
    const alias = OPENROUTER_PRICING['gpt-5.4-mini']
    const prefixed = OPENROUTER_PRICING['openai/gpt-5.4-mini']
    expect(alias).toBeDefined()
    expect(prefixed).toBeDefined()
    expect(alias?.input_per_million_usd).toBe(prefixed?.input_per_million_usd)
    expect(alias?.output_per_million_usd).toBe(prefixed?.output_per_million_usd)
    expect(alias?.cache_read_factor).toBe(prefixed?.cache_read_factor)
  })

  test('gemini-3.1-flash-lite-preview alias matches prefixed sibling', () => {
    const alias = OPENROUTER_PRICING['gemini-3.1-flash-lite-preview']
    const prefixed = OPENROUTER_PRICING['google/gemini-3.1-flash-lite-preview']
    expect(alias?.input_per_million_usd).toBe(prefixed?.input_per_million_usd)
    expect(alias?.output_per_million_usd).toBe(prefixed?.output_per_million_usd)
  })

  test('claude-sonnet-4.6 alias has anthropic cache factors', () => {
    const p = OPENROUTER_PRICING['claude-sonnet-4.6']
    expect(p?.input_per_million_usd).toBe(3.0)
    expect(p?.cache_read_factor).toBe(0.1)
    expect(p?.cache_write_factor).toBe(1.25)
  })

  test('costFromUsage with LiteLLM-style key matches OpenRouter-style key', () => {
    const usage = { prompt_tokens: 1000, completion_tokens: 200 }
    expect(costFromUsage('gpt-5.4-mini', usage)).toBe(
      costFromUsage('openai/gpt-5.4-mini', usage),
    )
  })
})

describe('createAnthropicClient — shape sanity', () => {
  test('returns a function (LLMClient shape)', () => {
    const client = createAnthropicClient({ apiKey: 'sk-fake' })
    expect(typeof client).toBe('function')
  })

  test('honours baseURL override (smoke — constructor accepts it)', () => {
    const client = createAnthropicClient({
      apiKey: 'sk-fake',
      baseURL: 'https://proxy.example.com',
    })
    expect(typeof client).toBe('function')
  })
})
