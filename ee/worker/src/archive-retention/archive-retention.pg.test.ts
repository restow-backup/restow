/**
 * Postgres-backed test of the archive deletion run (docs/ARCHIVE.md):
 * expired, unheld items are deleted and audited; items under either a
 * tenant-wide or a mailbox-scoped legal hold are never touched, however far
 * past their retention date they are (a hold wins over expiry).
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server (a database
 * named `restow_worker_archive_retention_test` is dropped and recreated
 * there on every run, then migrated). Without it the suite is skipped.
 */
import {
  archiveItemMailboxes,
  archiveItems,
  auditLog,
  createDb,
  type Database,
  legalHolds,
  protectedObjects,
  providers,
  sources,
  tenants,
} from "@restow/db";
import { runMigrations } from "@restow/db/migrate";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { runArchiveRetention } from "./archive-retention.js";

const adminUrl = process.env.RESTOW_TEST_DATABASE_URL;
const TEST_DB = "restow_worker_archive_retention_test";
const NOW = new Date("2026-06-01T12:00:00.000Z");

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);
}

function testDatabaseUrl(base: string): string {
  const url = new URL(base);
  url.pathname = `/${TEST_DB}`;
  return url.toString();
}

async function recreateTestDatabase(base: string): Promise<string> {
  const admin = createDb(base);
  try {
    await admin.$client.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await admin.$client.query(`CREATE DATABASE ${TEST_DB}`);
  } finally {
    await admin.$client.end();
  }
  const url = testDatabaseUrl(base);
  await runMigrations(url);
  return url;
}

async function seedItem(
  db: Database,
  tenantId: string,
  overrides: {
    protectedObjectId?: string | null;
    receivedAt: Date;
    retentionUntil: Date | null;
    chainHash: string;
  },
) {
  const [row] = await db
    .insert(archiveItems)
    .values({
      tenantId,
      protectedObjectId: overrides.protectedObjectId ?? null,
      messageId: `msg-${overrides.chainHash}`,
      itemHash: `hash-${overrides.chainHash}`,
      prevChainHash: null,
      chainHash: overrides.chainHash,
      receivedAt: overrides.receivedAt,
      capturedVia: "journal",
      retentionUntil: overrides.retentionUntil,
      storagePath: `tenants/${tenantId}/archive/item-${overrides.chainHash}`,
    })
    .returning({ id: archiveItems.id });
  return row?.id as string;
}

