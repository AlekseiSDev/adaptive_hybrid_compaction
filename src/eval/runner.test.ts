import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { context, trace } from '@opentelemetry/api'
import type { Attributes, Span, SpanOptions, Tracer } from '@opentelemetry/api'
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-node'
import {
  defaultAdapterRegistry,
  defaultRunnerRegistry,
  runSweep,
  type AdapterRegistry,
  type RunnerRegistry,
} from './runner.js'
import type { Runner, SweepPlan } from './types.js'
import { buildRunnerFromBaseline } from './baseline.js'

let workspace: string

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'ahc-runner-'))
})

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true })
})

const smokePlan: SweepPlan = {
  name: 'smoke',
  benches: ['synthetic'],
  configs: [
    { id: 'noop_baseline', baseline: 'noop_baseline' },
    // B5: `ahc_flags`-only configs now route to the real ahc_core runner.
    // Tests use the explicit stub to stay offline (no OPENROUTER_API_KEY).
    { id: 'noop_ahc', baseline: 'noop_ahc' },
  ],
  seeds: [42],
  budget_usd: 1,
}

describe('runSweep — lifecycle smoke (synthetic + stub runners)', () => {
  test('first run produces 2 records per config; meta + summary written', async () => {
    const result = await runSweep(smokePlan, defaultAdapterRegistry, defaultRunnerRegistry, {
      rootDir: workspace,
      gitSha: 'test-sha',
    })

    expect(result.configs).toHaveLength(2)
    for (const cfg of result.configs) {
      expect(cfg.bench).toBe('synthetic')
      expect(cfg.seed).toBe(42)
      expect(cfg.n_completed).toBe(2)
      expect(cfg.n_skipped).toBe(0)
      expect(cfg.config_id).toMatch(/^[0-9a-f]{16}$/)

      const ndjson = await readFile(join(cfg.runDir, 'records.ndjson'), 'utf8')
      expect(ndjson.trim().split('\n')).toHaveLength(2)

      expect(existsSync(join(cfg.runDir, 'meta.json'))).toBe(true)
      expect(existsSync(join(cfg.runDir, 'summary.json'))).toBe(true)

      const summary = JSON.parse(await readFile(join(cfg.runDir, 'summary.json'), 'utf8')) as {
        n_completed: number
        mean_primary_score: number
      }
      expect(summary.n_completed).toBe(2)
      // Stub runner echoes task.expected -> grader scores 1 on both -> mean = 1.
      expect(summary.mean_primary_score).toBe(1)
    }

    // Each config gets a distinct config_id directory.
    const ids = new Set(result.configs.map((c) => c.config_id))
    expect(ids.size).toBe(2)
  })

  test('records persist final_response_text — what the grader scored against', async () => {
    // Regression for "ну judge же на чем-то считается?" — pre-fix the response
    // text was passed to grader and to the OTel span but dropped from NDJSON.
    await runSweep(smokePlan, defaultAdapterRegistry, defaultRunnerRegistry, {
      rootDir: workspace,
      gitSha: 'test-sha',
    })
    const cfg = (
      await runSweep(smokePlan, defaultAdapterRegistry, defaultRunnerRegistry, {
        rootDir: workspace,
        gitSha: 'test-sha',
      })
    ).configs[0]
    if (!cfg) throw new Error('expected at least one config')
    const ndjson = await readFile(join(cfg.runDir, 'records.ndjson'), 'utf8')
    const records = ndjson
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { final_response_text?: string })
    expect(records).toHaveLength(2)
    for (const r of records) {
      const text = r.final_response_text
      expect(typeof text).toBe('string')
      expect((text ?? '').length).toBeGreaterThan(0)
    }
  })

  test('re-run on same rootDir is idempotent (skips completed task_ids)', async () => {
    await runSweep(smokePlan, defaultAdapterRegistry, defaultRunnerRegistry, {
      rootDir: workspace,
      gitSha: 'test-sha',
    })
    const second = await runSweep(smokePlan, defaultAdapterRegistry, defaultRunnerRegistry, {
      rootDir: workspace,
      gitSha: 'test-sha',
    })

    for (const cfg of second.configs) {
      expect(cfg.n_completed).toBe(0)
      expect(cfg.n_skipped).toBe(2)

      const ndjson = await readFile(join(cfg.runDir, 'records.ndjson'), 'utf8')
      // Line count unchanged from first run.
      expect(ndjson.trim().split('\n')).toHaveLength(2)
    }
  })

  test('forceCellsForConfigs wipes cells for named configs, leaves others intact', async () => {
    // Motivation: config_hash is computed from sweep YAML JSON only, not from
    // baseline source code. If algo code changes, hash stays same → resume
    // would silently merge new-code records with old-code records. --force=id
    // gives users an explicit "wipe and rerun THIS algo's cells" escape hatch.
    const first = await runSweep(
      smokePlan,
      defaultAdapterRegistry,
      defaultRunnerRegistry,
      { rootDir: workspace, gitSha: 'test-sha' },
    )
    expect(first.configs.every((c) => c.n_completed === 2)).toBe(true)

    const second = await runSweep(
      smokePlan,
      defaultAdapterRegistry,
      defaultRunnerRegistry,
      {
        rootDir: workspace,
        gitSha: 'test-sha',
        forceCellsForConfigs: new Set(['noop_ahc']),
      },
    )

    // Forced cell (noop_ahc) wiped → ran 2 tasks fresh, n_skipped=0.
    // Non-forced (noop_baseline) → all 2 task_ids in NDJSON, resume skips all.
    const ahcResult = second.configs.find((c) => c.n_completed === 2)
    const baselineResult = second.configs.find((c) => c.n_completed === 0)
    expect(ahcResult).toBeDefined()
    expect(baselineResult).toBeDefined()
    expect(ahcResult?.n_skipped).toBe(0)
    expect(baselineResult?.n_skipped).toBe(2)

    // The non-forced cell still has its original 2 records (file untouched).
    if (baselineResult) {
      const ndjson = await readFile(
        join(baselineResult.runDir, 'records.ndjson'),
        'utf8',
      )
      expect(ndjson.trim().split('\n')).toHaveLength(2)
    }
    // The forced cell has fresh 2 records (not 4 = appended).
    if (ahcResult) {
      const ndjson = await readFile(
        join(ahcResult.runDir, 'records.ndjson'),
        'utf8',
      )
      expect(ndjson.trim().split('\n')).toHaveLength(2)
    }
  })

  test('forceCellsForConfigs with id not in plan is a no-op', async () => {
    await runSweep(smokePlan, defaultAdapterRegistry, defaultRunnerRegistry, {
      rootDir: workspace,
      gitSha: 'test-sha',
    })
    const second = await runSweep(
      smokePlan,
      defaultAdapterRegistry,
      defaultRunnerRegistry,
      {
        rootDir: workspace,
        gitSha: 'test-sha',
        forceCellsForConfigs: new Set(['does_not_exist']),
      },
    )
    for (const cfg of second.configs) {
      expect(cfg.n_completed).toBe(0)
      expect(cfg.n_skipped).toBe(2)
    }
  })
})

