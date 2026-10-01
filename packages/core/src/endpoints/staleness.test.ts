import { describe, expect, it } from "vitest";
import { ONLINE_WINDOW_MS, connectionOf, endpointStaleness } from "./staleness.js";

const now = new Date("2026-09-30T12:00:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms);
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const base = {
  status: "active" as const,
  createdAt: ago(30 * DAY),
  lastSeenAt: ago(5 * 60 * 1000),
  lastSuccessAt: ago(3 * HOUR),
  settings: null,
};

describe("when an endpoint counts as silent", () => {
  it("flags a server after more than 2 hours without contact", () => {
    const server = { ...base, profile: "server" as const };
    expect(endpointStaleness({ ...server, lastSeenAt: ago(HOUR) }, now).silent).toBe(false);
    expect(endpointStaleness({ ...server, lastSeenAt: ago(2 * HOUR) }, now).silent).toBe(false);
    expect(endpointStaleness({ ...server, lastSeenAt: ago(2 * HOUR + 1) }, now).silent).toBe(true);
  });

  it("uses the limit set on the server", () => {
    const server = { ...base, profile: "server" as const, settings: { staleAfterHours: 6 } };
    expect(endpointStaleness({ ...server, lastSeenAt: ago(5 * HOUR) }, now).silent).toBe(false);
    expect(endpointStaleness({ ...server, lastSeenAt: ago(7 * HOUR) }, now)).toMatchObject({
      silent: true,
      limit: { hours: 6 },
    });
  });

  it("counts a server that never reported from its creation", () => {
    const fresh = {
      ...base,
      profile: "server" as const,
      lastSeenAt: null,
      createdAt: ago(3 * HOUR),
    };
    expect(endpointStaleness(fresh, now).silent).toBe(true);
    expect(endpointStaleness({ ...fresh, createdAt: ago(HOUR) }, now).silent).toBe(false);
  });

  it("never calls a client silent, but flags a backup older than 7 days", () => {
    const client = { ...base, profile: "client" as const, lastSeenAt: ago(20 * DAY) };
    expect(endpointStaleness(client, now).silent).toBe(false);
    expect(endpointStaleness({ ...client, lastSuccessAt: ago(6 * DAY) }, now).backupOverdue).toBe(
      false,
    );
    expect(endpointStaleness({ ...client, lastSuccessAt: ago(8 * DAY) }, now)).toMatchObject({
      backupOverdue: true,
      limit: { days: 7 },
    });
    expect(
      endpointStaleness(
        { ...client, lastSuccessAt: ago(8 * DAY), settings: { staleAfterDays: 14 } },
        now,
      ).backupOverdue,
    ).toBe(false);
  });

  it("says nothing about a revoked endpoint", () => {
    const revoked = {
      ...base,
      profile: "server" as const,
      status: "revoked" as const,
      lastSeenAt: ago(9 * DAY),
    };
    expect(endpointStaleness(revoked, now)).toEqual({
      silent: false,
      backupOverdue: false,
      limit: {},
    });
  });
});

describe("connection state", () => {
  it("is online within three heartbeats, offline after, never before the first contact", () => {
    expect(ONLINE_WINDOW_MS).toBe(15 * 60 * 1000);
    expect(connectionOf(ago(60_000), now)).toBe("online");
    expect(connectionOf(ago(ONLINE_WINDOW_MS), now)).toBe("online");
    expect(connectionOf(ago(ONLINE_WINDOW_MS + 1), now)).toBe("offline");
    expect(connectionOf(null, now)).toBe("never");
  });
});
