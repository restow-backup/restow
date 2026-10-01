import { describe, expect, it } from "vitest";
import {
  type AgentStateEntry,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_JITTER_MS,
  nextHeartbeatDelay,
  nextRunFor,
  parseState,
  serializeState,
} from "./agent-state.js";

const ENTRY: AgentStateEntry = {
  hostname: "fileserver-01",
  endpointId: "6f1c2a52-6c0b-4d3a-9d0e-3a1b2c4d5e6f",
  agentSecret: "rsea_example",
  agentVersion: "0.1.0",
  osVersion: "Debian GNU/Linux 12 (bookworm)",
  configVersion: 2,
  profile: "server",
  schedule: { kind: "daily", timeOfDay: "22:00", timeZone: "Europe/Berlin" },
};

describe("agent state file", () => {
  it("round-trips", () => {
    expect(parseState(serializeState([ENTRY]))).toEqual({ version: 1, agents: [ENTRY] });
  });

  it("refuses what is not a state file, and says why", () => {
    expect(() => parseState("not json")).toThrow(/not JSON/);
    expect(() => parseState("{}")).toThrow(/unknown format/);
    expect(() => parseState(JSON.stringify({ version: 2, agents: [] }))).toThrow(/unknown format/);
    expect(() => parseState(serializeState([{ ...ENTRY, endpointId: "../etc/passwd" }]))).toThrow(
      /agent 0/,
    );
    expect(() => parseState(serializeState([{ ...ENTRY, agentSecret: "" }]))).toThrow(/incomplete/);
    expect(() => parseState(serializeState([{ ...ENTRY, profile: "tablet" as never }]))).toThrow(
      /incomplete/,
    );
  });
});

describe("nextRunFor", () => {
  it("is the next 22:00 of the schedule's zone for a daily schedule", () => {
    expect(nextRunFor(ENTRY, new Date("2026-09-30T19:00:00Z"))?.toISOString()).toBe(
      "2026-09-30T20:00:00.000Z",
    );
    expect(nextRunFor(ENTRY, new Date("2026-09-30T20:30:00Z"))?.toISOString()).toBe(
      "2026-10-01T20:00:00.000Z",
    );
  });

  it("follows an interval and is null when the machine backs up when it connects", () => {
    const now = new Date("2026-09-30T10:00:00Z");
    expect(
      nextRunFor(
        { ...ENTRY, schedule: { kind: "interval", intervalMinutes: 60 } },
        now,
      )?.toISOString(),
    ).toBe("2026-09-30T11:00:00.000Z");
    expect(nextRunFor({ ...ENTRY, schedule: { kind: "on_connect" } }, now)).toBeNull();
  });
});

describe("nextHeartbeatDelay", () => {
  it("is five minutes give or take a minute", () => {
    expect(nextHeartbeatDelay(() => 0.5)).toBe(HEARTBEAT_INTERVAL_MS);
    expect(nextHeartbeatDelay(() => 0)).toBe(HEARTBEAT_INTERVAL_MS - HEARTBEAT_JITTER_MS);
    expect(nextHeartbeatDelay(() => 1)).toBe(HEARTBEAT_INTERVAL_MS + HEARTBEAT_JITTER_MS);
  });
});
