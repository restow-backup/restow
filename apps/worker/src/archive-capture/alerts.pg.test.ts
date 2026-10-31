/**
 * The alerts of the archive capture against Postgres (./alerts.ts): a stream in `error` for
 * more than an hour, forwarding and journaling silent for 24 hours after they received, each
 * raised once per stream or address and stretch; and `_errorSince` kept by the stream store.
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server (a database named
 * `restow_worker_archive_alerts_test` is recreated there and dropped after).
 */
import { createHash, randomUUID } from "node:crypto";
import {
  archiveCaptureStreams,
  archiveForwardAddresses,
  archiveItemCaptures,
  archiveItems,
  backupJobMembers,
  backupJobs,
  createDb,
  type Database,
  notifications,
  protectedObjects,
  providers,
  sources,
  tenants,
} from "@restow/db";
import { runMigrations } from "@restow/db/migrate";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { dropTestDatabase } from "../testing/database.js";
import { alertArchiveCapture } from "./alerts.js";
import { PgStreamStore } from "./streams.js";

const adminUrl = process.env.RESTOW_TEST_DATABASE_URL;
const TEST_DB = "restow_worker_archive_alerts_test";
const HOUR = 60 * 60 * 1000;

async function withAdmin(base: string, statement: string): Promise<void> {
  const admin = createDb(base);
  try {
    await admin.$client.query(statement);
  } finally {
    await admin.$client.end();
  }
}

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

