/**
 * Backup and restore runs through the API, stage D3, against Postgres (docs/DATABASES.md 4.3,
 * 4.4, 7.1, 16 "D3"): "Jetzt sichern" plans one run at a time; an agent fetches its run once
 * with the credentials and a token for the connection's repository (append-only for a backup,
 * read-only for a restore), and reports what it wrote; another instance records nothing; a
 * restore is checked before it is planned (name, target, backup); the download streams the dump
 * from the repository and the guide holds no secret.
 *
 * Needs RESTOW_TEST_DATABASE_URL (a superuser) and restic on PATH; skipped otherwise.
 */
import { createHash } from "node:crypto";
import {
  type RepositoryAccess,
  resticBinary,
  resticCacheBase,
  runRestic,
  withRepository,
} from "@restow/core";
import {
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
    expect(spec.repository.repositoryPassword.length).toBeGreaterThan(20);
    await expect(
      runs.agentFetchRun(shared.db, agent(), run.id, "https://restow.example.test"),
    ).rejects.toMatchObject({ status: 404 });
    const [stored] = await fixture.db
      .select()
      .from(databaseRuns)
      .where(eq(databaseRuns.id, run.id));
    expect(stored?.status).toBe("running");
    expect(JSON.stringify(stored)).not.toContain(spec.repository.password);
    expect(JSON.stringify(stored)).not.toContain(PASSWORD);

    // The run's token opens the connection's repository, append-only, and nothing else.
    const allowed = await runs.resolveDatabaseRunCredential(
      { runId: run.id, token: spec.repository.password },
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
        { runId: run.id, token: spec.repository.password },
        databaseId,
      ),
    ).toEqual({ ok: false, reason: "invalid" });

    // The report: databases and backups recorded, the message cleaned.
    await runs.agentFinishRun(shared.db, agent(), run.id, {
      status: "partial",
      error: { code: "db_dump_failed", message: `pg_dump: password ${PASSWORD} rejected` },
      instance: {
        systemIdentifier: "7300000000000000042",
        serverVersion: "16.4",
        databases: [
          { name: "app", oid: "16384" },
          { name: "shop", oid: "16390" },
        ],
      },
      backups: [
        {
          kind: "database",
          name: "app",
          oid: "16384",
          snapshotId: "a".repeat(64),
          fileName: "postgresql/app.pgdump",
          sha256: "b".repeat(64),
          bytes: 4096,
          objects: { TABLE: 2 },
          startedAt: "2026-11-18T10:00:00Z",
          finishedAt: "2026-11-18T10:00:05Z",
          toolVersion: "16",
        },
      ],
      notes: [{ database: "shop", result: "failed", message: `for user ${USER}` }],
      targetOid: null,
    });
    const [done] = await fixture.db.select().from(databaseRuns).where(eq(databaseRuns.id, run.id));
    expect(done).toMatchObject({ status: "partial", errorCode: "db_dump_failed" });
    expect(JSON.stringify(done)).not.toContain(PASSWORD);
    expect(JSON.stringify(done)).not.toContain(USER);
    const backups = await runs.listBackups(shared.db, fixture.tenantId, databaseId);
    expect(backups.backups).toMatchObject([{ snapshotId: "a".repeat(64), bytes: 4096 }]);
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
      backups: [
        {
          kind: "database",
          name: "app",
          oid: "16384",
          snapshotId: "c".repeat(64),
          fileName: "postgresql/app.pgdump",
          sha256: "d".repeat(64),
          bytes: 1,
          objects: {},
          startedAt: "2026-11-18T11:00:00Z",
          finishedAt: "2026-11-18T11:00:01Z",
          toolVersion: "16",
        },
      ],
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

  it("checks a restore before planning it and hands the agent read-only access [DB-008]", async () => {
    const [backup] = await fixture.db
      .select()
      .from(databaseBackups)
      .where(eq(databaseBackups.databaseId, databaseId));
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
    expect(spec.restore).toMatchObject({ snapshotId: "a".repeat(64), targetName: run.targetName });
    const access = await runs.resolveDatabaseRunCredential(
      { runId: run.id, token: spec.repository.password },
      connectionId,
    );
    expect(access).toMatchObject({ ok: true, access: { principal: "reader" } });
  });

  it("streams a backup from the repository and guides a restore without a secret", async () => {
    // A real snapshot in the connection's repository (created by the first test's fetch).
    const [connection] = await fixture.db
      .select()
      .from(databaseConnections)
      .where(eq(databaseConnections.id, connectionId));
    const password = await secretStore.readSecret(shared.db, {
      id: connection?.repositorySecretId as string,
      tenantId: fixture.tenantId,
    });
    const { storage } = await repository.tenantStorage(shared.db, fixture.tenantId);
    const access: RepositoryAccess = {
      storage,
      prefix: `db/${connectionId}/`,
      repositoryPassword: password as string,
      repositoryKey: `db-${connectionId}`,
      binary: resticBinary(),
      cacheBase: resticCacheBase(),
    };
    const content = Buffer.from("PGDMP fake archive for the download test");
    const result = await withRepository(access, (session) =>
      runRestic(session, [
        "backup",
        "--json",
        "--stdin-from-command",
        "--stdin-filename",
        "postgresql/app.pgdump",
        "--",
        "printf",
        content.toString("utf8"),
      ]),
    );
    const snapshotId = result.stdout
      .split("\n")
      .map((line) => {
        try {
          return JSON.parse(line) as { message_type?: string; snapshot_id?: string };
        } catch {
          return null;
        }
      })
      .find((message) => message?.message_type === "summary")?.snapshot_id as string;
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
    expect(guide).not.toContain(PASSWORD);
    expect(guide).not.toContain(USER);
  });
});
