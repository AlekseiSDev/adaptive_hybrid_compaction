#!/usr/bin/env tsx
// B6 Langfuse session/trace/span hierarchy verifier — supersedes B4
// `check-langfuse-trace.ts`. Two modes:
//
// --mode=count (B4 fallback, legacy behaviour preserved):
//   GET /api/public/traces?fromTimestamp=...  →  exit 0 if data.length >= min-traces
//
// --mode=hierarchy (B6 default):
//   GET /api/public/sessions?fromTimestamp=...
//     → filter by --session-prefix (=`<bench>-`) or exact (=`<bench>-<config>-<seed>`)
//   GET /api/public/sessions/<id>             → list traces in session
//   GET /api/public/traces/<id>               → observations tree (root + children)
//   assert: each trace named `eval.task`, parent_observation_id === null,
//           ≥ --expected-turns-min `eval.turn` spans,
//           ≥ --expected-tool-calls-min `ai.toolCall` spans.
//
// Functions exported for unit tests (see check-langfuse-hierarchy.test.ts) —
// fetch is injectable so the CLI can be exercised without a live Langfuse stack.

const DEFAULT_BASE_URL = 'http://localhost:3001'
const DEFAULT_SINCE_SECONDS = 60
const DEFAULT_MIN_TRACES = 1

export type Mode = 'count' | 'hierarchy'

export type Args = {
  mode: Mode
  sinceSeconds: number
  baseUrl: string
  // --mode=count
  minTraces: number
  // --mode=hierarchy
  bench: string | undefined
  configId: string | undefined
  seed: number | undefined
  expectedTurnsMin: number
  expectedToolCallsMin: number
}

const HELP = `usage: tsx scripts/check-langfuse-hierarchy.ts [options]

Common:
  --mode=count|hierarchy   default: hierarchy
  --since-seconds=N        default: 60
  --base-url=URL           default: env LANGFUSE_BASE_URL or http://localhost:3001

--mode=count (legacy B4):
  --min-traces=N           default: 1

--mode=hierarchy (B6):
  --bench=<name>           required (e.g. gaia-med, lme-multiturn)
  --config-id=<hash>       optional — narrow to single (bench, config_id) pair
  --seed=N                 optional — narrow to single cell
  --expected-turns-min=N   default: 0 (no assertion)
  --expected-tool-calls-min=N  default: 0 (no assertion)

env: LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY (required when running CLI)`

export function parseArgs(argv: string[]): Args {
  let mode: Mode = 'hierarchy'
  let sinceSeconds = DEFAULT_SINCE_SECONDS
  let baseUrl: string | undefined
  let minTraces = DEFAULT_MIN_TRACES
  let bench: string | undefined
  let configId: string | undefined
  let seed: number | undefined
  let expectedTurnsMin = 0
  let expectedToolCallsMin = 0

  for (const a of argv) {
    if (typeof a !== 'string') continue
    if (a === '--help' || a === '-h') {
      console.log(HELP)
      process.exit(0)
    } else if (a.startsWith('--mode=')) {
      const v = a.slice('--mode='.length)
      if (v !== 'count' && v !== 'hierarchy') {
        throw new Error(`--mode must be 'count' or 'hierarchy', got "${v}"`)
      }
      mode = v
    } else if (a.startsWith('--since-seconds=')) {
      sinceSeconds = Number.parseInt(a.slice('--since-seconds='.length), 10)
    } else if (a.startsWith('--base-url=')) {
      baseUrl = a.slice('--base-url='.length)
    } else if (a.startsWith('--min-traces=')) {
      minTraces = Number.parseInt(a.slice('--min-traces='.length), 10)
    } else if (a.startsWith('--bench=')) {
      bench = a.slice('--bench='.length)
    } else if (a.startsWith('--config-id=')) {
      configId = a.slice('--config-id='.length)
    } else if (a.startsWith('--seed=')) {
      seed = Number.parseInt(a.slice('--seed='.length), 10)
    } else if (a.startsWith('--expected-turns-min=')) {
      expectedTurnsMin = Number.parseInt(
        a.slice('--expected-turns-min='.length),
        10,
      )
    } else if (a.startsWith('--expected-tool-calls-min=')) {
      expectedToolCallsMin = Number.parseInt(
        a.slice('--expected-tool-calls-min='.length),
        10,
      )
    } else {
      throw new Error(`unknown arg: ${a}`)
    }
  }

  if (Number.isNaN(sinceSeconds) || sinceSeconds <= 0) {
    throw new Error('--since-seconds must be positive integer')
  }
  if (mode === 'count' && (Number.isNaN(minTraces) || minTraces < 0)) {
    throw new Error('--min-traces must be non-negative integer')
  }
  if (mode === 'hierarchy' && (bench === undefined || bench.length === 0)) {
    throw new Error('--bench is required with --mode=hierarchy')
  }

  return {
    mode,
    sinceSeconds,
    baseUrl: baseUrl ?? process.env['LANGFUSE_BASE_URL'] ?? DEFAULT_BASE_URL,
    minTraces,
    bench,
    configId,
    seed,
    expectedTurnsMin,
    expectedToolCallsMin,
  }
}

