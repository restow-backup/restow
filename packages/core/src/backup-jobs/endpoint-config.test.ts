import { describe, expect, it } from "vitest";
import { type AgentConfig as EndpointConfig, defaultEndpointConfig } from "../endpoints/config.js";
import {
  buildEndpointConfig,
  configKey,
  effectiveSchedule,
  effectiveSettings,
  gibToBytes,
  retentionToWrite,
  sameEndpointConfig,
} from "./endpoint-config.js";

const ZONE = "Europe/Berlin";

function config(overrides: Partial<EndpointConfig> = {}): EndpointConfig {
  return { ...defaultEndpointConfig("linux", "server", { timeZone: ZONE }), ...overrides };
}

describe("effective settings", () => {
  it("lets a member's value replace the job's, and a null replace it with nothing", () => {
    const merged = effectiveSettings(
      { paths: ["/srv"], excludes: ["*.iso"], bandwidthKbps: 1000, hooks: { pre: "a" } },
      { paths: ["/srv", "/data"], bandwidthKbps: null },
    );
    expect(merged).toEqual({
      paths: ["/srv", "/data"],
      excludes: ["*.iso"],
      bandwidthKbps: null,
      hooks: { pre: "a" },
    });
  });

  it("treats the limit and its windows as one setting when a member overrides it", () => {
    const windows = [{ days: [1, 2, 3, 4, 5], from: "08:00", to: "18:00", kbps: 2000 }];
    const job = { bandwidthKbps: 500, bandwidthWindows: windows };
    // Without an override of either, the machine runs the job's limit and windows.
    expect(effectiveSettings(job, {})).toEqual(job);
    // A limit of its own (also one stored before windows existed) replaces the windows with it.
    expect(effectiveSettings(job, { bandwidthKbps: 100 })).toEqual({ bandwidthKbps: 100 });
    expect(effectiveSettings(job, { bandwidthKbps: null })).toEqual({ bandwidthKbps: null });
    // Windows of its own keep the job's default limit.
    const own = [{ days: [6, 7], from: "00:00", to: "00:00", kbps: 0 }];
    expect(effectiveSettings(job, { bandwidthWindows: own })).toEqual({
      bandwidthKbps: 500,
      bandwidthWindows: own,
    });
    // Both stated: exactly those. An empty list states "no windows".
    expect(effectiveSettings(job, { bandwidthKbps: 100, bandwidthWindows: [] })).toEqual({
      bandwidthKbps: 100,
      bandwidthWindows: [],
    });
    // An override of something else leaves the bandwidth alone.
    expect(effectiveSettings(job, { paths: ["/data"] })).toEqual({ ...job, paths: ["/data"] });
  });

  it("takes the member's schedule over the job's", () => {
    const job = { kind: "daily" as const, timeOfDay: "02:00", timeZone: ZONE };
    const own = { kind: "interval" as const, intervalMinutes: 60, timeZone: ZONE };
    expect(effectiveSchedule(job, { schedule: own })).toBe(own);
    expect(effectiveSchedule(job, {})).toBe(job);
    expect(effectiveSchedule(null, {})).toBeNull();
  });
});

