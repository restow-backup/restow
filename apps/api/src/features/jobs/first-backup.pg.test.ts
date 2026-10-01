/**
 * Postgres-backed tests of {@link enqueueFirstBackups}: idempotency (calling
 * it twice, or with an object already covered, never queues a second backup)
 * and tenant isolation (an id from another tenant is silently dropped, never
 * acted on). The selection itself (@restow/core's `selectFirstBackupTargets`)
 * is unit tested there; this suite is about what only a real database can
 * prove: RLS, the `jobs` row and the audit entry.
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server (the
 * database `restow_api_first_backup_test` is recreated there and dropped
 * after). Without it the suite is skipped.
 */
import { randomUUID } from "node:crypto";
import {
  type Database,
  auditLog,
  createDb,
  jobs,
  protectedObjects,
  providers,
  snapshots,
  sources,
  tenants,
} from "@restow/db";
import { and, eq } from "drizzle-orm";
import PgBoss from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  dropDatabase,
  recreateDatabase,
  testDatabaseAdminUrl,
} from "../snapshots/testing/explorer-fixture.js";
import { enqueueFirstBackups } from "./service.js";

const DATABASE = "restow_api_first_backup_test";

describe.skipIf(!testDatabaseAdminUrl)("enqueueFirstBackups against Postgres", () => {
  let db: Database;

  beforeAll(async () => {
    const url = await recreateDatabase(testDatabaseAdminUrl as string, DATABASE);
    const boss = new PgBoss({ connectionString: url });
    await boss.start();
    await boss.createQueue("backup");
    await boss.stop({ graceful: false, wait: true });
    db = createDb(url);
  }, 60_000);

  afterAll(async () => {
    await db?.$client.end();
    await dropDatabase(testDatabaseAdminUrl as string, DATABASE);
  });

  /** A tenant with one m365 source and its own provider (RLS is per tenant, not per provider). */
  async function tenant(name: string) {
    const [provider] = await db
      .insert(providers)
      .values({ name: `${name} Provider` })
      .returning();
    const [row] = await db
      .insert(tenants)
      .values({
        providerId: provider?.id as string,
        name,
        slug: `${name.toLowerCase()}-${randomUUID().slice(0, 8)}`,
      })
      .returning();
    const tenantId = row?.id as string;
    const [source] = await db
      .insert(sources)
      .values({ tenantId, kind: "m365", name: `${name} 365`, status: "active" })
      .returning();
    return { tenantId, sourceId: source?.id as string };
  }

  /** A protected object, `active` unless told otherwise. */
  async function object(
    tenantId: string,
    sourceId: string,
    overrides: { status?: "active" | "excluded" | "orphaned" } = {},
  ) {
    const [row] = await db
      .insert(protectedObjects)
      .values({
        tenantId,
        sourceId,
        kind: "mailbox",
        origin: "directory_sync",
        status: overrides.status ?? "active",
        externalId: randomUUID(),
        displayName: "Mailbox",
      })
      .returning();
    return row?.id as string;
  }

  async function jobRowsFor(tenantId: string, protectedObjectId: string) {
    return db
      .select()
      .from(jobs)
      .where(
        and(
          eq(jobs.tenantId, tenantId),
          eq(jobs.queue, "backup"),
          eq(jobs.protectedObjectId, protectedObjectId),
        ),
      );
  }

  async function firstBackupAuditEntries(tenantId: string) {
    return db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.tenantId, tenantId), eq(auditLog.action, "backup.first_queued")));
  }

  it("queues exactly one backup per object and audits it as the system", async () => {
    const { tenantId, sourceId } = await tenant("Idempotent");
    const a = await object(tenantId, sourceId);
    const b = await object(tenantId, sourceId);

    const queued = await enqueueFirstBackups(db, tenantId, [a, b]);
    expect(queued.sort()).toEqual([a, b].sort());

    for (const id of [a, b]) {
      const rows = await jobRowsFor(tenantId, id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: "queued", queue: "backup" });
    }
    const entries = await firstBackupAuditEntries(tenantId);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      actor: "system",
      actorUserId: null,
      details: expect.objectContaining({
        count: 2,
        protectedObjectIds: expect.arrayContaining([a, b]),
      }),
    });
  });

  it("is a no-op the second time it is called for the same objects", async () => {
    const { tenantId, sourceId } = await tenant("Repeat-Call");
    const a = await object(tenantId, sourceId);

    const first = await enqueueFirstBackups(db, tenantId, [a]);
    expect(first).toEqual([a]);

    const second = await enqueueFirstBackups(db, tenantId, [a]);
    expect(second).toEqual([]);

    const rows = await jobRowsFor(tenantId, a);
    expect(rows).toHaveLength(1); // still exactly one queued backup, not two
    const entries = await firstBackupAuditEntries(tenantId);
    expect(entries).toHaveLength(1); // no second audit entry either
  });

  it("skips an object that already has a completed snapshot", async () => {
    const { tenantId, sourceId } = await tenant("Has-Snapshot");
    const a = await object(tenantId, sourceId);
    await db.insert(snapshots).values({
      tenantId,
      protectedObjectId: a,
      sequence: 1,
      status: "active",
      manifestPath: `tenants/${tenantId}/manifests/snap-1.json.zst`,
      completedAt: new Date(),
    });

    const queued = await enqueueFirstBackups(db, tenantId, [a]);
    expect(queued).toEqual([]);
    expect(await jobRowsFor(tenantId, a)).toEqual([]);
    expect(await firstBackupAuditEntries(tenantId)).toEqual([]);
  });

  it("skips an object that is not (or no longer) active", async () => {
    const { tenantId, sourceId } = await tenant("Not-Active");
    const excluded = await object(tenantId, sourceId, { status: "excluded" });

    const queued = await enqueueFirstBackups(db, tenantId, [excluded]);
    expect(queued).toEqual([]);
    expect(await jobRowsFor(tenantId, excluded)).toEqual([]);
  });

  it("skips an active object whose source is disabled or not yet usable", async () => {
    const { tenantId } = await tenant("Source-Unusable");
    const [disabledSource] = await db
      .insert(sources)
      .values({ tenantId, kind: "m365", name: "Disabled 365", status: "disabled" })
      .returning();
    const [pendingSource] = await db
      .insert(sources)
      .values({ tenantId, kind: "imap", name: "New IMAP", status: "pending" })
      .returning();
    const onDisabled = await object(tenantId, disabledSource?.id as string);
    const onPending = await object(tenantId, pendingSource?.id as string);

    // Queuing either would only hand the worker a job it refuses without
    // retry (InvalidPayloadError), firing a job.failed webhook for nothing.
    const queued = await enqueueFirstBackups(db, tenantId, [onDisabled, onPending]);
    expect(queued).toEqual([]);
    expect(await jobRowsFor(tenantId, onDisabled)).toEqual([]);
    expect(await jobRowsFor(tenantId, onPending)).toEqual([]);
    expect(await firstBackupAuditEntries(tenantId)).toEqual([]);
  });

  it("never acts on another tenant's object, even if its id is passed in", async () => {
    const alpha = await tenant("Alpha");
    const beta = await tenant("Beta");
    const alphaObject = await object(alpha.tenantId, alpha.sourceId);
    const betaObject = await object(beta.tenantId, beta.sourceId);

    // Beta's call names both ids; only its own object may ever be touched.
    const queued = await enqueueFirstBackups(db, beta.tenantId, [betaObject, alphaObject]);
    expect(queued).toEqual([betaObject]);

    expect(await jobRowsFor(beta.tenantId, betaObject)).toHaveLength(1);
    // Alpha's object got nothing queued under either tenant id.
    expect(await jobRowsFor(alpha.tenantId, alphaObject)).toEqual([]);
    expect(await jobRowsFor(beta.tenantId, alphaObject)).toEqual([]);
    expect(await firstBackupAuditEntries(alpha.tenantId)).toEqual([]);
  });

  it("returns nothing for an empty id list without touching the database", async () => {
    const { tenantId } = await tenant("Empty-Call");
    await expect(enqueueFirstBackups(db, tenantId, [])).resolves.toEqual([]);
  });
});
