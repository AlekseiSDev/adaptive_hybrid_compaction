import type { TrajectoryClass } from './types.js'

export type CompactionEventType = 'observer' | 'offload' | 'reflection'

export type CompactionEvent = {
  kind: 'compaction'
  type: CompactionEventType
  turn_index: number
  before_bytes: number
  after_bytes: number
  llm_cost_usd?: number
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
