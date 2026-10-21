/**
 * Temporarily unreadable packs against Postgres: the scrub handler keeps the
 * run of failed checks in `pack_read_failures`, files a yellow storage finding
 * while it is short, a red one once it lasted three checks over a day, and a
 * green "cleared" finding once the pack reads intact again; a restore check
 * reads the same split through `loadPackFindings`.
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server (a database
 * named `restow_worker_scrub_unreadable_test` is recreated there).
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import {
  ChunkWriter,
  createMemoryJobContext,
  generateDek,
  Keyring,
  LocalStorageBackend,
  packPrefix,
  type ScrubReport,
  type StorageBackend,
} from "@restow/core";
import {
  createDb,
  type Database,
  jobs,
  notifications,
  packReadFailures,
  packs,
  protectedObjects,
  providers,
  snapshots,
  sources,
  tenants,
  verifyReports,
} from "@restow/db";
import { runMigrations } from "@restow/db/migrate";
import { and, asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dropTestDatabase } from "../testing/database.js";
import { PgChunkIndex, tenantRunner, type WorkerJobContext } from "./framework.js";
import { loadPackFindings, scrubHandler } from "./scrub.js";

const adminUrl = process.env.RESTOW_TEST_DATABASE_URL;
const TEST_DB = "restow_worker_scrub_unreadable_test";
const HOUR = 3_600_000;

async function withAdmin(base: string, statement: string): Promise<void> {
  const admin = createDb(base);
  try {
    await admin.$client.query(statement);
  } finally {
    await admin.$client.end();
  }
}

/** Local storage whose reads of chosen keys are refused, like a bucket policy that denies them. */
class DenyingStorage extends LocalStorageBackend {
  readonly denied = new Set<string>();

  private refuse(key: string): void {
    if (this.denied.has(key)) {
      throw Object.assign(new Error("Access Denied"), {
        name: "AccessDenied",
        $metadata: { httpStatusCode: 403 },
      });
    }
  }

  override async get(key: string): Promise<Buffer> {
    this.refuse(key);
    return super.get(key);
  }

  override async getStream(key: string): Promise<Readable> {
    this.refuse(key);
    return super.getStream(key);
  }
}

