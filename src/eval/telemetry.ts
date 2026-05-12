import type {
  AnthropicUsage,
  CompactionEvent,
  InstrumentationEvent,
  OpenRouterUsage,
  RecallEvent,
  TrajectoryClass,
  TurnRecord,
} from './types.js'

// Provider tokens authoritative — see decisions.md 2026-05-13 B2 entries.
// Mappers project provider response usage into TurnRecord-shaped fragments;
// caller (runner / baseline) merges with instrumentation events via composeTurnRecord.

export type TurnTimingHints = {
  wall_clock_ms: number
  turn_index: number
  ttfb_ms?: number
}

export type TurnUsagePart = Pick<
  TurnRecord,
  | 'turn_index'
  | 'input_tokens'
  | 'output_tokens'
  | 'wall_clock_ms'
  | 'ttfb_ms'
  | 'cache_read_input_tokens'
  | 'cache_creation_input_tokens'
>

export type TurnEventsPart = {
  recall_events: RecallEvent[]
  compaction_events: CompactionEvent[]
  class_signal?: { class: TrajectoryClass; confidence: number }
}

export function mapOpenRouterUsage(
  usage: OpenRouterUsage,
  timing: TurnTimingHints,
): TurnUsagePart {
  const cached = usage.prompt_tokens_details?.cached_tokens
  return {
    turn_index: timing.turn_index,
    input_tokens: usage.prompt_tokens,
    output_tokens: usage.completion_tokens,
    wall_clock_ms: timing.wall_clock_ms,
    ...(timing.ttfb_ms !== undefined ? { ttfb_ms: timing.ttfb_ms } : {}),
    ...(cached !== undefined ? { cache_read_input_tokens: cached } : {}),
  }
}

export function mapAnthropicUsage(
  usage: AnthropicUsage,
  timing: TurnTimingHints,
): TurnUsagePart {
  return {
    turn_index: timing.turn_index,
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    wall_clock_ms: timing.wall_clock_ms,
    ...(timing.ttfb_ms !== undefined ? { ttfb_ms: timing.ttfb_ms } : {}),
    ...(usage.cache_read_input_tokens !== undefined
      ? { cache_read_input_tokens: usage.cache_read_input_tokens }
      : {}),
    ...(usage.cache_creation_input_tokens !== undefined
      ? { cache_creation_input_tokens: usage.cache_creation_input_tokens }
      : {}),
  }
}

export function aggregateTurnEvents(
  events: readonly InstrumentationEvent[],
  turn_index: number,
): TurnEventsPart {
  const recall_events: RecallEvent[] = []
  const compaction_events: CompactionEvent[] = []
  let class_signal: TurnEventsPart['class_signal']

  for (const event of events) {
    switch (event.kind) {
      case 'compaction':
        if (event.payload.turn_index === turn_index) {
          compaction_events.push(event.payload)
        }
        break
      case 'recall':
        if (event.payload.turn_index === turn_index) {
          recall_events.push(event.payload)
        }
        break
      case 'class_signal':
        if (event.turn_index === turn_index) {
          class_signal = { class: event.class, confidence: event.confidence }
        }
        break
    }
  }

  return {
    recall_events,
    compaction_events,
    ...(class_signal !== undefined ? { class_signal } : {}),
  }
}

export function composeTurnRecord(
  usage: TurnUsagePart,
  events: Partial<TurnEventsPart>,
): TurnRecord {
  return {
    ...usage,
    recall_events: events.recall_events ?? [],
    compaction_events: events.compaction_events ?? [],
    ...(events.class_signal !== undefined ? { class_signal: events.class_signal } : {}),
  }
}
