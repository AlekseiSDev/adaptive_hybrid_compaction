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
    { id: 'noop_ahc', ahc_flags: {} },
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

describe('default registries', () => {
  test('adapter registry resolves synthetic; throws on unknown bench', () => {
    const synth = defaultAdapterRegistry.resolve('synthetic')
    expect(synth.adapter.name).toBe('synthetic')
    expect(() => defaultAdapterRegistry.resolve('locomo-med')).toThrow(/not registered/)
  })

  test('runner registry resolves noop_baseline by `baseline` field and noop_ahc by `ahc_flags`', () => {
    const baseline = defaultRunnerRegistry.resolve({
      id: 'x',
      baseline: 'noop_baseline',
    })
    expect(baseline.name).toBe('noop_baseline')

    const ahc = defaultRunnerRegistry.resolve({ id: 'x', ahc_flags: {} })
    expect(ahc.name).toBe('noop_ahc')

    expect(() => defaultRunnerRegistry.resolve({ id: 'x' })).toThrow(/baseline or ahc_flags/)
    expect(() =>
      defaultRunnerRegistry.resolve({ id: 'x', baseline: 'unknown_baseline' }),
    ).toThrow(/unknown runner/)
  })
})
