#!/usr/bin/env tsx
// B4 end-to-end Langfuse trace verifier (per docs/design/B_eval-harness.md §9.7).
// Fetches /api/public/traces with HTTP Basic auth, filters by fromTimestamp,
// exits 0 if >= min-traces traces returned, exits 1 otherwise.

const DEFAULT_BASE_URL = 'http://localhost:3001'
const DEFAULT_SINCE_SECONDS = 60
const DEFAULT_MIN_TRACES = 1

type Args = {
  sinceSeconds: number
  minTraces: number
  baseUrl: string
}

function parseArgs(argv: string[]): Args {
  let sinceSeconds = DEFAULT_SINCE_SECONDS
  let minTraces = DEFAULT_MIN_TRACES
  let baseUrl: string | undefined
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (typeof a !== 'string') continue
    if (a.startsWith('--since-seconds=')) {
      sinceSeconds = Number.parseInt(a.slice('--since-seconds='.length), 10)
    } else if (a.startsWith('--min-traces=')) {
      minTraces = Number.parseInt(a.slice('--min-traces='.length), 10)
    } else if (a.startsWith('--base-url=')) {
      baseUrl = a.slice('--base-url='.length)
    } else if (a === '--help' || a === '-h') {
      console.log(
        'usage: tsx scripts/check-langfuse-trace.ts [--since-seconds=60] [--min-traces=1] [--base-url=...]',
      )
      console.log(
        'env: LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY (required), LANGFUSE_BASE_URL (default http://localhost:3001)',
      )
      process.exit(0)
    } else {
      console.error(`error: unknown arg: ${a}`)
      process.exit(1)
    }
  }
  if (Number.isNaN(sinceSeconds) || sinceSeconds <= 0) {
    console.error('error: --since-seconds must be positive integer')
    process.exit(1)
  }
  if (Number.isNaN(minTraces) || minTraces < 0) {
    console.error('error: --min-traces must be non-negative integer')
    process.exit(1)
  }
  return {
    sinceSeconds,
    minTraces,
    baseUrl: baseUrl ?? process.env['LANGFUSE_BASE_URL'] ?? DEFAULT_BASE_URL,
  }
}

type LangfuseTrace = {
  id: string
  name?: string
  observations?: { id: string }[]
}

type LangfuseTracesResponse = {
  data?: LangfuseTrace[]
  meta?: { totalItems?: number }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const publicKey = process.env['LANGFUSE_PUBLIC_KEY']
  const secretKey = process.env['LANGFUSE_SECRET_KEY']
  if (!publicKey || !secretKey) {
    console.error(
      'error: LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY env vars are required',
    )
    process.exit(1)
  }

  const fromTimestamp = new Date(Date.now() - args.sinceSeconds * 1000).toISOString()
  const url = `${args.baseUrl}/api/public/traces?fromTimestamp=${encodeURIComponent(fromTimestamp)}`

  const auth = Buffer.from(`${publicKey}:${secretKey}`).toString('base64')

  let response: Response
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: 'application/json',
      },
    })
  } catch (err) {
    console.error(
      `error: failed to fetch ${url}: ${err instanceof Error ? err.message : String(err)}`,
    )
    process.exit(1)
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    console.error(
      `error: Langfuse responded ${String(response.status)}: ${text || response.statusText}`,
    )
    process.exit(1)
  }

  let parsed: LangfuseTracesResponse
  try {
    parsed = (await response.json()) as LangfuseTracesResponse
  } catch (err) {
    console.error(
      `error: invalid JSON from Langfuse: ${err instanceof Error ? err.message : String(err)}`,
    )
    process.exit(1)
  }

  const traces = parsed.data ?? []
  console.log(
    `[check-langfuse-trace] base_url=${args.baseUrl} fromTimestamp=${fromTimestamp}` +
      `  traces_returned=${String(traces.length)}` +
      `  total_items=${String(parsed.meta?.totalItems ?? 'n/a')}`,
  )
  for (const t of traces.slice(0, 10)) {
    const obsCount = t.observations?.length ?? 0
    console.log(`  trace_id=${t.id}  name=${t.name ?? '<unnamed>'}  observations=${String(obsCount)}`)
  }

  if (traces.length < args.minTraces) {
    console.error(
      `\nFAIL: expected >= ${String(args.minTraces)} trace(s), got ${String(traces.length)}`,
    )
    process.exit(1)
  }
  console.log(
    `\nOK: ${String(traces.length)} trace(s) >= min-traces=${String(args.minTraces)}`,
  )
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
