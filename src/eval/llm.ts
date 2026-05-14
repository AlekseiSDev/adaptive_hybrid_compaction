import Anthropic from '@anthropic-ai/sdk'
import type {
  AnthropicUsage,
  LLMClient,
  LLMRequest,
  LLMResponse,
  LLMResponseError,
  OpenRouterUsage,
} from './types.js'

// OpenRouter pricing snapshot — manual maintenance, fresh per commit.
// Cost calc: (prompt_tokens × input + completion_tokens × output) / 1e6.
// Verified против OpenRouter /models 2026-05-13 (B4). Refresh перед main sweep (E1).
//
// `cache_read_factor` / `cache_write_factor` — multipliers applied to
// `input_per_million_usd` for tokens served from the provider's prompt cache
// (`cache_read_factor`) or newly added to it (`cache_write_factor`). Both
// default to 1.0 (no discount, no premium) when undefined, so callers can opt
// into cache-aware costing per-model without touching others. Used by
// `costFromUsageWithCache` / `anthropicCostFromUsageWithCache` to back-fill
// actor cost for baselines that have token counts but no SDK-side $ field
// (mastra_om, anthropic_compact).
export type ModelPricing = {
  input_per_million_usd: number
  output_per_million_usd: number
  cache_read_factor?: number
  cache_write_factor?: number
}

export const OPENROUTER_PRICING: Record<string, ModelPricing> = Object.freeze({
  'google/gemini-3-flash-preview': {
    input_per_million_usd: 0.5,
    output_per_million_usd: 3.0,
  },
  // E1: cheaper actor fallback (2× cheaper than flash-preview). Used when
  // cross-phase budget tracker detects OpenRouter overspend mid-pipeline —
  // swap actor model for remaining sweeps via AHC_ACTOR_MODEL env var.
  // Pricing verified live 2026-05-13 vs OpenRouter /api/v1/models.
  'google/gemini-3.1-flash-lite-preview': {
    input_per_million_usd: 0.25,
    output_per_million_usd: 1.5,
  },
  // Primary actor (per decisions.md 2026-05-13 pivot). OpenAI prompt cache
  // fires automatically on OpenRouter on ≥1024-token stable prefix — no
  // cache_control plumbing required. Probe verified ~80% cached_tokens
  // ratio on 3rd identical-prefix call. Pricing live 2026-05-13 OpenRouter.
  // Cached input billed at 50% of full rate (OpenAI standard).
  'openai/gpt-5.4-mini': {
    input_per_million_usd: 0.75,
    output_per_million_usd: 4.5,
    cache_read_factor: 0.5,
  },
  // D4 judge model. Sonnet 4-7 not yet on OpenRouter (2026-05-13 verified via
  // /api/v1/models); fallback to 4.6 per plan. Note: OpenRouter uses dot
  // notation (4.6), Anthropic SDK uses dash (4-6). Pricing verified live.
  // Anthropic prompt cache rates: read at 10% of input, write at 125%.
  'anthropic/claude-sonnet-4.6': {
    input_per_million_usd: 3.0,
    output_per_million_usd: 15.0,
    cache_read_factor: 0.1,
    cache_write_factor: 1.25,
  },
})

// Anthropic direct-API pricing snapshot — separate table from OpenRouter
// proxy pricing because direct API uses dash-form model ids
// (claude-sonnet-4-6, not 4.6). E3 cache-hit subset routes through
// Anthropic-direct; main sweeps stay on OpenRouter. Cache discount /
// premium applied by `anthropicCostFromUsageWithCache` when cache token
// fields are populated on the response.
// Google AI Studio direct-API pricing snapshot. Track H P4 (2026-05-14) —
// E3-style cache verification on Gemini requires direct route (OpenRouter
// strips usageMetadata.cachedContentTokenCount per investigation
// 2026-05-13 round 2). Rates verified live at ai.google.dev/pricing
// 2026-05-14 — refresh per sweep. Cached prompt billed at 25% of input.
export const GOOGLE_DIRECT_PRICING: Record<string, ModelPricing> = Object.freeze({
  'gemini-3-flash-preview': {
    input_per_million_usd: 0.30,
    output_per_million_usd: 2.50,
    cache_read_factor: 0.25,
  },
  // 2.5-flash variant for fallback / cross-version sanity comparison.
  'gemini-2.5-flash': {
    input_per_million_usd: 0.30,
    output_per_million_usd: 2.50,
    cache_read_factor: 0.25,
  },
})

