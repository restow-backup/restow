import { describe, expect, it } from "vitest";
import type { DbProbeResult } from "./facts.js";
import {
  advanceDbHealthState,
  DB_HEALTH_SLOW_MS,
  type DbHealthSampleInput,
  dbHealthDueAt,
  dbHealthEvents,
  dbHealthSizesDue,
  dbReachabilityOf,
  judgeDbHealth,
} from "./health.js";

const FINGERPRINT = `${"3A:".repeat(31)}3A`;
const OTHER = `${"0F:".repeat(31)}0F`;

function result(overrides: Partial<DbProbeResult> = {}): DbProbeResult {
  return {
    engine: "postgresql",
    port: 5432,
    serverVersion: "16.4",
    tls: {
      offered: true,
      used: true,
      fingerprintSha256: FINGERPRINT,
      subject: null,
      issuer: null,
      notAfter: null,
    },
    login: "ok",
    error: null,
    health: {
      latencyMs: 42,
      startedAt: "2026-11-01T00:00:00.000Z",
      connectionsUsed: 5,
      connectionsMax: 100,
      systemIdentifier: "7300000000000000042",
      serverUuid: null,
      serverId: null,
      datadir: null,
      databases: [
        { name: "erp", oid: "16384", sizeBytes: 1000 },
        { name: "template1", oid: "1", sizeBytes: 10 },
        { name: "hr", oid: "16390", sizeBytes: null },
      ],
    },
    durationMs: 50,
    ...overrides,
  };
}

const connection = {
  engine: "postgresql" as const,
  instanceKey: "postgresql:7300000000000000042",
  tlsFingerprint: FINGERPRINT,
};

describe("judging one health check (docs/DATABASES.md 8)", () => {
  it("keeps a good check with its values and the sizes it read", () => {
    expect(judgeDbHealth(result(), connection)).toEqual({
      ok: true,
      errorCode: null,
      errorMessage: null,
      latencyMs: 42,
      serverVersion: "16.4",
      startedAt: "2026-11-01T00:00:00.000Z",
      connectionsUsed: 5,
      connectionsMax: 100,
      tlsFingerprint: FINGERPRINT,
      instanceKey: "postgresql:7300000000000000042",
      sizes: [{ name: "erp", identity: "16384", sizeBytes: 1000 }],
    });
  });

  it("fails on another instance, engine or certificate, and on a refused sign-in", () => {
    const moved = result({
      health: {
        ...(result().health as NonNullable<DbProbeResult["health"]>),
        systemIdentifier: "1",
      },
    });
    expect(judgeDbHealth(moved, connection).errorCode).toBe("db_instance_changed");
    expect(judgeDbHealth(result({ engine: "mysql" }), connection).errorCode).toBe(
      "db_engine_changed",
    );
    expect(judgeDbHealth(result(), { ...connection, tlsFingerprint: OTHER })).toMatchObject({
      ok: false,
      errorCode: "db_tls_changed",
    });
    const plain = result({ tls: { ...result().tls, used: false, fingerprintSha256: null } });
    expect(judgeDbHealth(plain, connection).errorCode).toBe("db_tls_missing");
    const refused = result({
      login: "failed",
      health: undefined,
      error: { code: "db_login_failed", message: "password authentication failed" },
    });
    expect(judgeDbHealth(refused, connection)).toMatchObject({
      ok: false,
      errorCode: "db_login_failed",
    });
    const silent = result({
      engine: null,
      login: "skipped",
      health: undefined,
      error: { code: "db_unreachable", message: "timeout" },
    });
    expect(judgeDbHealth(silent, connection)).toMatchObject({
      ok: false,
      errorCode: "db_unreachable",
    });
  });

  it("takes an SQLite file and a SQL Server PRELOGIN as good checks", () => {
    const sqlite = judgeDbHealth(
      result({
        engine: "sqlite",
        port: null,
        login: "skipped",
        health: undefined,
        tls: { ...result().tls, used: false, fingerprintSha256: null },
        sqlite: {
          path: "/srv/app/data.db",
          sizeBytes: 4096,
          pageSize: 4096,
          inode: "12",
          device: "2049",
          createdAt: null,
          modifiedAt: null,
        },
      }),
      { engine: "sqlite", instanceKey: "sqlite:/srv/app/data.db:2049:12:", tlsFingerprint: null },
    );
    expect(sqlite).toMatchObject({
      ok: true,
      latencyMs: 50,
      sizes: [{ name: "data.db", identity: "12", sizeBytes: 4096 }],
    });
    const replaced = judgeDbHealth(
      result({
        engine: "sqlite",
        login: "skipped",
        health: undefined,
        sqlite: {
          path: "/srv/app/data.db",
          sizeBytes: 4096,
          pageSize: 4096,
          inode: "99",
          device: "2049",
          createdAt: null,
          modifiedAt: null,
        },
      }),
      { engine: "sqlite", instanceKey: "sqlite:/srv/app/data.db:2049:12:", tlsFingerprint: null },
    );
    expect(replaced.errorCode).toBe("db_instance_changed");
    const sqlserver = judgeDbHealth(
      result({
        engine: "sqlserver",
        login: "skipped",
        health: undefined,
        serverVersion: "16.0.1000",
        tls: { ...result().tls, used: false, fingerprintSha256: null },
        sqlserver: { version: "16.0.1000", encryption: "off" },
      }),
      { engine: "sqlserver", instanceKey: null, tlsFingerprint: null },
    );
    expect(sqlserver).toMatchObject({ ok: true, serverVersion: "16.0.1000" });
  });
});

