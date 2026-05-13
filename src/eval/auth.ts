// Pre-flight auth verification for sweep launches. Cheap fail-fast — runs
// once before runSweep so bad creds surface immediately, not after multiple
// cells crash mid-run with auth_error records.
//
// OpenRouter: GET /auth/key returns {data: {usage, limit, ...}} on 200.
// LiteLLM: GET /health/liveliness returns {status: 'healthy'} on 200.
// Anthropic-direct: no ping endpoint that doesn't cost ~$0.0001; skip
// (runner instantiation already fails-loud on missing ANTHROPIC_API_KEY).
//
// Bypass: scripts/eval.ts exposes --skip-auth-check for emergencies.

export type AuthPingResult = {
  ok: boolean
  /** Optional details for human-readable report (balance, account label, etc.) */
  detail?: string
  /** Set when ok=false; describes the failure mode. */
  error?: string
}

const OPENROUTER_AUTH_URL = 'https://openrouter.ai/api/v1/auth/key'

type OpenRouterAuthKeyResponse = {
  data?: {
    label?: string
    usage?: number
    limit?: number | null
    is_free_tier?: boolean
  }
}

export async function pingOpenRouter(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AuthPingResult> {
  try {
    const resp = await fetchImpl(OPENROUTER_AUTH_URL, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    if (!resp.ok) {
      const text = await safeReadText(resp)
      return {
        ok: false,
        error: `OpenRouter /auth/key returned HTTP ${String(resp.status)}${text ? ': ' + text.slice(0, 200) : ''}`,
      }
    }
    const body = (await resp.json()) as OpenRouterAuthKeyResponse
    const data = body.data
    if (!data) {
      return { ok: false, error: 'OpenRouter /auth/key returned 200 but body had no `data` field' }
    }
    // Limit may be null (unlimited / pay-as-you-go) or a positive number
    // (prepaid credit cap). Surface a compact human label either way.
    const limitText =
      data.limit === null || data.limit === undefined
        ? 'unlimited'
        : `limit=$${data.limit.toFixed(2)}`
    const usageText = data.usage !== undefined ? `usage=$${data.usage.toFixed(2)}` : 'usage=?'
    const label = data.label ?? 'no-label'
    return {
      ok: true,
      detail: `OpenRouter: ${label}, ${usageText}, ${limitText}`,
    }
  } catch (err) {
    return {
      ok: false,
      error: `OpenRouter ping network/parse error: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

export async function pingLiteLLM(
  baseUrl: string,
  masterKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AuthPingResult> {
  // Try /health/liveliness (LiteLLM standard health endpoint). Some proxies
  // are configured with /health or just respond on /. We try a couple of
  // fallbacks before declaring failure.
  const candidates = ['/health/liveliness', '/health', '/']
  for (const path of candidates) {
    const url = baseUrl.replace(/\/+$/, '') + path
    try {
      const resp = await fetchImpl(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${masterKey}` },
      })
      if (resp.ok) {
        return {
          ok: true,
          detail: `LiteLLM at ${baseUrl}: ${path} reached`,
        }
      }
      if (resp.status === 401 || resp.status === 403) {
        const text = await safeReadText(resp)
        return {
          ok: false,
          error: `LiteLLM at ${baseUrl}: auth rejected (HTTP ${String(resp.status)})${text ? ': ' + text.slice(0, 200) : ''}`,
        }
      }
      // Other 4xx/5xx: try next path.
    } catch {
      // Network error on this path; try next.
    }
  }
  return {
    ok: false,
    error: `LiteLLM at ${baseUrl}: none of /health/liveliness, /health, / responded successfully`,
  }
}

async function safeReadText(resp: Response): Promise<string> {
  try {
    return await resp.text()
  } catch {
    return ''
  }
}
