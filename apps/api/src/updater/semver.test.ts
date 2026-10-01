import { describe, expect, it } from "vitest";
import {
  compareVersions,
  isNewerVersion,
  normalizeVersion,
  parseVersion,
  sameVersion,
  targetVersionOf,
} from "./semver.js";

describe("semver", () => {
  it("parses versions with and without a leading v", () => {
    expect(parseVersion("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [] });
    expect(parseVersion("v1.2.3-rc.1+build5")).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: ["rc", "1"],
    });
    expect(parseVersion("1.2")).toBeNull();
    expect(parseVersion("latest")).toBeNull();
    expect(parseVersion("")).toBeNull();
  });

  it("orders versions by precedence", () => {
    const order = [
      "0.1.0",
      "0.1.1",
      "0.2.0-alpha",
      "0.2.0-alpha.1",
      "0.2.0-beta",
      "0.2.0-rc.1",
      "0.2.0-rc.2",
      "0.2.0",
      "0.10.0",
      "1.0.0",
    ];
    for (let index = 1; index < order.length; index++) {
      const left = parseVersion(order[index - 1] as string);
      const right = parseVersion(order[index] as string);
      expect(compareVersions(left as never, right as never)).toBeLessThan(0);
      expect(compareVersions(right as never, left as never)).toBeGreaterThan(0);
    }
  });

  it("isNewerVersion is strict and null for non-versions", () => {
    expect(isNewerVersion("0.1.0", "0.1.1")).toBe(true);
    expect(isNewerVersion("0.1.0", "0.1.0")).toBe(false);
    expect(isNewerVersion("v0.1.0", "0.1.0")).toBe(false);
    expect(isNewerVersion("0.2.0", "0.1.9")).toBe(false);
    expect(isNewerVersion("1.0.0-rc.1", "1.0.0")).toBe(true);
    expect(isNewerVersion("1.0.0", "1.0.0-rc.1")).toBe(false);
    expect(isNewerVersion("dev", "1.0.0")).toBeNull();
    expect(isNewerVersion("1.0.0", "next")).toBeNull();
  });

  it("targetVersionOf accepts plain versions only and normalizes them", () => {
    expect(targetVersionOf("v0.2.0")).toBe("0.2.0");
    expect(targetVersionOf(" 0.2.0-rc.1 ")).toBe("0.2.0-rc.1");
    expect(targetVersionOf("0.2.0+build")).toBeNull();
    expect(targetVersionOf("0.2")).toBeNull();
    expect(targetVersionOf("../etc")).toBeNull();
    expect(targetVersionOf("0.2.0/../../x")).toBeNull();
    expect(normalizeVersion("v1.0.0")).toBe("1.0.0");
  });

  it("sameVersion ignores the v prefix and build metadata", () => {
    expect(sameVersion("v0.2.0", "0.2.0")).toBe(true);
    expect(sameVersion("0.2.0+abc", "0.2.0")).toBe(true);
    expect(sameVersion("0.2.0", "0.2.1")).toBe(false);
    expect(sameVersion("dev", "dev")).toBe(true);
    expect(sameVersion("dev", "0.2.0")).toBe(false);
  });
});
