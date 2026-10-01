import { describe, expect, it } from "vitest";
import {
  MAX_PERIOD_DAYS,
  autoGranularity,
  bucketIndexByDay,
  bucketsOf,
  parseDay,
  resolvePeriod,
  truncate,
} from "./period.js";

const NOW = new Date("2026-09-23T10:15:00.000Z");

describe("parseDay", () => {
  it("accepts real calendar days only", () => {
    expect(parseDay("2026-09-23")?.toISOString()).toBe("2026-09-23T00:00:00.000Z");
    expect(parseDay("2028-02-29")).not.toBeNull();
    expect(parseDay("2026-02-29")).toBeNull();
    expect(parseDay("2026-13-01")).toBeNull();
    expect(parseDay("23.09.2026")).toBeNull();
  });
});

describe("resolvePeriod", () => {
  it("defaults to the last 30 days including today, by day", () => {
    const period = resolvePeriod({}, NOW);
    expect(period.current).toMatchObject({ from: "2026-08-25", to: "2026-09-23", days: 30 });
    expect(period.current.end.toISOString()).toBe("2026-09-24T00:00:00.000Z");
    expect(period.previous).toMatchObject({ from: "2026-07-26", to: "2026-08-24", days: 30 });
    expect(period.previous.end.getTime()).toBe(period.current.start.getTime());
    expect(period.granularity).toBe("day");
    expect(period.buckets).toHaveLength(30);
    expect(period.buckets[0]?.t).toBe("2026-08-25");
    expect(period.buckets.at(-1)?.t).toBe("2026-09-23");
  });

  it("compares with the period of the same length right before it", () => {
    const period = resolvePeriod({ from: "2026-09-01", to: "2026-09-07" }, NOW);
    expect(period.previous).toMatchObject({ from: "2026-08-25", to: "2026-08-31", days: 7 });
  });

  it("clips week and month buckets to the period and labels them with their first day", () => {
    // 2026-09-10 is a Thursday; weeks start on Monday.
    const weeks = resolvePeriod({ from: "2026-09-10", to: "2026-09-23", granularity: "week" }, NOW);
    expect(weeks.buckets.map((bucket) => bucket.t)).toEqual([
      "2026-09-10",
      "2026-09-14",
      "2026-09-21",
    ]);
    expect(weeks.buckets[2]?.end.toISOString()).toBe("2026-09-24T00:00:00.000Z");

    const months = resolvePeriod({ from: "2026-07-15", to: "2026-09-23" }, NOW);
    expect(months.granularity).toBe("week");
    const monthly = resolvePeriod(
      { from: "2026-07-15", to: "2026-09-23", granularity: "month" },
      NOW,
    );
    expect(monthly.buckets.map((bucket) => bucket.t)).toEqual([
      "2026-07-15",
      "2026-08-01",
      "2026-09-01",
    ]);
  });

  it("maps every day of the period onto its bucket", () => {
    const period = resolvePeriod(
      { from: "2026-09-10", to: "2026-09-23", granularity: "week" },
      NOW,
    );
    const index = bucketIndexByDay(period);
    expect(index.size).toBe(14);
    expect(index.get("2026-09-13")).toBe(0);
    expect(index.get("2026-09-14")).toBe(1);
    expect(index.get("2026-09-23")).toBe(2);
    expect(index.has("2026-09-09")).toBe(false);
  });

  it("refuses periods that are malformed, reversed, in the future or too long", () => {
    const reason = (input: Parameters<typeof resolvePeriod>[0]) => {
      try {
        resolvePeriod(input, NOW);
        return null;
      } catch (error) {
        return (error as { status: number; extensions: { reason: string } }).extensions.reason;
      }
    };
    expect(reason({ from: "2026-02-30" })).toBe("invalid_day");
    expect(reason({ from: "2026-09-20", to: "2026-09-10" })).toBe("from_after_to");
    expect(reason({ to: "2026-09-26" })).toBe("in_future");
    // One day ahead is allowed: "today" for a client east of UTC.
    expect(reason({ to: "2026-09-24" })).toBeNull();
    expect(reason({ from: "2024-01-01", to: "2026-09-23" })).toBe("too_long");
    expect(() => resolvePeriod({ from: "2026-09-20", to: "2026-09-10" }, NOW)).toThrow(
      expect.objectContaining({ status: 422, type: "urn:restow:problem:stats-period-invalid" }),
    );
  });

  it("accepts the longest period", () => {
    const period = resolvePeriod({ from: "2024-09-23", to: "2026-09-23" }, NOW);
    expect(period.current.days).toBe(MAX_PERIOD_DAYS);
    expect(period.granularity).toBe("month");
  });
});

describe("granularity helpers", () => {
  it("picks days up to a month, weeks up to half a year, months beyond", () => {
    expect(autoGranularity(7)).toBe("day");
    expect(autoGranularity(31)).toBe("day");
    expect(autoGranularity(90)).toBe("week");
    expect(autoGranularity(365)).toBe("month");
  });

  it("truncates to the ISO week and the calendar month", () => {
    const sunday = new Date("2026-09-20T23:00:00.000Z");
    expect(truncate(sunday, "week").toISOString()).toBe("2026-09-14T00:00:00.000Z");
    expect(truncate(sunday, "month").toISOString()).toBe("2026-09-01T00:00:00.000Z");
    expect(truncate(sunday, "day").toISOString()).toBe("2026-09-20T00:00:00.000Z");
  });

  it("builds buckets across a year boundary", () => {
    const buckets = bucketsOf(
      {
        start: new Date("2025-12-15T00:00:00.000Z"),
        end: new Date("2026-02-01T00:00:00.000Z"),
      },
      "month",
    );
    expect(buckets.map((bucket) => bucket.t)).toEqual(["2025-12-15", "2026-01-01"]);
  });
});
