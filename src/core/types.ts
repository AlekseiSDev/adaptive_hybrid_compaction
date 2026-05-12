// Canonical cross-module types. See `docs/design/A_ahc-algorithm.md §2.4`.
// Contractual surface: field renames / removals require a `docs/decisions.md` entry.

export type Role = 'system' | 'user' | 'assistant' | 'tool'

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; data: string }
  | { type: 'file'; mimeType: string; data: string }
  | { type: 'tool_use'; tool_use_id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; output: unknown; isError?: boolean }

export type Message = {
  role: Role
  content: ContentPart[]
  metadata?: {
    turn_index: number
    step_index: number
    is_offloaded_pointer?: boolean
  }
}

// Opaque shape — populated by adapters (AI SDK v6 in A6).
// Core never inspects fields; adapters cast in via typed factories.
export type ToolDefinition = { readonly __brand: 'ToolDefinition' } & Record<string, unknown>

export type TrajectoryClass = 'conversational' | 'tool_heavy' | 'mixed'

export type Observation = {
  timestamp: number
  confidence: 'high' | 'med' | 'low'
  statement: string
  subDetails?: string[]
  sourceTurn: number
}

export type PointerPlaceholder = {
  recall_id: string
  tool_name: string
  original_size_bytes: number
  digest: string
  turn_index: number
}

export type Tier1 = {
  systemPrompt: Message
  toolDefinitions: ToolDefinition[]
  firstUserMessages: Message[]
}

export type Tier2 = {
  observations: Observation[]
  pointers: PointerPlaceholder[]
  classSignal: { class: TrajectoryClass; confidence: number; updatedAt: number }
}

export type AtomicGroup = {
  group_id: string
  tool_use: Message
  tool_result: Message
  reasoning_chunk?: Message
  turn_index: number
}

// Tool_use awaiting its tool_result. Split from AtomicGroup so the latter
// preserves a non-null tool_result invariant (decisions.md 2026-05-13).
export type InflightToolUse = {
  group_id: string
  tool_use: Message
  turn_index: number
}

export type Tier3 = {
  recent: Message[]
  inflight: InflightToolUse[]
}

export type ClassifierFeatures = {
  tool_call_density: number
  avg_tool_result_size: number
  recent_tool_density: number
  user_turn_ratio: number
  multimodal_flag: boolean
  cumulative_tokens: number
  turns_total: number
}

// Forward-declared imports to keep this file self-contained.
// Re-exports of FeatureFlags/Thresholds live in `./index.ts`.
import type { FeatureFlags } from './featureFlags.js'
import type { Thresholds } from './thresholds.js'

export type CompactionContext = {
  flags: FeatureFlags
  groups_after_this: number
  cumulative_kept_tool_result_bytes: number
  current_class: TrajectoryClass
  thresholds: Thresholds
}
