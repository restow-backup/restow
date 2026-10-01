import { describe, expect, it } from "vitest";
import {
  compareVersions,
  isUpdateAvailable,
  parseVersion,
  runningCommitFrom,
  runningVersionFrom,
} from "./version.js";

function version(value: string) {
  const parsed = parseVersion(value);
  if (!parsed) {
    throw new Error(`not a version: ${value}`);
  }
  return parsed;
}

describe("semantic versions", () => {
  it("parses release tags with or without the v prefix and ignores build metadata", () => {
    expect(parseVersion("v1.2.3")).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [] });
    expect(parseVersion("1.2.0-rc.1+build.7")).toEqual({
      major: 1,
      minor: 2,
      patch: 0,
      prerelease: ["rc", "1"],
    });
    expect(parseVersion("latest")).toBeNull();
    expect(parseVersion("1.2")).toBeNull();
  });

  it("orders by precedence, pre-releases before their release", () => {
    const ordered = [
      "1.0.0-alpha",
      "1.0.0-alpha.1",
      "1.0.0-beta.2",
      "1.0.0-beta.11",
      "1.0.0-rc.1",
      "1.0.0",
      "1.0.1",
      "1.10.0",
      "2.0.0",
    ];
    for (let index = 1; index < ordered.length; index++) {
      const older = version(ordered[index - 1] as string);
      const newer = version(ordered[index] as string);
      expect(compareVersions(older, newer)).toBeLessThan(0);
      expect(compareVersions(newer, older)).toBeGreaterThan(0);
    }
    expect(compareVersions(version("v1.2.3"), version("1.2.3"))).toBe(0);
  });

  it("knows an update only when both versions are known", () => {
    expect(isUpdateAvailable("1.2.0", "1.3.0")).toBe(true);
    expect(isUpdateAvailable("1.3.0-rc.2", "1.3.0")).toBe(true);
    expect(isUpdateAvailable("1.3.0", "1.3.0")).toBe(false);
    expect(isUpdateAvailable("1.4.0", "1.3.0")).toBe(false);
    expect(isUpdateAvailable(null, "1.3.0")).toBeNull();
  });
});

describe("runningVersionFrom", () => {
  it("reads the version stamped into the image, without the tag prefix", () => {
    expect(runningVersionFrom({ RESTOW_VERSION: "v1.5.0" })).toBe("1.5.0");
    expect(runningVersionFrom({ RESTOW_VERSION: " 0.1.0-rc.1 " })).toBe("0.1.0-rc.1");
  });

  it("reports a build without a stamp as unknown, never as a made-up number", () => {
    expect(runningVersionFrom({})).toBeNull();
    expect(runningVersionFrom({ RESTOW_VERSION: "  " })).toBeNull();
  });
});

describe("runningCommitFrom", () => {
  it("shortens the stamped revision to seven digits", () => {
    expect(runningCommitFrom({ RESTOW_REVISION: "9272693ABCDEF0123456789abcdef0123456789a" })).toBe(
      "9272693",
    );
    expect(runningCommitFrom({ RESTOW_REVISION: " 9272693 " })).toBe("9272693");
  });

  it("is null without a revision or for something that is none", () => {
    expect(runningCommitFrom({})).toBeNull();
    expect(runningCommitFrom({ RESTOW_REVISION: "unknown" })).toBeNull();
    expect(runningCommitFrom({ RESTOW_REVISION: "" })).toBeNull();
  });
});
