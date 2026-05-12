import type { FeatureFlags } from './featureFlags.js'
import type { TrajectoryClass } from './types.js'

export type DispatchState = {
  class: TrajectoryClass
  flags: FeatureFlags
  // Required when flags.TRAJECTORY_CLASSIFIER === false (per §3.3 disabled-mode).
  configuredClass?: TrajectoryClass
}

export type DispatchPlan = {
  class: TrajectoryClass
  runObserver: boolean
  runOffloader: boolean
}

const POLICY: Record<TrajectoryClass, { observer: boolean; offloader: boolean }> = {
  conversational: { observer: true, offloader: false },
  tool_heavy: { observer: false, offloader: true },
  mixed: { observer: true, offloader: true },
}

export function dispatch(state: DispatchState): DispatchPlan {
  const effectiveClass = state.flags.TRAJECTORY_CLASSIFIER
    ? state.class
    : (() => {
        if (state.configuredClass === undefined) {
          throw new Error(
            'dispatch: TRAJECTORY_CLASSIFIER=false requires state.configuredClass (§3.3 disabled-mode)',
          )
        }
        return state.configuredClass
      })()

  const policy = POLICY[effectiveClass]
  return {
    class: effectiveClass,
    runObserver: policy.observer && state.flags.TASK_AWARE_EXTRACTION,
    runOffloader: policy.offloader && state.flags.TYPE_AWARE_OFFLOAD,
  }
}
