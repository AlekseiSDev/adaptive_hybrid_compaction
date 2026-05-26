#!/usr/bin/env tsx
// Direct sanity-check для `webSearch` (Track K). Бьёт provider минуя AI SDK
// agent loop — sanity check что search возвращает осмысленные results.
//
// Usage:
//   docker compose -f observability/searxng-docker-compose.yml up -d
//   WEB_SEARCH_AUTOSELECT=true SEARXNG_URL=http://localhost:8080 \
//     pnpm tsx scripts/check-gaia-search.ts ['<query>']
//
// Default query: 'GAIA benchmark Mialon arxiv 2023'. Output: pretty JSON
// + result count to stdout. Exit code 0 при non-empty, 1 при пустом.

import { webSearch } from '../src/eval/adapters/gaia-tools/web-search.js'

async function main(): Promise<void> {
  const query = process.argv[2] ?? 'GAIA benchmark Mialon arxiv 2023'
  const maxResults = Number.parseInt(process.argv[3] ?? '3', 10)
  console.log(`[probe] query: ${query}`)
  console.log(`[probe] maxResults: ${String(maxResults)}`)

  const t0 = Date.now()
  const results = await webSearch(query, { maxResults })
  const dt = Date.now() - t0
  console.log(`[probe] elapsed: ${String(dt)}ms`)
  console.log(`[probe] ${String(results.length)} results returned\n`)
  console.log(JSON.stringify(results, null, 2))

  if (results.length === 0) {
    console.error('\n[probe] FAIL: empty results array')
    process.exit(1)
  }
  console.log('\n[probe] OK')
}

await main()
