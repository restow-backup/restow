import { afterEach, describe, expect, it, vi } from "vitest";
import {
  endOfUpdatePeriod,
  majorVersionOf,
  runningBuildOf,
  updateEntitlement,
} from "./entitlement.js";

const BETA = { series: null, updatesUntil: null };
const PERIOD = { series: "1", updatesUntil: "2027-11-30" };

afterEach(() => {
  vi.useRealTimers();
});

describe("updateEntitlement: beta licences (no update period)", () => {
  it.each([
    ["0.4.5", true],
    ["0.9.0-rc.1", true],
    ["1.0.0", true],
    ["1.37.2", true],
    ["v1.2.3", true],
    ["2.0.0-beta.1", false],
    ["2.0.0", false],
    ["10.0.0", false],
  ])("a key of before 0.4.5 on %s: %s", (version, entitled) => {
    const result = updateEntitlement(BETA, { version, releasedAt: "2031-01-01T00:00:00Z" });
    expect(result).toEqual({
      entitled,
      reason: entitled ? "series" : "outside_series",
      coveredUntil: null,
      series: "1",
    });
  });

  it("covers the releases of the series it names", () => {
    const series2 = { series: "2", updatesUntil: null };
    expect(updateEntitlement(series2, { version: "2.5.0", releasedAt: null }).entitled).toBe(true);
    expect(updateEntitlement(series2, { version: "1.9.0", releasedAt: null }).entitled).toBe(false);
    expect(updateEntitlement(series2, { version: "0.4.5", releasedAt: null }).entitled).toBe(false);
  });

  it("treats a build without a release version as a development build", () => {
    expect(updateEntitlement(BETA, { version: null, releasedAt: null })).toMatchObject({
      entitled: true,
      reason: "development_build",
    });
    expect(updateEntitlement(BETA, { version: "dev", releasedAt: null }).entitled).toBe(true);
  });
});

describe("updateEntitlement: update period", () => {
  it("covers a release made on the last day, up to its last millisecond (UTC)", () => {
    for (const releasedAt of [
      "2027-11-30T00:00:00Z",
      "2027-11-30T23:59:59.999Z",
      // 23:30 in Berlin on the last day is still the last day in UTC.
      "2027-11-30T23:30:00+00:00",
    ]) {
      expect(updateEntitlement(PERIOD, { version: "1.6.0", releasedAt })).toEqual({
        entitled: true,
        reason: "within_period",
        coveredUntil: "2027-11-30",
        series: "1",
      });
    }
  });

  it("does not cover a release made after the last day", () => {
    for (const releasedAt of [
      "2027-12-01T00:00:00Z",
      new Date("2027-12-01T00:00:00.000Z"),
      // The commit date of a tag carries the committer's offset: 00:30+01:00 is still Nov 30 UTC.
      "2027-12-01T01:00:01+01:00",
    ]) {
      expect(updateEntitlement(PERIOD, { version: "1.6.0", releasedAt })).toMatchObject({
        entitled: false,
        reason: "after_period",
      });
    }
    expect(
      updateEntitlement(PERIOD, { version: "1.6.0", releasedAt: "2027-12-01T00:30:00+01:00" })
        .entitled,
    ).toBe(true);
  });

  it("decides by the release date alone, whatever the version", () => {
    expect(
      updateEntitlement(PERIOD, { version: "2.0.0", releasedAt: "2027-10-01T00:00:00Z" }).entitled,
    ).toBe(true);
    expect(
      updateEntitlement(PERIOD, { version: "1.0.1", releasedAt: "2028-01-01T00:00:00Z" }).entitled,
    ).toBe(false);
  });

  it("covers a development build (no release date)", () => {
    expect(updateEntitlement(PERIOD, { version: "1.9.0", releasedAt: null })).toMatchObject({
      entitled: true,
      reason: "development_build",
    });
    expect(updateEntitlement(PERIOD, { version: "1.9.0", releasedAt: "garbage" }).entitled).toBe(
      true,
    );
  });

  it("never reads the clock: a covered release stays covered years later", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2040-01-01T00:00:00Z"));
    expect(
      updateEntitlement(PERIOD, { version: "1.6.0", releasedAt: "2027-06-01T00:00:00Z" }).entitled,
    ).toBe(true);
    vi.setSystemTime(new Date("2020-01-01T00:00:00Z"));
    expect(
      updateEntitlement(PERIOD, { version: "1.6.0", releasedAt: "2028-06-01T00:00:00Z" }).entitled,
    ).toBe(false);
  });
});

describe("updateEntitlement: no key", () => {
  it("restricts nothing (Community needs no update entitlement)", () => {
    expect(updateEntitlement(null, { version: "9.0.0", releasedAt: "2040-01-01" })).toEqual({
      entitled: true,
      reason: "no_key",
      coveredUntil: null,
      series: null,
    });
  });
});

describe("helpers", () => {
  it("reads the major version of release versions only", () => {
    expect(majorVersionOf("1.2.3")).toBe(1);
    expect(majorVersionOf("v0.4.5-alpha.3")).toBe(0);
    expect(majorVersionOf("0.0.0-dev")).toBe(0);
    expect(majorVersionOf("1.2")).toBeNull();
    expect(majorVersionOf(null)).toBeNull();
  });

  it("ends the period at the last millisecond of the day, UTC", () => {
    expect(endOfUpdatePeriod("2028-02-29").toISOString()).toBe("2028-02-29T23:59:59.999Z");
  });

  it("reads the running build from the image's environment", () => {
    expect(
      runningBuildOf({ RESTOW_VERSION: "v1.2.0", RESTOW_RELEASED_AT: "2027-05-04T10:00:00+02:00" }),
    ).toEqual({ version: "1.2.0", releasedAt: new Date("2027-05-04T08:00:00Z") });
    expect(runningBuildOf({ RESTOW_VERSION: "", RESTOW_RELEASED_AT: "" })).toEqual({
      version: null,
      releasedAt: null,
    });
    expect(runningBuildOf({ RESTOW_RELEASED_AT: "not a date" }).releasedAt).toBeNull();
  });
});
