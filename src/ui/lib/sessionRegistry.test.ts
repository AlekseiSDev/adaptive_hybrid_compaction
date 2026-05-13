import { describe, expect, it } from 'vitest';
import { FetchRateLimiter } from './sessionRegistry';

describe('FetchRateLimiter', () => {
  it('allows up to maxPerWindow consumes inside the window', () => {
    const now = 0;
    const limiter = new FetchRateLimiter({ maxPerWindow: 3, windowMs: 1000, clock: () => now });

    expect(limiter.tryConsume('s1')).toBe(true);
    expect(limiter.tryConsume('s1')).toBe(true);
    expect(limiter.tryConsume('s1')).toBe(true);
    expect(limiter.tryConsume('s1')).toBe(false);
  });

  it('refills after the window slides past old consumes', () => {
    let now = 0;
    const limiter = new FetchRateLimiter({ maxPerWindow: 2, windowMs: 1000, clock: () => now });

    expect(limiter.tryConsume('s1')).toBe(true);
    expect(limiter.tryConsume('s1')).toBe(true);
    expect(limiter.tryConsume('s1')).toBe(false);

    now = 1001;
    expect(limiter.tryConsume('s1')).toBe(true);
    expect(limiter.tryConsume('s1')).toBe(true);
    expect(limiter.tryConsume('s1')).toBe(false);
  });

  it('isolates sessions', () => {
    const now = 0;
    const limiter = new FetchRateLimiter({ maxPerWindow: 1, windowMs: 1000, clock: () => now });

    expect(limiter.tryConsume('a')).toBe(true);
    expect(limiter.tryConsume('a')).toBe(false);
    expect(limiter.tryConsume('b')).toBe(true);
    expect(limiter.tryConsume('b')).toBe(false);
  });

  it('uses sane defaults (30 calls / 5min)', () => {
    const limiter = new FetchRateLimiter();
    let count = 0;
    while (limiter.tryConsume('s1')) count++;
    expect(count).toBe(30);
  });
});
