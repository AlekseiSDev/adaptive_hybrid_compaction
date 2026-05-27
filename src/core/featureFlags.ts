export type FeatureFlags = {
  TASK_AWARE_EXTRACTION: boolean
  TYPE_AWARE_OFFLOAD: boolean
  TRAJECTORY_CLASSIFIER: boolean
  ASYNC_OBSERVER: boolean
  RECALL_TOOL: boolean
  SCHEMA_AWARE_DIGEST: boolean
  // K-tail-3 (2026-05-26): content-aware digest — per-tool-name projection
  // (web_search → top urls+snippets, python_exec → stdout/stderr, etc.). Cheap,
  // no LLM call. When false, generateDigest falls back to SCHEMA_AWARE_DIGEST
  // (if enabled) → llm_summarize (80 tokens) → ruleBasedFallback.
  CONTENT_AWARE_DIGEST: boolean
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
  CONTENT_AWARE_DIGEST: false,
  REFLECTION: true,
  CALIBRATION_AUTO: false,
}