describe('runSweep — Instrumentation aggregation (B2)', () => {
  test('events emitted via ctx.instrumentation are merged into TurnRecord by turn_index', async () => {
    const customAdapter: AdapterRegistry = {
      resolve: () => ({
        adapter: {
          name: 'synthetic',
          loadTasks: () => Promise.resolve([{ id: 'tsk-1', input: 'x', expected: 'y' }]),
          prepare: (task) => ({
            messages: [{ role: 'user', content: [{ type: 'text', text: String(task.input) }] }],
          }),
        },
        grader: { score: () => Promise.resolve({ primary: 1 }) },
      }),
    }
    const customRunner: RunnerRegistry = {
      resolve: () => ({
        name: 'emit',
        execute: (_conv, ctx) => {
          ctx.instrumentation?.({
            kind: 'compaction',
            payload: { type: 'offload', turn_index: 0, before_bytes: 1000, after_bytes: 200 },
          })
          ctx.instrumentation?.({
            kind: 'class_signal',
            turn_index: 0,
            class: 'tool_heavy',
            confidence: 0.85,
          })
          return Promise.resolve({
            text: 'y',
            turns: [
              {
                turn_index: 0,
                input_tokens: 10,
                output_tokens: 5,
                wall_clock_ms: 1,
                recall_events: [],
                compaction_events: [],
              },
            ],
            errors: [],
            totals: { input: 10, output: 5 },
            cost_usd: 0.01,
          })
        },
      }),
    }
    const plan: SweepPlan = {
      name: 'instr-test',
      benches: ['synthetic'],
      configs: [{ id: 'emit', baseline: 'emit' }],
      seeds: [0],
      budget_usd: 10,
    }
    const result = await runSweep(plan, customAdapter, customRunner, {
      rootDir: workspace,
      gitSha: 't',
    })
    const cfg = result.configs[0]
    expect(cfg).toBeDefined()
    if (!cfg) return
    const ndjson = await readFile(join(cfg.runDir, 'records.ndjson'), 'utf8')
    const lines = ndjson.trim().split('\n')
    expect(lines).toHaveLength(1)
    const record = JSON.parse(lines[0] ?? '') as {
      turns: {
        compaction_events: { type: string }[]
        class_signal?: { class: string; confidence: number }
      }[]
    }
    expect(record.turns[0]?.compaction_events).toHaveLength(1)
    expect(record.turns[0]?.compaction_events[0]?.type).toBe('offload')
    expect(record.turns[0]?.class_signal).toEqual({ class: 'tool_heavy', confidence: 0.85 })
  })

  // Regression: H Phase 8 (2026-05-22). AHC core baselines populate their
  // own TurnRecord.compaction_events (PATH A) AND emit the same events via
  // ctx.instrumentation for trace correlation (PATH B). Pre-fix runner
  // unconditionally merged both streams, double-counting every observer event
  // (audit cells showed 2× true density). Fix: if turn already carries events,
  // trust them and ignore instrumentation re-aggregation for that field.
  test('events present in both TurnRecord and instrumentation are not double-counted', async () => {
    const adapter: AdapterRegistry = {
      resolve: () => ({
        adapter: {
          name: 'synthetic',
          loadTasks: () => Promise.resolve([{ id: 'tsk-1', input: 'x', expected: 'y' }]),
          prepare: (task) => ({
            messages: [{ role: 'user', content: [{ type: 'text', text: String(task.input) }] }],
          }),
        },
        grader: { score: () => Promise.resolve({ primary: 1 }) },
      }),
    }
    const runnerReg: RunnerRegistry = {
      resolve: () => ({
        name: 'emit',
        execute: (_conv, ctx) => {
          const obsEvent = {
            kind: 'compaction' as const,
            payload: {
              type: 'observer' as const,
              turn_index: 0,
              before_bytes: 30000,
              after_bytes: 6000,
            },
          }
          ctx.instrumentation?.(obsEvent)
          return Promise.resolve({
            text: 'y',
            turns: [
              {
                turn_index: 0,
                input_tokens: 10,
                output_tokens: 5,
                wall_clock_ms: 1,
                recall_events: [],
                compaction_events: [obsEvent.payload],
              },
            ],
            errors: [],
            totals: { input: 10, output: 5 },
            cost_usd: 0.01,
          })
        },
      }),
    }
    const plan: SweepPlan = {
      name: 'no-dup',
      benches: ['synthetic'],
      configs: [{ id: 'emit', baseline: 'emit' }],
      seeds: [0],
      budget_usd: 10,
    }
    const result = await runSweep(plan, adapter, runnerReg, { rootDir: workspace, gitSha: 't' })
    const cfg = result.configs[0]
    expect(cfg).toBeDefined()
    if (!cfg) return
    const ndjson = await readFile(join(cfg.runDir, 'records.ndjson'), 'utf8')
    const record = JSON.parse(ndjson.trim()) as {
      turns: { compaction_events: { type: string }[] }[]
    }
    expect(record.turns[0]?.compaction_events).toHaveLength(1)
    expect(record.turns[0]?.compaction_events[0]?.type).toBe('observer')
  })
})

