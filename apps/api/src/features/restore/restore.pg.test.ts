/**
 * Postgres-backed tests of restore requests: selection validation against the
 * snapshot, the self-service and impersonation rules, the single transaction
 * that writes the request, the lifecycle row, the pg-boss entry and the audit
 * entry, and reading results back.
 *
 * The last section (round 3 of the restore-never-replace regression) proves
 * the same rule through real HTTP requests against `features/restore/routes.ts`
 * instead of calling the service directly: better-auth's session lookup is
 * replaced at its module boundary (same style as features/tenants/routes.test.ts).
 * Everything else, the router, the middleware, the service and the database,
 * is the real thing.
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server (the
 * database `restow_api_restore_test` is recreated there and dropped after).
 * Without it the suite is skipped; docs/TESTING.md lists it under integration.
 */
import { type Database, auditLog, createDb, jobs, protectedObjects, restoreJobs } from "@restow/db";
import { and, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import PgBoss from "pg-boss";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { errorHandler, notFoundHandler } from "../../problem.js";
import {
  type ExplorerFixture,
  createExplorerFixture,
  dropDatabase,
  recreateDatabase,
  testDatabaseAdminUrl,
} from "../snapshots/testing/explorer-fixture.js";
import { createRestoreSchema } from "./schemas.js";

const DATABASE = "restow_api_restore_test";

type Service = typeof import("./service.js");

const request = (input: Record<string, unknown>) => createRestoreSchema.parse(input);

/**
 * better-auth's session lookup, replaced so the HTTP-level cases below run
 * against a real request without a real passkey ceremony (features/tenants/
 * routes.test.ts uses the same stand-in).
 */
const authState = vi.hoisted(() => ({ getSession: vi.fn() }));
vi.mock("../../auth.js", () => ({ auth: { api: { getSession: authState.getSession } } }));

describe.skipIf(!testDatabaseAdminUrl)("restore requests against Postgres", () => {
  let db: Database;
  let f: ExplorerFixture;
  let service: Service;
  let httpApp: Hono;

  const actor = (viewer: ExplorerFixture["admin"]) => ({ ...viewer, ip: "192.0.2.10" });

  beforeAll(async () => {
    const url = await recreateDatabase(testDatabaseAdminUrl as string, DATABASE);
    // The API's shared handles (db.ts) read these on import.
    process.env.DATABASE_URL = url;
    process.env.DATABASE_PROVIDER_URL = url;
    const boss = new PgBoss({ connectionString: url });
    await boss.start();
    await boss.createQueue("restore");
    await boss.stop({ graceful: false, wait: true });

    db = createDb(url);
    f = await createExplorerFixture(db);
    service = await import("./service.js");

    const { restoreRoutes } = await import("./routes.js");
    httpApp = new Hono();
    httpApp.onError(errorHandler);
    httpApp.notFound(notFoundHandler);
    httpApp.route("/restore", restoreRoutes);
  }, 60_000);

  afterAll(async () => {
    const shared = await import("../../db.js");
    await Promise.all([shared.db.$client.end(), shared.providerDb.$client.end()]);
    await db?.$client.end();
    await dropDatabase(testDatabaseAdminUrl as string, DATABASE);
  });

  it("writes the request, the lifecycle row, the queue entry and the audit entry together", async () => {
    const created = await service.createRestore(
      db,
      f.tenantId,
      actor(f.anna),
      request({
        snapshotId: f.mailbox.second,
        selection: [
          { path: "calendar", kind: "folder" },
          { path: "mail/Inbox/Quarterly.aaaa.eml", kind: "item" },
          { itemId: "msg-kickoff" },
          // Deleted at the source, still restorable from the snapshot.
          { path: "mail/Inbox/Lunch.bbbb.eml" },
        ],
        target: { type: "original" },
        mode: "skip",
        options: { restoreFolderName: "Wiederhergestellt 2026-09-23" },
      }),
    );
    expect(created).toMatchObject({
      status: "queued",
      impersonated: false,
      selection: { all: false, folders: 1, items: 3 },
    });

    const [stored] = await db.select().from(restoreJobs).where(eq(restoreJobs.id, created.id));
    expect(stored).toMatchObject({
      jobId: created.jobId,
      snapshotId: f.mailbox.second,
      targetType: "original",
      targetRef: null,
      mode: "skip",
      actorUserId: f.anna.userId,
      impersonated: false,
      reason: null,
      sourceSelection: {
        folderPaths: ["calendar"],
        paths: ["mail/Inbox/Lunch.bbbb.eml", "mail/Inbox/Quarterly.aaaa.eml"],
        objectIds: ["msg-kickoff"],
        options: { restoreFolderName: "Wiederhergestellt 2026-09-23" },
      },
    });

    const [job] = await db.select().from(jobs).where(eq(jobs.id, created.jobId));
    expect(job).toMatchObject({
      queue: "restore",
      status: "queued",
      protectedObjectId: f.annaMailbox,
    });
    expect(job?.pgBossJobId).toBeTruthy();

    const queued = await db.execute<{
      name: string;
      priority: number;
      data: Record<string, unknown>;
    }>(sql`SELECT name, priority, data FROM pgboss.job WHERE id = ${job?.pgBossJobId}::uuid`);
    expect(queued.rows[0]).toEqual({
      name: "restore",
      priority: 100,
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
      tenantId: f.tenantId,
      actorUserId: f.anna.userId,
      targetType: "restore_job",
      onBehalfOf: null,
      ip: "192.0.2.10",
    });
    expect(entry?.details).toMatchObject({ target: "original", mode: "skip", reason: null });
  });

  it("rejects entries that are not in the snapshot instead of restoring less", async () => {
    await expect(
      service.createRestore(
        db,
        f.tenantId,
        actor(f.anna),
        request({
          snapshotId: f.mailbox.first,
          selection: [{ path: "mail/Inbox" }, { path: "mail/Nowhere" }, { itemId: "ghost" }],
          target: { type: "download" },
        }),
      ),
    ).rejects.toMatchObject({
      status: 422,
      extensions: { unknown: ["path:mail/Nowhere", "itemId:ghost"] },
    });
  });

  it("selects the whole snapshot through the root and folders that only exist implicitly", async () => {
    const everything = await service.createRestore(
      db,
      f.tenantId,
      actor(f.anna),
      request({
        snapshotId: f.mailbox.first,
        selection: [{ path: "" }],
        target: { type: "download" },
      }),
    );
    expect(everything.selection).toEqual({ all: true, folders: 0, items: 0 });

    const implicit = await service.createRestore(
      db,
      f.tenantId,
      actor(f.anna),
      request({
        snapshotId: f.mailbox.first,
        selection: [{ path: "mail" }, { path: "mail/Inbox/Quarterly.aaaa.eml" }],
        target: { type: "download" },
      }),
    );
    // The mail inside the selected folder is covered by it.
    expect(implicit.selection).toEqual({ all: false, folders: 1, items: 0 });
  });

  it("requires a reason when an admin restores another person's data, and audits on whose behalf", async () => {
    const input = {
      snapshotId: f.mailbox.second,
      selection: [{ path: "mail/Inbox" }],
      target: { type: "original" },
    };
    await expect(
      service.createRestore(db, f.tenantId, actor(f.admin), request(input)),
    ).rejects.toMatchObject({ status: 422, type: "urn:restow:problem:restore-reason-required" });

    const created = await service.createRestore(
      db,
      f.tenantId,
      actor(f.admin),
      request({ ...input, reason: "Ticket 4711: Inbox emptied by accident" }),
    );
    expect(created.impersonated).toBe(true);
    const [entry] = await db.select().from(auditLog).where(eq(auditLog.target, created.id));
    expect(entry?.onBehalfOf).toBe("anna@contoso.test");
    expect(entry?.details).toMatchObject({ reason: "Ticket 4711: Inbox emptied by accident" });
  });

  it("keeps end users to their own data and their own account", async () => {
    await expect(
      service.createRestore(
        db,
        f.tenantId,
        actor(f.anna),
        request({
          snapshotId: f.mailbox.second,
          selection: [{ path: "mail/Inbox" }],
          target: { type: "other", accountId: "bob@contoso.test" },
        }),
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      service.createRestore(
        db,
        f.tenantId,
        actor(f.bob),
        request({
          snapshotId: f.mailbox.second,
          selection: [{ path: "mail/Inbox" }],
          target: { type: "download" },
        }),
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("restores IMAP data only into accounts the tenant knows", async () => {
    const input = (accountId: string) =>
      request({
        snapshotId: f.imap,
        selection: [{ path: "mail/INBOX" }],
        target: { type: "other", accountId },
        reason: "Moving the shared inbox",
      });
    await expect(
      service.createRestore(db, f.tenantId, actor(f.admin), input("stranger@example.test")),
    ).rejects.toMatchObject({ status: 422, type: "urn:restow:problem:restore-target-unknown" });
    const created = await service.createRestore(
      db,
      f.tenantId,
      actor(f.admin),
      input("INFO@contoso.test"),
    );
    expect(created.status).toBe("queued");
  });

  it("suggests same-kind accounts of the same source as targets", async () => {
    const targets = await service.listTargets(db, f.tenantId, f.admin, f.annaMailbox);
    expect(targets.map((target) => target.externalId)).toEqual(["bob@contoso.test"]);
    const imapTargets = await service.listTargets(db, f.tenantId, f.admin, f.imapAccount);
    expect(imapTargets).toEqual([]);
  });

  it("refuses the original target of an account that no longer exists", async () => {
    await db
      .update(protectedObjects)
      .set({ status: "orphaned" })
      .where(eq(protectedObjects.id, f.bobMailbox));
    const input = (target: Record<string, unknown>) =>
      request({
        snapshotId: f.bobSnapshot,
        selection: [{ path: "mail/Inbox" }],
        target,
        reason: "Offboarding export",
      });
    await expect(
      service.createRestore(db, f.tenantId, actor(f.admin), input({ type: "original" })),
    ).rejects.toMatchObject({ status: 409 });
    const download = await service.createRestore(
      db,
      f.tenantId,
      actor(f.admin),
      input({ type: "download" }),
    );
    expect(download.impersonated).toBe(true);
  });

  it("reads results, per-item outcomes and download availability back", async () => {
    const created = await service.createRestore(
      db,
      f.tenantId,
      actor(f.anna),
      request({
        snapshotId: f.mailbox.second,
        selection: [{ path: "mail/Inbox/Quarterly.aaaa.eml" }],
        target: { type: "download" },
      }),
    );
    const completedAt = new Date();
    await db
      .update(jobs)
      .set({
        status: "completed",
        completedAt,
        payload: sql`${jobs.payload} || ${JSON.stringify({
          result: {
            restored: 1,
            skipped: 0,
            failures: 0,
            unverified: 0,
            bytes: 100,
            downloadKey: `tenants/${f.tenantId}/downloads/${created.id}/restore.zip`,
            itemCount: 1,
            items: [
              {
                path: "mail/Inbox/Quarterly.aaaa.eml",
                itemId: "msg-quarterly",
                type: "mail",
                status: "restored",
                targetRef: "mail/Inbox/Quarterly.aaaa.eml.eml",
                bytes: 100,
                verified: true,
                reason: null,
              },
            ],
          },
        })}::jsonb`,
      })
      .where(eq(jobs.id, created.jobId));

    const detail = await service.getRestore(db, f.tenantId, f.anna, created.id);
    expect(detail).toMatchObject({
      status: "completed",
      target: { type: "download", ref: null },
      snapshotSequence: 2,
      object: { id: f.annaMailbox, kind: "mailbox" },
      actor: { userId: f.anna.userId, name: "Anna", email: "anna@contoso.test" },
      result: { restored: 1, bytes: 100 },
      items: { total: 1, truncated: false },
      download: { available: true },
      failures: [],
    });
    expect(detail.items?.items[0]?.verified).toBe(true);
  });

  it("shows end users their own restores and the ones of their objects only", async () => {
    const annas = await service.listRestores(db, f.tenantId, f.anna, { limit: 200 });
    expect(annas.length).toBeGreaterThan(0);
    expect(annas.every((restore) => restore.object?.id === f.annaMailbox)).toBe(true);

    const bobs = await service.listRestores(db, f.tenantId, f.bob, { limit: 200 });
    expect(bobs.map((restore) => restore.object?.id)).toEqual([f.bobMailbox]);

    const all = await service.listRestores(db, f.tenantId, f.admin, { limit: 200 });
    expect(all.length).toBeGreaterThan(annas.length);
    await expect(
      service.getRestore(db, f.tenantId, f.bob, annas[0]?.id as string),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("cancels a queued restore once and audits it", async () => {
    const created = await service.createRestore(
      db,
      f.tenantId,
      actor(f.anna),
      request({
        snapshotId: f.mailbox.first,
        selection: [{ path: "mail" }],
        target: { type: "download" },
      }),
    );
    const cancelled = await service.cancelRestore(db, f.tenantId, actor(f.anna), created.id);
    expect(cancelled.status).toBe("cancelled");
    await expect(
      service.cancelRestore(db, f.tenantId, actor(f.anna), created.id),
    ).rejects.toMatchObject({ status: 409 });
    const [entry] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "restore.cancelled"), eq(auditLog.target, created.id)));
    expect(entry?.details).toMatchObject({ previousStatus: "queued" });
  });

  describe("POST /restore over HTTP (round 3: mailbox/IMAP never replace)", () => {
    /** A provider admin session (better-auth `user.role: "admin"`); backed by the real `f.admin` user row. */
    function signInAsProviderAdmin(): void {
      authState.getSession.mockResolvedValue({
        session: {
          id: "session-round3",
          userId: f.admin.userId,
          activeOrganizationId: null,
          authMethod: "passkey",
          impersonatedBy: null,
        },
        user: {
          id: f.admin.userId,
          email: f.admin.email,
          name: "Admin",
          role: "admin",
          banned: false,
          twoFactorEnabled: false,
        },
      });
    }

    function post(body: Record<string, unknown>) {
      return httpApp.request("/restore", {
        method: "POST",
        headers: { "content-type": "application/json", "x-restow-tenant": f.tenantId },
        body: JSON.stringify(body),
      });
    }

    const REPLACE_ORIGINAL = (snapshotId: string, path: string) => ({
      snapshotId,
      selection: [{ path }],
      target: { type: "original" },
      mode: "replace",
      reason: "Ticket 9001: restore-replace-not-allowed HTTP regression",
    });

    it("refuses mode 'replace' for an Exchange mailbox target with 422 and the problem type", async () => {
      signInAsProviderAdmin();
      const res = await post(REPLACE_ORIGINAL(f.mailbox.second, "mail/Inbox"));
      expect(res.status).toBe(422);
      expect(res.headers.get("content-type")).toContain("application/problem+json");
      expect(await res.json()).toMatchObject({
        status: 422,
        type: "urn:restow:problem:restore-replace-not-allowed",
      });
    });

    it("refuses mode 'replace' for an IMAP target with the same 422 and problem type", async () => {
      signInAsProviderAdmin();
      const res = await post(REPLACE_ORIGINAL(f.imap, "mail/INBOX"));
      expect(res.status).toBe(422);
      expect(await res.json()).toMatchObject({
        status: 422,
        type: "urn:restow:problem:restore-replace-not-allowed",
      });
    });

    it("refuses mode 'replace' for a OneDrive target too, and stores or queues nothing", async () => {
      signInAsProviderAdmin();
      const before = await db.select().from(restoreJobs);
      const res = await post(REPLACE_ORIGINAL(f.drive, "Documents"));
      expect(res.status).toBe(422);
      expect(await res.json()).toMatchObject({
        status: 422,
        type: "urn:restow:problem:restore-replace-not-allowed",
      });
      expect(await db.select().from(restoreJobs)).toHaveLength(before.length);
    });
  });
});