// Langfuse API shapes — subset we actually consume. Extra fields are tolerated
// (no schema validation; we trust Langfuse to keep the documented contract).
export type LfTrace = {
  id: string
  name?: string
  sessionId?: string | null
  observations?: { id: string }[] | string[]
  parentObservationId?: string | null
}

export type LfObservation = {
  id: string
  name?: string
  parentObservationId?: string | null
  type?: string
}

export type LfSession = {
  id: string
  createdAt?: string
}

export type LfTracesResponse = { data?: LfTrace[]; meta?: { totalItems?: number } }
export type LfSessionsResponse = { data?: LfSession[]; meta?: { totalItems?: number } }
export type LfTraceDetailResponse = LfTrace & {
  observations?: (LfObservation | string)[]
}

// Injectable fetcher so the unit test can mock without a live Langfuse stack.
export type Fetcher = (url: string, init?: { headers?: Record<string, string> }) => Promise<{
  ok: boolean
  status: number
  statusText: string
  json: () => Promise<unknown>
  text: () => Promise<string>
}>

export type CheckDeps = {
  publicKey: string
  secretKey: string
  fetcher: Fetcher
  logger?: { log: (msg: string) => void; error: (msg: string) => void }
}

function basicAuthHeader(publicKey: string, secretKey: string): string {
  return `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString('base64')}`
}

