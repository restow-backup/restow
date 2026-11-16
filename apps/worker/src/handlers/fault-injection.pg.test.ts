/**
 * Fault injection into the chunk store (docs/CLAIMS.md, FAULT): a pack file is
 * deleted behind Restow's back (a lifecycle rule of the storage) or damaged on
 * disk, and each test asserts both halves of the promise: the readiness of the
 * affected object changes, and an alert is raised.
 *
 * Everything is real except the fault: a snapshot written through the chunk
 * store into a directory, the Postgres chunk index, pack catalog and manifest
 * index, the scrub and the verify handler with their production stores.
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server (a database
 * named `restow_worker_fault_injection_test` is recreated there).
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createMemoryJobContext,
  generateDek,
  Keyring,
  LocalStorageBackend,
  noopLogger,
  type ProtectedObjectRef,
  packPrefix,
  type ScrubReport,
  SnapshotWriter,
  type StorageTargets,
  UNREADABLE_CHECKS_LIMIT,
} from "@restow/core";
import {
  createDb,
  type Database,
  jobs,
  notifications,
  protectedObjects,
  providers,
  sources,
  tenants,
  verifyReports,
} from "@restow/db";
import { runMigrations } from "@restow/db/migrate";
import { and, asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dropTestDatabase } from "../testing/database.js";
import { PgChunkIndex, PgSnapshotIndex, tenantRunner, type WorkerJobContext } from "./framework.js";
import { SCRUB_EVENTS, scrubHandler } from "./scrub.js";
import { createVerifyHandler, VERIFY_EVENTS } from "./verify.js";

const adminUrl = process.env.RESTOW_TEST_DATABASE_URL;
const TEST_DB = "restow_worker_fault_injection_test";
const HOUR = 3_600_000;
/** A Sunday, 03:00 UTC: the weekly restore check of the recommended schedules. */
const BACKUP_AT = new Date("2026-10-04T01:00:00.000Z");

async function withAdmin(base: string, statement: string): Promise<void> {
  const admin = createDb(base);
  try {
    await admin.$client.query(statement);
  } finally {
    await admin.$client.end();
  }
}

/** Deterministic bytes with real entropy, so no two mails share a chunk. */
function mailBytes(size: number, seed: number): Buffer {
  const out = Buffer.alloc(size);
  let state = seed >>> 0;
  for (let i = 0; i < size; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out[i] = state >>> 24;
  }
  return out;
}

