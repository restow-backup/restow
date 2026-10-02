import { describe, expect, it } from "vitest";

import { COUNTDOWN_WITHIN_MS, JUST_NOW_MS, ageStep, countdownText } from "./age";

describe("ageStep", () => {
  it("stays at just now for as long as a keep-alive may be late", () => {
    expect(ageStep(0)).toEqual({ unit: "now" });
    expect(ageStep(JUST_NOW_MS - 1)).toEqual({ unit: "now" });
    // The server speaks at least every 15 s: 15 s of silence is normal.
    expect(JUST_NOW_MS).toBeGreaterThan(15_000);
  });

  it("counts seconds up to a minute, minutes after", () => {
    expect(ageStep(JUST_NOW_MS)).toEqual({ unit: "seconds", count: 20 });
    expect(ageStep(59_999)).toEqual({ unit: "seconds", count: 59 });
    expect(ageStep(60_000)).toEqual({ unit: "minutes", count: 1 });
    expect(ageStep(5 * 60_000 + 10_000)).toEqual({ unit: "minutes", count: 5 });
  });

  it("reads nonsense as just now", () => {
    expect(ageStep(-5000)).toEqual({ unit: "now" });
    expect(ageStep(Number.NaN)).toEqual({ unit: "now" });
  });
});

describe("countdownText", () => {
  const now = Date.parse("2026-10-02T10:00:00.000Z");
  const at = (seconds: number) => now + seconds * 1000;

  it("counts down in minutes and seconds under an hour", () => {
    expect(countdownText(at(17 * 60 + 42), now)).toBe("17:42");
    expect(countdownText(at(65), now)).toBe("1:05");
    expect(countdownText(at(9), now)).toBe("0:09");
  });

  it("rounds up, so the last second shown is the one before it happens", () => {
    expect(countdownText(now + 400, now)).toBe("0:01");
    expect(countdownText(now + 1001, now)).toBe("0:02");
  });

  it("counts hours from an hour on, and ends when the moment is reached", () => {
    expect(countdownText(at(3600 + 125), now)).toBe("1:02:05");
    expect(countdownText(now, now)).toBeNull();
    expect(countdownText(now - 1000, now)).toBeNull();
    expect(countdownText(Number.NaN, now)).toBeNull();
  });

  it("is used within the hour", () => {
    expect(COUNTDOWN_WITHIN_MS).toBe(3_600_000);
  });
});