describe.skipIf(!adminUrl)("runArchiveRetention against Postgres", () => {
  it("deletes only expired, unheld items and audits every deletion; a mailbox-scoped hold blocks only its own mailbox", async () => {
    const url = await recreateTestDatabase(adminUrl as string);
    const db = createDb(url);
    try {
      const [provider] = await db.insert(providers).values({ name: "Provider" }).returning();
      const [tenant] = await db
        .insert(tenants)
        .values({ providerId: provider?.id as string, name: "Contoso", slug: "contoso" })
        .returning();
      const tenantId = tenant?.id as string;
      const [source] = await db
        .insert(sources)
        .values({ tenantId, kind: "m365", name: "Contoso M365", status: "active" })
        .returning();
      const [mailboxB] = await db
        .insert(protectedObjects)
        .values({
          tenantId,
          sourceId: source?.id as string,
          kind: "mailbox",
          externalId: "b@contoso.example",
        })
        .returning();

      // expired, no mailbox scope, no hold covers it: due for deletion.
      await seedItem(db, tenantId, {
        receivedAt: daysAgo(3000),
        retentionUntil: daysAgo(1),
        chainHash: "expired",
      });
      // not yet due.
      await seedItem(db, tenantId, {
        receivedAt: daysAgo(10),
        retentionUntil: daysAgo(-3000),
        chainHash: "fresh",
      });
      // expired but held via a mailbox-scoped hold.
      await seedItem(db, tenantId, {
        protectedObjectId: mailboxB?.id as string,
        receivedAt: daysAgo(3000),
        retentionUntil: daysAgo(1),
        chainHash: "held-mailbox",
      });

      await db.insert(legalHolds).values({
        tenantId,
        reason: "Litigation (one mailbox)",
        protectedObjectId: mailboxB?.id as string,
        active: true,
      });

      const summary = await runArchiveRetention(db, tenantId, { dryRun: false }, () => NOW);

      expect(summary.deleted).toBe(1);
      expect(summary.held).toBe(1);
      expect(summary.candidates).toBe(2);

      const remaining = await db
        .select({ chainHash: archiveItems.chainHash })
        .from(archiveItems)
        .where(eq(archiveItems.tenantId, tenantId));
      const remainingHashes = remaining.map((row) => row.chainHash).sort();
      expect(remainingHashes).toEqual(["fresh", "held-mailbox"]);

      const auditRows = await db.select().from(auditLog).where(eq(auditLog.tenantId, tenantId));
      const deletionEntries = auditRows.filter((row) => row.action === "archive.item.deleted");
      expect(deletionEntries).toHaveLength(1);
      expect((deletionEntries[0]?.details as { itemHash?: string } | null)?.itemHash).toBe(
        "hash-expired",
      );
    } finally {
      await db.$client.end();
    }
  }, 60_000);

  it("a mailbox-scoped hold also blocks the journal reports assigned to that mailbox", async () => {
    const url = await recreateTestDatabase(adminUrl as string);
    const db = createDb(url);
    try {
      const [provider] = await db.insert(providers).values({ name: "Provider" }).returning();
      const [tenant] = await db
        .insert(tenants)
        .values({ providerId: provider?.id as string, name: "Contoso", slug: "contoso" })
        .returning();
      const tenantId = tenant?.id as string;
      const [source] = await db
        .insert(sources)
        .values({ tenantId, kind: "m365", name: "Contoso M365", status: "active" })
        .returning();
      const [held, free] = await db
        .insert(protectedObjects)
        .values([
          { tenantId, sourceId: source?.id as string, kind: "mailbox", externalId: "oid-held" },
          { tenantId, sourceId: source?.id as string, kind: "mailbox", externalId: "oid-free" },
        ])
        .returning();
      // Journal reports carry no protected_object_id; their mailboxes are assignments.
      const toHeld = await seedItem(db, tenantId, {
        receivedAt: daysAgo(3000),
        retentionUntil: daysAgo(1),
        chainHash: "journal-held",
      });
      const toFree = await seedItem(db, tenantId, {
        receivedAt: daysAgo(3000),
        retentionUntil: daysAgo(1),
        chainHash: "journal-free",
      });
      await db.insert(archiveItemMailboxes).values([
        { tenantId, archiveItemId: toHeld, protectedObjectId: held?.id as string },
        { tenantId, archiveItemId: toHeld, protectedObjectId: free?.id as string },
        { tenantId, archiveItemId: toFree, protectedObjectId: free?.id as string },
      ]);
      await db.insert(legalHolds).values({
        tenantId,
        reason: "Litigation (one mailbox)",
        protectedObjectId: held?.id as string,
        active: true,
      });

      const summary = await runArchiveRetention(db, tenantId, { dryRun: false }, () => NOW);

      expect(summary).toMatchObject({ deleted: 1, held: 1 });
      const remaining = await db
        .select({ chainHash: archiveItems.chainHash })
        .from(archiveItems)
        .where(eq(archiveItems.tenantId, tenantId));
      expect(remaining.map((row) => row.chainHash)).toEqual(["journal-held"]);
    } finally {
      await db.$client.end();
    }
  }, 60_000);

  it("a tenant-wide hold blocks every item, however far past its retention date", async () => {
    const url = await recreateTestDatabase(adminUrl as string);
    const db = createDb(url);
    try {
      const [provider] = await db.insert(providers).values({ name: "Provider" }).returning();
      const [tenant] = await db
        .insert(tenants)
        .values({ providerId: provider?.id as string, name: "Fabrikam", slug: "fabrikam" })
        .returning();
      const tenantId = tenant?.id as string;

      await seedItem(db, tenantId, {
        receivedAt: daysAgo(3000),
        retentionUntil: daysAgo(1),
        chainHash: "expired-tenant-wide",
      });
      await db
        .insert(legalHolds)
        .values({ tenantId, reason: "Litigation (whole tenant)", active: true });

      const summary = await runArchiveRetention(db, tenantId, { dryRun: false }, () => NOW);

      expect(summary.candidates).toBe(1);
      expect(summary.held).toBe(1);
      expect(summary.deleted).toBe(0);

      const remaining = await db
        .select({ id: archiveItems.id })
        .from(archiveItems)
        .where(eq(archiveItems.tenantId, tenantId));
      expect(remaining).toHaveLength(1);
    } finally {
      await db.$client.end();
    }
  }, 60_000);

  it("a dry run counts candidates without deleting or auditing anything", async () => {
    const url = await recreateTestDatabase(adminUrl as string);
    const db = createDb(url);
    try {
      const [provider] = await db.insert(providers).values({ name: "Provider" }).returning();
      const [tenant] = await db
        .insert(tenants)
        .values({ providerId: provider?.id as string, name: "Contoso", slug: "contoso" })
        .returning();
      const tenantId = tenant?.id as string;

      await seedItem(db, tenantId, {
        receivedAt: daysAgo(3000),
        retentionUntil: daysAgo(1),
        chainHash: "expired",
      });

      const summary = await runArchiveRetention(db, tenantId, { dryRun: true }, () => NOW);
      expect(summary.deleted).toBe(1);
      expect(summary.dryRun).toBe(true);

      const remaining = await db
        .select({ id: archiveItems.id })
        .from(archiveItems)
        .where(eq(archiveItems.tenantId, tenantId));
      expect(remaining).toHaveLength(1);

      const auditRows = await db.select().from(auditLog).where(eq(auditLog.tenantId, tenantId));
      expect(auditRows).toHaveLength(0);
    } finally {
      await db.$client.end();
    }
  }, 60_000);
  it("a hold placed between two batches protects every item the run has not reached yet", async () => {
    const url = await recreateTestDatabase(adminUrl as string);
    const db = createDb(url);
    try {
      const [provider] = await db.insert(providers).values({ name: "Provider" }).returning();
      const [tenant] = await db
        .insert(tenants)
        .values({ providerId: provider?.id as string, name: "Contoso", slug: "contoso" })
        .returning();
      const tenantId = tenant?.id as string;
      const [source] = await db
        .insert(sources)
        .values({ tenantId, kind: "m365", name: "Contoso M365", status: "active" })
        .returning();
      const [mailbox] = await db
        .insert(protectedObjects)
        .values({
          tenantId,
          sourceId: source?.id as string,
          kind: "mailbox",
          externalId: "x@contoso.example",
        })
        .returning();
      // Six due items of mailbox X, due one day apart: two batches of three.
      for (let n = 0; n < 6; n++) {
        await seedItem(db, tenantId, {
          protectedObjectId: mailbox?.id as string,
          receivedAt: daysAgo(3000),
          retentionUntil: daysAgo(10 - n),
          chainHash: `x-${n}`,
        });
      }

      let batches = 0;
      const summary = await runArchiveRetention(db, tenantId, { dryRun: false }, () => NOW, {
        batchSize: 3,
        afterBatch: async () => {
          batches++;
          if (batches === 1) {
            // Legal places a hold on X while the run is between batches.
            await db.insert(legalHolds).values({
              tenantId,
              reason: "Litigation (mailbox X)",
              protectedObjectId: mailbox?.id as string,
              active: true,
            });
          }
        },
      });

      expect(summary).toMatchObject({ candidates: 6, deleted: 3, held: 3 });
      const remaining = await db
        .select({ chainHash: archiveItems.chainHash })
        .from(archiveItems)
        .where(eq(archiveItems.tenantId, tenantId));
      expect(remaining.map((row) => row.chainHash).sort()).toEqual(["x-3", "x-4", "x-5"]);
    } finally {
      await db.$client.end();
    }
  }, 60_000);

  it("deletes 10,000 items due on the same day in bounded batches, and stops on a cancelled job", async () => {
    const url = await recreateTestDatabase(adminUrl as string);
    const db = createDb(url);
    try {
      const [provider] = await db.insert(providers).values({ name: "Provider" }).returning();
      const [tenant] = await db
        .insert(tenants)
        .values({ providerId: provider?.id as string, name: "Contoso", slug: "contoso" })
        .returning();
      const tenantId = tenant?.id as string;
      // end_of_year: a whole capture year falls due on the same 1 January.
      const due = daysAgo(1).toISOString();
      await db.execute(sql`
        insert into archive_items
          (tenant_id, message_id, item_hash, chain_hash, received_at, captured_via, retention_until, storage_path)
        select ${tenantId}::uuid, 'm-' || n, 'h-' || n, 'c-' || n, ${daysAgo(3000).toISOString()}::timestamptz,
               'journal', ${due}::timestamptz, 'tenants/' || ${tenantId} || '/archive/' || n
          from generate_series(1, 10000) as n`);

      const cancel = new AbortController();
      let batches = 0;
      const stopped = await runArchiveRetention(db, tenantId, { dryRun: false }, () => NOW, {
        signal: cancel.signal,
        afterBatch: async () => {
          batches++;
          if (batches === 4) {
            cancel.abort();
          }
        },
      }).catch((error: unknown) => error);
      expect(stopped).toBeInstanceOf(Error);
      expect((stopped as Error).name).toBe("JobAbortedError");
      const [afterCancel] = await db
        .select({ value: sql<number>`count(*)::int` })
        .from(archiveItems)
        .where(eq(archiveItems.tenantId, tenantId));
      // Four batches committed before the run stopped; nothing of a fifth.
      expect(afterCancel?.value).toBe(10_000 - 4 * 500);

      batches = 0;
      const summary = await runArchiveRetention(db, tenantId, { dryRun: false }, () => NOW, {
        afterBatch: async () => {
          batches++;
        },
      });
      expect(summary).toMatchObject({ candidates: 8000, deleted: 8000, held: 0 });
      expect(batches).toBe(16);
      const audits = await db
        .select({ value: sql<number>`count(*)::int` })
        .from(auditLog)
        .where(eq(auditLog.action, "archive.item.deleted"));
      expect(audits[0]?.value).toBe(10_000);
    } finally {
      await db.$client.end();
    }
  }, 300_000);
});