export const ANTHROPIC_DIRECT_PRICING: Record<string, ModelPricing> = Object.freeze({
  'claude-sonnet-4-6': {
    input_per_million_usd: 3.0,
    output_per_million_usd: 15.0,
    cache_read_factor: 0.1,
    cache_write_factor: 1.25,
  },
  // LiteLLM proxy uses dot-form model aliases (claude-sonnet-4.6 rewrites
  // upstream to anthropic/claude-sonnet-4-6). Same pricing — keep both keys
  // in sync when refreshing. See LITELLM_MODEL in src/eval/runner.ts.
  'claude-sonnet-4.6': {
    input_per_million_usd: 3.0,
    output_per_million_usd: 15.0,
    cache_read_factor: 0.1,
    cache_write_factor: 1.25,
  },
})

export function costFromUsage(model: string, usage: OpenRouterUsage): number {
  const pricing = OPENROUTER_PRICING[model]
  if (!pricing) return 0
  return (
    (usage.prompt_tokens * pricing.input_per_million_usd +
      usage.completion_tokens * pricing.output_per_million_usd) /
    1_000_000
  )
}

// OpenRouter / OpenAI semantics: `prompt_tokens` is TOTAL input (cached subset
// included). `prompt_tokens_details.cached_tokens` reports the subset served
// from prompt cache. Cached tokens are billed at
// `pricing.cache_read_factor × input_per_million_usd` (defaults to 1.0 when
// pricing entry omits the factor — i.e. cache-naive, identical to costFromUsage).
// AHC_ACTOR_MODEL env override — shared helper for all default-model
// constants (ahc_core, full_context, mastra_om, tau-bench actor). Track H H1
// (2026-05-14): pre-H1, full_context + mastra_om hardcoded `gpt-5.4-mini`,
// so `AHC_ACTOR_MODEL=google/gemini-3-flash-preview` produced an asymmetric
// sweep (AHC + tau switched to Gemini, FC + mastra_om stayed on gpt) — false
// cross-model comparison. Helper closes that gap so a single env-set affects
// all four call sites consistently.
//
// Per-config `ahc_flags.model` in sweep YAML still takes precedence (consumer
// applies it as `deps.model ?? resolveActorModel(default)`).
export const ACTOR_MODEL_ENV_VAR = 'AHC_ACTOR_MODEL'
export function resolveActorModel(defaultModelId: string): string {
  const v = process.env[ACTOR_MODEL_ENV_VAR]
  return v !== undefined && v.length > 0 ? v : defaultModelId
}

export function costFromUsageWithCache(model: string, usage: OpenRouterUsage): number {
  const pricing = OPENROUTER_PRICING[model]
  if (!pricing) return 0
  const cached = usage.prompt_tokens_details?.cached_tokens ?? 0
  const uncached = Math.max(0, usage.prompt_tokens - cached)
  const readFactor = pricing.cache_read_factor ?? 1
  return (
    (uncached * pricing.input_per_million_usd +
      cached * pricing.input_per_million_usd * readFactor +
      usage.completion_tokens * pricing.output_per_million_usd) /
    1_000_000
  )
}

export type OpenRouterClientOptions = {
  apiKey: string
  baseUrl?: string
  httpReferer?: string
  appName?: string
}

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1'

function classifyHttpError(status: number): LLMResponseError['kind'] {
  if (status === 401 || status === 403) return 'auth'
  if (status === 429) return 'rate_limit'
  if (status >= 500) return 'server_error'
  return 'unknown'
}

