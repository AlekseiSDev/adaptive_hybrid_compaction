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
export type ModelPricing = {
  input_per_million_usd: number
  output_per_million_usd: number
}

export const OPENROUTER_PRICING: Record<string, ModelPricing> = Object.freeze({
  'google/gemini-3-flash-preview': {
    input_per_million_usd: 0.5,
    output_per_million_usd: 3.0,
  },
  // D4 judge model. Sonnet 4-7 not yet on OpenRouter (2026-05-13 verified via
  // /api/v1/models); fallback to 4.6 per plan. Note: OpenRouter uses dot
  // notation (4.6), Anthropic SDK uses dash (4-6). Pricing verified live.
  'anthropic/claude-sonnet-4.6': {
    input_per_million_usd: 3.0,
    output_per_million_usd: 15.0,
  },
})

// Anthropic direct-API pricing snapshot — separate table from OpenRouter
// proxy pricing because direct API has slightly different prompt-cache rates
// and uses dash-form model ids (claude-sonnet-4-6, not 4.6). E3 cache-hit
// subset routes through Anthropic-direct; main sweeps stay on OpenRouter.
// Cache rates ignored in cost calc — F report uses cache_read_input_tokens
// ratio as the metric, not a per-token cost line. Refresh перед E3 launch.
export const ANTHROPIC_DIRECT_PRICING: Record<string, ModelPricing> = Object.freeze({
  'claude-sonnet-4-6': {
    input_per_million_usd: 3.0,
    output_per_million_usd: 15.0,
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
