// Backup and restore runs of the Restow server against a real PostgreSQL with TLS
// (docs/DATABASES.md 4.3, 5.1, 5.2, 7.1, 16 "D3"):
//
//   - a due connection gets one run; the run dumps the selected database through the pinning
//     relay into the connection's own restic repository (one snapshot per database, plus the
//     instance's globals) and records SHA-256, size and objects;
//   - a restore goes into a new database under a new name, on the same connection and on another
//     one, never over an existing database, refused without CREATEDB, and drops only the
//     database it created when it fails (by name and OID);
//   - a dump that fails leaves no snapshot; a due run beside an active one is dropped visibly.
//
// Runs when RESTOW_TEST_DATABASE_URL (the worker's database, a superuser) and
// RESTOW_TEST_DATABASE_TLS_URL (a PostgreSQL with ssl = on, docs/CI.md "Postgres suites") are set
// and restic and the PostgreSQL client programs are installed; skipped otherwise.

import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  choosePgTools,
  generateDek,
  installDeletionEnforcement,
  Keyring,
  LocalStorageBackend,
  openPgAdminSession,
  type PgAdminSession,
  pgQuoteIdent,
  pgQuoteLiteral,
  probeDatabaseFromServer,
  resticSnapshots,
  withRepository,
} from "@restow/core";
import { createDb, databaseBackups, databaseConnections, databaseRuns } from "@restow/db";
import { runMigrations } from "@restow/db/migrate";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TenantCache } from "../handlers/framework.js";
import { dropTestDatabase } from "../testing/database.js";
import {
  type DatabaseRunDeps,
  databaseRetention,
  databaseRunsPass,
  defaultRestoreName,
  ensureDatabaseRepository,
  insertDatabaseRun,
  runDatabaseJob,
} from "./runs.js";

const adminUrl = process.env.RESTOW_TEST_DATABASE_URL;
const tlsUrl = process.env.RESTOW_TEST_DATABASE_TLS_URL;
const TEST_DB = "restow_worker_dbruns_test";
const suffix = randomBytes(4).toString("hex");
const SOURCE = `restow_d3_src_${suffix}`;
const NO_CREATE = `restow_d3_nocreate_${suffix}`;
const NO_CREATE_PASSWORD = `pw-${randomBytes(8).toString("hex")}`;
/** A role whose sessions read backslashes in literals the old way (standard_conforming_strings). */
const OLD_STRINGS = `restow_d3_oldstrings_${suffix}`;
const OLD_STRINGS_PASSWORD = `pw-${randomBytes(8).toString("hex")}`;

const tls = tlsUrl ? new URL(tlsUrl) : null;
const host = tls?.hostname ?? "localhost";
const port = Number(tls?.port || 5432);
const user = decodeURIComponent(tls?.username ?? "");
const password = decodeURIComponent(tls?.password ?? "");
const network = { allowPrivateNetworks: true, approvedAddresses: [], forbiddenTargets: [] };

