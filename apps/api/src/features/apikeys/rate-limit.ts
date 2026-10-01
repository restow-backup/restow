/**
 * Per-key request limit: 600 requests per 10 minutes
 * (docs/ARCHITECTURE.md, "API").
 *
 * A sliding-window counter: the count of the current fixed window plus the
 * previous window's count weighted by how much of it still overlaps the
 * sliding window. Unlike a fixed window it does not allow a double burst at a
 * window boundary, and unlike a request log it needs two integers per key.
 * State is per API process; Restow runs a single API instance per
 * installation (docs/ARCHITECTURE.md, Betrieb).
 */

export const API_KEY_RATE_LIMIT = 600;
export const API_KEY_RATE_WINDOW_MS = 10 * 60 * 1000;

export interface RateWindowState {
  /** Start of the current fixed window (ms since epoch, aligned to the window size). */
  windowStart: number;
  current: number;
  previous: number;
}

export interface RateDecision {
  allowed: boolean;
  limit: number;
  /** Requests still available right now (after this one, when allowed). */
  remaining: number;
  /** Milliseconds until the current fixed window ends. */
  resetMs: number;
  /** When denied: milliseconds until a request would be allowed again; 0 otherwise. */
  retryAfterMs: number;
}

/** Move a state forward to the window containing `now`. */
export function advanceWindow(
  state: RateWindowState | undefined,
  now: number,
  windowMs: number,
): RateWindowState {
  const windowStart = Math.floor(now / windowMs) * windowMs;
  if (!state) {
    return { windowStart, current: 0, previous: 0 };
  }
  if (state.windowStart === windowStart) {
    return state;
  }
  const previous = state.windowStart === windowStart - windowMs ? state.current : 0;
  return { windowStart, current: 0, previous };
}

/** Requests counted against the sliding window ending at `now`. */
export function estimatedCount(state: RateWindowState, now: number, windowMs: number): number {
  const elapsed = now - state.windowStart;
  // Multiply before dividing: exact for integral inputs at the boundaries.
  return (state.previous * (windowMs - elapsed)) / windowMs + state.current;
}

/**
 * How long until one more request fits, for a state that is currently full.
 * Either the previous window's weight decays enough within this window, or
 * the current window becomes the (decaying) previous one.
 */
export function retryAfterMs(
  state: RateWindowState,
  now: number,
  limit: number,
  windowMs: number,
): number {
  const elapsed = now - state.windowStart;
  const untilWindowEnd = windowMs - elapsed;
  const headroom = limit - 1 - state.current;
  if (headroom >= 0 && state.previous > 0) {
    // previous * (W - elapsed - t) / W + current + 1 <= limit
    const wait = untilWindowEnd - (headroom * windowMs) / state.previous;
    if (wait < untilWindowEnd) {
      return Math.max(1, Math.ceil(wait));
    }
  }
  // In the next window the current count decays: current * (W - e') / W + 1 <= limit.
  const into = state.current > limit - 1 ? windowMs * (1 - (limit - 1) / state.current) : 0;
  return Math.max(1, Math.ceil(untilWindowEnd + into));
}

export class SlidingWindowRateLimiter {
  private readonly states = new Map<string, RateWindowState>();
  private calls = 0;

  constructor(
    readonly limit: number = API_KEY_RATE_LIMIT,
    readonly windowMs: number = API_KEY_RATE_WINDOW_MS,
  ) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError("rate limit must be a positive integer");
    }
    if (!(windowMs > 0)) {
      throw new RangeError("rate window must be positive");
    }
  }

  /** Count one request for `key` at `now` and decide whether it may proceed. */
  consume(key: string, now: number): RateDecision {
    this.pruneOccasionally(now);
    const state = advanceWindow(this.states.get(key), now, this.windowMs);
    const resetMs = state.windowStart + this.windowMs - now;
    const estimate = estimatedCount(state, now, this.windowMs);
    if (estimate + 1 > this.limit) {
      this.states.set(key, state);
      return {
        allowed: false,
        limit: this.limit,
        remaining: 0,
        resetMs,
        retryAfterMs: retryAfterMs(state, now, this.limit, this.windowMs),
      };
    }
    const next = { ...state, current: state.current + 1 };
    this.states.set(key, next);
    return {
      allowed: true,
      limit: this.limit,
      remaining: Math.max(0, Math.floor(this.limit - estimate - 1)),
      resetMs,
      retryAfterMs: 0,
    };
  }

  /** Forget every key (tests, and a revoked key never needs its counters). */
  reset(key?: string): void {
    if (key === undefined) {
      this.states.clear();
    } else {
      this.states.delete(key);
    }
  }

  /** Number of keys with state (for tests). */
  size(): number {
    return this.states.size;
  }

  /** Drop keys idle for two full windows, so the map stays as small as the active key set. */
  private pruneOccasionally(now: number): void {
    this.calls += 1;
    if (this.calls % 1000 !== 0) {
      return;
    }
    const cutoff = now - 2 * this.windowMs;
    for (const [key, state] of this.states) {
      if (state.windowStart < cutoff) {
        this.states.delete(key);
      }
    }
  }
}
