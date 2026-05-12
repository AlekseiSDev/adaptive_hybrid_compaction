import { describe, expect, test } from 'vitest'
import { classify, classifyWithHysteresis, type HysteresisState } from './classifier.js'
import type { ClassifierFeatures, TrajectoryClass } from './types.js'

const features = (overrides: Partial<ClassifierFeatures> = {}): ClassifierFeatures => ({
  tool_call_density: 0,
  avg_tool_result_size: 0,
  recent_tool_density: 0,
  user_turn_ratio: 0.5,
  multimodal_flag: false,
  cumulative_tokens: 0,
  turns_total: 5,
  ...overrides,
})

describe('classify (rules per §3.2)', () => {
  test('turns_total < 2 returns mixed (cold start)', () => {
    expect(classify(features({ turns_total: 0 }))).toBe('mixed')
    expect(classify(features({ turns_total: 1 }))).toBe('mixed')
  })

  test('high conv_score and low tool_score → conversational', () => {
    // conv_score = (1 - 0.1) * 0.8 = 0.72 (> 0.6), tool_score = 0.1*0.5 + 0.1*0.5 = 0.1 (< 0.3)
    const f = features({ tool_call_density: 0.1, recent_tool_density: 0.1, user_turn_ratio: 0.8 })
    expect(classify(f)).toBe('conversational')
  })

  test('high tool_score → tool_heavy', () => {
    // tool_score = 0.8*0.5 + 0.8*0.5 = 0.8 (> 0.5)
    const f = features({ tool_call_density: 0.8, recent_tool_density: 0.8, user_turn_ratio: 0.3 })
    expect(classify(f)).toBe('tool_heavy')
  })

  test('neither rule fires → mixed', () => {
    // conv_score = (1 - 0.4) * 0.5 = 0.3 (< 0.6); tool_score = 0.4*0.5 + 0.4*0.5 = 0.4 (< 0.5)
    const f = features({ tool_call_density: 0.4, recent_tool_density: 0.4, user_turn_ratio: 0.5 })
    expect(classify(f)).toBe('mixed')
  })
})

const toolHeavy = features({
  tool_call_density: 0.8,
  recent_tool_density: 0.8,
  user_turn_ratio: 0.3,
})
const conversational = features({
  tool_call_density: 0.1,
  recent_tool_density: 0.1,
  user_turn_ratio: 0.8,
})
const mixedFeatures = features({
  tool_call_density: 0.4,
  recent_tool_density: 0.4,
  user_turn_ratio: 0.5,
})

const stateFrom = (lastClass: TrajectoryClass): HysteresisState => ({
  lastClass,
  pendingClass: null,
  pendingCount: 0,
})

describe('classifyWithHysteresis', () => {
  test('cold start (no prevState) returns raw classify', () => {
    const { class: cls, newState } = classifyWithHysteresis(toolHeavy)
    expect(cls).toBe('tool_heavy')
    expect(newState.lastClass).toBe('tool_heavy')
    expect(newState.pendingClass).toBeNull()
    expect(newState.pendingCount).toBe(0)
  })

  test('single dissenting turn does not flip class', () => {
    const start = stateFrom('conversational')
    const { class: cls, newState } = classifyWithHysteresis(toolHeavy, start)
    expect(cls).toBe('conversational')
    expect(newState.lastClass).toBe('conversational')
    expect(newState.pendingClass).toBe('tool_heavy')
    expect(newState.pendingCount).toBe(1)
  })

  test('two consecutive dissenting turns flip the class', () => {
    const first = classifyWithHysteresis(toolHeavy, stateFrom('conversational'))
    expect(first.class).toBe('conversational')
    const second = classifyWithHysteresis(toolHeavy, first.newState)
    expect(second.class).toBe('tool_heavy')
    expect(second.newState.lastClass).toBe('tool_heavy')
    expect(second.newState.pendingClass).toBeNull()
    expect(second.newState.pendingCount).toBe(0)
  })

  test('bidirectional: two consecutive conversational turns flip back from tool_heavy', () => {
    const first = classifyWithHysteresis(conversational, stateFrom('tool_heavy'))
    expect(first.class).toBe('tool_heavy')
    const second = classifyWithHysteresis(conversational, first.newState)
    expect(second.class).toBe('conversational')
  })

  test('inconsistent intermediate turn resets pendingCount for prior candidate', () => {
    // Setup: pending tool_heavy with count=1, last=conversational
    let state: HysteresisState = {
      lastClass: 'conversational',
      pendingClass: 'tool_heavy',
      pendingCount: 1,
    }
    // Intermediate turn produces 'mixed' (neither matches prior pending)
    const interim = classifyWithHysteresis(mixedFeatures, state)
    expect(interim.class).toBe('conversational')
    // Prior tool_heavy streak is broken — new pending is 'mixed' with count 1
    expect(interim.newState.pendingClass).toBe('mixed')
    expect(interim.newState.pendingCount).toBe(1)
    state = interim.newState
    // Now even a second tool_heavy starts fresh, doesn't immediately flip
    const followUp = classifyWithHysteresis(toolHeavy, state)
    expect(followUp.class).toBe('conversational')
    expect(followUp.newState.pendingClass).toBe('tool_heavy')
    expect(followUp.newState.pendingCount).toBe(1)
  })
})
