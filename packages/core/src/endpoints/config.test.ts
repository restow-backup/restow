import { describe, expect, it } from "vitest";
import {
  DEFAULT_CLIENT_INTERVAL_MINUTES,
  DEFAULT_ENDPOINT_RETENTION,
  SUPPORTED_ENDPOINT_OS,
  defaultEndpointConfig,
  isSupportedEndpointOs,
} from "./config.js";

const options = { timeZone: "Europe/Berlin" };

describe("agent configuration defaults", () => {
  it("backs a server up daily at 22:00 in the given zone", () => {
    const config = defaultEndpointConfig("linux", "server", options);
    expect(config.profile).toBe("server");
    expect(config.schedule).toEqual({
      kind: "daily",
      timeOfDay: "22:00",
      timeZone: "Europe/Berlin",
    });
    expect(config.onlyOnAcPower).toBe(false);
    expect(config.bandwidthKbps).toBeNull();
    expect(config.hooks).toEqual({});
  });

  it("backs a client up when it connects, at most once every 4 hours", () => {
    const config = defaultEndpointConfig("darwin", "client", options);
    expect(config.schedule).toEqual({
      kind: "on_connect",
      intervalMinutes: DEFAULT_CLIENT_INTERVAL_MINUTES,
      timeZone: "Europe/Berlin",
    });
    expect(DEFAULT_CLIENT_INTERVAL_MINUTES).toBe(240);
  });

  it("picks the paths per operating system", () => {
    expect(defaultEndpointConfig("linux", "server", options).paths).toEqual([
      "/etc",
      "/home",
      "/root",
      "/srv",
      "/var/www",
    ]);
    expect(defaultEndpointConfig("darwin", "client", options).paths).toEqual(["/Users"]);
    expect(defaultEndpointConfig("windows", "client", options).paths).toEqual(["C:\\Users"]);
    expect(defaultEndpointConfig("windows", "server", options).paths).toEqual([
      "C:\\Users",
      "C:\\ProgramData",
    ]);
  });

  it("excludes caches, temporary files, the trash, node_modules and the restic cache", () => {
    for (const os of ["linux", "darwin", "windows"] as const) {
      const excludes = defaultEndpointConfig(os, "client", options).excludes;
      expect(excludes).toContain("**/node_modules");
      expect(excludes).toContain("*.tmp");
      expect(excludes).toContain("**/.cache/restic");
      expect(excludes.length).toBeGreaterThan(5);
    }
    expect(defaultEndpointConfig("darwin", "client", options).excludes).toContain(
      "**/Library/Caches",
    );
    expect(defaultEndpointConfig("linux", "server", options).excludes).toContain("/var/cache");
  });

  it("uses a volume shadow copy on Windows only", () => {
    expect(defaultEndpointConfig("windows", "server", options).useVss).toBe(true);
    expect(defaultEndpointConfig("linux", "server", options).useVss).toBe(false);
    expect(defaultEndpointConfig("darwin", "client", options).useVss).toBe(false);
  });

  it("returns fresh arrays, so a change to one endpoint's config never reaches another", () => {
    const a = defaultEndpointConfig("linux", "server", options);
    const b = defaultEndpointConfig("linux", "server", options);
    a.paths.push("/extra");
    a.excludes.push("*.bak");
    expect(b.paths).not.toContain("/extra");
    expect(b.excludes).not.toContain("*.bak");
  });

  it("keeps 30 daily, 12 weekly and 12 monthly snapshots by default", () => {
    expect(DEFAULT_ENDPOINT_RETENTION).toEqual({ keepDaily: 30, keepWeekly: 12, keepMonthly: 12 });
  });

  it("enrolls Linux and macOS only in this release", () => {
    expect([...SUPPORTED_ENDPOINT_OS]).toEqual(["linux", "darwin"]);
    expect(isSupportedEndpointOs("linux")).toBe(true);
    expect(isSupportedEndpointOs("darwin")).toBe(true);
    expect(isSupportedEndpointOs("windows")).toBe(false);
    expect(isSupportedEndpointOs("freebsd")).toBe(false);
  });
});
