import { describe, expect, test } from 'vitest'
import {
  byteLengthOfContent,
  charsOver4TokenCounter,
  type ByteCounter,
  type TokenCounter,
} from './tokenCounter.js'
import type { ContentPart } from './types.js'

describe('byteLengthOfContent', () => {
  test('is deterministic across repeated calls', () => {
    const parts: ContentPart[] = [{ type: 'text', text: 'hello world' }]
    expect(byteLengthOfContent(parts)).toBe(byteLengthOfContent(parts))
  })

  test('counts UTF-8 bytes, not chars (multi-byte sequences exceed char count)', () => {
    const parts: ContentPart[] = [{ type: 'text', text: 'привет' }]
    const bytes = byteLengthOfContent(parts)
    expect(bytes).toBeGreaterThan('привет'.length)
  })

  test('conforms to ByteCounter type', () => {
    const counter: ByteCounter = byteLengthOfContent
    expect(counter([{ type: 'text', text: 'x' }])).toBeGreaterThan(0)
  })
})

describe('charsOver4TokenCounter', () => {
  test('returns 1 for 4-char string', () => {
    expect(charsOver4TokenCounter('1234')).toBe(1)
  })

  test('rounds up', () => {
    expect(charsOver4TokenCounter('12345')).toBe(2)
  })

  test('handles empty string', () => {
    expect(charsOver4TokenCounter('')).toBe(0)
  })

  test('conforms to TokenCounter type', () => {
    const counter: TokenCounter = charsOver4TokenCounter
    expect(counter('hello world')).toBeGreaterThan(0)
  })
})
