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
import { defaultEndpointConfig, endpointPrefix, InstallationDefaultResolver } from "@restow/core";
import {
  createDb,
  type Database,
  endpoints,
  fileShares,
  jobs,
  packs,
  providers,
  pveClusters,
  pveGuests,
  pveRuns,
  secrets,
  storageMigrations,
  storageRepositoryRepairs,
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
    await db.delete(pveClusters).where(eq(pveClusters.tenantId, tenantId));
    await db.delete(fileShares).where(eq(fileShares.tenantId, tenantId));
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

  it("refuses to keep or promote while only revoked machines have repositories", async () => {
    // A promotion away from the installation default (0.4.1) dropped the old location without
    // a trace, and a revoked machine's backups with it: its repository counts too.
    const old = await primaryAt(join(root, "old-with-revoked"));
    const copy = await primaryAt(join(root, "copy-with-revoked"), "copy");
    await endpoint("revoked");

    const kept = await refusal(replace("keep", "after-revoke"));
    expect(kept.type).toBe("urn:restow:problem:storage-switch-blocked-by-repositories");
    expect(kept.extensions?.repositories).toEqual({
      containers: false,
      fileShares: false,
      machines: true,
    });
    const promoted = await refusal(promoteTarget(db, tenantId, copy, actor));
    expect(promoted.type).toBe("urn:restow:problem:storage-switch-blocked-by-repositories");
    const rows = await db
      .select()
      .from(storageTargets)
      .where(eq(storageTargets.tenantId, tenantId));
    expect(Object.fromEntries(rows.map((row) => [row.id, row.role]))).toEqual({
      [old]: "primary",
      [copy]: "copy",
    });
  });

  it("does not remove a retired location that holds the only copy of a repository", async () => {
    const oldDir = join(root, "old-only-copy");
    const old = await primaryAt(oldDir);
    const revoked = await endpoint("revoked");
    await mkdir(join(oldDir, endpointPrefix(revoked)), { recursive: true });
    await writeFile(join(oldDir, endpointPrefix(revoked), "config"), "restic-config");
    await db.update(storageTargets).set({ role: "previous" }).where(eq(storageTargets.id, old));
    await primaryAt(join(root, "new-only-copy"));

    // Removing the retired location would make the revoked machine's backups unreachable.
    const error = await refusal(deleteTarget(db, tenantId, old, actor));
    expect(error.status).toBe(409);
    expect(error.type).toBe("urn:restow:problem:storage-previous-holds-endpoint-repositories");
    expect(error.extensions?.repositories).toEqual([endpointPrefix(revoked)]);
    const [still] = await db.select().from(storageTargets).where(eq(storageTargets.id, old));
    expect(still?.role).toBe("previous");
  });

  it("does not remove a retired location that holds early packs of a run split by a switch", async () => {
    // The config is on the new primary too (the move copied it, or the run wrote it on both),
    // but a data file only the retired location has: deleting it would lose that pack.
    const oldDir = join(root, "old-split");
    const newDir = join(root, "new-split");
    const old = await primaryAt(oldDir);
    const [cluster] = await db
      .insert(pveClusters)
      .values({ tenantId, name: "lab", fingerprint: randomUUID(), storageId: "restow" })
      .returning();
    const [guest] = await db
      .insert(pveGuests)
      .values({
        tenantId,
        clusterId: cluster?.id as string,
        vmid: 109,
        kind: "ct",
        repositoryReadyAt: new Date(),
      })
      .returning();
    const prefix = `pve-guests/${guest?.id}/`;
    for (const dir of [oldDir, newDir]) {
      await mkdir(join(dir, prefix), { recursive: true });
      await writeFile(join(dir, prefix, "config"), "restic-config");
    }
    await mkdir(join(oldDir, prefix, "data", "ab"), { recursive: true });
    await writeFile(join(oldDir, prefix, "data", "ab", "ab".repeat(32)), "early pack");
    await db.update(storageTargets).set({ role: "previous" }).where(eq(storageTargets.id, old));
    await primaryAt(newDir);

    const error = await refusal(deleteTarget(db, tenantId, old, actor));
    expect(error.type).toBe("urn:restow:problem:storage-previous-holds-endpoint-repositories");
    expect(error.extensions?.repositories).toEqual([prefix]);
  });

  it("keeps the installation default attached read-only when a copy is promoted away from it", async () => {
    // A tenant with mail backups only (no restic repository): promoting is allowed, and the
    // installation default stays readable as a retired target (0.4.1 dropped it).
    const copy = await primaryAt(join(root, "copy-from-default"), "copy");
    const result = await promoteTarget(db, tenantId, copy, actor);
    expect(result.target.role).toBe("primary");
    const rows = await db
      .select()
      .from(storageTargets)
      .where(eq(storageTargets.tenantId, tenantId));
    expect(rows.map((row) => [row.kind, row.role]).sort()).toEqual([
      ["installation_default", "previous"],
      ["local", "primary"],
    ]);
  });

  it("refuses to promote while a file share's repository is being created (its password is stored before restic init)", async () => {
    await primaryAt(join(root, "primary-creating"));
    const copy = await primaryAt(join(root, "copy-creating"), "copy");
    const [secret] = await db
      .insert(secrets)
      .values({ tenantId, kind: "file_share_repository", ciphertext: "sealed" })
      .returning();
    await db.insert(fileShares).values({
      tenantId,
      name: "Creating",
      protocol: "nfs",
      server: "1.1.1.1",
      exportPath: "/srv/creating",
      nfsVersion: "4.1",
      repositorySecretId: secret?.id as string,
    });
    const error = await refusal(promoteTarget(db, tenantId, copy, actor));
    expect(error.type).toBe("urn:restow:problem:storage-switch-blocked-by-repositories");
    expect(error.extensions?.repositories).toMatchObject({ fileShares: true });
  });

  it("refuses to promote while a container's first backup is in its credential or init step (the run is running)", async () => {
    // A container records its password only together with its ready time, after restic init:
    // while it creates its repository, only its running run stands for it.
    await primaryAt(join(root, "primary-first-run"));
    const copy = await primaryAt(join(root, "copy-first-run"), "copy");
    const [cluster] = await db
      .insert(pveClusters)
      .values({ tenantId, name: "lab", fingerprint: randomUUID(), storageId: "restow" })
      .returning();
    const [guest] = await db
      .insert(pveGuests)
      .values({ tenantId, clusterId: cluster?.id as string, vmid: 300, kind: "ct" })
      .returning();
    await db.insert(pveRuns).values({
      tenantId,
      clusterId: cluster?.id as string,
      guestId: guest?.id as string,
      kind: "backup",
      status: "running",
    });
    const error = await refusal(promoteTarget(db, tenantId, copy, actor));
    expect(error.type).toBe("urn:restow:problem:storage-switch-blocked-by-runs");
    expect(error.detail).toContain("container or VM");
  });

  it("refuses to promote or keep while a repository repair is queued or running", async () => {
    await primaryAt(join(root, "primary-repairing"));
    const copy = await primaryAt(join(root, "copy-repairing"), "copy");
    const [repair] = await db
      .insert(storageRepositoryRepairs)
      .values({ tenantId, kind: "apply", requestedBy: "admin@contoso.example" })
      .returning();
    try {
      const promoted = await refusal(promoteTarget(db, tenantId, copy, actor));
      expect(promoted.type).toBe("urn:restow:problem:storage-switch-blocked-by-repair");
      const moved = await refusal(replace("move", "while-repairing"));
      expect(moved.type).toBe("urn:restow:problem:storage-switch-blocked-by-repair");
    } finally {
      await db
        .delete(storageRepositoryRepairs)
        .where(eq(storageRepositoryRepairs.id, repair?.id as string));
    }
  });

  it("keeps a retired location while only it holds a moved-aside repository folder", async () => {
    const oldDir = join(root, "old-aside");
    const newDir = join(root, "new-aside");
    const old = await primaryAt(oldDir);
    const [cluster] = await db
      .insert(pveClusters)
      .values({ tenantId, name: "lab", fingerprint: randomUUID(), storageId: "restow" })
      .returning();
    // A guest whose repository the repair found lost: no password, no ready time any more.
    const [guest] = await db
      .insert(pveGuests)
      .values({ tenantId, clusterId: cluster?.id as string, vmid: 109, kind: "ct" })
      .returning();
    // Its first chain, and a chain under a fresh prefix (begun on a storage that refused the
    // move once) that a later reset moved aside as well.
    const folders = [
      `${guest?.id}.chain-2.orphaned-2026-11-05T10-00-00-000Z`,
      `${guest?.id}.orphaned-2026-11-04T10-00-00-000Z`,
    ];
    for (const folder of folders) {
      const aside = join(oldDir, "pve-guests", folder);
      await mkdir(join(aside, "data", "ab"), { recursive: true });
      await writeFile(join(aside, "data", "ab", "ab".repeat(32)), "pack");
    }
    await db.update(storageTargets).set({ role: "previous" }).where(eq(storageTargets.id, old));
    await db.insert(storageTargets).values({
      tenantId,
      kind: "local",
      role: "primary",
      status: "ok",
      config: { basePath: newDir },
    });
    const error = await refusal(deleteTarget(db, tenantId, old, actor));
    expect(error.type).toBe("urn:restow:problem:storage-previous-holds-moved-aside");
    expect([...((error.extensions?.folders as string[] | undefined) ?? [])].sort()).toEqual(
      folders.map((folder) => `pve-guests/${folder}/`).sort(),
    );
    // Once they are elsewhere too, the location can go.
    for (const folder of folders) {
      const copied = join(newDir, "pve-guests", folder);
      await mkdir(join(copied, "data", "ab"), { recursive: true });
      await writeFile(join(copied, "data", "ab", "ab".repeat(32)), "pack");
    }
    await deleteTarget(db, tenantId, old, actor);
  });

  it("refuses to promote or keep while a backup run is running", async () => {
    await primaryAt(join(root, "primary-running"));
    const copy = await primaryAt(join(root, "copy-running"), "copy");
    const [cluster] = await db
      .insert(pveClusters)
      .values({ tenantId, name: "lab", fingerprint: randomUUID(), storageId: "restow" })
      .returning();
    // A VM (no restic repository): its run alone holds the switch.
    const [guest] = await db
      .insert(pveGuests)
      .values({ tenantId, clusterId: cluster?.id as string, vmid: 101, kind: "vm" })
      .returning();
    await db.insert(pveRuns).values({
      tenantId,
      clusterId: cluster?.id as string,
      guestId: guest?.id as string,
      kind: "backup",
      status: "running",
    });
    const promoted = await refusal(promoteTarget(db, tenantId, copy, actor));
    expect(promoted.type).toBe("urn:restow:problem:storage-switch-blocked-by-runs");
    const kept = await refusal(replace("keep", "while-running"));
    expect(kept.type).toBe("urn:restow:problem:storage-switch-blocked-by-runs");
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

  /** A container whose restic repository exists (its first backup ran). */
  async function containerWithRepository(): Promise<void> {
    const [cluster] = await db
      .insert(pveClusters)
      .values({ tenantId, name: "lab", fingerprint: randomUUID(), storageId: "restow" })
      .returning();
    await db.insert(pveGuests).values({
      tenantId,
      clusterId: cluster?.id as string,
      vmid: 300,
      kind: "ct",
      name: "paperless",
      repositoryReadyAt: new Date(),
    });
  }

  it("refuses to keep existing backups where they are while containers or file shares have repositories", async () => {
    const old = await primaryAt(join(root, "old-with-containers"));
    await containerWithRepository();

    const error = await refusal(replace("keep", "nas-keep"));
    expect(error.status).toBe(409);
    expect(error.type).toBe("urn:restow:problem:storage-switch-blocked-by-repositories");
    expect(error.extensions?.repositories).toEqual({
      containers: true,
      fileShares: false,
      machines: false,
    });
    expect(error.detail).toContain('"move"');
    // Nothing switched.
    const rows = await db
      .select()
      .from(storageTargets)
      .where(eq(storageTargets.tenantId, tenantId));
    expect(rows.map((row) => [row.id, row.role])).toEqual([[old, "primary"]]);

    // A file share's repository blocks it the same way, also without any container.
    await db.delete(pveClusters).where(eq(pveClusters.tenantId, tenantId));
    await db.insert(fileShares).values({
      tenantId,
      name: "Projects",
      protocol: "nfs",
      server: "1.1.1.1",
      exportPath: "/srv/projects",
      nfsVersion: "4.1",
      repositoryReadyAt: new Date(),
    });
    const shares = await refusal(replace("keep", "nas-keep-shares"));
    expect(shares.extensions?.repositories).toEqual({
      containers: false,
      fileShares: true,
      machines: false,
    });

    // "move" copies the repositories, so it is allowed.
    const moved = await replace("move", "nas-move");
    expect(moved.role).toBe("copy");
    expect(moved.migration?.mode).toBe("move");
  });

  it("refuses to promote a copy while containers have repositories (a copy never has them)", async () => {
    await primaryAt(join(root, "primary-containers"));
    const copy = await primaryAt(join(root, "copy-containers"), "copy");
    await containerWithRepository();
    const error = await refusal(promoteTarget(db, tenantId, copy, actor));
    expect(error.type).toBe("urn:restow:problem:storage-switch-blocked-by-repositories");
  });
});
