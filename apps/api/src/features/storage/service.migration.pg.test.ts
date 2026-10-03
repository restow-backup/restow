/**
 * Postgres-backed coverage for the "replace the primary" flow
 * (docs/STORAGE.md): `createTarget` routing into `startReplacePrimary` for
 * both migration modes, `cancelMigration`, and the FK cleanup `deleteTarget`
 * does for finished migration rows. Local targets only (no S3 credentials),
 * so no secret store or KMS setup is needed.
 *
 * The database `restow_api_storage_migration_test` is created once and
 * migrated in `beforeAll`; `afterEach` clears `storage_targets`, `packs`,
 * `storage_migrations`, `jobs` and `audit_log` so every test starts from a
 * clean slate. Runs when RESTOW_TEST_DATABASE_URL points at a Postgres
 * server; without it the suite is skipped.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  InstallationDefaultResolver,
  LocalStorageBackend,
  manifestKey,
  packKey,
  partialManifestKey,
  sha256,
  wrappedKeyKey,
} from "@restow/core";
import {
  type Database,
  auditLog,
  createDb,
  jobs,
  packs,
  protectedObjects,
  providers,
  snapshots,
  sources,
  storageMigrations,
  storageTargets,
  tenantKeys,
  tenants,
} from "@restow/db";
import { eq } from "drizzle-orm";
import PgBoss from "pg-boss";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { setInstallationDefaultResolver } from "../../lib/installation-default.js";
import { ProblemError } from "../../problem.js";
import {
  dropDatabase,
  recreateDatabase,
  testDatabaseAdminUrl,
} from "../snapshots/testing/explorer-fixture.js";
import {
  cancelMigration,
  createTarget,
  deleteTarget,
  getTarget,
  listTargets,
  promoteTarget,
  retryMigration,
  updateTarget,
} from "./service.js";

// These suites set the installation default in the environment (STORAGE_*); read it from there,
// uncached, instead of from the installation pool of a configured server
// (lib/installation-default.ts).
beforeAll(() => setInstallationDefaultResolver(new InstallationDefaultResolver({ ttlMs: 0 })));
afterAll(() => setInstallationDefaultResolver(null));

const DATABASE = "restow_api_storage_migration_test";

describe.skipIf(!testDatabaseAdminUrl)("replace the primary: startReplacePrimary", () => {
  let db: Database;
  let tenantId: string;
  let root: string;

  const actor = { id: "u1", email: "admin@example.com", ip: "203.0.113.7", isProviderAdmin: true };

  beforeAll(async () => {
    const url = await recreateDatabase(testDatabaseAdminUrl as string, DATABASE);
    const boss = new PgBoss({ connectionString: url });
    await boss.start();
    await boss.createQueue("storage_migration");
    await boss.stop({ graceful: false, wait: true });
    db = createDb(url);
    const [provider] = await db.insert(providers).values({ name: "Provider" }).returning();
    const [tenant] = await db
      .insert(tenants)
      .values({ providerId: provider?.id as string, name: "Tenant", slug: "tenant" })
      .returning();
    tenantId = tenant?.id as string;
    // A "keep" switch verifies the target is reachable before it commits
    // (startReplacePrimaryTx, "keep"): give it a real, writable directory
    // rather than a fake /mnt path.
    root = await mkdtemp(join(tmpdir(), "restow-storage-migration-api-"));
  }, 60_000);

  afterEach(async () => {
    await db.delete(jobs).where(eq(jobs.tenantId, tenantId));
    await db.delete(storageMigrations).where(eq(storageMigrations.tenantId, tenantId));
    await db.delete(storageTargets).where(eq(storageTargets.tenantId, tenantId));
    await db.delete(packs).where(eq(packs.tenantId, tenantId));
  });

  afterAll(async () => {
    await db.$client.end();
    await dropDatabase(testDatabaseAdminUrl as string, DATABASE);
    if (root) {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("switches the primary immediately for 'keep' against the installation default, leaving a retired placeholder as 'previous'", async () => {
    await db
      .insert(packs)
      .values({ tenantId, path: "tenants/x/packs/a", sha256: "a".repeat(64), size: 10 });

    const dto = await createTarget(
      db,
      tenantId,
      {
        kind: "local",
        name: "New primary",
        role: "primary",
        config: { basePath: join(root, "new-primary") },
        migrationMode: "keep",
      },
      actor,
    );

    // The new target is primary right away: no background job, nothing to cancel.
    expect(dto.role).toBe("primary");
    expect(dto.migration).toMatchObject({ mode: "keep", status: "completed", cancellable: false });

    const rows = await db
      .select()
      .from(storageTargets)
      .where(eq(storageTargets.tenantId, tenantId));
    // The new primary plus a placeholder row standing in for the retired
    // installation default (insertRetiredInstallationDefault), now "previous".
    expect(rows).toHaveLength(2);
    const previousRow = rows.find((row) => row.role === "previous");
    expect(previousRow).toMatchObject({ kind: "installation_default", role: "previous" });

    const migrations = await db
      .select()
      .from(storageMigrations)
      .where(eq(storageMigrations.tenantId, tenantId));
    expect(migrations).toHaveLength(1);
    expect(migrations[0]).toMatchObject({
      mode: "keep",
      status: "completed",
      sourceTargetId: previousRow?.id,
      destinationTargetId: dto.id,
      jobId: null,
    });

    const audited = await db.select().from(auditLog).where(eq(auditLog.tenantId, tenantId));
    const started = audited.find((entry) => entry.action === "storage.migration.started");
    expect(started).toBeDefined();
    expect(started?.details).toMatchObject({ mode: "keep", instant: true });
  });

  it("switches the primary immediately for 'keep' against an existing primary row, leaving it as 'previous'", async () => {
    const [oldPrimary] = await db
      .insert(storageTargets)
      .values({
        tenantId,
        kind: "local",
        role: "primary",
        config: { basePath: "/mnt/old-primary" },
      })
      .returning();
    await db
      .insert(packs)
      .values({ tenantId, path: "tenants/x/packs/a", sha256: "a".repeat(64), size: 10 });

    const dto = await createTarget(
      db,
      tenantId,
      {
        kind: "local",
        name: "New primary",
        role: "primary",
        config: { basePath: join(root, "new-primary-2") },
        migrationMode: "keep",
      },
      actor,
    );
    expect(dto.role).toBe("primary");

    // The old primary is retired, not deleted: it stays attached, read-only.
    const [retired] = await db
      .select()
      .from(storageTargets)
      .where(eq(storageTargets.id, oldPrimary?.id as string));
    expect(retired?.role).toBe("previous");
    expect(retired?.config).toMatchObject({ basePath: "/mnt/old-primary" });

    const [migration] = await db
      .select()
      .from(storageMigrations)
      .where(eq(storageMigrations.destinationTargetId, dto.id));
    expect(migration).toMatchObject({
      mode: "keep",
      status: "completed",
      sourceTargetId: oldPrimary?.id,
    });
  });

  it("refuses a 'keep' switch while a backup, archive, retention, scrub, restore or storage_migration job is queued or active, and allows it once that job ends", async () => {
    await db
      .insert(storageTargets)
      .values({
        tenantId,
        kind: "local",
        role: "primary",
        config: { basePath: "/mnt/old-primary-blocked" },
      })
      .returning();
    await db
      .insert(packs)
      .values({ tenantId, path: "tenants/x/packs/a", sha256: "a".repeat(64), size: 10 });

    // "restore" is here too: its download engine writes the export ZIP
    // straight to the primary (core `restore/download.ts`), so an
    // already-running or queued restore job must block "keep" exactly like
    // the queues that only ever write.
    for (const queue of [
      "backup",
      "archive",
      "retention",
      "scrub",
      "storage_migration",
      "restore",
    ] as const) {
      for (const status of ["queued", "active"] as const) {
        const [jobRow] = await db.insert(jobs).values({ tenantId, queue, status }).returning();

        const error = await createTarget(
          db,
          tenantId,
          {
            kind: "local",
            name: "New primary",
            role: "primary",
            config: { basePath: join(root, `blocked-${queue}-${status}`) },
            migrationMode: "keep",
          },
          actor,
        ).catch((e) => e);
        expect(error).toBeInstanceOf(ProblemError);
        expect((error as ProblemError).status).toBe(409);
        expect((error as ProblemError).extensions?.code).toBe("keep_blocked_by_active_job");

        // Nothing switched: the old primary is exactly as it was.
        const rows = await db
          .select()
          .from(storageTargets)
          .where(eq(storageTargets.tenantId, tenantId));
        expect(rows).toHaveLength(1);
        expect(rows[0]?.role).toBe("primary");

        await db.delete(jobs).where(eq(jobs.id, jobRow?.id as string));
      }
    }

    // The blocking job is gone (completed, failed or cancelled): the same
    // request now switches the primary.
    const [finishedJob] = await db
      .insert(jobs)
      .values({ tenantId, queue: "backup", status: "completed" })
      .returning();
    const dto = await createTarget(
      db,
      tenantId,
      {
        kind: "local",
        name: "New primary",
        role: "primary",
        config: { basePath: join(root, "unblocked") },
        migrationMode: "keep",
      },
      actor,
    );
    expect(dto.role).toBe("primary");
    expect(dto.migration).toMatchObject({ mode: "keep", status: "completed" });
    await db.delete(jobs).where(eq(jobs.id, finishedJob?.id as string));
  });

  it("queues a background job for 'move', inserting the destination as a live copy", async () => {
    await db
      .insert(packs)
      .values({ tenantId, path: "tenants/x/packs/a", sha256: "a".repeat(64), size: 10 });

    const dto = await createTarget(
      db,
      tenantId,
      {
        kind: "local",
        name: "New primary",
        role: "primary",
        config: { basePath: "/mnt/new-primary" },
        migrationMode: "move",
      },
      actor,
    );

    // Still a copy: the worker performs the switch once verified.
    expect(dto.role).toBe("copy");
    expect(dto.migration).toMatchObject({ mode: "move", status: "queued", cancellable: true });
    expect(dto.migration?.etaSeconds).toBeNull();

    const [migration] = await db
      .select()
      .from(storageMigrations)
      .where(eq(storageMigrations.destinationTargetId, dto.id));
    expect(migration).toMatchObject({ mode: "move", status: "queued", sourceTargetId: null });
    expect(migration?.jobId).not.toBeNull();

    const [jobRow] = await db
      .select()
      .from(jobs)
      .where(eq(jobs.id, migration?.jobId as string));
    expect(jobRow).toMatchObject({ queue: "storage_migration", status: "queued" });
    expect((jobRow?.payload as { migrationId?: string })?.migrationId).toBe(migration?.id);
  });

  it("falls through to an ordinary create when the tenant has nothing to replace yet", async () => {
    const dto = await createTarget(
      db,
      tenantId,
      {
        kind: "local",
        name: "First primary",
        role: "primary",
        config: { basePath: "/mnt/first" },
        migrationMode: "move",
      },
      actor,
    );
    expect(dto.role).toBe("primary");
    expect(dto.migration).toBeNull();
    const migrations = await db
      .select()
      .from(storageMigrations)
      .where(eq(storageMigrations.tenantId, tenantId));
    expect(migrations).toHaveLength(0);
  });

  it("refuses a second migration while one is already running", async () => {
    await db
      .insert(packs)
      .values({ tenantId, path: "tenants/x/packs/a", sha256: "a".repeat(64), size: 10 });
    await createTarget(
      db,
      tenantId,
      {
        kind: "local",
        name: "First replacement",
        role: "primary",
        config: { basePath: "/mnt/replacement-1" },
        migrationMode: "move",
      },
      actor,
    );

    const error = await createTarget(
      db,
      tenantId,
      {
        kind: "local",
        name: "Second replacement",
        role: "primary",
        config: { basePath: "/mnt/replacement-2" },
        migrationMode: "move",
      },
      actor,
    ).catch((e) => e);
    expect(error).toBeInstanceOf(ProblemError);
    expect((error as ProblemError).status).toBe(409);
    expect((error as ProblemError).extensions?.code).toBe("migration_in_progress");
  });
});

describe.skipIf(!testDatabaseAdminUrl)("cancelMigration", () => {
  let db: Database;
  let tenantId: string;
  const actor = { id: "u1", email: "admin@example.com", ip: null, isProviderAdmin: true };

  beforeAll(async () => {
    const url = await recreateDatabase(testDatabaseAdminUrl as string, `${DATABASE}_cancel`);
    const boss = new PgBoss({ connectionString: url });
    await boss.start();
    await boss.createQueue("storage_migration");
    await boss.stop({ graceful: false, wait: true });
    db = createDb(url);
    const [provider] = await db.insert(providers).values({ name: "Provider" }).returning();
    const [tenant] = await db
      .insert(tenants)
      .values({ providerId: provider?.id as string, name: "Tenant", slug: "tenant" })
      .returning();
    tenantId = tenant?.id as string;
  }, 60_000);

  afterEach(async () => {
    await db.delete(storageMigrations).where(eq(storageMigrations.tenantId, tenantId));
    await db.delete(jobs).where(eq(jobs.tenantId, tenantId));
    await db.delete(storageTargets).where(eq(storageTargets.tenantId, tenantId));
    await db.delete(packs).where(eq(packs.tenantId, tenantId));
  });

  afterAll(async () => {
    await db.$client.end();
    await dropDatabase(testDatabaseAdminUrl as string, `${DATABASE}_cancel`);
  });

  it("finishes a queued migration right away and withdraws its job", async () => {
    await db
      .insert(packs)
      .values({ tenantId, path: "tenants/x/packs/a", sha256: "a".repeat(64), size: 10 });
    const dto = await createTarget(
      db,
      tenantId,
      {
        kind: "local",
        name: "New primary",
        role: "primary",
        config: { basePath: "/mnt/new-primary" },
        migrationMode: "move",
      },
      actor,
    );

    const cancelled = await cancelMigration(db, tenantId, dto.id, actor);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.cancellable).toBe(false);

    const [jobRow] = await db.select().from(jobs).where(eq(jobs.tenantId, tenantId));
    expect(jobRow?.status).toBe("cancelled");
  });

  it("refuses to cancel a target with no migration, and a finished one", async () => {
    const [target] = await db
      .insert(storageTargets)
      .values({ tenantId, kind: "local", role: "copy", config: { basePath: "/mnt/plain-copy" } })
      .returning();
    const error = await cancelMigration(db, tenantId, target?.id as string, actor).catch((e) => e);
    expect(error).toBeInstanceOf(ProblemError);
    expect((error as ProblemError).status).toBe(404);
  });

  it("audits the resulting status next to the request", async () => {
    await db
      .insert(packs)
      .values({ tenantId, path: "tenants/x/packs/a", sha256: "a".repeat(64), size: 10 });
    const dto = await createTarget(
      db,
      tenantId,
      {
        kind: "local",
        name: "New primary",
        role: "primary",
        config: { basePath: "/mnt/audited" },
        migrationMode: "move",
      },
      actor,
    );

    await cancelMigration(db, tenantId, dto.id, actor);

    const audited = await db.select().from(auditLog).where(eq(auditLog.tenantId, tenantId));
    const cancelEntry = audited.find((entry) => entry.action === "storage.migration.cancelled");
    expect(cancelEntry).toBeDefined();
    expect(cancelEntry?.details).toMatchObject({ resultStatus: "cancelled" });
  });

  it("finalizes a migration whose job already failed for good, instead of leaving it stuck", async () => {
    await db
      .insert(packs)
      .values({ tenantId, path: "tenants/x/packs/a", sha256: "a".repeat(64), size: 10 });
    const [source] = await db
      .insert(storageTargets)
      .values({
        tenantId,
        kind: "local",
        role: "primary",
        config: { basePath: "/mnt/stuck-source" },
      })
      .returning();
    const [destination] = await db
      .insert(storageTargets)
      .values({ tenantId, kind: "local", role: "copy", config: { basePath: "/mnt/stuck-dest" } })
      .returning();
    const jobId = randomUUID();
    await db.insert(jobs).values({
      id: jobId,
      tenantId,
      queue: "storage_migration",
      status: "failed",
      errorMessage: "S3StorageBackend: connect ECONNREFUSED",
      payload: { jobId, tenantId },
      startedAt: new Date(),
      completedAt: new Date(),
    });
    const [migration] = await db
      .insert(storageMigrations)
      .values({
        tenantId,
        sourceTargetId: source?.id as string,
        destinationTargetId: destination?.id as string,
        mode: "move",
        status: "copying",
        jobId,
      })
      .returning();

    // Pg-boss's retries are exhausted (the destination stayed unreachable);
    // nothing ever told storage_migrations, so it still reads "copying". The
    // cancel action is how an admin recovers it.
    const result = await cancelMigration(db, tenantId, destination?.id as string, actor);
    expect(result.status).toBe("failed");
    expect(result.errorMessage).toContain("ECONNREFUSED");
    expect(result.cancellable).toBe(false);

    const [row] = await db
      .select()
      .from(storageMigrations)
      .where(eq(storageMigrations.id, migration?.id as string));
    expect(row).toMatchObject({ status: "failed" });
    expect(row?.finishedAt).not.toBeNull();
  });

  it("shows a migration whose job already died as stalled before anyone clicks cancel", async () => {
    await db
      .insert(packs)
      .values({ tenantId, path: "tenants/x/packs/a", sha256: "a".repeat(64), size: 10 });
    const [source] = await db
      .insert(storageTargets)
      .values({
        tenantId,
        kind: "local",
        role: "primary",
        config: { basePath: "/mnt/stalled-src" },
      })
      .returning();
    const [destination] = await db
      .insert(storageTargets)
      .values({ tenantId, kind: "local", role: "copy", config: { basePath: "/mnt/stalled-dst" } })
      .returning();
    const jobId = randomUUID();
    await db.insert(jobs).values({
      id: jobId,
      tenantId,
      queue: "storage_migration",
      status: "failed",
      errorMessage: "S3StorageBackend: connect ECONNREFUSED",
      payload: { jobId, tenantId },
      startedAt: new Date(),
      completedAt: new Date(),
    });
    await db.insert(storageMigrations).values({
      tenantId,
      sourceTargetId: source?.id as string,
      destinationTargetId: destination?.id as string,
      mode: "move",
      status: "copying",
      jobId,
    });

    // Nothing has reconciled the row yet: it is still "copying" in the
    // database, but listing and reading the target must not repeat that as
    // if the job were still running.
    const list = await listTargets(db, tenantId, actor);
    const listed = list.items.find((item) => item.id === destination?.id);
    expect(listed?.migration).toMatchObject({
      status: "copying",
      stalled: true,
      etaSeconds: null,
      errorMessage: expect.stringContaining("ECONNREFUSED"),
      cancellable: true,
    });

    const single = await getTarget(db, tenantId, destination?.id as string, actor);
    expect(single.migration).toMatchObject({ stalled: true, cancellable: true });
  });

  it("does not cancel a migration that is already switching", async () => {
    await db
      .insert(packs)
      .values({ tenantId, path: "tenants/x/packs/a", sha256: "a".repeat(64), size: 10 });
    const [destination] = await db
      .insert(storageTargets)
      .values({
        tenantId,
        kind: "local",
        role: "copy",
        config: { basePath: "/mnt/switching-dest" },
      })
      .returning();
    const jobId = randomUUID();
    await db.insert(jobs).values({
      id: jobId,
      tenantId,
      queue: "storage_migration",
      status: "active",
      payload: { jobId, tenantId },
      startedAt: new Date(),
    });
    await db.insert(storageMigrations).values({
      tenantId,
      sourceTargetId: null,
      destinationTargetId: destination?.id as string,
      mode: "move",
      status: "switching",
      jobId,
    });

    const error = await cancelMigration(db, tenantId, destination?.id as string, actor).catch(
      (e) => e,
    );
    expect(error).toBeInstanceOf(ProblemError);
    expect((error as ProblemError).status).toBe(409);
    expect((error as ProblemError).extensions?.status).toBe("switching");

    const [jobRow] = await db.select().from(jobs).where(eq(jobs.id, jobId));
    // Untouched: the job (and the switch it is committing) was not flagged.
    expect(jobRow?.status).toBe("active");
  });
});

describe.skipIf(!testDatabaseAdminUrl)("retryMigration", () => {
  let db: Database;
  let tenantId: string;
  const actor = { id: "u1", email: "admin@example.com", ip: null, isProviderAdmin: true };

  beforeAll(async () => {
    const url = await recreateDatabase(testDatabaseAdminUrl as string, `${DATABASE}_retry`);
    const boss = new PgBoss({ connectionString: url });
    await boss.start();
    await boss.createQueue("storage_migration");
    await boss.stop({ graceful: false, wait: true });
    db = createDb(url);
    const [provider] = await db.insert(providers).values({ name: "Provider" }).returning();
    const [tenant] = await db
      .insert(tenants)
      .values({ providerId: provider?.id as string, name: "Tenant", slug: "tenant" })
      .returning();
    tenantId = tenant?.id as string;
  }, 60_000);

  afterEach(async () => {
    await db.delete(storageMigrations).where(eq(storageMigrations.tenantId, tenantId));
    await db.delete(jobs).where(eq(jobs.tenantId, tenantId));
    await db.delete(storageTargets).where(eq(storageTargets.tenantId, tenantId));
    await db.delete(packs).where(eq(packs.tenantId, tenantId));
  });

  afterAll(async () => {
    await db.$client.end();
    await dropDatabase(testDatabaseAdminUrl as string, `${DATABASE}_retry`);
  });

  it("re-queues a failed move with a fresh job, without deleting the destination", async () => {
    await db
      .insert(packs)
      .values({ tenantId, path: "tenants/x/packs/a", sha256: "a".repeat(64), size: 10 });
    const [destination] = await db
      .insert(storageTargets)
      .values({ tenantId, kind: "local", role: "copy", config: { basePath: "/mnt/retry-dest" } })
      .returning();
    const oldJobId = randomUUID();
    await db.insert(jobs).values({
      id: oldJobId,
      tenantId,
      queue: "storage_migration",
      status: "failed",
      errorMessage: "Copying found 1 object(s) that did not verify",
      payload: { jobId: oldJobId, tenantId },
      startedAt: new Date(),
      completedAt: new Date(),
    });
    const [migration] = await db
      .insert(storageMigrations)
      .values({
        tenantId,
        sourceTargetId: null,
        destinationTargetId: destination?.id as string,
        mode: "move",
        status: "failed",
        jobId: oldJobId,
        errorMessage: "Copying found 1 object(s) that did not verify",
        objectsDone: 3,
        bytesDone: 900,
      })
      .returning();

    const retried = await retryMigration(db, tenantId, destination?.id as string, actor);
    expect(retried.status).toBe("queued");
    expect(retried.errorMessage).toBeNull();
    expect(retried.objectsDone).toBe(0);

    const [row] = await db
      .select()
      .from(storageMigrations)
      .where(eq(storageMigrations.id, migration?.id as string));
    expect(row?.jobId).not.toBe(oldJobId);
    const [newJob] = await db
      .select()
      .from(jobs)
      .where(eq(jobs.id, row?.jobId as string));
    expect(newJob).toMatchObject({ queue: "storage_migration", status: "queued" });

    const audited = await db.select().from(auditLog).where(eq(auditLog.tenantId, tenantId));
    const started = audited.filter((entry) => entry.action === "storage.migration.started");
    expect(started.some((entry) => (entry.details as { retry?: boolean })?.retry === true)).toBe(
      true,
    );
  });

  it("refuses to retry a migration that is not a failed move", async () => {
    const [destination] = await db
      .insert(storageTargets)
      .values({
        tenantId,
        kind: "local",
        role: "copy",
        config: { basePath: "/mnt/retry-move-only" },
      })
      .returning();
    await db.insert(storageMigrations).values({
      tenantId,
      sourceTargetId: null,
      destinationTargetId: destination?.id as string,
      mode: "move",
      status: "copying",
    });
    const error = await retryMigration(db, tenantId, destination?.id as string, actor).catch(
      (e) => e,
    );
    expect(error).toBeInstanceOf(ProblemError);
    expect((error as ProblemError).status).toBe(409);
  });
});

describe.skipIf(!testDatabaseAdminUrl)(
  "updateTarget and promoteTarget refuse changes while a migration is unfinished",
  () => {
    let db: Database;
    let tenantId: string;
    const actor = { id: "u1", email: "admin@example.com", ip: null, isProviderAdmin: true };

    beforeAll(async () => {
      const url = await recreateDatabase(testDatabaseAdminUrl as string, `${DATABASE}_guard`);
      const boss = new PgBoss({ connectionString: url });
      await boss.start();
      await boss.createQueue("storage_migration");
      await boss.stop({ graceful: false, wait: true });
      db = createDb(url);
      const [provider] = await db.insert(providers).values({ name: "Provider" }).returning();
      const [tenant] = await db
        .insert(tenants)
        .values({ providerId: provider?.id as string, name: "Tenant", slug: "tenant" })
        .returning();
      tenantId = tenant?.id as string;
    }, 60_000);

    afterEach(async () => {
      await db.delete(storageMigrations).where(eq(storageMigrations.tenantId, tenantId));
      await db.delete(jobs).where(eq(jobs.tenantId, tenantId));
      await db.delete(storageTargets).where(eq(storageTargets.tenantId, tenantId));
      await db.delete(packs).where(eq(packs.tenantId, tenantId));
    });

    afterAll(async () => {
      await db.$client.end();
      await dropDatabase(testDatabaseAdminUrl as string, `${DATABASE}_guard`);
    });

    /** A primary, a copy, and an unfinished "move" migration between two other rows. */
    async function seedMidMigration(): Promise<{ primaryId: string; copyId: string }> {
      const [primary] = await db
        .insert(storageTargets)
        .values({ tenantId, kind: "local", role: "primary", config: { basePath: "/mnt/primary" } })
        .returning();
      const [copy] = await db
        .insert(storageTargets)
        .values({
          tenantId,
          kind: "local",
          role: "copy",
          config: { basePath: "/mnt/copy" },
          status: "ok",
        })
        .returning();
      const [migrationSource] = await db
        .insert(storageTargets)
        .values({
          tenantId,
          kind: "local",
          role: "copy",
          config: { basePath: "/mnt/migration-source" },
        })
        .returning();
      const [migrationDestination] = await db
        .insert(storageTargets)
        .values({
          tenantId,
          kind: "local",
          role: "copy",
          config: { basePath: "/mnt/migration-dest" },
        })
        .returning();
      await db.insert(storageMigrations).values({
        tenantId,
        sourceTargetId: migrationSource?.id as string,
        destinationTargetId: migrationDestination?.id as string,
        mode: "move",
        status: "copying",
      });
      return { primaryId: primary?.id as string, copyId: copy?.id as string };
    }

    it("refuses to move a copy's location while a migration is unfinished", async () => {
      const { copyId } = await seedMidMigration();
      const error = await updateTarget(
        db,
        tenantId,
        copyId,
        { config: { basePath: "/mnt/copy-moved" } },
        actor,
      ).catch((e) => e);
      expect(error).toBeInstanceOf(ProblemError);
      expect((error as ProblemError).extensions?.code).toBe("migration_in_progress");
      const [unchanged] = await db
        .select()
        .from(storageTargets)
        .where(eq(storageTargets.id, copyId));
      expect((unchanged?.config as { basePath?: string })?.basePath).toBe("/mnt/copy");
    });

    it("still allows a name-only edit while a migration is unfinished", async () => {
      const { copyId } = await seedMidMigration();
      const updated = await updateTarget(db, tenantId, copyId, { name: "Renamed" }, actor);
      expect(updated.name).toBe("Renamed");
    });

    it("refuses to promote a copy to primary while a migration is unfinished", async () => {
      const { copyId } = await seedMidMigration();
      const error = await promoteTarget(db, tenantId, copyId, actor).catch((e) => e);
      expect(error).toBeInstanceOf(ProblemError);
      expect((error as ProblemError).extensions?.code).toBe("migration_in_progress");
      const [unchanged] = await db
        .select()
        .from(storageTargets)
        .where(eq(storageTargets.id, copyId));
      expect(unchanged?.role).toBe("copy");
    });
  },
);