describe('runSweep — CostTracker halt (B2)', () => {
  test('high cost_usd triggers halt after 20 tasks; subsequent tasks not executed', async () => {
    let executions = 0
    // Adapter returns 30 tasks; with 1 config, total_tasks = 30.
    const adapter: AdapterRegistry = {
      resolve: () => ({
        adapter: {
          name: 'synthetic',
          loadTasks: () =>
            Promise.resolve(
              Array.from({ length: 30 }, (_, i) => ({
                id: 't' + String(i),
                input: 'x',
                expected: 'y',
              })),
            ),
          prepare: (task) => ({
            messages: [{ role: 'user', content: [{ type: 'text', text: String(task.input) }] }],
          }),
        },
        grader: { score: () => Promise.resolve({ primary: 1 }) },
      }),
    }
    // Each task costs $5; budget=$1; total_tasks=30; mean=$5; projected=$150 > 1.5×1=1.5 → halt at 20.
    const runner: RunnerRegistry = {
      resolve: () => ({
        name: 'expensive',
        execute: () => {
          executions += 1
          return Promise.resolve({
            text: 'y',
            turns: [],
            errors: [],
            totals: { input: 0, output: 0 },
            cost_usd: 5,
          })
        },
      }),
    }
    const plan: SweepPlan = {
      name: 'halt-test',
      benches: ['synthetic'],
      configs: [{ id: 'exp', baseline: 'expensive' }],
      seeds: [0],
      budget_usd: 1,
    }
    const result = await runSweep(plan, adapter, runner, {
      rootDir: workspace,
      gitSha: 't',
    })
    expect(result.halted).toBe(true)
    expect(result.halt_reason).toContain('projected')
    // Halt fires when shouldHalt first returns true — task_count must reach 20 before check.
    // So executions == 20 (the 20th task triggers the halt; no 21st).
    expect(executions).toBe(20)
    expect(result.total_cost_usd).toBe(100)
  })
})

