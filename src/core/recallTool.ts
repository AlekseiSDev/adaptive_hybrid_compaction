// Two-stage recall tools (§6). Frozen literals — referential equality across
// calls keeps cache prefix stable (§6.2). Injection is no-op when scratchpad
// is empty so existing Tier-1 reference is preserved unchanged.
//
// K-tail-3 (2026-05-26): split single `recall_tool_result` into a summary/full
// pair. Rationale: lossy single-tier digest forced the actor to re-run the
// original tool when the digest was insufficient — costly and lossy. With
// explicit summary→raw escalation the actor pays only for what it needs.

import type { FeatureFlags } from './featureFlags.js'
import type { Scratchpad } from './scratchpad.js'
import type { AtomicGroup, Tier1, ToolDefinition } from './types.js'

const RECALL_PARAMS = Object.freeze({
  type: 'object',
  properties: Object.freeze({
    recall_id: Object.freeze({
      type: 'string',
      description: 'The G## id from a pointer placeholder',
    }),
    reason: Object.freeze({
      type: 'string',
      description: 'Brief why you need this (for logging)',
    }),
  }),
  required: Object.freeze(['recall_id', 'reason']),
})

export const recallSummaryToolDefinition: ToolDefinition = Object.freeze({
  __brand: 'ToolDefinition',
  name: 'recall_tool_summary',
  description:
    'Retrieve a content-aware summary of a previously offloaded tool result by recall_id. Cheap; try this first before recall_tool_full.',
  parameters: RECALL_PARAMS,
})

export const recallFullToolDefinition: ToolDefinition = Object.freeze({
  __brand: 'ToolDefinition',
  name: 'recall_tool_full',
  description:
    'Retrieve the raw full body of a previously offloaded tool result by recall_id. Use only if the summary from recall_tool_summary was insufficient.',
  parameters: RECALL_PARAMS,
})

export function injectRecallTool(
  tier1: Tier1,
  scratchpad: Scratchpad<AtomicGroup>,
  flags: FeatureFlags,
): Tier1 {
  if (!flags.RECALL_TOOL || scratchpad.size() === 0) return tier1
  return {
    ...tier1,
    toolDefinitions: [
      ...tier1.toolDefinitions,
      recallSummaryToolDefinition,
      recallFullToolDefinition,
    ],
  }
}
