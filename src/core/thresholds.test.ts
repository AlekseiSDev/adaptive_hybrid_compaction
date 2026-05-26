import { describe, expect, test } from 'vitest'
import { defaultThresholds } from './thresholds.js'
import * as core from './index.js'

describe('Thresholds defaults', () => {
  test('defaultThresholds matches §10.4 constants (+ T_SIZE_MIXED from A2 §5.2)', () => {
    expect(defaultThresholds).toEqual({
      OBSERVER_THRESHOLD: 30000,
      T_SIZE: 4096,
      T_SIZE_MIXED: 2048,
      T_CUM: 24000,
      BUFFER_TOKENS: 0.2,
      BUFFER_ACTIVATION: 0.8,
      REFLECTION_THRESHOLD: 100_000,
      TIER3_TOKEN_BUDGET: 30000,
    })
  })

  test('defaults accessible from core index re-export', () => {
    expect(core.defaultThresholds).toBe(defaultThresholds)
  })

  test('TIER3_TOKEN_BUDGET defaults to OBSERVER_THRESHOLD — they are intentionally coupled', () => {
    expect(defaultThresholds.TIER3_TOKEN_BUDGET).toBe(defaultThresholds.OBSERVER_THRESHOLD)
    expect(Number.isInteger(defaultThresholds.TIER3_TOKEN_BUDGET)).toBe(true)
    expect(defaultThresholds.TIER3_TOKEN_BUDGET).toBeGreaterThan(0)
  })

  test('REFLECTION_THRESHOLD raised to 100k (2026-05-26) — gives Tier-2 wider window before reflection', () => {
    expect(defaultThresholds.REFLECTION_THRESHOLD).toBe(100_000)
  })

  test('K_RECENT removed from Thresholds — TIER3_TOKEN_BUDGET is the single Tier-3 cap', () => {
    expect(defaultThresholds).not.toHaveProperty('K_RECENT')
  })
})
