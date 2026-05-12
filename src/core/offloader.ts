import { parseAtomicGroups } from './atomicGroup.js'
import { generateDigest, type DigestDeps, type ToolSchema } from './digest.js'
import type { LLMCaller } from './llm.js'
import type { ByteCounter } from './tokenCounter.js'
import type {
  AtomicGroup,
  CompactionContext,
  InflightToolUse,
  Message,
  PointerPlaceholder,
  Tier3,
} from './types.js'
import type { Scratchpad } from './scratchpad.js'

const ALWAYS_KEEP_LAST_GROUPS = 2

function sizeThresholdFor(ctx: CompactionContext): number {
  return ctx.current_class === 'mixed' ? ctx.thresholds.T_SIZE_MIXED : ctx.thresholds.T_SIZE
}

export function shouldOffload(
  group: AtomicGroup,
  ctx: CompactionContext,
  byteCounter: ByteCounter,
): boolean {
  if (ctx.groups_after_this < ALWAYS_KEEP_LAST_GROUPS) return false
  const size = byteCounter(group.tool_result.content)
  if (size > sizeThresholdFor(ctx)) return true
  if (ctx.cumulative_kept_tool_result_bytes + size > ctx.thresholds.T_CUM) return true
  return false
}

export type CompactWithOffloadDeps = {
  byteCounter: ByteCounter
  // Pulled into DigestDeps internally; flags come from CompactionContext.
  llmCaller?: LLMCaller
  toolSchema?: ToolSchema
}

export type OffloadResult = {
  tier3New: Tier3
  pointersAdded: PointerPlaceholder[]
}

function toolNameFromUse(toolUse: Message): string {
  const part = toolUse.content.find((p) => p.type === 'tool_use')
  return part?.type === 'tool_use' ? part.name : '<unknown>'
}

function buildPointerMessage(
  original: Message,
  pointer: PointerPlaceholder,
): Message {
  const part = original.content.find((p) => p.type === 'tool_result')
  if (part?.type !== 'tool_result') return original
  const stub = `[Offloaded tool_result #${pointer.recall_id} | tool=${pointer.tool_name} | size=${String(pointer.original_size_bytes)}B | digest: ${pointer.digest} | recall_id=${pointer.recall_id}]`
  return {
    role: original.role,
    content: [{ type: 'tool_result', tool_use_id: part.tool_use_id, output: stub }],
    metadata: { ...(original.metadata ?? { turn_index: 0, step_index: 0 }), is_offloaded_pointer: true },
  }
}

export async function compactWithOffload(
  tier3: Tier3,
  scratchpad: Scratchpad<AtomicGroup>,
  ctx: CompactionContext,
  deps: CompactWithOffloadDeps,
): Promise<OffloadResult> {
  const parsed = parseAtomicGroups(tier3.recent)
  const groups = parsed.groups
  const inflightFromParse: InflightToolUse[] = parsed.inflight

  const pointersAdded: PointerPlaceholder[] = []
  const replacements = new Map<Message, Message>()
  let cumulativeKept = ctx.cumulative_kept_tool_result_bytes

  for (let i = 0; i < groups.length; i++) {
    const group = groups[i]
    if (group === undefined) continue
    const groupsAfterThis = groups.length - i - 1
    const perGroupCtx: CompactionContext = {
      ...ctx,
      groups_after_this: groupsAfterThis,
      cumulative_kept_tool_result_bytes: cumulativeKept,
    }
    if (!shouldOffload(group, perGroupCtx, deps.byteCounter)) {
      cumulativeKept += deps.byteCounter(group.tool_result.content)
      continue
    }
    const digestDeps: DigestDeps = {
      flags: ctx.flags,
      ...(deps.llmCaller === undefined ? {} : { llmCaller: deps.llmCaller }),
      ...(deps.toolSchema === undefined ? {} : { toolSchema: deps.toolSchema }),
    }
    const digest = await generateDigest(group, digestDeps)
    const originalSize = deps.byteCounter(group.tool_result.content)
    const pointer: PointerPlaceholder = {
      recall_id: group.group_id,
      tool_name: toolNameFromUse(group.tool_use),
      original_size_bytes: originalSize,
      digest,
      turn_index: group.turn_index,
    }
    scratchpad.put(group.group_id, group)
    pointersAdded.push(pointer)
    replacements.set(group.tool_result, buildPointerMessage(group.tool_result, pointer))
  }

  const recentNew = tier3.recent.map((msg) => replacements.get(msg) ?? msg)
  const inflightNew: InflightToolUse[] = tier3.inflight.length > 0 ? tier3.inflight : inflightFromParse

  return {
    tier3New: { recent: recentNew, inflight: inflightNew },
    pointersAdded,
  }
}