describe.skipIf(!adminUrl)("archive capture alerts (Postgres)", () => {
  let db: Database;
  let tenantId: string;
  let otherTenantId: string;
  let imapSourceId: string;
  let jobId: string;

  beforeAll(async () => {
    await withAdmin(adminUrl as string, `DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await withAdmin(adminUrl as string, `CREATE DATABASE ${TEST_DB}`);
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
    const [other] = await db
      .insert(tenants)
      .values({ providerId: provider?.id ?? "", name: "Fabrikam", slug: "fabrikam" })
      .returning();
    otherTenantId = other?.id ?? "";
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
  }, 60_000);

  afterAll(async () => {
    await db?.$client.end();
    if (adminUrl) {
      await dropTestDatabase(adminUrl, TEST_DB);
    }
  });

  beforeEach(async () => {
    await db.execute(sql`delete from notifications`);
    await db.execute(sql`delete from archive_capture_streams`);
    await db.execute(sql`delete from archive_forward_addresses`);
    await db.execute(sql`delete from backup_job_members`);
    await db.execute(sql`delete from backup_jobs`);
    await db.execute(sql`update tenants set journal_token = null`);
    const [job] = await db
      .insert(backupJobs)
      .values({
        tenantId,
        kind: "mail",
        name: `Mail ${randomUUID()}`,
        archive: true,
        archiveCapture: { imap: { sync: true, forward: true } },
      })
      .returning();
    jobId = job?.id ?? "";
  });

  const deps = () => ({ db, providerDb: db });

  async function imapObject(login: string): Promise<string> {
    const [object] = await db
      .insert(protectedObjects)
      .values({ tenantId, sourceId: imapSourceId, kind: "imap", externalId: login })
      .returning();
    await db.insert(backupJobMembers).values({ tenantId, jobId, protectedObjectId: object?.id });
    return object?.id ?? "";
  }

  async function item(
    tenant: string,
    via: "smtp_forward" | "journal",
    receivedAt: Date,
    objectId: string | null = null,
  ): Promise<string> {
    const key = randomUUID();
    const [row] = await db
      .insert(archiveItems)
      .values({
        tenantId: tenant,
        protectedObjectId: objectId,
        messageId: `<${key}@example.net>`,
        itemHash: hash(key),
        chainHash: hash(`chain-${key}`),
        receivedAt,
        capturedVia: via,
        storagePath: `archive/${key}`,
      })
      .returning();
    return row?.id ?? "";
  }

  async function alerts(reason: string) {
    const rows = await db
      .select({ details: notifications.details, tenantId: notifications.tenantId })
      .from(notifications)
      .where(eq(notifications.event, "archive.failed"));
    return rows.filter((row) => row.details?.reason === reason);
  }

  async function stream(objectId: string, state: Record<string, unknown>, status = "error") {
    const [row] = await db
      .insert(archiveCaptureStreams)
      .values({
        tenantId,
        protectedObjectId: objectId,
        sourceId: imapSourceId,
        way: "imap_sync",
        status: status as "error",
        state,
        consecutiveFailures: 5,
        failure: {
          v: 1,
          code: "imap.auth_failed",
          transient: false,
          params: {},
          technical: {},
          occurredAt: new Date().toISOString(),
          step: "catch_up",
          retry: null,
        },
      })
      .returning();
    return row?.id ?? "";
  }

  it("raises a stream in error for more than an hour once per error stretch", async () => {
    const long = await imapObject(`long-${randomUUID()}@example.net`);
    const short = await imapObject(`short-${randomUUID()}@example.net`);
    const live = await imapObject(`live-${randomUUID()}@example.net`);
    const longStream = await stream(long, {
      _errorSince: new Date(Date.now() - 2 * HOUR).toISOString(),
    });
    await stream(short, { _errorSince: new Date(Date.now() - 10 * 60_000).toISOString() });
    await stream(live, {}, "live");

    expect(await alertArchiveCapture(deps(), new Date())).toBe(1);
    const [raised] = await alerts("capture_error");
    expect(raised?.details).toMatchObject({
      protectedObjectId: long,
      captureStreamId: longStream,
      captureWay: "imap_sync",
      queue: "archive",
      failure: { code: "imap.auth_failed" },
    });
    // Once per stretch.
    expect(await alertArchiveCapture(deps(), new Date())).toBe(0);

    // The stream worked again and failed anew: a new stretch, announced once more.
    await db
      .update(archiveCaptureStreams)
      .set({ state: { _errorSince: new Date(Date.now() + 60_000).toISOString() } })
      .where(eq(archiveCaptureStreams.id, longStream));
    // Two hours on, the short error is past its hour as well.
    expect(await alertArchiveCapture(deps(), new Date(Date.now() + 2 * HOUR))).toBe(2);
    expect(await alerts("capture_error")).toHaveLength(3);
  });

  it("keeps _errorSince while a stream stays in error and drops it after a good pass", async () => {
    const objectId = await imapObject(`since-${randomUUID()}@example.net`);
    const id = await stream(objectId, { folders: {} }, "live");
    const store = new PgStreamStore(db);
    const lease = () =>
      db
        .update(archiveCaptureStreams)
        .set({ leaseOwner: "w1", leaseUntil: new Date(Date.now() + HOUR) })
        .where(eq(archiveCaptureStreams.id, id));
    const pass = (status: "error" | "live") => ({
      state: { folders: {} },
      status,
      nextDueAt: new Date(),
      passStartedAt: new Date(),
      captured: 0,
      failure: null,
    });
    const stateOf = async () =>
      (
        await db
          .select({ state: archiveCaptureStreams.state })
          .from(archiveCaptureStreams)
          .where(eq(archiveCaptureStreams.id, id))
      )[0]?.state as Record<string, unknown>;

    await lease();
    expect(await store.complete("w1", id, pass("error"))).toBe(true);
    const first = (await stateOf())._errorSince;
    expect(typeof first).toBe("string");
    expect(Number.isNaN(new Date(first as string).getTime())).toBe(false);
    expect((await stateOf()).folders).toEqual({});

    await lease();
    await store.complete("w1", id, { ...pass("error"), state: await stateOf() });
    expect((await stateOf())._errorSince).toBe(first);

    await lease();
    await store.complete("w1", id, { ...pass("live"), state: await stateOf() });
    expect((await stateOf())._errorSince).toBeUndefined();
  });

  it("keeps a stream made due and a resync asked for while its pass ran, instead of what the pass writes", async () => {
    const objectId = await imapObject(`due-${randomUUID()}@example.net`);
    const id = await stream(objectId, { folders: {} }, "live");
    const store = new PgStreamStore(db);
    const dueOf = async () =>
      (
        await db
          .select({ nextDueAt: archiveCaptureStreams.nextDueAt })
          .from(archiveCaptureStreams)
          .where(eq(archiveCaptureStreams.id, id))
      )[0]?.nextDueAt ?? null;
    // Due long ago, so this stream is the one claimed first.
    const claim = async () => {
      await db
        .update(archiveCaptureStreams)
        .set({
          nextDueAt: new Date("2000-01-01T00:00:00.000Z"),
          leaseOwner: null,
          leaseUntil: null,
        })
        .where(eq(archiveCaptureStreams.id, id));
      const claimed = await store.claimDue({
        owner: "w2",
        limit: 1,
        leaseMs: HOUR,
        ways: ["imap_sync"],
      });
      expect(claimed.map((row) => row.id)).toEqual([id]);
    };
    const later = () => new Date(Date.now() + 30 * 60_000);
    const pass = (nextDueAt: Date) => ({
      state: { folders: {} },
      status: "live" as const,
      nextDueAt,
      passStartedAt: new Date(),
      captured: 0,
      failure: null,
    });

    const resyncOf = async () =>
      (
        (
          await db
            .select({ state: archiveCaptureStreams.state })
            .from(archiveCaptureStreams)
            .where(eq(archiveCaptureStreams.id, id))
        )[0]?.state as Record<string, unknown> | undefined
      )?.resyncRequestedAt;

    // The IDLE manager takes the account over while the pass runs: its request stays.
    await claim();
    await store.markDue([id]);
    const marked = await dueOf();
    expect(await store.complete("w2", id, pass(later()))).toBe(true);
    expect(await dueOf()).toEqual(marked);
    expect((await dueOf())?.getTime()).toBeLessThanOrEqual(Date.now());

    // A resync asked for while the pass runs (as the api does it) survives a checkpoint and
    // the end of the pass, whose state was read before it.
    await claim();
    await db.execute(sql`
      update archive_capture_streams
         set dirty_since = coalesce(dirty_since, now()), next_due_at = now(),
             state = state || jsonb_build_object('resyncRequestedAt', now()::text)
       where id = ${id}::uuid
    `);
    const asked = await resyncOf();
    expect(typeof asked).toBe("string");
    expect(await store.checkpoint("w2", id, { folders: {} })).toBe(true);
    expect(await resyncOf()).toBe(asked);
    expect(await store.complete("w2", id, pass(later()))).toBe(true);
    expect(await resyncOf()).toBe(asked);

    // The next pass takes the request (claimed with it) and does not get it back.
    await claim();
    expect(await store.complete("w2", id, pass(later()))).toBe(true);
    expect(await resyncOf()).toBeUndefined();

    // Nobody asked for it meanwhile: the pass's own next time.
    await claim();
    const next = later();
    expect(await store.complete("w2", id, pass(next))).toBe(true);
    expect(await dueOf()).toEqual(next);
  });

  it("raises forwarding silent for 24 hours after it received, once per address and stretch", async () => {
    const quiet = await imapObject(`quiet-${randomUUID()}@example.net`);
    const busy = await imapObject(`busy-${randomUUID()}@example.net`);
    const never = await imapObject(`never-${randomUUID()}@example.net`);
    const rotated = await imapObject(`rotated-${randomUUID()}@example.net`);
    const threeDaysAgo = new Date(Date.now() - 72 * HOUR);
    const [address] = await db
      .insert(archiveForwardAddresses)
      .values({ tenantId, protectedObjectId: quiet, token: randomUUID(), createdAt: threeDaysAgo })
      .returning();
    for (const objectId of [busy, never]) {
      await db.insert(archiveForwardAddresses).values({
        tenantId,
        protectedObjectId: objectId,
        token: randomUUID(),
        createdAt: threeDaysAgo,
      });
    }
    // Issued after its last copy (rotated): it has not received yet.
    await db
      .insert(archiveForwardAddresses)
      .values({ tenantId, protectedObjectId: rotated, token: randomUUID() });
    await item(tenantId, "smtp_forward", new Date(Date.now() - 30 * HOUR), quiet);
    // A capture row counts as a copy as well.
    const held = await item(tenantId, "smtp_forward", new Date(Date.now() - 40 * HOUR), null);
    await db.insert(archiveItemCaptures).values({
      tenantId,
      archiveItemId: held,
      capturedVia: "smtp_forward",
      protectedObjectId: busy,
      itemHash: hash(randomUUID()),
      receivedAt: new Date(Date.now() - HOUR),
    });
    await item(tenantId, "smtp_forward", new Date(Date.now() - 30 * HOUR), rotated);

    expect(await alertArchiveCapture(deps(), new Date())).toBe(1);
    const [raised] = await alerts("forward_stale");
    expect(raised?.details).toMatchObject({
      protectedObjectId: quiet,
      forwardAddressId: address?.id,
    });
    expect(await alertArchiveCapture(deps(), new Date())).toBe(0);

    // A new copy ends the stretch; silent again for a day, it is announced again.
    await item(tenantId, "smtp_forward", new Date(Date.now() + 60_000), quiet);
    expect(await alertArchiveCapture(deps(), new Date())).toBe(0);
    const later = new Date(Date.now() + 26 * HOUR);
    // `busy` is silent by then as well.
    expect(await alertArchiveCapture(deps(), later)).toBe(2);
    expect(await alertArchiveCapture(deps(), later)).toBe(0);
  });

  it("raises forwarding only while a job wants it, also while the job is paused", async () => {
    const objectId = await imapObject(`paused-${randomUUID()}@example.net`);
    await db.insert(archiveForwardAddresses).values({
      tenantId,
      protectedObjectId: objectId,
      token: randomUUID(),
      createdAt: new Date(Date.now() - 72 * HOUR),
    });
    await item(tenantId, "smtp_forward", new Date(Date.now() - 30 * HOUR), objectId);

    await db
      .update(backupJobs)
      .set({ archiveCapture: { imap: { sync: true, forward: false } } })
      .where(eq(backupJobs.id, jobId));
    expect(await alertArchiveCapture(deps(), new Date())).toBe(0);

    await db
      .update(backupJobs)
      .set({ archiveCapture: { imap: { sync: false, forward: true } }, enabled: false })
      .where(eq(backupJobs.id, jobId));
    expect(await alertArchiveCapture(deps(), new Date())).toBe(1);
  });

  it("raises journaling silent for 24 hours after it received, once per tenant and stretch", async () => {
    await db
      .update(tenants)
      .set({ journalToken: `t${randomUUID().replaceAll("-", "")}` })
      .where(eq(tenants.id, tenantId));
    await db
      .update(tenants)
      .set({ journalToken: `t${randomUUID().replaceAll("-", "")}` })
      .where(eq(tenants.id, otherTenantId));
    await item(tenantId, "journal", new Date(Date.now() - 30 * HOUR));
    // The other tenant receives: no alert there.
    await item(otherTenantId, "journal", new Date(Date.now() - HOUR));

    expect(await alertArchiveCapture(deps(), new Date())).toBe(1);
    const raised = await alerts("journal_stale");
    expect(raised).toHaveLength(1);
    expect(raised[0]?.tenantId).toBe(tenantId);
    expect(await alertArchiveCapture(deps(), new Date())).toBe(0);

    // Without a journal address nothing is expected.
    await db.update(tenants).set({ journalToken: null }).where(eq(tenants.id, otherTenantId));
    expect(await alertArchiveCapture(deps(), new Date(Date.now() + 26 * HOUR))).toBe(0);
    expect(
      await db
        .select({ id: notifications.id })
        .from(notifications)
        .where(and(eq(notifications.tenantId, otherTenantId))),
    ).toHaveLength(0);
  });
});
