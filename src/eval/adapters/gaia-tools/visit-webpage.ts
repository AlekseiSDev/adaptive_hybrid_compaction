// `visit_webpage` tool for GAIA. Per docs/design/K_gaia.md §4.2.
//
// Fetch HTML → strip <script>/<style> → extract text from text-bearing
// elements (<h*>/<p>/<li>/<td>/<th>) → concatenate with newlines →
// truncate to 50K chars. Cheerio-only (user decision 2026-05-26 — no
// @mozilla/readability + jsdom deps).

import * as cheerio from 'cheerio'

export type VisitWebpageResult = {
  title: string
  text_content: string
}

export type VisitWebpageOptions = {
  maxChars?: number
  timeoutMs?: number
  fetchFn?: typeof fetch
}

const DEFAULT_MAX_CHARS = 50_000
const DEFAULT_TIMEOUT_MS = 15_000

export async function visitWebpage(
  url: string,
  opts: VisitWebpageOptions = {},
): Promise<VisitWebpageResult> {
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const fetchFn = opts.fetchFn ?? fetch

  const res = await fetchFn(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) {
    throw new Error(`visit_webpage ${String(res.status)} ${res.statusText} for ${url}`)
  }
  const html = await res.text()
  const $ = cheerio.load(html)

  // Drop boilerplate first.
  $('script, style, noscript, iframe, svg, nav, header, footer, aside').remove()

  const title = ($('title').first().text() || $('h1').first().text() || '').trim()

  const parts: string[] = []
  // Order matters: walk text-bearing elements top-to-bottom. cheerio's `each`
  // visits in document order.
  $('h1, h2, h3, h4, h5, h6, p, li, td, th, blockquote, pre').each((_, el) => {
    const text = $(el).text().trim()
    if (text.length > 0) parts.push(text)
  })

  let textContent = parts.join('\n\n')
  if (textContent.length > maxChars) {
    const truncated = textContent.slice(0, maxChars)
    textContent =
      truncated +
      `\n\n[... truncated; original length ${String(textContent.length)} chars]`
  }
  return { title, text_content: textContent }
}
