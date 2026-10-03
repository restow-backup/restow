/**
 * Postgres-backed coverage of how endpoint backup (docs/AGENT.md) limits a
 * change of the storage target: the repositories of servers and clients live
 * in the primary target under `endpoints/<id>/`, and a storage change (move,
 * keep, promote) copies `tenants/<id>/...` only. So while an agent still backs
 * up, the primary cannot be replaced; a repository pins the primary like data
 * does; and a retired target that holds the only copy of a repository is not
 * removed. The database `restow_api_storage_endpoints_test` is created once;
 * local targets only. Runs when RESTOW_TEST_DATABASE_URL points at Postgres.
 */
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InstallationDefaultResolver, defaultEndpointConfig, endpointPrefix } from "@restow/core";
import {
  type Database,
  createDb,
  endpoints,
  jobs,
  packs,
  providers,
  secrets,
  storageMigrations,
  storageTargets,
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
import { createTarget, deleteTarget, promoteTarget, updateTarget } from "./service.js";

// These suites set the installation default in the environment (STORAGE_*); read it from there,
// uncached, instead of from the installation pool of a configured server
// (lib/installation-default.ts).
beforeAll(() => setInstallationDefaultResolver(new InstallationDefaultResolver({ ttlMs: 0 })));
afterAll(() => setInstallationDefaultResolver(null));

const DATABASE = "restow_api_storage_endpoints_test";

describe.skipIf(!testDatabaseAdminUrl)("storage changes and endpoint repositories", () => {
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
    root = await mkdtemp(join(tmpdir(), "restow-storage-endpoints-"));
  }, 60_000);

  afterEach(async () => {
    await db.delete(jobs).where(eq(jobs.tenantId, tenantId));
    await db.delete(storageMigrations).where(eq(storageMigrations.tenantId, tenantId));
    await db.delete(storageTargets).where(eq(storageTargets.tenantId, tenantId));
    await db.delete(endpoints).where(eq(endpoints.tenantId, tenantId));
    await db.delete(secrets).where(eq(secrets.tenantId, tenantId));
    await db.delete(packs).where(eq(packs.tenantId, tenantId));
  });

  afterAll(async () => {
    await db.$client.end();
    await dropDatabase(testDatabaseAdminUrl as string, DATABASE);
    if (root) {
      await rm(root, { recursive: true, force: true });
    }
  });

  /** An enrolled machine with its repository password sealed in the store. */
  async function endpoint(status: "active" | "revoked" = "active"): Promise<string> {
    const [secret] = await db
      .insert(secrets)
      .values({ tenantId, kind: "endpoint_repository", ciphertext: "sealed" })
      .returning();
    const [row] = await db
      .insert(endpoints)
      .values({
        tenantId,
        hostname: `host-${randomUUID().slice(0, 8)}`,
        os: "linux",
        arch: "amd64",
        profile: "server",
        status,
        secretHash: "hash",
        repositorySecretId: secret?.id as string,
        config: defaultEndpointConfig("linux", "server", { timeZone: "Europe/Berlin" }),
      })
      .returning();
    return row?.id as string;
  }

  async function primaryAt(basePath: string, role: "primary" | "copy" = "primary") {
    const [row] = await db
      .insert(storageTargets)
      .values({ tenantId, kind: "local", role, status: "ok", config: { basePath } })
      .returning();
    return row?.id as string;
  }

  const replace = (mode: "keep" | "move", name: string) =>
    createTarget(
      db,
      tenantId,
      {
        kind: "local",
        name,
        role: "primary",
        config: { basePath: join(root, `${name}-${randomUUID().slice(0, 6)}`) },
        migrationMode: mode,
      },
      actor,
    );

  async function refusal(work: Promise<unknown>): Promise<ProblemError> {
    const error = await work.then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ProblemError);
    return error as ProblemError;
  }

  it("refuses to replace the primary, keeping or moving, while a machine backs up to it", async () => {
    const old = await primaryAt(join(root, "old-primary"));
    await endpoint("active");

    for (const mode of ["keep", "move"] as const) {
      const error = await refusal(replace(mode, `new-${mode}`));
      expect(error.status).toBe(409);
      expect(error.type).toBe("urn:restow:problem:storage-active-endpoints");
      expect(error.extensions?.code).toBe("active_endpoints");
    }
    // Nothing switched, nothing queued.
    const rows = await db
      .select()
      .from(storageTargets)
      .where(eq(storageTargets.tenantId, tenantId));
    expect(rows.map((row) => [row.id, row.role])).toEqual([[old, "primary"]]);
    expect(
      await db.select().from(storageMigrations).where(eq(storageMigrations.tenantId, tenantId)),
    ).toHaveLength(0);
  });

  it("refuses to promote a copy while a machine backs up to the primary", async () => {
    const primary = await primaryAt(join(root, "primary-promote"));
    const copy = await primaryAt(join(root, "copy-promote"), "copy");
    await endpoint("active");

    const error = await refusal(promoteTarget(db, tenantId, copy, actor));
    expect(error.type).toBe("urn:restow:problem:storage-active-endpoints");
    const rows = await db
      .select()
      .from(storageTargets)
      .where(eq(storageTargets.tenantId, tenantId));
    expect(Object.fromEntries(rows.map((row) => [row.id, row.role]))).toEqual({
      [primary]: "primary",
      [copy]: "copy",
    });
  });

  it("does not let a tenant with only machine backups add, move or remove its primary by the plain routes either", async () => {
    // No pack at all: the repositories alone make the primary hold data.
    const primary = await primaryAt(join(root, "primary-only-endpoints"));
    await endpoint("active");

    const moved = await refusal(
      updateTarget(db, tenantId, primary, { config: { basePath: join(root, "elsewhere") } }, actor),
    );
    expect(moved.extensions?.code).toBe("location_locked");
    const removed = await refusal(deleteTarget(db, tenantId, primary, actor));
    expect(removed.extensions?.code).toBe("primary_holds_data");
  });

  it("does not let a tenant that has only endpoint repositories create a first primary on top of them", async () => {
    // The repositories are on the installation default; a new primary would hide them.
    await endpoint("revoked");
    const error = await refusal(
      createTarget(
        db,
        tenantId,
        {
          kind: "local",
          name: "Fresh primary",
          role: "primary",
          config: { basePath: join(root, "fresh-primary") },
        },
        actor,
      ),
    );
    expect(error.extensions?.code).toBe("tenant_has_data");
  });

  it("replaces the primary once only revoked machines are left, and keeps their repositories reachable", async () => {
    const oldDir = join(root, "old-with-revoked");
    const old = await primaryAt(oldDir);
    const revoked = await endpoint("revoked");
    await mkdir(join(oldDir, endpointPrefix(revoked)), { recursive: true });
    await writeFile(join(oldDir, endpointPrefix(revoked), "config"), "restic-config");

    const created = await replace("keep", "after-revoke");
    expect(created.role).toBe("primary");
    const [retired] = await db.select().from(storageTargets).where(eq(storageTargets.id, old));
    expect(retired?.role).toBe("previous");

    // Removing the retired location would make the revoked machine's backups unreachable.
    const error = await refusal(deleteTarget(db, tenantId, old, actor));
    expect(error.status).toBe(409);
    expect(error.type).toBe("urn:restow:problem:storage-previous-holds-endpoint-repositories");
    expect(error.extensions?.repositories).toEqual([`${endpointPrefix(revoked)}config`]);
    const [still] = await db.select().from(storageTargets).where(eq(storageTargets.id, old));
    expect(still?.role).toBe("previous");
  });

  it("removes a retired location once its repositories are also on the current primary", async () => {
    const oldDir = join(root, "old-copied");
    const newDir = join(root, "new-copied");
    const old = await primaryAt(oldDir);
    const revoked = await endpoint("revoked");
    for (const dir of [oldDir, newDir]) {
      await mkdir(join(dir, endpointPrefix(revoked)), { recursive: true });
      await writeFile(join(dir, endpointPrefix(revoked), "config"), "restic-config");
    }
    await db.update(storageTargets).set({ role: "previous" }).where(eq(storageTargets.id, old));
    await db.insert(storageTargets).values({
      tenantId,
      kind: "local",
      role: "primary",
      status: "ok",
      config: { basePath: newDir },
    });

    await deleteTarget(db, tenantId, old, actor);
    const rows = await db
      .select()
      .from(storageTargets)
      .where(eq(storageTargets.tenantId, tenantId));
    expect(rows.map((row) => row.role)).toEqual(["primary"]);
  });
});
