/**
 * Restoring archived mail into its mailbox (#48, features/restore/archive.ts) against
 * Postgres: the request, the lifecycle row, the queue entry and the audit entry in one
 * transaction; administrators only; the messages must be archived for that mailbox and
 * readable; a reason for another person's mail; and how the restore reads back.
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server (the database
 * `restow_api_restore_archive_test` is recreated there and dropped after).
 */
import { randomUUID } from "node:crypto";
import {
  archiveItemMailboxes,
  archiveItems,
  auditLog,
  createDb,
  type Database,
  jobs,
  protectedObjects,
  restoreJobs,
} from "@restow/db";
import { and, eq, sql } from "drizzle-orm";
import PgBoss from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createExplorerFixture,
  dropDatabase,
  type ExplorerFixture,
  recreateDatabase,
  testDatabaseAdminUrl,
} from "../snapshots/testing/explorer-fixture.js";
import { type CreateArchiveRestoreInput, createArchiveRestoreSchema } from "./archive.js";

const DATABASE = "restow_api_restore_archive_test";

type Archive = typeof import("./archive.js");
type Service = typeof import("./service.js");

const request = (input: Record<string, unknown>): CreateArchiveRestoreInput =>
  createArchiveRestoreSchema.parse(input);

describe.skipIf(!testDatabaseAdminUrl)("restore from the archive against Postgres", () => {
  let db: Database;
  let f: ExplorerFixture;
  let archive: Archive;
  let service: Service;
  const items: Record<string, string> = {};

  const actor = (viewer: ExplorerFixture["admin"]) => ({ ...viewer, ip: "192.0.2.20" });

  beforeAll(async () => {
    const url = await recreateDatabase(testDatabaseAdminUrl as string, DATABASE);
    process.env.DATABASE_URL = url;
    process.env.DATABASE_PROVIDER_URL = url;
    const boss = new PgBoss({ connectionString: url });
    await boss.start();
    await boss.createQueue("restore");
    await boss.stop({ graceful: false, wait: true });

    db = createDb(url);
    f = await createExplorerFixture(db);
    archive = await import("./archive.js");
    service = await import("./service.js");

    const item = async (label: string, own: string | null, recorded = true) => {
      const [row] = await db
        .insert(archiveItems)
        .values({
          tenantId: f.tenantId,
          protectedObjectId: own,
          messageId: `<${label}@contoso.test>`,
          itemHash: randomUUID(),
          chainHash: randomUUID(),
          receivedAt: new Date("2026-11-04T08:00:00Z"),
          capturedVia: own ? "graph_sync" : "journal",
          storagePath: `x/${label}`,
          subject: label,
          sizeBytes: recorded ? 100 : null,
          chunks: recorded ? ["c1"] : null,
        })
        .returning();
      items[label] = row?.id ?? "";
      return items[label] as string;
    };
    await item("annas", f.annaMailbox);
    const journal = await item("journal", null);
    await db
      .insert(archiveItemMailboxes)
      .values({ tenantId: f.tenantId, archiveItemId: journal, protectedObjectId: f.annaMailbox });
    await item("bobs", f.bobMailbox);
    await item("unrecorded", f.annaMailbox, false);
    await item("imaps", f.imapAccount);
  }, 60_000);

  afterAll(async () => {
    const shared = await import("../../db.js");
    await Promise.all([
      shared.db.$client.end(),
      shared.providerDb.$client.end(),
      shared.authDb.$client.end(),
    ]);
    await db?.$client.end();
    await dropDatabase(testDatabaseAdminUrl as string, DATABASE);
  });

  it("writes the request, the lifecycle row, the queue entry and the audit entry together", async () => {
    const input = {
      objectId: f.annaMailbox,
      itemIds: [items.journal, items.annas, items.annas],
      options: { restoreFolderName: "Aus dem Archiv 2026-11-04 0905" },
    };
    // Anna's mailbox is not the administrator's own: a reason is required.
    await expect(
      archive.createArchiveRestore(db, f.tenantId, actor(f.admin), request(input)),
    ).rejects.toMatchObject({ status: 422, type: "urn:restow:problem:restore-reason-required" });

    const created = await archive.createArchiveRestore(
      db,
      f.tenantId,
      actor(f.admin),
      request({ ...input, reason: "Ticket 4801: mail of yesterday evening deleted" }),
    );
    expect(created).toMatchObject({
      status: "queued",
      impersonated: true,
      selection: { all: false, folders: 0, items: 2 },
    });

    const [stored] = await db.select().from(restoreJobs).where(eq(restoreJobs.id, created.id));
    expect(stored).toMatchObject({
      jobId: created.jobId,
      snapshotId: null,
      targetType: "original",
      targetRef: null,
      mode: "rename",
      actorUserId: f.admin.userId,
      impersonated: true,
      sourceSelection: {
        archiveItemIds: [items.annas, items.journal].sort(),
        options: { restoreFolderName: "Aus dem Archiv 2026-11-04 0905" },
      },
    });
    const [job] = await db.select().from(jobs).where(eq(jobs.id, created.jobId));
    expect(job).toMatchObject({
      queue: "restore",
      status: "queued",
      protectedObjectId: f.annaMailbox,
    });
    const queued = await db.execute<{ name: string; data: Record<string, unknown> }>(
      sql`SELECT name, data FROM pgboss.job WHERE id = ${job?.pgBossJobId}::uuid`,
    );
    expect(queued.rows[0]).toEqual({
      name: "restore",
      data: {
        jobId: created.jobId,
        tenantId: f.tenantId,
        restoreJobId: created.id,
        protectedObjectId: f.annaMailbox,
      },
    });

    const [entry] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "restore.requested"), eq(auditLog.target, created.id)));
    expect(entry).toMatchObject({
      actorUserId: f.admin.userId,
      targetType: "restore_job",
      onBehalfOf: "anna@contoso.test",
      ip: "192.0.2.20",
    });
    expect(entry?.details).toMatchObject({
      source: "archive",
      snapshotId: null,
      target: "original",
      mode: "rename",
      archiveItemIds: [items.annas, items.journal].sort(),
      selection: { items: 2 },
    });

    const detail = await service.getRestore(db, f.tenantId, f.admin, created.id);
    expect(detail).toMatchObject({
      source: "archive",
      snapshotId: null,
      snapshotSequence: null,
      selection: { all: false, folders: 0, items: 2 },
      target: { type: "original", ref: null },
    });
    const listed = await service.listRestores(db, f.tenantId, f.admin, { limit: 50 });
    expect(listed.find((restore) => restore.id === created.id)?.source).toBe("archive");
  });

  it("restores an IMAP account's archived mail, the archive's administrators only", async () => {
    const input = request({ objectId: f.imapAccount, itemIds: [items.imaps], reason: "Ticket" });
    for (const role of ["tenant_restore", "tenant_user"] as const) {
      await expect(
        archive.createArchiveRestore(db, f.tenantId, actor({ ...f.admin, role }), input),
      ).rejects.toMatchObject({ status: 403 });
    }
    const created = await archive.createArchiveRestore(db, f.tenantId, actor(f.admin), input);
    expect(created.selection.items).toBe(1);
  });

  it("restores only messages archived for that mailbox, and only readable ones", async () => {
    await expect(
      archive.createArchiveRestore(
        db,
        f.tenantId,
        actor(f.admin),
        request({ objectId: f.annaMailbox, itemIds: [items.bobs], reason: "Ticket" }),
      ),
    ).rejects.toMatchObject({
      status: 422,
      type: "urn:restow:problem:restore-selection-unknown",
      extensions: { unknown: [`archiveItem:${items.bobs}`] },
    });
    await expect(
      archive.createArchiveRestore(
        db,
        f.tenantId,
        actor(f.admin),
        request({ objectId: f.annaMailbox, itemIds: [items.unrecorded], reason: "Ticket" }),
      ),
    ).rejects.toMatchObject({
      status: 422,
      type: "urn:restow:problem:archive-content-unavailable",
    });
    // A OneDrive holds no archived mail.
    await expect(
      archive.createArchiveRestore(
        db,
        f.tenantId,
        actor(f.admin),
        request({ objectId: f.annaDrive, itemIds: [items.annas], reason: "Ticket" }),
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("refuses an account that is gone at its source", async () => {
    await db
      .update(protectedObjects)
      .set({ status: "orphaned" })
      .where(eq(protectedObjects.id, f.bobMailbox));
    try {
      await expect(
        archive.createArchiveRestore(
          db,
          f.tenantId,
          actor(f.admin),
          request({ objectId: f.bobMailbox, itemIds: [items.bobs], reason: "Ticket" }),
        ),
      ).rejects.toMatchObject({ status: 409, type: "urn:restow:problem:restore-original-gone" });
    } finally {
      await db
        .update(protectedObjects)
        .set({ status: "active" })
        .where(eq(protectedObjects.id, f.bobMailbox));
    }
  });
});
