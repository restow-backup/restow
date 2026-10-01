import { describe, expect, it } from "vitest";
import {
  CronSyntaxError,
  isValidTimeZone,
  localParts,
  nextCronOccurrence,
  parseCron,
  zonedTimeToUtc,
} from "./cron.js";

function next(expr: string, after: string, tz = "UTC"): string | null {
  return nextCronOccurrence(parseCron(expr), new Date(after), tz)?.toISOString() ?? null;
}

describe("parseCron", () => {
  it("parses wildcards, lists, ranges and steps", () => {
    const spec = parseCron("*/15 2,14 1-3 * 1-5");
    expect([...spec.minutes]).toEqual([0, 15, 30, 45]);
    expect([...spec.hours]).toEqual([2, 14]);
    expect([...spec.daysOfMonth]).toEqual([1, 2, 3]);
    expect(spec.months.size).toBe(12);
    expect([...spec.daysOfWeek]).toEqual([1, 2, 3, 4, 5]);
    expect(spec.anyDayOfMonth).toBe(false);
    expect(spec.anyDayOfWeek).toBe(false);
    expect(parseCron("0 0 * * *").anyDayOfMonth).toBe(true);
  });

  it("treats 7 as Sunday and supports a stepped start", () => {
    expect([...parseCron("0 0 * * 7").daysOfWeek]).toEqual([0]);
    expect([...parseCron("5/20 * * * *").minutes]).toEqual([5, 25, 45]);
  });

  it("rejects malformed expressions", () => {
    for (const bad of [
      "* * * *",
      "60 * * * *",
      "* 24 * * *",
      "* * 0 * *",
      "* * * 13 *",
      "a * * * *",
      "5-1 * * * *",
      "*/0 * * * *",
    ]) {
      expect(() => parseCron(bad), bad).toThrow(CronSyntaxError);
    }
  });
});

describe("nextCronOccurrence", () => {
  it("finds the next minute, hour and day boundaries in UTC", () => {
    expect(next("*/15 * * * *", "2026-03-01T10:07:00Z")).toBe("2026-03-01T10:15:00.000Z");
    expect(next("*/15 * * * *", "2026-03-01T10:15:00Z")).toBe("2026-03-01T10:30:00.000Z");
    expect(next("30 2 * * *", "2026-03-01T03:00:00Z")).toBe("2026-03-02T02:30:00.000Z");
    expect(next("0 0 1 * *", "2026-03-01T00:00:00Z")).toBe("2026-04-01T00:00:00.000Z");
  });

  it("is strictly after the given instant and ignores seconds", () => {
    expect(next("0 12 * * *", "2026-03-01T12:00:30Z")).toBe("2026-03-02T12:00:00.000Z");
    expect(next("0 12 * * *", "2026-03-01T11:59:59Z")).toBe("2026-03-01T12:00:00.000Z");
  });

  it("applies Vixie OR semantics when both day fields are restricted", () => {
    // 15th of the month OR a Monday. 2026-03-02 is a Monday.
    expect(next("0 9 15 * 1", "2026-03-01T00:00:00Z")).toBe("2026-03-02T09:00:00.000Z");
    expect(next("0 9 15 * 1", "2026-03-10T00:00:00Z")).toBe("2026-03-15T09:00:00.000Z");
  });

  it("handles leap days and long gaps", () => {
    expect(next("0 0 29 2 *", "2026-03-01T00:00:00Z")).toBe("2028-02-29T00:00:00.000Z");
    expect(next("0 0 31 2 *", "2026-03-01T00:00:00Z")).toBeNull();
  });

  it("evaluates wall-clock times in the schedule's zone across daylight-saving switches", () => {
    // Berlin: 02:30 local is 01:30Z in winter, 00:30Z in summer.
    expect(next("30 2 * * *", "2026-01-10T00:00:00Z", "Europe/Berlin")).toBe(
      "2026-01-10T01:30:00.000Z",
    );
    expect(next("30 2 * * *", "2026-07-10T00:00:00Z", "Europe/Berlin")).toBe(
      "2026-07-10T00:30:00.000Z",
    );
    // Spring forward on 2026-03-29: 02:30 does not exist, so the next run is the 30th.
    expect(next("30 2 * * *", "2026-03-28T02:00:00Z", "Europe/Berlin")).toBe(
      "2026-03-30T00:30:00.000Z",
    );
    // A daily 03:30 still runs on the switch day itself.
    expect(next("30 3 * * *", "2026-03-28T03:00:00Z", "Europe/Berlin")).toBe(
      "2026-03-29T01:30:00.000Z",
    );
  });

  it("converts local wall times and validates zones", () => {
    expect(localParts(new Date("2026-07-01T12:00:00Z"), "America/New_York")).toEqual({
      year: 2026,
      month: 7,
      day: 1,
      hour: 8,
      minute: 0,
    });
    expect(
      zonedTimeToUtc(
        { year: 2026, month: 7, day: 1, hour: 8, minute: 0 },
        "America/New_York",
      )?.toISOString(),
    ).toBe("2026-07-01T12:00:00.000Z");
    expect(
      zonedTimeToUtc({ year: 2026, month: 3, day: 29, hour: 2, minute: 30 }, "Europe/Berlin"),
    ).toBeNull();
    expect(isValidTimeZone("Europe/Berlin")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
  });
});