describe('runSweep — per-task OTel spans (B5)', () => {
  test('emits eval.task span per task with langfuse input/output attrs', async () => {
    type RecordedSpan = {
      name: string
      attributes: Attributes
      ended: boolean
    }
    const spans: RecordedSpan[] = []
    const fakeTracer = {
      startSpan: (name: string, options?: SpanOptions) => {
        const recorded: RecordedSpan = {
          name,
          attributes: { ...(options?.attributes ?? {}) },
          ended: false,
        }
        spans.push(recorded)
        const fakeSpan: Partial<Span> = {
          setAttribute: (key, value) => {
            recorded.attributes[key] = value
            return fakeSpan as Span
          },
          setAttributes: (attrs) => {
            Object.assign(recorded.attributes, attrs)
            return fakeSpan as Span
          },
          setStatus: () => fakeSpan as Span,
          recordException: () => undefined,
          end: () => {
            recorded.ended = true
          },
        }
        return fakeSpan as Span
      },
      // Not used by runSweep, but Tracer interface requires it.
      startActiveSpan: () => {
        throw new Error('startActiveSpan not used in runSweep')
      },
    } as unknown as Tracer
    const result = await runSweep(
      smokePlan,
      defaultAdapterRegistry,
      defaultRunnerRegistry,
      { rootDir: workspace, gitSha: 't', tracer: fakeTracer },
    )
    expect(result.configs).toHaveLength(2)
    // smokePlan has 2 configs × 2 synthetic tasks = 4 eval.task spans
    expect(spans).toHaveLength(4)
    for (const s of spans) {
      expect(s.name).toBe('eval.task')
      expect(s.ended).toBe(true)
      expect(s.attributes['task.id']).toMatch(/^syn-\d{3}$/)
      expect(s.attributes['bench']).toBe('synthetic')
      expect(typeof s.attributes['config_id']).toBe('string')
      expect(s.attributes['langfuse.observation.input']).toBeTypeOf('string')
      // Stub baseline echoes task.expected → output is the assistant text
      expect(s.attributes['langfuse.observation.output']).toBeTypeOf('string')
    }
  })
})

