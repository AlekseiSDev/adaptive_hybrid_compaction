import { SessionScratchpadRegistry } from '../../adapters';

export { SessionScratchpadRegistry } from '../../adapters';
export type { SessionId } from '../../adapters';

export const SESSION_REGISTRY = new SessionScratchpadRegistry();

const DEFAULT_MAX_PER_WINDOW = 30;
const DEFAULT_WINDOW_MS = 5 * 60 * 1000;

export type FetchRateLimiterOptions = {
  maxPerWindow?: number;
  windowMs?: number;
  clock?: () => number;
};

export class FetchRateLimiter {
  private readonly history = new Map<string, number[]>();
  private readonly maxPerWindow: number;
  private readonly windowMs: number;
  private readonly clock: () => number;

  constructor(opts: FetchRateLimiterOptions = {}) {
    this.maxPerWindow = opts.maxPerWindow ?? DEFAULT_MAX_PER_WINDOW;
    this.windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
    this.clock = opts.clock ?? Date.now;
  }

  tryConsume(sessionId: string): boolean {
    const now = this.clock();
    const cutoff = now - this.windowMs;
    const previous = this.history.get(sessionId) ?? [];
    const recent = previous.filter((t) => t > cutoff);
    if (recent.length >= this.maxPerWindow) {
      this.history.set(sessionId, recent);
      return false;
    }
    recent.push(now);
    this.history.set(sessionId, recent);
    return true;
  }
}

export const FETCH_RATE_LIMITER = new FetchRateLimiter();
