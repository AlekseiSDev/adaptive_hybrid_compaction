// B1 surface
export {
  appendRecord,
  computeConfigId,
  readAllRecords,
  readCompletedTaskIds,
  runDirFor,
  writeMeta,
  writeSummary,
} from './persist.js'
export {
  computeTotalTasks,
  defaultAdapterRegistry,
  defaultRunnerRegistry,
  runSweep,
  type AdapterRegistry,
  type RunnerRegistry,
  type RunSweepConfigResult,
  type RunSweepOptions,
  type RunSweepResult,
} from './runner.js'
export { syntheticAdapter, syntheticGrader } from './adapters/synthetic.js'

// B2 surface
export { buildRunnerFromBaseline } from './baseline.js'
export { fullContextBaseline, type FullContextDeps } from './baselines/full_context.js'
export {
  costFromUsage,
  createOpenRouterClient,
  OPENROUTER_PRICING,
  type ModelPricing,
  type OpenRouterClientOptions,
} from './llm.js'
export {
  aggregateTurnEvents,
  composeTurnRecord,
  mapAnthropicUsage,
  mapOpenRouterUsage,
  type TurnEventsPart,
  type TurnTimingHints,
  type TurnUsagePart,
} from './telemetry.js'
export { CostTracker, type ShouldHaltOpts, type ShouldHaltResult } from './cost.js'

// B3 surface
export {
  modeClassOfTask,
  pairedPermutation,
  perClassBreakdown,
  type ClassBucket,
  type ClassStats,
  type PairedPermutationResult,
} from './stats.js'
export {
  setupObservability,
  type ObservabilityHandle,
  type SetupObservabilityOptions,
} from './observability/langfuse.js'

export type {
  AnthropicUsage,
  Baseline,
  BaselineState,
  BaselineStepOptions,
  BaselineStepResult,
  Bench,
  BenchAdapter,
  CompactionEvent,
  ConfigDef,
  Conversation,
  ErrorRecord,
  Grader,
  Instrumentation,
  InstrumentationEvent,
  LLMClient,
  LLMMessage,
  LLMRequest,
  LLMResponse,
  LLMResponseError,
  Message,
  OpenRouterUsage,
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
  TrajectoryClass,
  TurnRecord,
  WorkUnit,
} from './types.js'
