import type { ClassifierFeatures, TrajectoryClass } from './types.js'

const COLD_START_TURNS = 2
const CONV_SCORE_THRESHOLD = 0.6
const CONV_TOOL_CEILING = 0.3
const TOOL_SCORE_THRESHOLD = 0.5

function scores(features: ClassifierFeatures): { conv: number; tool: number } {
  const conv = (1 - features.tool_call_density) * features.user_turn_ratio
  const tool = features.tool_call_density * 0.5 + features.recent_tool_density * 0.5
  return { conv, tool }
}

export function classify(features: ClassifierFeatures): TrajectoryClass {
  if (features.turns_total < COLD_START_TURNS) return 'mixed'
  const { conv, tool } = scores(features)
  if (conv > CONV_SCORE_THRESHOLD && tool < CONV_TOOL_CEILING) return 'conversational'
  if (tool > TOOL_SCORE_THRESHOLD) return 'tool_heavy'
  return 'mixed'
}

const HYSTERESIS_THRESHOLD = 2

export type HysteresisState = {
  lastClass: TrajectoryClass
  pendingClass: TrajectoryClass | null
  pendingCount: number
}

export type HysteresisResult = {
  class: TrajectoryClass
  newState: HysteresisState
}

export function classifyWithHysteresis(
  features: ClassifierFeatures,
  prevState?: HysteresisState,
): HysteresisResult {
  const raw = classify(features)
  if (prevState === undefined) {
    return {
      class: raw,
      newState: { lastClass: raw, pendingClass: null, pendingCount: 0 },
    }
  }
  if (raw === prevState.lastClass) {
    return {
      class: raw,
      newState: { lastClass: raw, pendingClass: null, pendingCount: 0 },
    }
  }
  if (prevState.pendingClass === raw) {
    const newCount = prevState.pendingCount + 1
    if (newCount >= HYSTERESIS_THRESHOLD) {
      return {
        class: raw,
        newState: { lastClass: raw, pendingClass: null, pendingCount: 0 },
      }
    }
    return {
      class: prevState.lastClass,
      newState: { lastClass: prevState.lastClass, pendingClass: raw, pendingCount: newCount },
    }
  }
  return {
    class: prevState.lastClass,
    newState: { lastClass: prevState.lastClass, pendingClass: raw, pendingCount: 1 },
  }
}
