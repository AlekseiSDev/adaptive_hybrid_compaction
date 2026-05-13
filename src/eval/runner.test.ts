import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Attributes, Span, SpanOptions, Tracer } from '@opentelemetry/api'
import {
  defaultAdapterRegistry,
  defaultRunnerRegistry,
  runSweep,
  type AdapterRegistry,
  type RunnerRegistry,
} from './runner.js'
import type { SweepPlan } from './types.js'

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
    const prevKey = process.env['OPENROUTER_API_KEY']
    delete process.env['OPENROUTER_API_KEY']
    try {
      expect(() => defaultRunnerRegistry.resolve({ id: 'x', ahc_flags: {} })).toThrow(
        /ahc_core.*OPENROUTER_API_KEY/,
      )
    } finally {
      if (prevKey !== undefined) process.env['OPENROUTER_API_KEY'] = prevKey
    }

    expect(() => defaultRunnerRegistry.resolve({ id: 'x' })).toThrow(/baseline or ahc_flags/)
    expect(() =>
      defaultRunnerRegistry.resolve({ id: 'x', baseline: 'unknown_baseline' }),
    ).toThrow(/unknown runner/)
  })

  test('runner registry: provider:anthropic_direct dispatches to ANTHROPIC_API_KEY env var (E0)', () => {
    // ahc_core with provider:'anthropic_direct' reads ANTHROPIC_API_KEY, not
    // OPENROUTER_API_KEY. With both missing, error message mentions the
    // anthropic-specific env name.
    const prevOR = process.env['OPENROUTER_API_KEY']
    const prevAN = process.env['ANTHROPIC_API_KEY']
    delete process.env['OPENROUTER_API_KEY']
    delete process.env['ANTHROPIC_API_KEY']
    try {
      expect(() =>
        defaultRunnerRegistry.resolve({
          id: 'x',
          ahc_flags: {},
          provider: 'anthropic_direct',
        }),
      ).toThrow(/provider=anthropic_direct.*ANTHROPIC_API_KEY/)
    } finally {
      if (prevOR !== undefined) process.env['OPENROUTER_API_KEY'] = prevOR
      if (prevAN !== undefined) process.env['ANTHROPIC_API_KEY'] = prevAN
    }
  })

  test('runner registry: provider:openrouter explicit still reads OPENROUTER_API_KEY (E0 default)', () => {
    const prevOR = process.env['OPENROUTER_API_KEY']
    delete process.env['OPENROUTER_API_KEY']
    try {
      expect(() =>
        defaultRunnerRegistry.resolve({
          id: 'x',
          ahc_flags: {},
          provider: 'openrouter',
        }),
      ).toThrow(/provider=openrouter.*OPENROUTER_API_KEY/)
    } finally {
      if (prevOR !== undefined) process.env['OPENROUTER_API_KEY'] = prevOR
    }
  })
})
