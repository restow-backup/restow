import { describe, expect, it } from "vitest";
import { localToUtc, nextDailyRun, zoneOffsetMs, zonedParts } from "./tz.js";

describe("zone arithmetic", () => {
  it("knows Berlin's offset in summer and winter", () => {
    expect(zoneOffsetMs(new Date("2026-07-01T12:00:00Z"), "Europe/Berlin")).toBe(2 * 3600_000);
    expect(zoneOffsetMs(new Date("2026-01-15T12:00:00Z"), "Europe/Berlin")).toBe(3600_000);
    expect(zoneOffsetMs(new Date("2026-07-01T12:00:00Z"), "UTC")).toBe(0);
  });

  it("reads the wall clock of an instant", () => {
    expect(zonedParts(new Date("2026-09-30T20:30:15Z"), "Europe/Berlin")).toEqual({
      year: 2026,
      month: 9,
      day: 30,
      hour: 22,
      minute: 30,
      second: 15,
    });
  });

  it("turns a wall-clock time into the right UTC instant on both sides of a change", () => {
    expect(localToUtc(2026, 9, 1, 22, 0, "Europe/Berlin").toISOString()).toBe(
      "2026-09-01T20:00:00.000Z",
    );
    expect(localToUtc(2026, 12, 1, 22, 0, "Europe/Berlin").toISOString()).toBe(
      "2026-12-01T21:00:00.000Z",
    );
    // The day clocks go back (2026-10-25): 22:00 is already winter time.
    expect(localToUtc(2026, 10, 25, 22, 0, "Europe/Berlin").toISOString()).toBe(
      "2026-10-25T21:00:00.000Z",
    );
    expect(localToUtc(2026, 10, 24, 22, 0, "Europe/Berlin").toISOString()).toBe(
      "2026-10-24T20:00:00.000Z",
    );
  });

  it("finds the next daily run after a moment", () => {
    // 21:00 Berlin on 30 September: today's 22:00 is still to come.
    expect(
      nextDailyRun(new Date("2026-09-30T19:00:00Z"), "22:00", "Europe/Berlin").toISOString(),
    ).toBe("2026-09-30T20:00:00.000Z");
    // Past 22:00: tomorrow's.
    expect(
      nextDailyRun(new Date("2026-09-30T20:00:00Z"), "22:00", "Europe/Berlin").toISOString(),
    ).toBe("2026-10-01T20:00:00.000Z");
    expect(() => nextDailyRun(new Date(), "late", "UTC")).toThrow();
  });
});
