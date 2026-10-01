import { describe, expect, it } from "vitest";
import {
  API_KEY_RATE_LIMIT,
  API_KEY_RATE_WINDOW_MS,
  SlidingWindowRateLimiter,
  advanceWindow,
  estimatedCount,
} from "./rate-limit.js";

const W = API_KEY_RATE_WINDOW_MS;
/** A window-aligned origin, so offsets below read as "ms into the window". */
const T0 = W * 1000;

function burst(limiter: SlidingWindowRateLimiter, key: string, n: number, at: number) {
  let last = limiter.consume(key, at);
  for (let i = 1; i < n; i++) {
    last = limiter.consume(key, at);
  }
  return last;
}

describe("SlidingWindowRateLimiter", () => {
  it("defaults to 600 requests per 10 minutes", () => {
    const limiter = new SlidingWindowRateLimiter();
    expect(limiter.limit).toBe(600);
    expect(limiter.windowMs).toBe(600_000);
    expect(API_KEY_RATE_LIMIT).toBe(600);
  });

  it("allows the limit, then refuses with a retry hint", () => {
    const limiter = new SlidingWindowRateLimiter();
    const last = burst(limiter, "k", 600, T0 + 1000);
    expect(last.allowed).toBe(true);
    expect(last.remaining).toBe(0);
    const denied = limiter.consume("k", T0 + 1000);
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
    expect(denied.retryAfterMs).toBeGreaterThan(0);
  });

  it("counts remaining requests down", () => {
    const limiter = new SlidingWindowRateLimiter(10, W);
    expect(limiter.consume("k", T0).remaining).toBe(9);
    expect(limiter.consume("k", T0).remaining).toBe(8);
    expect(limiter.consume("k", T0).resetMs).toBe(W);
  });

  it("keeps keys apart", () => {
    const limiter = new SlidingWindowRateLimiter(1, W);
    expect(limiter.consume("a", T0).allowed).toBe(true);
    expect(limiter.consume("b", T0).allowed).toBe(true);
    expect(limiter.consume("a", T0).allowed).toBe(false);
  });

  it("does not allow a double burst across a window boundary", () => {
    const limiter = new SlidingWindowRateLimiter(10, W);
    burst(limiter, "k", 10, T0 + W - 1000);
    // Just after the boundary nearly the whole previous window still counts.
    expect(limiter.consume("k", T0 + W + 1000).allowed).toBe(false);
  });

  it("frees capacity as the previous window slides out", () => {
    const limiter = new SlidingWindowRateLimiter(10, W);
    burst(limiter, "k", 10, T0);
    // Halfway through the next window half of the old requests still count.
    const half = T0 + W + W / 2;
    for (let i = 0; i < 5; i++) {
      expect(limiter.consume("k", half).allowed).toBe(true);
    }
    expect(limiter.consume("k", half).allowed).toBe(false);
    // Two windows later everything has slid out.
    expect(limiter.consume("k", T0 + 3 * W).remaining).toBe(9);
  });

  it("names a retry time at which the request is allowed, and not earlier", () => {
    const scenarios = [
      { limit: 10, fill: [[T0, 10]], at: T0 + 5000 },
      { limit: 10, fill: [[T0 + W - 1, 10]], at: T0 + W + 1000 },
      {
        limit: 10,
        fill: [
          [T0, 6],
          [T0 + W + 100, 4],
        ],
        at: T0 + W + 200,
      },
      { limit: 600, fill: [[T0 + 30_000, 600]], at: T0 + 60_000 },
    ] as const;
    for (const scenario of scenarios) {
      const limiter = new SlidingWindowRateLimiter(scenario.limit, W);
      for (const [at, n] of scenario.fill) {
        burst(limiter, "k", n, at);
      }
      const denied = limiter.consume("k", scenario.at);
      expect(denied.allowed).toBe(false);

      const probe = (offset: number) => {
        const copy = new SlidingWindowRateLimiter(scenario.limit, W);
        for (const [at, n] of scenario.fill) {
          burst(copy, "k", n, at);
        }
        return copy.consume("k", scenario.at + offset).allowed;
      };
      expect(probe(denied.retryAfterMs)).toBe(true);
      expect(probe(denied.retryAfterMs - 2)).toBe(false);
    }
  });

  it("validates its configuration", () => {
    expect(() => new SlidingWindowRateLimiter(0, W)).toThrow(RangeError);
    expect(() => new SlidingWindowRateLimiter(1.5, W)).toThrow(RangeError);
    expect(() => new SlidingWindowRateLimiter(10, 0)).toThrow(RangeError);
  });

  it("forgets keys on reset", () => {
    const limiter = new SlidingWindowRateLimiter(1, W);
    limiter.consume("a", T0);
    limiter.consume("b", T0);
    limiter.reset("a");
    expect(limiter.size()).toBe(1);
    expect(limiter.consume("a", T0).allowed).toBe(true);
    limiter.reset();
    expect(limiter.size()).toBe(0);
  });

  it("prunes keys that have been idle for two windows", () => {
    const limiter = new SlidingWindowRateLimiter(10_000, W);
    limiter.consume("idle", T0);
    for (let i = 0; i < 999; i++) {
      limiter.consume("busy", T0 + 3 * W);
    }
    expect(limiter.size()).toBe(1);
  });
});

describe("window arithmetic", () => {
  it("carries the current count into the next window and drops older ones", () => {
    const state = { windowStart: T0, current: 7, previous: 3 };
    expect(advanceWindow(state, T0 + 10, W)).toBe(state);
    expect(advanceWindow(state, T0 + W, W)).toEqual({
      windowStart: T0 + W,
      current: 0,
      previous: 7,
    });
    expect(advanceWindow(state, T0 + 2 * W, W)).toEqual({
      windowStart: T0 + 2 * W,
      current: 0,
      previous: 0,
    });
  });

  it("weights the previous window by its remaining overlap", () => {
    const state = { windowStart: T0, current: 2, previous: 10 };
    expect(estimatedCount(state, T0, W)).toBe(12);
    expect(estimatedCount(state, T0 + W / 2, W)).toBe(7);
    expect(estimatedCount(state, T0 + (3 * W) / 4, W)).toBe(4.5);
  });
});
