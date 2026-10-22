/**
 * Microsoft 365 group mailboxes against Postgres: the restore explorer lists
 * them in the "SharePoint & Teams" section (not among people), the target list
 * of a group offers the user mailboxes of its source, restoring a group is no
 * impersonation (it belongs to no person), and "replace" stays refused.
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server (the
 * database `restow_api_restore_groups_test` is recreated there and dropped after).
 */
import { createDb, type Database, protectedObjects, restoreJobs, snapshots } from "@restow/db";
import { eq } from "drizzle-orm";
import PgBoss from "pg-boss";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { peopleQuerySchema } from "../snapshots/schemas.js";
import {
  createExplorerFixture,
  dropDatabase,
  type ExplorerFixture,
  recreateDatabase,
  testDatabaseAdminUrl,
} from "../snapshots/testing/explorer-fixture.js";
import { insertManifestRows } from "../snapshots/testing/manifest-rows.js";
import { createRestoreSchema } from "./schemas.js";

const DATABASE = "restow_api_restore_groups_test";

type Service = typeof import("./service.js");
type Snapshots = typeof import("../snapshots/service.js");

const request = (input: Record<string, unknown>) => createRestoreSchema.parse(input);

const authState = vi.hoisted(() => ({ getSession: vi.fn() }));
vi.mock("../../auth.js", () => ({ auth: { api: { getSession: authState.getSession } } }));

describe.skipIf(!testDatabaseAdminUrl)("group mailbox restore requests against Postgres", () => {
  let db: Database;
  let f: ExplorerFixture;
  let service: Service;
  let explorer: Snapshots;
  let group: string;
  let groupSnapshot: string;

  const admin = () => ({ ...f.admin, ip: "192.0.2.10" });

  beforeAll(async () => {
    const url = await recreateDatabase(testDatabaseAdminUrl as string, DATABASE);
    process.env.DATABASE_URL = url;
    process.env.DATABASE_PROVIDER_URL = url;
    const boss = new PgBoss({ connectionString: url });
    await boss.start();
    await boss.createQueue("restore");
    await boss.stop({ graceful: false, wait: true });

    db = createDb(url);
    f = await createExplorerFixture(db);
    service = await import("./service.js");
    explorer = await import("../snapshots/service.js");

    const [mailbox] = await db
      .select({ sourceId: protectedObjects.sourceId })
      .from(protectedObjects)
      .where(eq(protectedObjects.id, f.annaMailbox));
    const [row] = await db
      .insert(protectedObjects)
      .values({
        tenantId: f.tenantId,
        sourceId: mailbox?.sourceId as string,
        kind: "group",
        externalId: "0b6f8f5e-1111-4222-8333-444455556666",
        displayName: "Project Phoenix",
        status: "active",
      })
      .returning();
    group = row?.id as string;
    const [snapshot] = await db
      .insert(snapshots)
      .values({
        tenantId: f.tenantId,
        protectedObjectId: group,
        sequence: 1,
        startedAt: new Date(Date.UTC(2026, 0, 5)),
        completedAt: new Date(Date.UTC(2026, 0, 5)),
        manifestPath: `tenants/${f.tenantId}/manifests/${group}`,
        itemCount: 2,
        byteSize: 100,
      })
      .returning();
    groupSnapshot = snapshot?.id as string;
    const base = { tenantId: f.tenantId, snapshotId: groupSnapshot, protectedObjectId: group };
    await insertManifestRows(db, [
      { ...base, kind: "folder", path: "calendar/Calendar", metadata: { folderKind: "calendar" } },
      {
        ...base,
        kind: "event",
        path: "calendar/Calendar/Kickoff.0001.json",
        itemId: "G-E1",
        size: 40,
        chunkRefs: ["chunk-event"],
        metadata: { subject: "Kickoff" },
      },
      { ...base, kind: "folder", path: "mail/Conversations", metadata: { folderKind: "mail" } },
      {
        ...base,
        kind: "mail",
        path: "mail/Conversations/Launch plan.0002.eml",
        itemId: "P1",
        size: 60,
        chunkRefs: ["chunk-post"],
        metadata: { subject: "Launch plan" },
      },
    ]);
  }, 60_000);

  afterAll(async () => {
    const shared = await import("../../db.js");
    await Promise.all([
      shared.db.$client.end(),
      shared.providerDb.$client.end(),
      shared.authDb.$client.end(),
    ]);
    await db?.$client.end();
    await dropDatabase(testDatabaseAdminUrl as string, DATABASE);
  });

  it("lists the group in the SharePoint & Teams section, not among people", async () => {
    const sites = await explorer.listPeople(
      db,
      f.tenantId,
      admin(),
      peopleQuerySchema.parse({ section: "sites" }),
    );
    const entry = sites.items.find((e) => e.objects.some((o) => o.id === group));
    expect(entry?.name).toBe("Project Phoenix");
    expect(entry?.objects.map((o) => [o.kind, o.ownerKey])).toEqual([["group", null]]);
    const people = await explorer.listPeople(
      db,
      f.tenantId,
      admin(),
      peopleQuerySchema.parse({ section: "people", limit: "100" }),
    );
    expect(people.items.some((e) => e.objects.some((o) => o.id === group))).toBe(false);
  });

  it("offers the user mailboxes of the group's source as targets", async () => {
    const targets = await service.listTargets(db, f.tenantId, admin(), group);
    expect(targets.length).toBeGreaterThan(0);
    expect(targets.every((target) => target.kind === "mailbox")).toBe(true);
    expect(targets.some((target) => target.id === f.annaMailbox)).toBe(true);
  });

  it("restores into the group or a user's mailbox without counting as impersonation", async () => {
    const intoGroup = await service.createRestore(
      db,
      f.tenantId,
      admin(),
      request({
        snapshotId: groupSnapshot,
        selection: [{ path: "calendar/Calendar", kind: "folder" }],
        target: { type: "original" },
        mode: "skip",
      }),
    );
    expect(intoGroup).toMatchObject({ status: "queued", impersonated: false });
    const intoMailbox = await service.createRestore(
      db,
      f.tenantId,
      admin(),
      request({
        snapshotId: groupSnapshot,
        selection: [{ path: "mail/Conversations", kind: "folder" }],
        target: { type: "other", accountId: "anna@example.org" },
      }),
    );
    const [stored] = await db.select().from(restoreJobs).where(eq(restoreJobs.id, intoMailbox.id));
    expect(stored).toMatchObject({ targetType: "other", impersonated: false, reason: null });
  });

  it("refuses replace into a group", async () => {
    await expect(
      service.createRestore(
        db,
        f.tenantId,
        admin(),
        request({
          snapshotId: groupSnapshot,
          selection: [{ path: "calendar/Calendar", kind: "folder" }],
          target: { type: "original" },
          mode: "replace",
        }),
      ),
    ).rejects.toMatchObject({ status: 422 });
  });
});