describe("the episode of database.unreachable (2.4) [DB-005]", () => {
  const at = (minute: number) => new Date(Date.UTC(2026, 10, 17, 10, minute));
  const sample = (minute: number, ok: boolean): DbHealthSampleInput => ({
    at: at(minute),
    ok,
    errorCode: ok ? null : "db_unreachable",
    errorMessage: ok ? null : "timeout",
    latencyMs: ok ? 20 : null,
  });

  it("alerts after three failures in a row, once, and once more when it answers again", () => {
    const first = advanceDbHealthState(
      null,
      [sample(0, true), sample(5, false), sample(10, false)],
      at(11),
    );
    expect(first.alerts).toEqual([]);
    expect(first.state).toMatchObject({
      consecutiveFailures: 2,
      failingSince: at(5).toISOString(),
    });

    const second = advanceDbHealthState(
      first.state,
      [sample(15, false), sample(20, false)],
      at(21),
    );
    expect(second.alerts).toEqual([
      {
        kind: "unreachable",
        since: at(5).toISOString(),
        failures: 3,
        errorCode: "db_unreachable",
        errorMessage: "timeout",
      },
    ]);
    expect(second.state.unreachableAlertedAt).toBe(at(21).toISOString());

    // Samples already taken into account are not counted twice.
    expect(advanceDbHealthState(second.state, [sample(20, false)], at(22)).alerts).toEqual([]);

    const back = advanceDbHealthState(second.state, [sample(25, true)], at(26));
    expect(back.alerts).toEqual([
      { kind: "reachable", since: at(25).toISOString(), unreachableSince: at(5).toISOString() },
    ]);
    expect(back.state).toMatchObject({
      consecutiveFailures: 0,
      unreachableAlertedAt: null,
      lastOkAt: at(25).toISOString(),
    });
  });

  it("does not alert for a connection that fails now and then", () => {
    const flapping = [0, 5, 10, 15, 20, 25].map((minute, index) => sample(minute, index % 3 === 2));
    const { alerts, state } = advanceDbHealthState(null, flapping, at(30));
    expect(alerts).toEqual([]);
    expect(state.consecutiveFailures).toBe(0);
  });

  it("says nothing when it answers again without an alerted episode", () => {
    const { alerts } = advanceDbHealthState(null, [sample(0, false), sample(5, true)], at(6));
    expect(alerts).toEqual([]);
  });
});

describe("reachability, schedule and events", () => {
  const now = new Date("2026-11-17T12:00:00.000Z");
  const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();

  it("shows reachable, slow, unreachable, and unknown when the checks went quiet", () => {
    expect(dbReachabilityOf(null, 5, now)).toBe("unknown");
    expect(dbReachabilityOf({ lastAt: minutesAgo(2), lastOk: true, latencyMs: 30 }, 5, now)).toBe(
      "reachable",
    );
    expect(
      dbReachabilityOf(
        { lastAt: minutesAgo(2), lastOk: true, latencyMs: DB_HEALTH_SLOW_MS },
        5,
        now,
      ),
    ).toBe("slow");
    expect(
      dbReachabilityOf({ lastAt: minutesAgo(2), lastOk: false, latencyMs: null }, 5, now),
    ).toBe("unreachable");
    expect(dbReachabilityOf({ lastAt: minutesAgo(30), lastOk: true, latencyMs: 30 }, 5, now)).toBe(
      "unknown",
    );
  });

  it("is due an interval after the last check, sizes once an hour", () => {
    expect(dbHealthDueAt(null, 5, now)).toEqual(now);
    expect(dbHealthDueAt(new Date(minutesAgo(2)), 5, now).toISOString()).toBe(minutesAgo(-3));
    expect(dbHealthSizesDue(null, now)).toBe(true);
    expect(dbHealthSizesDue(new Date(minutesAgo(30)), now)).toBe(false);
    expect(dbHealthSizesDue(new Date(minutesAgo(60)), now)).toBe(true);
  });

  it("lists unreachable from/until, restarts, version changes and another certificate", () => {
    const base = {
      checks: 1,
      okChecks: 1,
      errorCode: null,
      serverVersion: "16.3",
      startedAt: new Date("2026-11-01T00:00:00.000Z"),
      tlsFingerprint: FINGERPRINT,
    };
    const events = dbHealthEvents([
      { ...base, at: new Date(minutesAgo(50)) },
      { ...base, at: new Date(minutesAgo(45)), okChecks: 0, errorCode: "db_unreachable" },
      { ...base, at: new Date(minutesAgo(40)), okChecks: 0, errorCode: "db_unreachable" },
      {
        ...base,
        at: new Date(minutesAgo(35)),
        serverVersion: "16.4",
        startedAt: new Date(minutesAgo(36)),
      },
      {
        ...base,
        at: new Date(minutesAgo(30)),
        serverVersion: "16.4",
        startedAt: new Date(minutesAgo(36)),
        tlsFingerprint: OTHER,
      },
      { ...base, at: new Date(minutesAgo(25)), okChecks: 0, errorCode: "db_login_failed" },
    ]);
    expect(events).toEqual([
      {
        kind: "unreachable",
        from: minutesAgo(45),
        to: minutesAgo(35),
        errorCode: "db_unreachable",
      },
      { kind: "version", at: minutesAgo(35), from: "16.3", to: "16.4" },
      { kind: "restart", at: minutesAgo(35), startedAt: minutesAgo(36) },
      { kind: "tls", at: minutesAgo(30) },
      { kind: "unreachable", from: minutesAgo(25), to: null, errorCode: "db_login_failed" },
    ]);
  });
});
