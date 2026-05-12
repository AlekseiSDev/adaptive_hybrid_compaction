export type FeatureFlags = {
  TASK_AWARE_EXTRACTION: boolean
  TYPE_AWARE_OFFLOAD: boolean
  TRAJECTORY_CLASSIFIER: boolean
  ASYNC_OBSERVER: boolean
  RECALL_TOOL: boolean
  SCHEMA_AWARE_DIGEST: boolean
  REFLECTION: boolean
  CALIBRATION_AUTO: boolean
}

export const defaultFeatureFlags: FeatureFlags = {
  TASK_AWARE_EXTRACTION: false,
  TYPE_AWARE_OFFLOAD: false,
  TRAJECTORY_CLASSIFIER: false,
  ASYNC_OBSERVER: false,
  RECALL_TOOL: false,
  SCHEMA_AWARE_DIGEST: false,
  REFLECTION: false,
  CALIBRATION_AUTO: false,
}