type ChatChoice = {
  message?: { content?: unknown }
  finish_reason?: unknown
}

type ChatBody = {
  choices?: ChatChoice[]
  usage?: OpenRouterUsage
}

function parseChatBody(raw: unknown): ChatBody {
  if (!raw || typeof raw !== 'object') return {}
  return raw
}

export function createOpenRouterClient(opts: OpenRouterClientOptions): LLMClient {
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL
  return async (req: LLMRequest): Promise<LLMResponse> => {
    const start = Date.now()
    const headers: Record<string, string> = {
      Authorization: `Bearer ${opts.apiKey}`,
      'Content-Type': 'application/json',
    }
    if (opts.httpReferer) headers['HTTP-Referer'] = opts.httpReferer
    if (opts.appName) headers['X-Title'] = opts.appName

    const body = JSON.stringify({
      model: req.model,
      messages: req.messages,
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.max_tokens !== undefined ? { max_tokens: req.max_tokens } : {}),
    })

    let response: Response
    try {
      response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body,
      })
    } catch (err) {
      return {
        text: '',
        raw_usage: null,
        finish_reason: 'error',
        latency_ms: Date.now() - start,
        error: {
          kind: 'network',
          message: err instanceof Error ? err.message : String(err),
        },
      }
    }

    const latency_ms = Date.now() - start

    if (!response.ok) {
      let bodyText = ''
      try {
        bodyText = await response.text()
      } catch {
        // ignore — we still report status
      }
      return {
        text: '',
        raw_usage: null,
        finish_reason: 'error',
        latency_ms,
        error: {
          kind: classifyHttpError(response.status),
          message: bodyText || `HTTP ${String(response.status)}`,
          status: response.status,
        },
      }
    }

    let parsed: unknown
    try {
      parsed = await response.json()
    } catch (err) {
      return {
        text: '',
        raw_usage: null,
        finish_reason: 'error',
        latency_ms,
        error: {
          kind: 'parse',
          message: err instanceof Error ? err.message : 'invalid JSON response',
        },
      }
    }

    const data = parseChatBody(parsed)
    const choice = data.choices?.[0]
    const text =
      typeof choice?.message?.content === 'string' ? choice.message.content : ''
    const finish_reason =
      typeof choice?.finish_reason === 'string' ? choice.finish_reason : 'unknown'
    const raw_usage = data.usage ?? null

    return {
      text,
      raw_usage,
      finish_reason,
      latency_ms,
    }
  }
}

// Anthropic-direct LLMClient — E0 enabler for E3 cache-hit subset.
// Surfaces cache_read_input_tokens / cache_creation_input_tokens through
// raw_usage so the rest of the pipeline (telemetry, summary aggregation)
// can observe cache hits per turn without a separate code path.
//
// Internal AHC calls (digest / observer / reflection) go through this client
// on the anthropic_direct provider path; they don't set cache_control —
// caching happens on the main actor call inside `createAhcRuntime`, which
// uses @ai-sdk/anthropic provider with its own cache header handling.
export type AnthropicClientOptions = {
  apiKey: string
  baseURL?: string
}

type AnthropicMessageParam = {
  role: 'user' | 'assistant'
  content: string
}

function classifyAnthropicError(err: unknown): LLMResponseError['kind'] {
  if (err instanceof Anthropic.APIError) {
    if (err.status === 401 || err.status === 403) return 'auth'
    if (err.status === 429) return 'rate_limit'
    if (err.status !== undefined && err.status >= 500) return 'server_error'
  }
  if (err instanceof Anthropic.APIConnectionError) return 'network'
  return 'unknown'
}

function llmMessagesToAnthropic(
  messages: LLMRequest['messages'],
): { system: string | undefined; messages: AnthropicMessageParam[] } {
  const systemParts: string[] = []
  const out: AnthropicMessageParam[] = []
  for (const m of messages) {
    const text =
      typeof m.content === 'string'
        ? m.content
        : m.content
            .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
            .map((b) => b.text)
            .join('\n')
    if (m.role === 'system') {
      systemParts.push(text)
      continue
    }
    out.push({ role: m.role, content: text })
  }
  return {
    system: systemParts.length > 0 ? systemParts.join('\n\n') : undefined,
    messages: out,
  }
}

