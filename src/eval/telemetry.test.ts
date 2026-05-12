import { describe, expect, test } from 'vitest'
import {
  aggregateTurnEvents,
  composeTurnRecord,
  mapAnthropicUsage,
  mapOpenRouterUsage,
} from './telemetry.js'
import type {
  AnthropicUsage,
  CompactionEvent,
  InstrumentationEvent,
  OpenRouterUsage,
  RecallEvent,
} from './types.js'

describe('mapOpenRouterUsage — TDD seed #1: provider tokens authoritative', () => {
  test('basic prompt/completion tokens map straight through', () => {
    const raw: OpenRouterUsage = { prompt_tokens: 123, completion_tokens: 45 }
    const part = mapOpenRouterUsage(raw, { wall_clock_ms: 250, turn_index: 0 })
    expect(part.input_tokens).toBe(123)
    expect(part.output_tokens).toBe(45)
    expect(part.wall_clock_ms).toBe(250)
    expect(part.turn_index).toBe(0)
    expect(part.cache_read_input_tokens).toBeUndefined()
  })

  test('cached_tokens from nested prompt_tokens_details surfaced as cache_read_input_tokens', () => {
    const raw: OpenRouterUsage = {
      prompt_tokens: 200,
      completion_tokens: 50,
      prompt_tokens_details: { cached_tokens: 80 },
    }
    const part = mapOpenRouterUsage(raw, { wall_clock_ms: 100, turn_index: 1 })
    expect(part.cache_read_input_tokens).toBe(80)
  })

  test('cached_tokens=0 is preserved (truthy difference from undefined)', () => {
    const raw: OpenRouterUsage = {
      prompt_tokens: 100,
      completion_tokens: 30,
      prompt_tokens_details: { cached_tokens: 0 },
    }
    const part = mapOpenRouterUsage(raw, { wall_clock_ms: 50, turn_index: 0 })
    expect(part.cache_read_input_tokens).toBe(0)
  })
})

describe('mapAnthropicUsage', () => {
  test('input/output tokens + cache fields map directly (Anthropic-native names)', () => {
    const raw: AnthropicUsage = {
      input_tokens: 500,
      output_tokens: 120,
      cache_read_input_tokens: 200,
      cache_creation_input_tokens: 50,
    }
    const part = mapAnthropicUsage(raw, { wall_clock_ms: 800, turn_index: 2 })
    expect(part.input_tokens).toBe(500)
    expect(part.output_tokens).toBe(120)
    expect(part.cache_read_input_tokens).toBe(200)
    expect(part.cache_creation_input_tokens).toBe(50)
    expect(part.wall_clock_ms).toBe(800)
  })

  test('omits cache fields when not provided (no zero defaulting)', () => {
    const raw: AnthropicUsage = { input_tokens: 100, output_tokens: 20 }
    const part = mapAnthropicUsage(raw, { wall_clock_ms: 10, turn_index: 0 })
    expect(part.cache_read_input_tokens).toBeUndefined()
    expect(part.cache_creation_input_tokens).toBeUndefined()
  })
})

describe('aggregateTurnEvents', () => {
  const compactEvent = (turn_index: number): CompactionEvent => ({
    type: 'offload',
    turn_index,
    before_bytes: 1000,
    after_bytes: 100,
  })
  const recallEvent = (turn_index: number, recall_id: string): RecallEvent => ({
    recall_id,
    tool_name: 'search',
    reason: 'need data',
    turn_index,
  })

  test('groups events by turn_index — events for other turns are excluded', () => {
    const events: InstrumentationEvent[] = [
      { kind: 'compaction', payload: compactEvent(0) },
      { kind: 'compaction', payload: compactEvent(1) },
      { kind: 'recall', payload: recallEvent(0, 'r1') },
      { kind: 'recall', payload: recallEvent(2, 'r2') },
    ]
    const part = aggregateTurnEvents(events, 0)
    expect(part.compaction_events).toHaveLength(1)
    expect(part.compaction_events[0]?.turn_index).toBe(0)
    expect(part.recall_events).toHaveLength(1)
    expect(part.recall_events[0]?.recall_id).toBe('r1')
  })

  test('class_signal at matching turn_index becomes class_signal field', () => {
    const events: InstrumentationEvent[] = [
      { kind: 'class_signal', turn_index: 0, class: 'tool_heavy', confidence: 0.9 },
      { kind: 'class_signal', turn_index: 1, class: 'mixed', confidence: 0.6 },
    ]
    const part = aggregateTurnEvents(events, 0)
    expect(part.class_signal).toEqual({ class: 'tool_heavy', confidence: 0.9 })
  })

  test('returns empty arrays + undefined class_signal when no matching events', () => {
    const part = aggregateTurnEvents([], 5)
    expect(part.compaction_events).toEqual([])
    expect(part.recall_events).toEqual([])
    expect(part.class_signal).toBeUndefined()
  })
})

describe('composeTurnRecord', () => {
  test('guarantees non-null recall_events / compaction_events arrays even when partials omit them', () => {
    const turn = composeTurnRecord(
      { input_tokens: 10, output_tokens: 5, wall_clock_ms: 1, turn_index: 0 },
      {},
    )
    expect(turn.recall_events).toEqual([])
    expect(turn.compaction_events).toEqual([])
    expect(turn.input_tokens).toBe(10)
    expect(turn.turn_index).toBe(0)
  })

  test('events partial overrides defaults; usage fields come from usage partial', () => {
    const turn = composeTurnRecord(
      { input_tokens: 100, output_tokens: 20, wall_clock_ms: 50, turn_index: 1, cache_read_input_tokens: 30 },
      {
        compaction_events: [
          { type: 'observer', turn_index: 1, before_bytes: 500, after_bytes: 200 },
        ],
        class_signal: { class: 'conversational', confidence: 0.85 },
      },
    )
    expect(turn.compaction_events).toHaveLength(1)
    expect(turn.cache_read_input_tokens).toBe(30)
    expect(turn.class_signal).toEqual({ class: 'conversational', confidence: 0.85 })
    expect(turn.recall_events).toEqual([])
  })
})
