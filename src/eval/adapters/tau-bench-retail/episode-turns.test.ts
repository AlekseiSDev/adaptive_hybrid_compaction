import { describe, expect, test } from 'vitest'
import { buildEpisodeTurns } from './index.js'
import type { InstrumentationEvent } from '../../types.js'

// S4 (E1): tau-bench Runner emits InstrumentationEvents via AHC middleware,
// but they reach runSweep through ctx.instrumentation rather than
// RunnerResponse.turns. enrichTurnsWithEvents in runSweep filters per
// turn_index — an empty `turns: []` would silently drop AHC events from
// NDJSON.
// buildEpisodeTurns synthesizes a TurnRecord skeleton per unique turn_index
// in the events array; events are then attached by runSweep.

describe('buildEpisodeTurns', () => {
  test('returns empty array when no events (vanilla tau_bench_agent path)', () => {
    expect(buildEpisodeTurns([])).toEqual([])
  })

  test('builds one TurnRecord per unique turn_index from compaction events', () => {
    const events: InstrumentationEvent[] = [
      {
        kind: 'compaction',
        payload: { type: 'observer', turn_index: 0, before_bytes: 100, after_bytes: 50 },
      },
      {
        kind: 'compaction',
        payload: { type: 'observer', turn_index: 2, before_bytes: 200, after_bytes: 80 },
      },
      // Second event on turn 2 — should not create a duplicate TurnRecord.
      {
        kind: 'compaction',
        payload: { type: 'observer', turn_index: 2, before_bytes: 150, after_bytes: 60 },
      },
    ]
    const turns = buildEpisodeTurns(events)
    expect(turns).toHaveLength(2)
    expect(turns.map((t) => t.turn_index)).toEqual([0, 2])
    for (const turn of turns) {
      // Token / wall-clock attribution stays at episode level (RunRecord.totals);
      // per-turn fields are zero placeholders.
      expect(turn.input_tokens).toBe(0)
      expect(turn.output_tokens).toBe(0)
      expect(turn.wall_clock_ms).toBe(0)
      // Events array is empty here — runSweep's enrichTurnsWithEvents fills
      // these based on turn_index match (verified via runSweep tests).
      expect(turn.compaction_events).toEqual([])
      expect(turn.recall_events).toEqual([])
    }
  })

  test('handles class_signal events (top-level turn_index, not nested in payload)', () => {
    const events: InstrumentationEvent[] = [
      { kind: 'class_signal', turn_index: 1, class: 'tool_heavy', confidence: 0.8 },
    ]
    const turns = buildEpisodeTurns(events)
    expect(turns).toHaveLength(1)
    expect(turns[0]?.turn_index).toBe(1)
  })

  test('handles recall events (payload.turn_index)', () => {
    const events: InstrumentationEvent[] = [
      {
        kind: 'recall',
        payload: {
          recall_id: 'r-1',
          tool_name: 'recall_tool_result',
          reason: 'budget_overflow',
          turn_index: 3,
        },
      },
    ]
    const turns = buildEpisodeTurns(events)
    expect(turns).toHaveLength(1)
    expect(turns[0]?.turn_index).toBe(3)
  })

  test('mixed event kinds collapsed to unique turn_indices, sorted ascending', () => {
    const events: InstrumentationEvent[] = [
      { kind: 'compaction', payload: { type: 'observer', turn_index: 4, before_bytes: 1, after_bytes: 0 } },
      { kind: 'class_signal', turn_index: 2, class: 'mixed', confidence: 0.5 },
      { kind: 'recall', payload: { recall_id: 'r-x', tool_name: 't', reason: 'r', turn_index: 0 } },
      { kind: 'compaction', payload: { type: 'observer', turn_index: 2, before_bytes: 1, after_bytes: 0 } },
    ]
    const turns = buildEpisodeTurns(events)
    expect(turns.map((t) => t.turn_index)).toEqual([0, 2, 4])
  })
})
