// Recall tool (§6). Frozen literal — referential equality across calls keeps
// cache prefix stable (§6.2). Injection is no-op when not needed so existing
// Tier-1 reference is preserved unchanged.
import type { FeatureFlags } from './featureFlags.js'
import type { Scratchpad } from './scratchpad.js'
import type { AtomicGroup, Tier1, ToolDefinition } from './types.js'

export const recallToolDefinition: ToolDefinition = Object.freeze({
  __brand: 'ToolDefinition',
  name: 'recall_tool_result',
  description:
    'Retrieve a previously offloaded tool result by its recall_id. Use when you need exact data from an earlier tool call (the pointer/digest in context is insufficient for current reasoning).',
  parameters: Object.freeze({
    type: 'object',
    properties: Object.freeze({
      recall_id: Object.freeze({
        type: 'string',
        description: 'The G## id from a pointer placeholder',
      }),
      reason: Object.freeze({
        type: 'string',
        description: 'Brief why you need full data (for logging)',
      }),
    }),
    required: Object.freeze(['recall_id', 'reason']),
  }),
})

export function injectRecallTool(
  tier1: Tier1,
  scratchpad: Scratchpad<AtomicGroup>,
  flags: FeatureFlags,
): Tier1 {
  if (!flags.RECALL_TOOL || scratchpad.size() === 0) return tier1
  return {
    ...tier1,
    toolDefinitions: [...tier1.toolDefinitions, recallToolDefinition],
  }
}
