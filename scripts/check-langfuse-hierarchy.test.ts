// B6 verifier unit tests. Mocked fetcher exercises both modes without a live
// Langfuse stack. Lives under scripts/ next to the CLI it tests (consistent
// with scripts/per-class-report.test.ts pattern).

import { describe, expect, test } from 'vitest'
import {
  parseArgs,
  runCountMode,
  runHierarchyMode,
  type CheckDeps,
  type Fetcher,
} from './check-langfuse-hierarchy.js'

type MockResponse = {
  ok?: boolean
  status?: number
  statusText?: string
  body?: unknown
  text?: string
}

function makeFetcher(routes: Record<string, MockResponse>): Fetcher {
  return async (url) => {
    // Match by path-prefix so query-string variation (?sessionId=...,
    // ?fromTimestamp=...) doesn't break the routing table.
    const matched = Object.keys(routes).find((k) => url.includes(k))
    if (!matched) throw new Error(`fetch: unmocked url ${url}`)
    const r = routes[matched] ?? {}
    return {
      ok: r.ok ?? true,
      status: r.status ?? 200,
      statusText: r.statusText ?? 'OK',
      json: () => Promise.resolve(r.body ?? {}),
      text: () => Promise.resolve(r.text ?? ''),
    }
  }
}

function makeLogger(): {
  log: (m: string) => void
  error: (m: string) => void
  logs: string[]
  errors: string[]
} {
  const logs: string[] = []
  const errors: string[] = []
  return {
    log: (m: string) => logs.push(m),
    error: (m: string) => errors.push(m),
    logs,
    errors,
  }
}

describe('parseArgs', () => {
  test('defaults to mode=hierarchy', () => {
    const args = parseArgs(['--bench=gaia-med'])
    expect(args.mode).toBe('hierarchy')
    expect(args.bench).toBe('gaia-med')
    expect(args.expectedTurnsMin).toBe(0)
    expect(args.expectedToolCallsMin).toBe(0)
  })

  test('hierarchy mode requires --bench', () => {
    expect(() => parseArgs(['--mode=hierarchy'])).toThrow(/bench/)
  })

  test('count mode accepts no --bench (legacy)', () => {
    const args = parseArgs(['--mode=count'])
    expect(args.mode).toBe('count')
    expect(args.minTraces).toBe(1)
  })

  test('invalid mode throws', () => {
    expect(() => parseArgs(['--mode=garbage'])).toThrow(/must be/)
  })

  test('numeric args parsed', () => {
    const args = parseArgs([
      '--bench=lme-multiturn',
      '--seed=42',
      '--expected-turns-min=5',
      '--expected-tool-calls-min=2',
      '--since-seconds=300',
    ])
    expect(args.seed).toBe(42)
    expect(args.expectedTurnsMin).toBe(5)
    expect(args.expectedToolCallsMin).toBe(2)
    expect(args.sinceSeconds).toBe(300)
  })

  test('rejects unknown flag', () => {
    expect(() => parseArgs(['--garbage'])).toThrow(/unknown arg/)
  })
})

describe('runCountMode', () => {
  test('exit 0 when traces.length >= min-traces', async () => {
    const logger = makeLogger()
    const deps: CheckDeps = {
      publicKey: 'pk',
      secretKey: 'sk',
      fetcher: makeFetcher({
        '/api/public/traces': {
          body: { data: [{ id: 't1' }, { id: 't2' }] },
        },
      }),
      logger,
    }
    const args = parseArgs(['--mode=count', '--min-traces=2'])
    const { exitCode } = await runCountMode(args, deps)
    expect(exitCode).toBe(0)
    expect(logger.errors).toHaveLength(0)
  })

  test('exit 1 when traces.length < min-traces', async () => {
    const logger = makeLogger()
    const deps: CheckDeps = {
      publicKey: 'pk',
      secretKey: 'sk',
      fetcher: makeFetcher({
        '/api/public/traces': { body: { data: [] } },
      }),
      logger,
    }
    const args = parseArgs(['--mode=count', '--min-traces=1'])
    const { exitCode } = await runCountMode(args, deps)
    expect(exitCode).toBe(1)
    expect(logger.errors.join('\n')).toMatch(/FAIL/)
  })

  test('exit 1 on HTTP error', async () => {
    const logger = makeLogger()
    const deps: CheckDeps = {
      publicKey: 'pk',
      secretKey: 'sk',
      fetcher: makeFetcher({
        '/api/public/traces': { ok: false, status: 401, statusText: 'Unauthorized', text: 'bad key' },
      }),
      logger,
    }
    const args = parseArgs(['--mode=count'])
    const { exitCode } = await runCountMode(args, deps)
    expect(exitCode).toBe(1)
    expect(logger.errors.join('\n')).toMatch(/401/)
  })
})

