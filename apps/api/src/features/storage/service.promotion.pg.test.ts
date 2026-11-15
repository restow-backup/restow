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
  repositoryLockHeld,
  resticSnapshotOrigins,
  restorePointSuspicions,
  secrets,
  storageMigrations,
  storageTargets,
  tenantKeys,
  tenants,
} from "@restow/db";
import { and, desc, eq } from "drizzle-orm";
import PgBoss from "pg-boss";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { setInstallationDefaultResolver } from "../../lib/installation-default.js";
import { withTenantTx } from "../../lib/tenant-context.js";
import { ProblemError } from "../../problem.js";
import {
  dropDatabase,
  recreateDatabase,
  testDatabaseAdminUrl,
} from "../snapshots/testing/explorer-fixture.js";
import type { CopiedSnapshot } from "./rules.js";
import { loadSnapshotOrigins, snapshotOnListing } from "./snapshot-origins.js";

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
    await db.delete(resticSnapshotOrigins).where(eq(resticSnapshotOrigins.tenantId, tenantId));
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
    // The suspicion scan of the machine's backup names the restic snapshot.
    await db.insert(restorePointSuspicions).values({
      tenantId,
      objectKind: "endpoint",
      objectId: machineId,
      runId: run?.id as string,
      restorePointId: sid("m2"),
      restorePointAt: new Date("2026-11-03"),
      verdict: "suspicious",
      metrics: {} as never,
      signaturesVersion: "1",
    });
    // A snapshot retention forgot long ago (its run stays): on no repository any more.
    await db.insert(endpointRuns).values({
      tenantId,
      endpointId: machineId,
      kind: "backup",
      status: "succeeded",
      startedAt: new Date("2026-10-01"),
      finishedAt: new Date("2026-10-01"),
      snapshotId: sid("m0"),
    });
    await copyRow(`file-shares/${shareId}/`, shareId, copy.id);
    await copyRow(`endpoints/${machineId}/`, machineId, copy.id);

    const result = await service.promoteTarget(db, tenantId, copy.id, actor, {
      listCopySnapshots: async ({ repository, role }) =>
        repository.kind === "file_share"
          ? copied(["s1"])
          : role === "primary"
            ? [{ id: sid("m2"), original: null }]
            : copied(["m2"]),
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
    const [suspicion] = await db
      .select({ id: restorePointSuspicions.restorePointId })
      .from(restorePointSuspicions)
      .where(eq(restorePointSuspicions.objectId, machineId));
    expect(suspicion?.id).toBe(sid("cm2"));

    // The retired primary's chain was replaced by the promoted copy (marked on the primary): it
    // does not pin the retired location, unless a record still names a snapshot of it.
    for (const [dir, files] of [
      [
        primary.basePath,
        [
          "config",
          `data/ab/${"ab".repeat(32)}`,
          `snapshots/${sid("m2")}`,
          `snapshots/${sid("m0")}`,
        ],
      ],
      [copy.basePath, ["config", REPOSITORY_COPY_MARKER_FILE, `data/cd/${"cd".repeat(32)}`]],
    ] as const) {
      for (const file of files) {
        const path = join(dir, `endpoints/${machineId}/`, file);
        await mkdir(join(path, ".."), { recursive: true });
        await writeFile(path, "x");
      }
    }
    // The forgotten snapshot m0 is still there and a run still names it (it was on no copy).
    const pinned = await refusal(service.deleteTarget(db, tenantId, primary.id, actor));
    expect(pinned.type).toBe("urn:restow:problem:storage-previous-holds-endpoint-repositories");
    await rm(join(primary.basePath, `endpoints/${machineId}/snapshots/${sid("m0")}`));
    await service.deleteTarget(db, tenantId, primary.id, actor);
    expect(await roles()).toEqual({ [copy.id]: "primary" });
  });

  it("refuses while a restore point that only a hold keeps is not on the copy [COPY-004]", async () => {
    await targetAt("primary", "primary");
    const copy = await targetAt("copy", "copy");
    // A revoked machine (its retention no longer runs): the primary keeps h1 beside h2, and the
    // copy holds only h2 (a copy pass that followed the retention rules alone did that).
    const [machine] = await db
      .insert(endpoints)
      .values({
        tenantId,
        hostname: "attacked",
        os: "linux",
        arch: "amd64",
        profile: "server",
        status: "revoked",
        secretHash: "hash",
        repositorySecretId: await password("endpoint_repository"),
        lastSnapshotId: sid("h2"),
        config: defaultEndpointConfig("linux", "server", { timeZone: "Europe/Berlin" }),
      })
      .returning();
    const machineId = machine?.id as string;
    for (const [tag, at] of [
      ["h1", "2026-10-20"],
      ["h2", "2026-11-03"],
    ] as const) {
      await db.insert(endpointRuns).values({
        tenantId,
        endpointId: machineId,
        kind: "backup",
        status: "succeeded",
        startedAt: new Date(at),
        finishedAt: new Date(at),
        snapshotId: sid(tag),
      });
    }
    await copyRow(`endpoints/${machineId}/`, machineId, copy.id);
    const lister =
      (onCopy: string[]) =>
      async ({ role }: { role: "copy" | "primary" }) =>
        role === "primary"
          ? [
              { id: sid("h1"), original: null },
              { id: sid("h2"), original: null },
            ]
          : copied(onCopy);

    const error = await refusal(
      service.promoteTarget(db, tenantId, copy.id, actor, { listCopySnapshots: lister(["h2"]) }),
    );
    expect(error.type).toBe("urn:restow:problem:storage-repository-copies-incomplete");
    // Once the copy holds it too, the promotion goes ahead and both are carried over.
    const result = await service.promoteTarget(db, tenantId, copy.id, actor, {
      listCopySnapshots: lister(["h1", "h2"]),
    });
    // Both runs and the machine's newest snapshot.
    expect(result.restorePointIdsRewritten).toBe(3);
  });

  /** A revoked machine with runs h1, h2 (newest) and a snapshot u1 no run reported, flagged. */
  async function revokedMachine(): Promise<{ id: string; prefix: string }> {
    const [machine] = await db
      .insert(endpoints)
      .values({
        tenantId,
        hostname: `old-${randomUUID().slice(0, 6)}`,
        os: "linux",
        arch: "amd64",
        profile: "server",
        status: "revoked",
        secretHash: "hash",
        repositorySecretId: await password("endpoint_repository"),
        lastSnapshotId: sid("h2"),
        config: defaultEndpointConfig("linux", "server", { timeZone: "Europe/Berlin" }),
      })
      .returning();
    const id = machine?.id as string;
    for (const [tag, at] of [
      ["h1", "2026-10-20"],
      ["h2", "2026-11-03"],
    ] as const) {
      await db.insert(endpointRuns).values({
        tenantId,
        endpointId: id,
        kind: "backup",
        status: "succeeded",
        startedAt: new Date(at),
        finishedAt: new Date(at),
        snapshotId: sid(tag),
      });
    }
    await db
      .insert(endpointSnapshotFlags)
      .values({ tenantId, endpointId: id, snapshotId: sid("u1"), reasons: ["unrecorded"] });
    return { id, prefix: `endpoints/${id}/` };
  }

  it("requires a snapshot no run reported that a flag names while the primary holds it", async () => {
    await targetAt("primary", "primary");
    const copy = await targetAt("copy", "copy");
    const machine = await revokedMachine();
    await copyRow(machine.prefix, machine.id, copy.id);
    const onPrimary = ["h1", "h2", "u1"].map((tag) => ({ id: sid(tag), original: null }));
    const lister =
      (onCopy: string[]) =>
      async ({ role }: { role: "copy" | "primary" }) =>
        role === "primary" ? onPrimary : copied(onCopy);

    const error = await refusal(
      service.promoteTarget(db, tenantId, copy.id, actor, {
        listCopySnapshots: lister(["h1", "h2"]),
      }),
    );
    expect(error.type).toBe("urn:restow:problem:storage-repository-copies-incomplete");
    // The copy pass now copies it too (repository-copies `decideMachineCopy`): then it goes ahead.
    const result = await service.promoteTarget(db, tenantId, copy.id, actor, {
      listCopySnapshots: lister(["h1", "h2", "u1"]),
    });
    expect(result.primaryUnreadable).toEqual([]);
    const [flag] = await db
      .select({ id: endpointSnapshotFlags.snapshotId })
      .from(endpointSnapshotFlags)
      .where(eq(endpointSnapshotFlags.endpointId, machine.id));
    expect(flag?.id).toBe(sid("cu1"));
  });

  it("checks a machine against the records when the primary cannot list its repository, and says so", async () => {
    await targetAt("primary", "primary");
    const copy = await targetAt("copy", "copy");
    const machine = await revokedMachine();
    await copyRow(machine.prefix, machine.id, copy.id);
    const lister =
      (onCopy: string[]) =>
      async ({ role }: { role: "copy" | "primary" }) => {
        if (role === "primary") {
          throw new Error("Fatal: unable to open config file: no such file");
        }
        return copied(onCopy);
      };

    // Without the newest snapshot on the copy: refused.
    const error = await refusal(
      service.promoteTarget(db, tenantId, copy.id, actor, { listCopySnapshots: lister(["h1"]) }),
    );
    expect(error.type).toBe("urn:restow:problem:storage-repository-copies-incomplete");
    // The copy holds it (its state says current): the damaged primary does not lock it out.
    const result = await service.promoteTarget(db, tenantId, copy.id, actor, {
      listCopySnapshots: lister(["h1", "h2", "u1"]),
    });
    expect(result.primaryUnreadable).toEqual([machine.prefix]);
    const [entry] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.tenantId, tenantId), eq(auditLog.action, "storage.target.promoted")))
      .orderBy(desc(auditLog.createdAt))
      .limit(1);
    expect(entry?.details).toMatchObject({ primaryUnreadable: [machine.prefix] });
  });

  it("refuses when a listing of the copy fails or times out, and releases the copy lock", async () => {
    const primary = await targetAt("primary", "primary");
    const copy = await targetAt("copy", "copy");
    const guest = await container(["t1"]);
    await copyRow(guest.prefix, guest.id, copy.id);
    const error = await refusal(
      service.promoteTarget(db, tenantId, copy.id, actor, {
        listCopySnapshots: async () => {
          throw new Error("restic snapshots timed out after 300000 ms");
        },
      }),
    );
    expect(error.type).toBe("urn:restow:problem:storage-repository-copies-incomplete");
    expect(error.extensions?.repositories).toMatchObject([{ reason: "unreadable" }]);
    expect(await repositoryLockHeld(db.$client, repositoryCopiesLockKey(tenantId))).toBe(false);
    expect(await roles()).toEqual({ [primary.id]: "primary", [copy.id]: "copy" });
  });

  it("finds the restore points on another copy after the promoted primary is lost, and promotes that copy later", async () => {
    // P1 primary, C1 and C2 copies. C1 is promoted (records: c-ids); C1 is lost; C2 holds every
    // restore point under ids of its own whose original is still P1's (restic keeps the first).
    const p1 = await targetAt("p1", "primary");
    const c1 = await targetAt("c1", "copy");
    const c2 = await targetAt("c2", "copy");
    const guest = await container(["g1", "g2"]);
    await copyRow(guest.prefix, guest.id, c1.id);
    await copyRow(guest.prefix, guest.id, c2.id);
    const onC2: CopiedSnapshot[] = ["g1", "g2"].map((tag) => ({
      id: sid(`e${tag}`),
      original: sid(tag),
    }));

    await service.promoteTarget(db, tenantId, c1.id, actor, {
      listCopySnapshots: async () => copied(["g1", "g2"]),
    });
    const recorded = async () =>
      (
        await db
          .select({ id: pveSnapshots.resticSnapshotId })
          .from(pveSnapshots)
          .where(eq(pveSnapshots.guestId, guest.id))
      )
        .map((row) => row.id as string)
        .sort();
    expect(await recorded()).toEqual([sid("cg1"), sid("cg2")]);

    // The restore fallback to C2 with C1 gone: by the persistent id the promotion recorded.
    const origins = await withTenantTx(db, tenantId, (tx) =>
      loadSnapshotOrigins(tx, tenantId, guest.prefix),
    );
    expect(snapshotOnListing(onC2, sid("cg1"), origins)).toBe(sid("eg1"));
    expect(snapshotOnListing(onC2, sid("cg2").slice(0, 8), origins)).toBe(sid("eg2"));
    expect(snapshotOnListing(onC2, sid("cg1"), [])).toBeNull();

    // C2 is promoted later: its copies are found by the same persistent ids.
    await db
      .update(repositoryCopies)
      .set({ lastAttemptAt: new Date("2026-11-12") })
      .where(eq(repositoryCopies.targetId, c2.id));
    const second = await service.promoteTarget(db, tenantId, c2.id, actor, {
      listCopySnapshots: async () => onC2,
    });
    expect(second.restorePointIdsRewritten).toBe(2);
    expect(await recorded()).toEqual([sid("eg1"), sid("eg2")]);
    expect(await roles()).toEqual({ [p1.id]: "previous", [c1.id]: "previous", [c2.id]: "primary" });
    // And a third copy made from C2 later still resolves the persistent id.
    const again = await withTenantTx(db, tenantId, (tx) =>
      loadSnapshotOrigins(tx, tenantId, guest.prefix),
    );
    expect(snapshotOnListing([{ id: sid("x1"), original: sid("g1") }], sid("eg1"), again)).toBe(
      sid("x1"),
    );
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
