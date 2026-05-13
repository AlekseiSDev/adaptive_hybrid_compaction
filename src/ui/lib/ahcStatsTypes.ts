import type { TrajectoryClass } from '../../core/index.js';

export const AHC_DATA_PART_TYPE = 'ahc_stats' as const;

export type AhcStatsTokens = {
  input: number;
  output: number;
  cache_read: number;
  offloaded: number;
};

export type AhcStatsEnvelope = {
  class: TrajectoryClass | null;
  confidence: number | null;
  observations_count: number;
  scratchpad_size: number;
  recall_events_count: number;
  compaction_events_count: number;
  active_flags: readonly string[];
  tokens: AhcStatsTokens;
  cost_usd: number;
  model_id: string;
};
