import { describe, expect, it } from "vitest";
import {
  daysInPeriod,
  localDay,
  nextPeriod,
  periodBounds,
  periodDayRange,
  periodHasEnded,
  periodOfDay,
} from "./period.js";

describe("days and months of the billing close", () => {
  it("takes the calendar day of the installation's zone, not UTC", () => {
    // 23:30 UTC on 31 October is already 1 November in Berlin (CET, +01:00).
    const instant = new Date("2026-10-31T23:30:00.000Z");
    expect(localDay(instant, "Europe/Berlin")).toBe("2026-11-01");
    expect(localDay(instant, "UTC")).toBe("2026-10-31");
    expect(localDay(instant, "America/New_York")).toBe("2026-10-31");
    expect(periodOfDay(localDay(instant, "Europe/Berlin"))).toBe("2026-11");
  });

  it("counts months across the year and February in a leap year", () => {
    expect(nextPeriod("2026-12")).toBe("2027-01");
    expect(nextPeriod("2026-09")).toBe("2026-10");
    expect(daysInPeriod("2028-02")).toBe(29);
    expect(daysInPeriod("2026-02")).toBe(28);
    expect(daysInPeriod("2026-10")).toBe(31);
    expect(periodDayRange("2026-12")).toEqual({ first: "2026-12-01", end: "2027-01-01" });
    expect(() => nextPeriod("2026-13")).toThrow(/not a billing period/);
  });

  it("begins and ends a month at 00:00 in the zone, across the daylight-saving switch", () => {
    // October in Berlin starts in summer time (+02:00) and ends in winter time (+01:00): 745 hours.
    const october = periodBounds("2026-10", "Europe/Berlin");
    expect(october.startsAt.toISOString()).toBe("2026-09-30T22:00:00.000Z");
    expect(october.endsAt.toISOString()).toBe("2026-10-31T23:00:00.000Z");
    expect((october.endsAt.getTime() - october.startsAt.getTime()) / 3_600_000).toBe(745);
    // March is one hour short.
    const march = periodBounds("2026-03", "Europe/Berlin");
    expect((march.endsAt.getTime() - march.startsAt.getTime()) / 3_600_000).toBe(743);
    expect(periodBounds("2026-10", "UTC").startsAt.toISOString()).toBe("2026-10-01T00:00:00.000Z");
  });

  it("lets a month be closed from 00:00 on the 1st of the next one in the zone", () => {
    const zone = "Europe/Berlin";
    expect(periodHasEnded("2026-10", new Date("2026-10-31T22:59:59.000Z"), zone)).toBe(false);
    expect(periodHasEnded("2026-10", new Date("2026-10-31T23:00:00.000Z"), zone)).toBe(true);
    // In UTC that instant is still October.
    expect(periodHasEnded("2026-10", new Date("2026-10-31T23:00:00.000Z"), "UTC")).toBe(false);
    expect(periodHasEnded("2026-11", new Date("2026-11-17T10:00:00.000Z"), zone)).toBe(false);
  });
});
