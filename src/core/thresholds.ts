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
}

export const defaultThresholds: Thresholds = {
  OBSERVER_THRESHOLD: 8000,
  T_SIZE: 4096,
  T_SIZE_MIXED: 2048,
  T_CUM: 24000,
  K_RECENT: 6,
  BUFFER_TOKENS: 0.2,
  BUFFER_ACTIVATION: 0.8,
  REFLECTION_THRESHOLD: 40000,
}
