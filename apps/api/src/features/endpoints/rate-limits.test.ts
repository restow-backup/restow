import { describe, expect, it } from "vitest";
import { SlidingWindowRateLimiter } from "../apikeys/rate-limit.js";
import { AGENT_API_LIMIT, TEN_MINUTES_MS } from "./rate-limits.js";

/**
 * The agent reports the progress of a run every 5 seconds (agent/internal/core, 0.2.0), which
 * doubles what 0.1.x sent. The limit of the agent API must admit that, with everything else an
 * agent sends, for runs of any length.
 */

const SECOND = 1000;

/** The calls of one agent during a run that lasts `runSeconds`, as (second, kind), in time order. */
function agentCalls(runSeconds: number, progressEverySeconds: number) {
  const calls: { at: number; kind: string }[] = [{ at: 0, kind: "config" }];
  calls.push({ at: 1, kind: "run-start" });
  for (let at = progressEverySeconds; at < runSeconds; at += progressEverySeconds) {
    calls.push({ at, kind: "progress" });
  }
  for (let at = 0; at < runSeconds; at += 5 * 60) {
    calls.push({ at, kind: "heartbeat" });
  }
  calls.push({ at: runSeconds, kind: "run-finish" });
  return calls.sort((a, b) => a.at - b.at);
}

function refusedAfter(limit: number, runSeconds: number, progressEverySeconds: number): number {
  const limiter = new SlidingWindowRateLimiter(limit, TEN_MINUTES_MS);
  const start = Date.UTC(2026, 9, 2, 10, 0, 0);
  let refused = 0;
  for (const call of agentCalls(runSeconds, progressEverySeconds)) {
    if (!limiter.consume("endpoint", start + call.at * SECOND).allowed) {
      refused++;
    }
  }
  return refused;
}

describe("the limit of the agent API", () => {
  it("admits a progress report every 5 seconds for a run of 24 hours", () => {
    expect(refusedAfter(AGENT_API_LIMIT, 24 * 3600, 5)).toBe(0);
  });

  it("leaves room: 5 second reports use about a fifth of what 10 minutes allow", () => {
    const perTenMinutes = agentCalls(600, 5).filter((call) => call.at < 600).length;
    expect(perTenMinutes).toBeLessThan(AGENT_API_LIMIT / 4);
    // Even a report every 2 seconds would fit.
    expect(refusedAfter(AGENT_API_LIMIT, 3600, 2)).toBe(0);
  });

  it("still stops an agent that reports far more often than it should", () => {
    expect(refusedAfter(AGENT_API_LIMIT, 3600, 0.5)).toBeGreaterThan(0);
  });
});
