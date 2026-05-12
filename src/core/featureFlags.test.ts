import { describe, expect, test } from 'vitest'
import { defaultFeatureFlags, type FeatureFlags } from './featureFlags.js'
import * as core from './index.js'

describe('FeatureFlags defaults', () => {
  test('defaultFeatureFlags exposes all 8 flags with REFLECTION=true (§8 spec)', () => {
    const expectedKeys: readonly (keyof FeatureFlags)[] = [
      'TASK_AWARE_EXTRACTION',
      'TYPE_AWARE_OFFLOAD',
      'TRAJECTORY_CLASSIFIER',
      'ASYNC_OBSERVER',
      'RECALL_TOOL',
      'SCHEMA_AWARE_DIGEST',
      'REFLECTION',
      'CALIBRATION_AUTO',
    ]
    const keys = Object.keys(defaultFeatureFlags).sort()
    expect(keys).toEqual([...expectedKeys].sort())
    expect(defaultFeatureFlags.REFLECTION).toBe(true)
    const otherFlagsAllFalse = expectedKeys
      .filter((k) => k !== 'REFLECTION')
      .every((k) => !defaultFeatureFlags[k])
    expect(otherFlagsAllFalse).toBe(true)
  })

  test('defaults accessible from core index re-export', () => {
    expect(core.defaultFeatureFlags).toBe(defaultFeatureFlags)
  })
})
