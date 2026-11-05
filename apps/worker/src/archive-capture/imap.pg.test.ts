/**
 * The IMAP capture way against Postgres and the in-process IMAP server: activation through
 * the capture service, live capture of new mail only, the backfill job (captured late,
 * resumable), mail the archive already holds for the account is not downloaded, and the
 * IDLE manager (budget per process, two processes share the accounts through advisory
 * locks, new mail marks the stream due, `archiveIdle: "off"` gives the account back).
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server (a database named
 * `restow_worker_archive_imap_test` is recreated there and dropped after).
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ArchiveJobPayload,
  encryptChunk,
  generateDek,
  Keyring,
  LocalStorageBackend,
  MemoryChunkIndex,
  type StorageTargets,
  secretAad,
  type TenantKeyring,
} from "@restow/core";
import {
  archiveCaptureGaps,
  archiveCaptureStreams,
  archiveItems,
  backupJobMembers,
  backupJobs,
  createDb,
  type Database,
  notifications,
  protectedObjects,
  providers,
  secrets,
  sources,
  tenants,
} from "@restow/db";
import { runMigrations } from "@restow/db/migrate";
import { and, eq, isNull, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeImapServer as DistFakeImapServer } from "../../../../packages/core/dist/backup/imap/testing/fake-imap.js";
import { FakeImapServer } from "../../../../packages/core/src/backup/imap/testing/fake-imap.js";
import type { WorkerFeatureGate } from "../extensions.js";
import { archiveHandler, configureArchiveHandler } from "../handlers/archive.js";
import { TenantCache, type WorkerJobContext } from "../handlers/framework.js";
import { dropTestDatabase } from "../testing/database.js";
import { createImapCaptureWay, idleWatched, imapMode } from "./imap.js";
import { ArchiveCaptureService } from "./service.js";
import type { CaptureWayServices } from "./ways.js";

const adminUrl = process.env.RESTOW_TEST_DATABASE_URL;
const TEST_DB = "restow_worker_archive_imap_test";

const silent = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child() {
    return silent;
  },
};

const open: WorkerFeatureGate = { isEnabled: async () => true };

async function withAdmin(base: string, statement: string): Promise<void> {
  const admin = createDb(base);
  try {
    await admin.$client.query(statement);
  } finally {
    await admin.$client.end();
  }
}

function mail(id: string): string {
  return `Message-ID: <${id}>\r\nFrom: bob@example.net\r\nTo: alice@example.net\r\nSubject: ${id}\r\nDate: Mon, 02 Nov 2026 08:00:00 +0000\r\n\r\nBody of ${id}\r\n`;
}

async function until(condition: () => boolean | Promise<boolean>, what: string): Promise<void> {
  // Generous: on a shared CI runner the whole suite runs at once, and a pass of the service
  // loop can wait seconds for its turn. Every wait ends as soon as its condition holds.
  const deadline = Date.now() + 60_000;
  while (!(await condition())) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("imapMode", () => {
  it("names why an account is polled", () => {
    const base = { idleSupported: true, watched: false } as const;
    expect(imapMode({ ...base, archiveIdle: "off" })).toEqual({
      mode: "poll",
      pollReason: "imap.idle_disabled",
    });
    expect(imapMode({ ...base, archiveIdle: "auto", idleSupported: false })).toEqual({
      mode: "poll",
      pollReason: "imap.idle_unsupported",
    });
    expect(imapMode({ ...base, archiveIdle: "auto" })).toEqual({
      mode: "poll",
      pollReason: "imap.idle_budget",
    });
    expect(imapMode({ ...base, archiveIdle: "auto", watched: true })).toEqual({
      mode: "notifications",
    });
  });
});

describe.skipIf(!adminUrl)("IMAP capture way (Postgres)", () => {
  let db: Database;
  let other: Database;
  let tenantId: string;
  let sourceId: string;
  let dir: string;
  let storage: StorageTargets;
  let keys: TenantKeyring;
  let jobId: string;
  let server: FakeImapServer;

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
    keys = new Keyring(tenantId, [generateDek(1)]);
    const secretId = randomUUID();
    const key = keys.current;
    await db.insert(secrets).values({
      id: secretId,
      tenantId,
      kind: "imap_password",
      ciphertext: encryptChunk(key, Buffer.from("pw", "utf8"), secretAad(secretId)).toString(
        "base64",
      ),
      keyVersion: key.version,
    });
    const [source] = await db
      .insert(sources)
      .values({
        tenantId,
        kind: "imap",
        name: "Mail host",
        host: "imap.example.net",
        port: 993,
        security: "tls",
        secretRef: secretId,
        status: "active",
      })
      .returning();
    sourceId = source?.id ?? "";
    dir = await mkdtemp(join(tmpdir(), "restow-imap-capture-"));
    storage = { primary: new LocalStorageBackend(dir), copies: [] };
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
    await db.update(sources).set({ config: {} }).where(eq(sources.id, sourceId));
    const [job] = await db
      .insert(backupJobs)
      .values({ tenantId, kind: "mail", name: `Mail ${randomUUID()}`, archive: true })
      .returning();
    jobId = job?.id ?? "";
    server = new FakeImapServer();
    server.addFolder("INBOX");
    server.addFolder("Sent", { specialUse: "\\Sent" });
    server.addFolder("Drafts", { specialUse: "\\Drafts" });
  });

  async function account(login: string): Promise<string> {
    const [object] = await db
      .insert(protectedObjects)
      .values({ tenantId, sourceId, kind: "imap", externalId: login })
      .returning();
    await db
      .insert(backupJobMembers)
      .values({ tenantId, jobId, protectedObjectId: object?.id ?? "" });
    return object?.id ?? "";
  }

  /** A mail delivered now (INTERNALDATE), with its ENVELOPE Message-ID. */
  function put(folder: string, id: string): void {
    server.folder(folder).add(mail(id), { messageId: `<${id}>`, internalDate: new Date() });
  }

  function captureService(way: ReturnType<typeof createImapCaptureWay>) {
    const backfills: string[] = [];
    const instance = new ArchiveCaptureService({
      db,
      providerDb: db,
      keyrings: new TenantCache(async () => keys),
      storage: new TenantCache(async () => storage),
      logger: silent,
      gate: open,
      ways: { imap_sync: way },
      settings: { gateCheckMs: 0, reconcileMs: 0, leaseMs: 60_000 },
      enqueueBackfill: async (stream) => {
        // The backfill job may start at once: activation and state are stored already.
        const [row] = await db
          .select()
          .from(archiveCaptureStreams)
          .where(eq(archiveCaptureStreams.id, stream.id));
        if (row?.activatedAt && row.status === "backfilling" && row.state.folders) {
          backfills.push(stream.protectedObjectId);
        }
        return randomUUID();
      },
    });
    return { instance, backfills };
  }

  async function pass(instance: ArchiveCaptureService): Promise<void> {
    await db.update(archiveCaptureStreams).set({ nextDueAt: new Date(0) });
    await instance.tick();
    await instance.settle();
  }

  async function itemsOf(objectId: string) {
    return db
      .select()
      .from(archiveItems)
      .where(eq(archiveItems.protectedObjectId, objectId))
      .orderBy(archiveItems.createdAt);
  }

  it("activates at the current mail, captures new mail live and the rest by backfill", async () => {
    const object = await account("alice@example.net");
    const old = { internalDate: new Date("2025-06-01T08:00:00Z") };
    server.folder("INBOX").add(mail("old-1@example.net"), old);
    server.folder("INBOX").add(mail("old-2@example.net"), old);
    server.folder("Sent").add(mail("old-sent@example.net"), old);
    server.folder("Drafts").add(mail("draft@example.net"), old);
    const way = createImapCaptureWay({ connector: server, env: {} });
    const { instance, backfills } = captureService(way);

    await instance.tick();
    await instance.settle();
    let [stream] = await db.select().from(archiveCaptureStreams);
    expect(stream?.status).toBe("backfilling");
    expect(backfills).toEqual([object]);
    expect(stream?.state).toMatchObject({
      folders: { INBOX: { lastUid: 2, backfillUpTo: 2 }, Sent: { lastUid: 1 } },
      idle: { folder: "INBOX", supported: true },
      _mode: "poll",
      _pollReason: "imap.idle_budget",
    });
    expect(server.logins[0]).toMatchObject({ user: "alice@example.net", password: "pw" });
    expect(await itemsOf(object)).toEqual([]);

    put("INBOX", "new@example.net");
    await pass(instance);
    let items = await itemsOf(object);
    expect(items.map((item) => [item.capturedVia, item.externalRef])).toEqual([
      ["imap_sync", "INBOX;1000;3"],
    ]);
    expect(items[0]?.flags).not.toContain("captured-late");
    [stream] = await db.select().from(archiveCaptureStreams);
    expect(stream?.nextDueAt?.getTime()).toBeGreaterThan(Date.now() + 9 * 60_000);
    expect(server.stats.open).toBe(0);

    // The backfill job takes over the three older mails, flagged captured late; resumable.
    let cursor: Record<string, unknown> | null = null;
    const ctx = {
      db,
      tenantId,
      storage,
      keys,
      chunkIndex: new MemoryChunkIndex(),
      logger: silent,
      signal: new AbortController().signal,
      now: () => new Date(),
      cursor: {
        load: async () => cursor,
        save: async (next: Record<string, unknown>) => {
          cursor = next;
        },
        clear: async () => {
          cursor = null;
        },
      },
    } as unknown as WorkerJobContext;
    const payload: ArchiveJobPayload = {
      jobId: randomUUID(),
      tenantId,
      protectedObjectId: object,
      capture: "imap_sync",
      mode: "backfill",
    };
    configureArchiveHandler({ providerDb: db, gate: open, ways: { imap_sync: way } });
    expect(await archiveHandler.run(ctx, payload)).toMatchObject({
      summary: { status: "completed", captured: 3, skipped: 0 },
    });
    configureArchiveHandler(null);
    items = await itemsOf(object);
    expect(items).toHaveLength(4);
    expect(items.filter((item) => (item.flags ?? []).includes("captured-late"))).toHaveLength(3);
    [stream] = await db.select().from(archiveCaptureStreams);
    expect(stream?.status).toBe("live");
    expect(items.some((item) => item.subject === "draft@example.net")).toBe(false);
  });

  it("resumes a backfill across jobs from the stream's cursor, reading each mail once", async () => {
    const object = await account("hanna@example.net");
    const old = { internalDate: new Date("2025-06-01T08:00:00Z") };
    for (let n = 1; n <= 7; n++) {
      server
        .folder("INBOX")
        .add(mail(`big-${n}@example.net`), { ...old, messageId: `<big-${n}@example.net>` });
    }
    for (let n = 1; n <= 2; n++) {
      server
        .folder("Sent")
        .add(mail(`sent-${n}@example.net`), { ...old, messageId: `<sent-${n}@example.net>` });
    }
    // A budget that runs out after every batch of two: the backfill needs several jobs, and
    // stops inside INBOX (a huge folder) instead of only between folders.
    const way = createImapCaptureWay({
      connector: server,
      env: {},
      settings: { backfillBudgetMs: 1 },
      limits: { metaBatch: 2, maxBatchBytes: 1024 * 1024, maxBatchMessages: 10 },
    });
    const { instance } = captureService(way);
    await instance.tick();
    await instance.settle();
    let clock = Date.now();
    const continued: string[] = [];
    configureArchiveHandler({
      providerDb: db,
      gate: open,
      ways: { imap_sync: way },
      enqueueBackfill: async () => {
        const id = randomUUID();
        continued.push(id);
        return id;
      },
    });
    const statuses: unknown[] = [];
    try {
      for (let job = 0; job < 12; job++) {
        // Every continuation is a new job with an empty cursor of its own.
        let jobCursor: Record<string, unknown> | null = null;
        const ctx = {
          db,
          tenantId,
          storage,
          keys,
          chunkIndex: new MemoryChunkIndex(),
          logger: silent,
          signal: new AbortController().signal,
          now: () => {
            clock += 1;
            return new Date(clock);
          },
          progress: { phase: () => {}, advance: () => {} },
          cursor: {
            load: async () => jobCursor,
            save: async (next: Record<string, unknown>) => {
              jobCursor = next;
            },
            clear: async () => {
              jobCursor = null;
            },
          },
        } as unknown as WorkerJobContext;
        const outcome = await archiveHandler.run(ctx, {
          jobId: randomUUID(),
          tenantId,
          protectedObjectId: object,
          capture: "imap_sync",
          mode: "backfill",
        });
        const status = (outcome as { summary?: { status?: string } } | undefined)?.summary?.status;
        statuses.push(status);
        if (status !== "continued") {
          break;
        }
      }
    } finally {
      configureArchiveHandler(null);
    }
    expect(statuses.at(-1)).toBe("completed");
    expect(statuses.length).toBeGreaterThanOrEqual(3);
    expect(continued).toHaveLength(statuses.length - 1);
    // Each old mail was read (metadata and source) exactly once across all the jobs.
    const delivered = server.stats.sourcesDelivered;
    expect(delivered).toHaveLength(9);
    expect(new Set(delivered).size).toBe(9);
    const meta = server.stats.metaDelivered;
    expect(new Set(meta).size).toBe(meta.length);
    const items = await itemsOf(object);
    expect(items).toHaveLength(9);
    expect(items.every((item) => (item.flags ?? []).includes("captured-late"))).toBe(true);
    const [stream] = await db
      .select()
      .from(archiveCaptureStreams)
      .where(eq(archiveCaptureStreams.protectedObjectId, object));
    expect(stream?.status).toBe("live");
    expect(stream?.backfillCursor).toBeNull();
  });

  it("records a message never delivered and a folder always refused as open gaps, alerted once", async () => {
    const object = await account("ida@example.net");
    // The built core's fake: its NOs are the ImapSessionError the worker's (built) capture
    // knows, so a refused folder is a command-level error, as in production.
    const dist = new DistFakeImapServer();
    dist.addFolder("INBOX");
    dist.addFolder("Sent", { specialUse: "\\Sent" });
    server = dist as unknown as FakeImapServer;
    const way = createImapCaptureWay({ connector: dist, env: {} });
    const { instance } = captureService(way);
    await instance.tick();
    await instance.settle();
    put("INBOX", "never@example.net");
    put("INBOX", "fine@example.net");
    server.faults.omitSource.add("INBOX:1");
    server.faults.openFailures.add("Sent");
    // Three passes an hour apart (an attempt counts at most once an hour, ./gaps.ts).
    for (let n = 0; n < 3; n++) {
      await db.execute(
        sql`update archive_capture_gaps set last_attempt_at = last_attempt_at - interval '1 hour'`,
      );
      await pass(instance);
    }
    const gaps = await db
      .select()
      .from(archiveCaptureGaps)
      .orderBy(archiveCaptureGaps.kind, archiveCaptureGaps.ref);
    expect(gaps.map((gap) => [gap.kind, gap.ref, gap.reason, gap.openedAt !== null])).toEqual([
      ["folder", "Sent", expect.any(String), true],
      ["message", "INBOX;1000;1", "undelivered", true],
    ]);
    // The pass itself succeeds: the stream is live, but not complete (the gaps say so).
    const [stream] = await db.select().from(archiveCaptureStreams);
    expect(stream?.status).toBe("backfilling");
    expect(stream?.consecutiveFailures).toBe(0);
    expect((await itemsOf(object)).map((item) => item.externalRef)).toEqual(["INBOX;1000;2"]);

    const { alertArchiveCapture } = await import("./alerts.js");
    expect(await alertArchiveCapture({ db, providerDb: db }, new Date())).toBe(1);
    const [alert] = await db
      .select()
      .from(notifications)
      .where(eq(notifications.event, "archive.failed"));
    expect(alert?.details).toMatchObject({
      reason: "capture_gap",
      protectedObjectId: object,
      folders: 1,
      messages: 1,
    });
    expect(await alertArchiveCapture({ db, providerDb: db }, new Date())).toBe(0);

    // The folder works again: read, its gap resolved; the message stays open.
    server.faults.openFailures.clear();
    put("Sent", "out@example.net");
    await pass(instance);
    const open = await db
      .select({ ref: archiveCaptureGaps.ref })
      .from(archiveCaptureGaps)
      .where(isNull(archiveCaptureGaps.resolvedAt));
    expect(open.map((gap) => gap.ref)).toEqual(["INBOX;1000;1"]);
    await db.execute(sql`delete from notifications`);
  });

  it("does not download mail the archive already holds for the account", async () => {
    const object = await account("ben@example.net");
    const way = createImapCaptureWay({ connector: server, env: {} });
    const { instance } = captureService(way);
    await instance.tick();
    await instance.settle();
    put("INBOX", "first@example.net");
    await pass(instance);
    // The same mail shows up in another folder (moved, or copied by a filter).
    server.folder("Sent").add(mail("first@example.net"), { messageId: "<first@example.net>" });
    const delivered = server.stats.sourcesDelivered.length;
    await pass(instance);
    expect(server.stats.sourcesDelivered.length).toBe(delivered);
    expect(await itemsOf(object)).toHaveLength(1);
  });

  it("archives a second mail with the same Message-ID and other content, flagged as a conflict", async () => {
    const object = await account("greta@example.net");
    const way = createImapCaptureWay({ connector: server, env: {} });
    const { instance } = captureService(way);
    await instance.tick();
    await instance.settle();
    const ticket = (body: string) =>
      `Message-ID: <ticket-7@helpdesk.example>\r\nFrom: helpdesk@example.org\r\nTo: erik@example.net\r\nSubject: Ticket 7\r\nDate: Mon, 02 Nov 2026 08:00:00 +0000\r\n\r\n${body}\r\n`;
    server
      .folder("INBOX")
      .add(ticket("Status: open"), { messageId: "<ticket-7@helpdesk.example>" });
    await pass(instance);
    // Edited content under the same Message-ID (a ticket system, or a sender reusing it).
    server.folder("INBOX").add(ticket("Status: closed, the refund of 1,200 EUR was paid"), {
      messageId: "<ticket-7@helpdesk.example>",
    });
    await pass(instance);
    const items = await itemsOf(object);
    expect(items.map((item) => item.externalRef)).toEqual(["INBOX;1000;1", "INBOX;1000;2"]);
    expect(items[1]?.flags).toContain("message-id-conflict");
  });

  it("watches accounts with IDLE within the budget, shared by two processes through locks", async () => {
    const first = await account("carla@example.net");
    const second = await account("dora@example.net");
    const settings = { idleMax: 1, refreshMs: 3_600_000, pollMinutes: 5 };
    const way = createImapCaptureWay({ connector: server, env: {}, settings });
    const { instance } = captureService(way);
    await instance.tick();
    await instance.settle();
    expect(
      (await db.select().from(archiveCaptureStreams)).every((row) => row.status === "backfilling"),
    ).toBe(true);

    const due: string[] = [];
    const controller = new AbortController();
    const services = (pool: Database): CaptureWayServices => ({
      db: pool,
      providerDb: pool,
      logger: silent,
      signal: controller.signal,
      markDue: async (ids) => {
        due.push(...ids);
      },
      keyring: async () => keys,
      active: () => true,
    });
    way.start?.(services(db));
    const manager = way.idle();
    expect(manager).not.toBeNull();
    await until(() => (manager?.idling().length ?? 0) === 1, "the first IDLE connection");
    const watchedId = manager?.watching()[0] as string;

    // A second process (its own pool, own lock connection) takes the other account.
    const secondWay = createImapCaptureWay({ connector: server, env: {}, settings });
    secondWay.start?.(services(other));
    const secondManager = secondWay.idle();
    await until(() => (secondManager?.idling().length ?? 0) === 1, "the second IDLE connection");
    expect(
      new Set([...(manager?.watching() ?? []), ...(secondManager?.watching() ?? [])]).size,
    ).toBe(2);
    expect(await idleWatched(db, watchedId)).toBe(true);

    // New mail in INBOX: both watched streams are made due (both accounts share the fake's INBOX).
    put("INBOX", "pushed@example.net");
    await until(() => due.length >= 2, "the streams to be marked due");
    const streamIds = (await db.select().from(archiveCaptureStreams)).map((row) => row.id).sort();
    expect([...new Set(due)].sort()).toEqual(streamIds);

    // A pass of a watched account reports IDLE and comes back only as a safety net.
    await pass(instance);
    const rows = await db.select().from(archiveCaptureStreams);
    for (const row of rows) {
      expect(row.state).toMatchObject({ _mode: "notifications" });
      expect(row.nextDueAt?.getTime()).toBeGreaterThan(Date.now() + 25 * 60_000);
    }

    // IDLE switched off for the source: both processes give the accounts back.
    await db
      .update(sources)
      .set({ config: { archiveIdle: "off" } })
      .where(eq(sources.id, sourceId));
    await manager?.refresh();
    await secondManager?.refresh();
    expect(manager?.watching()).toEqual([]);
    expect(secondManager?.watching()).toEqual([]);
    expect(await idleWatched(db, watchedId)).toBe(false);
    await pass(instance);
    const [polled] = await db
      .select()
      .from(archiveCaptureStreams)
      .where(and(eq(archiveCaptureStreams.protectedObjectId, first)));
    expect(polled?.state).toMatchObject({ _mode: "poll", _pollReason: "imap.idle_disabled" });
    expect(second).toBeTruthy();

    controller.abort();
    await manager?.stop();
    await secondManager?.stop();
    await until(() => server.stats.open === 0, "every IMAP session to close");
  });

  it("retries a watch refused with a NO on EXAMINE soon, not after the day-long no-IDLE backoff", async () => {
    await account("fritz@example.net");
    // The built core's fake: its ImapSessionError is the class the worker's (built)
    // isImapSessionError knows, so the NO is seen as a command-level error, as in production.
    const server = new DistFakeImapServer();
    server.addFolder("INBOX");
    const settings = { idleMax: 1, refreshMs: 20, retryMs: 50 };
    const way = createImapCaptureWay({ connector: server, env: {}, settings });
    const { instance } = captureService(way);
    await instance.tick();
    await instance.settle();
    // The server announces IDLE but refuses EXAMINE of the watched folder for now.
    server.faults.openFailures.add("INBOX");
    const opensBefore = server.stats.opens;
    const controller = new AbortController();
    way.start?.({
      db,
      providerDb: db,
      logger: silent,
      signal: controller.signal,
      markDue: async () => undefined,
      keyring: async () => keys,
      active: () => true,
    });
    const manager = way.idle();
    try {
      await until(() => server.stats.opens > opensBefore, "the refused EXAMINE");
      await until(() => (manager?.watching().length ?? 0) === 0, "the failed watch to end");
      server.faults.openFailures.clear();
      // Retried after retryMs (doubling while it keeps failing), not after 24 hours.
      await until(() => (manager?.idling().length ?? 0) === 1, "the IDLE connection on retry");
    } finally {
      controller.abort();
      await manager?.stop();
      await until(() => server.stats.open === 0, "every IMAP session to close");
    }
  });

  it("shows a watched account as IDLE without waiting for its next scheduled pass (service loop)", async () => {
    // As the worker runs it: the service's own loop starts the IDLE manager with its
    // services (gate, keyrings, installation pool); no pass is forced by the test.
    const object = await account("frida@example.net");
    const way = createImapCaptureWay({
      connector: server,
      env: {},
      settings: { idleMax: 5, refreshMs: 50 },
    });
    const instance = new ArchiveCaptureService({
      db,
      providerDb: db,
      keyrings: new TenantCache(async () => keys),
      storage: new TenantCache(async () => storage),
      logger: silent,
      gate: open,
      ways: { imap_sync: way },
      settings: { gateCheckMs: 0, reconcileMs: 0, leaseMs: 60_000, pollMs: 20 },
      enqueueBackfill: async () => randomUUID(),
    });
    const streamOf = async () =>
      (
        await db
          .select()
          .from(archiveCaptureStreams)
          .where(eq(archiveCaptureStreams.protectedObjectId, object))
      )[0];
    instance.start();
    try {
      // Activated while nobody watches it yet: polled, next pass in 10 minutes.
      await until(
        async () => (await streamOf())?.activatedAt != null,
        "the stream to be activated",
      );
      await until(() => (way.idle()?.idling().length ?? 0) === 1, "the IDLE connection");
      // Once the IDLE manager watches it, a pass records that well before those 10 minutes.
      await until(
        async () => (await streamOf())?.state._mode === "notifications",
        "the stream to show IDLE",
      );
      expect((await streamOf())?.nextDueAt?.getTime()).toBeGreaterThan(Date.now() + 25 * 60_000);

      // New mail arrives through IDLE alone.
      put("INBOX", "idle-live@example.net");
      await until(async () => (await itemsOf(object)).length === 1, "the mail pushed by IDLE");

      // IDLE turned off for the source: the account is given back and shown as polled.
      await db
        .update(sources)
        .set({ config: { archiveIdle: "off" } })
        .where(eq(sources.id, sourceId));
      await until(
        async () => (await streamOf())?.state._pollReason === "imap.idle_disabled",
        "the stream to show polling",
      );
      expect(await idleWatched(db, (await streamOf())?.id as string)).toBe(false);
    } finally {
      await instance.stop();
      await way.idle()?.stop();
    }
    await until(() => server.stats.open === 0, "every IMAP session to close");
  }, 180_000);
});
