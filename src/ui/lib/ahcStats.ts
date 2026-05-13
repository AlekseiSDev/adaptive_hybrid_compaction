import type { CoreEvent } from '../../core/index.js';
import { costFromUsage } from '../../eval/llm.js';
import type { AhcStatsEnvelope } from './ahcStatsTypes';

// UI-local pricing overrides for demo models that aren't in eval's OPENROUTER_PRICING.
// eval/llm.ts is off-limits during E1 experiments; adding entries to a UI-local table
// keeps cost-display honest without touching eval state. Verified live 2026-05-13 via
// `openrouter.ai/api/v1/models` — refresh with link to the response timestamp on update.
const UI_PRICING_OVERRIDES: Record<
  string,
  { input_per_million_usd: number; output_per_million_usd: number }
> = Object.freeze({
  'openai/gpt-5.4-mini': { input_per_million_usd: 0.75, output_per_million_usd: 4.5 },
});

export type AiSdkUsage = {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  inputTokenDetails?: {
    cacheReadTokens?: number | undefined;
    cacheWriteTokens?: number | undefined;
  };
};

export type BuildAhcStatsInput = {
  events: readonly CoreEvent[];
  observationsCount: number;
  scratchpadSize: number;
  activeFlags: readonly string[];
  usage: AiSdkUsage;
  modelId: string;
};

export function buildAhcStats(input: BuildAhcStatsInput): AhcStatsEnvelope {
  let latestClass: AhcStatsEnvelope['class'] = null;
  let latestConfidence: AhcStatsEnvelope['confidence'] = null;
  let recallCount = 0;
  let compactionCount = 0;
  let offloadedBytes = 0;

  for (const event of input.events) {
    switch (event.kind) {
      case 'classifier_signal':
        latestClass = event.class;
        latestConfidence = event.confidence;
        break;
      case 'recall':
        recallCount += 1;
        break;
      case 'compaction':
        compactionCount += 1;
        offloadedBytes += Math.max(0, event.before_bytes - event.after_bytes);
        break;
    }
  }

  const inputTokens = input.usage.inputTokens ?? 0;
  const outputTokens = input.usage.outputTokens ?? 0;
  const cacheReadTokens = input.usage.inputTokenDetails?.cacheReadTokens ?? 0;

  const override = UI_PRICING_OVERRIDES[input.modelId];
  const costUsd = override
    ? (inputTokens * override.input_per_million_usd +
        outputTokens * override.output_per_million_usd) /
      1_000_000
    : costFromUsage(input.modelId, {
        prompt_tokens: inputTokens,
        completion_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
      });

  return {
    class: latestClass,
    confidence: latestConfidence,
    observations_count: input.observationsCount,
    scratchpad_size: input.scratchpadSize,
    recall_events_count: recallCount,
    compaction_events_count: compactionCount,
    active_flags: input.activeFlags,
    tokens: {
      input: inputTokens,
      output: outputTokens,
      cache_read: cacheReadTokens,
      offloaded: Math.round(offloadedBytes / 4),
    },
    cost_usd: costUsd,
    model_id: input.modelId,
  };
}