describe.skipIf(!testDatabaseAdminUrl)("deleteTarget: finished migration references", () => {
  let db: Database;
  let tenantId: string;
  let root: string;
  const actor = { id: "u1", email: "admin@example.com", ip: null, isProviderAdmin: true };

  beforeAll(async () => {
    const url = await recreateDatabase(testDatabaseAdminUrl as string, `${DATABASE}_delete`);
    const boss = new PgBoss({ connectionString: url });
    await boss.start();
    await boss.createQueue("storage_migration");
    await boss.stop({ graceful: false, wait: true });
    db = createDb(url);
    const [provider] = await db.insert(providers).values({ name: "Provider" }).returning();
    const [tenant] = await db
      .insert(tenants)
      .values({ providerId: provider?.id as string, name: "Tenant", slug: "tenant" })
      .returning();
    tenantId = tenant?.id as string;
    root = await mkdtemp(join(tmpdir(), "restow-storage-migration-api-delete-"));
  }, 60_000);

  afterEach(async () => {
    await db.delete(storageMigrations).where(eq(storageMigrations.tenantId, tenantId));
    await db.delete(jobs).where(eq(jobs.tenantId, tenantId));
    await db.delete(storageTargets).where(eq(storageTargets.tenantId, tenantId));
    await db.delete(packs).where(eq(packs.tenantId, tenantId));
    // Cascades onto protectedObjects, then onto snapshots.
    await db.delete(sources).where(eq(sources.tenantId, tenantId));
    await db.delete(tenantKeys).where(eq(tenantKeys.tenantId, tenantId));
  });

  afterAll(async () => {
    await db.$client.end();
    await dropDatabase(testDatabaseAdminUrl as string, `${DATABASE}_delete`);
    if (root) {
      await rm(root, { recursive: true, force: true });
    }
  });

  /**
   * A `previous` target and the completed migration that retired it, set up
   * directly rather than through a live "keep" replacement, so the removal
   * guard below is tested on its own, without depending on the replacement
   * flow covered elsewhere in this file.
   */
  async function seedRetiredPrevious(options: {
    readonly legacyOnPrimaryToo: boolean;
  }): Promise<{
    previousId: string;
    primaryId: string;
    packPath: string;
    previousDir: string;
  }> {
    const previousDir = join(root, `previous-${randomUUID()}`);
    const primaryDir = join(root, `primary-${randomUUID()}`);
    const [previous] = await db
      .insert(storageTargets)
      .values({ tenantId, kind: "local", role: "previous", config: { basePath: previousDir } })
      .returning();
    const [primary] = await db
      .insert(storageTargets)
      .values({ tenantId, kind: "local", role: "primary", config: { basePath: primaryDir } })
      .returning();
    await db.insert(storageMigrations).values({
      tenantId,
      sourceTargetId: previous?.id as string,
      destinationTargetId: primary?.id as string,
      mode: "keep",
      status: "completed",
      startedAt: new Date(),
      switchedAt: new Date(),
      finishedAt: new Date(),
    });

    const content = Buffer.from("a pack left behind by an earlier keep switch");
    const packPath = packKey(tenantId, randomUUID());
    await new LocalStorageBackend(previousDir).put(packPath, content);
    if (options.legacyOnPrimaryToo) {
      await new LocalStorageBackend(primaryDir).put(packPath, content);
    }
    await db.insert(packs).values({
      tenantId,
      path: packPath,
      size: content.length,
      sha256: sha256(content).toString("hex"),
    });
    return {
      previousId: previous?.id as string,
      primaryId: primary?.id as string,
      packPath,
      previousDir,
    };
  }

  /**
   * A committed, active snapshot row bound to `manifestPath` — what makes a
   * manifest key "still live" under the fixed exclusive-objects check. Every
   * snapshot needs a protected object, and every protected object a source,
   * so both are seeded here with the minimum the schema requires.
   */
  async function seedActiveSnapshot(options: {
    readonly manifestPath: string;
    readonly status?: "active" | "pruned";
  }): Promise<string> {
    const [source] = await db
      .insert(sources)
      .values({ tenantId, kind: "imap", name: `Source ${randomUUID()}` })
      .returning();
    const [object] = await db
      .insert(protectedObjects)
      .values({
        tenantId,
        sourceId: source?.id as string,
        kind: "mailbox",
        externalId: `mailbox-${randomUUID()}@example.test`,
      })
      .returning();
    const [snapshot] = await db
      .insert(snapshots)
      .values({
        tenantId,
        protectedObjectId: object?.id as string,
        sequence: 1,
        manifestPath: options.manifestPath,
        status: options.status ?? "active",
        completedAt: new Date(),
      })
      .returning();
    return snapshot?.id as string;
  }

  it("refuses to remove a 'previous' target while it still holds packs no other target has", async () => {
    const { previousId } = await seedRetiredPrevious({ legacyOnPrimaryToo: false });

    const error = await deleteTarget(db, tenantId, previousId, actor).catch((e) => e);
    expect(error).toBeInstanceOf(ProblemError);
    expect((error as ProblemError).status).toBe(409);
    expect((error as ProblemError).extensions?.code).toBe("previous_holds_exclusive_data");

    // Untouched: the target and the migration that explains it are both still there.
    const [stillThere] = await db
      .select()
      .from(storageTargets)
      .where(eq(storageTargets.id, previousId));
    expect(stillThere?.role).toBe("previous");
    const migrations = await db
      .select()
      .from(storageMigrations)
      .where(eq(storageMigrations.tenantId, tenantId));
    expect(migrations).toHaveLength(1);
  });

  it("refuses to remove a 'previous' target that holds a manifest no other target has, even with every pack elsewhere", async () => {
    const previousDir = join(root, `previous-manifest-${randomUUID()}`);
    const primaryDir = join(root, `primary-manifest-${randomUUID()}`);
    const [previous] = await db
      .insert(storageTargets)
      .values({ tenantId, kind: "local", role: "previous", config: { basePath: previousDir } })
      .returning();
    await db
      .insert(storageTargets)
      .values({ tenantId, kind: "local", role: "primary", config: { basePath: primaryDir } })
      .returning();
    // The pack this manifest would point at is already on both locations
    // (as a later "move" would leave it); only the manifest itself never
    // made it across.
    const content = Buffer.from("a shared pack");
    const packPath = packKey(tenantId, randomUUID());
    await new LocalStorageBackend(previousDir).put(packPath, content);
    await new LocalStorageBackend(primaryDir).put(packPath, content);
    await db.insert(packs).values({
      tenantId,
      path: packPath,
      size: content.length,
      sha256: sha256(content).toString("hex"),
    });
    // The manifest belongs to a snapshot that is still active: retention has
    // not touched it, so it is exactly what a "keep" switch would leave
    // stranded, not garbage a housekeeping job already made obsolete.
    const snapshotId = randomUUID();
    const path = manifestKey(tenantId, snapshotId);
    await new LocalStorageBackend(previousDir).put(
      path,
      Buffer.from("a manifest only the retired target has"),
    );
    await seedActiveSnapshot({ manifestPath: path });

    const error = await deleteTarget(db, tenantId, previous?.id as string, actor).catch((e) => e);
    expect(error).toBeInstanceOf(ProblemError);
    expect((error as ProblemError).status).toBe(409);
    expect((error as ProblemError).extensions?.code).toBe("previous_holds_exclusive_data");
  });

  it("removes a 'previous' target and clears its finished migration once nothing is exclusive there", async () => {
    // The same pack a later "move" would have copied onto the primary too:
    // nothing left that only the retired target holds.
    const { previousId, primaryId } = await seedRetiredPrevious({ legacyOnPrimaryToo: true });

    await deleteTarget(db, tenantId, previousId, actor);

    const remaining = await db
      .select()
      .from(storageTargets)
      .where(eq(storageTargets.tenantId, tenantId));
    expect(remaining.map((row) => row.id)).toEqual([primaryId]);
    const migrations = await db
      .select()
      .from(storageMigrations)
      .where(eq(storageMigrations.tenantId, tenantId));
    expect(migrations).toHaveLength(0);
  });

  it("removes a 'previous' target whose only leftovers are garbage retention and GC could never reach there", async () => {
    // Retention (apps/worker/src/handlers/retention.ts) and GC
    // (packages/core/src/verify/gc.ts) only ever delete from the current
    // primary and copies, never from a retired `previous` target. Before this
    // fix, none of the three kinds of leftovers below could ever be cleared:
    // the first prune or scrub after a "move" switch left them stranded, and
    // the exclusive-objects check counted every one of them as a reason to
    // keep the target forever.
    const previousDir = join(root, `previous-garbage-${randomUUID()}`);
    const primaryDir = join(root, `primary-garbage-${randomUUID()}`);
    const [previous] = await db
      .insert(storageTargets)
      .values({ tenantId, kind: "local", role: "previous", config: { basePath: previousDir } })
      .returning();
    const [primary] = await db
      .insert(storageTargets)
      .values({ tenantId, kind: "local", role: "primary", config: { basePath: primaryDir } })
      .returning();
    await db.insert(storageMigrations).values({
      tenantId,
      sourceTargetId: previous?.id as string,
      destinationTargetId: primary?.id as string,
      mode: "keep",
      status: "completed",
      startedAt: new Date(),
      switchedAt: new Date(),
      finishedAt: new Date(),
    });
    const previousStorage = new LocalStorageBackend(previousDir);

    // 1. A pack GC already repacked or dropped: gone from the `packs` index,
    //    still physically sitting on the retired target.
    const orphanPack = packKey(tenantId, randomUUID());
    await previousStorage.put(orphanPack, Buffer.from("a pack GC already superseded"));

    // 2. The manifest of a snapshot retention already pruned.
    const prunedSnapshotManifest = manifestKey(tenantId, randomUUID());
    await previousStorage.put(
      prunedSnapshotManifest,
      Buffer.from("the manifest of a snapshot retention pruned"),
    );
    await seedActiveSnapshot({ manifestPath: prunedSnapshotManifest, status: "pruned" });

    // 3. An abandoned `.partial` checkpoint no retry will ever resume.
    const abandonedCheckpoint = partialManifestKey(tenantId, randomUUID());
    await previousStorage.put(abandonedCheckpoint, Buffer.from("an abandoned checkpoint"));

    // 4. A wrapped key version no `tenant_keys` row names any more.
    const orphanKey = wrappedKeyKey(tenantId, 99);
    await previousStorage.put(orphanKey, Buffer.from("a superseded wrapped key"));

    await deleteTarget(db, tenantId, previous?.id as string, actor);

    const remaining = await db
      .select()
      .from(storageTargets)
      .where(eq(storageTargets.tenantId, tenantId));
    expect(remaining.map((row) => row.id)).toEqual([primary?.id]);
  });

  it("still refuses removal once a live pack sits alongside the garbage", async () => {
    // Garbage alone must not block the delete, but a still-needed pack next
    // to it must keep blocking it exactly as before.
    const { previousId, previousDir } = await seedRetiredPrevious({ legacyOnPrimaryToo: false });
    await new LocalStorageBackend(previousDir).put(
      packKey(tenantId, randomUUID()),
      Buffer.from("garbage no index row references any more"),
    );

    const error = await deleteTarget(db, tenantId, previousId, actor).catch((e) => e);
    expect(error).toBeInstanceOf(ProblemError);
    expect((error as ProblemError).status).toBe(409);
    expect((error as ProblemError).extensions?.code).toBe("previous_holds_exclusive_data");
  });

  it("removes a retired installation-default placeholder once nothing exclusive is left on the environment default", async () => {
    // A "keep" switch away from the installation default leaves a
    // placeholder with no addressing of its own (insertRetiredInstallationDefault):
    // its real location is the environment default, not a stored config.
    const envDefaultDir = join(root, `env-default-${randomUUID()}`);
    const newPrimaryDir = join(root, `installation-default-new-primary-${randomUUID()}`);
    const deps = { env: { STORAGE_TARGET: "local", STORAGE_LOCAL_PATH: envDefaultDir } };

    const [placeholder] = await db
      .insert(storageTargets)
      .values({ tenantId, name: null, kind: "installation_default", role: "previous", config: {} })
      .returning();
    const [primary] = await db
      .insert(storageTargets)
      .values({ tenantId, kind: "local", role: "primary", config: { basePath: newPrimaryDir } })
      .returning();
    await db.insert(storageMigrations).values({
      tenantId,
      sourceTargetId: placeholder?.id as string,
      destinationTargetId: primary?.id as string,
      mode: "keep",
      status: "completed",
      startedAt: new Date(),
      switchedAt: new Date(),
      finishedAt: new Date(),
    });

    const content = Buffer.from("a pack the installation default held before the keep switch");
    const packPath = packKey(tenantId, randomUUID());
    await new LocalStorageBackend(envDefaultDir).put(packPath, content);
    await db.insert(packs).values({
      tenantId,
      path: packPath,
      size: content.length,
      sha256: sha256(content).toString("hex"),
    });

    // Before this fix, opening the placeholder to check for exclusive data
    // rejected it outright as an "unknown_kind" (409 config-invalid): the
    // placeholder could never be deleted, whatever it held. It must now
    // report the real reason instead — this pack still only lives on the
    // environment default.
    const blocked = await deleteTarget(db, tenantId, placeholder?.id as string, actor, deps).catch(
      (e: unknown) => e,
    );
    expect(blocked).toBeInstanceOf(ProblemError);
    expect((blocked as ProblemError).status).toBe(409);
    expect((blocked as ProblemError).extensions?.code).toBe("previous_holds_exclusive_data");

    // Once the same pack also lives on the current primary (as a "move"
    // would leave it), the placeholder holds nothing exclusive any more.
    await new LocalStorageBackend(newPrimaryDir).put(packPath, content);
    await deleteTarget(db, tenantId, placeholder?.id as string, actor, deps);

    const [gone] = await db
      .select()
      .from(storageTargets)
      .where(eq(storageTargets.id, placeholder?.id as string));
    expect(gone).toBeUndefined();
  });

  it("refuses to delete a target an unfinished migration still references", async () => {
    await db
      .insert(packs)
      .values({ tenantId, path: "tenants/x/packs/a", sha256: "a".repeat(64), size: 10 });
    const dto = await createTarget(
      db,
      tenantId,
      {
        kind: "local",
        name: "New primary",
        role: "primary",
        config: { basePath: "/mnt/new-primary" },
        migrationMode: "move",
      },
      actor,
    );
    const error = await deleteTarget(db, tenantId, dto.id, actor).catch((e) => e);
    expect(error).toBeInstanceOf(ProblemError);
    expect((error as ProblemError).status).toBe(409);
  });
});