describe('runHierarchyMode', () => {
  test('happy path — eval.task root + eval.turn × N + ai.toolCall × M passes assertions', async () => {
    // Simulated session: gaia-med-cfg123-42 with one trace; trace has
    // 2 eval.turn spans + 3 ai.toolCall spans, all as observations on the
    // eval.task trace (root).
    const logger = makeLogger()
    const deps: CheckDeps = {
      publicKey: 'pk',
      secretKey: 'sk',
      fetcher: makeFetcher({
        '/api/public/sessions?fromTimestamp': {
          body: { data: [{ id: 'gaia-med-cfg123-42' }] },
        },
        '/api/public/traces?sessionId': {
          body: { data: [{ id: 'trace-a', name: 'eval.task' }] },
        },
        '/api/public/traces/trace-a': {
          body: {
            id: 'trace-a',
            name: 'eval.task',
            parentObservationId: null,
            observations: [
              { id: 'o1', name: 'eval.turn', type: 'SPAN' },
              { id: 'o2', name: 'eval.turn', type: 'SPAN' },
              // AI SDK tool spans land in Langfuse as type=TOOL with the
              // tool's own name (Langfuse renames via ai.toolCall.name attr).
              { id: 'o3', name: 'web_search', type: 'TOOL' },
              { id: 'o4', name: 'visit_webpage', type: 'TOOL' },
              { id: 'o5', name: 'web_search', type: 'TOOL' },
            ],
          },
        },
      }),
      logger,
    }
    const args = parseArgs([
      '--bench=gaia-med',
      '--expected-turns-min=2',
      '--expected-tool-calls-min=3',
    ])
    const { exitCode, summary } = await runHierarchyMode(args, deps)
    expect(summary.sessions).toBe(1)
    expect(summary.traces).toBe(1)
    expect(summary.rootTraces).toBe(1)
    expect(summary.nonRootTraces).toBe(0)
    expect(summary.evalTurnSpans).toBe(2)
    expect(summary.toolCallSpans).toBe(3)
    expect(exitCode).toBe(0)
  })

  test('exit 1 when no sessions match prefix', async () => {
    const logger = makeLogger()
    const deps: CheckDeps = {
      publicKey: 'pk',
      secretKey: 'sk',
      fetcher: makeFetcher({
        '/api/public/sessions': {
          body: { data: [{ id: 'unrelated-session' }] },
        },
      }),
      logger,
    }
    const args = parseArgs(['--bench=gaia-med'])
    const { exitCode } = await runHierarchyMode(args, deps)
    expect(exitCode).toBe(1)
    expect(logger.errors.join('\n')).toMatch(/no Langfuse sessions matched/)
  })

  test('exit 1 when eval.turn count < expected-turns-min', async () => {
    const logger = makeLogger()
    const deps: CheckDeps = {
      publicKey: 'pk',
      secretKey: 'sk',
      fetcher: makeFetcher({
        '/api/public/sessions': {
          body: { data: [{ id: 'lme-multiturn-abc-42' }] },
        },
        '/api/public/traces?sessionId': {
          body: { data: [{ id: 'tx' }] },
        },
        '/api/public/traces/tx': {
          body: {
            id: 'tx',
            name: 'eval.task',
            parentObservationId: null,
            observations: [{ id: 'o1', name: 'eval.turn' }],
          },
        },
      }),
      logger,
    }
    const args = parseArgs([
      '--bench=lme-multiturn',
      '--expected-turns-min=5',
    ])
    const { exitCode, summary } = await runHierarchyMode(args, deps)
    expect(summary.evalTurnSpans).toBe(1)
    expect(exitCode).toBe(1)
    expect(logger.errors.join('\n')).toMatch(/>= 5 eval\.turn spans, got 1/)
  })

  test('exit 1 when a trace is non-root (has parentObservationId)', async () => {
    const logger = makeLogger()
    const deps: CheckDeps = {
      publicKey: 'pk',
      secretKey: 'sk',
      fetcher: makeFetcher({
        '/api/public/sessions': {
          body: { data: [{ id: 'gaia-med-x-42' }] },
        },
        '/api/public/traces?sessionId': {
          body: { data: [{ id: 'tx' }] },
        },
        '/api/public/traces/tx': {
          body: {
            id: 'tx',
            name: 'eval.task',
            parentObservationId: 'some-parent-obs-id',
            observations: [{ id: 'o1', name: 'eval.turn' }],
          },
        },
      }),
      logger,
    }
    const args = parseArgs(['--bench=gaia-med'])
    const { exitCode, summary } = await runHierarchyMode(args, deps)
    expect(summary.nonRootTraces).toBe(1)
    expect(exitCode).toBe(1)
    expect(logger.errors.join('\n')).toMatch(/expected ALL traces to be roots/)
  })

  test('config_id + seed narrows session match to exact equality', async () => {
    const logger = makeLogger()
    const deps: CheckDeps = {
      publicKey: 'pk',
      secretKey: 'sk',
      fetcher: makeFetcher({
        '/api/public/sessions': {
          body: {
            data: [
              { id: 'gaia-med-cfg1-42' },
              { id: 'gaia-med-cfg2-42' },
              { id: 'gaia-med-cfg1-43' },
            ],
          },
        },
        '/api/public/traces?sessionId': {
          body: { data: [] },
        },
      }),
      logger,
    }
    const args = parseArgs([
      '--bench=gaia-med',
      '--config-id=cfg1',
      '--seed=42',
    ])
    const { summary } = await runHierarchyMode(args, deps)
    // Only gaia-med-cfg1-42 matches the exact (bench, config_id, seed) triple
    // — the other two sessions are filtered out by sessionMatches. The point
    // of this test is the FILTER, not the assertion outcome (with 0 expected
    // minimums + 0 traces, asserts all pass → exit 0).
    expect(summary.sessions).toBe(1)
    expect(summary.traces).toBe(0)
  })
})