describe.skipIf(!adminUrl)("fault injection into the chunk store", { timeout: 30_000 }, () => {
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
    root = await mkdtemp(join(tmpdir(), "restow-fault-injection-"));
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

  /**
   * A tenant with one mailbox and one committed backup of six mails in small packs,
   * on a directory as the primary and, on request, a second directory as a copy.
   */
  async function fixture(options: { copy?: boolean } = {}) {
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
      .values({ tenantId, kind: "m365", name: "M365", status: "active", config: {} })
      .returning();
    const [row] = await db
      .insert(protectedObjects)
      .values({
        tenantId,
        sourceId: source?.id as string,
        kind: "mailbox",
        externalId: "anna@example.org",
        displayName: "Anna Example",
      })
      .returning();
    const object: ProtectedObjectRef = {
      id: row?.id as string,
      tenantId,
      sourceId: source?.id as string,
      kind: "mailbox",
      externalId: "anna@example.org",
      displayName: "Anna Example",
      userId: null,
    };
    const primary = new LocalStorageBackend(join(root, tenantId, "primary"));
    const copy = options.copy ? new LocalStorageBackend(join(root, tenantId, "copy")) : null;
    const storage: StorageTargets = { primary, copies: copy ? [copy] : [] };
    const keys = new Keyring(tenantId, [dek]);
    const f = { tenantId, object, primary, copy, storage, keys };

    const writer = await SnapshotWriter.begin(await context(f, "backup", BACKUP_AT), {
      protectedObject: object,
      sourceType: "m365",
      maxPackBytes: 2 * 1024,
    });
    const chunksByPath = new Map<string, string[]>();
    for (let i = 0; i < 6; i++) {
      const written = await writer.chunks.write(mailBytes(900 + i * 17, 500 + i));
      const path = `mail/Inbox/${i}.eml`;
      writer.add({
        path,
        type: "mail",
        id: `item-${i}`,
        size: written.size,
        mtime: Date.UTC(2026, 9, 3, 8, 0),
        sha256: written.sha256,
        chunks: written.chunks,
      });
      chunksByPath.set(path, written.chunks);
    }
    const committed = await writer.commit();
    const packKeys = (await primary.list(packPrefix(tenantId))).sort();
    return { ...f, snapshotId: committed.snapshotId, chunksByPath, packKeys };
  }

  type Base = {
    tenantId: string;
    object: ProtectedObjectRef;
    storage: StorageTargets;
    keys: Keyring;
  };
  type Fixture = Awaited<ReturnType<typeof fixture>>;

  /** A job row and the context the worker would run it with, at `now`. */
  async function context(
    f: Base,
    queue: "backup" | "verify" | "scrub",
    now: Date,
  ): Promise<WorkerJobContext> {
    const jobId = randomUUID();
    await db.insert(jobs).values({
      id: jobId,
      tenantId: f.tenantId,
      queue,
      status: "active",
      startedAt: now,
      protectedObjectId: queue === "scrub" ? null : f.object.id,
    });
    const run = tenantRunner(db, f.tenantId);
    return {
      ...createMemoryJobContext({
        tenantId: f.tenantId,
        keys: f.keys,
        storage: f.storage,
        queue,
        jobId,
        chunkIndex: new PgChunkIndex(run, f.tenantId),
        snapshots: new PgSnapshotIndex(run, f.tenantId, noopLogger),
        now: () => now,
      }),
      db,
      protectedObject: queue === "scrub" ? null : f.object,
    } as WorkerJobContext;
  }

  async function finish(f: Base, jobId: string, now: Date): Promise<void> {
    await db
      .update(jobs)
      .set({ status: "completed", completedAt: now })
      .where(and(eq(jobs.tenantId, f.tenantId), eq(jobs.id, jobId)));
  }

  /** The storage check as the worker runs it. */
  async function storageCheck(
    f: Fixture,
    now: Date,
    mode: "full" | "sample" = "full",
  ): Promise<ScrubReport> {
    const ctx = await context(f, "scrub", now);
    await scrubHandler.run(ctx, { tenantId: f.tenantId, jobId: ctx.jobId, mode });
    await finish(f, ctx.jobId, now);
    const [row] = await db
      .select({ payload: jobs.payload })
      .from(jobs)
      .where(eq(jobs.id, ctx.jobId));
    return (row?.payload as { result: ScrubReport } | undefined)?.result as ScrubReport;
  }

  /** The restore check as the worker runs it, with the production store. */
  async function restoreCheck(f: Fixture, now: Date): Promise<void> {
    const ctx = await context(f, "verify", now);
    await createVerifyHandler({ probes: () => null }).run(ctx, {
      jobId: ctx.jobId,
      tenantId: f.tenantId,
      protectedObjectId: f.object.id,
      kind: "verify",
      sampleSize: 20,
    });
    await finish(f, ctx.jobId, now);
  }

  /** Every rating of the object, oldest first: what the readiness views read. */
  async function ratings(f: Fixture) {
    return db
      .select({
        readiness: verifyReports.recoveryReadiness,
        origin: sql<string | null>`${verifyReports.details}->>'origin'`,
        codes: sql<
          string[]
        >`coalesce((select array_agg(r->>'code') from jsonb_array_elements(${verifyReports.details}->'reasons') r), '{}')`,
      })
      .from(verifyReports)
      .where(
        and(
          eq(verifyReports.tenantId, f.tenantId),
          eq(verifyReports.protectedObjectId, f.object.id),
        ),
      )
      .orderBy(asc(verifyReports.checkedAt), asc(verifyReports.createdAt));
  }

  async function alerts(f: Fixture) {
    return db
      .select({
        event: notifications.event,
        level: notifications.level,
        details: notifications.details,
      })
      .from(notifications)
      .where(eq(notifications.tenantId, f.tenantId))
      .orderBy(asc(notifications.createdAt));
  }

  /** Flip one byte in the middle of a stored file: bit rot, or a broken disk. */
  async function damage(target: LocalStorageBackend, key: string): Promise<void> {
    const bytes = await target.get(key);
    const middle = Math.floor(bytes.length / 2);
    bytes[middle] = (bytes[middle] ?? 0) ^ 0xff;
    await target.put(key, bytes);
  }

  describe("a pack file deleted behind Restow's back", () => {
    it("is found by the next full storage check, at once: the object turns red and scrub.corrupt is raised [FAULT-001]", async () => {
      const f = await fixture();
      await restoreCheck(f, new Date(BACKUP_AT.getTime() + 2 * HOUR));
      expect((await ratings(f)).map((row) => row.readiness)).toEqual(["green"]);
      expect(await alerts(f)).toEqual([]);

      // The lifecycle rule: the file goes, Restow's index and catalog still name it.
      const victim = f.packKeys[0] as string;
      await f.primary.delete(victim);

      const report = await storageCheck(f, new Date(BACKUP_AT.getTime() + 3 * HOUR), "full");
      // Proven damage on the first check: "missing" is an answer of the storage, not an
      // outage, so the three checks over a day of an unreadable pack do not apply.
      expect(UNREADABLE_CHECKS_LIMIT).toBe(3);
      expect(report.unreadable).toEqual([]);
      expect(report.corrupt.map((pack) => pack.path)).toEqual([victim]);
      expect(report.corrupt[0]?.targets).toMatchObject([{ target: 0, status: "missing" }]);

      // The state: a red storage finding on the object, the newest rating the views read.
      expect((await ratings(f)).at(-1)).toEqual({
        readiness: "red",
        origin: "scrub",
        codes: ["storage_corrupt"],
      });
      // The alert.
      const raised = await alerts(f);
      expect(raised.map((row) => row.event)).toEqual([SCRUB_EVENTS.corrupt]);
      expect(raised[0]).toMatchObject({
        level: "error",
        details: { corrupt: 1, affectedObjects: 1, packs: [victim] },
      });
    });

    it("turns the object red in the restore check that reads it, with verify.red [FAULT-002]", async () => {
      const f = await fixture();
      await restoreCheck(f, new Date(BACKUP_AT.getTime() + 2 * HOUR));
      expect((await ratings(f)).map((row) => row.readiness)).toEqual(["green"]);

      // Every pack goes, so the sample cannot miss the deletion.
      for (const key of f.packKeys) {
        await f.primary.delete(key);
      }
      // The wrapped key and the manifest stay: the storage still holds the tenant.
      await restoreCheck(f, new Date(BACKUP_AT.getTime() + 7 * 24 * HOUR - HOUR));

      const rated = await ratings(f);
      expect(rated.map((row) => row.readiness)).toEqual(["green", "red"]);
      expect(rated[1]?.codes).toContain("items_missing");
      const raised = await alerts(f);
      expect(raised.map((row) => row.event)).toEqual([VERIFY_EVENTS.red]);
      expect(raised[0]).toMatchObject({
        level: "error",
        details: { previous: "green", readiness: "red" },
      });
    });

    it("is put back from an intact copy by the storage check: scrub.repaired, and the object stays green [FAULT-003]", async () => {
      const f = await fixture({ copy: true });
      const victim = f.packKeys[0] as string;
      const copy = f.copy as LocalStorageBackend;
      // The backup wrote the pack to the copy as well.
      expect(await copy.head(victim)).not.toBeNull();
      await f.primary.delete(victim);

      const report = await storageCheck(f, new Date(BACKUP_AT.getTime() + 3 * HOUR), "full");
      expect(report.corrupt).toEqual([]);
      expect(report.repaired.map((pack) => pack.path)).toEqual([victim]);
      expect(report.repaired[0]?.targets).toMatchObject([
        { target: 0, status: "missing", repaired: true },
        { target: 1, status: "ok" },
      ]);
      expect((await f.primary.get(victim)).equals(await copy.get(victim))).toBe(true);

      // No finding rates the object, and the repair is announced.
      expect(await ratings(f)).toEqual([]);
      expect((await alerts(f)).map((row) => [row.event, row.level])).toEqual([
        [SCRUB_EVENTS.repaired, "warning"],
      ]);
      await restoreCheck(f, new Date(BACKUP_AT.getTime() + 4 * HOUR));
      expect((await ratings(f)).map((row) => row.readiness)).toEqual(["green"]);
    });
  });

  describe("a pack file damaged on the storage", () => {
    it("is found by the next full storage check: the object turns red and scrub.corrupt is raised [FAULT-004]", async () => {
      const f = await fixture();
      const victim = f.packKeys[1] as string;
      await damage(f.primary, victim);

      const report = await storageCheck(f, new Date(BACKUP_AT.getTime() + 3 * HOUR), "full");
      expect(report.unreadable).toEqual([]);
      expect(report.corrupt.map((pack) => pack.path)).toEqual([victim]);
      expect(report.corrupt[0]?.targets).toMatchObject([{ target: 0, status: "hash_mismatch" }]);

      expect((await ratings(f)).at(-1)).toEqual({
        readiness: "red",
        origin: "scrub",
        codes: ["storage_corrupt"],
      });
      const raised = await alerts(f);
      expect(raised.map((row) => [row.event, row.level])).toEqual([
        [SCRUB_EVENTS.corrupt, "error"],
      ]);
    });

    it("turns the object red in the restore check that reads it, with verify.red [FAULT-005]", async () => {
      const f = await fixture();
      await restoreCheck(f, new Date(BACKUP_AT.getTime() + 2 * HOUR));
      for (const key of f.packKeys) {
        await damage(f.primary, key);
      }
      await restoreCheck(f, new Date(BACKUP_AT.getTime() + 3 * HOUR));

      const rated = await ratings(f);
      expect(rated.map((row) => row.readiness)).toEqual(["green", "red"]);
      // The data does not open: never "matches", never silently skipped.
      expect(rated[1]?.codes.some((code) => code.startsWith("items_"))).toBe(true);
      expect(rated[1]?.codes).not.toContain("check_incomplete");
      expect((await alerts(f)).map((row) => [row.event, row.level])).toEqual([
        [VERIFY_EVENTS.red, "error"],
      ]);
    });
  });
});
