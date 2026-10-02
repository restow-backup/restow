import { describe, expect, it } from "vitest";
import { canonicalJson, sameJson } from "./json.js";
import { sameSchedule } from "./write.js";

describe("sameJson", () => {
  it("does not care in which order the keys of an object were written", () => {
    expect(
      sameJson(
        { a: 1, b: { c: 2, d: [1, { x: 1, y: 2 }] } },
        { b: { d: [1, { y: 2, x: 1 }], c: 2 }, a: 1 },
      ),
    ).toBe(true);
  });

  it("still tells different documents apart, and arrays by order", () => {
    expect(sameJson({ a: 1 }, { a: 2 })).toBe(false);
    expect(sameJson({ a: [1, 2] }, { a: [2, 1] })).toBe(false);
    expect(sameJson({ a: 1 }, { a: 1, b: 1 })).toBe(false);
  });

  it("reads a missing value, null and an absent key alike", () => {
    expect(sameJson(undefined, null)).toBe(true);
    expect(sameJson({ a: 1, b: undefined }, { a: 1 })).toBe(true);
    expect(canonicalJson(undefined)).toBe("null");
  });
});

describe("sameSchedule", () => {
  const zone = "Europe/Berlin";

  it("reads the same schedule written with its keys in another order as unchanged", () => {
    expect(
      sameSchedule(
        { kind: "interval", intervalMinutes: 480, timeZone: zone },
        { timeZone: zone, kind: "interval", intervalMinutes: 480 },
      ),
    ).toBe(true);
  });

  it("ignores the spacing of a cron expression, not its fields or its zone", () => {
    const cron = (expression: string, timeZone = zone) =>
      ({ kind: "cron", cron: expression, timeZone }) as const;
    expect(sameSchedule(cron("0 3 * * 0"), cron("0  3 * * 0"))).toBe(true);
    expect(sameSchedule(cron("0 3 * * 0"), cron("0 4 * * 0"))).toBe(false);
    expect(sameSchedule(cron("0 3 * * 0"), cron("0 3 * * 0", "UTC"))).toBe(false);
  });

  it("tells another cadence or no schedule apart", () => {
    expect(
      sameSchedule(
        { kind: "interval", intervalMinutes: 480, timeZone: zone },
        { kind: "interval", intervalMinutes: 240, timeZone: zone },
      ),
    ).toBe(false);
    expect(sameSchedule(null, undefined)).toBe(true);
    expect(sameSchedule({ kind: "interval", intervalMinutes: 60, timeZone: zone }, null)).toBe(
      false,
    );
  });
});
