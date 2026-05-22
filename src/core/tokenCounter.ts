import type { ContentPart, Message } from './types.js'

export type ByteCounter = (parts: readonly ContentPart[]) => number
export type TokenCounter = (value: string) => number

export const byteLengthOfContent: ByteCounter = (parts) =>
  Buffer.byteLength(JSON.stringify(parts), 'utf8')

export const charsOver4TokenCounter: TokenCounter = (value) => Math.ceil(value.length / 4)

export function messageTokens(message: Message, counter: TokenCounter): number {
  return counter(JSON.stringify(message.content))
}
