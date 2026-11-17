// The health checks of database connections against a real Postgres (docs/DATABASES.md 8):
//
//   - a connection of the Restow server is checked when its interval has passed, with the
//     confirmed certificate and only the private networks its approval allows; the credentials go
//     to the check and nowhere else, the stored message is cleaned of them;
//   - the sizes are read at most once an hour and follow the database rows;
//   - three failures in a row raise `database.unreachable` once, the first good check after it
//     `database.reachable`, also for the checks an agent reported;
//   - Restow's own database is refused, restore mode stops the checks;
//   - raw samples older than 14 days fold into hours.
//
// Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server (a database named
// `restow_worker_dbhealth_test` is recreated there); skipped otherwise.

import { randomUUID } from "node:crypto";
import type { DbHealthCheckOptions, DbHealthCheckTarget, DbProbeResult } from "@restow/core";
import { createDb } from "@restow/db";
import { runMigrations } from "@restow/db/migrate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dropTestDatabase } from "../testing/database.js";
import { type DatabaseHealthDeps, databaseHealthPass } from "./health.js";

const adminUrl = process.env.RESTOW_TEST_DATABASE_URL;
const TEST_DB = "restow_worker_dbhealth_test";
const FINGERPRINT = `${"3A:".repeat(31)}3A`;
const PASSWORD = "pw-very-secret-42";
const USER = "backup_operator";
const MINUTE = 60_000;

function good(sizes: boolean, systemIdentifier = "7300000000000000042"): DbProbeResult {
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
      latencyMs: 25,
      startedAt: "2026-11-01T00:00:00.000Z",
      connectionsUsed: 7,
      connectionsMax: 100,
      systemIdentifier,
      serverUuid: null,
      serverId: null,
      datadir: null,
      databases: sizes ? [{ name: "erp", oid: "16384", sizeBytes: 123_456 }] : null,
    },
    durationMs: 30,
  };
}

function unreachable(): DbProbeResult {
  return {
    engine: null,
    port: null,
    serverVersion: null,
    tls: {
      offered: null,
      used: false,
      fingerprintSha256: null,
      subject: null,
      issuer: null,
      notAfter: null,
    },
    login: "skipped",
    // A client that repeats what it was given: the stored text must not.
    error: { code: "db_unreachable", message: `connect timeout for ${USER}:${PASSWORD}` },
    durationMs: 10_000,
  };
}

