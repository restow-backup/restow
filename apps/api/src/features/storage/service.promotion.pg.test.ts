/**
 * Postgres-backed coverage of promoting a copy target while the tenant has restic repositories
 * (docs/STORAGE.md, "Promoting a copy"): every reason it is refused is known before the click
 * (`promotionReadiness`), "Catch up now" asks for a storage check and the repository copies, and
 * a promotion with complete repository copies carries the recorded restore points over to the
 * copy's snapshot ids and retires the old primary read-only. restic itself is not run here: the
 * listing of the repository copies is injected (`listCopySnapshots`). Local targets only. Runs
 * when RESTOW_TEST_DATABASE_URL points at Postgres.
 */
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultEndpointConfig,
  generateDek,
  InstallationDefaultResolver,
  kekFromBase64,
  REPOSITORY_COPY_MARKER_FILE,
  wrapDek,
} from "@restow/core";
import {
  acquireEndpointRepositoryLock,
  auditLog,
  createDb,
  type Database,
  endpointRuns,
  endpointSnapshotFlags,
  endpoints,
  fileShareRuns,
  fileShareSamples,
  fileShareSnapshots,
  fileShares,
  jobs,
  providers,
  pveClusters,
  pveGuests,
  pveSnapshots,
  repositoryCopies,
  repositoryCopiesLockKey,
  secrets,
  storageMigrations,
  storageTargets,
  tenantKeys,
  tenants,
} from "@restow/db";
import { and, eq } from "drizzle-orm";
import PgBoss from "pg-boss";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { setInstallationDefaultResolver } from "../../lib/installation-default.js";
import { ProblemError } from "../../problem.js";
import {
  dropDatabase,
  recreateDatabase,
  testDatabaseAdminUrl,
} from "../snapshots/testing/explorer-fixture.js";
import type { CopiedSnapshot } from "./rules.js";

// The API's configuration reads the master key on import (repository passwords are sealed).
const masterKey = vi.hoisted(() => {
  const key = Buffer.alloc(32, 7).toString("base64");
  process.env.RESTOW_MASTER_KEY = key;
  return key;
});

beforeAll(() => setInstallationDefaultResolver(new InstallationDefaultResolver({ ttlMs: 0 })));
afterAll(() => setInstallationDefaultResolver(null));

const DATABASE = "restow_api_storage_promotion_test";

/** A restic snapshot id (64 hex characters) from a short tag. */
const sid = (tag: string) => tag.padEnd(64, "0");

