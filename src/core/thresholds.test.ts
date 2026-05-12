import { describe, expect, test } from 'vitest'
import { defaultThresholds } from './thresholds.js'
import * as core from './index.js'

describe('Thresholds defaults', () => {
  test('defaultThresholds matches §10.4 constants (+ T_SIZE_MIXED from A2 §5.2)', () => {
    expect(defaultThresholds).toEqual({
      OBSERVER_THRESHOLD: 8000,
      T_SIZE: 4096,
      T_SIZE_MIXED: 2048,
      T_CUM: 24000,
      K_RECENT: 6,
      BUFFER_TOKENS: 0.2,
      BUFFER_ACTIVATION: 0.8,
      REFLECTION_THRESHOLD: 40000,
    })
  })

  test('defaults accessible from core index re-export', () => {
    expect(core.defaultThresholds).toBe(defaultThresholds)
  })
})
