export type Thresholds = {
  OBSERVER_THRESHOLD: number
  T_SIZE: number
  // Mixed-class size threshold (more aggressive — §5.2 "Defaults: ... На mixed — T_SIZE=2KB").
  // Not in design doc §2.4; introduced in A2 per decisions.md 2026-05-13.
  T_SIZE_MIXED: number
  T_CUM: number
  K_RECENT: number
  BUFFER_TOKENS: number
  BUFFER_ACTIVATION: number
  REFLECTION_THRESHOLD: number
  // Upper bound (tokens) on Tier-3.recent. Tier-3 grows past K_RECENT messages
  // up to this budget; observer fires when window crosses OBSERVER_THRESHOLD
  // and clips back to ~0.2 × OBSERVER_THRESHOLD. Defaulting to OBSERVER_THRESHOLD
  // keeps the two coupled (one fire per overflow with predictable residue);
  // separate knob exists so sweeps can decouple. See decisions.md 2026-05-22.
  TIER3_TOKEN_BUDGET: number
}

export const defaultThresholds: Thresholds = {
  // H Phase 8 (2026-05-22): raised 8000 → 30000 after Mastra comparison on
  // lme-multiturn. At 8000 (and 4000 in the sweep override) observer fired
  // on every turn ≥2 — TAE summaries replaced raw context too aggressively,
  // erasing the exact facts answer-bearing sessions carried (knowledge-update
  // confabulated "17" for ground-truth "25"; single-session-user lost "Luna").
  // Mastra OM ran with a working-window ≈25K tokens before its own compact,
  // kept those facts, and beat AHC by 37pp accuracy at lower cost. 30000
  // sets AHC's pre-compact window in the same envelope. See decisions.md.
  OBSERVER_THRESHOLD: 30000,
  T_SIZE: 4096,
  T_SIZE_MIXED: 2048,
  T_CUM: 24000,
  K_RECENT: 6,
  BUFFER_TOKENS: 0.2,
  BUFFER_ACTIVATION: 0.8,
  REFLECTION_THRESHOLD: 40000,
  TIER3_TOKEN_BUDGET: 30000,
}
