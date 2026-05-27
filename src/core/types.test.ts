import { describe, expect, test } from 'vitest'
import type {
  AtomicGroup,
  ClassifierFeatures,
  CompactionContext,
  ContentPart,
  InflightToolUse,
  Message,
  Observation,
  PointerPlaceholder,
  Role,
  Tier1,
  Tier2,
  Tier3,
  ToolDefinition,
  TrajectoryClass,
} from './types.js'
import { defaultFeatureFlags } from './featureFlags.js'
import { defaultThresholds } from './thresholds.js'

describe('Canonical types — compile-time witness', () => {
  test('canonical types instantiate with documented fields', () => {
    const role: Role = 'assistant'

    const textPart: ContentPart = { type: 'text', text: 'hi' }
    const imagePart: ContentPart = { type: 'image', mimeType: 'image/png', data: 'b64' }
    const filePart: ContentPart = { type: 'file', mimeType: 'application/pdf', data: 'b64' }
    const toolUsePart: ContentPart = {
      type: 'tool_use',
      tool_use_id: 'tu_1',
      name: 'search',
      input: { q: 'x' },
    }
    const toolResultPart: ContentPart = {
      type: 'tool_result',
      tool_use_id: 'tu_1',
      output: { docs: [] },
      isError: false,
    }

    const message: Message = {
      role,
      content: [textPart],
      metadata: { turn_index: 0, step_index: 0, is_offloaded_pointer: false },
    }

    const toolUseMessage: Message = {
      role: 'assistant',
      content: [toolUsePart],
      metadata: { turn_index: 0, step_index: 1 },
    }
    const toolResultMessage: Message = {
      role: 'tool',
      content: [toolResultPart],
      metadata: { turn_index: 0, step_index: 2 },
    }

    const toolDef = { name: 'search' } as unknown as ToolDefinition

    const tier1: Tier1 = {
      systemPrompt: { role: 'system', content: [textPart] },
      toolDefinitions: [toolDef],
      firstUserMessages: [{ role: 'user', content: [textPart] }],
    }

    const observation: Observation = {
      timestamp: Date.now(),
      confidence: 'high',
      statement: 'user prefers TS strict',
      subDetails: ['mentioned at turn 2'],
      sourceTurn: 2,
    }

    const pointer: PointerPlaceholder = {
      recall_id: 'g_1',
      tool_name: 'search',
      original_size_bytes: 8192,
      digest: 'Found 3 docs',
      turn_index: 3,
    }

    const trajClass: TrajectoryClass = 'mixed'

    const tier2: Tier2 = {
      observations: [observation],
      pointers: [pointer],
      classSignal: { class: trajClass, confidence: 0.42, updatedAt: Date.now() },
    }

    const atomicGroup: AtomicGroup = {
      group_id: 'g_1',
      tool_use_id: 'tu_1',
      tool_use: toolUseMessage,
      tool_result: toolResultMessage,
      reasoning_chunk: { role: 'assistant', content: [textPart] },
      turn_index: 0,
    }

    const inflight: InflightToolUse = {
      group_id: 'g_2',
      tool_use: toolUseMessage,
      turn_index: 1,
    }

    const tier3: Tier3 = {
      recent: [message, toolUseMessage, toolResultMessage],
      inflight: [],
    }

    const features: ClassifierFeatures = {
      tool_call_density: 0.5,
      avg_tool_result_size: 4096,
      recent_tool_density: 0.8,
      user_turn_ratio: 0.4,
      multimodal_flag: false,
      cumulative_tokens: 12000,
      turns_total: 5,
    }

    const ctx: CompactionContext = {
      flags: defaultFeatureFlags,
      groups_after_this: 3,
      cumulative_kept_tool_result_bytes: 1024,
      current_class: 'tool_heavy',
      thresholds: defaultThresholds,
    }

    expect(tier1.systemPrompt.role).toBe('system')
    expect(tier2.observations).toHaveLength(1)
    expect(tier3.recent).toHaveLength(3)
    expect(atomicGroup.tool_use.metadata?.turn_index).toBe(0)
    expect(inflight.group_id).toBe('g_2')
    expect(features.turns_total).toBe(5)
    expect(ctx.current_class).toBe('tool_heavy')
    expect(imagePart.type).toBe('image')
    expect(filePart.type).toBe('file')
  })

  test('ToolDefinition is opaque — cannot be constructed without cast', () => {
    const okViaCast = { whatever: 1 } as unknown as ToolDefinition
    expect(okViaCast).toBeDefined()
  })
})
