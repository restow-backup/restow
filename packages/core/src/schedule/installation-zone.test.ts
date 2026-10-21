import { describe, expect, it } from "vitest";
import { canonicalTimeZone } from "./cron.js";
import { environmentTimeZone, resolveInstallationTimeZone } from "./installation-zone.js";

describe("canonicalTimeZone", () => {
  it("accepts IANA names and returns their canonical spelling", () => {
    expect(canonicalTimeZone("Europe/Berlin")).toBe("Europe/Berlin");
    expect(canonicalTimeZone(" europe/berlin ")).toBe("Europe/Berlin");
    expect(canonicalTimeZone("UTC")).toBe("UTC");
    // An alias resolves to the runtime's spelling of the same zone.
    expect(canonicalTimeZone("America/Argentina/Buenos_Aires")).toMatch(/Buenos_Aires$/);
  });

  it("refuses what is not a zone, offsets included", () => {
    for (const value of ["", "Mars/Olympus", "+01:00", "-0500", "Europe/../etc", "a".repeat(80)]) {
      expect(canonicalTimeZone(value)).toBeNull();
    }
  });
});

describe("resolveInstallationTimeZone", () => {
  it("prefers the stored setting over the environment", () => {
    expect(
      resolveInstallationTimeZone("America/New_York", {
        RESTOW_TIME_ZONE: "UTC",
        TZ: "Asia/Tokyo",
      }),
    ).toEqual({ timeZone: "America/New_York", source: "settings" });
  });

  it("falls back to RESTOW_TIME_ZONE, then TZ, then Europe/Berlin", () => {
    expect(
      resolveInstallationTimeZone(null, { RESTOW_TIME_ZONE: "UTC", TZ: "Asia/Tokyo" }),
    ).toEqual({ timeZone: "UTC", source: "environment" });
    expect(resolveInstallationTimeZone(null, { TZ: "Asia/Tokyo" })).toEqual({
      timeZone: "Asia/Tokyo",
      source: "process",
    });
    expect(resolveInstallationTimeZone(null, {})).toEqual({
      timeZone: "Europe/Berlin",
      source: "default",
    });
  });

  it("skips values that are not zones", () => {
    expect(
      resolveInstallationTimeZone("Nowhere/City", {
        RESTOW_TIME_ZONE: "nope",
        TZ: ":/etc/localtime",
      }),
    ).toEqual({ timeZone: "Europe/Berlin", source: "default" });
    expect(environmentTimeZone({ RESTOW_TIME_ZONE: "Europe/Vienna" })).toEqual({
      timeZone: "Europe/Vienna",
      source: "environment",
    });
  });
});
