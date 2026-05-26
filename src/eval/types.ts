// Eval harness types. Source of truth: docs/design/B_eval-harness.md §3.
// Field renames or removals require a docs/decisions.md entry.

import type { Tracer } from '@opentelemetry/api'
import type { Message, Observation, Thresholds, TrajectoryClass } from '../core/index.js'

// Re-export core types so eval-side modules import a single surface
// (`./types.js`). Avoids cross-module drift if core paths change.
export type { Message, Observation, Thresholds, TrajectoryClass }

// §3 union extended with 'synthetic' for B1 smoke. Real benches land in
// Track D (assistant-traj) and B-tail (longmemeval/locomo/tau-bench).
// 'lme-multiturn' added in Track H Phase 1 (2026-05-14) — same baked
// longmemeval-med tasks, but adapter replays each haystack session as a
// separate user turn so AHC's Task-Aware Observer fires (Tier-3 fills
// past OBSERVER_THRESHOLD across replay).
export type Bench =
  | 'longmemeval-med'
  | 'lme-multiturn'
  | 'locomo-med'
  | 'tau-bench-retail-med'
  | 'assistant-traj'
  | 'gaia-med'
  | 'synthetic'

export type Score = {
  primary: number
  secondary?: Record<string, number>
  judge_explanation?: string
  // Per-record judge call cost (D4). Rolled into RunRecord.cost_usd in runSweep
  // before CostTracker.observe(). Separate field so test/eval can distinguish
  // baseline cost from judge cost.
  judge_cost_usd?: number
  // Track J — AssistantTraj v2 tool-call coherence (J §6). AT-only field;
  // other benches leave it undefined. Always populated by AT grader (even when
  // pass:true) so RunRecord-level audit can see required_called / required_total
  // without re-running.
  tool_coherence?: {
    required_called: number
    required_total: number
    pass: boolean
  }
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
  // Observer-only payload — the extracted observations as appended to Tier-2.
  // Forwarded from core CompactionEvent via mapCoreEventToInstrumentation so
  // records.ndjson lets a post-hoc reader see what the observer captured
  // without re-running the workload. Empty / absent for offload / reflection.
  observations?: Observation[]
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
  /**
   * Final assistant response text — the same string that the grader/judge
   * scores against. Without this field, post-hoc audit of why a task scored
   * 0 / 0.5 / 1 is impossible (NDJSON was previously token-only). Optional
   * because old NDJSON predates the field and must still parse; new writes
   * always set it.
   */
  final_response_text?: string
}

// Harness-side interfaces (B1).

export type Task = {
  id: string
  input: unknown
  expected: unknown
}

export type Conversation = {
  messages: Message[]
  // Track J — optional bench-provided tool palette. AT-v2 adapter populates
  // it from `tools_available[]` + per-task replay dispatcher. Baselines that
  // don't consume tools must tolerate undefined. Shape kept loose at the type
  // boundary (provider-specific shapes diverge); concrete contract lives in
  // src/eval/adapters/assistant-traj.tools.ts (J2).
  tools?: Record<string, ToolHandle>
}

// Provider-neutral tool handle. AI SDK v6 `tool({...})` instances satisfy this
// shape via duck-typing (description + inputSchema + execute). Baselines may
// pass the object through to provider SDKs that understand richer shape.
export type ToolHandle = {
  description?: string
  inputSchema: unknown
  execute: (input: unknown) => Promise<{
    content: ToolHandleContentPart[]
    isError?: boolean
  }>
}

export type ToolHandleContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; path: string; alt?: string | undefined }
  | { type: 'file'; path: string; mime?: string | undefined }

export type RunnerResponse = {
  text: string
  turns: TurnRecord[]
  errors: ErrorRecord[]
  totals: TokenUsage
  cost_usd: number
  // Side-channel for bench-specific payloads (e.g. tau-bench env state + reward).
  // Transient — not persisted to RunRecord; only used grader↔runner. D5 Step 4.
  bench_extras?: unknown
  // Track J — tool-calls emitted by the baseline during execution. AT grader
  // (J5) consumes this to compute tool_coherence. Optional because non-AT
  // benches don't populate it; baselines that don't see tools leave it undefined.
  toolCalls?: { name: string; args: unknown }[]
}

