import type {
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