describe('runSweep — B6 Langfuse session/trace hierarchy', () => {
  test('eval.task is root trace (parentSpanContext undefined) + langfuse.session.id matches ${bench}-${config_id}-${seed}', async () => {
    // B6 inverts B5: previously eval.task was a CHILD of eval.sweep, which made
    // Langfuse see one giant trace per sweep. B6 cuts the parent link so each
    // eval.task is its own root trace, and adds langfuse.session.id so Langfuse
    // groups traces of the same (bench × config × seed) cell into one session.
    const exporter = new InMemorySpanExporter()
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    })
    const tracer = provider.getTracer('test-b6')

    const result = await runSweep(
      smokePlan,
      defaultAdapterRegistry,
      defaultRunnerRegistry,
      { rootDir: workspace, gitSha: 'test-sha', tracer },
    )

    const taskSpans = exporter
      .getFinishedSpans()
      .filter((s) => s.name === 'eval.task')
    // smokePlan: 2 configs × 2 synthetic tasks × 1 seed = 4 spans.
    expect(taskSpans).toHaveLength(4)

    const expectedSessionIds = new Set(
      result.configs.map((c) => `${c.bench}-${c.config_id}-${String(c.seed)}`),
    )

    for (const span of taskSpans) {
      // Root trace: no parent. parentSpanContext is OTel 2.x property
      // (replaces older parentSpanId). Both should resolve undefined.
      const parentCtx = (span as unknown as { parentSpanContext?: unknown })
        .parentSpanContext
      expect(parentCtx).toBeUndefined()
      // langfuse.session.id present and matches one of the expected cells.
      const sessionId = span.attributes['langfuse.session.id']
      expect(typeof sessionId).toBe('string')
      expect(expectedSessionIds.has(String(sessionId))).toBe(true)
    }

    await provider.shutdown()
  })

  test('eval.task spans of different (config_id, seed) cells get distinct session.id', async () => {
    const exporter = new InMemorySpanExporter()
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    })
    const tracer = provider.getTracer('test-b6')

    await runSweep(smokePlan, defaultAdapterRegistry, defaultRunnerRegistry, {
      rootDir: workspace,
      gitSha: 'test-sha',
      tracer,
    })

    const taskSpans = exporter
      .getFinishedSpans()
      .filter((s) => s.name === 'eval.task')
    const sessionIds = new Set(
      taskSpans.map((s) => String(s.attributes['langfuse.session.id'])),
    )
    // 2 configs × 1 seed = 2 distinct sessions; both task spans in each cell
    // share the same session.id.
    expect(sessionIds.size).toBe(2)

    await provider.shutdown()
  })

  test('eval.turn spans are emitted as children of eval.task (multi-turn synthesis)', async () => {
    // Custom 3-message conv via custom adapter + simple baseline that echoes.
    // Verifies buildRunnerFromBaseline wraps each baseline.step in eval.turn
    // span with the correct turn.index attribute, parented to eval.task.
    //
    // NodeTracerProvider (vs BasicTracerProvider used in sibling tests) is
    // required here because AsyncLocalStorageContextManager — installed by
    // provider.register() — is what makes context.with(trace.setSpan(...))
    // actually propagate the active span. Without it, startActiveSpan
    // inside baseline.ts can't find a parent. Cleanup: shutdown + disable
    // the globals.
    const exporter = new InMemorySpanExporter()
    const provider = new NodeTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    })
    provider.register()
    const tracer = provider.getTracer('test-b6')

    const adapter: AdapterRegistry = {
      resolve: () => ({
        adapter: {
          name: 'synthetic',
          loadTasks: () =>
            Promise.resolve([{ id: 'mt-1', input: 'x', expected: 'y' }]),
          prepare: (_task) => ({
            messages: [
              { role: 'user', content: [{ type: 'text', text: 'q1' }] },
              { role: 'user', content: [{ type: 'text', text: 'q2' }] },
              { role: 'user', content: [{ type: 'text', text: 'q3' }] },
            ],
          }),
        },
        grader: { score: () => Promise.resolve({ primary: 1 }) },
      }),
    }
    // Real baseline via buildRunnerFromBaseline — uses eval.turn wrapper.
    const runnerReg: RunnerRegistry = {
      resolve: (): Runner => {
        let stepIdx = 0
        return buildRunnerFromBaseline({
          name: 'mock-mt',
          prepare: (task) => ({ task_id: task.id, history: [] }),
          step: (state, userMsg) => {
            const idx = stepIdx
            stepIdx += 1
            return Promise.resolve({
              response: {
                role: 'assistant' as const,
                content: [{ type: 'text' as const, text: `a${String(idx)}` }],
              },
              state: { ...state, history: [...state.history, userMsg] },
              telemetry: {
                turn_index: idx,
                input_tokens: 1,
                output_tokens: 1,
                wall_clock_ms: 0,
                recall_events: [],
                compaction_events: [],
              },
              cost_usd: 0,
            })
          },
        })
      },
    }
    const plan: SweepPlan = {
      name: 'b6-mt',
      benches: ['synthetic'],
      configs: [{ id: 'mt', baseline: 'mock-mt' }],
      seeds: [0],
      budget_usd: 10,
    }
    await runSweep(plan, adapter, runnerReg, {
      rootDir: workspace,
      gitSha: 't',
      tracer,
    })

    const allSpans = exporter.getFinishedSpans()
    const taskSpan = allSpans.find((s) => s.name === 'eval.task')
    const turnSpans = allSpans
      .filter((s) => s.name === 'eval.turn')
      .sort(
        (a, b) =>
          Number(a.attributes['turn.index'] ?? 0) -
          Number(b.attributes['turn.index'] ?? 0),
      )

    expect(taskSpan).toBeDefined()
    expect(turnSpans).toHaveLength(3)
    expect(turnSpans.map((s) => s.attributes['turn.index'])).toEqual([0, 1, 2])

    // Each eval.turn span is a child of the eval.task span (OTel context
    // propagation through context.with(trace.setSpan(...))).
    const taskSpanId = taskSpan?.spanContext().spanId
    for (const turn of turnSpans) {
      const parentId = (
        turn as unknown as { parentSpanContext?: { spanId: string } }
      ).parentSpanContext?.spanId
      expect(parentId).toBe(taskSpanId)
    }

    await provider.shutdown()
    trace.disable()
    context.disable()
  })
})