async function getJson<T>(
  url: string,
  deps: CheckDeps,
): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  const res = await deps.fetcher(url, {
    headers: {
      Authorization: basicAuthHeader(deps.publicKey, deps.secretKey),
      Accept: 'application/json',
    },
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    return {
      ok: false,
      error: `${String(res.status)} ${res.statusText}: ${text}`,
    }
  }
  try {
    const value = (await res.json()) as T
    return { ok: true, value }
  } catch (err) {
    return {
      ok: false,
      error: `invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

export async function runCountMode(
  args: Args,
  deps: CheckDeps,
): Promise<{ exitCode: number }> {
  const log = deps.logger ?? console
  const fromTimestamp = new Date(Date.now() - args.sinceSeconds * 1000).toISOString()
  const url = `${args.baseUrl}/api/public/traces?fromTimestamp=${encodeURIComponent(fromTimestamp)}`
  const r = await getJson<LfTracesResponse>(url, deps)
  if (!r.ok) {
    log.error(`[count] fetch failed: ${r.error}`)
    return { exitCode: 1 }
  }
  const traces = r.value.data ?? []
  log.log(
    `[count] base_url=${args.baseUrl} fromTimestamp=${fromTimestamp}` +
      `  traces_returned=${String(traces.length)}` +
      `  total_items=${String(r.value.meta?.totalItems ?? 'n/a')}`,
  )
  for (const t of traces.slice(0, 10)) {
    const obsCount = Array.isArray(t.observations) ? t.observations.length : 0
    log.log(
      `  trace_id=${t.id}  name=${t.name ?? '<unnamed>'}  observations=${String(obsCount)}`,
    )
  }
  if (traces.length < args.minTraces) {
    log.error(
      `\nFAIL: expected >= ${String(args.minTraces)} trace(s), got ${String(traces.length)}`,
    )
    return { exitCode: 1 }
  }
  log.log(
    `\nOK: ${String(traces.length)} trace(s) >= min-traces=${String(args.minTraces)}`,
  )
  return { exitCode: 0 }
}

function sessionMatches(
  sessionId: string,
  bench: string,
  configId: string | undefined,
  seed: number | undefined,
): boolean {
  if (configId !== undefined && seed !== undefined) {
    return sessionId === `${bench}-${configId}-${String(seed)}`
  }
  if (configId !== undefined) {
    return sessionId.startsWith(`${bench}-${configId}-`)
  }
  return sessionId.startsWith(`${bench}-`)
}

export type HierarchySummary = {
  sessions: number
  traces: number
  evalTurnSpans: number
  toolCallSpans: number
  rootTraces: number
  nonRootTraces: number
}

export async function runHierarchyMode(
  args: Args,
  deps: CheckDeps,
): Promise<{ exitCode: number; summary: HierarchySummary }> {
  const log = deps.logger ?? console
  const summary: HierarchySummary = {
    sessions: 0,
    traces: 0,
    evalTurnSpans: 0,
    toolCallSpans: 0,
    rootTraces: 0,
    nonRootTraces: 0,
  }
  if (args.bench === undefined) {
    log.error('[hierarchy] --bench is required')
    return { exitCode: 1, summary }
  }
  const fromTimestamp = new Date(Date.now() - args.sinceSeconds * 1000).toISOString()

  // 1. Fetch sessions in the window. Langfuse session list endpoint:
  //    GET /api/public/sessions?fromTimestamp=...
  const sessUrl = `${args.baseUrl}/api/public/sessions?fromTimestamp=${encodeURIComponent(fromTimestamp)}`
  const sessR = await getJson<LfSessionsResponse>(sessUrl, deps)
  if (!sessR.ok) {
    log.error(`[hierarchy] sessions fetch failed: ${sessR.error}`)
    return { exitCode: 1, summary }
  }
  const allSessions = sessR.value.data ?? []
  const matchedSessions = allSessions.filter((s) =>
    sessionMatches(s.id, args.bench ?? '', args.configId, args.seed),
  )
  summary.sessions = matchedSessions.length
  log.log(
    `[hierarchy] base_url=${args.baseUrl} bench=${args.bench}` +
      ` configId=${args.configId ?? '*'} seed=${args.seed ?? '*'}` +
      ` since=${fromTimestamp}`,
  )
  log.log(
    `  sessions_total=${String(allSessions.length)} sessions_matched=${String(matchedSessions.length)}`,
  )

  if (matchedSessions.length === 0) {
    log.error(`\nFAIL: no Langfuse sessions matched bench=${args.bench}`)
    return { exitCode: 1, summary }
  }

  // 2. For each matched session, list traces. Langfuse exposes per-session
  //    queries via /api/public/traces?sessionId=<id>.
  for (const sess of matchedSessions) {
    const tracesUrl = `${args.baseUrl}/api/public/traces?sessionId=${encodeURIComponent(sess.id)}`
    const tr = await getJson<LfTracesResponse>(tracesUrl, deps)
    if (!tr.ok) {
      log.error(`[hierarchy] traces fetch failed for session=${sess.id}: ${tr.error}`)
      return { exitCode: 1, summary }
    }
    const traces = tr.value.data ?? []
    summary.traces += traces.length
    log.log(`  session=${sess.id}  traces=${String(traces.length)}`)
    for (const t of traces) {
      // 3. Fetch trace details (observations tree).
      const detailR = await getJson<LfTraceDetailResponse>(
        `${args.baseUrl}/api/public/traces/${encodeURIComponent(t.id)}`,
        deps,
      )
      if (!detailR.ok) {
        log.error(`[hierarchy] trace detail fetch failed for ${t.id}: ${detailR.error}`)
        return { exitCode: 1, summary }
      }
      const detail = detailR.value
      const observations: LfObservation[] = []
      for (const o of detail.observations ?? []) {
        if (typeof o === 'string') continue // skip id-only forms (defensive)
        observations.push(o)
      }
      const turnSpans = observations.filter((o) => o.name === 'eval.turn')
      // Tool-call spans: AI SDK emits ai.toolCall with attribute
      // `ai.toolCall.name = '<tool_name>'`. Langfuse renames the displayed
      // span by the tool name (e.g. `web_search`) but tags type=TOOL — that's
      // the stable discriminator. Filter by type rather than name prefix.
      const toolSpans = observations.filter((o) => o.type === 'TOOL')
      const isRoot =
        detail.parentObservationId === null ||
        detail.parentObservationId === undefined
      if (isRoot) summary.rootTraces += 1
      else summary.nonRootTraces += 1
      summary.evalTurnSpans += turnSpans.length
      summary.toolCallSpans += toolSpans.length
      log.log(
        `    trace=${t.id} name=${detail.name ?? '<unnamed>'}` +
          ` root=${String(isRoot)}` +
          ` eval.turn=${String(turnSpans.length)}` +
          ` ai.toolCall=${String(toolSpans.length)}`,
      )
    }
  }

  // 4. Assertions.
  const failures: string[] = []
  if (summary.nonRootTraces > 0) {
    failures.push(
      `expected ALL traces to be roots (parent_observation_id null), found ${String(summary.nonRootTraces)} with parent`,
    )
  }
  if (summary.evalTurnSpans < args.expectedTurnsMin) {
    failures.push(
      `expected >= ${String(args.expectedTurnsMin)} eval.turn spans, got ${String(summary.evalTurnSpans)}`,
    )
  }
  if (summary.toolCallSpans < args.expectedToolCallsMin) {
    failures.push(
      `expected >= ${String(args.expectedToolCallsMin)} ai.toolCall spans, got ${String(summary.toolCallSpans)}`,
    )
  }

  log.log(
    `\nsummary:` +
      ` sessions=${String(summary.sessions)}` +
      ` traces=${String(summary.traces)}` +
      ` eval.turn=${String(summary.evalTurnSpans)}` +
      ` ai.toolCall=${String(summary.toolCallSpans)}` +
      ` roots=${String(summary.rootTraces)} non_roots=${String(summary.nonRootTraces)}`,
  )

  if (failures.length > 0) {
    for (const f of failures) log.error(`FAIL: ${f}`)
    return { exitCode: 1, summary }
  }
  log.log('OK: hierarchy assertions passed')
  return { exitCode: 0, summary }
}

async function main(): Promise<void> {
  let args: Args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
  const publicKey = process.env['LANGFUSE_PUBLIC_KEY']
  const secretKey = process.env['LANGFUSE_SECRET_KEY']
  if (!publicKey || !secretKey) {
    console.error(
      'error: LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY env vars are required',
    )
    process.exit(1)
  }
  const deps: CheckDeps = {
    publicKey,
    secretKey,
    fetcher: (url, init) =>
      fetch(url, { method: 'GET', headers: init?.headers ?? {} }) as ReturnType<Fetcher>,
  }

  const { exitCode } =
    args.mode === 'count'
      ? await runCountMode(args, deps)
      : await runHierarchyMode(args, deps)
  process.exit(exitCode)
}

// Only run when invoked as CLI, not when imported by test.
const entryUrl = `file://${process.argv[1] ?? ''}`
if (import.meta.url === entryUrl) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  })
}
