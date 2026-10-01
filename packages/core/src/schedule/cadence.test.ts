import { describe, expect, it } from "vitest";
import {
  CadenceError,
  FULL_SCRUB_INTERVAL_MINUTES,
  MAX_INTERVAL_MINUTES,
  MIN_INTERVAL_MINUTES,
  nextRunAt,
  scrubModeForCadence,
  upcomingRuns,
  validateCadence,
} from "./cadence.js";

const NOW = new Date("2026-03-01T10:00:00Z");

const iso = (dates: readonly Date[]) => dates.map((date) => date.toISOString());

describe("validateCadence", () => {
  it("accepts an interval or a cron expression in a known zone", () => {
    expect(validateCadence({ intervalMinutes: 480, timezone: "Europe/Berlin" }, NOW)).toBeNull();
    expect(validateCadence({ cron: "30 4 * * *", timezone: "Europe/Berlin" }, NOW)).toBeNull();
    // The zone is checked for intervals too: it is stored with every schedule.
    expect(validateCadence({ intervalMinutes: 60, timezone: "UTC" }, NOW)).toBeNull();
  });

  it("requires exactly one of interval and cron", () => {
    expect(validateCadence({ timezone: "UTC" }, NOW)).toMatchObject({
      field: "intervalMinutes",
      code: "cadence_missing",
    });
    expect(
      validateCadence({ intervalMinutes: null, cron: "  ", timezone: "UTC" }, NOW),
    ).toMatchObject({ code: "cadence_missing" });
    expect(
      validateCadence({ intervalMinutes: 60, cron: "0 3 * * *", timezone: "UTC" }, NOW),
    ).toMatchObject({ field: "intervalMinutes", code: "cadence_ambiguous" });
  });

  it("names the zone when it is unknown", () => {
    expect(validateCadence({ cron: "0 3 * * *", timezone: "Mars/Olympus" }, NOW)).toMatchObject({
      field: "timezone",
      code: "timezone_unknown",
    });
  });

  it("keeps intervals whole and within the limits", () => {
    expect(validateCadence({ intervalMinutes: 90.5, timezone: "UTC" }, NOW)).toMatchObject({
      field: "intervalMinutes",
      code: "interval_not_integer",
    });
    for (const minutes of [0, MIN_INTERVAL_MINUTES - 1, MAX_INTERVAL_MINUTES + 1, -60]) {
      expect(validateCadence({ intervalMinutes: minutes, timezone: "UTC" }, NOW)).toMatchObject({
        field: "intervalMinutes",
        code: "interval_out_of_range",
      });
    }
    expect(
      validateCadence({ intervalMinutes: MIN_INTERVAL_MINUTES, timezone: "UTC" }, NOW),
    ).toBeNull();
    expect(
      validateCadence({ intervalMinutes: MAX_INTERVAL_MINUTES, timezone: "UTC" }, NOW),
    ).toBeNull();
  });

  it("names the cron field for syntax errors, impossible dates and runs too close together", () => {
    const invalid = validateCadence({ cron: "61 * * * *", timezone: "UTC" }, NOW);
    expect(invalid).toMatchObject({ field: "cron", code: "cron_invalid" });
    expect(invalid?.message).toContain("minute");
    expect(validateCadence({ cron: "0 3 31 2 *", timezone: "UTC" }, NOW)).toMatchObject({
      field: "cron",
      code: "cron_never_matches",
    });
    expect(validateCadence({ cron: "* * * * *", timezone: "UTC" }, NOW)).toMatchObject({
      field: "cron",
      code: "cron_too_frequent",
    });
    expect(validateCadence({ cron: "*/15 * * * *", timezone: "UTC" }, NOW)).toBeNull();
    expect(validateCadence({ cron: "0,5 3 * * *", timezone: "UTC" }, NOW)).toMatchObject({
      code: "cron_too_frequent",
    });
  });
});

