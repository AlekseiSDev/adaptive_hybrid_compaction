export { defaultFeatureFlags, type FeatureFlags } from './featureFlags.js'
export { defaultThresholds, type Thresholds } from './thresholds.js'
export { hashAtomicGroupId, parseAtomicGroups, type ParseResult } from './atomicGroup.js'
export { tierize, type TierizeOptions, type TierizeResult } from './tiers.js'
export { computeFeatures } from './classifierFeatures.js'
export {
  classify,
  classifyWithHysteresis,
  type HysteresisState,
  type HysteresisResult,
} from './classifier.js'
export { dispatch, type DispatchPlan, type DispatchState } from './dispatch.js'
export {
  byteLengthOfContent,
  charsOver4TokenCounter,
  type ByteCounter,
  type TokenCounter,
} from './tokenCounter.js'
export { type LLMCaller, type LLMMessage, type LLMRequest, type LLMResponse } from './llm.js'
export { createInMemoryScratchpad, type Scratchpad } from './scratchpad.js'
export {
  shouldOffload,
  compactWithOffload,
  type CompactWithOffloadDeps,
  type OffloadResult,
} from './offloader.js'
export { generateDigest, type DigestDeps, type DigestStrategy, type ToolSchema } from './digest.js'
export { recallToolDefinition, injectRecallTool } from './recallTool.js'
export { serializeForCache, canonicalJSON, type CachePrefix } from './serializeForCache.js'
export {
  clipTier3KeepingTail,
  maybeExtractObservations,
  extractObservationsSync,
  type ObserverResult,
  type ObserverDeps,
  type ObserverDepsSync,
  type ObserverReason,
  type SyncLLMCaller,
  type ClipOptions,
} from './observer.js'
export { OBSERVER_PROMPT_TEMPLATE, parseObservations } from './observerPrompt.js'
export type {
  ClassifierSignalEvent,
  CompactionEvent,
  CompactionEventType,
  CoreEvent,
  EventEmitter,
  RecallEvent,
} from './events.js'
export { compact, type CompactDeps, type CompactInput, type CompactResult } from './compact.js'
export { assembleContext, renderObservationsAsNote } from './assembleContext.js'
export {
  AsyncBuffer,
  type PreparedCompaction,
  type PreCompactDeps,
} from './asyncBuffer.js'
export {
  reflect,
  type ReflectDeps,
  type ReflectionReason,
  type ReflectionResult,
} from './reflection.js'
export { REFLECTOR_PROMPT_TEMPLATE } from './reflectorPrompt.js'
export type {
  AtomicGroup,
  ClassifierFeatures,
  CompactionContext,
  ContentPart,
  InflightToolUse,
  Message,
  Observation,
  PointerPlaceholder,
  Role,
  Tier1,
  Tier2,
  Tier3,
  ToolDefinition,
  TrajectoryClass,
} from './types.js'