describe.skipIf(!adminUrl)("temporarily unreadable packs against Postgres", () => {
  let db: Database;
  let root: string;
  const dek = generateDek(1);

  beforeAll(async () => {
    const base = adminUrl as string;
    await withAdmin(base, `DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await withAdmin(base, `CREATE DATABASE ${TEST_DB}`);
    const url = new URL(base);
    url.pathname = `/${TEST_DB}`;
    await runMigrations(url.toString());
    db = createDb(url.toString());
    root = await mkdtemp(join(tmpdir(), "restow-scrub-unreadable-"));
  }, 60_000);

  afterAll(async () => {
    await db?.$client.end();
    if (root) {
      await rm(root, { recursive: true, force: true });
    }
    if (adminUrl) {
      await dropTestDatabase(adminUrl, TEST_DB);
    }
  });

  /** A tenant with one mailbox whose active snapshot uses every chunk written. */
  async function fixture() {
    const [provider] = await db.insert(providers).values({ name: "P" }).returning();
    const [tenant] = await db
      .insert(tenants)
      .values({
        providerId: provider?.id as string,
        name: "T",
        slug: `t-${randomUUID().slice(0, 8)}`,
      })
      .returning();
    const tenantId = tenant?.id as string;
    const [source] = await db
      .insert(sources)
      .values({ tenantId, kind: "m365", name: "M365", config: {} })
      .returning();
    const [object] = await db
      .insert(protectedObjects)
      .values({
        tenantId,
        sourceId: source?.id as string,
        kind: "mailbox",
        externalId: `${randomUUID()}@example.test`,
      })
      .returning();
    const objectId = object?.id as string;
    const primary = new DenyingStorage(join(root, tenantId));
    const storage = { primary: primary as StorageBackend, copies: [] };
    const keys = new Keyring(tenantId, [dek]);
    const index = new PgChunkIndex(tenantRunner(db, tenantId), tenantId);
    const writer = new ChunkWriter({ tenantId, storage, keys, index, maxPackBytes: 2 * 1024 });
    const chunkIds: string[] = [];
    for (let i = 0; i < 6; i++) {
      const written = await writer.write(Buffer.from(`mail ${i} `.repeat(60 + i)));
      chunkIds.push(...written.chunks);
    }
    await writer.close();
    await index.addReferences(chunkIds);
    const [snapshot] = await db
      .insert(snapshots)
      .values({
        tenantId,
        protectedObjectId: objectId,
        sequence: 1,
        manifestPath: "m/1",
        completedAt: new Date("2026-10-01T00:00:00Z"),
      })
      .returning();
    await db.execute(sql`
      INSERT INTO manifest_objects (tenant_id, snapshot_id, protected_object_id, kind, path,
        name, parent_path, size, mtime, item_id, message_id, chunk_refs, metadata)
      VALUES (${tenantId}, ${snapshot?.id}, ${objectId}, 'mail', 'mail/Inbox/1.eml',
        '1.eml', 'mail/Inbox', 1, now(), 'i1', null, ${JSON.stringify(chunkIds)}::jsonb, '{}'::jsonb)
    `);
    const packKeys = (await primary.list(packPrefix(tenantId))).sort();
    return { tenantId, objectId, primary, storage, keys, packKeys };
  }

  type Fixture = Awaited<ReturnType<typeof fixture>>;

  async function scrubAt(
    f: Fixture,
    now: Date,
    mode: "full" | "sample" | "recheck" = "full",
  ): Promise<ScrubReport> {
    const jobId = randomUUID();
    await db.insert(jobs).values({
      id: jobId,
      tenantId: f.tenantId,
      queue: "scrub",
      status: "active",
      startedAt: now,
    });
    const ctx = {
      ...createMemoryJobContext({
        tenantId: f.tenantId,
        keys: f.keys,
        storage: f.storage,
        queue: "scrub",
        jobId,
        chunkIndex: new PgChunkIndex(tenantRunner(db, f.tenantId), f.tenantId),
        now: () => now,
      }),
      db,
      protectedObject: null,
    } as WorkerJobContext;
    await scrubHandler.run(ctx, { tenantId: f.tenantId, jobId, mode });
    await db
      .update(jobs)
      .set({ status: "completed", completedAt: now })
      .where(and(eq(jobs.tenantId, f.tenantId), eq(jobs.id, jobId)));
    const [row] = await db.select({ payload: jobs.payload }).from(jobs).where(eq(jobs.id, jobId));
    return (row?.payload as { result: ScrubReport } | undefined)?.result as ScrubReport;
  }

  async function findings(f: Fixture) {
    return db
      .select({
        readiness: verifyReports.recoveryReadiness,
        codes: sql<
          string[]
        >`coalesce((select array_agg(r->>'code') from jsonb_array_elements(${verifyReports.details}->'reasons') r), '{}')`,
        cleared: sql<boolean>`coalesce((${verifyReports.details}->>'cleared')::boolean, false)`,
      })
      .from(verifyReports)
      .where(
        and(
          eq(verifyReports.tenantId, f.tenantId),
          eq(verifyReports.protectedObjectId, f.objectId),
        ),
      )
      .orderBy(asc(verifyReports.checkedAt), asc(verifyReports.createdAt));
  }

  async function failureRow(f: Fixture, path: string) {
    const [row] = await db
      .select({
        checks: packReadFailures.failedChecks,
        first: packReadFailures.firstFailedAt,
        last: packReadFailures.lastFailedAt,
        detail: packReadFailures.detail,
      })
      .from(packReadFailures)
      .innerJoin(packs, eq(packs.id, packReadFailures.packId))
      .where(and(eq(packs.tenantId, f.tenantId), eq(packs.path, path)));
    return row ?? null;
  }

  it("counts failed checks, rates attention, then not restorable, and clears once read", async () => {
    const f = await fixture();
    const victim = f.packKeys[0] as string;
    f.primary.denied.add(victim);
    const start = new Date("2026-10-17T02:00:00Z");
    const run = tenantRunner(db, f.tenantId);

    const first = await scrubAt(f, start);
    expect(first.corrupt).toEqual([]);
    expect(first.unreadable.map((pack) => pack.path)).toEqual([victim]);
    expect(await failureRow(f, victim)).toMatchObject({
      checks: 1,
      first: start,
      last: start,
      detail: "Access Denied",
    });
    const [packRow] = await db.select().from(packs).where(eq(packs.path, victim));
    expect(packRow?.damagedAt).toBeNull();
    expect(await findings(f)).toEqual([
      { readiness: "yellow", codes: ["storage_unreadable"], cleared: false },
    ]);
    expect((await loadPackFindings(run, f.tenantId)).unreadable).toEqual(new Set([victim]));
    // Nothing alarming is raised for a pack that is only temporarily unreadable.
    expect(
      await db.select().from(notifications).where(eq(notifications.tenantId, f.tenantId)),
    ).toEqual([]);

    // Two more failed checks within hours: still attention only.
    await scrubAt(f, new Date(start.getTime() + HOUR), "sample");
    const third = await scrubAt(f, new Date(start.getTime() + 2 * HOUR), "recheck");
    expect(third.packsChecked).toBe(1);
    expect(third.unreadable[0]?.unreadable).toMatchObject({ checks: 3, persistent: false });
    expect((await findings(f)).map((row) => row.readiness)).toEqual(["yellow", "yellow", "yellow"]);

    // The fourth, more than a day after the first: counts like damage.
    const fourth = await scrubAt(f, new Date(start.getTime() + 25 * HOUR), "recheck");
    expect(fourth.unreadable[0]?.unreadable).toMatchObject({ checks: 4, persistent: true });
    expect((await findings(f)).at(-1)).toEqual({
      readiness: "red",
      codes: ["storage_unreadable_persistent"],
      cleared: false,
    });
    const persistent = await loadPackFindings(run, f.tenantId);
    expect(persistent.persistentlyUnreadable).toEqual(new Set([victim]));
    expect(persistent.unreadable).toEqual(new Set());
    expect(persistent.damaged).toEqual(new Set());
    const raised = await db
      .select({ event: notifications.event })
      .from(notifications)
      .where(eq(notifications.tenantId, f.tenantId));
    expect(raised.map((row) => row.event)).toContain("scrub.corrupt");

    // Readable again: the run of failures ends and the finding with it.
    f.primary.denied.clear();
    const cleared = await scrubAt(f, new Date(start.getTime() + 26 * HOUR), "recheck");
    expect(cleared.unreadable).toEqual([]);
    expect(cleared.cleared).toEqual([victim]);
    expect(await failureRow(f, victim)).toBeNull();
    expect((await findings(f)).at(-1)).toEqual({ readiness: "green", codes: [], cleared: true });
    expect(await loadPackFindings(run, f.tenantId)).toEqual({
      damaged: new Set(),
      unreadable: new Set(),
      persistentlyUnreadable: new Set(),
    });
  });

  it("starts the count again after a check that read the pack", async () => {
    const f = await fixture();
    const victim = f.packKeys[0] as string;
    const start = new Date("2026-10-17T02:00:00Z");
    f.primary.denied.add(victim);
    await scrubAt(f, start);
    await scrubAt(f, new Date(start.getTime() + HOUR), "recheck");
    expect((await failureRow(f, victim))?.checks).toBe(2);
    f.primary.denied.clear();
    await scrubAt(f, new Date(start.getTime() + 2 * HOUR), "recheck");
    expect(await failureRow(f, victim)).toBeNull();
    f.primary.denied.add(victim);
    const again = new Date(start.getTime() + 30 * HOUR);
    await scrubAt(f, again);
    expect(await failureRow(f, victim)).toMatchObject({ checks: 1, first: again });
  });

  it("reads a report from before 0.4.2 that listed unreadable packs as corrupt as unreadable", async () => {
    const f = await fixture();
    const victim = f.packKeys[0] as string;
    const damaged = f.packKeys[1] as string;
    await db.insert(jobs).values({
      tenantId: f.tenantId,
      queue: "scrub",
      status: "completed",
      completedAt: new Date("2026-10-17T02:33:00Z"),
      payload: {
        mode: "sample",
        result: {
          corrupt: [
            {
              path: victim,
              targets: [{ target: 0, status: "unreadable", detail: "aborted", repaired: false }],
            },
            {
              path: damaged,
              targets: [{ target: 0, status: "hash_mismatch", detail: null, repaired: false }],
            },
          ],
        },
      },
    });
    const found = await loadPackFindings(tenantRunner(db, f.tenantId), f.tenantId);
    expect(found.unreadable).toEqual(new Set([victim]));
    expect(found.damaged).toEqual(new Set([damaged]));

    // The next check reads both first, whatever it samples.
    const report = await scrubAt(f, new Date("2026-10-21T02:00:00Z"), "recheck");
    expect(report.packsChecked).toBe(2);
    expect(report.cleared.sort()).toEqual([victim, damaged].sort());
  });
});