describe.skipIf(!adminUrl)("database health checks against Postgres [DB-005]", () => {
  let db: ReturnType<typeof createDb>;
  let tenantId: string;
  let connectionId: string;
  let agentConnectionId: string;
  let databaseId: string;
  let now = new Date("2026-11-17T10:00:00.000Z");
  let restoreMode = false;
  let ownTargets: () => Promise<{ address: string; port: number }[]> = async () => [
    { address: "10.9.9.9", port: 5432 },
  ];
  let next: () => DbProbeResult = () => good(true);
  const calls: { target: DbHealthCheckTarget; options: DbHealthCheckOptions }[] = [];

  const q = <T extends Record<string, unknown>>(text: string, values: unknown[] = []) =>
    db.$client.query<T>(text, values).then((result) => result.rows);

  const deps = (): DatabaseHealthDeps => ({
    db,
    providerDb: db,
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    now: () => now,
    privateNetworksAllowed: false,
    restoreModeActive: async () => restoreMode,
    readCredentials: async () => ({ user: USER, password: PASSWORD }),
    check: async (target, options) => {
      calls.push({ target, options });
      return next();
    },
    ownSystemIdentifier: async () => "6000000000000000001",
    ownDatabaseTargets: () => ownTargets(),
  });

  const events = (event: string) =>
    q<{ details: Record<string, unknown>; message: string }>(
      "SELECT details, message FROM notifications WHERE event = $1 ORDER BY created_at",
      [event],
    );

  beforeAll(async () => {
    const admin = createDb(adminUrl as string);
    await admin.$client.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await admin.$client.query(`CREATE DATABASE ${TEST_DB}`);
    await admin.$client.end();
    const url = new URL(adminUrl as string);
    url.pathname = `/${TEST_DB}`;
    await runMigrations(url.toString());
    db = createDb(url.toString());
    const [provider] = await q<{ id: string }>(
      "INSERT INTO providers (name) VALUES ('p') RETURNING id",
    );
    const [tenant] = await q<{ id: string }>(
      "INSERT INTO tenants (provider_id, name, slug, status) VALUES ($1, 'Contoso', 'contoso', 'active') RETURNING id",
      [provider?.id],
    );
    tenantId = tenant?.id ?? "";
    const schedule = JSON.stringify({ kind: "interval", intervalMinutes: 60, timeZone: "UTC" });
    const [connection] = await q<{ id: string }>(
      `INSERT INTO database_connections
         (tenant_id, name, engine, host, port, executor_kind, auth_method, schedule, tls_fingerprint,
          instance_key, credential_secret_id)
       VALUES ($1, 'ERP', 'postgresql', 'db.example.test', 5432, 'server', 'password', $2::jsonb, $3,
               'postgresql:7300000000000000042', NULL) RETURNING id`,
      [tenantId, schedule, FINGERPRINT],
    );
    connectionId = connection?.id ?? "";
    const [endpoint] = await q<{ id: string }>(
      `INSERT INTO endpoints (tenant_id, hostname, os, arch, profile, secret_hash, config)
       VALUES ($1, 'bridge', 'linux', 'amd64', 'server', 'x', '{}'::jsonb) RETURNING id`,
      [tenantId],
    );
    const [agentConnection] = await q<{ id: string }>(
      `INSERT INTO database_connections
         (tenant_id, name, engine, host, port, executor_kind, executor_endpoint_id, schedule)
       VALUES ($1, 'Shop', 'mysql', 'shop.lan', 3306, 'agent', $2, $3::jsonb) RETURNING id`,
      [tenantId, endpoint?.id, schedule],
    );
    agentConnectionId = agentConnection?.id ?? "";
    const [database] = await q<{ id: string }>(
      `INSERT INTO databases (tenant_id, connection_id, name, identity, instance_key)
       VALUES ($1, $2, 'erp', '16384', 'postgresql:7300000000000000042') RETURNING id`,
      [tenantId, connectionId],
    );
    databaseId = database?.id ?? "";
    // The server check needs credentials: a secret row is referenced, the test reads none.
    const [secret] = await q<{ id: string }>(
      `INSERT INTO secrets (tenant_id, kind, ciphertext, key_version)
       VALUES ($1, 'database_credentials', 'x', 1) RETURNING id`,
      [tenantId],
    );
    await q("UPDATE database_connections SET credential_secret_id = $1 WHERE id = $2", [
      secret?.id,
      connectionId,
    ]);
  }, 120_000);

  afterAll(async () => {
    await db?.$client.end();
    if (adminUrl) {
      await dropTestDatabase(adminUrl, TEST_DB);
    }
  });

  it("checks a due connection with its certificate and its network approval, sizes once an hour [DB-004]", async () => {
    const summary = await databaseHealthPass(deps(), { compact: false });
    expect(summary).toMatchObject({ checked: 1, failed: 0, evaluated: 1, alerts: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.target).toMatchObject({
      engine: "postgresql",
      host: "db.example.test",
      pinnedFingerprintSha256: FINGERPRINT,
      user: USER,
      password: PASSWORD,
      sizes: true,
    });
    expect(calls[0]?.options).toEqual({
      allowPrivateNetworks: false,
      approvedAddresses: [],
      forbiddenTargets: [{ address: "10.9.9.9", port: 5432 }],
    });
    const [sample] = await q<{
      ok_checks: number;
      latency_ms: number;
      connections_used: number;
      sizes: Record<string, number>;
      executor_kind: string;
    }>("SELECT * FROM database_health_samples WHERE connection_id = $1", [connectionId]);
    expect(sample).toMatchObject({
      ok_checks: 1,
      latency_ms: 25,
      connections_used: 7,
      executor_kind: "server",
      sizes: { [databaseId]: 123_456 },
    });
    const [database] = await q<{ size_bytes: string }>(
      "SELECT size_bytes::text FROM databases WHERE id = $1",
      [databaseId],
    );
    expect(database?.size_bytes).toBe("123456");

    // Not due again within its interval; due after it, without the sizes this time.
    now = new Date(now.getTime() + 2 * MINUTE);
    expect((await databaseHealthPass(deps(), { compact: false })).checked).toBe(0);
    now = new Date(now.getTime() + 4 * MINUTE);
    next = () => good(false);
    expect((await databaseHealthPass(deps(), { compact: false })).checked).toBe(1);
    expect(calls.at(-1)?.target.sizes).toBe(false);

    // A provider admin's approval reaches the addresses it names and no others; private networks
    // as a whole only with the installation flag. An approval without addresses reaches none.
    const approval = {
      by: "p@example.test",
      at: "2026-11-17T00:00:00Z",
      addresses: ["192.168.10.20"],
    };
    await q("UPDATE database_connections SET private_network_approval = $2::jsonb WHERE id = $1", [
      connectionId,
      JSON.stringify(approval),
    ]);
    now = new Date(now.getTime() + 6 * MINUTE);
    await databaseHealthPass(deps(), { compact: false });
    expect(calls.at(-1)?.options).toMatchObject({
      allowPrivateNetworks: false,
      approvedAddresses: ["192.168.10.20"],
    });
    await q(
      `UPDATE database_connections SET private_network_approval = '{"by":"p@example.test","at":"2026-11-17T00:00:00Z"}'::jsonb WHERE id = $1`,
      [connectionId],
    );
    now = new Date(now.getTime() + 6 * MINUTE);
    await databaseHealthPass(deps(), { compact: false });
    expect(calls.at(-1)?.options).toMatchObject({
      allowPrivateNetworks: false,
      approvedAddresses: [],
    });
    await q("UPDATE database_connections SET private_network_approval = $2::jsonb WHERE id = $1", [
      connectionId,
      JSON.stringify(approval),
    ]);
  });

  it("raises database.unreachable after three failures in a row and database.reachable once after", async () => {
    next = unreachable;
    for (let index = 0; index < 4; index++) {
      now = new Date(now.getTime() + 6 * MINUTE);
      const summary = await databaseHealthPass(deps(), { compact: false });
      expect(summary.failed).toBe(1);
    }
    const down = await events("database.unreachable");
    expect(down).toHaveLength(1);
    expect(down[0]?.details).toMatchObject({
      connectionId,
      objectName: "ERP",
      failures: 3,
      errorCode: "db_unreachable",
    });
    const stored = JSON.stringify(
      await q("SELECT error_message FROM database_health_samples WHERE connection_id = $1", [
        connectionId,
      ]),
    );
    expect(stored).toContain("connect timeout");
    expect(stored).not.toContain(PASSWORD);
    expect(stored).not.toContain(USER);
    expect(JSON.stringify(down)).not.toContain(PASSWORD);

    next = () => good(false);
    now = new Date(now.getTime() + 6 * MINUTE);
    await databaseHealthPass(deps(), { compact: false });
    now = new Date(now.getTime() + 6 * MINUTE);
    await databaseHealthPass(deps(), { compact: false });
    expect(await events("database.reachable")).toHaveLength(1);
    expect(await events("database.unreachable")).toHaveLength(1);
    const [connection] = await q<{ health: Record<string, unknown> }>(
      "SELECT health FROM database_connections WHERE id = $1",
      [connectionId],
    );
    expect(connection?.health).toMatchObject({
      lastOk: true,
      consecutiveFailures: 0,
      unreachableAlertedAt: null,
    });
  });

  it("evaluates the checks an agent reported the same way", async () => {
    for (let minute = 1; minute <= 3; minute++) {
      await q(
        `INSERT INTO database_health_samples (tenant_id, connection_id, at, executor_kind, ok_checks, error_code)
         VALUES ($1, $2, $3, 'agent', 0, 'db_login_failed')`,
        [tenantId, agentConnectionId, new Date(now.getTime() - (10 - minute) * MINUTE)],
      );
    }
    await databaseHealthPass(deps(), { compact: false });
    const down = (await events("database.unreachable")).filter(
      (row) => row.details.connectionId === agentConnectionId,
    );
    expect(down).toHaveLength(1);
    expect(down[0]?.details).toMatchObject({ errorCode: "db_login_failed", executor: "agent" });
  });

  it("refuses Restow's own database and keeps none of its facts", async () => {
    next = () => good(false, "6000000000000000001");
    now = new Date(now.getTime() + 6 * MINUTE);
    await databaseHealthPass(deps(), { compact: false });
    const [sample] = await q<{
      ok_checks: number;
      error_code: string;
      server_version: string | null;
      instance_key: string | null;
    }>(
      "SELECT ok_checks, error_code, server_version, instance_key FROM database_health_samples WHERE connection_id = $1 ORDER BY at DESC LIMIT 1",
      [connectionId],
    );
    expect(sample).toEqual({
      ok_checks: 0,
      error_code: "db_target_is_restow",
      server_version: null,
      instance_key: null,
    });
  });

  it("waits instead of checking unguarded when Restow's own database cannot be located", async () => {
    ownTargets = async () => {
      throw new Error("the database host db does not resolve");
    };
    const before = calls.length;
    now = new Date(now.getTime() + 60 * MINUTE);
    const summary = await databaseHealthPass(deps(), { compact: false });
    expect(summary).toMatchObject({ checked: 0, waiting: 1 });
    expect(calls.length).toBe(before);
    ownTargets = async () => [{ address: "10.9.9.9", port: 5432 }];
  });

  it("never renews an approval or takes a certificate it sees", async () => {
    const [before] = await q<{ approval: unknown; fingerprint: string; confirmed: string }>(
      "SELECT private_network_approval AS approval, tls_fingerprint AS fingerprint, tls_confirmed_at::text AS confirmed FROM database_connections WHERE id = $1",
      [connectionId],
    );
    next = () => ({
      ...good(false),
      login: "skipped",
      health: undefined,
      tls: { ...good(false).tls, fingerprintSha256: `${"0F:".repeat(31)}0F` },
      error: { code: "db_tls_changed", message: "another certificate" },
    });
    now = new Date(now.getTime() + 60 * MINUTE);
    await databaseHealthPass(deps(), { compact: false });
    const [after] = await q<{ approval: unknown; fingerprint: string; confirmed: string }>(
      "SELECT private_network_approval AS approval, tls_fingerprint AS fingerprint, tls_confirmed_at::text AS confirmed FROM database_connections WHERE id = $1",
      [connectionId],
    );
    expect(after).toEqual(before);
    expect(after?.fingerprint).toBe(FINGERPRINT);
    const [sample] = await q<{ error_code: string }>(
      "SELECT error_code FROM database_health_samples WHERE connection_id = $1 ORDER BY at DESC LIMIT 1",
      [connectionId],
    );
    expect(sample?.error_code).toBe("db_tls_changed");
    next = () => good(false);
  });

  it("checks nothing while restore mode is on", async () => {
    restoreMode = true;
    const before = calls.length;
    now = new Date(now.getTime() + 60 * MINUTE);
    expect((await databaseHealthPass(deps(), { compact: false })).checked).toBe(0);
    expect(calls.length).toBe(before);
    restoreMode = false;
  });

  it("folds raw samples older than 14 days into hours", async () => {
    const old = new Date(now.getTime() - 20 * 24 * 60 * MINUTE);
    const hour = new Date(Math.floor(old.getTime() / 3_600_000) * 3_600_000);
    for (const [offset, ok, latency] of [
      [5, 1, 10],
      [20, 1, 30],
      [40, 0, null],
    ] as const) {
      await q(
        `INSERT INTO database_health_samples (tenant_id, connection_id, at, executor_kind, ok_checks, latency_ms, latency_min_ms, latency_max_ms, error_code)
         VALUES ($1, $2, $3, 'server', $4, $5, $5, $5, $6)`,
        [
          tenantId,
          connectionId,
          new Date(hour.getTime() + offset * MINUTE),
          ok,
          latency,
          ok ? null : "db_unreachable",
        ],
      );
    }
    const id = randomUUID();
    await q(
      `INSERT INTO database_health_samples (id, tenant_id, connection_id, at, resolution, executor_kind, checks, ok_checks)
       VALUES ($1, $2, $3, $4, 'hour', 'server', 12, 12)`,
      [id, tenantId, connectionId, new Date(now.getTime() - 500 * 24 * 60 * MINUTE)],
    );
    const summary = await databaseHealthPass(deps(), { compact: true });
    expect(summary.folded).toBeGreaterThanOrEqual(3);
    expect(summary.dropped).toBe(1);
    const rows = await q<{
      resolution: string;
      checks: number;
      ok_checks: number;
      latency_ms: number;
      latency_min_ms: number;
      latency_max_ms: number;
      error_code: string;
    }>(
      "SELECT resolution, checks, ok_checks, latency_ms, latency_min_ms, latency_max_ms, error_code FROM database_health_samples WHERE connection_id = $1 AND at = $2",
      [connectionId, hour],
    );
    expect(rows).toEqual([
      {
        resolution: "hour",
        checks: 3,
        ok_checks: 2,
        latency_ms: 20,
        latency_min_ms: 10,
        latency_max_ms: 30,
        error_code: "db_unreachable",
      },
    ]);
  });
});