describe("nextRunAt", () => {
  it("starts a new interval schedule at once and counts later ones from the last run", () => {
    expect(nextRunAt({ intervalMinutes: 480, timezone: "UTC" }, { now: NOW }).toISOString()).toBe(
      NOW.toISOString(),
    );
    const lastRunAt = new Date("2026-03-01T08:00:00Z");
    expect(
      nextRunAt({ intervalMinutes: 240, timezone: "UTC" }, { now: NOW, lastRunAt }).toISOString(),
    ).toBe("2026-03-01T12:00:00.000Z");
    // Overdue (the schedule was paused for a while): due now, not in the past.
    expect(
      nextRunAt({ intervalMinutes: 60, timezone: "UTC" }, { now: NOW, lastRunAt }).toISOString(),
    ).toBe(NOW.toISOString());
  });

  it("runs cron schedules at their next wall-clock match, even when they ran recently", () => {
    expect(
      nextRunAt(
        { cron: "30 4 * * *", timezone: "Europe/Berlin" },
        { now: NOW, lastRunAt: new Date("2026-03-01T03:30:00Z") },
      ).toISOString(),
    ).toBe("2026-03-02T03:30:00.000Z");
  });

  it("throws a CadenceError naming the field for an unusable cadence", () => {
    expect(() => nextRunAt({ cron: "nope", timezone: "UTC" }, { now: NOW })).toThrow(CadenceError);
    try {
      nextRunAt({ intervalMinutes: 5, timezone: "UTC" }, { now: NOW });
    } catch (error) {
      expect(error).toBeInstanceOf(CadenceError);
      expect((error as CadenceError).issue.field).toBe("intervalMinutes");
    }
  });
});

describe("upcomingRuns", () => {
  it("lists five interval runs starting now", () => {
    expect(iso(upcomingRuns({ intervalMinutes: 480, timezone: "UTC" }, { now: NOW }))).toEqual([
      "2026-03-01T10:00:00.000Z",
      "2026-03-01T18:00:00.000Z",
      "2026-03-02T02:00:00.000Z",
      "2026-03-02T10:00:00.000Z",
      "2026-03-02T18:00:00.000Z",
    ]);
  });

  it("keeps a daily run at its local time across the spring-forward switch in Berlin", () => {
    // 2026-03-29: clocks jump from 02:00 to 03:00; 03:30 local is 02:30Z before, 01:30Z after.
    expect(
      iso(
        upcomingRuns(
          { cron: "30 3 * * *", timezone: "Europe/Berlin" },
          { now: new Date("2026-03-27T12:00:00Z") },
        ),
      ),
    ).toEqual([
      "2026-03-28T02:30:00.000Z",
      "2026-03-29T01:30:00.000Z",
      "2026-03-30T01:30:00.000Z",
      "2026-03-31T01:30:00.000Z",
      "2026-04-01T01:30:00.000Z",
    ]);
  });

  it("runs a wall time that happens twice only once when clocks fall back", () => {
    // 2026-10-25: 03:00 CEST becomes 02:00 CET, so 02:30 happens twice; it runs once.
    expect(
      iso(
        upcomingRuns(
          { cron: "30 2 * * *", timezone: "Europe/Berlin" },
          { now: new Date("2026-10-23T12:00:00Z") },
        ),
      ),
    ).toEqual([
      "2026-10-24T00:30:00.000Z",
      "2026-10-25T01:30:00.000Z",
      "2026-10-26T01:30:00.000Z",
      "2026-10-27T01:30:00.000Z",
      "2026-10-28T01:30:00.000Z",
    ]);
  });

  it("follows weekly runs across the switch and honours the count", () => {
    expect(
      iso(
        upcomingRuns(
          { cron: "0 3 * * 0", timezone: "Europe/Berlin" },
          { now: new Date("2026-03-20T12:00:00Z"), count: 3 },
        ),
      ),
    ).toEqual(["2026-03-22T02:00:00.000Z", "2026-03-29T01:00:00.000Z", "2026-04-05T01:00:00.000Z"]);
  });
});

describe("scrubModeForCadence", () => {
  it("scrubs everything when the cadence is monthly or rarer, a sample otherwise", () => {
    expect(scrubModeForCadence({ intervalMinutes: 7 * 24 * 60, cron: null })).toBe("sample");
    expect(scrubModeForCadence({ intervalMinutes: FULL_SCRUB_INTERVAL_MINUTES, cron: null })).toBe(
      "full",
    );
    expect(scrubModeForCadence({ intervalMinutes: null, cron: "0 4 * * 6" })).toBe("sample");
    expect(scrubModeForCadence({ intervalMinutes: null, cron: "0 5 1 * *" })).toBe("full");
    expect(scrubModeForCadence({ intervalMinutes: null, cron: "broken" })).toBe("sample");
  });
});
