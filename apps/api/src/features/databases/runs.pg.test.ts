/**
 * Backup and restore runs through the API, stage D3, against Postgres (docs/DATABASES.md 4.3,
 * 4.4, 7.1, 16 "D3"): "Jetzt sichern" plans one run at a time; an agent fetches its run once
 * with the credentials and, for a backup, a token for the connection's repository (append-only),
 * and reports what it wrote; the server records only backups it finds in the repository as this
 * run's, under their full ids, dated by itself; another instance records nothing; a run of an
 * executor the connection left is failed, never handed out; a restore is checked before it is
 * planned and reads its one dump from the server; the download streams the dump from the
 * repository, the globals only for administrators, and the guide holds no secret.
 *
 * Needs RESTOW_TEST_DATABASE_URL (a superuser) and restic on PATH; skipped otherwise.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  type RepositoryAccess,
  resticBinary,
  resticCacheBase,
  runRestic,
  withRepository,
} from "@restow/core";
import {
  auditLog,
  databaseBackups,
  databaseConnections,
  databaseRuns,
  databases,
  endpoints,
  endpointTasks,
  settings,
} from "@restow/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  type EndpointFixture,
  startFixture,
  testDatabaseAdminUrl,
} from "../endpoints/testing/fixture.js";
import type { DatabaseContext } from "./service.js";

const DATABASE = "restow_api_database_runs_test";
const PASSWORD = "Runs-s3cret!42";
const USER = "restow_backup";
const FINGERPRINT = Array.from({ length: 32 }, (_, i) => (i + 32).toString(16).toUpperCase()).join(
  ":",
);

type Runs = typeof import("./runs.js");
type Service = typeof import("./service.js");
type Secrets = typeof import("../../lib/secrets.js");
type Repository = typeof import("../endpoints/repository.js");
type Shared = typeof import("../../db.js");

describe.skipIf(!testDatabaseAdminUrl)("database runs through the API against Postgres", () => {
  let fixture: EndpointFixture;
  let runs: Runs;
  let service: Service;
  let secretStore: Secrets;
  let repository: Repository;
  let shared: Shared;
  let agentId: string;
  let connectionId: string;
  let databaseId: string;

  const ctx = (): DatabaseContext => ({
    actor: { label: "admin@contoso.example", userId: fixture.adminId, ip: "192.0.2.1" },
    isProviderAdmin: false,
  });
  const agent = () => ({ endpointId: agentId, tenantId: fixture.tenantId });

  /** The connection's repository as the server opens it. */
  const repositoryOf = async (): Promise<RepositoryAccess> => {
    const [connection] = await fixture.db
      .select()
      .from(databaseConnections)
      .where(eq(databaseConnections.id, connectionId));
    const password = await secretStore.readSecret(shared.db, {
      id: connection?.repositorySecretId as string,
      tenantId: fixture.tenantId,
    });
    const { storage } = await repository.tenantStorage(shared.db, fixture.tenantId);
    return {
      storage,
      prefix: `db/${connectionId}/`,
      repositoryPassword: password as string,
      repositoryKey: `db-${connectionId}`,
      binary: resticBinary(),
      cacheBase: resticCacheBase(),
    };
  };

  /** A snapshot the way an agent writes it (restic on stdin), with its full id. */
  const writeSnapshot = async (input: {
    fileName: string;
    content: Buffer;
    tags: string[];
    host?: string;
  }): Promise<string> => {
    const access = await repositoryOf();
    const result = await withRepository(access, (session) =>
      runRestic(session, [
        "backup",
        "--json",
        "--host",
        input.host ?? "restow-db",
        "--stdin-from-command",
        "--stdin-filename",
        input.fileName,
        ...input.tags.flatMap((tag) => ["--tag", tag]),
        "--",
        "printf",
        input.content.toString("utf8"),
      ]),
    );
    return result.stdout
      .split("\n")
      .map((line) => {
        try {
          return JSON.parse(line) as { message_type?: string; snapshot_id?: string };
        } catch {
          return null;
        }
      })
      .find((message) => message?.message_type === "summary")?.snapshot_id as string;
  };

  const runTags = (runId: string) => [
    "restow-db",
    "restow-db-engine=postgresql",
    `restow-db-connection=${connectionId}`,
    `restow-db-run=${runId}`,
  ];

  const instance = {
    systemIdentifier: "7300000000000000042",
    serverVersion: "16.4",
    databases: [
      { name: "app", oid: "16384" },
      { name: "shop", oid: "16390" },
    ],
  };

  const reported = (input: {
    snapshotId: string;
    name?: string;
    kind?: "database" | "globals";
    startedAt?: string;
    finishedAt?: string;
  }) => {
    const kind = input.kind ?? "database";
    const name = kind === "globals" ? "" : (input.name ?? "app");
    return {
      kind,
      name,
      oid: kind === "globals" ? null : "16384",
      snapshotId: input.snapshotId,
      fileName: kind === "globals" ? "postgresql/globals.sql" : `postgresql/${name}.pgdump`,
      sha256: "b".repeat(64),
      bytes: 4096,
      objects: { TABLE: 2 },
      startedAt: input.startedAt ?? new Date().toISOString(),
      finishedAt: input.finishedAt ?? new Date().toISOString(),
      toolVersion: "16",
    };
  };

  const runOf = async (id: string) =>
    (await fixture.db.select().from(databaseRuns).where(eq(databaseRuns.id, id)))[0];

  beforeAll(async () => {
    fixture = await startFixture(DATABASE);
    shared = await import("../../db.js");
    runs = await import("./runs.js");
    service = await import("./service.js");
    secretStore = await import("../../lib/secrets.js");
    repository = await import("../endpoints/repository.js");
    await fixture.db.insert(settings).values({}).onConflictDoNothing();
    const [endpoint] = await fixture.db
      .insert(endpoints)
      .values({
        tenantId: fixture.tenantId,
        hostname: "db-bridge",
        os: "linux",
        arch: "amd64",
        profile: "server",
        secretHash: "x",
        config: {} as never,
        lastSeenAt: new Date(),
        settings: { agent: { capabilities: ["db_runner_v1"] } },
      })
      .returning();
    agentId = endpoint?.id as string;
    const secret = await secretStore.storeSecret(shared.db, {
      tenantId: fixture.tenantId,
      kind: "database_credentials",
      plaintext: JSON.stringify({ user: USER, password: PASSWORD }),
    });
    const [connection] = await fixture.db
      .insert(databaseConnections)
      .values({
        tenantId: fixture.tenantId,
        name: "ERP",
        engine: "postgresql",
        host: "10.0.0.5",
        port: 5432,
        executorKind: "agent",
        executorEndpointId: agentId,
        authMethod: "password",
        credentialSecretId: secret.id,
        tlsFingerprint: FINGERPRINT,
        instanceKey: "postgresql:7300000000000000042",
        schedule: { kind: "interval", intervalMinutes: 60, timeZone: "UTC" },
      })
      .returning();
    connectionId = connection?.id as string;
    const [database] = await fixture.db
      .insert(databases)
      .values({
        tenantId: fixture.tenantId,
        connectionId,
        name: "app",
        identity: "16384",
        instanceKey: "postgresql:7300000000000000042",
      })
      .returning();
    databaseId = database?.id as string;
  }, 120_000);

  afterAll(async () => {
    await fixture?.cleanup();
  });

  beforeEach(async () => {
    await fixture.db.delete(databaseRuns);
    await fixture.db.delete(endpointTasks);
  });

  it("plans one manual backup at a time and hands the agent its run once [DB-002]", async () => {
    const run = await runs.requestBackup(shared.db, fixture.tenantId, databaseId, ctx());
    expect(run).toMatchObject({
      kind: "backup",
      trigger: "manual",
      status: "queued",
      executor: "agent",
    });
    await expect(
      runs.requestBackup(shared.db, fixture.tenantId, databaseId, ctx()),
    ).rejects.toMatchObject({ status: 409, type: runs.RUN_PROBLEMS.active });
    const [task] = await fixture.db.select().from(endpointTasks);
    expect(task).toMatchObject({ kind: "db_backup", params: { runId: run.id } });

    // Another agent gets nothing; the right one gets the credentials once.
    await expect(
      runs.agentFetchRun(
        shared.db,
        { ...agent(), endpointId: fixture.tenantId },
        run.id,
        "https://restow.example.test",
      ),
    ).rejects.toMatchObject({ status: 404 });
    const spec = await runs.agentFetchRun(
      shared.db,
      agent(),
      run.id,
      "https://restow.example.test/",
    );
    expect(spec).toMatchObject({
      runId: run.id,
      kind: "backup",
      connection: {
        connectionId,
        host: "10.0.0.5",
        user: USER,
        password: PASSWORD,
        pinnedFingerprintSha256: FINGERPRINT,
      },
      repository: {
        url: `rest:https://restow.example.test/agent/db/restic/${connectionId}/`,
        username: run.id,
      },
      restore: null,
    });
    expect(spec.repository?.repositoryPassword.length).toBeGreaterThan(20);
    await expect(
      runs.agentFetchRun(shared.db, agent(), run.id, "https://restow.example.test"),
    ).rejects.toMatchObject({ status: 404 });
    const [stored] = await fixture.db
      .select()
      .from(databaseRuns)
      .where(eq(databaseRuns.id, run.id));
    expect(stored?.status).toBe("running");
    expect(JSON.stringify(stored)).not.toContain(spec.repository?.password as string);
    expect(JSON.stringify(stored)).not.toContain(PASSWORD);

    // The run's token opens the connection's repository, append-only, and nothing else.
    const allowed = await runs.resolveDatabaseRunCredential(
      { runId: run.id, token: spec.repository?.password as string },
      connectionId,
    );
    expect(allowed).toMatchObject({
      ok: true,
      access: { principal: "agent", prefix: `db/${connectionId}/` },
    });
    expect(
      await runs.resolveDatabaseRunCredential({ runId: run.id, token: "wrong" }, connectionId),
    ).toEqual({ ok: false, reason: "invalid" });
    expect(
      await runs.resolveDatabaseRunCredential(
        { runId: run.id, token: spec.repository?.password as string },
        databaseId,
      ),
    ).toEqual({ ok: false, reason: "invalid" });

    // The report: databases and backups recorded, the message cleaned, the times the server's.
    const genuine = await writeSnapshot({
      fileName: "postgresql/app.pgdump",
      content: Buffer.from("PGDMP app"),
      tags: runTags(run.id),
    });
    expect(genuine).toMatch(/^[0-9a-f]{64}$/);
    await runs.agentFinishRun(shared.db, agent(), run.id, {
      status: "partial",
      error: { code: "db_dump_failed", message: `pg_dump: password ${PASSWORD} rejected` },
      instance,
      backups: [
        // Dated far in the future and long before the run: the server clamps both.
        reported({
          snapshotId: genuine,
          startedAt: "2000-01-01T00:00:00Z",
          finishedAt: "2099-01-01T00:00:00Z",
        }),
      ],
      notes: [{ database: "shop", result: "failed", message: `for user ${USER}` }],
      targetOid: null,
    });
    const done = await runOf(run.id);
    expect(done).toMatchObject({ status: "partial", errorCode: "db_dump_failed" });
    expect(JSON.stringify(done)).not.toContain(PASSWORD);
    expect(JSON.stringify(done)).not.toContain(USER);
    const backups = await runs.listBackups(shared.db, fixture.tenantId, databaseId);
    expect(backups.backups).toMatchObject([{ snapshotId: genuine, bytes: 4096 }]);
    const recordedAt = new Date(backups.backups[0]?.finishedAt as string);
    expect(recordedAt.getTime()).toBeLessThanOrEqual(Date.now());
    expect(recordedAt.getTime()).toBeGreaterThanOrEqual(Number(done?.startedAt?.getTime()));
    expect(new Date(backups.backups[0]?.startedAt as string).getTime()).toBeGreaterThanOrEqual(
      Number(done?.startedAt?.getTime()),
    );
    const shop = await fixture.db.select().from(databases).where(eq(databases.name, "shop"));
    expect(shop).toHaveLength(1);
    // The database now rates "unverified" (D6 brings the checks).
    expect((await service.getDatabase(shared.db, fixture.tenantId, databaseId)).rating).toBe(
      "unverified",
    );
  });

  it("records nothing when another instance answered [DB-002]", async () => {
    const run = await runs.requestBackup(shared.db, fixture.tenantId, databaseId, ctx());
    await runs.agentFetchRun(shared.db, agent(), run.id, "https://restow.example.test");
    await runs.agentFinishRun(shared.db, agent(), run.id, {
      status: "succeeded",
      error: null,
      instance: { systemIdentifier: "7999999999999999999", serverVersion: "16.4", databases: [] },
      backups: [reported({ snapshotId: "c".repeat(64) })],
      notes: [],
      targetOid: null,
    });
    const [done] = await fixture.db.select().from(databaseRuns).where(eq(databaseRuns.id, run.id));
    expect(done).toMatchObject({ status: "failed", errorCode: "db_instance_changed" });
    const recorded = await fixture.db
      .select()
      .from(databaseBackups)
      .where(eq(databaseBackups.snapshotId, "c".repeat(64)));
    expect(recorded).toEqual([]);
  });

  it("records only backups it finds in the repository as this run's [DB-007]", async () => {
    const run = await runs.requestBackup(shared.db, fixture.tenantId, databaseId, ctx());
    await runs.agentFetchRun(shared.db, agent(), run.id, "https://restow.example.test");
    const app = await writeSnapshot({
      fileName: "postgresql/app.pgdump",
      content: Buffer.from("PGDMP app 2"),
      tags: runTags(run.id),
    });
    // A snapshot of another run, one of another host, a globals one tagged as a database and
    // an id nobody wrote: none of them is this run's backup.
    const other = await writeSnapshot({
      fileName: "postgresql/shop.pgdump",
      content: Buffer.from("PGDMP shop"),
      tags: runTags("00000000-0000-4000-8000-000000000001"),
    });
    const foreignHost = await writeSnapshot({
      fileName: "postgresql/globals.sql",
      content: Buffer.from("CREATE ROLE x;"),
      tags: [...runTags(run.id), "restow-db-globals"],
      host: "elsewhere",
    });
    await runs.agentFinishRun(shared.db, agent(), run.id, {
      status: "succeeded",
      error: null,
      instance,
      backups: [
        reported({ snapshotId: app }),
        reported({ snapshotId: other, name: "shop" }),
        reported({ snapshotId: foreignHost, kind: "globals" }),
      ],
      notes: [],
      targetOid: null,
    });
    expect(await runOf(run.id)).toMatchObject({
      status: "partial",
      errorCode: "db_snapshot_failed",
    });
    const recorded = await fixture.db
      .select()
      .from(databaseBackups)
      .where(eq(databaseBackups.runId, run.id));
    expect(recorded.map((row) => row.snapshotId)).toEqual([app]);

    // Nothing of a run whose every backup is made up.
    const fake = await runs.requestBackup(shared.db, fixture.tenantId, databaseId, ctx());
    await runs.agentFetchRun(shared.db, agent(), fake.id, "https://restow.example.test");
    await runs.agentFinishRun(shared.db, agent(), fake.id, {
      status: "succeeded",
      error: null,
      instance,
      backups: [reported({ snapshotId: "e".repeat(64) })],
      notes: [],
      targetOid: null,
    });
    expect(await runOf(fake.id)).toMatchObject({
      status: "failed",
      errorCode: "db_snapshot_failed",
    });
  });

  it("refuses a snapshot id prefix and a second backup of one database [DB-007]", async () => {
    const run = await runs.requestBackup(shared.db, fixture.tenantId, databaseId, ctx());
    await runs.agentFetchRun(shared.db, agent(), run.id, "https://restow.example.test");
    const genuine = await writeSnapshot({
      fileName: "postgresql/app.pgdump",
      content: Buffer.from("PGDMP app 3"),
      tags: runTags(run.id),
    });
    // restic would forget every snapshot starting with a prefix: only full ids are taken.
    await runs.agentFinishRun(shared.db, agent(), run.id, {
      status: "succeeded",
      error: null,
      instance,
      backups: [reported({ snapshotId: genuine.slice(0, 8) })],
      notes: [],
      targetOid: null,
    });
    expect(await runOf(run.id)).toMatchObject({ status: "failed", errorCode: "db_probe_failed" });
    const twice = await runs.requestBackup(shared.db, fixture.tenantId, databaseId, ctx());
    await runs.agentFetchRun(shared.db, agent(), twice.id, "https://restow.example.test");
    const second = await writeSnapshot({
      fileName: "postgresql/app.pgdump",
      content: Buffer.from("PGDMP app 4"),
      tags: runTags(twice.id),
    });
    await runs.agentFinishRun(shared.db, agent(), twice.id, {
      status: "succeeded",
      error: null,
      instance,
      backups: [reported({ snapshotId: second }), reported({ snapshotId: genuine })],
      notes: [],
      targetOid: null,
    });
    expect(await runOf(twice.id)).toMatchObject({ status: "failed", errorCode: "db_probe_failed" });
    const recorded = await fixture.db
      .select()
      .from(databaseBackups)
      .where(eq(databaseBackups.runId, twice.id));
    expect(recorded).toEqual([]);
  });

  it("never hands a run to an agent the connection left, nor while it is off [DB-002]", async () => {
    const [other] = await fixture.db
      .insert(endpoints)
      .values({
        tenantId: fixture.tenantId,
        hostname: "db-bridge-2",
        os: "linux",
        arch: "amd64",
        profile: "server",
        secretHash: "y",
        config: {} as never,
        lastSeenAt: new Date(),
        settings: { agent: { capabilities: ["db_runner_v1"] } },
      })
      .returning();
    const otherId = other?.id as string;
    try {
      // Moved through the API: the queued run fails at once.
      const queued = await runs.requestBackup(shared.db, fixture.tenantId, databaseId, ctx());
      await service.updateConnection(
        shared.db,
        fixture.tenantId,
        connectionId,
        { executor: { kind: "agent", endpointId: otherId }, password: PASSWORD },
        ctx(),
      );
      expect(await runOf(queued.id)).toMatchObject({
        status: "failed",
        errorCode: "db_run_failed",
      });
      await expect(
        runs.agentFetchRun(shared.db, agent(), queued.id, "https://restow.example.test"),
      ).rejects.toMatchObject({ status: 404 });
      // A running run of the old agent ends as well; its repository token no longer opens.
      await fixture.db
        .update(databaseConnections)
        .set({ executorEndpointId: agentId })
        .where(eq(databaseConnections.id, connectionId));
      const running = await runs.requestBackup(shared.db, fixture.tenantId, databaseId, ctx());
      const spec = await runs.agentFetchRun(
        shared.db,
        agent(),
        running.id,
        "https://restow.example.test",
      );
      await service.updateConnection(
        shared.db,
        fixture.tenantId,
        connectionId,
        { executor: { kind: "agent", endpointId: otherId }, password: PASSWORD },
        ctx(),
      );
      expect(await runOf(running.id)).toMatchObject({ status: "failed" });
      expect(
        await runs.resolveDatabaseRunCredential(
          { runId: running.id, token: spec.repository?.password as string },
          connectionId,
        ),
      ).toEqual({ ok: false, reason: "invalid" });
      // Changed behind the API's back (or switched off): the fetch checks it again.
      await fixture.db
        .update(databaseConnections)
        .set({ executorEndpointId: agentId })
        .where(eq(databaseConnections.id, connectionId));
      const late = await runs.requestBackup(shared.db, fixture.tenantId, databaseId, ctx());
      await fixture.db
        .update(databaseConnections)
        .set({ executorEndpointId: otherId })
        .where(eq(databaseConnections.id, connectionId));
      await expect(
        runs.agentFetchRun(shared.db, agent(), late.id, "https://restow.example.test"),
      ).rejects.toMatchObject({ status: 404 });
      expect(await runOf(late.id)).toMatchObject({ status: "failed", errorCode: "db_run_failed" });
      await fixture.db
        .update(databaseConnections)
        .set({ executorEndpointId: agentId, enabled: false })
        .where(eq(databaseConnections.id, connectionId));
      const off = await runs.requestBackup(shared.db, fixture.tenantId, databaseId, ctx());
      await expect(
        runs.agentFetchRun(shared.db, agent(), off.id, "https://restow.example.test"),
      ).rejects.toMatchObject({ status: 404 });
      expect(await runOf(off.id)).toMatchObject({ status: "failed" });
    } finally {
      await fixture.db
        .update(databaseConnections)
        .set({ executorEndpointId: agentId, enabled: true })
        .where(eq(databaseConnections.id, connectionId));
    }
  });

  it("checks a restore before planning it and hands the agent only its one dump [DB-008]", async () => {
    const [backup] = await fixture.db
      .select()
      .from(databaseBackups)
      .where(eq(databaseBackups.databaseId, databaseId))
      .limit(1);
    const too = "x".repeat(64);
    await expect(
      runs.requestRestore(
        shared.db,
        fixture.tenantId,
        databaseId,
        { backupId: backup?.id as string, name: too },
        ctx(),
      ),
    ).rejects.toMatchObject({ status: 422, type: runs.RUN_PROBLEMS.restoreName });
    await expect(
      runs.requestRestore(
        shared.db,
        fixture.tenantId,
        databaseId,
        { backupId: backup?.id as string, name: "bad\nname" },
        ctx(),
      ),
    ).rejects.toMatchObject({ status: 422, type: runs.RUN_PROBLEMS.restoreName });
    await expect(
      runs.requestRestore(shared.db, fixture.tenantId, databaseId, { backupId: databaseId }, ctx()),
    ).rejects.toMatchObject({ status: 422, type: runs.RUN_PROBLEMS.backupGone });
    const run = await runs.requestRestore(
      shared.db,
      fixture.tenantId,
      databaseId,
      { backupId: backup?.id as string },
      ctx(),
    );
    expect(run.targetName).toMatch(/^app_restored_\d{8}_\d{6}$/);
    expect(run.targetConnectionId).toBe(connectionId);
    const [task] = await fixture.db.select().from(endpointTasks);
    expect(task?.kind).toBe("db_restore");
    const spec = await runs.agentFetchRun(
      shared.db,
      agent(),
      run.id,
      "https://restow.example.test",
    );
    // No repository and no snapshot id: the agent reads the one dump from the server.
    expect(spec.repository).toBeNull();
    expect(spec.restore).toEqual({
      fileName: backup?.fileName,
      sha256: backup?.sha256,
      targetName: run.targetName,
      engineOptions: {},
    });
    const stored = await runOf(run.id);
    expect(stored?.tokenHash).toBeNull();
    await expect(
      runs.agentRunDump(shared.db, { ...agent(), endpointId: fixture.tenantId }, run.id),
    ).rejects.toMatchObject({ status: 404 });
    const dump = await runs.agentRunDump(shared.db, agent(), run.id);
    const chunks: Buffer[] = [];
    for await (const chunk of dump.stream) {
      chunks.push(chunk as Buffer);
    }
    await dump.done;
    expect(Buffer.concat(chunks).toString("utf8")).toMatch(/^PGDMP app/);
  });

  it("streams a backup from the repository and guides a restore without a secret", async () => {
    // A real snapshot in the connection's repository (created by the first test's fetch).
    const content = Buffer.from("PGDMP fake archive for the download test");
    const snapshotId = await writeSnapshot({
      fileName: "postgresql/app.pgdump",
      content,
      tags: ["restow-db"],
    });
    const [row] = await fixture.db
      .insert(databaseBackups)
      .values({
        tenantId: fixture.tenantId,
        connectionId,
        databaseId,
        kind: "database",
        databaseName: "app",
        snapshotId,
        fileName: "postgresql/app.pgdump",
        sha256: createHash("sha256").update(content).digest("hex"),
        bytes: content.length,
        startedAt: new Date(),
        finishedAt: new Date(),
        serverVersion: "16.4",
        toolVersion: "16",
      })
      .returning();
    const file = await runs.downloadBackup(
      shared.db,
      fixture.tenantId,
      databaseId,
      row?.id as string,
      ctx(),
    );
    const chunks: Buffer[] = [];
    for await (const chunk of file.stream) {
      chunks.push(chunk as Buffer);
    }
    await file.done;
    expect(Buffer.concat(chunks).equals(content)).toBe(true);
    expect(file.fileName).toBe("app.pgdump");

    const guide = await runs.restoreGuide(
      shared.db,
      fixture.tenantId,
      databaseId,
      row?.id as string,
    );
    expect(guide).toContain("pg_restore --exit-on-error --no-owner --no-privileges");
    expect(guide).toContain("createdb --template=template0");
    expect(guide).toContain("sha256sum 'app.pgdump'");
    expect(guide).not.toContain(PASSWORD);
    expect(guide).not.toContain(USER);

    // The globals are not served by the database's download, only to administrators.
    const roles = Buffer.from("CREATE ROLE app PASSWORD 'SCRAM-SHA-256$4096:hash';");
    const globalsSnapshot = await writeSnapshot({
      fileName: "postgresql/globals.sql",
      content: roles,
      tags: ["restow-db", "restow-db-globals"],
    });
    const [globals] = await fixture.db
      .insert(databaseBackups)
      .values({
        tenantId: fixture.tenantId,
        connectionId,
        databaseId: null,
        kind: "globals",
        databaseName: "",
        snapshotId: globalsSnapshot,
        fileName: "postgresql/globals.sql",
        sha256: createHash("sha256").update(roles).digest("hex"),
        bytes: roles.length,
        startedAt: new Date(),
        finishedAt: new Date(),
      })
      .returning();
    await expect(
      runs.downloadBackup(shared.db, fixture.tenantId, databaseId, globals?.id as string, ctx()),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      runs.restoreGuide(shared.db, fixture.tenantId, databaseId, globals?.id as string),
    ).rejects.toMatchObject({ status: 404 });
    expect(
      (await runs.listGlobals(shared.db, fixture.tenantId, connectionId)).backups.map((b) => b.id),
    ).toContain(globals?.id);
    const sql = await runs.downloadGlobals(
      shared.db,
      fixture.tenantId,
      connectionId,
      globals?.id as string,
      ctx(),
    );
    const parts: Buffer[] = [];
    for await (const chunk of sql.stream) {
      parts.push(chunk as Buffer);
    }
    await sql.done;
    expect(Buffer.concat(parts).equals(roles)).toBe(true);
    expect(sql.fileName).toBe("globals.sql");
    const audited = await fixture.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, runs.DB_RUN_AUDIT.globalsDownloaded));
    expect(audited).toHaveLength(1);
  });

  it("quotes the file and the names in the guide, whatever the database is called", async () => {
    const evil = "x'; rm -rf ~ #$(id)";
    const [database] = await fixture.db
      .insert(databases)
      .values({
        tenantId: fixture.tenantId,
        connectionId,
        name: evil,
        identity: "16999",
        instanceKey: "postgresql:7300000000000000042",
      })
      .returning();
    const [row] = await fixture.db
      .insert(databaseBackups)
      .values({
        tenantId: fixture.tenantId,
        connectionId,
        databaseId: database?.id as string,
        kind: "database",
        databaseName: evil,
        snapshotId: "f".repeat(64),
        fileName: runs.dumpFileNameOf("database", evil),
        sha256: "0".repeat(64),
        bytes: 1,
        startedAt: new Date(),
        finishedAt: new Date("2026-11-18T12:00:00Z"),
      })
      .returning();
    const guide = await runs.restoreGuide(
      shared.db,
      fixture.tenantId,
      database?.id as string,
      row?.id as string,
    );
    const file = runs.downloadFileNameOf(row?.fileName as string);
    expect(file).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(guide).toContain(`sha256sum '${file}'`);
    expect(guide).toContain(
      `--dbname='x'\\''; rm -rf ~ #$(id)_restored_20261118_120000' '${file}'`,
    );
    // The shell reads each command's words back exactly: nothing of the name runs.
    const createdb = guide.split("\n").find((line) => line.includes("createdb ")) as string;
    const words = execFileSync("bash", [
      "-c",
      createdb.trim().replace(/^createdb /, "printf '%s\\n' "),
    ]).toString("utf8");
    expect(words).toBe(`--template=template0\n${evil}_restored_20261118_120000\n`);
  });

  it("runs no backup through an agent on Windows yet, and says so [DB-002]", async () => {
    const [windows] = await fixture.db
      .insert(endpoints)
      .values({
        tenantId: fixture.tenantId,
        hostname: "db-bridge-win",
        os: "windows",
        arch: "amd64",
        profile: "server",
        secretHash: "w",
        config: {} as never,
        lastSeenAt: new Date(),
        settings: { agent: { capabilities: ["db_runner_v1"] } },
      })
      .returning();
    try {
      await fixture.db
        .update(databaseConnections)
        .set({ executorEndpointId: windows?.id as string })
        .where(eq(databaseConnections.id, connectionId));
      await expect(
        runs.requestBackup(shared.db, fixture.tenantId, databaseId, ctx()),
      ).rejects.toMatchObject({ status: 422, type: runs.RUN_PROBLEMS.platform });
      const [backup] = await fixture.db
        .select()
        .from(databaseBackups)
        .where(eq(databaseBackups.databaseId, databaseId))
        .limit(1);
      await expect(
        runs.requestRestore(
          shared.db,
          fixture.tenantId,
          databaseId,
          { backupId: backup?.id as string },
          ctx(),
        ),
      ).rejects.toMatchObject({ status: 422, type: runs.RUN_PROBLEMS.platform });
      expect(await fixture.db.select().from(databaseRuns)).toEqual([]);
      const detail = await service.getDatabase(shared.db, fixture.tenantId, databaseId);
      expect(detail.connection.notices).toContain("db_platform_unsupported");
    } finally {
      await fixture.db
        .update(databaseConnections)
        .set({ executorEndpointId: agentId })
        .where(eq(databaseConnections.id, connectionId));
    }
  });

  it("records a MySQL agent's backups by the instance's server_uuid and guides its restore [DB-007]", async () => {
    const [connection] = await fixture.db
      .insert(databaseConnections)
      .values({
        tenantId: fixture.tenantId,
        name: "Shop",
        engine: "mysql",
        host: "10.0.0.6",
        port: 3306,
        executorKind: "agent",
        executorEndpointId: agentId,
        authMethod: "password",
        instanceKey: "mysql:3e11fa47-71ca-11e1-9e33-c80aa9429562",
        schedule: { kind: "interval", intervalMinutes: 60, timeZone: "UTC" },
      })
      .returning();
    const mysqlId = connection?.id as string;
    const [shop] = await fixture.db
      .insert(databases)
      .values({
        tenantId: fixture.tenantId,
        connectionId: mysqlId,
        name: "shop",
        instanceKey: "mysql:3e11fa47-71ca-11e1-9e33-c80aa9429562",
      })
      .returning();
    const run = await runs.requestBackup(shared.db, fixture.tenantId, shop?.id as string, ctx());
    const spec = await runs.agentFetchRun(
      shared.db,
      agent(),
      run.id,
      "https://restow.example.test",
    );
    expect(spec.connection.engine).toBe("mysql");
    // The snapshot the agent wrote, in the MySQL connection's own repository.
    const savedConnection = connectionId;
    connectionId = mysqlId;
    let snapshot: string;
    try {
      snapshot = await writeSnapshot({
        fileName: "mysql/shop.sql",
        content: Buffer.from("-- MySQL dump\nCREATE TABLE `t` (`id` int);\n"),
        tags: runTags(run.id),
      });
    } finally {
      connectionId = savedConnection;
    }
    await runs.agentFinishRun(shared.db, agent(), run.id, {
      status: "succeeded",
      error: null,
      instance: {
        serverUuid: "3E11FA47-71CA-11E1-9E33-C80AA9429562",
        serverVersion: "8.4.3",
        databases: [{ name: "shop", oid: null }],
      },
      backups: [
        {
          ...reported({ snapshotId: snapshot, name: "shop" }),
          oid: null,
          fileName: "mysql/shop.sql",
          engineOptions: { characterSet: "utf8mb4", collation: "utf8mb4_0900_ai_ci" },
        },
      ],
      notes: [],
      targetOid: null,
    });
    expect(await runOf(run.id)).toMatchObject({ status: "succeeded" });
    const [recorded] = await fixture.db
      .select()
      .from(databaseBackups)
      .where(eq(databaseBackups.runId, run.id));
    expect(recorded).toMatchObject({
      instanceKey: "mysql:3e11fa47-71ca-11e1-9e33-c80aa9429562",
      identity: null,
      engineOptions: { characterSet: "utf8mb4", collation: "utf8mb4_0900_ai_ci" },
    });
    const guide = await runs.restoreGuide(
      shared.db,
      fixture.tenantId,
      shop?.id as string,
      recorded?.id as string,
    );
    expect(guide).toContain("sha256sum 'shop.sql'");
    expect(guide).toMatch(
      /mysql -e 'CREATE DATABASE `shop_restored_\d{8}_\d{6}` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci'/,
    );
    expect(guide).toContain("mysql --binary-mode --skip-system-command --database='shop_restored_");
    expect(guide).not.toContain("pg_restore");
    // A schema name of 64 characters is a MySQL name; 65 is not.
    await expect(
      runs.requestRestore(
        shared.db,
        fixture.tenantId,
        shop?.id as string,
        { backupId: recorded?.id as string, name: "s".repeat(65) },
        ctx(),
      ),
    ).rejects.toMatchObject({ status: 422, type: runs.RUN_PROBLEMS.restoreName });
    const restore = await runs.requestRestore(
      shared.db,
      fixture.tenantId,
      shop?.id as string,
      { backupId: recorded?.id as string, name: "ä".repeat(64) },
      ctx(),
    );
    expect(restore.targetName).toBe("ä".repeat(64));
    const fetched = await runs.agentFetchRun(
      shared.db,
      agent(),
      restore.id,
      "https://restow.example.test",
    );
    expect(fetched.restore?.engineOptions).toEqual({
      characterSet: "utf8mb4",
      collation: "utf8mb4_0900_ai_ci",
    });
  });

  it("limits downloads at once, per tenant and in all", () => {
    const first = runs.takeDownloadSlot("tenant-a");
    const second = runs.takeDownloadSlot("tenant-a");
    expect(() => runs.takeDownloadSlot("tenant-a")).toThrow(
      expect.objectContaining({ status: 429 }),
    );
    const third = runs.takeDownloadSlot("tenant-b");
    const fourth = runs.takeDownloadSlot("tenant-c");
    expect(() => runs.takeDownloadSlot("tenant-d")).toThrow(
      expect.objectContaining({ status: 429 }),
    );
    first();
    first();
    const again = runs.takeDownloadSlot("tenant-a");
    for (const release of [second, third, fourth, again]) {
      release();
    }
  });
});
