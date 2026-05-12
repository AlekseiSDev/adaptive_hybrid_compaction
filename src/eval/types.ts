// Eval harness types. Source of truth: docs/design/B_eval-harness.md §3.
// Field renames or removals require a docs/decisions.md entry.

import type { Message, TrajectoryClass } from '../core/index.js'

// Re-export core types so eval-side modules import a single surface
// (`./types.js`). Avoids cross-module drift if core paths change.
export type { Message, TrajectoryClass }

// §3 union extended with 'synthetic' for B1 smoke. Real benches land in
// Track D (assistant-traj) and B-tail (longmemeval/locomo/tau-bench).
export type Bench =
  | 'longmemeval-med'
  | 'locomo-med'
  | 'tau-bench-retail-med'
  | 'assistant-traj'
  | 'synthetic'

export type Score = {
  primary: number
  secondary?: Record<string, number>
  judge_explanation?: string
}

export type TokenUsage = {
  input: number
  output: number
  cache_read?: number
  cache_creation?: number
}

export type ErrorRecord = {
  turn_index: number
  kind: 'api_error' | 'tool_error' | 'judge_error' | 'timeout'
  message: string
}

export type RecallEvent = {
  recall_id: string
  tool_name: string
  reason: string
  turn_index: number
}

export type CompactionEvent = {
  type: 'observer' | 'offload' | 'reflection'
  turn_index: number
  before_bytes: number
  after_bytes: number
  llm_cost_usd?: number
}

export type TurnRecord = {
  turn_index: number
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  wall_clock_ms: number
  ttfb_ms?: number
  class_signal?: { class: TrajectoryClass; confidence: number }
  recall_events: RecallEvent[]
  compaction_events: CompactionEvent[]
}

export type RunRecord = {
  run_id: string
  bench: Bench
  config_id: string
  seed: number
  task_id: string
  started_at: number
  completed_at: number
  score: Score
  totals: TokenUsage
  cost_usd: number
  turns: TurnRecord[]
  errors: ErrorRecord[]
}

// Harness-side interfaces (B1).

export type Task = {
  id: string
  input: unknown
  expected: unknown
}

export type Conversation = {
  messages: Message[]
}

export type RunnerResponse = {
  text: string
  turns: TurnRecord[]
  errors: ErrorRecord[]
  totals: TokenUsage
  cost_usd: number
}

export type ConfigDef = {
  id: string
  baseline?: string
  ahc_flags?: Record<string, unknown>
}

export type RunnerContext = {
  bench: Bench
  config: ConfigDef
  seed: number
  task: Task
  instrumentation?: Instrumentation
}

export type BenchAdapter = {
  name: Bench
  loadTasks: (seed: number) => Promise<Task[]>
  prepare: (task: Task) => Conversation
}

export type Grader = {
  score: (task: Task, response: RunnerResponse) => Score
}

export type Runner = {
  name: string
  execute: (conv: Conversation, ctx: RunnerContext) => Promise<RunnerResponse>
}

// Baseline = inner per-turn contract (per design/C_baselines.md §1).
// `buildRunnerFromBaseline` (src/eval/baseline.ts) wraps it into outer Runner.
export type BaselineState = {
  task_id: string
  history: Message[]
  scratch?: Record<string, unknown>
}

export type BaselineStepOptions = {
  instrumentation?: Instrumentation
}

export type BaselineStepResult = {
  response: Message
  state: BaselineState
  telemetry: TurnRecord
  cost_usd: number
}

export type Baseline = {
  readonly name: string
  prepare: (task: Task) => BaselineState
  step: (
    state: BaselineState,
    userMsg: Message,
    opts?: BaselineStepOptions,
  ) => Promise<BaselineStepResult>
  finalize?: (state: BaselineState) => Promise<void>
}

// Instrumentation — eval-side callback for per-turn events (compaction / recall /
// class signal). Pluggable by baselines that wrap AHC middleware (eventually A6).
// Eval-side InstrumentationEvent uses local CompactionEvent / RecallEvent — when A6
// integration lands, a mapper bridges core CoreEvent → InstrumentationEvent (see
// decisions.md 2026-05-13 B2 entries).
export type InstrumentationEvent =
  | { kind: 'compaction'; payload: CompactionEvent }
  | { kind: 'recall'; payload: RecallEvent }
  | { kind: 'class_signal'; turn_index: number; class: TrajectoryClass; confidence: number }

export type Instrumentation = (event: InstrumentationEvent) => void

// Provider usage shapes — minimal projections of provider-reported tokens.
// Used by src/eval/telemetry.ts ProviderUsageMapper. Source of truth: provider
// response headers (decisions.md 2026-05-13 — provider tokens authoritative).
export type OpenRouterUsage = {
  prompt_tokens: number
  completion_tokens: number
  total_tokens?: number
  prompt_tokens_details?: {
    cached_tokens?: number
  }
}

export type AnthropicUsage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

// LLMClient — provider-neutral interface used by baselines.
// Concrete impl: createOpenRouterClient (src/eval/llm.ts).
// Anthropic-direct client lands at E3 (cache subset) as a separate factory.
export type LLMMessage = {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export type LLMRequest = {
  model: string
  messages: LLMMessage[]
  temperature?: number
  max_tokens?: number
}

export type LLMResponseError = {
  kind: 'rate_limit' | 'server_error' | 'auth' | 'network' | 'parse' | 'unknown'
  message: string
  status?: number
}

export type LLMResponse = {
  text: string
  raw_usage: OpenRouterUsage | AnthropicUsage | null
  finish_reason: string
  latency_ms: number
  error?: LLMResponseError
}

export type LLMClient = (req: LLMRequest) => Promise<LLMResponse>

export type SweepConfig = {
  name: string
  benches: Bench[]
  configs: ConfigDef[]
  seeds: number[]
  budget_usd: number
}

// SweepPlan == parsed SweepConfig for B1; future enrichments (resolved adapters,
// total_tasks count) get a distinct type when first needed.
export type SweepPlan = SweepConfig

export type WorkUnit = {
  bench: Bench
  config: ConfigDef
  seed: number
  task: Task
}

export type RunMeta = {
  config: ConfigDef
  bench: Bench
  seed: number
  git_sha: string
  timestamp: string
}

export type RunSummary = {
  bench: Bench
  config_id: string
  seed: number
  n_total: number
  n_completed: number
  mean_primary_score: number
  total_cost_usd: number
}
