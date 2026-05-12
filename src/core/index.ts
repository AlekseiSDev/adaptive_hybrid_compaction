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
