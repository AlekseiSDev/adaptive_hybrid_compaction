import { describe, expect, test } from 'vitest'
import type {
  Bench,
  BenchAdapter,
  CompactionEvent,
  ConfigDef,
  Conversation,
  ErrorRecord,
  Grader,
  RecallEvent,
  RunMeta,
  RunRecord,
  RunSummary,
  Runner,
  RunnerContext,
  RunnerResponse,
  Score,
  SweepConfig,
  SweepPlan,
  Task,
  TokenUsage,
  TurnRecord,
  WorkUnit,
} from './types.js'

describe('Eval harness types — compile-time witness', () => {
  test('telemetry schema (§3) instantiates with documented fields', () => {
    const bench: Bench = 'synthetic'

    const score: Score = {
      primary: 0.85,
      secondary: { f1: 0.9 },
      judge_explanation: 'matches expected',
    }

    const totals: TokenUsage = {
      input: 1200,
      output: 200,
      cache_read: 0,
      cache_creation: 0,
    }

    const recallEvent: RecallEvent = {
      recall_id: 'r_1',
      tool_name: 'search',
      reason: 'need full result for citation',
      turn_index: 3,
    }

    const compactionEvent: CompactionEvent = {
      type: 'offload',
      turn_index: 2,
      before_bytes: 8192,
      after_bytes: 128,
      llm_cost_usd: 0.0001,
    }

    const turn: TurnRecord = {
      turn_index: 0,
      input_tokens: 1000,
      output_tokens: 100,
      cache_read_input_tokens: 500,
      cache_creation_input_tokens: 0,
      wall_clock_ms: 1200,
      ttfb_ms: 250,
      class_signal: { class: 'tool_heavy', confidence: 0.8 },
      recall_events: [recallEvent],
      compaction_events: [compactionEvent],
    }

    const error: ErrorRecord = {
      turn_index: 1,
      kind: 'api_error',
      message: 'rate limited',
    }

    const record: RunRecord = {
      run_id: 'r_abc',
      bench,
      config_id: '0123456789abcdef',
      seed: 42,
      task_id: 'syn-001',
      started_at: 1_000,
      completed_at: 2_000,
      score,
      totals,
      cost_usd: 0.0012,
      turns: [turn],
      errors: [error],
    }

    expect(record.bench).toBe('synthetic')
    expect(record.turns[0]?.recall_events).toHaveLength(1)
    expect(record.turns[0]?.compaction_events[0]?.type).toBe('offload')
  })

  test('harness-side interfaces (Task / BenchAdapter / Grader / Runner) wire together', () => {
    const task: Task = { id: 't_1', input: 'hello', expected: 'world' }

    const conv: Conversation = {
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    }

    const config: ConfigDef = { id: 'noop_baseline', baseline: 'noop_baseline' }

    const ctx: RunnerContext = { bench: 'synthetic', config, seed: 42, task }

    const response: RunnerResponse = {
      text: 'world',
      turns: [],
      errors: [],
      totals: { input: 0, output: 0 },
      cost_usd: 0,
    }

    const adapter: BenchAdapter = {
      name: 'synthetic',
      loadTasks: (_seed) => Promise.resolve([task]),
      prepare: (_t) => conv,
    }

    const grader: Grader = {
      score: (t, r) => ({ primary: r.text === t.expected ? 1 : 0 }),
    }

    const runner: Runner = {
      name: 'noop_baseline',
      execute: (_c, _ctxArg) => Promise.resolve(response),
    }

    expect(adapter.name).toBe('synthetic')
    expect(grader.score(task, response).primary).toBe(1)
    expect(runner.name).toBe('noop_baseline')
    expect(ctx.seed).toBe(42)
  })

  test('SweepConfig + ConfigDef + WorkUnit + RunMeta + RunSummary shape', () => {
    const config: ConfigDef = { id: 'ahc_full', ahc_flags: { TASK_AWARE_EXTRACTION: true } }

    const sweep: SweepConfig = {
      name: 'smoke',
      benches: ['synthetic'],
      configs: [config],
      seeds: [42],
      budget_usd: 1,
    }

    const plan: SweepPlan = sweep

    const work: WorkUnit = {
      bench: 'synthetic',
      config,
      seed: 42,
      task: { id: 't', input: null, expected: null },
    }

    const meta: RunMeta = {
      config,
      bench: 'synthetic',
      seed: 42,
      git_sha: 'abc123',
      timestamp: new Date(0).toISOString(),
    }

    const summary: RunSummary = {
      bench: 'synthetic',
      config_id: '0123456789abcdef',
      seed: 42,
      n_total: 2,
      n_completed: 2,
      mean_primary_score: 1,
      total_cost_usd: 0,
    }

    expect(plan.budget_usd).toBe(1)
    expect(work.config.id).toBe('ahc_full')
    expect(meta.git_sha).toBe('abc123')
    expect(summary.n_completed).toBe(2)
  })
})
