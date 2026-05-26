export type Thresholds = {
  OBSERVER_THRESHOLD: number
  T_SIZE: number
  // Mixed-class size threshold (more aggressive — §5.2 "Defaults: ... На mixed — T_SIZE=2KB").
  // Not in design doc §2.4; introduced in A2 per decisions.md 2026-05-13.
  T_SIZE_MIXED: number
  T_CUM: number
  BUFFER_TOKENS: number
  BUFFER_ACTIVATION: number
  REFLECTION_THRESHOLD: number
  // Upper bound (tokens) on Tier-3.recent. tierize walks from tail accumulating
  // tokens until budget is reached. Observer fires when window crosses
  // OBSERVER_THRESHOLD and clips back to ~0.2 × OBSERVER_THRESHOLD. Defaulting
  // to OBSERVER_THRESHOLD keeps the two coupled (one fire per overflow with
  // predictable residue); separate knob exists so sweeps can decouple.
  // See decisions.md 2026-05-22 and 2026-05-26 (K_RECENT removal).
  TIER3_TOKEN_BUDGET: number
}

export const defaultThresholds: Thresholds = {
  OBSERVER_THRESHOLD: 30000,
  T_SIZE: 4096,
  T_SIZE_MIXED: 2048,
  T_CUM: 24000,
  BUFFER_TOKENS: 0.2,
  BUFFER_ACTIVATION: 0.8,
  // 2026-05-26: raised 40000 → 100000. The previous threshold collapsed
  // observations into a reflector summary too eagerly — by the time Tier-2
  // had ~10 observation entries we already lost factual specifics
  // (numbers, proper nouns) on lme-multiturn. 100k keeps Tier-2 wider before
  // reflection consolidates, matching the same envelope as Mastra OM's
  // reflection.observationTokens default (40000 → effectively never on med
  // tasks since Mastra's per-batch cap is 10000).
  REFLECTION_THRESHOLD: 100_000,
  TIER3_TOKEN_BUDGET: 30000,
}