describe('runSweep — dry-run mode (E0)', () => {
  test('dryRun:{nTasksPerCell:1} caps each cell, writes no NDJSON / meta / summary', async () => {
    const result = await runSweep(smokePlan, defaultAdapterRegistry, defaultRunnerRegistry, {
      rootDir: workspace,
      dryRun: { nTasksPerCell: 1 },
    })
    expect(result.configs).toHaveLength(2)
    for (const cfg of result.configs) {
      // Cell capped at 1 task (synthetic has 2 by default).
      expect(cfg.n_completed).toBe(1)
      // No persistence anywhere.
      expect(existsSync(join(cfg.runDir, 'records.ndjson'))).toBe(false)
      expect(existsSync(join(cfg.runDir, 'meta.json'))).toBe(false)
      expect(existsSync(join(cfg.runDir, 'summary.json'))).toBe(false)
    }
    // Cost tracking still in-memory.
    expect(result.total_cost_usd).toBeGreaterThanOrEqual(0)
    expect(result.halted).toBe(false)
  })

  test('dryRun also bypasses resume — second run is not affected by phantom NDJSON', async () => {
    // First write some real records via non-dry-run.
    await runSweep(smokePlan, defaultAdapterRegistry, defaultRunnerRegistry, {
      rootDir: workspace,
    })
    // Now dry-run on same rootDir — should not skip (because dry-run ignores
    // existing NDJSON and runs from scratch up to nTasksPerCell).
    const dryResult = await runSweep(smokePlan, defaultAdapterRegistry, defaultRunnerRegistry, {
      rootDir: workspace,
      dryRun: { nTasksPerCell: 2 },
    })
    for (const cfg of dryResult.configs) {
      expect(cfg.n_completed).toBe(2)
      expect(cfg.n_skipped).toBe(0)
    }
  })
})

describe('runSweep — concurrency + maxTasksPerCell (E1)', () => {
  test('concurrency=1 preserves sequential semantics: NDJSON ordering deterministic', async () => {
    const result = await runSweep(smokePlan, defaultAdapterRegistry, defaultRunnerRegistry, {
      rootDir: workspace,
      concurrency: 1,
    })
    for (const cfg of result.configs) {
      const ndjson = await readFile(join(cfg.runDir, 'records.ndjson'), 'utf8')
      const lines = ndjson.trim().split('\n')
      const ids = lines.map((l) => (JSON.parse(l) as { task_id: string }).task_id)
      // Synthetic adapter yields stable task ordering; with conc=1 record
      // appends mirror that order exactly.
      expect(ids).toEqual(ids.slice().sort())
    }
  })

  test('concurrency=2 runs chunks in parallel: wall-clock is shorter than sequential', async () => {
    // Use a slow synthetic runner via custom registry to make parallelism
    // observable. Each task sleeps 100ms; with conc=2 over 2 tasks the chunk
    // takes ~100ms, vs ~200ms for conc=1.
    const slowRunners: RunnerRegistry = {
      resolve: () => ({
        name: 'slow-stub',
        execute: async (_conv, ctx) => {
          await new Promise((r) => setTimeout(r, 100))
          return {
            text: ctx.task.expected as string,
            turns: [],
            errors: [],
            totals: { input: 0, output: 0 },
            cost_usd: 0.0001,
          }
        },
      }),
    }
    const firstCfg = smokePlan.configs[0]
    if (firstCfg === undefined) throw new Error('smokePlan.configs[0] missing')
    const t0 = Date.now()
    await runSweep(
      { ...smokePlan, configs: [firstCfg] },
      defaultAdapterRegistry,
      slowRunners,
      { rootDir: workspace, concurrency: 2 },
    )
    const dur = Date.now() - t0
    // 2 tasks @ 100ms each in chunk → ~100ms wall-clock. Add slack for FS.
    expect(dur).toBeLessThan(180)
  })

  test('maxTasksPerCell caps live runs and persists (unlike dryRun)', async () => {
    const result = await runSweep(smokePlan, defaultAdapterRegistry, defaultRunnerRegistry, {
      rootDir: workspace,
      maxTasksPerCell: 1,
    })
    for (const cfg of result.configs) {
      expect(cfg.n_completed).toBe(1)
      // Live cap = persistence happens.
      expect(existsSync(join(cfg.runDir, 'records.ndjson'))).toBe(true)
      expect(existsSync(join(cfg.runDir, 'summary.json'))).toBe(true)
      const ndjson = await readFile(join(cfg.runDir, 'records.ndjson'), 'utf8')
      expect(ndjson.trim().split('\n')).toHaveLength(1)
    }
  })

  test('maxTasksPerCell + auto-resume: rerunning without cap completes remaining tasks', async () => {
    // First pass: mini-smoke caps at 1.
    await runSweep(smokePlan, defaultAdapterRegistry, defaultRunnerRegistry, {
      rootDir: workspace,
      maxTasksPerCell: 1,
    })
    // Second pass: no cap. Auto-resume skips the 1 already done and runs the
    // remaining 1 (synthetic has 2 tasks). End state: 2 total per cell.
    const second = await runSweep(smokePlan, defaultAdapterRegistry, defaultRunnerRegistry, {
      rootDir: workspace,
    })
    for (const cfg of second.configs) {
      expect(cfg.n_completed).toBe(1)
      expect(cfg.n_skipped).toBe(1)
      const ndjson = await readFile(join(cfg.runDir, 'records.ndjson'), 'utf8')
      expect(ndjson.trim().split('\n')).toHaveLength(2)
    }
  })
})