const DEFAULT_ANTHROPIC_MAX_TOKENS = 4096

export function createAnthropicClient(opts: AnthropicClientOptions): LLMClient {
  const client = new Anthropic({
    apiKey: opts.apiKey,
    ...(opts.baseURL !== undefined ? { baseURL: opts.baseURL } : {}),
  })
  return async (req: LLMRequest): Promise<LLMResponse> => {
    const start = Date.now()
    const { system, messages } = llmMessagesToAnthropic(req.messages)
    try {
      const resp = await client.messages.create({
        model: req.model,
        max_tokens: req.max_tokens ?? DEFAULT_ANTHROPIC_MAX_TOKENS,
        messages,
        ...(system !== undefined ? { system } : {}),
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      })
      const text = resp.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('')
      // Anthropic SDK types these cache fields as `number | null`; project
      // schema (AnthropicUsage) only accepts `number | undefined`. Map null
      // → absent so existing telemetry consumers don't see null-vs-undefined
      // ambiguity (TurnUsagePart's `cache_read_input_tokens?: number`).
      const cacheRead = resp.usage.cache_read_input_tokens
      const cacheCreation = resp.usage.cache_creation_input_tokens
      const raw_usage: AnthropicUsage = {
        input_tokens: resp.usage.input_tokens,
        output_tokens: resp.usage.output_tokens,
        ...(cacheRead != null ? { cache_read_input_tokens: cacheRead } : {}),
        ...(cacheCreation != null
          ? { cache_creation_input_tokens: cacheCreation }
          : {}),
      }
      return {
        text,
        raw_usage,
        finish_reason: resp.stop_reason ?? 'unknown',
        latency_ms: Date.now() - start,
      }
    } catch (err) {
      // APIError.status is typed loosely by Anthropic SDK — pull through a
      // typed local so the `status` field assigned to LLMResponseError stays
      // strictly `number`.
      const status: number | undefined =
        err instanceof Anthropic.APIError && typeof err.status === 'number'
          ? err.status
          : undefined
      return {
        text: '',
        raw_usage: null,
        finish_reason: 'error',
        latency_ms: Date.now() - start,
        error: {
          kind: classifyAnthropicError(err),
          message: err instanceof Error ? err.message : String(err),
          ...(status !== undefined ? { status } : {}),
        },
      }
    }
  }
}

export function anthropicCostFromUsage(model: string, usage: AnthropicUsage): number {
  const pricing = ANTHROPIC_DIRECT_PRICING[model]
  if (!pricing) return 0
  return (
    (usage.input_tokens * pricing.input_per_million_usd +
      usage.output_tokens * pricing.output_per_million_usd) /
    1_000_000
  )
}

// Anthropic semantics: `input_tokens` excludes cached and creation slices
// (each reported in its own field). Effective input billed is
//   input_tokens + cache_read * read_factor + cache_creation * write_factor
// times `input_per_million_usd`. Factors default to 1.0 when pricing entry
// omits them — degenerates to anthropicCostFromUsage for cache-naive models.
export function anthropicCostFromUsageWithCache(
  model: string,
  usage: AnthropicUsage,
): number {
  const pricing = ANTHROPIC_DIRECT_PRICING[model]
  if (!pricing) return 0
  const readFactor = pricing.cache_read_factor ?? 1
  const writeFactor = pricing.cache_write_factor ?? 1
  const cacheRead = usage.cache_read_input_tokens ?? 0
  const cacheCreate = usage.cache_creation_input_tokens ?? 0
  const effectiveInput =
    usage.input_tokens + cacheRead * readFactor + cacheCreate * writeFactor
  return (
    (effectiveInput * pricing.input_per_million_usd +
      usage.output_tokens * pricing.output_per_million_usd) /
    1_000_000
  )
}
