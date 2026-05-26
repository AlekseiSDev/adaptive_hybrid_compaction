import type { Observation, TrajectoryClass } from './types.js'

export type CompactionEventType = 'observer' | 'offload' | 'reflection'

export type CompactionEvent = {
  kind: 'compaction'
  type: CompactionEventType
  turn_index: number
  before_bytes: number
  after_bytes: number
  llm_cost_usd?: number
  // Observer-only payload: the extracted observations as they were appended
  // to Tier-2. Populated when type === 'observer' so post-hoc audit of run
  // dirs can grade observation quality without re-running the workload.
  // Empty / absent for offload and reflection events.
  observations?: Observation[]
  // Observer-only diagnostic: raw LLM text when parseObservations returned
  // []. Lets a post-hoc reader see what the LLM actually produced when the
  // parser silently dropped the output (prompt/parser format-drift case).
  observerRawText?: string
}

export type RecallEvent = {
  kind: 'recall'
  recall_id: string
  tool_name: string
  reason: string
  turn_index: number
}

export type ClassifierSignalEvent = {
  kind: 'classifier_signal'
  turn_index: number
  class: TrajectoryClass
  confidence: number
}

export type CoreEvent = CompactionEvent | RecallEvent | ClassifierSignalEvent

export type EventEmitter = (event: CoreEvent) => void
