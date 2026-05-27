import { parseAtomicGroups } from './atomicGroup.js'
import { generateDigest, type DigestDeps, type ToolSchema } from './digest.js'
import type { LLMCaller } from './llm.js'
import type { ByteCounter } from './tokenCounter.js'
import type {
  AtomicGroup,
  CompactionContext,
  ContentPart,
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

// Returns the specific tool_result content part for this atomic group's
// tool_use_id. A tool message can carry multiple tool_result parts (parallel
// tool calls return as parts of one tool message), so size / replacement
// decisions must be made per part, not per message.
function partForGroup(
  group: AtomicGroup,
): Extract<ContentPart, { type: 'tool_result' }> | undefined {
  return group.tool_result.content.find(
    (p): p is Extract<ContentPart, { type: 'tool_result' }> =>
      p.type === 'tool_result' && p.tool_use_id === group.tool_use_id,
  )
}

function groupResultBytes(group: AtomicGroup, byteCounter: ByteCounter): number {
  const part = partForGroup(group)
  return part === undefined ? 0 : byteCounter([part])
}

function groupToolName(group: AtomicGroup): string {
  const part = group.tool_use.content.find(
    (p): p is Extract<ContentPart, { type: 'tool_use' }> =>
      p.type === 'tool_use' && p.tool_use_id === group.tool_use_id,
  )
  return part?.name ?? '<unknown>'
}

export function shouldOffload(
  group: AtomicGroup,
  ctx: CompactionContext,
  byteCounter: ByteCounter,
): boolean {
  if (ctx.groups_after_this < ALWAYS_KEEP_LAST_GROUPS) return false
  const size = groupResultBytes(group, byteCounter)
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

function buildPointerPart(
  group: AtomicGroup,
  pointer: PointerPlaceholder,
): Extract<ContentPart, { type: 'tool_result' }> | undefined {
  const part = partForGroup(group)
  if (part === undefined) return undefined
  // K-tail-3 (2026-05-26): pointer stub no longer carries the digest inline.
  // The summary lives behind recall_tool_summary(<id>); raw body behind
  // recall_tool_full(<id>). Stub mentions both tools by name so the actor
  // sees the recall path even without re-reading the system note.
  const stub = `[Offloaded #${pointer.recall_id} tool=${pointer.tool_name} size=${String(pointer.original_size_bytes)}B — summary: recall_tool_summary(${pointer.recall_id}); raw: recall_tool_full(${pointer.recall_id})]`
  return { type: 'tool_result', tool_use_id: part.tool_use_id, output: stub }
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
  // K-tail-3 fix (2026-05-27): per-part replacement (was per-message).
  // Outer key: the original tool message; inner key: the specific tool_use_id
  // of the part being replaced; value: the pointer-stub part. This preserves
  // sibling tool_result parts in messages carrying parallel-tool-call results
  // — the previous `Map<Message, Message>` design dropped all-but-one part
  // because `replacements.set(M, ...)` overwrote itself for siblings.
  const partReplacements = new Map<Message, Map<string, ContentPart>>()
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
      cumulativeKept += groupResultBytes(group, deps.byteCounter)
      continue
    }
    const digestDeps: DigestDeps = {
      flags: ctx.flags,
      ...(deps.llmCaller === undefined ? {} : { llmCaller: deps.llmCaller }),
      ...(deps.toolSchema === undefined ? {} : { toolSchema: deps.toolSchema }),
    }
    const digest = await generateDigest(group, digestDeps)
    const originalSize = groupResultBytes(group, deps.byteCounter)
    const pointer: PointerPlaceholder = {
      recall_id: group.group_id,
      tool_name: groupToolName(group),
      original_size_bytes: originalSize,
      digest,
      turn_index: group.turn_index,
    }
    const replacementPart = buildPointerPart(group, pointer)
    if (replacementPart === undefined) continue
    scratchpad.put(group.group_id, group)
    pointersAdded.push(pointer)
    let inner = partReplacements.get(group.tool_result)
    if (inner === undefined) {
      inner = new Map<string, ContentPart>()
      partReplacements.set(group.tool_result, inner)
    }
    inner.set(group.tool_use_id, replacementPart)
  }

  const recentNew = tier3.recent.map((msg) => {
    const inner = partReplacements.get(msg)
    if (inner === undefined) return msg
    const newContent: ContentPart[] = msg.content.map((p) => {
      if (p.type !== 'tool_result') return p
      return inner.get(p.tool_use_id) ?? p
    })
    return {
      role: msg.role,
      content: newContent,
      metadata: {
        ...(msg.metadata ?? { turn_index: 0, step_index: 0 }),
        is_offloaded_pointer: true,
      },
    }
  })
  const inflightNew: InflightToolUse[] = tier3.inflight.length > 0 ? tier3.inflight : inflightFromParse

  return {
    tier3New: { recent: recentNew, inflight: inflightNew },
    pointersAdded,
  }
}
