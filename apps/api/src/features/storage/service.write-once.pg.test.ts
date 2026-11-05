/**
 * Postgres-backed coverage of how "Test" on a tenant target keeps its write-once finding
 * (docs/STORAGE.md, "Write-once storage"): only a probe that reached its overwrite and delete
 * step replaces the finding; one that stopped earlier (here: the directory is gone, as when a
 * share is briefly unmounted) keeps the finding of the last probe that got there, so a known
 * write-once target is never treated as a normal one again. The database
 * `restow_api_storage_write_once_test` is created once; local targets only. Runs when
 * RESTOW_TEST_DATABASE_URL points at Postgres.
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rowWriteOnce, type WriteOnceFinding, writeOnceOfConfig } from "@restow/core";
import { createDb, type Database, providers, storageTargets, tenants } from "@restow/db";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  dropDatabase,
  recreateDatabase,
  testDatabaseAdminUrl,
} from "../snapshots/testing/explorer-fixture.js";
import { testTarget } from "./service.js";

const DATABASE = "restow_api_storage_write_once_test";

const FOUND: WriteOnceFinding = {
  writeOnce: true,
  refused: ["overwrite", "delete"],
  code: "EPERM",
  checkedAt: "2026-11-01T10:00:00.000Z",
};

describe.skipIf(!testDatabaseAdminUrl)("the write-once finding of a tenant target", () => {
  let db: Database;
  let tenantId: string;
  let root: string;

  const actor = { id: "u1", email: "admin@example.com", ip: "203.0.113.7", isProviderAdmin: true };

  beforeAll(async () => {
    const url = await recreateDatabase(testDatabaseAdminUrl as string, DATABASE);
    db = createDb(url);
    const [provider] = await db.insert(providers).values({ name: "Provider" }).returning();
    const [tenant] = await db
      .insert(tenants)
      .values({ providerId: provider?.id as string, name: "Tenant", slug: "tenant" })
      .returning();
    tenantId = tenant?.id as string;
    root = await mkdtemp(join(tmpdir(), "restow-storage-write-once-"));
  }, 60_000);

  afterEach(async () => {
    await db.delete(storageTargets).where(eq(storageTargets.tenantId, tenantId));
  });

  afterAll(async () => {
    await db.$client.end();
    await dropDatabase(testDatabaseAdminUrl as string, DATABASE);
    if (root) {
      await rm(root, { recursive: true, force: true });
    }
  });

  /** A primary whose last probe found it write-once. */
  async function writeOnceTarget(basePath: string): Promise<string> {
    const [row] = await db
      .insert(storageTargets)
      .values({
        tenantId,
        kind: "local",
        role: "primary",
        status: "ok",
        config: {
          basePath,
          lastProbe: {
            ok: true,
            failedStep: null,
            errorCode: null,
            checkedAt: FOUND.checkedAt,
            writeOnce: FOUND,
          },
        } as typeof storageTargets.$inferInsert.config,
      })
      .returning();
    return row?.id as string;
  }

  async function configOf(id: string): Promise<unknown> {
    const [row] = await db.select().from(storageTargets).where(eq(storageTargets.id, id));
    return row?.config;
  }

  it("stays write-once after a Test that fails before the overwrite and delete step", async () => {
    const id = await writeOnceTarget(join(root, "unmounted"));

    const result = await testTarget(db, tenantId, id, actor);

    expect(result.probe.ok).toBe(false);
    expect(result.probe.writeOnce ?? null).toBeNull();
    expect(result.target.writeOnce).toEqual(FOUND);
    const config = await configOf(id);
    expect(writeOnceOfConfig(config)).toEqual(FOUND);
    expect(rowWriteOnce({ config: config as typeof storageTargets.$inferSelect.config })).toBe(
      true,
    );
    // The rest of the last probe is the new one.
    expect((config as { lastProbe: { ok: boolean } }).lastProbe.ok).toBe(false);
    expect((config as { basePath: string }).basePath).toBe(join(root, "unmounted"));
  });

  it("takes the finding of a Test that reached the overwrite and delete step", async () => {
    const basePath = join(root, "normal");
    await mkdir(basePath, { recursive: true });
    const id = await writeOnceTarget(basePath);

    const result = await testTarget(db, tenantId, id, actor);

    expect(result.probe.ok).toBe(true);
    expect(result.probe.writeOnce?.writeOnce).toBe(false);
    const config = await configOf(id);
    expect(writeOnceOfConfig(config)?.writeOnce).toBe(false);
    expect(writeOnceOfConfig(config)?.checkedAt).not.toBe(FOUND.checkedAt);
  });

  it("records no finding when no probe ever got that far", async () => {
    const [row] = await db
      .insert(storageTargets)
      .values({
        tenantId,
        kind: "local",
        role: "copy",
        status: "unverified",
        config: { basePath: join(root, "never") },
      })
      .returning();
    const id = row?.id as string;

    await testTarget(db, tenantId, id, actor);

    expect(writeOnceOfConfig(await configOf(id))).toBeNull();
  });
});