export type ConfigDef = {
  id: string
  baseline?: string
  ahc_flags?: Record<string, unknown>
  /**
   * Optional provider override for `ahc_core` baseline. 'openrouter' (default)
   * dispatches actor + AHC internal calls through OpenRouter; 'anthropic_direct'
   * routes through @ai-sdk/anthropic for E3 cache-hit subset; 'google_direct'
   * routes through @ai-sdk/google for Track H P4 Gemini cache-rate measurement
   * (OpenRouter strips Gemini's cachedContentTokenCount, so direct API needed
   * for honest cache numbers). Ignored for other baselines. Per decisions.md
   * [2026-05-13] E0 — ConfigDef.provider field, extended Track H 2026-05-14.
   */
  provider?: 'openrouter' | 'anthropic_direct' | 'google_direct'
  /**
   * Optional threshold overrides for `ahc_core` baseline. Track H P1 added
   * for the lme-multiturn sweep where natural Tier-3 size (~7.8K tok with
   * Mode A replay) sat below the then-default OBSERVER_THRESHOLD=8000 —
   * sweep lowered to 4000 so observer fired (per H_ablations_and_TODOs §12.2).
   * Default has since been raised to 30000 (H Phase 8); the sweep YAML
   * keeps 4000 as a historical artefact of that run.
   * Ignored for non-AHC baselines.
   */
  thresholds?: Partial<Thresholds>
}

export type RunnerContext = {
  bench: Bench
  config: ConfigDef
  seed: number
  task: Task
  instrumentation?: Instrumentation
  // B6: tracer threaded from runSweep so per-turn spans (eval.turn) emit
  // through the same OTel provider as eval.task. Optional — Runner impls
  // fall back to `trace.getTracer('ahc-eval')` (global noop when
  // observability is disabled).
  tracer?: Tracer
}

export type BenchAdapter = {
  name: Bench
  loadTasks: (seed: number) => Promise<Task[]>
  prepare: (task: Task) => Conversation
}

export type Grader = {
  // Async to support LLM-judge graders (D4). Sync graders (synthetic) wrap
  // their result in Promise.resolve via `async` keyword. runSweep awaits.
  score: (task: Task, response: RunnerResponse) => Promise<Score>
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
  // Track J — optional tool palette forwarded from `Conversation.tools`. AT-v2
  // adapter populates it from the task's `tools_available[]` + sidecar fixture.
  // Tools-aware baselines (`mastra-agent`, future ahc_core) pass it to their
  // provider call (`agent.generate({tools})`). Text-only baselines ignore it.
  tools?: Record<string, ToolHandle>
}

export type BaselineStepResult = {
  response: Message
  state: BaselineState
  telemetry: TurnRecord
  cost_usd: number
  // Track J — tool-calls emitted by the baseline during this step. Optional;
  // text-only baselines leave it undefined. Aggregated across step()s by the
  // runner into `RunnerResponse.toolCalls`.
  toolCalls?: { name: string; args: unknown }[]
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
//
// `content` accepts a plain string (text-only callers — full_context,
// mastra_om, anthropic_compact) or a ContentBlock[] (multimodal — D4 judge).
// OpenRouter is OpenAI-compatible and accepts both shapes natively.
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

export type LLMMessage = {
  role: 'system' | 'user' | 'assistant'
  content: string | ContentBlock[]
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
  // E0: completion status — 'partial' iff CostTracker halt'нул sweep mid-run.
  // halt_reason populated only when status === 'partial'. Per
  // `docs/design/E_main-runs.md §9` post-run audit; readers (audit scripts /
  // F-report aggregation) must check status === 'complete' before consuming
  // mean_primary_score etc. on aggregated cells.
  status: 'complete' | 'partial'
  halt_reason?: string
}
