import { describe, expect, it } from "vitest";
import { monthPeriod, periodLengthDays, periodMonth, reportPeriod } from "./period.js";

const iso = (period: { start: Date; end: Date }) => [
  period.start.toISOString(),
  period.end.toISOString(),
];

describe("reportPeriod", () => {
  it("covers the previous calendar day in the zone", () => {
    const now = new Date("2026-06-10T05:00:00Z"); // 07:00 in Berlin
    expect(iso(reportPeriod({ cadence: "daily" }, now, "Europe/Berlin"))).toEqual([
      "2026-06-08T22:00:00.000Z",
      "2026-06-09T22:00:00.000Z",
    ]);
    expect(iso(reportPeriod({ cadence: "daily" }, now, "UTC"))).toEqual([
      "2026-06-09T00:00:00.000Z",
      "2026-06-10T00:00:00.000Z",
    ]);
  });

  it("makes the day of a daylight saving switch 23 or 25 hours long", () => {
    // 29 March 2026: Berlin switches to summer time; 25 October back.
    const spring = reportPeriod(
      { cadence: "daily" },
      new Date("2026-03-30T05:00:00Z"),
      "Europe/Berlin",
    );
    expect(iso(spring)).toEqual(["2026-03-28T23:00:00.000Z", "2026-03-29T22:00:00.000Z"]);
    expect(spring.end.getTime() - spring.start.getTime()).toBe(23 * 3600_000);
    const autumn = reportPeriod(
      { cadence: "daily" },
      new Date("2026-10-26T06:00:00Z"),
      "Europe/Berlin",
    );
    expect(autumn.end.getTime() - autumn.start.getTime()).toBe(25 * 3600_000);
  });

  it("covers the previous Monday to Sunday", () => {
    // Monday 5 October 2026, 07:00 Berlin.
    const now = new Date("2026-10-05T05:00:00Z");
    expect(iso(reportPeriod({ cadence: "weekly" }, now, "Europe/Berlin"))).toEqual([
      "2026-09-27T22:00:00.000Z",
      "2026-10-04T22:00:00.000Z",
    ]);
    // A Wednesday still reports the week before the current one.
    const midweek = new Date("2026-10-07T12:00:00Z");
    expect(iso(reportPeriod({ cadence: "weekly" }, midweek, "UTC"))).toEqual([
      "2026-09-28T00:00:00.000Z",
      "2026-10-05T00:00:00.000Z",
    ]);
    // The week of the switch to winter time has 7 days and an hour.
    const switchWeek = reportPeriod(
      { cadence: "weekly" },
      new Date("2026-10-26T06:00:00Z"),
      "Europe/Berlin",
    );
    expect(switchWeek.end.getTime() - switchWeek.start.getTime()).toBe((7 * 24 + 1) * 3600_000);
    expect(periodLengthDays(switchWeek)).toBe(7);
  });

  it("covers the previous calendar month, across the year", () => {
    const now = new Date("2026-01-01T06:00:00Z");
    const period = reportPeriod({ cadence: "monthly" }, now, "Europe/Berlin");
    expect(iso(period)).toEqual(["2025-11-30T23:00:00.000Z", "2025-12-31T23:00:00.000Z"]);
    expect(periodMonth(period, "Europe/Berlin")).toBe("2025-12");
    expect(
      iso(reportPeriod({ cadence: "monthly" }, new Date("2026-03-15T00:00:00Z"), "UTC")),
    ).toEqual(["2026-02-01T00:00:00.000Z", "2026-03-01T00:00:00.000Z"]);
  });

  it("keeps the rolling period of a rule without a cadence", () => {
    const now = new Date("2026-06-10T07:00:00Z");
    expect(iso(reportPeriod({ periodDays: 7 }, now, "Europe/Berlin"))).toEqual([
      "2026-06-03T07:00:00.000Z",
      "2026-06-10T07:00:00.000Z",
    ]);
  });

  it("falls back to UTC for an unknown zone", () => {
    expect(
      iso(reportPeriod({ cadence: "daily" }, new Date("2026-06-10T05:00:00Z"), "Nope/Nope")),
    ).toEqual(["2026-06-09T00:00:00.000Z", "2026-06-10T00:00:00.000Z"]);
  });
});

describe("monthPeriod", () => {
  it("turns YYYY-MM into the month in the zone", () => {
    expect(iso(monthPeriod("2026-12", "UTC") as { start: Date; end: Date })).toEqual([
      "2026-12-01T00:00:00.000Z",
      "2027-01-01T00:00:00.000Z",
    ]);
    expect(monthPeriod("2026-13", "UTC")).toBeNull();
    expect(monthPeriod("26-01", "UTC")).toBeNull();
  });
});