describe.skipIf(!adminUrl || !tlsUrl)("database runs of the Restow server [DB-007]", () => {
  let db: ReturnType<typeof createDb>;
  let tenantId: string;
  let connectionId: string;
  let otherConnectionId: string;
  let fingerprint = "";
  let storageDir = "";
  let customer: PgAdminSession;
  const credentials: Record<string, { user: string; password: string }> = {};
  const queued: { tenantId: string; runId: string }[] = [];
  let now = new Date("2026-11-18T10:00:00.000Z");
  let writeOnce = false;
  const keys = new Keyring("x", [generateDek(1)]);

  const q = <T extends Record<string, unknown>>(text: string, values: unknown[] = []) =>
    db.$client.query<T>(text, values).then((result) => result.rows);

  const deps = (): DatabaseRunDeps => ({
    db,
    providerDb: db,
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    now: () => now,
    keyrings: new TenantCache(async () => keys),
    primaryStorage: async () => new LocalStorageBackend(storageDir),
    primaryWriteOnce: async () => writeOnce,
    privateNetworksAllowed: true,
    restoreModeActive: async () => false,
    readCredentials: async (_tenant, secretId) =>
      credentials[secretId] ?? { user: null, password: null },
    ownSystemIdentifier: async () => "6000000000000000001",
    ownDatabaseTargets: async () => [{ address: "10.9.9.9", port: 5432 }],
    enqueue: async (payload) => {
      queued.push(payload);
    },
    dbStreamCommand: [process.execPath, fileURLToPath(new URL("./db-stream.ts", import.meta.url))],
  });

  const runOf = async (id: string) => {
    const [row] = await db.select().from(databaseRuns).where(eq(databaseRuns.id, id));
    return row;
  };
  const connectionRow = async (id: string) => {
    const [row] = await q<Record<string, unknown>>(
      "SELECT * FROM database_connections WHERE id = $1",
      [id],
    );
    return row;
  };
  const customerQuery = async (database: string, sql: string) => {
    const opened = await openPgAdminSession(
      { host, port, allowUnencrypted: false, pinnedFingerprintSha256: fingerprint },
      network,
      { user, password },
      database,
    );
    if (!opened.ok) throw new Error(opened.message);
    try {
      return await opened.session.query(sql);
    } finally {
      opened.session.close();
    }
  };
  const restore = async (
    target: string,
    name: string,
    backupId: string,
  ): Promise<NonNullable<Awaited<ReturnType<typeof runOf>>>> => {
    const [connection] = await q<{
      id: string;
      tenant_id: string;
      executor_kind: "server";
      executor_endpoint_id: null;
    }>(
      "SELECT id, tenant_id, executor_kind, executor_endpoint_id FROM database_connections WHERE id = $1",
      [connectionId],
    );
    const run = await insertDatabaseRun(
      db,
      {
        id: connectionId,
        tenantId: connection?.tenant_id as string,
        executorKind: "server",
        executorEndpointId: null,
      },
      {
        kind: "restore",
        trigger: "manual",
        sourceBackupId: backupId,
        targetConnectionId: target,
        targetName: name,
      },
      now,
    );
    if (!run) throw new Error("no run");
    await runDatabaseJob(deps(), { tenantId, runId: run.id });
    return (await runOf(run.id)) as NonNullable<Awaited<ReturnType<typeof runOf>>>;
  };

  beforeAll(async () => {
    const admin = createDb(adminUrl as string);
    await admin.$client.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await admin.$client.query(`CREATE DATABASE ${TEST_DB}`);
    await admin.$client.end();
    const url = new URL(adminUrl as string);
    url.pathname = `/${TEST_DB}`;
    await runMigrations(url.toString());
    db = createDb(url.toString());
    storageDir = await mkdtemp(join(tmpdir(), "restow-dbruns-"));

    const probe = await probeDatabaseFromServer(
      {
        probeId: "00000000-0000-4000-8000-000000000004",
        engine: "postgresql",
        host,
        port,
        path: null,
        database: null,
        authMethod: "password",
        user,
        password,
        allowUnencrypted: false,
        timeoutSeconds: 20,
      },
      network,
    );
    fingerprint = probe.tls.fingerprintSha256 ?? "";
    const opened = await openPgAdminSession(
      { host, port, allowUnencrypted: false, pinnedFingerprintSha256: fingerprint },
      network,
      { user, password },
      "postgres",
    );
    if (!opened.ok) throw new Error(opened.message);
    customer = opened.session;
    await customer.query(`CREATE DATABASE ${pgQuoteIdent(SOURCE)}`);
    await customerQuery(
      SOURCE,
      "CREATE TABLE orders (id int PRIMARY KEY, item text); INSERT INTO orders VALUES (1, 'tea'), (2, 'cake'); CREATE VIEW cheap AS SELECT id FROM orders",
    );
    await customer.query(
      `CREATE ROLE ${pgQuoteIdent(NO_CREATE)} LOGIN PASSWORD '${NO_CREATE_PASSWORD}'`,
    );
    await customer.query(
      `CREATE ROLE ${pgQuoteIdent(OLD_STRINGS)} LOGIN CREATEDB PASSWORD '${OLD_STRINGS_PASSWORD}'`,
    );
    await customer.query(
      `ALTER ROLE ${pgQuoteIdent(OLD_STRINGS)} SET standard_conforming_strings = off`,
    );

    const [provider] = await q<{ id: string }>(
      "INSERT INTO providers (name) VALUES ('p') RETURNING id",
    );
    const [tenant] = await q<{ id: string }>(
      "INSERT INTO tenants (provider_id, name, slug, status) VALUES ($1, 'Contoso', 'contoso', 'active') RETURNING id",
      [provider?.id],
    );
    tenantId = tenant?.id ?? "";
    const secret = async (owner: { user: string; password: string }) => {
      const [row] = await q<{ id: string }>(
        `INSERT INTO secrets (tenant_id, kind, ciphertext, key_version)
         VALUES ($1, 'database_credentials', 'x', 1) RETURNING id`,
        [tenantId],
      );
      credentials[row?.id as string] = owner;
      return row?.id as string;
    };
    const schedule = JSON.stringify({ kind: "interval", intervalMinutes: 60, timeZone: "UTC" });
    const selection = JSON.stringify({ mode: "selected", names: [SOURCE], exclude: [] });
    const add = async (
      name: string,
      address: string,
      owner: { user: string; password: string },
    ) => {
      const [row] = await q<{ id: string }>(
        `INSERT INTO database_connections
           (tenant_id, name, engine, host, port, executor_kind, auth_method, schedule, selection,
            tls_fingerprint, credential_secret_id)
         VALUES ($1, $2, 'postgresql', $3, $4, 'server', 'password', $5::jsonb, $6::jsonb, $7, $8)
         RETURNING id`,
        [tenantId, name, address, port, schedule, selection, fingerprint, await secret(owner)],
      );
      return row?.id as string;
    };
    connectionId = await add("ERP", host, { user, password });
    otherConnectionId = await add("Test instance", host, { user, password });
  }, 120_000);

  afterAll(async () => {
    if (customer) {
      const leftovers = await customer.query(
        `SELECT datname FROM pg_database WHERE datname LIKE 'restow_d3_%${suffix}%' OR datname LIKE '${SOURCE}%'`,
      );
      for (const [name] of leftovers) {
        await customer.query(
          `DROP DATABASE IF EXISTS ${pgQuoteIdent(name as string)} WITH (FORCE)`,
        );
      }
      await customer.query(`DROP ROLE IF EXISTS ${pgQuoteIdent(NO_CREATE)}`);
      await customer.query(`DROP ROLE IF EXISTS ${pgQuoteIdent(OLD_STRINGS)}`);
      customer.close();
    }
    await db?.$client.end();
    if (adminUrl) await dropTestDatabase(adminUrl, TEST_DB);
    if (storageDir) await rm(storageDir, { recursive: true, force: true });
  });

  it("plans a due backup and dumps the database into the connection's repository [DB-007]", async () => {
    const summary = await databaseRunsPass(deps());
    expect(summary.planned).toBe(2);
    const mine = queued.find((entry) => entry.runId && entry.tenantId === tenantId);
    expect(mine).toBeDefined();
    const runs = await db
      .select()
      .from(databaseRuns)
      .where(eq(databaseRuns.connectionId, connectionId));
    expect(runs).toHaveLength(1);
    const run = runs[0];
    if (!run) throw new Error("no run");
    await runDatabaseJob(deps(), { tenantId, runId: run.id });
    const done = await runOf(run.id);
    expect(done).toMatchObject({ status: "succeeded", errorCode: null });
    const backups = await db
      .select()
      .from(databaseBackups)
      .where(eq(databaseBackups.connectionId, connectionId));
    expect(backups.map((backup) => backup.kind).sort()).toEqual(["database", "globals"]);
    const dump = backups.find((backup) => backup.kind === "database");
    expect(dump).toMatchObject({ databaseName: SOURCE, fileName: `postgresql/${SOURCE}.pgdump` });
    expect(dump?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(dump?.bytes).toBeGreaterThan(0);
    expect(dump?.objects).toMatchObject({ TABLE: 1, "TABLE DATA": 1, VIEW: 1 });
    // The connection now has its own repository; restic holds one snapshot per backup.
    const connection = await connectionRow(connectionId);
    expect(connection?.repository_secret_id).toBeTruthy();
    expect(connection?.repository_initialized_at).toBeTruthy();
    const [full] = await db
      .select()
      .from(databaseConnections)
      .where(eq(databaseConnections.id, connectionId));
    const access = await ensureDatabaseRepository(deps(), full as NonNullable<typeof full>);
    const snapshots = await withRepository(access, (session) => resticSnapshots(session));
    expect(snapshots.map((snapshot) => snapshot.id).sort()).toEqual(
      backups.map((backup) => backup.snapshotId).sort(),
    );
    // Each snapshot names its run: the server checks an agent's report against these tags.
    for (const snapshot of snapshots) {
      expect(snapshot.tags).toContain(`restow-db-run=${run.id}`);
      expect(snapshot.tags).toContain(`restow-db-connection=${connectionId}`);
      expect(snapshot.hostname).toBe("restow-db");
    }
    // A database row with its identity (name and OID).
    const [database] = await q<{ name: string; identity: string; instance_key: string }>(
      "SELECT name, identity, instance_key FROM databases WHERE connection_id = $1 AND name = $2",
      [connectionId, SOURCE],
    );
    expect(database).toMatchObject({ name: SOURCE });
    expect(database?.identity).toMatch(/^\d+$/);
    expect(database?.instance_key).toMatch(/^postgresql:\d+$/);
  }, 120_000);

  it("plans no backup for an agent on Windows (E7)", async () => {
    const [endpoint] = await q<{ id: string }>(
      `INSERT INTO endpoints (tenant_id, hostname, os, arch, profile, secret_hash, config)
       VALUES ($1, 'win-bridge', 'windows', 'amd64', 'server', 'x', '{}'::jsonb) RETURNING id`,
      [tenantId],
    );
    const [connection] = await q<{ id: string }>(
      `INSERT INTO database_connections
         (tenant_id, name, engine, host, port, executor_kind, executor_endpoint_id, auth_method,
          schedule, selection)
       VALUES ($1, 'Windows ERP', 'postgresql', 'db.example.test', 5432, 'agent', $2, 'password',
               '{"kind":"interval","intervalMinutes":60,"timeZone":"UTC"}'::jsonb,
               '{"mode":"all","names":[],"exclude":[]}'::jsonb)
       RETURNING id`,
      [tenantId, endpoint?.id],
    );
    try {
      await databaseRunsPass(deps());
      expect(
        await q("SELECT id FROM database_runs WHERE connection_id = $1", [connection?.id]),
      ).toEqual([]);
    } finally {
      await q("DELETE FROM database_connections WHERE id = $1", [connection?.id]);
      await q("DELETE FROM endpoints WHERE id = $1", [endpoint?.id]);
    }
  });

  it("drops a due run beside an active one, visibly", async () => {
    const connection = {
      id: connectionId,
      tenantId,
      executorKind: "server" as const,
      executorEndpointId: null,
    };
    const first = await insertDatabaseRun(db, connection, { kind: "backup" }, now);
    expect(first).not.toBeNull();
    expect(await insertDatabaseRun(db, connection, { kind: "backup" }, now)).toBeNull();
    expect((await runOf(first?.id as string))?.notes).toEqual([
      { code: "db_run_overlap", at: now.toISOString() },
    ]);
    await q("UPDATE database_runs SET status = 'failed' WHERE id = $1", [first?.id]);
  });

  it("restores under a new name on the same connection and onto another one [DB-008]", async () => {
    const [backup] = await db
      .select()
      .from(databaseBackups)
      .where(eq(databaseBackups.connectionId, connectionId));
    const dump = (
      await db.select().from(databaseBackups).where(eq(databaseBackups.connectionId, connectionId))
    ).find((row) => row.kind === "database");
    expect(backup).toBeDefined();
    const name = defaultRestoreName(SOURCE, now);
    expect(Buffer.byteLength(name)).toBeLessThanOrEqual(63);
    const same = await restore(connectionId, name, dump?.id as string);
    expect(same).toMatchObject({ status: "succeeded", targetName: name });
    expect(same.targetOid).toMatch(/^\d+$/);
    expect(await customerQuery(name, "SELECT item FROM orders ORDER BY id")).toEqual([
      ["tea"],
      ["cake"],
    ]);

    const elsewhere = `restow_d3_other_${suffix}`;
    const other = await restore(otherConnectionId, elsewhere, dump?.id as string);
    expect(other).toMatchObject({ status: "succeeded" });
    expect(await customerQuery(elsewhere, "SELECT count(*) FROM orders")).toEqual([["2"]]);
  }, 120_000);

  it("never restores over a database, needs CREATEDB, and drops only what it created [DB-008]", async () => {
    const dump = (
      await db.select().from(databaseBackups).where(eq(databaseBackups.connectionId, connectionId))
    ).find((row) => row.kind === "database");
    // The name exists: refused, the existing database is untouched.
    const taken = await restore(connectionId, SOURCE, dump?.id as string);
    expect(taken).toMatchObject({
      status: "failed",
      errorCode: "db_restore_name_taken",
      targetOid: null,
    });
    expect(await customerQuery(SOURCE, "SELECT count(*) FROM orders")).toEqual([["2"]]);

    // A target whose user may not create databases.
    const [secret] = await q<{ id: string }>(
      `INSERT INTO secrets (tenant_id, kind, ciphertext, key_version)
       VALUES ($1, 'database_credentials', 'x', 1) RETURNING id`,
      [tenantId],
    );
    credentials[secret?.id as string] = { user: NO_CREATE, password: NO_CREATE_PASSWORD };
    await q("UPDATE database_connections SET credential_secret_id = $1 WHERE id = $2", [
      secret?.id,
      otherConnectionId,
    ]);
    const refused = await restore(
      otherConnectionId,
      `restow_d3_nope_${suffix}`,
      dump?.id as string,
    );
    expect(refused).toMatchObject({ status: "failed", errorCode: "db_permission_missing" });

    // A backup whose content does not match its record: restored, then the run's own database
    // (and only it) is dropped, found by its name and OID even when the name holds \' and the
    // target's sessions read backslashes in literals as escapes.
    const [oldStrings] = await q<{ id: string }>(
      `INSERT INTO secrets (tenant_id, kind, ciphertext, key_version)
       VALUES ($1, 'database_credentials', 'x', 1) RETURNING id`,
      [tenantId],
    );
    credentials[oldStrings?.id as string] = { user: OLD_STRINGS, password: OLD_STRINGS_PASSWORD };
    await q("UPDATE database_connections SET credential_secret_id = $1 WHERE id = $2", [
      oldStrings?.id,
      otherConnectionId,
    ]);
    await q("UPDATE database_backups SET sha256 = repeat('0', 64) WHERE id = $1", [dump?.id]);
    const broken = `restow_d3_br\\'k_${suffix}`;
    const failed = await restore(otherConnectionId, broken, dump?.id as string);
    expect(failed).toMatchObject({ status: "failed", errorCode: "db_backup_mismatch" });
    expect(failed.targetOid).toMatch(/^\d+$/);
    expect(
      await customer.query(`SELECT 1 FROM pg_database WHERE datname = ${pgQuoteLiteral(broken)}`),
    ).toEqual([]);
    await q("UPDATE database_backups SET sha256 = $1 WHERE id = $2", [dump?.sha256, dump?.id]);
  }, 120_000);

  it("keeps no snapshot of a dump that breaks off [DB-006]", async () => {
    const [full] = await db
      .select()
      .from(databaseConnections)
      .where(eq(databaseConnections.id, connectionId));
    const access = await ensureDatabaseRepository(deps(), full as NonNullable<typeof full>);
    const count = async () =>
      (await withRepository(access, (session) => resticSnapshots(session))).length;
    const before = await count();
    // A dump program that writes part of an archive and fails.
    const broken = join(storageDir, "broken-pg_dump");
    await writeFile(broken, "#!/bin/sh\nprintf 'PGDMP partial archive'\nexit 1\n", { mode: 0o755 });
    const real = await choosePgTools(16);
    if (!real.ok) throw new Error(real.message);
    const tools = async () => ({
      ok: true as const,
      tools: {
        major: 99,
        dir: storageDir,
        path: (tool: "pg_dump" | "pg_dumpall" | "pg_restore") =>
          tool === "pg_restore" ? real.tools.path(tool) : broken,
      },
    });
    now = new Date(now.getTime() + 60 * 60 * 1000);
    const connection = {
      id: connectionId,
      tenantId,
      executorKind: "server" as const,
      executorEndpointId: null,
    };
    const run = await insertDatabaseRun(db, connection, { kind: "backup", trigger: "manual" }, now);
    await runDatabaseJob({ ...deps(), tools }, { tenantId, runId: run?.id as string });
    const failed = await runOf(run?.id as string);
    expect(failed).toMatchObject({ status: "failed", errorCode: "db_dump_failed" });
    expect(failed?.notes).toContainEqual(
      expect.objectContaining({ database: SOURCE, result: "failed", code: "db_dump_failed" }),
    );
    expect(await count()).toBe(before);
  }, 120_000);

  it("fails a run with wrong credentials and keeps the password out of its message [DB-002]", async () => {
    const before = (
      await db.select().from(databaseBackups).where(eq(databaseBackups.connectionId, connectionId))
    ).length;
    const row = await connectionRow(connectionId);
    const secretId = row?.credential_secret_id as string;
    const kept = credentials[secretId];
    credentials[secretId] = { user, password: `wrong-${suffix}` };
    now = new Date(now.getTime() + 2 * 60 * 60 * 1000);
    const connection = {
      id: connectionId,
      tenantId,
      executorKind: "server" as const,
      executorEndpointId: null,
    };
    const run = await insertDatabaseRun(db, connection, { kind: "backup", trigger: "manual" }, now);
    await runDatabaseJob(deps(), { tenantId, runId: run?.id as string });
    credentials[secretId] = kept as { user: string; password: string };
    const failed = await runOf(run?.id as string);
    expect(failed).toMatchObject({ status: "failed", errorCode: "db_login_failed" });
    expect(failed?.errorMessage).not.toContain(`wrong-${suffix}`);
    const after = (
      await db.select().from(databaseBackups).where(eq(databaseBackups.connectionId, connectionId))
    ).length;
    expect(after).toBe(before);
  }, 120_000);

  it("forgets what the retention no longer keeps, per database, and only what runs reported [DB-007]", async () => {
    const connection = {
      id: connectionId,
      tenantId,
      executorKind: "server" as const,
      executorEndpointId: null,
    };
    for (let index = 0; index < 2; index++) {
      now = new Date(now.getTime() + 60 * 1000);
      const run = await insertDatabaseRun(
        db,
        connection,
        { kind: "backup", trigger: "manual" },
        now,
      );
      await runDatabaseJob(deps(), { tenantId, runId: run?.id as string });
      expect((await runOf(run?.id as string))?.status).toBe("succeeded");
    }
    const [full] = await db
      .select()
      .from(databaseConnections)
      .where(eq(databaseConnections.id, connectionId));
    const access = await ensureDatabaseRepository(deps(), full as NonNullable<typeof full>);
    const listedBefore = await withRepository(access, (session) => resticSnapshots(session));
    const before = listedBefore.length;
    // Rows no run of the server wrote and the server never found in the repository, each older
    // than a genuine backup of the same day (so the policy drops them): one under a prefix of a
    // genuine snapshot (restic would forget every snapshot starting with it) and one under an id
    // nobody wrote. Retention forgets neither.
    const genuine = listedBefore[0]?.id as string;
    const [sample] = await db
      .select()
      .from(databaseBackups)
      .where(eq(databaseBackups.connectionId, connectionId))
      .limit(1);
    for (const snapshotId of [genuine.slice(0, 8), "0".repeat(64)]) {
      await db.insert(databaseBackups).values({
        ...(sample as NonNullable<typeof sample>),
        id: undefined,
        snapshotId,
        startedAt: new Date(Number(sample?.finishedAt.getTime()) - 2000),
        finishedAt: new Date(Number(sample?.finishedAt.getTime()) - 1000),
      } as never);
    }
    const active = await db
      .select()
      .from(databaseBackups)
      .where(eq(databaseBackups.connectionId, connectionId));
    // Write-once storage and restore mode hold it: nothing is forgotten.
    writeOnce = true;
    expect(await databaseRetention(deps(), full as NonNullable<typeof full>)).toEqual({
      forgotten: 0,
    });
    writeOnce = false;
    const passes: string[] = [];
    const refuse = installDeletionEnforcement({
      decide: async (request) => {
        passes.push(request.pass);
        return { allowed: false, reason: "restore_mode", restoreModeId: null };
      },
      holding: () => true,
    });
    try {
      expect(await databaseRetention(deps(), full as NonNullable<typeof full>)).toEqual({
        forgotten: 0,
      });
    } finally {
      refuse();
    }
    expect(passes).toEqual(["database_retention"]);
    expect((await withRepository(access, (session) => resticSnapshots(session))).length).toBe(
      before,
    );
    // Strict: every delete of restic's prune must carry the permit of the pass.
    const allow = installDeletionEnforcement(
      {
        decide: async () => ({ allowed: true, keepUnknownBefore: null, inRestoreMode: false }),
        holding: () => false,
      },
      { strict: true },
    );
    let outcome: { forgotten: number };
    try {
      outcome = await databaseRetention(deps(), full as NonNullable<typeof full>);
    } finally {
      allow();
    }
    // The policy of the machines per group (the database and the globals): some of today's go,
    // the newest of each group stays.
    const after = await db
      .select()
      .from(databaseBackups)
      .where(eq(databaseBackups.connectionId, connectionId));
    const real = (row: { snapshotId: string }) =>
      row.snapshotId !== "0".repeat(64) && /^[0-9a-f]{64}$/.test(row.snapshotId);
    const kept = after.filter((row) => row.status === "active" && real(row));
    const wasActive = active.filter((row) => row.status === "active" && real(row));
    expect(outcome.forgotten).toBeGreaterThan(0);
    expect(outcome.forgotten).toBe(wasActive.length - kept.length);
    // The prefix row is left alone (no forget by a prefix ever runs); the unknown id is marked
    // gone without a forget.
    expect(after.find((row) => row.snapshotId === genuine.slice(0, 8))?.status).toBe("active");
    expect(after.find((row) => row.snapshotId === "0".repeat(64))?.status).toBe("pruned");
    for (const kind of ["database", "globals"] as const) {
      const newest = wasActive
        .filter((row) => row.kind === kind)
        .sort((x, y) => y.finishedAt.getTime() - x.finishedAt.getTime())[0];
      expect(kept.map((row) => row.id)).toContain(newest?.id);
    }
    expect(after.filter((row) => row.status === "pruned").every((row) => row.prunedAt)).toBe(true);
    const snapshots = await withRepository(access, (session) => resticSnapshots(session));
    expect(snapshots.length).toBe(before - outcome.forgotten);
    expect(snapshots.map((snapshot) => snapshot.id).sort()).toEqual(
      expect.arrayContaining(kept.map((row) => row.snapshotId)),
    );

    // The pass notes when it checked a connection and leaves it a day.
    // (Switched off: the pass plans no backup, whose queued run would hold the retention back.)
    await q("UPDATE database_connections SET retention_checked_at = NULL, enabled = false");
    await databaseRunsPass(deps());
    const checked = await connectionRow(connectionId);
    expect(checked?.retention_checked_at).toBeTruthy();
    const first = new Date(checked?.retention_checked_at as string).getTime();
    now = new Date(now.getTime() + 60 * 60 * 1000);
    await databaseRunsPass(deps());
    expect(
      new Date((await connectionRow(connectionId))?.retention_checked_at as string).getTime(),
    ).toBe(first);
  }, 240_000);
});
