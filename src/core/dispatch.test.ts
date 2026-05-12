import { describe, expect, test } from 'vitest'
import { dispatch, type DispatchState } from './dispatch.js'
import { defaultFeatureFlags, type FeatureFlags } from './featureFlags.js'
import type { TrajectoryClass } from './types.js'

const flagsWith = (overrides: Partial<FeatureFlags> = {}): FeatureFlags => ({
  ...defaultFeatureFlags,
  TASK_AWARE_EXTRACTION: true,
  TYPE_AWARE_OFFLOAD: true,
  TRAJECTORY_CLASSIFIER: true,
  ...overrides,
})

const stateFor = (
  cls: TrajectoryClass,
  flagOverrides: Partial<FeatureFlags> = {},
  configuredClass?: TrajectoryClass,
): DispatchState =>
  configuredClass === undefined
    ? { class: cls, flags: flagsWith(flagOverrides) }
    : { class: cls, flags: flagsWith(flagOverrides), configuredClass }

describe('dispatch (seam)', () => {
  test('conversational → observer only', () => {
    const plan = dispatch(stateFor('conversational'))
    expect(plan).toEqual({
      class: 'conversational',
      runObserver: true,
      runOffloader: false,
    })
  })

  test('tool_heavy → offloader only', () => {
    const plan = dispatch(stateFor('tool_heavy'))
    expect(plan).toEqual({
      class: 'tool_heavy',
      runObserver: false,
      runOffloader: true,
    })
  })

  test('mixed → both observer and offloader', () => {
    const plan = dispatch(stateFor('mixed'))
    expect(plan).toEqual({
      class: 'mixed',
      runObserver: true,
      runOffloader: true,
    })
  })

  test('TRAJECTORY_CLASSIFIER=false uses configuredClass, ignores state.class', () => {
    const plan = dispatch(
      stateFor('conversational', { TRAJECTORY_CLASSIFIER: false }, 'tool_heavy'),
    )
    expect(plan.class).toBe('tool_heavy')
    expect(plan.runOffloader).toBe(true)
    expect(plan.runObserver).toBe(false)
  })

  test('observer and offloader are gated by their own feature flags', () => {
    const plan = dispatch(
      stateFor('mixed', { TASK_AWARE_EXTRACTION: false, TYPE_AWARE_OFFLOAD: false }),
    )
    expect(plan.class).toBe('mixed')
    expect(plan.runObserver).toBe(false)
    expect(plan.runOffloader).toBe(false)
  })

  test('TRAJECTORY_CLASSIFIER=false without configuredClass throws (force explicit config)', () => {
    expect(() =>
      dispatch({
        class: 'tool_heavy',
        flags: flagsWith({ TRAJECTORY_CLASSIFIER: false }),
      }),
    ).toThrow(/configuredClass/)
  })
})