describe.skipIf(!testDatabaseAdminUrl)("promoting a copy with restic repositories", () => {
  let db: Database;
  let tenantId: string;
  let root: string;
  let service: typeof import("./service.js");
  let secretStore: typeof import("../../lib/secrets.js");

  const actor = { id: "u1", email: "admin@example.com", ip: "203.0.113.7", isProviderAdmin: true };

  beforeAll(async () => {
    const url = await recreateDatabase(testDatabaseAdminUrl as string, DATABASE);
    const boss = new PgBoss({ connectionString: url });
    await boss.start();
    await boss.createQueue("scrub");
    await boss.createQueue("storage_migration");
    await boss.stop({ graceful: false, wait: true });
    db = createDb(url);
    const [provider] = await db.insert(providers).values({ name: "Provider" }).returning();
    const [tenant] = await db
      .insert(tenants)
      .values({ providerId: provider?.id as string, name: "Tenant", slug: "tenant" })
      .returning();
    tenantId = tenant?.id as string;
    await db.insert(tenantKeys).values({
      tenantId,
      keyVersion: 1,
      encryptedDek: wrapDek(kekFromBase64(masterKey), generateDek(1)).toString("base64"),
      kekId: "env:RESTOW_MASTER_KEY",
    });
    service = await import("./service.js");
    secretStore = await import("../../lib/secrets.js");
    root = await mkdtemp(join(tmpdir(), "restow-storage-promotion-"));
  }, 60_000);

  afterEach(async () => {
    await db.delete(jobs).where(eq(jobs.tenantId, tenantId));
    await db.delete(repositoryCopies).where(eq(repositoryCopies.tenantId, tenantId));
    await db.delete(storageMigrations).where(eq(storageMigrations.tenantId, tenantId));
    await db.delete(storageTargets).where(eq(storageTargets.tenantId, tenantId));
    await db.delete(endpoints).where(eq(endpoints.tenantId, tenantId));
    await db.delete(pveClusters).where(eq(pveClusters.tenantId, tenantId));
    await db.delete(fileShares).where(eq(fileShares.tenantId, tenantId));
    await db.delete(secrets).where(eq(secrets.tenantId, tenantId));
  });

  afterAll(async () => {
    const shared = await import("../../db.js");
    await Promise.all([
      shared.db.$client.end(),
      shared.providerDb.$client.end(),
      shared.authDb.$client.end(),
    ]);
    await db.$client.end();
    await dropDatabase(testDatabaseAdminUrl as string, DATABASE);
    if (root) {
      await rm(root, { recursive: true, force: true });
    }
  });

  async function targetAt(name: string, role: "primary" | "copy") {
    const basePath = join(root, `${name}-${randomUUID().slice(0, 6)}`);
    await mkdir(basePath, { recursive: true });
    const [row] = await db
      .insert(storageTargets)
      .values({ tenantId, kind: "local", name, role, status: "ok", config: { basePath } })
      .returning();
    return { id: row?.id as string, basePath };
  }

  async function password(kind: string): Promise<string> {
    const ref = await secretStore.storeSecret(db, {
      tenantId,
      kind: kind as Parameters<typeof secretStore.storeSecret>[1]["kind"],
      plaintext: "repository-password",
    });
    return ref.id;
  }

  /** A container with a repository and restore points (restic ids `sid(tag)`). */
  async function container(tags: string[], pruned: string[] = []) {
    const [cluster] = await db
      .insert(pveClusters)
      .values({ tenantId, name: "lab", fingerprint: randomUUID(), storageId: "restow" })
      .returning();
    const [guest] = await db
      .insert(pveGuests)
      .values({
        tenantId,
        clusterId: cluster?.id as string,
        vmid: 300,
        kind: "ct",
        name: "paperless",
        repositoryReadyAt: new Date("2026-11-01T00:00:00Z"),
        repositorySecretId: await password("pve_ct_repository"),
      })
      .returning();
    let sequence = 0;
    for (const tag of [...tags, ...pruned]) {
      sequence++;
      await db.insert(pveSnapshots).values({
        tenantId,
        clusterId: cluster?.id as string,
        guestId: guest?.id as string,
        sequence,
        kind: "ct",
        archiveName: `backup/vzdump-lxc-300-${sequence}.tar`,
        storageId: "restow",
        manifestPath: `m/${sequence}`,
        resticSnapshotId: sid(tag),
        status: pruned.includes(tag) ? "pruned" : "active",
        backupAt: new Date(`2026-11-0${sequence}T00:00:00Z`),
        createdAt: new Date(`2026-11-0${sequence}T00:00:00Z`),
      });
    }
    const id = guest?.id as string;
    return { id, prefix: `pve-guests/${id}/` };
  }

  async function copyRow(
    prefix: string,
    ownerId: string,
    targetId: string,
    values: Partial<typeof repositoryCopies.$inferInsert> = {},
  ) {
    await db.insert(repositoryCopies).values({
      tenantId,
      prefix,
      kind: prefix.startsWith("pve-guests/")
        ? "container"
        : prefix.startsWith("endpoints/")
          ? "machine"
          : "file_share",
      ownerId,
      targetId,
      state: "current",
      lastAttemptAt: new Date("2026-11-10T00:00:00Z"),
      lastCopiedAt: new Date("2026-11-10T00:05:00Z"),
      lastCheckOk: true,
      ...values,
    });
  }

  /** The listing of a repository copy: each recorded id copied under `c<tag>`. */
  const copied = (tags: string[]): CopiedSnapshot[] =>
    tags.map((tag) => ({ id: sid(`c${tag}`), original: sid(tag) }));

  async function refusal(work: Promise<unknown>): Promise<ProblemError> {
    const error = await work.then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ProblemError);
    return error as ProblemError;
  }

  async function roles() {
    const rows = await db
      .select({ id: storageTargets.id, role: storageTargets.role })
      .from(storageTargets)
      .where(eq(storageTargets.tenantId, tenantId));
    return Object.fromEntries(rows.map((row) => [row.id, row.role]));
  }

  it("promotes a copy whose repository copies are current and carries the restore points over [COPY-004]", async () => {
    const primary = await targetAt("primary", "primary");
    const copy = await targetAt("copy", "copy");
    const guest = await container(["a1", "a2"], ["a3"]);
    await copyRow(guest.prefix, guest.id, copy.id);

    const readiness = await service.promotionReadiness(db, tenantId, copy.id, actor, {
      files: true,
    });
    expect(readiness.blockers).toEqual([]);
    expect(readiness.ready).toBe(true);
    expect(readiness.currentPrimaryBecomes).toBe("previous");
    expect(readiness.repositories).toMatchObject({ total: 1, current: 1, items: [] });

    const result = await service.promoteTarget(db, tenantId, copy.id, actor, {
      listCopySnapshots: async ({ repository }) => {
        expect(repository.prefix).toBe(guest.prefix);
        return copied(["a1", "a2"]);
      },
    });
    expect(result.target.role).toBe("primary");
    expect(result.previousPrimaryRole).toBe("previous");
    expect(result.restorePointIdsRewritten).toBe(2);
    expect(await roles()).toEqual({ [primary.id]: "previous", [copy.id]: "primary" });

    const points = await db
      .select({ id: pveSnapshots.resticSnapshotId, status: pveSnapshots.status })
      .from(pveSnapshots)
      .where(eq(pveSnapshots.guestId, guest.id));
    // The kept restore points name the copy's snapshots; the pruned one is not on the copy.
    expect(points.map((point) => point.id).sort()).toEqual(
      [sid("ca1"), sid("ca2"), sid("a3")].sort(),
    );
    const [entry] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.tenantId, tenantId), eq(auditLog.action, "storage.target.promoted")));
    expect(entry?.details).toMatchObject({
      previousPrimary: primary.id,
      previousPrimaryRole: "previous",
      repositories: 1,
      restorePointIdsRewritten: 2,
    });
  });

  it("refuses while a repository copy is behind or older than the newest restore point, and says so before the click", async () => {
    await targetAt("primary", "primary");
    const copy = await targetAt("copy", "copy");
    const guest = await container(["b1", "b2"]);
    // Copied before the newest restore point (2026-11-02) was recorded.
    await copyRow(guest.prefix, guest.id, copy.id, {
      lastAttemptAt: new Date("2026-11-01T12:00:00Z"),
    });

    const readiness = await service.promotionReadiness(db, tenantId, copy.id, actor, {
      files: false,
    });
    expect(readiness.ready).toBe(false);
    expect(readiness.blockers).toEqual([{ code: "repository_copies_incomplete", repositories: 1 }]);
    expect(readiness.repositories.items).toMatchObject([
      { prefix: guest.prefix, name: "paperless", readiness: "outdated" },
    ]);
    expect(readiness.canCatchUp).toBe(true);

    const error = await refusal(
      service.promoteTarget(db, tenantId, copy.id, actor, {
        listCopySnapshots: async () => copied(["b1", "b2"]),
      }),
    );
    expect(error.status).toBe(409);
    expect(error.type).toBe("urn:restow:problem:storage-repository-copies-incomplete");
    expect(error.extensions?.repositories).toEqual([
      { prefix: guest.prefix, name: "paperless", reason: "outdated" },
    ]);

    await db
      .update(repositoryCopies)
      .set({ state: "behind", missingSnapshots: 1, lastAttemptAt: new Date("2026-11-10") })
      .where(eq(repositoryCopies.ownerId, guest.id));
    const behind = await service.promotionReadiness(db, tenantId, copy.id, actor, {
      files: false,
    });
    expect(behind.repositories.items[0]?.readiness).toBe("behind");
  });

  it("refuses when the copy lacks a kept restore point although its state says current, and changes nothing [COPY-004]", async () => {
    const primary = await targetAt("primary", "primary");
    const copy = await targetAt("copy", "copy");
    const guest = await container(["d1", "d2"]);
    await copyRow(guest.prefix, guest.id, copy.id);

    const error = await refusal(
      service.promoteTarget(db, tenantId, copy.id, actor, {
        listCopySnapshots: async () => copied(["d1"]),
      }),
    );
    expect(error.type).toBe("urn:restow:problem:storage-repository-copies-incomplete");
    expect(await roles()).toEqual({ [primary.id]: "primary", [copy.id]: "copy" });
    const points = await db
      .select({ id: pveSnapshots.resticSnapshotId })
      .from(pveSnapshots)
      .where(eq(pveSnapshots.guestId, guest.id));
    expect(points.map((point) => point.id).sort()).toEqual([sid("d1"), sid("d2")].sort());
  });

  it("lists every reason before the click: an active machine, a running scrub and a repository never copied", async () => {
    await targetAt("primary", "primary");
    const copy = await targetAt("copy", "copy");
    const [machine] = await db
      .insert(endpoints)
      .values({
        tenantId,
        hostname: "srv-01",
        os: "linux",
        arch: "amd64",
        profile: "server",
        status: "active",
        secretHash: "hash",
        repositorySecretId: await password("endpoint_repository"),
        config: defaultEndpointConfig("linux", "server", { timeZone: "Europe/Berlin" }),
      })
      .returning();
    await db.insert(jobs).values({ tenantId, queue: "scrub", status: "active" });

    const readiness = await service.promotionReadiness(db, tenantId, copy.id, actor, {
      files: false,
    });
    expect(readiness.blockers).toEqual([
      { code: "active_endpoints" },
      { code: "storage_jobs_running", queues: ["scrub"] },
      { code: "repository_copies_incomplete", repositories: 1 },
    ]);
    expect(readiness.repositories.items).toMatchObject([
      { ownerId: machine?.id, kind: "machine", readiness: "pending" },
    ]);
    expect(readiness.catchUp.running).toBe(true);

    // The promotion refuses with the first of them.
    const error = await refusal(service.promoteTarget(db, tenantId, copy.id, actor));
    expect(error.type).toBe("urn:restow:problem:storage-active-endpoints");
  });

  it("starts a catch-up: a storage check and the copy of every repository not current, audited", async () => {
    await targetAt("primary", "primary");
    const copy = await targetAt("copy", "copy");
    const guest = await container(["e1"]);
    await copyRow(guest.prefix, guest.id, copy.id, { state: "failed", lastError: "timeout" });

    const readiness = await service.startCatchUp(db, tenantId, copy.id, actor);
    expect(readiness.catchUp.running).toBe(true);
    expect(readiness.catchUp.waiting).toBe(1);
    expect(readiness.catchUp.scrub).toMatchObject({ status: "queued" });
    expect(readiness.repositories.items[0]?.readiness).toBe("requested");
    const [row] = await db
      .select()
      .from(repositoryCopies)
      .where(eq(repositoryCopies.ownerId, guest.id));
    expect(row?.lastAttemptAt).toBeNull();
    const [scrub] = await db
      .select()
      .from(jobs)
      .where(and(eq(jobs.tenantId, tenantId), eq(jobs.queue, "scrub")));
    expect(scrub?.payload).toMatchObject({ mode: "sample" });
    const [entry] = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenantId),
          eq(auditLog.action, "storage.target.catch_up_started"),
        ),
      );
    expect(entry?.target).toBe(copy.id);
    expect(entry?.details).toMatchObject({ scrubJobId: scrub?.id, repositories: 1, requested: 1 });

    // While it runs the promotion waits: the storage check holds it.
    const error = await refusal(service.promoteTarget(db, tenantId, copy.id, actor));
    expect(error.type).toBe("urn:restow:problem:storage-switch-blocked-by-jobs");
  });

  it("refuses while the worker copies the tenant's repositories (the copy lock)", async () => {
    await targetAt("primary", "primary");
    const copy = await targetAt("copy", "copy");
    const guest = await container(["f1"]);
    await copyRow(guest.prefix, guest.id, copy.id);
    const release = await acquireEndpointRepositoryLock(
      db.$client,
      repositoryCopiesLockKey(tenantId),
      { mode: "shared" },
    );
    try {
      const readiness = await service.promotionReadiness(db, tenantId, copy.id, actor, {
        files: false,
      });
      expect(readiness.blockers).toEqual([{ code: "copy_pass_running" }]);
      const error = await refusal(
        service.promoteTarget(db, tenantId, copy.id, actor, {
          listCopySnapshots: async () => copied(["f1"]),
        }),
      );
      expect(error.type).toBe("urn:restow:problem:storage-copy-pass-running");
    } finally {
      await release();
    }
  });

  it("carries a file share's and a revoked machine's records over, and lets the retired primary be removed afterwards", async () => {
    const primary = await targetAt("primary", "primary");
    const copy = await targetAt("copy", "copy");
    const [share] = await db
      .insert(fileShares)
      .values({
        tenantId,
        name: "Projects",
        protocol: "nfs",
        server: "1.1.1.1",
        exportPath: "/srv/projects",
        nfsVersion: "4.1",
        repositoryReadyAt: new Date("2026-11-01"),
        repositorySecretId: await password("file_share_repository"),
      })
      .returning();
    const shareId = share?.id as string;
    await db.insert(fileShareSnapshots).values({
      tenantId,
      fileShareId: shareId,
      sequence: 1,
      resticSnapshotId: sid("s1"),
      snapshotTime: new Date("2026-11-02"),
      createdAt: new Date("2026-11-02"),
    });
    const [machine] = await db
      .insert(endpoints)
      .values({
        tenantId,
        hostname: "old-laptop",
        os: "linux",
        arch: "amd64",
        profile: "server",
        status: "revoked",
        secretHash: "hash",
        repositorySecretId: await password("endpoint_repository"),
        lastSnapshotId: sid("m2").slice(0, 8),
        config: defaultEndpointConfig("linux", "server", { timeZone: "Europe/Berlin" }),
      })
      .returning();
    const machineId = machine?.id as string;
    const [run] = await db
      .insert(endpointRuns)
      .values({
        tenantId,
        endpointId: machineId,
        kind: "backup",
        status: "succeeded",
        startedAt: new Date("2026-11-03"),
        finishedAt: new Date("2026-11-03"),
        snapshotId: sid("m2"),
      })
      .returning();
    await db.insert(fileShareSamples).values({
      tenantId,
      fileShareId: shareId,
      runId: await fileShareRunId(shareId),
      snapshotId: sid("s1"),
      path: "/share/a.txt",
      size: 1,
      sha256: "0".repeat(64),
    });
    await db
      .insert(endpointSnapshotFlags)
      .values({ tenantId, endpointId: machineId, snapshotId: sid("m2"), reasons: ["unrecorded"] });
    await copyRow(`file-shares/${shareId}/`, shareId, copy.id);
    await copyRow(`endpoints/${machineId}/`, machineId, copy.id);

    const result = await service.promoteTarget(db, tenantId, copy.id, actor, {
      listCopySnapshots: async ({ repository }) =>
        repository.kind === "file_share" ? copied(["s1"]) : copied(["m2"]),
    });
    expect(result.repositories).toBe(2);
    const [snapshot] = await db
      .select({ id: fileShareSnapshots.resticSnapshotId })
      .from(fileShareSnapshots)
      .where(eq(fileShareSnapshots.fileShareId, shareId));
    expect(snapshot?.id).toBe(sid("cs1"));
    const [sample] = await db
      .select({ id: fileShareSamples.snapshotId })
      .from(fileShareSamples)
      .where(eq(fileShareSamples.fileShareId, shareId));
    expect(sample?.id).toBe(sid("cs1"));
    const [endpoint] = await db
      .select({ last: endpoints.lastSnapshotId })
      .from(endpoints)
      .where(eq(endpoints.id, machineId));
    // An abbreviated id stays abbreviated.
    expect(endpoint?.last).toBe(sid("cm2").slice(0, 8));
    const [recorded] = await db
      .select({ id: endpointRuns.snapshotId })
      .from(endpointRuns)
      .where(eq(endpointRuns.id, run?.id as string));
    expect(recorded?.id).toBe(sid("cm2"));
    const [flag] = await db
      .select({ id: endpointSnapshotFlags.snapshotId })
      .from(endpointSnapshotFlags)
      .where(eq(endpointSnapshotFlags.endpointId, machineId));
    expect(flag?.id).toBe(sid("cm2"));

    // The retired primary's chain was replaced by the promoted copy (marked on the primary): it
    // does not pin the retired location.
    for (const [dir, files] of [
      [primary.basePath, ["config", `data/ab/${"ab".repeat(32)}`]],
      [copy.basePath, ["config", REPOSITORY_COPY_MARKER_FILE, `data/cd/${"cd".repeat(32)}`]],
    ] as const) {
      for (const file of files) {
        const path = join(dir, `endpoints/${machineId}/`, file);
        await mkdir(join(path, ".."), { recursive: true });
        await writeFile(path, "x");
      }
    }
    await service.deleteTarget(db, tenantId, primary.id, actor);
    expect(await roles()).toEqual({ [copy.id]: "primary" });
  });

  /** A finished run of the share (a sample belongs to one). */
  async function fileShareRunId(shareId: string): Promise<string> {
    const [run] = await db
      .insert(fileShareRuns)
      .values({
        tenantId,
        fileShareId: shareId,
        lockShareId: shareId,
        kind: "backup",
        status: "succeeded",
      })
      .returning();
    return run?.id as string;
  }

  it("still promotes a tenant without restic repositories by making the old primary a copy", async () => {
    const primary = await targetAt("primary", "primary");
    const copy = await targetAt("copy", "copy");
    const result = await service.promoteTarget(db, tenantId, copy.id, actor);
    expect(result.previousPrimaryRole).toBe("copy");
    expect(await roles()).toEqual({ [primary.id]: "copy", [copy.id]: "primary" });
  });
});