describe('default registries', () => {
  test('adapter registry resolves synthetic; throws on unknown bench', () => {
    const synth = defaultAdapterRegistry.resolve('synthetic')
    expect(synth.adapter.name).toBe('synthetic')
    // D5 wired locomo-med + tau-bench-retail-med + longmemeval-med. Use an
    // explicitly-unknown literal cast to exercise the throw path.
    expect(() =>
      defaultAdapterRegistry.resolve('fake-bench-unknown' as unknown as 'synthetic'),
    ).toThrow(/not registered/)
  })

  test('runner registry: baseline:noop_baseline resolves stub; ahc_flags{} routes to ahc_core (B5)', () => {
    const baseline = defaultRunnerRegistry.resolve({
      id: 'x',
      baseline: 'noop_baseline',
    })
    expect(baseline.name).toBe('noop_baseline')

    // Explicit baseline:noop_ahc still resolves to the offline stub.
    const explicitNoop = defaultRunnerRegistry.resolve({ id: 'x', baseline: 'noop_ahc' })
    expect(explicitNoop.name).toBe('noop_ahc')

    // B5: `ahc_flags`-only routes to the real ahc_core runner. Without
    // OPENROUTER_API_KEY the factory throws — assert that path is taken.
    // 2026-05-27: error now surfaces from resolveLLMClient (dual-mode
    // routing) → message mentions `openrouter/` prefix instead of `ahc_core`.
    const prevKey = process.env['OPENROUTER_API_KEY']
    delete process.env['OPENROUTER_API_KEY']
    try {
      expect(() => defaultRunnerRegistry.resolve({ id: 'x', ahc_flags: {} })).toThrow(
        /OPENROUTER_API_KEY.*openrouter\//,
      )
    } finally {
      if (prevKey !== undefined) process.env['OPENROUTER_API_KEY'] = prevKey
    }

    expect(() => defaultRunnerRegistry.resolve({ id: 'x' })).toThrow(/baseline or ahc_flags/)
    expect(() =>
      defaultRunnerRegistry.resolve({ id: 'x', baseline: 'unknown_baseline' }),
    ).toThrow(/unknown runner/)
  })

  test('runner registry: provider:anthropic_direct requires LITELLM_* or ANTHROPIC_API_KEY (E1)', () => {
    // ahc_core with provider:'anthropic_direct' accepts either LiteLLM
    // forwarder (LITELLM_MASTER_KEY + LITELLM_BASE_URL) OR direct
    // ANTHROPIC_API_KEY. With all three missing, error message names both
    // auth paths.
    const prev = {
      OR: process.env['OPENROUTER_API_KEY'],
      AN: process.env['ANTHROPIC_API_KEY'],
      LK: process.env['LITELLM_MASTER_KEY'],
      LU: process.env['LITELLM_BASE_URL'],
    }
    delete process.env['OPENROUTER_API_KEY']
    delete process.env['ANTHROPIC_API_KEY']
    delete process.env['LITELLM_MASTER_KEY']
    delete process.env['LITELLM_BASE_URL']
    try {
      expect(() =>
        defaultRunnerRegistry.resolve({
          id: 'x',
          ahc_flags: {},
          provider: 'anthropic_direct',
        }),
      ).toThrow(/provider=anthropic_direct.*LITELLM_MASTER_KEY.*ANTHROPIC_API_KEY/s)
    } finally {
      for (const [k, v] of Object.entries({
        OPENROUTER_API_KEY: prev.OR,
        ANTHROPIC_API_KEY: prev.AN,
        LITELLM_MASTER_KEY: prev.LK,
        LITELLM_BASE_URL: prev.LU,
      })) {
        if (v !== undefined) process.env[k] = v
      }
    }
  })

  test('runner registry: provider:anthropic_direct accepts LITELLM_* (forwarder, preferred path) (E1)', () => {
    // When LITELLM_* are set, the runner factory builds without throwing.
    // We can't easily assert which auth path was taken from the outside, but
    // resolving without throw is the signal that LITELLM_* were honored
    // (ANTHROPIC_API_KEY is also deleted).
    const prev = {
      AN: process.env['ANTHROPIC_API_KEY'],
      LK: process.env['LITELLM_MASTER_KEY'],
      LU: process.env['LITELLM_BASE_URL'],
    }
    delete process.env['ANTHROPIC_API_KEY']
    process.env['LITELLM_MASTER_KEY'] = 'test-litellm-key'
    process.env['LITELLM_BASE_URL'] = 'http://localhost:4400'
    try {
      const runner = defaultRunnerRegistry.resolve({
        id: 'x',
        ahc_flags: {},
        provider: 'anthropic_direct',
      })
      expect(runner.name).toBeTypeOf('string')
    } finally {
      if (prev.AN !== undefined) process.env['ANTHROPIC_API_KEY'] = prev.AN
      if (prev.LK !== undefined) process.env['LITELLM_MASTER_KEY'] = prev.LK
      else delete process.env['LITELLM_MASTER_KEY']
      if (prev.LU !== undefined) process.env['LITELLM_BASE_URL'] = prev.LU
      else delete process.env['LITELLM_BASE_URL']
    }
  })

  test('runner registry: provider:anthropic_direct falls back to ANTHROPIC_API_KEY when LITELLM_* missing (E1)', () => {
    const prev = {
      AN: process.env['ANTHROPIC_API_KEY'],
      LK: process.env['LITELLM_MASTER_KEY'],
      LU: process.env['LITELLM_BASE_URL'],
    }
    delete process.env['LITELLM_MASTER_KEY']
    delete process.env['LITELLM_BASE_URL']
    process.env['ANTHROPIC_API_KEY'] = 'test-direct-key'
    try {
      const runner = defaultRunnerRegistry.resolve({
        id: 'x',
        ahc_flags: {},
        provider: 'anthropic_direct',
      })
      expect(runner.name).toBeTypeOf('string')
    } finally {
      if (prev.AN !== undefined) process.env['ANTHROPIC_API_KEY'] = prev.AN
      else delete process.env['ANTHROPIC_API_KEY']
      if (prev.LK !== undefined) process.env['LITELLM_MASTER_KEY'] = prev.LK
      if (prev.LU !== undefined) process.env['LITELLM_BASE_URL'] = prev.LU
    }
  })

  test('runner registry: provider:openrouter explicit still reads OPENROUTER_API_KEY (E0 default)', () => {
    // 2026-05-27 dual-mode: provider=openrouter ensures the model id carries
    // the `openrouter/` prefix → resolveLLMClient demands OPENROUTER_API_KEY.
    const prevOR = process.env['OPENROUTER_API_KEY']
    delete process.env['OPENROUTER_API_KEY']
    try {
      expect(() =>
        defaultRunnerRegistry.resolve({
          id: 'x',
          ahc_flags: {},
          provider: 'openrouter',
        }),
      ).toThrow(/OPENROUTER_API_KEY.*openrouter\//)
    } finally {
      if (prevOR !== undefined) process.env['OPENROUTER_API_KEY'] = prevOR
    }
  })
})
