import type {
  LanguageModelV3FilePart,
  LanguageModelV3Message,
  LanguageModelV3Prompt,
  LanguageModelV3TextPart,
  LanguageModelV3ToolCallPart,
  LanguageModelV3ToolResultOutput,
  LanguageModelV3ToolResultPart,
} from '@ai-sdk/provider'
import type { ContentPart, Message } from '../core/index.js'

function coreContentToSdkText(content: readonly ContentPart[]): string {
  // System messages: collapse all text parts into a single string. Drop non-text
  // (system messages don't carry tool calls / files in practice).
  return content
    .filter((p): p is Extract<ContentPart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('\n')
}

function corePartToSdkAssistantPart(
  part: ContentPart,
):
  | LanguageModelV3TextPart
  | LanguageModelV3FilePart
  | LanguageModelV3ToolCallPart
  | null {
  switch (part.type) {
    case 'text':
      return { type: 'text', text: part.text }
    case 'image':
      return { type: 'file', mediaType: part.mimeType, data: part.data }
    case 'file':
      return { type: 'file', mediaType: part.mimeType, data: part.data }
    case 'tool_use':
      return {
        type: 'tool-call',
        toolCallId: part.tool_use_id,
        toolName: part.name,
        input: part.input,
      }
    case 'tool_result':
      // Belongs to a tool message, not assistant — skip here.
      return null
  }
}

function corePartToSdkUserPart(
  part: ContentPart,
): LanguageModelV3TextPart | LanguageModelV3FilePart | null {
  switch (part.type) {
    case 'text':
      return { type: 'text', text: part.text }
    case 'image':
      return { type: 'file', mediaType: part.mimeType, data: part.data }
    case 'file':
      return { type: 'file', mediaType: part.mimeType, data: part.data }
    case 'tool_use':
    case 'tool_result':
      return null
  }
}

function corePartToSdkToolPart(part: ContentPart): LanguageModelV3ToolResultPart | null {
  if (part.type !== 'tool_result') return null
  const output: LanguageModelV3ToolResultOutput =
    typeof part.output === 'string'
      ? { type: 'text', value: part.output }
      : { type: 'json', value: part.output as LanguageModelV3ToolResultOutput extends { value: infer V } ? V : never }
  return {
    type: 'tool-result',
    toolCallId: part.tool_use_id,
    toolName: '',
    output,
  }
}

export function convertCoreMessagesToSdk(messages: readonly Message[]): LanguageModelV3Prompt {
  const out: LanguageModelV3Message[] = []
  for (const m of messages) {
    switch (m.role) {
      case 'system':
        out.push({ role: 'system', content: coreContentToSdkText(m.content) })
        break
      case 'user': {
        const parts = m.content
          .map(corePartToSdkUserPart)
          .filter((p): p is LanguageModelV3TextPart | LanguageModelV3FilePart => p !== null)
        out.push({ role: 'user', content: parts })
        break
      }
      case 'assistant': {
        const parts = m.content
          .map(corePartToSdkAssistantPart)
          .filter(
            (p): p is LanguageModelV3TextPart | LanguageModelV3FilePart | LanguageModelV3ToolCallPart =>
              p !== null,
          )
        out.push({ role: 'assistant', content: parts })
        break
      }
      case 'tool': {
        const parts = m.content
          .map(corePartToSdkToolPart)
          .filter((p): p is LanguageModelV3ToolResultPart => p !== null)
        out.push({ role: 'tool', content: parts })
        break
      }
    }
  }
  return out
}

function sdkToolOutputToCore(output: LanguageModelV3ToolResultOutput): unknown {
  switch (output.type) {
    case 'text':
      return output.value
    case 'json':
      return output.value
    case 'error-text':
    case 'error-json':
      return output.value
    case 'execution-denied':
      return { __denied: true, reason: output.reason }
    case 'content':
      return output.value
  }
}

function sdkUserPartToCore(
  part: LanguageModelV3TextPart | LanguageModelV3FilePart,
): ContentPart {
  if (part.type === 'text') return { type: 'text', text: part.text }
  // File part data may be Uint8Array | string | URL; for core we store string only.
  const data = typeof part.data === 'string' ? part.data : String(part.data)
  return { type: 'file', mimeType: part.mediaType, data }
}

export function convertSdkPromptToCore(prompt: LanguageModelV3Prompt): Message[] {
  const out: Message[] = []
  for (const m of prompt) {
    switch (m.role) {
      case 'system':
        out.push({ role: 'system', content: [{ type: 'text', text: m.content }] })
        break
      case 'user':
        out.push({
          role: 'user',
          content: m.content.map(sdkUserPartToCore),
        })
        break
      case 'assistant': {
        const content: ContentPart[] = []
        for (const part of m.content) {
          switch (part.type) {
            case 'text':
              content.push({ type: 'text', text: part.text })
              break
            case 'file':
              content.push({
                type: 'file',
                mimeType: part.mediaType,
                data: typeof part.data === 'string' ? part.data : String(part.data),
              })
              break
            case 'tool-call':
              content.push({
                type: 'tool_use',
                tool_use_id: part.toolCallId,
                name: part.toolName,
                input: part.input,
              })
              break
            case 'tool-result':
              content.push({
                type: 'tool_result',
                tool_use_id: part.toolCallId,
                output: sdkToolOutputToCore(part.output),
              })
              break
            case 'reasoning':
              content.push({ type: 'text', text: part.text })
              break
          }
        }
        out.push({ role: 'assistant', content })
        break
      }
      case 'tool': {
        const content: ContentPart[] = []
        for (const part of m.content) {
          if (part.type === 'tool-result') {
            content.push({
              type: 'tool_result',
              tool_use_id: part.toolCallId,
              output: sdkToolOutputToCore(part.output),
            })
          }
          // tool-approval-response is ignored — core has no analogue.
        }
        out.push({ role: 'tool', content })
        break
      }
    }
  }
  return out
}
