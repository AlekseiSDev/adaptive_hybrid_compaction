import { describe, expect, test } from 'vitest'
import { SessionScratchpadRegistry } from './sessionScratchpad.js'

describe('SessionScratchpadRegistry — A6 session lifecycle', () => {
  test('get for new sessionId creates an empty scratchpad', () => {
    const reg = new SessionScratchpadRegistry()
    const pad = reg.get('s1', 0)
    expect(pad.size()).toBe(0)
    expect(reg.size()).toBe(1)
  })

  test('get for existing sessionId returns same reference and updates lastAccess', () => {
    const reg = new SessionScratchpadRegistry()
    const first = reg.get('s1', 100)
    const second = reg.get('s1', 200)
    expect(second).toBe(first)
    // touch already happens inside get; idle for 0 ms at time 200
    expect(reg.evictIdle(200)).toBe(0)
  })

  test('evictIdle removes entries older than ttl and returns count', () => {
    const reg = new SessionScratchpadRegistry({ ttlMs: 1000 })
    reg.get('s1', 0)
    reg.get('s2', 0)
    reg.get('s3', 500)
    // At now=1500, s1 and s2 are 1500ms idle (> ttl), s3 is 1000ms (== ttl, not yet)
    const evicted = reg.evictIdle(1500)
    expect(evicted).toBe(2)
    expect(reg.size()).toBe(1)
  })

  test('evictIdle does not touch recent entries', () => {
    const reg = new SessionScratchpadRegistry({ ttlMs: 1000 })
    reg.get('s1', 0)
    reg.get('s2', 800)
    const evicted = reg.evictIdle(1500)
    // s1 idle 1500ms > 1000 ms ttl → evicted. s2 idle 700ms → kept.
    expect(evicted).toBe(1)
    expect(reg.size()).toBe(1)
  })
})
