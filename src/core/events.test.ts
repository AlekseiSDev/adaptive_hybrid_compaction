import { describe, expect, test } from 'vitest'
import type {
  ClassifierSignalEvent,
  CompactionEvent,
  CoreEvent,
  EventEmitter,
  RecallEvent,
} from './events.js'

describe('CoreEvent types', () => {
  test('CompactionEvent supports all three compaction subtypes', () => {
    const events: CompactionEvent[] = [
      {
        kind: 'compaction',
        type: 'observer',
        turn_index: 3,
        before_bytes: 12000,
        after_bytes: 1800,
      },
      {
        kind: 'compaction',
        type: 'offload',
        turn_index: 4,
        before_bytes: 8200,
        after_bytes: 320,
      },
      {
        kind: 'compaction',
        type: 'reflection',
        turn_index: 12,
        before_bytes: 41000,
        after_bytes: 18500,
        llm_cost_usd: 0.004,
      },
    ]
    expect(events).toHaveLength(3)
    expect(events.map((e) => e.type).sort()).toEqual(['observer', 'offload', 'reflection'])
  })

  test('CoreEvent discriminated union is exhaustive over kind', () => {
    function describe(e: CoreEvent): string {
      switch (e.kind) {
        case 'compaction':
          return `compaction:${e.type}@${String(e.turn_index)}`
        case 'recall':
          return `recall:${e.recall_id}`
        case 'classifier_signal':
          return `class:${e.class}@${String(e.turn_index)}`
      }
    }
    const compaction: CompactionEvent = {
      kind: 'compaction',
      type: 'observer',
      turn_index: 1,
      before_bytes: 100,
      after_bytes: 40,
    }
    const recall: RecallEvent = {
      kind: 'recall',
      recall_id: 'r_abc',
      tool_name: 'search',
      reason: 'follow-up',
      turn_index: 2,
    }
    const signal: ClassifierSignalEvent = {
      kind: 'classifier_signal',
      turn_index: 1,
      class: 'mixed',
      confidence: 0.62,
    }
    expect(describe(compaction)).toBe('compaction:observer@1')
    expect(describe(recall)).toBe('recall:r_abc')
    expect(describe(signal)).toBe('class:mixed@1')
  })

  test('EventEmitter is a sink function over CoreEvent', () => {
    const sink: CoreEvent[] = []
    const emit: EventEmitter = (e) => {
      sink.push(e)
    }
    emit({
      kind: 'compaction',
      type: 'reflection',
      turn_index: 0,
      before_bytes: 1,
      after_bytes: 0,
    })
    expect(sink).toHaveLength(1)
    expect(sink[0]?.kind).toBe('compaction')
  })
})
