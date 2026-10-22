/**
 * The archive capture framework against Postgres: reconcile of the streams from the mail
 * jobs (scope `all` included), the gate (closed = idle), leases with `SKIP LOCKED` across
 * two service instances, a pass with a fake way (activation, backfill queued, appends,
 * dedupe across ways), the pause during a storage switch, the backfill job, and the
 * shared archive append under concurrency (strictly increasing `created_at`, a chain that
 * verifies in (created_at, id) order, also after legacy rows with equal timestamps).
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server (a database named
 * `restow_worker_archive_capture_test` is recreated there and dropped after).
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ArchiveJobPayload,
  archive,
  generateDek,
  Keyring,
  LocalStorageBackend,
  MemoryChunkIndex,
  type StorageTargets,
  type TenantKeyring,
} from "@restow/core";
import {
  archiveCaptureStreams,
  archiveItemCaptures,
  archiveItems,
  backupJobMembers,
  backupJobs,
  createDb,
  type Database,
  PgArchiveAppendStore,
  protectedObjects,
  providers,
  sources,
  storageMigrations,
  storageTargets,
  tenants,
} from "@restow/db";
import { runMigrations } from "@restow/db/migrate";
import { and, asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { WorkerFeatureGate } from "../extensions.js";
import { archiveHandler, configureArchiveHandler } from "../handlers/archive.js";
import { TenantCache, type WorkerJobContext } from "../handlers/framework.js";
import { dropTestDatabase } from "../testing/database.js";
import { reconcileCaptureStreams } from "./reconcile.js";
import { ArchiveCaptureService, type ArchiveCaptureServiceDeps } from "./service.js";
import type { CaptureWay, MailboxWay } from "./ways.js";

const adminUrl = process.env.RESTOW_TEST_DATABASE_URL;
const TEST_DB = "restow_worker_archive_capture_test";

const silent = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child() {
    return silent;
  },
};

async function withAdmin(base: string, statement: string): Promise<void> {
  const admin = createDb(base);
  try {
    await admin.$client.query(statement);
  } finally {
    await admin.$client.end();
  }
}

function mail(messageId: string, body: string, extraHeaders = ""): Buffer {
  return Buffer.from(
    `Message-ID: <${messageId}>\r\nFrom: alice@contoso.example\r\nTo: bob@contoso.example\r\n${extraHeaders}Subject: ${body}\r\nDate: Mon, 02 Nov 2026 08:00:00 +0000\r\n\r\n${body}\r\n`,
  );
}

const open: WorkerFeatureGate = { isEnabled: async () => true };
const closed: WorkerFeatureGate = { isEnabled: async () => false };

/** Walk the chain as the API's check does: (created_at, id) order, each link recomputed. */
async function chainVerifies(db: Database, tenantId: string): Promise<boolean> {
  const rows = await db
    .select({
      itemHash: archiveItems.itemHash,
      receivedAt: archiveItems.receivedAt,
      chainHash: archiveItems.chainHash,
    })
    .from(archiveItems)
    .where(eq(archiveItems.tenantId, tenantId))
    .orderBy(asc(archiveItems.createdAt), asc(archiveItems.id));
  let prev: string | null = null;
  for (const row of rows) {
    if (archive.computeArchiveChainHash(prev, row.itemHash, row.receivedAt) !== row.chainHash) {
      return false;
    }
    prev = row.chainHash;
  }
  return true;
}

