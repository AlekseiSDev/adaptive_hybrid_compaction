import type { CoreEvent } from '../../core/index.js';
import { costFromUsage } from '../../eval/llm.js';
import type { AhcStatsEnvelope } from './ahcStatsTypes';

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

  const costUsd = costFromUsage(input.modelId, {
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
