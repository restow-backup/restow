/**
 * `resolveTenantStorage` / `locateInStorage` / `listInStorage` against real
 * rows: a `previous` storage target (the retired primary of a completed
 * storage migration, docs/STORAGE.md) must still answer restore, verify and
 * download reads for a snapshot that lives only there, as a fallback after
 * the primary and every copy.
 *
 * The database `restow_api_restore_storage_test` is created once and migrated
 * in `beforeAll`, like every other `*.pg.test.ts`-style suite in this
 * repository; `afterEach` clears `storage_targets` so every test starts from
 * a clean slate. Runs when RESTOW_TEST_DATABASE_URL points at a Postgres
 * server; without it the suite is skipped.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Database, createDb, providers, storageTargets, tenants } from "@restow/db";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  dropDatabase,
  recreateDatabase,
  testDatabaseAdminUrl,
} from "../snapshots/testing/explorer-fixture.js";
import { defaultStorage, listInStorage, locateInStorage, resolveTenantStorage } from "./storage.js";

const DATABASE = "restow_api_restore_storage_test";

async function putFile(baseDir: string, key: string, contents = "{}"): Promise<void> {
  const path = join(baseDir, ...key.split("/"));
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, contents);
}

describe.skipIf(!testDatabaseAdminUrl)("resolveTenantStorage: previous targets", () => {
  let db: Database;
  let tenantId: string;
  let primaryDir: string;
  let previousDir: string;

  beforeAll(async () => {
    db = createDb(await recreateDatabase(testDatabaseAdminUrl as string, DATABASE));
    primaryDir = await mkdtemp(join(tmpdir(), "restow-primary-"));
    previousDir = await mkdtemp(join(tmpdir(), "restow-previous-"));
    const [provider] = await db.insert(providers).values({ name: "Provider" }).returning();
    const [tenant] = await db
      .insert(tenants)
      .values({ providerId: provider?.id as string, name: "Tenant", slug: "tenant" })
      .returning();
    tenantId = tenant?.id as string;
  }, 30_000);

  afterEach(async () => {
    await db.delete(storageTargets).where(eq(storageTargets.tenantId, tenantId));
  });

  afterAll(async () => {
    await db.$client.end();
    await rm(primaryDir, { recursive: true, force: true });
    await rm(previousDir, { recursive: true, force: true });
    await dropDatabase(testDatabaseAdminUrl as string, DATABASE);
  });

  it("reads an object that exists only on a previous target, as a fallback after the primary and every copy", async () => {
    await db.insert(storageTargets).values([
      { tenantId, kind: "local", role: "primary", config: { basePath: primaryDir } },
      { tenantId, kind: "local", role: "previous", config: { basePath: previousDir } },
    ]);
    const key = "tenants/x/manifests/only-on-previous.json";
    await putFile(previousDir, key);

    const storage = await resolveTenantStorage(db, tenantId, () => defaultStorage());
    const found = await locateInStorage(storage, key);
    expect(found).not.toBeNull();

    const keys = await listInStorage(storage, "tenants/x/manifests/");
    expect(keys).toContain(key);
  });

  it("prefers the primary over a previous target when both have the object", async () => {
    const key = "tenants/y/manifests/on-both.json";
    await putFile(primaryDir, key, '{"from":"primary"}');
    await putFile(previousDir, key, '{"from":"previous"}');
    await db.insert(storageTargets).values([
      { tenantId, kind: "local", role: "primary", config: { basePath: primaryDir } },
      { tenantId, kind: "local", role: "previous", config: { basePath: previousDir } },
    ]);
    const storage = await resolveTenantStorage(db, tenantId, () => defaultStorage());
    const found = await locateInStorage(storage, key);
    expect(found?.backend).toBe(storage.primary);
  });

  it("finds nothing on a previous target that neither the primary nor the object holds", async () => {
    await db.insert(storageTargets).values([
      { tenantId, kind: "local", role: "primary", config: { basePath: primaryDir } },
      { tenantId, kind: "local", role: "previous", config: { basePath: previousDir } },
    ]);
    const storage = await resolveTenantStorage(db, tenantId, () => defaultStorage());
    const found = await locateInStorage(storage, "tenants/z/manifests/nowhere.json");
    expect(found).toBeNull();
  });
});