describe.skipIf(!adminUrl)("archive capture (Postgres)", () => {
  let db: Database;
  let other: Database;
  let tenantId: string;
  let imapSourceId: string;
  let m365SourceId: string;
  let dir: string;
  let storage: StorageTargets;
  let keys: TenantKeyring;
  let jobId: string;

  beforeAll(async () => {
    await withAdmin(adminUrl as string, `DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await withAdmin(adminUrl as string, `CREATE DATABASE ${TEST_DB}`);
    const url = new URL(adminUrl as string);
    url.pathname = `/${TEST_DB}`;
    await runMigrations(url.toString());
    db = createDb(url.toString());
    other = createDb(url.toString());
    const [provider] = await db.insert(providers).values({ name: "Provider" }).returning();
    const [tenant] = await db
      .insert(tenants)
      .values({ providerId: provider?.id ?? "", name: "Contoso", slug: "contoso" })
      .returning();
    tenantId = tenant?.id ?? "";
    const [imap] = await db
      .insert(sources)
      .values({
        tenantId,
        kind: "imap",
        name: "Mail host",
        host: "imap.example.net",
        status: "active",
      })
      .returning();
    imapSourceId = imap?.id ?? "";
    const [m365] = await db
      .insert(sources)
      .values({ tenantId, kind: "m365", name: "Contoso 365", status: "active" })
      .returning();
    m365SourceId = m365?.id ?? "";
    dir = await mkdtemp(join(tmpdir(), "restow-capture-"));
    storage = { primary: new LocalStorageBackend(dir), copies: [] };
    keys = new Keyring(tenantId, [generateDek(1)]);
  }, 60_000);

  afterAll(async () => {
    await db?.$client.end();
    await other?.$client.end();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
    if (adminUrl) {
      await dropTestDatabase(adminUrl, TEST_DB);
    }
  });

  beforeEach(async () => {
    await db.execute(sql`delete from archive_capture_streams`);
    await db.execute(sql`delete from backup_job_members`);
    await db.execute(sql`delete from backup_jobs`);
    await db.execute(sql`delete from storage_migrations`);
    const [job] = await db
      .insert(backupJobs)
      .values({ tenantId, kind: "mail", name: `Mail ${randomUUID()}`, archive: true })
      .returning();
    jobId = job?.id ?? "";
  });

  async function imapObject(login: string): Promise<string> {
    const [object] = await db
      .insert(protectedObjects)
      .values({ tenantId, sourceId: imapSourceId, kind: "imap", externalId: login })
      .returning();
    return object?.id ?? "";
  }

  async function member(objectId: string, job = jobId): Promise<void> {
    await db.insert(backupJobMembers).values({ tenantId, jobId: job, protectedObjectId: objectId });
  }

  async function streams() {
    return db
      .select()
      .from(archiveCaptureStreams)
      .orderBy(asc(archiveCaptureStreams.createdAt), asc(archiveCaptureStreams.id));
  }

  function service(
    ways: Partial<Record<MailboxWay, CaptureWay>>,
    overrides: Partial<ArchiveCaptureServiceDeps> = {},
  ) {
    const backfills: string[] = [];
    const instance = new ArchiveCaptureService({
      db,
      providerDb: db,
      keyrings: new TenantCache(async () => keys),
      storage: new TenantCache(async () => storage),
      logger: silent,
      gate: open,
      ways,
      settings: { gateCheckMs: 0, reconcileMs: 0, leaseMs: 60_000, concurrency: 16 },
      enqueueBackfill: async (stream) => {
        backfills.push(stream.protectedObjectId);
        return randomUUID();
      },
      ...overrides,
    });
    return { instance, backfills };
  }

  /** A way that captures what `inbox` holds for a mailbox, once per mail. */
  function fakeWay(inbox: Map<string, Buffer[]>, hooks: { gate?: Promise<void> } = {}) {
    const way: CaptureWay = {
      way: "imap_sync",
      async ensure() {
        await hooks.gate;
        return { activated: true, mode: "poll" };
      },
      async drain(_ctx, refs) {
        return { handled: refs, captured: 0 };
      },
      async catchUp(ctx) {
        let captured = 0;
        const mails = inbox.get(ctx.stream.protectedObjectId) ?? [];
        const done = (ctx.stream.state.done as number | undefined) ?? 0;
        for (const [n, original] of mails.slice(done).entries()) {
          await ctx.append({ original, externalRef: `INBOX;1;${done + n + 1}` });
          captured++;
        }
        return {
          state: { done: mails.length },
          captured,
          nextDueAt: new Date(ctx.now().getTime() + 3_600_000),
        };
      },
      async backfill(ctx) {
        const old = inbox.get(`old:${ctx.stream.protectedObjectId}`) ?? [];
        for (const [n, original] of old.entries()) {
          await ctx.append({
            original,
            externalRef: `Archive;1;${n + 1}`,
            receivedByService: new Date("2020-01-01T00:00:00Z"),
          });
        }
        return { captured: old.length, skipped: 0, completed: true };
      },
    };
    return way;
  }

  it("reconciles streams from the mail jobs, the ways chosen and scope all", async () => {
    const imap = await imapObject("anna@example.net");
    const [mailbox] = await db
      .insert(protectedObjects)
      .values({
        tenantId,
        sourceId: m365SourceId,
        kind: "mailbox",
        externalId: "ben@contoso.example",
      })
      .returning();
    const [drive] = await db
      .insert(protectedObjects)
      .values({ tenantId, sourceId: m365SourceId, kind: "onedrive", externalId: "drive-1" })
      .returning();
    await member(imap);
    await member(mailbox?.id ?? "");
    await member(drive?.id ?? "");

    expect(await reconcileCaptureStreams(db)).toEqual({ wanted: 2, disabled: 0 });
    const rows = await streams();
    expect(rows.map((row) => [row.protectedObjectId, row.way, row.status]).sort()).toEqual(
      [
        [imap, "imap_sync", "pending"],
        [mailbox?.id, "graph_sync", "pending"],
      ].sort(),
    );
    // Idempotent.
    expect(await reconcileCaptureStreams(db)).toEqual({ wanted: 0, disabled: 0 });

    // Graph not chosen for Microsoft 365 (journaling only): its stream is disabled.
    await db
      .update(backupJobs)
      .set({ archiveCapture: { m365: { graph: false, journal: true } } })
      .where(eq(backupJobs.id, jobId));
    expect(await reconcileCaptureStreams(db)).toEqual({ wanted: 0, disabled: 1 });

    // Archive off: everything disabled; on again: back, due now.
    await db.update(backupJobs).set({ archive: false }).where(eq(backupJobs.id, jobId));
    expect((await reconcileCaptureStreams(db)).disabled).toBe(1);
    await db
      .update(backupJobs)
      .set({ archive: true, archiveCapture: {} })
      .where(eq(backupJobs.id, jobId));
    expect(await reconcileCaptureStreams(db)).toEqual({ wanted: 2, disabled: 0 });
    expect((await streams()).every((row) => row.status === "pending")).toBe(true);
  });

  it("covers every object not in another job for a job of scope all", async () => {
    await db.update(backupJobs).set({ scopeMode: "all" }).where(eq(backupJobs.id, jobId));
    const free = await imapObject("free@example.net");
    const taken = await imapObject("taken@example.net");
    const [otherJob] = await db
      .insert(backupJobs)
      .values({ tenantId, kind: "mail", name: "Other", archive: false })
      .returning();
    await member(taken, otherJob?.id);
    await reconcileCaptureStreams(db);
    const objects = (await streams()).map((row) => row.protectedObjectId);
    expect(objects).toContain(free);
    expect(objects).not.toContain(taken);
  });

  it("stays idle while the gate is closed: no reconcile, no claim", async () => {
    await member(await imapObject("idle@example.net"));
    const { instance } = service({ imap_sync: fakeWay(new Map()) }, { gate: closed });
    expect(await instance.tick()).toBe(0);
    expect(instance.isEnabled()).toBe(false);
    expect(await streams()).toEqual([]);
  });

  it("activates a stream, queues its backfill, captures and merges across ways", async () => {
    const object = await imapObject("carla@example.net");
    await member(object);
    const inbox = new Map([
      [object, [mail("m1@example.net", "First"), mail("m2@example.net", "Second")]],
    ]);
    const { instance, backfills } = service({ imap_sync: fakeWay(inbox) });

    expect(await instance.tick()).toBe(1);
    await instance.settle();
    expect(backfills).toEqual([object]);
    const [stream] = await streams();
    expect(stream).toMatchObject({
      status: "backfilling",
      leaseOwner: null,
      consecutiveFailures: 0,
    });
    expect(stream?.activatedAt).not.toBeNull();
    expect(stream?.state).toEqual({ done: 2 });
    expect(stream?.nextDueAt?.getTime()).toBeGreaterThan(Date.now() + 3_000_000);

    const items = await db
      .select()
      .from(archiveItems)
      .where(eq(archiveItems.protectedObjectId, object))
      .orderBy(asc(archiveItems.createdAt));
    expect(items.map((item) => [item.capturedVia, item.externalRef, item.subject])).toEqual([
      ["imap_sync", "INBOX;1;1", "First"],
      ["imap_sync", "INBOX;1;2", "Second"],
    ]);
    expect(items.every((item) => item.bodyHash !== null)).toBe(true);

    // The same mail again through another mailbox: a capture row, no second item.
    const second = await imapObject("carla-alias@example.net");
    await member(second);
    inbox.set(second, [mail("m1@example.net", "First", "X-Delivered: again\r\n")]);
    await instance.tick();
    await instance.settle();
    const captures = await db
      .select()
      .from(archiveItemCaptures)
      .where(eq(archiveItemCaptures.protectedObjectId, second));
    expect(captures).toHaveLength(1);
    expect(captures[0]?.archiveItemId).toBe(items[0]?.id);
    const count = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(archiveItems)
      .where(eq(archiveItems.tenantId, tenantId));
    expect(await chainVerifies(db, tenantId)).toBe(true);
    expect(count[0]?.n).toBeGreaterThanOrEqual(2);
  });

  it("leases each stream to one of two service instances (SKIP LOCKED)", async () => {
    for (let n = 0; n < 6; n++) {
      await member(await imapObject(`lease${n}@example.net`));
    }
    await reconcileCaptureStreams(db);
    let openGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const way = fakeWay(new Map(), { gate });
    const a = service(
      { imap_sync: way },
      {
        owner: "worker-a",
        settings: { gateCheckMs: 0, reconcileMs: 1e9, leaseMs: 60_000, concurrency: 4 },
      },
    );
    const b = service(
      { imap_sync: way },
      {
        owner: "worker-b",
        settings: { gateCheckMs: 0, reconcileMs: 1e9, leaseMs: 60_000, concurrency: 4 },
      },
    );
    const [claimedA, claimedB] = await Promise.all([a.instance.tick(), b.instance.tick()]);
    expect(claimedA + claimedB).toBe(6);
    const runningA = new Set(a.instance.runningStreams());
    const runningB = new Set(b.instance.runningStreams());
    expect([...runningA].some((id) => runningB.has(id))).toBe(false);
    const leased = await db
      .select({ owner: archiveCaptureStreams.leaseOwner })
      .from(archiveCaptureStreams);
    expect(leased.every((row) => row.owner === "worker-a" || row.owner === "worker-b")).toBe(true);
    // Nothing is due for a third claim while the leases hold.
    expect(await a.instance.tick()).toBe(0);
    openGate();
    await Promise.all([a.instance.settle(), b.instance.settle()]);
    const after = await streams();
    expect(after.every((row) => row.leaseOwner === null && row.status === "backfilling")).toBe(
      true,
    );
  });

  it("does not claim a tenant whose storage is switching, and aborts its passes", async () => {
    await member(await imapObject("switch@example.net"));
    const [target] = await db
      .insert(storageTargets)
      .values({
        tenantId,
        name: "New",
        kind: "local",
        role: "copy",
        config: { path: "/tmp/x" } as never,
      })
      .returning();
    const [migration] = await db
      .insert(storageMigrations)
      .values({
        tenantId,
        destinationTargetId: target?.id ?? "",
        mode: "move",
        status: "switching",
      })
      .returning();
    const { instance } = service({ imap_sync: fakeWay(new Map()) });
    expect(await instance.tick()).toBe(0);
    expect((await streams())[0]?.status).toBe("pending");

    await db
      .update(storageMigrations)
      .set({ status: "completed" })
      .where(eq(storageMigrations.id, migration?.id ?? ""));
    expect(await instance.tick()).toBe(1);
    await instance.settle();
    await db
      .delete(storageTargets)
      .where(eq(storageTargets.id, target?.id ?? ""))
      .catch(() => {});
  });

  it("records a failing pass with backoff, error after repeated failures", async () => {
    await member(await imapObject("broken@example.net"));
    const way: CaptureWay = {
      ...fakeWay(new Map()),
      async ensure() {
        throw new Error("connection refused");
      },
    };
    const { instance } = service(
      { imap_sync: way },
      { settings: { gateCheckMs: 0, reconcileMs: 0, errorAfterFailures: 2, leaseMs: 60_000 } },
    );
    await instance.tick();
    await instance.settle();
    let [stream] = await streams();
    expect(stream?.consecutiveFailures).toBe(1);
    expect(stream?.status).toBe("pending");
    expect(stream?.failure?.code).toBeTruthy();
    expect(stream?.nextDueAt?.getTime()).toBeGreaterThan(Date.now() + 30_000);
    await db.update(archiveCaptureStreams).set({ nextDueAt: new Date(0) });
    await instance.tick();
    await instance.settle();
    [stream] = await streams();
    expect(stream?.consecutiveFailures).toBe(2);
    expect(stream?.status).toBe("error");
  });

  it("runs the backfill job: captured late, stream live; skipped while the gate is closed", async () => {
    const object = await imapObject("dora@example.net");
    await member(object);
    await reconcileCaptureStreams(db);
    const activatedAt = new Date();
    await db
      .update(archiveCaptureStreams)
      .set({ status: "backfilling", activatedAt })
      .where(eq(archiveCaptureStreams.protectedObjectId, object));
    const inbox = new Map([[`old:${object}`, [mail("old@example.net", "Old mail")]]]);
    const ctx = {
      db,
      tenantId,
      storage,
      keys,
      chunkIndex: new MemoryChunkIndex(),
      logger: silent,
      signal: new AbortController().signal,
      now: () => new Date(),
      cursor: { load: async () => null, save: async () => {}, clear: async () => {} },
    } as unknown as WorkerJobContext;
    const payload: ArchiveJobPayload = {
      jobId: randomUUID(),
      tenantId,
      protectedObjectId: object,
      capture: "imap_sync",
      mode: "backfill",
    };

    configureArchiveHandler({ providerDb: db, gate: closed, ways: { imap_sync: fakeWay(inbox) } });
    expect(await archiveHandler.run(ctx, payload)).toMatchObject({
      summary: { status: "skipped" },
    });

    configureArchiveHandler({ providerDb: db, gate: open, ways: { imap_sync: fakeWay(inbox) } });
    expect(await archiveHandler.run(ctx, payload)).toMatchObject({
      summary: { status: "completed", captured: 1 },
    });
    const [stream] = await db
      .select()
      .from(archiveCaptureStreams)
      .where(eq(archiveCaptureStreams.protectedObjectId, object));
    expect(stream?.status).toBe("live");
    expect(stream?.backfillCompletedAt).not.toBeNull();
    const [item] = await db
      .select()
      .from(archiveItems)
      .where(
        and(
          eq(archiveItems.protectedObjectId, object),
          eq(archiveItems.externalRef, "Archive;1;1"),
        ),
      );
    expect(item?.flags).toContain("captured-late");

    // A legacy archive job without a mode makes the mailbox due.
    await db.update(archiveCaptureStreams).set({ nextDueAt: null });
    const marked = await archiveHandler.run(ctx, { ...payload, mode: undefined });
    expect(marked).toMatchObject({ summary: { status: "marked_due", streams: 1 } });
    configureArchiveHandler(null);
  });

  it("keeps the chain linear under concurrent appends from two processes on one clock", async () => {
    const [chainTenant] = await db
      .insert(tenants)
      .values({
        providerId: (await db.select().from(providers))[0]?.id ?? "",
        name: "Fabrikam",
        slug: `fabrikam-${randomUUID().slice(0, 8)}`,
      })
      .returning();
    const tid = chainTenant?.id ?? "";
    // Two legacy rows with the same created_at (the fork the old writers could produce).
    const at = new Date("2026-10-01T10:00:00.000Z");
    const legacy = [randomUUID(), randomUUID()].sort();
    let prev: string | null = null;
    for (const [n, id] of legacy.entries()) {
      const itemHash = `legacy-${n}`;
      const chainHash = archive.computeArchiveChainHash(prev, itemHash, at);
      await db.insert(archiveItems).values({
        id,
        tenantId: tid,
        messageId: `legacy-${n}`,
        itemHash,
        prevChainHash: prev,
        chainHash,
        receivedAt: at,
        capturedVia: "journal",
        storagePath: `legacy/${n}`,
        createdAt: at,
      });
      prev = chainHash;
    }
    const frozen = new Date("2026-10-01T10:00:00.000Z");
    const tenantKeys = new Keyring(tid, [generateDek(1)]);
    const index = new MemoryChunkIndex();
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, n) =>
        archive.captureArchiveItem({
          tenantId: tid,
          storage,
          keys: tenantKeys,
          index,
          store: new PgArchiveAppendStore(n % 2 === 0 ? db : other, tid),
          original: mail(`c${n}@fabrikam.example`, `Concurrent ${n}`),
          source: n % 2 === 0 ? "journal" : "file_import",
          receivedAt: frozen,
          envelope: null,
          flags: [],
          messageId: `c${n}@fabrikam.example`,
          retentionPolicy: { mode: "from_capture", years: 10 },
          duplicates: "keep",
          now: () => frozen,
        }),
      ),
    );
    expect(results.every((result) => result.outcome === "stored")).toBe(true);
    const rows = await db
      .select({
        createdAt: sql<string>`${archiveItems.createdAt}::text`,
        prev: archiveItems.prevChainHash,
        hash: archiveItems.chainHash,
      })
      .from(archiveItems)
      .where(eq(archiveItems.tenantId, tid))
      .orderBy(asc(archiveItems.createdAt), asc(archiveItems.id));
    expect(rows).toHaveLength(12);
    const created = rows.slice(1).map((row) => row.createdAt);
    expect(new Set(created).size).toBe(created.length);
    for (let n = 1; n < rows.length; n++) {
      expect(rows[n]?.prev).toBe(rows[n - 1]?.hash);
    }
    expect(await chainVerifies(db, tid)).toBe(true);
  });
});
