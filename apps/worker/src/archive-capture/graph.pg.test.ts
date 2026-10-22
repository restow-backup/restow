/**
 * The Graph capture way against Postgres and a fake Graph mailbox (no tenant): activation
 * with a subscription first (immutable ids, clientState only hashed), notifications
 * drained (drafts skipped, a vanished mail triggers the catch-up), poll-only mode without a
 * public HTTPS URL, renewal before expiry, the lifecycle events (reauthorization, removal,
 * missed), a changed Entra app, release of a stream no job wants, and the backfill job
 * (paged, resumable, mail received before activation flagged `captured-late`).
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server (a database named
 * `restow_worker_graph_capture_test` is recreated there and dropped after).
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ArchiveJobPayload,
  type Cursor,
  generateDek,
  hashClientState,
  IMMUTABLE_ID_PREFER,
  Keyring,
  LocalStorageBackend,
  MemoryChunkIndex,
  type StorageTargets,
  type TenantKeyring,
} from "@restow/core";
import {
  archiveCaptureStreams,
  archiveItems,
  backupJobMembers,
  backupJobs,
  createDb,
  type Database,
  graphSubscriptions,
  protectedObjects,
  providers,
  sources,
  tenants,
} from "@restow/db";
import { runMigrations } from "@restow/db/migrate";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeMailboxGraph } from "../../../../packages/core/src/graph/testing/fake-mailbox.js";
import type { WorkerFeatureGate } from "../extensions.js";
import { archiveHandler, configureArchiveHandler } from "../handlers/archive.js";
import { TenantCache, type WorkerJobContext } from "../handlers/framework.js";
import { dropTestDatabase } from "../testing/database.js";
import {
  createGraphCaptureWay,
  type GraphWayDeps,
  type NotificationTarget,
  notificationTarget,
  SubscriptionBatcher,
} from "./graph.js";
import { ArchiveCaptureService } from "./service.js";
import type { CaptureWay } from "./ways.js";

const adminUrl = process.env.RESTOW_TEST_DATABASE_URL;
const TEST_DB = "restow_worker_graph_capture_test";

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
const PUBLIC = notificationTarget("https://restow.example.com");
const USER = "user-anna";

const FOLDERS = [
  { id: "inbox", displayName: "Inbox", wellKnownName: "inbox" },
  { id: "sent", displayName: "Sent Items", wellKnownName: "sentitems" },
  { id: "drafts", displayName: "Drafts", wellKnownName: "drafts" },
];

describe.skipIf(!adminUrl)("graph capture way (Postgres)", () => {
  let db: Database;
  let tenantId: string;
  let sourceId: string;
  let objectId: string;
  let dir: string;
  let storage: StorageTargets;
  let keys: TenantKeyring;
  let fake: FakeMailboxGraph;
  let target: NotificationTarget;
  let fingerprint: string;
  const hour = 3_600_000;

  beforeAll(async () => {
    const admin = createDb(adminUrl as string);
    await admin.$client.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await admin.$client.query(`CREATE DATABASE ${TEST_DB}`);
    await admin.$client.end();
    const url = new URL(adminUrl as string);
    url.pathname = `/${TEST_DB}`;
    await runMigrations(url.toString());
    db = createDb(url.toString());
    const [provider] = await db.insert(providers).values({ name: "Provider" }).returning();
    const [tenant] = await db
      .insert(tenants)
      .values({ providerId: provider?.id ?? "", name: "Contoso", slug: "contoso" })
      .returning();
    tenantId = tenant?.id ?? "";
    const [source] = await db
      .insert(sources)
      .values({
        tenantId,
        kind: "m365",
        name: "Contoso 365",
        status: "active",
        entraTenantId: "contoso-entra",
      })
      .returning();
    sourceId = source?.id ?? "";
    dir = await mkdtemp(join(tmpdir(), "restow-graph-capture-"));
    storage = { primary: new LocalStorageBackend(dir), copies: [] };
    keys = new Keyring(tenantId, [generateDek(1)]);
  }, 60_000);

  afterAll(async () => {
    await db?.$client.end();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
    if (adminUrl) {
      await dropTestDatabase(adminUrl, TEST_DB);
    }
  });

  beforeEach(async () => {
    await db.execute(sql`delete from graph_subscriptions`);
    await db.execute(sql`delete from archive_capture_pending`);
    await db.execute(sql`delete from archive_capture_streams`);
    await db.execute(sql`delete from backup_job_members`);
    await db.execute(sql`delete from backup_jobs`);
    const [object] = await db
      .insert(protectedObjects)
      .values({ tenantId, sourceId, kind: "mailbox", externalId: `${USER}-${randomUUID()}` })
      .returning();
    objectId = object?.id ?? "";
    const [job] = await db
      .insert(backupJobs)
      .values({ tenantId, kind: "mail", name: `Mail ${randomUUID()}`, archive: true })
      .returning();
    await db
      .insert(backupJobMembers)
      .values({ tenantId, jobId: job?.id ?? "", protectedObjectId: objectId });
    const now = Date.now();
    fake = new FakeMailboxGraph();
    fake.addMailbox(object?.externalId ?? "", FOLDERS, [
      {
        id: "old-1",
        folderId: "inbox",
        receivedDateTime: new Date(now - 30 * 24 * hour).toISOString(),
      },
      { id: "new-1", folderId: "inbox", receivedDateTime: new Date(now + hour).toISOString() },
      { id: "draft-1", folderId: "drafts", isDraft: true },
    ]);
    target = PUBLIC;
    fingerprint = "app-1";
  });

  function way(overrides: Partial<GraphWayDeps> = {}): CaptureWay {
    return createGraphCaptureWay({
      access: async (ctx) => {
        const [object] = await db
          .select({ externalId: protectedObjects.externalId })
          .from(protectedObjects)
          .where(eq(protectedObjects.id, ctx.stream.protectedObjectId));
        return {
          client: fake.client({ signal: ctx.signal }),
          userId: object?.externalId ?? "",
          entraTenantId: "contoso-entra",
          appFingerprint: fingerprint,
        };
      },
      notificationTarget: async () => target,
      batcher: new SubscriptionBatcher({ windowMs: 0, minIntervalMs: 0 }),
      ...overrides,
    });
  }

  function service(graph: CaptureWay) {
    const backfills: string[] = [];
    const instance = new ArchiveCaptureService({
      db,
      providerDb: db,
      keyrings: new TenantCache(async () => keys),
      storage: new TenantCache(async () => storage),
      logger: silent,
      gate: open,
      ways: { graph_sync: graph },
      settings: { gateCheckMs: 0, reconcileMs: 0, leaseMs: 60_000 },
      enqueueBackfill: async (stream) => {
        backfills.push(stream.protectedObjectId);
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

  async function stream() {
    const [row] = await db
      .select()
      .from(archiveCaptureStreams)
      .where(eq(archiveCaptureStreams.protectedObjectId, objectId));
    return row;
  }

  async function streamState(): Promise<{ lastCatchUpAt?: string; forceCatchUp?: boolean }> {
    return ((await stream())?.state ?? {}) as { lastCatchUpAt?: string; forceCatchUp?: boolean };
  }

  async function subscriptionRows() {
    return db
      .select()
      .from(graphSubscriptions)
      .where(eq(graphSubscriptions.protectedObjectId, objectId));
  }

  /** What the mailbox captured: its own items, and capture rows on items another one holds. */
  async function itemRefs(): Promise<string[]> {
    const result = await db.execute<{ ref: string }>(sql`
      select external_ref as ref from archive_items where protected_object_id = ${objectId}
      union
      select external_ref from archive_item_captures where protected_object_id = ${objectId}
    `);
    return result.rows.map((row) => row.ref).sort();
  }

  it("activates with a subscription first, then captures new mail; old mail is the backfill's", async () => {
    const { instance, backfills } = service(way());
    await pass(instance);
    const row = await stream();
    expect(row?.failure).toBeNull();
    expect(row?.status).toBe("backfilling");
    expect(row?.state).toMatchObject({ _mode: "notifications", _pollReason: null });
    expect(backfills).toEqual([objectId]);

    const [subscription] = await subscriptionRows();
    expect(subscription?.status).toBe("active");
    const atGraph = fake.subscriptions.get(subscription?.subscriptionId ?? "");
    expect(atGraph?.prefer).toBe(IMMUTABLE_ID_PREFER);
    expect(atGraph?.notificationUrl).toBe(
      "https://restow.example.com/api/v1/hooks/graph/notifications",
    );
    expect(atGraph?.lifecycleNotificationUrl).toBe(
      "https://restow.example.com/api/v1/hooks/graph/lifecycle",
    );
    // Only the hash of the clientState is stored.
    expect(subscription?.clientStateHash).toBe(hashClientState(atGraph?.clientState ?? ""));
    expect(JSON.stringify(row?.state)).not.toContain(atGraph?.clientState ?? "x");
    // The next pass no later than the renewal (a day before expiry).
    expect(row?.nextDueAt?.getTime()).toBeLessThanOrEqual(
      (subscription?.expiresAt.getTime() ?? 0) - 24 * hour,
    );
    // The first catch-up took the new mail, left the old one to the backfill, not the draft.
    expect(await itemRefs()).toEqual(["new-1"]);
  });

  it("drains notified mail: drafts skipped, a vanished mail makes the catch-up run", async () => {
    const { instance } = service(way());
    await pass(instance);
    fake.addMessage(fake.mailboxes.keys().next().value as string, {
      id: "notified-1",
      folderId: "inbox",
      receivedDateTime: new Date(Date.now() + 2 * hour).toISOString(),
    });
    await db.execute(sql`
      insert into archive_capture_pending (tenant_id, protected_object_id, way, external_ref)
      values (${tenantId}, ${objectId}, 'graph_sync', 'notified-1'),
             (${tenantId}, ${objectId}, 'graph_sync', 'draft-1'),
             (${tenantId}, ${objectId}, 'graph_sync', 'vanished')
    `);
    const before = await streamState();
    await pass(instance);
    expect(await itemRefs()).toEqual(["new-1", "notified-1"]);
    const pending = await db.execute(sql`select count(*)::int as n from archive_capture_pending`);
    expect((pending.rows[0] as { n: number }).n).toBe(0);
    const after = await streamState();
    expect(after.lastCatchUpAt).not.toBe(before.lastCatchUpAt);
    expect(after.forceCatchUp).toBeUndefined();
  });

  it("polls without a public HTTPS URL and says why; a subscription is removed then", async () => {
    const { instance } = service(way());
    await pass(instance);
    expect((await subscriptionRows())[0]?.status).toBe("active");

    target = notificationTarget("http://192.168.1.10:8080");
    await pass(instance);
    const row = await stream();
    expect(row?.state).toMatchObject({
      _mode: "poll",
      _pollReason: "graph.notification_url_unavailable",
    });
    expect((await subscriptionRows()).every((s) => s.status === "removed")).toBe(true);
    expect(fake.subscriptions.size).toBe(0);
    // Polling: the next catch-up within the poll interval.
    expect(row?.nextDueAt?.getTime()).toBeLessThanOrEqual(Date.now() + 16 * 60_000);
  });

  it("falls back to polling when Graph refuses the subscription and retries later", async () => {
    fake.failNext("/subscriptions", 403);
    const { instance } = service(way());
    await pass(instance);
    const row = await stream();
    expect(row?.status).toBe("backfilling");
    expect(row?.state).toMatchObject({ _mode: "poll", _pollReason: "graph.subscription_failed" });
    expect(await subscriptionRows()).toEqual([]);
    // Not retried on the next pass, only after the retry time.
    await pass(instance);
    expect(fake.subscriptions.size).toBe(0);
    await db
      .update(archiveCaptureStreams)
      .set({
        state: sql`${archiveCaptureStreams.state} || '{"subscriptionRetryAt": "2000-01-01T00:00:00Z"}'::jsonb`,
      })
      .where(eq(archiveCaptureStreams.protectedObjectId, objectId));
    await pass(instance);
    expect(fake.subscriptions.size).toBe(1);
    expect((await stream())?.state).toMatchObject({ _mode: "notifications" });
  });

  it("renews a subscription with less than a day left through $batch", async () => {
    const { instance } = service(way());
    await pass(instance);
    const [subscription] = await subscriptionRows();
    await db
      .update(graphSubscriptions)
      .set({ expiresAt: new Date(Date.now() + 2 * hour) })
      .where(eq(graphSubscriptions.id, subscription?.id ?? ""));
    const batches = fake.graph.callsTo("POST", "/$batch").length;
    await pass(instance);
    const [renewed] = await subscriptionRows();
    expect(renewed?.subscriptionId).toBe(subscription?.subscriptionId);
    expect(renewed?.expiresAt.getTime()).toBeGreaterThan(Date.now() + 2 * 24 * hour);
    const patch = fake.graph
      .callsTo("POST", "/$batch")
      .slice(batches)
      .some((call) =>
        (call.json as { requests: Array<{ method: string }> }).requests.some(
          (r) => r.method === "PATCH",
        ),
      );
    expect(patch).toBe(true);
  });

  it("answers the lifecycle events: reauthorize, recreate after removal, catch up after missed", async () => {
    const { instance } = service(way());
    await pass(instance);
    const [first] = await subscriptionRows();

    await db
      .update(graphSubscriptions)
      .set({ status: "reauthorization_required", lastLifecycleEvent: "reauthorizationRequired" })
      .where(eq(graphSubscriptions.id, first?.id ?? ""));
    await pass(instance);
    expect(fake.graph.callsTo("POST", "/reauthorize")).toHaveLength(1);
    expect((await subscriptionRows())[0]?.status).toBe("active");

    await db
      .update(graphSubscriptions)
      .set({ lastLifecycleEvent: "missed", updatedAt: new Date(Date.now() - 1000) })
      .where(eq(graphSubscriptions.id, first?.id ?? ""));
    const before = (await streamState()).lastCatchUpAt;
    await pass(instance);
    expect((await streamState()).lastCatchUpAt).not.toBe(before);
    expect((await subscriptionRows())[0]?.lastLifecycleEvent).toBe("missed_handled");

    await db
      .update(graphSubscriptions)
      .set({ status: "removed", lastLifecycleEvent: "subscriptionRemoved" })
      .where(eq(graphSubscriptions.id, first?.id ?? ""));
    fake.subscriptions.clear();
    await pass(instance);
    const rows = await subscriptionRows();
    expect(rows.filter((r) => r.status === "active")).toHaveLength(1);
    expect(rows.find((r) => r.status === "active")?.subscriptionId).not.toBe(first?.subscriptionId);
  });

  it("moves the subscription to a changed Entra app", async () => {
    const { instance } = service(way());
    await pass(instance);
    const [first] = await subscriptionRows();
    fingerprint = "app-2";
    await pass(instance);
    const rows = await subscriptionRows();
    const active = rows.filter((r) => r.status === "active");
    expect(active).toHaveLength(1);
    expect(active[0]?.subscriptionId).not.toBe(first?.subscriptionId);
    expect(rows.find((r) => r.id === first?.id)?.lastLifecycleEvent).toBe("app_changed");
    expect(fake.subscriptions.has(first?.subscriptionId ?? "")).toBe(false);
    expect((await stream())?.state).toMatchObject({ subscription: { appFingerprint: "app-2" } });
  });

  it("removes the subscription of a stream no job wants any more", async () => {
    const { instance } = service(way());
    await pass(instance);
    expect(fake.subscriptions.size).toBe(1);
    await db.update(backupJobs).set({ archive: false });
    await pass(instance);
    expect((await stream())?.status).toBe("disabled");
    expect(fake.subscriptions.size).toBe(0);
    expect((await subscriptionRows()).every((r) => r.status === "removed")).toBe(true);
  });

  it("runs the backfill: paged, resumable, older mail flagged captured-late", async () => {
    const { instance } = service(way());
    await pass(instance);
    let saved: Cursor | null = null;
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
        load: async () => saved,
        save: async (cursor: Cursor) => {
          saved = cursor;
        },
        clear: async () => {
          saved = null;
        },
      },
      progress: { phase: () => {}, advance: () => {} },
    } as unknown as WorkerJobContext;
    const payload: ArchiveJobPayload = {
      jobId: randomUUID(),
      tenantId,
      protectedObjectId: objectId,
      capture: "graph_sync",
      mode: "backfill",
    };
    configureArchiveHandler({ providerDb: db, gate: open, ways: { graph_sync: way() } });
    try {
      expect(await archiveHandler.run(ctx, payload)).toMatchObject({
        summary: { status: "completed", captured: 1, skipped: 1 },
      });
    } finally {
      configureArchiveHandler(null);
    }
    expect((await stream())?.status).toBe("live");
    // Each test's mailbox holds the same mails; the first archived "old-1" as an item.
    const [old] = await db
      .select()
      .from(archiveItems)
      .where(and(eq(archiveItems.tenantId, tenantId), eq(archiveItems.externalRef, "old-1")));
    expect(old?.flags).toContain("captured-late");
    expect(await itemRefs()).toEqual(["new-1", "old-1"]);
    expect(fake.prefer.every((p) => p.includes(IMMUTABLE_ID_PREFER))).toBe(true);
  });
});
