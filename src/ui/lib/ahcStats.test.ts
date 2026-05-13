import { describe, expect, it } from 'vitest';
import type { CoreEvent } from '../../core/index.js';
import { buildAhcStats, type BuildAhcStatsInput } from './ahcStats';

const MODEL_ID = 'google/gemini-3-flash-preview';

function baseInput(overrides: Partial<BuildAhcStatsInput> = {}): BuildAhcStatsInput {
  return {
    events: [],
    observationsCount: 0,
    scratchpadSize: 0,
    activeFlags: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    modelId: MODEL_ID,
    ...overrides,
  };
}

describe('buildAhcStats', () => {
  it('empty events → null class/confidence, zero counts, zero offloaded', () => {
    const envelope = buildAhcStats(baseInput());
    expect(envelope.class).toBeNull();
    expect(envelope.confidence).toBeNull();
    expect(envelope.observations_count).toBe(0);
    expect(envelope.scratchpad_size).toBe(0);
    expect(envelope.recall_events_count).toBe(0);
    expect(envelope.compaction_events_count).toBe(0);
    expect(envelope.tokens.offloaded).toBe(0);
    expect(envelope.cost_usd).toBe(0);
    expect(envelope.model_id).toBe(MODEL_ID);
  });

  it('latest ClassifierSignalEvent wins (multiple signals → last one)', () => {
    const events: CoreEvent[] = [
      { kind: 'classifier_signal', turn_index: 0, class: 'conversational', confidence: 0.4 },
      { kind: 'classifier_signal', turn_index: 1, class: 'tool_heavy', confidence: 0.78 },
    ];
    const envelope = buildAhcStats(baseInput({ events }));
    expect(envelope.class).toBe('tool_heavy');
    expect(envelope.confidence).toBeCloseTo(0.78);
  });

  it('CompactionEvent → compaction_events_count + offloaded = (before-after)/4 chars-over-4', () => {
    const events: CoreEvent[] = [
      {
        kind: 'compaction',
        type: 'offload',
        turn_index: 1,
        before_bytes: 8000,
        after_bytes: 2000,
      },
    ];
    const envelope = buildAhcStats(baseInput({ events }));
    expect(envelope.compaction_events_count).toBe(1);
    expect(envelope.tokens.offloaded).toBe(1500); // (8000-2000)/4
  });

  it('multiple CompactionEvents sum offloaded', () => {
    const events: CoreEvent[] = [
      {
        kind: 'compaction',
        type: 'offload',
        turn_index: 1,
        before_bytes: 4000,
        after_bytes: 1000,
      },
      {
        kind: 'compaction',
        type: 'observer',
        turn_index: 2,
        before_bytes: 2000,
        after_bytes: 800,
      },
    ];
    const envelope = buildAhcStats(baseInput({ events }));
    expect(envelope.compaction_events_count).toBe(2);
    expect(envelope.tokens.offloaded).toBe(1050); // (3000+1200)/4
  });

  it('RecallEvent → recall_events_count incremented', () => {
    const events: CoreEvent[] = [
      {
        kind: 'recall',
        recall_id: 'r1',
        tool_name: 'fetch_url',
        reason: 'duplicate-url',
        turn_index: 2,
      },
      {
        kind: 'recall',
        recall_id: 'r2',
        tool_name: 'fetch_url',
        reason: 'duplicate-url',
        turn_index: 3,
      },
    ];
    const envelope = buildAhcStats(baseInput({ events }));
    expect(envelope.recall_events_count).toBe(2);
  });

  it('projects tokens from AI SDK v6 usage shape', () => {
    const envelope = buildAhcStats(
      baseInput({
        usage: {
          inputTokens: 3421,
          outputTokens: 412,
          inputTokenDetails: { cacheReadTokens: 2900 },
        },
      }),
    );
    expect(envelope.tokens.input).toBe(3421);
    expect(envelope.tokens.output).toBe(412);
    expect(envelope.tokens.cache_read).toBe(2900);
  });

  it('cache_read defaults to 0 when inputTokenDetails missing', () => {
    const envelope = buildAhcStats(
      baseInput({
        usage: { inputTokens: 100, outputTokens: 50 },
      }),
    );
    expect(envelope.tokens.cache_read).toBe(0);
  });

  it('cost_usd computed via OpenRouter pricing for known model', () => {
    // gemini-3-flash-preview: input $0.50 / 1M, output $3.00 / 1M
    const envelope = buildAhcStats(
      baseInput({
        usage: { inputTokens: 1_000_000, outputTokens: 100_000 },
      }),
    );
    // 1M*0.5 + 0.1M*3 = 0.5 + 0.3 = 0.8 USD
    expect(envelope.cost_usd).toBeCloseTo(0.8, 4);
  });

  it('unknown model → cost_usd = 0', () => {
    const envelope = buildAhcStats(
      baseInput({
        usage: { inputTokens: 1_000_000, outputTokens: 100_000 },
        modelId: 'unknown/no-such-model',
      }),
    );
    expect(envelope.cost_usd).toBe(0);
  });

  it('passes observationsCount, scratchpadSize, activeFlags through', () => {
    const envelope = buildAhcStats(
      baseInput({
        observationsCount: 3,
        scratchpadSize: 2,
        activeFlags: ['TYPE_AWARE_OFFLOAD', 'RECALL_TOOL'],
      }),
    );
    expect(envelope.observations_count).toBe(3);
    expect(envelope.scratchpad_size).toBe(2);
    expect(envelope.active_flags).toEqual(['TYPE_AWARE_OFFLOAD', 'RECALL_TOOL']);
  });
});