describe("building the agent configuration", () => {
  it("keeps what no job decides and writes what the job decides", () => {
    const current = config({ onlyOnAcPower: true, useVss: false });
    const next = buildEndpointConfig(
      current,
      { kind: "daily", timeOfDay: "01:30", timeZone: ZONE },
      { paths: ["/srv"], excludes: ["*.iso"], hooks: { pre: "dump" }, bandwidthKbps: 2000 },
    );
    expect(next).toMatchObject({
      profile: "server",
      onlyOnAcPower: true,
      useVss: false,
      schedule: { kind: "daily", timeOfDay: "01:30", timeZone: ZONE },
      paths: ["/srv"],
      excludes: ["*.iso"],
      hooks: { pre: "dump" },
      bandwidthKbps: 2000,
    });
    expect("excludeLargerThanBytes" in next).toBe(false);
  });

  it("adds the size limit in bytes only when the job sets one, and drops it again", () => {
    const limited = buildEndpointConfig(config(), null, { excludeLargerThanGib: 4 });
    expect(limited.excludeLargerThanBytes).toBe(4 * 1024 ** 3);
    expect(gibToBytes(0.5)).toBe(512 * 1024 ** 2);
    const lifted = buildEndpointConfig(limited, null, { excludeLargerThanGib: null });
    expect("excludeLargerThanBytes" in lifted).toBe(false);
  });

  it("writes the bandwidth windows, in a fixed order, only when the job sets some", () => {
    const windows = [
      { days: [5, 1, 3], from: "18:00", to: "22:00", kbps: 0 },
      { days: [1, 2], from: "08:00", to: "17:00", kbps: 2000 },
    ];
    const limited = buildEndpointConfig(config(), null, {
      bandwidthKbps: 500,
      bandwidthWindows: windows,
    });
    expect(limited.bandwidthKbps).toBe(500);
    expect(limited.bandwidthWindows).toEqual([
      { days: [1, 2], from: "08:00", to: "17:00", kbps: 2000 },
      { days: [1, 3, 5], from: "18:00", to: "22:00", kbps: 0 },
    ]);
    // The same windows in another order write the same configuration: nothing to update on the machine.
    const again = buildEndpointConfig(limited, null, {
      bandwidthKbps: 500,
      bandwidthWindows: [...windows].reverse(),
    });
    expect(sameEndpointConfig(limited, again)).toBe(true);
    // A job without windows leaves none behind (and an empty list is none), byte for byte as before.
    for (const settings of [{ bandwidthKbps: 500 }, { bandwidthKbps: 500, bandwidthWindows: [] }]) {
      const lifted = buildEndpointConfig(limited, null, settings);
      expect("bandwidthWindows" in lifted).toBe(false);
      expect(sameEndpointConfig(lifted, config({ bandwidthKbps: 500 }))).toBe(true);
    }
    expect("bandwidthWindows" in buildEndpointConfig(config(), null, {})).toBe(false);
  });

  it("leaves a setting the job does not carry as the machine has it", () => {
    const current = config({ bandwidthKbps: 500, paths: ["/etc"] });
    const next = buildEndpointConfig(current, null, { excludes: [] });
    expect(next.paths).toEqual(["/etc"]);
    expect(next.bandwidthKbps).toBe(500);
    expect(next.excludes).toEqual([]);
    expect(next.schedule).toEqual(current.schedule);
  });

  it("gives back the very configuration a machine has when the job was made from it", () => {
    const current = config({
      schedule: { kind: "on_connect", intervalMinutes: 240, timeZone: ZONE },
      hooks: { pre: "dump" },
      bandwidthKbps: null,
    });
    const next = buildEndpointConfig(
      current,
      { kind: "on_connect", intervalMinutes: 240, timeZone: ZONE },
      {
        paths: current.paths,
        excludes: current.excludes,
        hooks: current.hooks,
        bandwidthKbps: current.bandwidthKbps,
      },
    );
    expect(sameEndpointConfig(current, next)).toBe(true);
  });

  it("compares configurations by meaning, not by key order or empty hooks", () => {
    const a = config();
    const reordered = JSON.parse(JSON.stringify(a), (_key, value) => value) as EndpointConfig;
    const b: EndpointConfig = {
      ...Object.fromEntries(Object.entries(reordered).reverse()),
      hooks: { pre: "" },
    } as EndpointConfig;
    expect(configKey(a)).toBe(configKey(b));
    expect(sameEndpointConfig(a, { ...a, paths: [...a.paths, "/extra"] })).toBe(false);
  });
});

describe("retention", () => {
  it("writes nothing when the job sets none or the machine keeps it already", () => {
    expect(retentionToWrite(undefined, { keepDaily: 1, keepWeekly: 1, keepMonthly: 1 })).toBeNull();
    expect(
      retentionToWrite({ keepDaily: 30, keepWeekly: 12, keepMonthly: 12 }, undefined),
    ).toBeNull();
    expect(
      retentionToWrite(
        { keepDaily: 7, keepWeekly: 4, keepMonthly: 12 },
        { keepDaily: 30, keepWeekly: 12, keepMonthly: 12 },
      ),
    ).toEqual({ keepDaily: 7, keepWeekly: 4, keepMonthly: 12 });
  });
});
