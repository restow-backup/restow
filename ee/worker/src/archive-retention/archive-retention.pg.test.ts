/**
 * Postgres-backed test of the archive deletion run (docs/ARCHIVE.md):
 * expired, unheld items are deleted and audited; items under either a
 * tenant-wide or a mailbox-scoped legal hold are never touched, however far
 * past their retention date they are (a hold wins over expiry). In restore mode
 * (after restoring a database dump) nothing is deleted at all: no row, no chunk
 * reference, no sealed record, also when restore mode comes on while the run goes.
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server (a database
 * named `restow_worker_archive_retention_test` is dropped and recreated
 * there on every run, then migrated). Without it the suite is skipped.
 */

import { randomUUID } from "node:crypto";
import {
  archive,
  assertDeletionPermitted,
  type DeletionGuard,
  DeletionsHeldError,
  generateDek,
  installDeletionEnforcement,
  Keyring,
  MemoryChunkIndex,
  ObjectLockedError,
  type StorageBackend,
} from "@restow/core";
import {
  archiveChainTombstones,
  archiveItemMailboxes,
  archiveItems,
  archiveRecordDeletions,
  auditLog,
  chunks,
  createDb,
  type Database,
  legalHolds,
  PgArchiveAppendStore,
  packs,
  protectedObjects,
  providers,
  sources,
  tenants,
} from "@restow/db";
import { runMigrations } from "@restow/db/migrate";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { verifyArchive } from "../../../../apps/api/src/features/archive/verify.js";
import { anchorArchiveChain } from "../../../../apps/worker/src/handlers/archive-anchor.js";
import { MemoryStorage } from "../../../../packages/core/src/verify/testing.js";
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

/**
 * A deletion guard as the worker installs it (restore-mode.ts), reduced to two switches: whether
 * a pass is granted a permit, and whether restore mode is known to be on (another process may
 * have switched it on after a permit was given).
 */
function testGuard(state: { refuse: boolean; holding: boolean }): {
  guard: DeletionGuard;
  passes: string[];
} {
  const passes: string[] = [];
  return {
    passes,
    guard: {
      async decide(request) {
        passes.push(request.pass);
        return state.refuse
          ? { allowed: false, reason: "restore_mode", restoreModeId: null }
          : { allowed: true, keepUnknownBefore: null, inRestoreMode: false };
      },
      holding: () => state.holding,
    },
  };
}

/**
 * A memory backend that checks the deletion guard of `@restow/core` before every delete, as every
 * real backend does (MemoryStorage is imported from the sources and so sees another instance).
 */
function guardedMemoryStorage(): StorageBackend {
  const inner = new MemoryStorage();
  return Object.assign(Object.create(inner), {
    delete: async (key: string) => {
      assertDeletionPermitted(key);
      await inner.delete(key);
    },
  });
}

