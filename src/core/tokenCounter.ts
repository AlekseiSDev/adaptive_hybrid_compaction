import type { ContentPart } from './types.js'

export type ByteCounter = (parts: readonly ContentPart[]) => number
export type TokenCounter = (value: string) => number

export const byteLengthOfContent: ByteCounter = (parts) =>
  Buffer.byteLength(JSON.stringify(parts), 'utf8')

export const charsOver4TokenCounter: TokenCounter = (value) => Math.ceil(value.length / 4)
