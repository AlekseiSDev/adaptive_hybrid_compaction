// `web_search` tool for GAIA. Per docs/design/K_gaia.md §4.
//
// Fallback chain (mirror Holosophus academia_mcp/tools/web_search.py):
//   1. SearXNG (`SEARXNG_URL` env, self-hosted, no API key)
//   2. Tavily (`TAVILY_API_KEY`)
//   3. Brave (`BRAVE_API_KEY`)
//   4. Mock (`MOCK_WEB_SEARCH=true`) — deterministic fixture
//   5. throw
//
// Returns normalized `{title, url, snippet}[]` regardless of provider.

export type SearchResult = {
  title: string
  url: string
  snippet: string
}

export type WebSearchOptions = {
  maxResults?: number
  // Override default env-based provider selection (useful for unit tests).
  fetchFn?: typeof fetch
}

const DEFAULT_MAX = 5
const REQUEST_TIMEOUT_MS = 30_000

function timeoutSignal(ms: number): AbortSignal {
  return AbortSignal.timeout(ms)
}

async function searchSearXNG(
  url: string,
  query: string,
  maxResults: number,
  fetchFn: typeof fetch,
): Promise<SearchResult[]> {
  const params = new URLSearchParams({ q: query, format: 'json', pageno: '1' })
  const res = await fetchFn(`${url.replace(/\/$/, '')}/search?${params.toString()}`, {
    signal: timeoutSignal(REQUEST_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`SearXNG ${String(res.status)}: ${await res.text()}`)
  const body = (await res.json()) as { results?: { url?: string; title?: string; content?: string }[] }
  const results = body.results ?? []
  return results.slice(0, maxResults).map((r) => ({
    title: r.title ?? '',
    url: r.url ?? '',
    snippet: r.content ?? '',
  }))
}

async function searchTavily(
  apiKey: string,
  query: string,
  maxResults: number,
  fetchFn: typeof fetch,
): Promise<SearchResult[]> {
  const res = await fetchFn('https://api.tavily.com/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ query, max_results: maxResults, search_depth: 'basic' }),
    signal: timeoutSignal(REQUEST_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`Tavily ${String(res.status)}: ${await res.text()}`)
  const body = (await res.json()) as { results?: { url?: string; title?: string; content?: string }[] }
  const results = body.results ?? []
  return results.slice(0, maxResults).map((r) => ({
    title: r.title ?? '',
    url: r.url ?? '',
    snippet: r.content ?? '',
  }))
}

async function searchBrave(
  apiKey: string,
  query: string,
  maxResults: number,
  fetchFn: typeof fetch,
): Promise<SearchResult[]> {
  const params = new URLSearchParams({ q: query, count: String(maxResults) })
  const res = await fetchFn(
    `https://api.search.brave.com/res/v1/web/search?${params.toString()}`,
    {
      headers: {
        Accept: 'application/json',
        'X-Subscription-Token': apiKey,
      },
      signal: timeoutSignal(REQUEST_TIMEOUT_MS),
    },
  )
  if (!res.ok) throw new Error(`Brave ${String(res.status)}: ${await res.text()}`)
  const body = (await res.json()) as {
    web?: { results?: { url?: string; title?: string; description?: string }[] }
  }
  const results = body.web?.results ?? []
  return results.slice(0, maxResults).map((r) => ({
    title: r.title ?? '',
    url: r.url ?? '',
    snippet: r.description ?? '',
  }))
}

function mockResults(query: string, maxResults: number): SearchResult[] {
  // Deterministic fixture for offline/CI smoke. Embeds query so tests can
  // assert content propagation through the agent loop.
  return Array.from({ length: Math.min(maxResults, 3) }, (_, i) => ({
    title: `Mock result ${String(i + 1)} for "${query}"`,
    url: `https://example.invalid/mock/${String(i + 1)}`,
    snippet: `Mock snippet ${String(i + 1)} containing query "${query}". For testing only.`,
  }))
}

export async function webSearch(
  query: string,
  opts: WebSearchOptions = {},
): Promise<SearchResult[]> {
  // Strict default (2026-05-26): provider chain is opt-in via
  // WEB_SEARCH_AUTOSELECT=true. Цель — honest experiments: пользователь
  // должен явно подтвердить что готов к silent fallback (SearXNG →
  // Tavily → Brave → mock) если первый provider не настроен. Без флага
  // — throw, чтобы случайный mock в проде не подменил реальные числа.
  if (process.env['WEB_SEARCH_AUTOSELECT'] !== 'true') {
    throw new Error(
      'web_search: strict default. Set WEB_SEARCH_AUTOSELECT=true to ' +
        'enable provider chain (SearXNG → Tavily → Brave → mock). Then ' +
        'configure one of: SEARXNG_URL / TAVILY_API_KEY / BRAVE_API_KEY ' +
        '/ MOCK_WEB_SEARCH=true.',
    )
  }
  const maxResults = opts.maxResults ?? DEFAULT_MAX
  const fetchFn = opts.fetchFn ?? fetch

  const searxng = process.env['SEARXNG_URL']
  if (searxng !== undefined && searxng.length > 0) {
    return searchSearXNG(searxng, query, maxResults, fetchFn)
  }
  const tavily = process.env['TAVILY_API_KEY']
  if (tavily !== undefined && tavily.length > 0) {
    return searchTavily(tavily, query, maxResults, fetchFn)
  }
  const brave = process.env['BRAVE_API_KEY']
  if (brave !== undefined && brave.length > 0) {
    return searchBrave(brave, query, maxResults, fetchFn)
  }
  if (process.env['MOCK_WEB_SEARCH'] === 'true') {
    return mockResults(query, maxResults)
  }
  throw new Error(
    'web_search: WEB_SEARCH_AUTOSELECT=true но не настроен ни один provider. ' +
      'Set one of: SEARXNG_URL (self-hosted), TAVILY_API_KEY, BRAVE_API_KEY, ' +
      'MOCK_WEB_SEARCH=true.',
  )
}