/** A tenant with due items, their chunk references and their sealed records on two targets. */
async function seedSealedItems(db: Database, due: number) {
  const [provider] = await db.insert(providers).values({ name: "Provider" }).returning();
  const [tenant] = await db
    .insert(tenants)
    .values({ providerId: provider?.id as string, name: "Contoso", slug: "contoso" })
    .returning();
  const tenantId = tenant?.id as string;
  const [pack] = await db
    .insert(packs)
    .values({ tenantId, path: `tenants/${tenantId}/packs/aa/p1`, sha256: "s", size: 100 })
    .returning();
  await db
    .insert(chunks)
    .values({ tenantId, storedId: "c1", length: 10, packId: pack?.id as string, refcount: due });
  const primary = guardedMemoryStorage();
  const copy = guardedMemoryStorage();
  const received = new Date("2026-01-10T00:00:00.000Z");
  const paths: string[] = [];
  let prev: string | null = null;
  for (let n = 0; n < due; n++) {
    const id = randomUUID();
    const storagePath = archive.archiveItemKey(tenantId, received, id);
    paths.push(storagePath);
    for (const target of [primary, copy]) {
      await target.put(storagePath, Buffer.from(`sealed ${n}`));
    }
    const chainHash = archive.computeArchiveChainHash(prev, `h-${n}`, received);
    await db.insert(archiveItems).values({
      id,
      tenantId,
      messageId: `m-${n}`,
      itemHash: `h-${n}`,
      prevChainHash: prev,
      chainHash,
      receivedAt: received,
      capturedVia: "journal",
      retentionUntil: daysAgo(1),
      storagePath,
      chunks: ["c1"],
      createdAt: new Date(received.getTime() + n),
    });
    prev = chainHash;
  }
  return { tenantId, primary, copy, paths, storage: { primary, copies: [copy] } };
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
  it("keeps the chain check green after legitimate deletions (prefix, mid-chain, tip) and red for a row removed by hand", async () => {
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
      const [heldBox] = await db
        .insert(protectedObjects)
        .values({
          tenantId,
          sourceId: source?.id as string,
          kind: "mailbox",
          externalId: "held@contoso.example",
        })
        .returning();
      await db.insert(legalHolds).values({
        tenantId,
        reason: "Litigation",
        protectedObjectId: heldBox?.id as string,
        active: true,
      });

      // Six entries on three days, linked as the writers link them. Due: 0 and 1 (a prefix),
      // 2 (but held), 3 (mid-chain) and 5 (the tip); 4 is not due yet.
      const plan = [
        { day: "2026-01-10", due: true, held: false },
        { day: "2026-01-10", due: true, held: false },
        { day: "2026-01-11", due: true, held: true },
        { day: "2026-01-11", due: true, held: false },
        { day: "2026-01-12", due: false, held: false },
        { day: "2026-01-12", due: true, held: false },
      ];
      let prev: string | null = null;
      const ids: string[] = [];
      for (const [n, entry] of plan.entries()) {
        const receivedAt = new Date(`${entry.day}T0${n}:00:00.000Z`);
        const itemHash = `item-${n}`;
        const chainHash = archive.computeArchiveChainHash(prev, itemHash, receivedAt);
        const [row] = await db
          .insert(archiveItems)
          .values({
            tenantId,
            protectedObjectId: entry.held ? (heldBox?.id as string) : null,
            messageId: `m-${n}`,
            itemHash,
            prevChainHash: prev,
            chainHash,
            receivedAt,
            capturedVia: "journal",
            retentionUntil: entry.due ? daysAgo(1) : daysAgo(-1000),
            storagePath: `tenants/${tenantId}/archive/${n}`,
            createdAt: receivedAt,
          })
          .returning({ id: archiveItems.id });
        ids.push(row?.id as string);
        prev = chainHash;
      }
      // The nightly anchors, sealed before anything was deleted: counts 2, 4 and 6.
      const sealed = await anchorArchiveChain(db, tenantId, new Date("2026-01-13T00:00:00.000Z"));
      expect(sealed.map((anchor) => anchor.count)).toEqual([2, 4, 6]);
      const actor = { userId: null, label: "test", ip: null };

      const summary = await runArchiveRetention(db, tenantId, { dryRun: false }, () => NOW);
      expect(summary).toMatchObject({ deleted: 4, held: 1 });
      const tombstones = await db
        .select({ itemId: archiveChainTombstones.itemId })
        .from(archiveChainTombstones)
        .where(eq(archiveChainTombstones.tenantId, tenantId));
      expect(tombstones.map((row) => row.itemId).sort()).toEqual(
        [ids[0], ids[1], ids[3], ids[5]].sort(),
      );

      const afterDeletion = await verifyArchive(db, tenantId, { contentSample: 0, actor });
      expect(afterDeletion.ok).toBe(true);
      expect(afterDeletion.brokenAt).toBeNull();
      expect(afterDeletion.anchors.failed).toBeNull();
      expect(afterDeletion.checked).toBe(6);
      expect(afterDeletion.deleted.count).toBe(4);

      // The next capture links to the tombstone at the tip, not to the item before it.
      const captured = await archive.captureArchiveItem({
        tenantId,
        storage: { primary: new MemoryStorage(), copies: [] },
        keys: new Keyring(tenantId, [generateDek(1)]),
        index: new MemoryChunkIndex(),
        store: new PgArchiveAppendStore(db, tenantId),
        original: Buffer.from("Message-ID: <new@contoso.example>\r\nSubject: New\r\n\r\nHi\r\n"),
        source: "journal",
        receivedAt: new Date("2026-05-01T00:00:00.000Z"),
        envelope: null,
        flags: [],
        messageId: "new@contoso.example",
        retentionPolicy: { mode: "from_capture", years: 10 },
      });
      expect(captured.outcome).toBe("stored");
      const record = (captured as { record: archive.ArchiveItemRecord }).record;
      expect(record.prevChainHash).toBe(prev);
      // Anchors written after the deletions count the tombstones too.
      await anchorArchiveChain(db, tenantId, new Date("2099-01-01T00:00:00.000Z"));
      const afterCapture = await verifyArchive(db, tenantId, { contentSample: 0, actor });
      expect(afterCapture).toMatchObject({ ok: true, checked: 7, brokenAt: null });
      expect(afterCapture.anchors.failed).toBeNull();

      // A row removed by hand leaves no tombstone: that is tampering, and stays red.
      await db.delete(archiveItems).where(eq(archiveItems.id, ids[4] as string));
      const tampered = await verifyArchive(db, tenantId, { contentSample: 0, actor });
      expect(tampered.ok).toBe(false);
      expect(tampered.brokenAt?.position).toBe(5);
    } finally {
      await db.$client.end();
    }
  }, 120_000);
  it("releases exactly the deleted items' chunk references and deletes their sealed records on every target", async () => {
    const url = await recreateTestDatabase(adminUrl as string);
    const db = createDb(url);
    try {
      const [provider] = await db.insert(providers).values({ name: "Provider" }).returning();
      const [tenant] = await db
        .insert(tenants)
        .values({ providerId: provider?.id as string, name: "Contoso", slug: "contoso" })
        .returning();
      const tenantId = tenant?.id as string;
      const [pack] = await db
        .insert(packs)
        .values({ tenantId, path: `tenants/${tenantId}/packs/aa/p1`, sha256: "s", size: 100 })
        .returning();
      // "shared" is also referenced by a backup (1) besides the two items; "own" only by the
      // first item, twice (a chunk can occur twice in one mail); "kept" by an item not due.
      const refs: Record<string, number> = { shared: 3, own: 2, kept: 1 };
      for (const [storedId, refcount] of Object.entries(refs)) {
        await db.insert(chunks).values({
          tenantId,
          storedId,
          length: 10,
          packId: pack?.id as string,
          refcount,
        });
      }
      const primary = new MemoryStorage();
      const copy = new MemoryStorage();
      const received = new Date("2026-01-10T00:00:00.000Z");
      const items = [
        { label: "a", chunks: ["shared", "own", "own"], due: true },
        { label: "b", chunks: ["shared"], due: true },
        { label: "c", chunks: ["kept"], due: false },
      ];
      const paths: string[] = [];
      let prev: string | null = null;
      for (const [n, item] of items.entries()) {
        const id = randomUUID();
        const storagePath = archive.archiveItemKey(tenantId, received, id);
        paths.push(storagePath);
        for (const target of [primary, copy]) {
          await target.put(storagePath, Buffer.from(`sealed ${item.label}`));
        }
        const chainHash = archive.computeArchiveChainHash(prev, `h-${item.label}`, received);
        await db.insert(archiveItems).values({
          id,
          tenantId,
          messageId: `m-${item.label}`,
          itemHash: `h-${item.label}`,
          prevChainHash: prev,
          chainHash,
          receivedAt: received,
          capturedVia: "journal",
          retentionUntil: item.due ? daysAgo(1) : daysAgo(-1000),
          storagePath,
          chunks: item.chunks,
          createdAt: new Date(received.getTime() + n),
        });
        prev = chainHash;
      }

      const summary = await runArchiveRetention(db, tenantId, { dryRun: false }, () => NOW, {
        storage: { primary, copies: [copy] },
      });

      expect(summary).toMatchObject({
        deleted: 2,
        chunkReferencesReleased: 4,
        recordsDeleted: 2,
        recordsDeferred: 0,
        recordsPending: 0,
      });
      const counts = await db
        .select({ storedId: chunks.storedId, refcount: chunks.refcount })
        .from(chunks)
        .where(eq(chunks.tenantId, tenantId));
      expect(Object.fromEntries(counts.map((row) => [row.storedId, row.refcount]))).toEqual({
        shared: 1, // the backup's reference survives
        own: 0,
        kept: 1,
      });
      for (const target of [primary, copy]) {
        expect(await target.head(paths[0] as string)).toBeNull();
        expect(await target.head(paths[1] as string)).toBeNull();
        expect(await target.head(paths[2] as string)).not.toBeNull();
      }
      expect(await db.select().from(archiveRecordDeletions)).toHaveLength(0);
      const audit = await db
        .select({ action: auditLog.action, details: auditLog.details })
        .from(auditLog)
        .where(eq(auditLog.tenantId, tenantId));
      const itemEntry = audit.find((row) => row.action === "archive.item.deleted");
      expect(itemEntry?.details).toMatchObject({
        deleted: { row: true, sealedRecord: "queued" },
      });
      expect(audit.some((row) => row.action === "archive.records.deleted")).toBe(true);

      // A second run releases nothing again.
      const again = await runArchiveRetention(db, tenantId, { dryRun: false }, () => NOW, {
        storage: { primary, copies: [copy] },
      });
      expect(again).toMatchObject({ deleted: 0, chunkReferencesReleased: 0, recordsDeleted: 0 });
    } finally {
      await db.$client.end();
    }
  }, 60_000);

  it("keeps a record a target refuses queued, reports it deferred, and deletes it on a later run", async () => {
    const url = await recreateTestDatabase(adminUrl as string);
    const db = createDb(url);
    try {
      const [provider] = await db.insert(providers).values({ name: "Provider" }).returning();
      const [tenant] = await db
        .insert(tenants)
        .values({ providerId: provider?.id as string, name: "Contoso", slug: "contoso" })
        .returning();
      const tenantId = tenant?.id as string;
      const primary = new MemoryStorage();
      const lockedUntil = new Date(NOW.getTime() + 86_400_000);
      let locked = true;
      // An Object Lock copy whose lock on the record has not run out yet.
      const inner = new MemoryStorage();
      const copy: StorageBackend = Object.assign(Object.create(inner), {
        delete: async (key: string) => {
          if (locked) {
            throw new ObjectLockedError(key, lockedUntil, "object_lock");
          }
          await inner.delete(key);
        },
      });
      const id = randomUUID();
      const storagePath = archive.archiveItemKey(tenantId, daysAgo(3000), id);
      await primary.put(storagePath, Buffer.from("sealed"));
      await inner.put(storagePath, Buffer.from("sealed"));
      await db.insert(archiveItems).values({
        id,
        tenantId,
        messageId: "m",
        itemHash: "h",
        chainHash: archive.computeArchiveChainHash(null, "h", daysAgo(3000)),
        receivedAt: daysAgo(3000),
        capturedVia: "journal",
        retentionUntil: daysAgo(1),
        storagePath,
      });

      const first = await runArchiveRetention(db, tenantId, { dryRun: false }, () => NOW, {
        storage: { primary, copies: [copy] },
      });
      expect(first).toMatchObject({
        deleted: 1,
        recordsDeleted: 0,
        recordsDeferred: 1,
        recordsPending: 1,
      });
      const [queued] = await db.select().from(archiveRecordDeletions);
      expect(queued).toMatchObject({ itemId: id, attempts: 1 });
      expect(queued?.lastError).toContain("locked");
      expect(await inner.head(storagePath)).not.toBeNull();
      const deferredAudit = await db
        .select({ action: auditLog.action })
        .from(auditLog)
        .where(eq(auditLog.action, "archive.record.deletion_deferred"));
      expect(deferredAudit).toHaveLength(1);

      locked = false;
      const later = await runArchiveRetention(db, tenantId, { dryRun: false }, () => NOW, {
        storage: { primary, copies: [copy] },
      });
      expect(later).toMatchObject({
        deleted: 0,
        recordsDeleted: 1,
        recordsDeferred: 0,
        recordsPending: 0,
      });
      expect(await inner.head(storagePath)).toBeNull();
      expect(await db.select().from(archiveRecordDeletions)).toHaveLength(0);
    } finally {
      await db.$client.end();
    }
  }, 60_000);

  it("deletes nothing in restore mode: rows, chunk references and sealed records (queued ones too) stay", async () => {
    const url = await recreateTestDatabase(adminUrl as string);
    const db = createDb(url);
    const state = { refuse: true, holding: true };
    const { guard, passes } = testGuard(state);
    const uninstall = installDeletionEnforcement(guard, { strict: true });
    try {
      const { tenantId, primary, copy, paths, storage } = await seedSealedItems(db, 2);
      // A record an earlier run could not delete is still queued (its row is gone).
      const queuedPath = `tenants/${tenantId}/archive/earlier-run`;
      await primary.put(queuedPath, Buffer.from("sealed earlier"));
      await db
        .insert(archiveRecordDeletions)
        .values({ tenantId, itemId: randomUUID(), storagePath: queuedPath });

      const summary = await runArchiveRetention(db, tenantId, { dryRun: false }, () => NOW, {
        storage,
      });

      expect(summary).toMatchObject({
        restoreMode: true,
        candidates: 0,
        deleted: 0,
        chunkReferencesReleased: 0,
        recordsDeleted: 0,
        recordsDeferred: 0,
        recordsPending: 1,
      });
      expect(passes).toEqual(["archive_retention"]);
      expect(await db.select().from(archiveItems)).toHaveLength(2);
      expect(await db.select().from(archiveChainTombstones)).toHaveLength(0);
      const [chunk] = await db.select({ refcount: chunks.refcount }).from(chunks);
      expect(chunk?.refcount).toBe(2);
      for (const target of [primary, copy]) {
        for (const path of paths) {
          expect(await target.head(path)).not.toBeNull();
        }
      }
      expect(await primary.head(queuedPath)).not.toBeNull();
      expect(await db.select().from(archiveRecordDeletions)).toHaveLength(1);
      const audit = await db.select({ action: auditLog.action }).from(auditLog);
      expect(audit.filter((row) => row.action.startsWith("archive."))).toEqual([]);

      // A dry run still counts what would go.
      const dry = await runArchiveRetention(db, tenantId, { dryRun: true }, () => NOW, {
        storage,
      });
      expect(dry).toMatchObject({ deleted: 2, dryRun: true });
      expect(dry.restoreMode).toBeUndefined();

      // Once restore mode is ended the run deletes as before, the earlier queued record too.
      state.refuse = false;
      state.holding = false;
      const after = await runArchiveRetention(db, tenantId, { dryRun: false }, () => NOW, {
        storage,
      });
      expect(after).toMatchObject({ deleted: 2, recordsDeleted: 3, recordsPending: 0 });
      expect(after.restoreMode).toBeUndefined();
      expect(await primary.head(queuedPath)).toBeNull();
    } finally {
      uninstall();
      await db.$client.end();
    }
  }, 60_000);

  it("stops at the next batch when restore mode comes on while the run goes", async () => {
    const url = await recreateTestDatabase(adminUrl as string);
    const db = createDb(url);
    const state = { refuse: false, holding: false };
    const { guard, passes } = testGuard(state);
    const uninstall = installDeletionEnforcement(guard, { strict: true });
    try {
      const { tenantId, primary, copy, paths, storage } = await seedSealedItems(db, 2);

      await expect(
        runArchiveRetention(db, tenantId, { dryRun: false }, () => NOW, {
          storage,
          batchSize: 1,
          // Restore mode comes on after the first batch committed.
          afterBatch: async () => {
            state.refuse = true;
            state.holding = true;
          },
        }),
      ).rejects.toBeInstanceOf(DeletionsHeldError);

      expect(passes).toEqual(["archive_retention", "archive_retention", "archive_retention"]);
      // The first batch went (row, tombstone, reference); its sealed record stays queued and in
      // storage, the second item is untouched.
      expect(await db.select().from(archiveItems)).toHaveLength(1);
      expect(await db.select().from(archiveChainTombstones)).toHaveLength(1);
      const [chunk] = await db.select({ refcount: chunks.refcount }).from(chunks);
      expect(chunk?.refcount).toBe(1);
      expect(await db.select().from(archiveRecordDeletions)).toHaveLength(1);
      for (const target of [primary, copy]) {
        for (const path of paths) {
          expect(await target.head(path)).not.toBeNull();
        }
      }
    } finally {
      uninstall();
      await db.$client.end();
    }
  }, 60_000);

  it("keeps the sealed records queued when restore mode comes on after the permit was given", async () => {
    const url = await recreateTestDatabase(adminUrl as string);
    const db = createDb(url);
    // Every permit is granted, but another process switched restore mode on meanwhile: the
    // backends refuse the delete themselves (assertDeletionPermitted).
    const state = { refuse: false, holding: false };
    const { guard } = testGuard(state);
    const uninstall = installDeletionEnforcement(guard, { strict: true });
    try {
      const { tenantId, primary, copy, paths, storage } = await seedSealedItems(db, 1);

      await expect(
        runArchiveRetention(db, tenantId, { dryRun: false }, () => NOW, {
          storage,
          afterBatch: async () => {
            state.holding = true;
          },
        }),
      ).rejects.toBeInstanceOf(DeletionsHeldError);

      for (const target of [primary, copy]) {
        expect(await target.head(paths[0] as string)).not.toBeNull();
      }
      // Still queued, not counted as a refusal of the target (no attempt, no deferred audit).
      const [queued] = await db.select().from(archiveRecordDeletions);
      expect(queued).toMatchObject({ attempts: 0, lastError: null });
      const deferred = await db
        .select({ action: auditLog.action })
        .from(auditLog)
        .where(eq(auditLog.action, "archive.record.deletion_deferred"));
      expect(deferred).toHaveLength(0);
    } finally {
      uninstall();
      await db.$client.end();
    }
  }, 60_000);
});
