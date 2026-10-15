/**
 * Restore requests for SharePoint sites against Postgres: the target list
 * offers the libraries of the source's backed-up sites, a restore into another
 * library must name one of them, "overwrite" (replace) is allowed for sites
 * only, and restoring a site is no impersonation (it belongs to no person).
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server (the
 * database `restow_api_restore_sites_test` is recreated there and dropped after).
 */
import { createDb, type Database, protectedObjects, restoreJobs, snapshots } from "@restow/db";
import { eq } from "drizzle-orm";
import PgBoss from "pg-boss";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createExplorerFixture,
  dropDatabase,
  type ExplorerFixture,
  recreateDatabase,
  testDatabaseAdminUrl,
} from "../snapshots/testing/explorer-fixture.js";
import { insertManifestRows } from "../snapshots/testing/manifest-rows.js";
import { createRestoreSchema } from "./schemas.js";

const DATABASE = "restow_api_restore_sites_test";

type Service = typeof import("./service.js");

const request = (input: Record<string, unknown>) => createRestoreSchema.parse(input);

const authState = vi.hoisted(() => ({ getSession: vi.fn() }));
vi.mock("../../auth.js", () => ({ auth: { api: { getSession: authState.getSession } } }));

describe.skipIf(!testDatabaseAdminUrl)("SharePoint restore requests against Postgres", () => {
  let db: Database;
  let f: ExplorerFixture;
  let service: Service;
  let site: string;
  let otherSite: string;
  let siteSnapshot: string;

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

    const [mailbox] = await db
      .select({ sourceId: protectedObjects.sourceId })
      .from(protectedObjects)
      .where(eq(protectedObjects.id, f.annaMailbox));
    const sourceId = mailbox?.sourceId as string;
    const insertSite = async (externalId: string, displayName: string) => {
      const [row] = await db
        .insert(protectedObjects)
        .values({
          tenantId: f.tenantId,
          sourceId,
          kind: "site",
          externalId,
          displayName,
          status: "active",
        })
        .returning();
      return row?.id as string;
    };
    site = await insertSite("host,1,1", "Sales");
    otherSite = await insertSite("host,2,2", "Archive");

    const snapshotOf = async (protectedObjectId: string) => {
      const [row] = await db
        .insert(snapshots)
        .values({
          tenantId: f.tenantId,
          protectedObjectId,
          sequence: 1,
          startedAt: new Date(Date.UTC(2026, 0, 5)),
          completedAt: new Date(Date.UTC(2026, 0, 5)),
          manifestPath: `tenants/${f.tenantId}/manifests/${protectedObjectId}`,
          itemCount: 3,
          byteSize: 100,
        })
        .returning();
      return row?.id as string;
    };
    siteSnapshot = await snapshotOf(site);
    const archiveSnapshot = await snapshotOf(otherSite);
    const base = { tenantId: f.tenantId, snapshotId: siteSnapshot, protectedObjectId: site };
    await insertManifestRows(db, [
      {
        ...base,
        kind: "folder",
        path: "Libraries/Documents",
        metadata: { siteRole: "library", driveId: "b!docs" },
      },
      {
        ...base,
        kind: "file",
        path: "Libraries/Documents/readme.txt",
        itemId: "item-readme",
        size: 11,
        chunkRefs: ["chunk-readme"],
      },
      { ...base, kind: "folder", path: "Lists/Tasks", metadata: { siteRole: "list" } },
      {
        ...base,
        kind: "file",
        path: "Lists/Tasks/1.json",
        itemId: "list:l1:1",
        size: 40,
        chunkRefs: ["chunk-item"],
        metadata: { siteRole: "listItem", title: "Call" },
      },
    ]);
    await insertManifestRows(db, [
      {
        tenantId: f.tenantId,
        snapshotId: archiveSnapshot,
        protectedObjectId: otherSite,
        kind: "folder",
        path: "Libraries/Old files",
        metadata: { siteRole: "library", driveId: "b!old" },
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

  it("offers the libraries of the source's backed-up sites as targets", async () => {
    const targets = await service.listTargets(db, f.tenantId, admin(), site);
    expect(targets.map((target) => [target.externalId, target.displayName])).toEqual([
      ["b!docs", "Sales › Documents"],
      ["b!old", "Archive › Old files"],
    ]);
  });

  it("overwrites into the original site on request, without counting as impersonation", async () => {
    const created = await service.createRestore(
      db,
      f.tenantId,
      admin(),
      request({
        snapshotId: siteSnapshot,
        selection: [{ path: "Libraries/Documents", kind: "folder" }],
        target: { type: "original" },
        mode: "replace",
      }),
    );
    expect(created).toMatchObject({ status: "queued", impersonated: false });
    const [stored] = await db.select().from(restoreJobs).where(eq(restoreJobs.id, created.id));
    expect(stored).toMatchObject({ mode: "replace", reason: null, impersonated: false });
  });

  it("restores into a library of another site, and refuses a library it does not know", async () => {
    const created = await service.createRestore(
      db,
      f.tenantId,
      admin(),
      request({
        snapshotId: siteSnapshot,
        selection: [{ path: "Libraries/Documents/readme.txt", kind: "item" }],
        target: { type: "other", accountId: "b!old:/Restored" },
      }),
    );
    const [stored] = await db.select().from(restoreJobs).where(eq(restoreJobs.id, created.id));
    expect(stored).toMatchObject({ targetType: "other", targetRef: "b!old:/Restored" });

    await expect(
      service.createRestore(
        db,
        f.tenantId,
        admin(),
        request({
          snapshotId: siteSnapshot,
          selection: [{ path: "Libraries/Documents/readme.txt", kind: "item" }],
          target: { type: "other", accountId: "b!somewhere-else" },
        }),
      ),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("still refuses overwrite into a OneDrive", async () => {
    await expect(
      service.createRestore(
        db,
        f.tenantId,
        admin(),
        request({
          snapshotId: f.drive,
          selection: [{ path: "Documents", kind: "folder" }],
          target: { type: "original" },
          mode: "replace",
          reason: "user asked",
        }),
      ),
    ).rejects.toMatchObject({ status: 422 });
  });
});
