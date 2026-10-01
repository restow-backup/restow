/**
 * Demo-mode restrictions on `createRestore` (security review findings 3 and
 * 6): download-only, one restore in flight per tenant, and a visitor's own
 * `reason`/`restoreFolderName`/`archiveName` replaced with fixed text.
 *
 * `config` (../../config.ts) is a module-level singleton read from
 * `process.env` at import time, so demo mode is exercised by stubbing the
 * environment, resetting the module registry and importing the service
 * fresh — the same approach app-wide tests use for other environment-derived
 * configuration (see auth.test.ts, middleware/demo-guard.test.ts).
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server (the
 * database `restow_api_restore_demo_test` is recreated there and dropped
 * after). Without it the suite is skipped.
 */
import { type Database, createDb, jobs, restoreJobs } from "@restow/db";
import { eq } from "drizzle-orm";
import PgBoss from "pg-boss";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  type ExplorerFixture,
  createExplorerFixture,
  dropDatabase,
  recreateDatabase,
  testDatabaseAdminUrl,
} from "../snapshots/testing/explorer-fixture.js";
import { createRestoreSchema } from "./schemas.js";

const DATABASE = "restow_api_restore_demo_test";

type Service = typeof import("./service.js");

const request = (input: Record<string, unknown>) => createRestoreSchema.parse(input);

describe.skipIf(!testDatabaseAdminUrl)("createRestore in demo mode, on Postgres", () => {
  let db: Database;
  let f: ExplorerFixture;
  let service: Service;

  const actor = (viewer: ExplorerFixture["admin"]) => ({ ...viewer, ip: "192.0.2.10" });

  beforeAll(async () => {
    const url = await recreateDatabase(testDatabaseAdminUrl as string, DATABASE);
    process.env.DATABASE_URL = url;
    const boss = new PgBoss({ connectionString: url });
    await boss.start();
    await boss.createQueue("restore");
    await boss.stop({ graceful: false, wait: true });

    db = createDb(url);
    f = await createExplorerFixture(db);

    vi.resetModules();
    vi.stubEnv("RESTOW_DEMO", "true");
    service = await import("./service.js");
  }, 60_000);

  afterAll(async () => {
    vi.unstubAllEnvs();
    vi.resetModules();
    const shared = await import("../../db.js");
    await shared.db.$client.end();
    await db?.$client.end();
    await dropDatabase(testDatabaseAdminUrl as string, DATABASE);
  });

  afterEach(async () => {
    // Each test starts with no restore of its own tenant/queue in flight:
    // `assertDemoJobNotInFlight` looks at `jobs`, not `restoreJobs`.
    await db.delete(restoreJobs);
    await db.delete(jobs);
  });

  it("refuses a restore into the mailbox (original), download only", async () => {
    await expect(
      service.createRestore(
        db,
        f.tenantId,
        actor(f.anna),
        request({
          snapshotId: f.mailbox.second,
          selection: [{ path: "mail/Inbox" }],
          target: { type: "original" },
        }),
      ),
    ).rejects.toMatchObject({ status: 403, type: "urn:restow:problem:demo-read-only" });
  });

  it("refuses a restore into another account", async () => {
    await expect(
      service.createRestore(
        db,
        f.tenantId,
        actor(f.admin),
        request({
          snapshotId: f.mailbox.second,
          selection: [{ path: "mail/Inbox" }],
          target: { type: "other", accountId: "bob@contoso.test" },
        }),
      ),
    ).rejects.toMatchObject({ status: 403, type: "urn:restow:problem:demo-read-only" });
  });

  it("replaces reason, restoreFolderName and archiveName with fixed text", async () => {
    const created = await service.createRestore(
      db,
      f.tenantId,
      actor(f.admin),
      request({
        snapshotId: f.mailbox.second,
        selection: [{ path: "mail/Inbox" }],
        target: { type: "download" },
        reason: "look at anna's private mail",
        options: { restoreFolderName: "pwned", archiveName: "not-malware" },
      }),
    );
    const [stored] = await db.select().from(restoreJobs).where(eq(restoreJobs.id, created.id));
    expect(stored?.reason).toBe("Public demo restore");
    expect(stored?.sourceSelection).toMatchObject({
      options: { restoreFolderName: "Restored (Demo)", archiveName: "demo-restore" },
    });
  });

  it("allows only one restore in flight per tenant at a time", async () => {
    const first = await service.createRestore(
      db,
      f.tenantId,
      actor(f.anna),
      request({
        snapshotId: f.mailbox.second,
        selection: [{ path: "mail/Inbox" }],
        target: { type: "download" },
      }),
    );
    expect(first.status).toBe("queued");

    await expect(
      service.createRestore(
        db,
        f.tenantId,
        actor(f.anna),
        request({
          snapshotId: f.mailbox.second,
          selection: [{ path: "calendar" }],
          target: { type: "download" },
        }),
      ),
    ).rejects.toMatchObject({ status: 409, type: "urn:restow:problem:demo-job-in-progress" });

    await service.cancelRestore(db, f.tenantId, actor(f.anna), first.id);

    const second = await service.createRestore(
      db,
      f.tenantId,
      actor(f.anna),
      request({
        snapshotId: f.mailbox.second,
        selection: [{ path: "calendar" }],
        target: { type: "download" },
      }),
    );
    expect(second.status).toBe("queued");
  });
});
