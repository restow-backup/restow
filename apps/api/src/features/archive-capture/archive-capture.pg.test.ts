/**
 * The archive capture routes against Postgres, on the application role (Row Level
 * Security): the status per way (gate, streams, modes, counts of items and capture rows,
 * backfill progress), the mailbox list with its cursor, the audited resync (refused while
 * the gate is closed), the hold confirmation (audited) and tenant isolation.
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server as a superuser (the
 * database `restow_api_archive_capture_test` is recreated there and dropped after).
 */
import { randomBytes, randomUUID } from "node:crypto";
import {
  archiveCaptureStreams,
  archiveItemCaptures,
  archiveItems,
  auditLog,
  backupJobMembers,
  backupJobs,
  createDb,
  type Database,
  protectedObjects,
  providers,
  sources,
  tenants,
} from "@restow/db";
import { and, eq } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SessionUser } from "../../auth.js";
import type { TenantEnv } from "../../middleware/session.js";
import { provisionTestRoles, type TestDatabaseRoles } from "../../testing/database-roles.js";
import {
  dropDatabase,
  recreateDatabase,
  testDatabaseAdminUrl,
} from "../snapshots/testing/explorer-fixture.js";

const DATABASE = "restow_api_archive_capture_test";

describe.skipIf(!testDatabaseAdminUrl)("archive capture routes against Postgres", () => {
  let owner: Database;
  let appDb: Database;
  let roles: TestDatabaseRoles | undefined;
  let app: Hono;
  let contoso: string;
  let fabrikam: string;
  let m365: string;
  let mailboxes: string[] = [];
  let gateOpen = true;
  const adminId = randomUUID();

  beforeAll(async () => {
    const url = await recreateDatabase(testDatabaseAdminUrl as string, DATABASE);
    roles = await provisionTestRoles(url);
    process.env.DATABASE_URL = roles.appUrl;
    process.env.DATABASE_PROVIDER_URL = roles.providerUrl;
    process.env.RESTOW_MASTER_KEY = randomBytes(32).toString("base64");
    owner = createDb(url);
    appDb = createDb(roles.appUrl);
    const { buildArchiveCaptureRoutes } = await import("./routes.js");
    const { errorHandler } = await import("../../problem.js");
    const { registerApiExtension } = await import("../../extensions.js");
    registerApiExtension({
      name: "test-gate",
      featureGate: { isEnabled: async () => gateOpen },
    });

    const [provider] = await owner.insert(providers).values({ name: "Provider" }).returning();
    const created = await owner
      .insert(tenants)
      .values([
        { providerId: provider?.id ?? "", name: "Contoso", slug: "contoso" },
        { providerId: provider?.id ?? "", name: "Fabrikam", slug: "fabrikam" },
      ])
      .returning();
    contoso = created[0]?.id ?? "";
    fabrikam = created[1]?.id ?? "";
    const [source] = await owner
      .insert(sources)
      .values({ tenantId: contoso, kind: "m365", name: "Contoso 365", status: "active" })
      .returning();
    m365 = source?.id ?? "";
    const objects = await owner
      .insert(protectedObjects)
      .values(
        ["anna", "ben", "carla"].map((name) => ({
          tenantId: contoso,
          sourceId: m365,
          kind: "mailbox" as const,
          externalId: `${name}@contoso.example`,
          displayName: name,
        })),
      )
      .returning();
    mailboxes = objects.map((object) => object.id);
    const now = Date.now();
    await owner.insert(archiveCaptureStreams).values([
      {
        tenantId: contoso,
        protectedObjectId: mailboxes[0] as string,
        sourceId: m365,
        way: "graph_sync",
        status: "live",
        activatedAt: new Date(now - 86_400_000),
        backfillCompletedAt: new Date(now - 3_600_000),
        state: { _mode: "notifications" },
        nextDueAt: new Date(now + 3_600_000),
      },
      {
        tenantId: contoso,
        protectedObjectId: mailboxes[1] as string,
        sourceId: m365,
        way: "graph_sync",
        status: "backfilling",
        activatedAt: new Date(now - 60_000),
        state: { _mode: "poll", _pollReason: "graph.notification_url_unavailable" },
        nextDueAt: new Date(now + 600_000),
      },
      {
        tenantId: contoso,
        protectedObjectId: mailboxes[2] as string,
        sourceId: m365,
        way: "graph_sync",
        status: "disabled",
        state: {},
      },
    ]);
    const item = async (via: "journal" | "graph_sync", flags: string[] = []) => {
      const [row] = await owner
        .insert(archiveItems)
        .values({
          tenantId: contoso,
          messageId: `<${randomUUID()}@contoso.example>`,
          itemHash: randomUUID(),
          chainHash: randomUUID(),
          receivedAt: new Date(now - 3_600_000),
          capturedVia: via,
          storagePath: `x/${randomUUID()}`,
          flags,
        })
        .returning();
      return row?.id ?? "";
    };
    const journalItem = await item("journal");
    await item("graph_sync");
    await item("graph_sync", ["captured-late"]);
    await owner.insert(archiveItemCaptures).values({
      tenantId: contoso,
      archiveItemId: journalItem,
      capturedVia: "graph_sync",
      protectedObjectId: mailboxes[0] as string,
      itemHash: "other",
      receivedAt: new Date(now - 60_000),
    });

    const tenantAccess: MiddlewareHandler<TenantEnv> = async (c, next) => {
      c.set("tenantId", c.req.header("x-restow-tenant") ?? "");
      c.set("role", "tenant_admin");
      c.set("user", { id: adminId, email: "admin@contoso.example" } as unknown as SessionUser);
      await next();
    };
    app = new Hono();
    app.onError(errorHandler);
    app.route(
      "/archive/capture",
      buildArchiveCaptureRoutes({ db: appDb, requireAdmin: tenantAccess, installation: owner }),
    );
  }, 60_000);

  afterEach(() => {
    gateOpen = true;
  });

  afterAll(async () => {
    const { resetExtensionsForTesting } = await import("../../extensions.js");
    resetExtensionsForTesting();
    const shared = await import("../../db.js");
    await Promise.all([
      shared.db.$client.end(),
      shared.providerDb.$client.end(),
      shared.authDb.$client.end(),
    ]);
    await appDb?.$client.end();
    await owner?.$client.end();
    await dropDatabase(testDatabaseAdminUrl as string, DATABASE);
    if (roles) {
      await roles.drop(testDatabaseAdminUrl as string);
    }
  }, 60_000);

  const as = (tenantId: string) => ({ "x-restow-tenant": tenantId });

  it("reports every way: gate, streams, modes, counts and backfill", async () => {
    const res = await app.request("/archive/capture", { headers: as(contoso) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      mailbox: Record<string, unknown>[];
      smtp: Record<string, unknown>[];
    };
    const graph = body.mailbox.find((way) => way.way === "graph_sync");
    expect(graph).toMatchObject({
      available: true,
      assurance: "mailbox",
      streams: { live: 1, backfilling: 1, disabled: 1, pending: 0, error: 0, paused: 0 },
      modes: { notifications: 1, poll: 1 },
      pollReasons: { "graph.notification_url_unavailable": 1 },
      backfill: { total: 2, completed: 1 },
      items24h: 2,
      items7d: 2,
      captures24h: 1,
      captures7d: 1,
      capturedLate7d: 1,
    });
    expect(body.smtp.find((way) => way.way === "journal")).toMatchObject({
      available: true,
      assurance: "transport",
      items24h: 1,
    });
    expect(body.smtp.find((way) => way.way === "smtp_forward")).toMatchObject({ items7d: 0 });

    gateOpen = false;
    const closed = (await (
      await app.request("/archive/capture", { headers: as(contoso) })
    ).json()) as { mailbox: { available: boolean }[] };
    expect(closed.mailbox.every((way) => way.available === false)).toBe(true);
  });

  it("names the archiving jobs that could capture more: Graph off, or IMAP waiting for a way", async () => {
    const MIGRATED = {
      m365: { graph: false, journal: true },
      imap: { sync: false, forward: false, pending: true as const },
      google: { sync: false, forward: false, pending: true as const },
    };
    const added = await owner
      .insert(sources)
      .values([
        {
          tenantId: contoso,
          kind: "imap",
          name: "Hoster",
          host: "mail.example.net",
          status: "active",
        },
        {
          tenantId: contoso,
          kind: "imap",
          name: "Workspace",
          host: "imap.gmail.com",
          status: "active",
        },
      ])
      .returning();
    const [hoster, workspace] = added.map((source) => source.id);
    const accounts = await owner
      .insert(protectedObjects)
      .values([
        {
          tenantId: contoso,
          sourceId: hoster as string,
          kind: "imap",
          externalId: "info@hoster.example",
        },
        {
          tenantId: contoso,
          sourceId: workspace as string,
          kind: "imap",
          externalId: "team@workspace.example",
        },
      ])
      .returning();
    const [imapAccount] = accounts.map((object) => object.id);
    const jobs = await owner
      .insert(backupJobs)
      .values([
        // From before 0.4.4: Microsoft 365 by journaling, the IMAP account waits for a way.
        {
          tenantId: contoso,
          kind: "mail",
          name: "Migrated",
          archive: true,
          archiveCapture: MIGRATED,
        },
        // Scope all: the mailboxes and the Google account in no other job.
        {
          tenantId: contoso,
          kind: "mail",
          name: "Everything",
          scopeMode: "all",
          archive: true,
          archiveCapture: MIGRATED,
        },
        // Ways chosen after the update, Graph on: nothing to offer.
        { tenantId: contoso, kind: "mail", name: "Chosen", archive: true, archiveCapture: {} },
        // Not archiving: nothing to offer.
        {
          tenantId: contoso,
          kind: "mail",
          name: "Backup only",
          archive: false,
          archiveCapture: MIGRATED,
        },
      ])
      .returning();
    const [migrated, everything, chosen, backupOnly] = jobs.map((job) => job.id as string);
    await owner.insert(backupJobMembers).values([
      { tenantId: contoso, jobId: migrated as string, protectedObjectId: mailboxes[0] as string },
      { tenantId: contoso, jobId: migrated as string, protectedObjectId: imapAccount as string },
      { tenantId: contoso, jobId: chosen as string, protectedObjectId: mailboxes[1] as string },
    ]);
    try {
      const body = (await (
        await app.request("/archive/capture", { headers: as(contoso) })
      ).json()) as { jobs: unknown[] };
      expect(body.jobs).toEqual([
        { jobId: everything, name: "Everything", graphOff: true, pending: ["google"] },
        { jobId: migrated, name: "Migrated", graphOff: true, pending: ["imap"] },
      ]);
      expect(JSON.stringify(body.jobs)).not.toContain(backupOnly as string);
      const other = (await (
        await app.request("/archive/capture", { headers: as(fabrikam) })
      ).json()) as { jobs: unknown[] };
      expect(other.jobs).toEqual([]);
    } finally {
      await owner.delete(backupJobs).where(eq(backupJobs.tenantId, contoso));
      for (const id of [hoster, workspace]) {
        await owner.delete(sources).where(eq(sources.id, id as string));
      }
    }
  });

  it("shows another tenant nothing of it", async () => {
    const body = (await (
      await app.request("/archive/capture/mailboxes", { headers: as(fabrikam) })
    ).json()) as { items: unknown[] };
    expect(body.items).toEqual([]);
    const status = (await (
      await app.request("/archive/capture", { headers: as(fabrikam) })
    ).json()) as { mailbox: { items7d: number; streams: { live: number } }[] };
    expect(status.mailbox.every((way) => way.items7d === 0 && way.streams.live === 0)).toBe(true);
  });

  it("lists the mailboxes with a cursor and filters", async () => {
    const first = (await (
      await app.request("/archive/capture/mailboxes?limit=2", { headers: as(contoso) })
    ).json()) as { items: { streamId: string; displayName: string }[]; nextCursor: string };
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toBe(first.items[1]?.streamId);
    const rest = (await (
      await app.request(`/archive/capture/mailboxes?limit=2&cursor=${first.nextCursor}`, {
        headers: as(contoso),
      })
    ).json()) as { items: unknown[]; nextCursor: string | null };
    expect(rest.items).toHaveLength(1);
    expect(rest.nextCursor).toBeNull();
    const live = (await (
      await app.request("/archive/capture/mailboxes?status=live", { headers: as(contoso) })
    ).json()) as { items: { displayName: string; mode: string }[] };
    expect(live.items).toEqual([
      expect.objectContaining({ displayName: "anna", mode: "notifications" }),
    ]);
    const bad = await app.request("/archive/capture/mailboxes?way=smtp", { headers: as(contoso) });
    expect(bad.status).toBe(422);
  });

  it("requests a resync, audited, and refuses it while the gate is closed", async () => {
    const res = await app.request(`/archive/capture/mailboxes/${mailboxes[0]}/resync`, {
      method: "POST",
      headers: as(contoso),
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ streams: 1 });
    const [stream] = await owner
      .select()
      .from(archiveCaptureStreams)
      .where(eq(archiveCaptureStreams.protectedObjectId, mailboxes[0] as string));
    expect(stream?.state).toHaveProperty("resyncRequestedAt");
    expect(stream?.dirtySince).not.toBeNull();
    const entries = await owner
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, contoso),
          eq(auditLog.action, "archive.capture.resync_requested"),
        ),
      );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.target).toBe(mailboxes[0]);

    // A disabled stream has nothing to resync.
    const none = await app.request(`/archive/capture/mailboxes/${mailboxes[2]}/resync`, {
      method: "POST",
      headers: as(contoso),
    });
    expect(none.status).toBe(404);
    // Another tenant cannot reach the mailbox.
    const foreign = await app.request(`/archive/capture/mailboxes/${mailboxes[0]}/resync`, {
      method: "POST",
      headers: as(fabrikam),
    });
    expect(foreign.status).toBe(404);

    gateOpen = false;
    const refused = await app.request(`/archive/capture/mailboxes/${mailboxes[0]}/resync`, {
      method: "POST",
      headers: as(contoso),
    });
    expect(refused.status).toBe(403);
  });

  it("confirms and withdraws the hold of a Microsoft 365 source, audited", async () => {
    const before = (await (
      await app.request("/archive/capture/holds", { headers: as(contoso) })
    ).json()) as { items: unknown[] };
    expect(before.items).toEqual([
      {
        sourceId: m365,
        name: "Contoso 365",
        status: "unknown",
        confirmedBy: null,
        confirmedAt: null,
        graphMailboxes: 2,
      },
    ]);
    const put = (status: string, tenantId = contoso, sourceId = m365) =>
      app.request(`/archive/capture/holds/${sourceId}`, {
        method: "PUT",
        headers: { ...as(tenantId), "content-type": "application/json" },
        body: JSON.stringify({ status }),
      });
    const confirmed = await put("confirmed");
    expect(confirmed.status).toBe(200);
    expect(await confirmed.json()).toMatchObject({
      status: "confirmed",
      confirmedBy: "admin@contoso.example",
    });
    const [source] = await owner.select().from(sources).where(eq(sources.id, m365));
    expect(source?.config.archiveHold?.status).toBe("confirmed");
    expect((await put("unknown")).status).toBe(200);
    const actions = (
      await owner
        .select({ action: auditLog.action })
        .from(auditLog)
        .where(and(eq(auditLog.tenantId, contoso), eq(auditLog.target, m365)))
    ).map((row) => row.action);
    expect(actions).toEqual(["archive.hold.confirmed", "archive.hold.unconfirmed"]);

    expect((await put("maybe")).status).toBe(422);
    expect((await put("confirmed", fabrikam)).status).toBe(404);
  });
});
