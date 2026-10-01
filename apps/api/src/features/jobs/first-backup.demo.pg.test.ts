/**
 * {@link enqueueFirstBackups} in demo mode: the automatic first backup follows
 * the same one-backup-batch-at-a-time rule as "Back up now"
 * (lib/demo-limits.ts), but skips instead of throwing, because the change
 * that made the objects protected has already committed. With nothing in
 * flight it still queues every first backup of the call, which is what the
 * demo seed (deploy/demo/seed) relies on.
 *
 * `config` (../../config.ts) is read from `process.env` at import time, so
 * demo mode is exercised by stubbing the environment, resetting the module
 * registry and importing the service fresh (same approach as
 * features/restore/restore.demo.pg.test.ts).
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server (the
 * database `restow_api_first_backup_demo_test` is recreated there and dropped
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
  sources,
  tenants,
} from "@restow/db";
import { and, eq } from "drizzle-orm";
import PgBoss from "pg-boss";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  dropDatabase,
  recreateDatabase,
  testDatabaseAdminUrl,
} from "../snapshots/testing/explorer-fixture.js";

const DATABASE = "restow_api_first_backup_demo_test";

type Service = typeof import("./service.js");

describe.skipIf(!testDatabaseAdminUrl)("enqueueFirstBackups in demo mode, on Postgres", () => {
  let db: Database;
  let service: Service;

  beforeAll(async () => {
    const url = await recreateDatabase(testDatabaseAdminUrl as string, DATABASE);
    process.env.DATABASE_URL = url;
    const boss = new PgBoss({ connectionString: url });
    await boss.start();
    await boss.createQueue("backup");
    await boss.stop({ graceful: false, wait: true });
    db = createDb(url);

    vi.resetModules();
    vi.stubEnv("RESTOW_DEMO", "true");
    service = await import("./service.js");
  }, 60_000);

  afterAll(async () => {
    vi.unstubAllEnvs();
    vi.resetModules();
    const shared = await import("../../db.js");
    await shared.db.$client.end();
    await db?.$client.end();
    await dropDatabase(testDatabaseAdminUrl as string, DATABASE);
  });

  /** A tenant with one usable IMAP source (the demo's only source kind). */
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
      .values({ tenantId, kind: "imap", name: `${name} IMAP`, status: "active" })
      .returning();
    return { tenantId, sourceId: source?.id as string };
  }

  async function object(tenantId: string, sourceId: string) {
    const [row] = await db
      .insert(protectedObjects)
      .values({
        tenantId,
        sourceId,
        kind: "imap",
        origin: "manual",
        status: "active",
        externalId: `${randomUUID()}@example.org`,
        displayName: "Mailbox",
      })
      .returning();
    return row?.id as string;
  }

  async function backupJobsFor(tenantId: string, protectedObjectId: string) {
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

  it("still queues every first backup of the call while nothing else is in flight", async () => {
    const { tenantId, sourceId } = await tenant("Quiet");
    const a = await object(tenantId, sourceId);
    const b = await object(tenantId, sourceId);

    const queued = await service.enqueueFirstBackups(db, tenantId, [a, b]);
    expect(queued.sort()).toEqual([a, b].sort());
    expect(await backupJobsFor(tenantId, a)).toHaveLength(1);
    expect(await backupJobsFor(tenantId, b)).toHaveLength(1);
    expect(await firstBackupAuditEntries(tenantId)).toHaveLength(1);
  });

  it("queues nothing while another backup of the tenant is queued or running", async () => {
    const { tenantId, sourceId } = await tenant("Busy");
    const running = await object(tenantId, sourceId);
    const added = await object(tenantId, sourceId);
    await db
      .insert(jobs)
      .values({ tenantId, queue: "backup", status: "active", protectedObjectId: running });

    // Skips rather than throwing: the protection change already committed.
    await expect(service.enqueueFirstBackups(db, tenantId, [added])).resolves.toEqual([]);
    expect(await backupJobsFor(tenantId, added)).toEqual([]);
    expect(await firstBackupAuditEntries(tenantId)).toEqual([]);
  });

  it("queues again once the tenant's backup in flight has finished", async () => {
    const { tenantId, sourceId } = await tenant("Finished");
    const earlier = await object(tenantId, sourceId);
    const added = await object(tenantId, sourceId);
    const [job] = await db
      .insert(jobs)
      .values({ tenantId, queue: "backup", status: "queued", protectedObjectId: earlier })
      .returning();
    expect(await service.enqueueFirstBackups(db, tenantId, [added])).toEqual([]);

    await db
      .update(jobs)
      .set({ status: "completed" })
      .where(eq(jobs.id, job?.id as string));
    expect(await service.enqueueFirstBackups(db, tenantId, [added])).toEqual([added]);
    expect(await backupJobsFor(tenantId, added)).toHaveLength(1);
  });

  it("is not held back by another tenant's backup or by other queues", async () => {
    const busy = await tenant("Neighbour");
    const own = await tenant("Own");
    const neighbourObject = await object(busy.tenantId, busy.sourceId);
    const added = await object(own.tenantId, own.sourceId);
    await db.insert(jobs).values([
      {
        tenantId: busy.tenantId,
        queue: "backup",
        status: "active",
        protectedObjectId: neighbourObject,
      },
      { tenantId: own.tenantId, queue: "verify", status: "active" },
      { tenantId: own.tenantId, queue: "restore", status: "queued" },
    ]);

    expect(await service.enqueueFirstBackups(db, own.tenantId, [added])).toEqual([added]);
  });
});
