import { afterEach, describe, expect, it } from "vitest";
import {
  demoRateLimitExceeded,
  rateLimitKeyOf,
  resetDemoRateLimitsForTests,
} from "./demo-rate-limit.js";

afterEach(() => {
  resetDemoRateLimitsForTests();
});

describe("demoRateLimitExceeded", () => {
  it("allows requests up to the window's max", () => {
    const now = 1_000;
    for (let i = 0; i < 5; i++) {
      expect(demoRateLimitExceeded("key", { windowMs: 1000, max: 5 }, now)).toBe(false);
    }
  });

  it("refuses once the max is exceeded within the window", () => {
    const now = 1_000;
    for (let i = 0; i < 5; i++) {
      demoRateLimitExceeded("key", { windowMs: 1000, max: 5 }, now);
    }
    expect(demoRateLimitExceeded("key", { windowMs: 1000, max: 5 }, now)).toBe(true);
  });

  it("resets once the window has elapsed", () => {
    const window = { windowMs: 1000, max: 2 };
    demoRateLimitExceeded("key", window, 0);
    demoRateLimitExceeded("key", window, 0);
    expect(demoRateLimitExceeded("key", window, 0)).toBe(true);
    expect(demoRateLimitExceeded("key", window, 1001)).toBe(false);
  });

  it("keeps separate counters per key", () => {
    const window = { windowMs: 1000, max: 1 };
    expect(demoRateLimitExceeded("a", window, 0)).toBe(false);
    expect(demoRateLimitExceeded("b", window, 0)).toBe(false);
    expect(demoRateLimitExceeded("a", window, 0)).toBe(true);
    expect(demoRateLimitExceeded("b", window, 0)).toBe(true);
  });
});

describe("rateLimitKeyOf", () => {
  function header(values: Record<string, string>) {
    return (name: string) => values[name.toLowerCase()];
  }

  it("reads the first X-Forwarded-For hop", () => {
    expect(rateLimitKeyOf(header({ "x-forwarded-for": "203.0.113.5, 10.0.0.1" }))).toBe(
      "203.0.113.5",
    );
  });

  it("falls back to X-Real-IP, then to a constant", () => {
    expect(rateLimitKeyOf(header({ "x-real-ip": "203.0.113.9" }))).toBe("203.0.113.9");
    expect(rateLimitKeyOf(header({}))).toBe("unknown");
  });
});
