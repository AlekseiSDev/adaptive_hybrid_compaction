import { createHash } from 'node:crypto'
import type { AtomicGroup, ContentPart, InflightToolUse, Message } from './types.js'

export function hashAtomicGroupId(toolUseId: string, turnIndex: number): string {
  return createHash('sha256').update(`${toolUseId}:${String(turnIndex)}`).digest('hex').slice(0, 16)
}

type ToolUseRef = {
  message: Message
  messageIndex: number
  toolUseId: string
  turnIndex: number
}

export type ParseResult = {
  groups: AtomicGroup[]
  inflight: InflightToolUse[]
  orphans: Message[]
}

export function parseAtomicGroups(messages: Message[]): ParseResult {
  const toolUses = new Map<string, ToolUseRef>()
  messages.forEach((message, messageIndex) => {
    for (const part of message.content) {
      if (part.type === 'tool_use') {
        toolUses.set(part.tool_use_id, {
          message,
          messageIndex,
          toolUseId: part.tool_use_id,
          turnIndex: message.metadata?.turn_index ?? 0,
        })
      }
    }
  })

  const matched = new Set<string>()
  const groups: AtomicGroup[] = []
  const orphans: Message[] = []

  for (const message of messages) {
    for (const part of message.content) {
      if (part.type !== 'tool_result') continue
      const ref = toolUses.get(part.tool_use_id)
      if (!ref) {
        orphans.push(message)
        continue
      }
      matched.add(part.tool_use_id)
      groups.push(buildAtomicGroup(ref, message, messages))
    }
  }

  const inflight: InflightToolUse[] = []
  for (const [id, ref] of toolUses) {
    if (matched.has(id)) continue
    inflight.push({
      group_id: hashAtomicGroupId(id, ref.turnIndex),
      tool_use: ref.message,
      turn_index: ref.turnIndex,
    })
  }

  return { groups, inflight, orphans }
}

function buildAtomicGroup(ref: ToolUseRef, resultMessage: Message, messages: Message[]): AtomicGroup {
  const reasoning = findReasoningChunk(ref, messages)
  const base: AtomicGroup = {
    group_id: hashAtomicGroupId(ref.toolUseId, ref.turnIndex),
    tool_use: ref.message,
    tool_result: resultMessage,
    turn_index: ref.turnIndex,
  }
  return reasoning === undefined ? base : { ...base, reasoning_chunk: reasoning }
}

function findReasoningChunk(ref: ToolUseRef, messages: Message[]): Message | undefined {
  const sameMsgText = ref.message.content.filter(isTextPart)
  if (sameMsgText.length > 0) {
    return ref.message.metadata === undefined
      ? { role: ref.message.role, content: sameMsgText }
      : { role: ref.message.role, content: sameMsgText, metadata: ref.message.metadata }
  }
  const prev = messages[ref.messageIndex - 1]
  if (prev?.role === 'assistant' && prev.content.some(isTextPart)) {
    return prev
  }
  return undefined
}

function isTextPart(part: ContentPart): part is Extract<ContentPart, { type: 'text' }> {
  return part.type === 'text'
}
