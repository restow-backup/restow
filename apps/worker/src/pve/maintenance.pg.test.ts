/**
 * Server-side work for Proxmox VE guests against Postgres and a local
 * storage target: due jobs become backup tasks, retention prunes restore
 * points and releases exactly their chunk references (the map-aware
 * reference count of docs/PROXMOX.md 2.4), verify reads a block sample back
 * and notices a block that does not match its map, stale runs fail and give
 * their staged references back. A container check another run's restic lock
 * keeps out is postponed, then recorded as "could not check", never failed.
 */
import { spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BLOCK_FLAG_PRESENT,
  buildPveManifest,
  ChunkWriter,
  collectGarbage,
  type DeletionDecision,
  EnvKeyProvider,
  encodeBlockMap,
  generateDek,
  installDeletionEnforcement,
  LocalStorageBackend,
  manifestKey,
  noopLogger,
  PVE_BLOCK_SIZE,
  pveRestorePointReadiness,
  resticBinary,
  resticInit,
  resticSnapshots,
  runRestic,
  type StorageBackend,
  type StorageTargets,
  sealManifest,
  sealSecret,
  type TenantKeyring,
  withRepository,
  writeToAllTargets,
} from "@restow/core";
import {
  acquireEndpointRepositoryLock,
  chunks,
  createDb,
  type Database,
  deriveAuthLogin,
  pveClusters,
  pveDownloads,
  pveEnrollmentTokens,
  pveGuestRepositoryLockKey,
  pveGuests,
  pveJobs,
  pveNodes,
  pveRunBlocks,
  pveRuns,
  pveSnapshots,
  pveTasks,
  type RoleLogin,
  restorePointSuspicions,
  secrets,
} from "@restow/db";
import { runMigrations } from "@restow/db/migrate";
import { and, desc, eq, inArray, notInArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  loadTenantKeyring,
  PgChunkIndex,
  TenantCache,
  tenantRunner,
} from "../handlers/framework.js";
import { PgPackCatalog } from "../handlers/scrub.js";
import { dropTestDatabase } from "../testing/database.js";
import {
  applyRetention,
  closeCancelledRunsOfSilentNodes,
  closeOrphanedRuns,
  closeRunsNodesDropped,
  closeStaleRuns,
  coveredBy,
  dropPveTokenSecrets,
  PVE_ORPHAN_SNAPSHOT_GRACE_MS,
  PVE_ORPHANED_RUN_MESSAGE,
  PVE_RECONCILE_EVERY_MS,
  PVE_RECONCILE_RETRY_MS,
  type PveDeps,
  planBootTests,
  planJobs,
  planRestoreTests,
  purgeDownloads,
  pvePass,
  reconcileGuestRepository,
  VERIFY_GIVE_UP_MS,
  VERIFY_POSTPONE_MS,
  verifyDue,
  verifySnapshot,
} from "./maintenance.js";

const adminUrl = process.env.RESTOW_TEST_DATABASE_URL;
const TEST_DB = "restow_worker_pve_test";
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const DAY = 24 * 60 * 60 * 1000;
const resticOk = spawnSync(resticBinary(), ["version"]).status === 0;

describe.skipIf(!adminUrl)("Proxmox VE maintenance against Postgres", () => {
  let owner: Database;
  let appDb: Database;
  let providerDb: Database;
  let deps: PveDeps;
  let work: string;
  let tenantId: string;
  let guestId: string;
  let clusterId: string;
  let storage: StorageTargets;
  let clock = new Date("2026-10-10T12:00:00Z");
  const roleNames: string[] = [];

  beforeAll(async () => {
    const admin = createDb(adminUrl as string);
    await admin.$client.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await admin.$client.query(`CREATE DATABASE ${TEST_DB}`);
    await admin.$client.end();
    const url = new URL(adminUrl as string);
    url.pathname = `/${TEST_DB}`;
    const suffix = randomBytes(4).toString("hex");
    const tenantLogin: RoleLogin = {
      name: `restow_wp_app_${suffix}`,
      password: randomBytes(12).toString("hex"),
    };
    const installationLogin: RoleLogin = {
      name: `restow_wp_inst_${suffix}`,
      password: randomBytes(12).toString("hex"),
    };
    roleNames.push(
      tenantLogin.name,
      installationLogin.name,
      deriveAuthLogin(tenantLogin, installationLogin).name,
    );
    await runMigrations(url.toString(), {
      roles: { tenant: tenantLogin, installation: installationLogin },
    });
    owner = createDb(url.toString());
    const asRole = (login: RoleLogin) => {
      const copy = new URL(url);
      copy.username = login.name;
      copy.password = login.password;
      return createDb(copy.toString());
    };
    appDb = asRole(tenantLogin);
    providerDb = asRole(installationLogin);
    work = await mkdtemp(join(tmpdir(), "restow-worker-pve-"));
    const q = <T extends Record<string, unknown>>(text: string, values: unknown[] = []) =>
      owner.$client.query<T>(text, values).then((r) => r.rows);
    const [provider] = await q<{ id: string }>(
      "INSERT INTO providers (name) VALUES ('p') RETURNING id",
    );
    const [tenant] = await q<{ id: string }>(
      "INSERT INTO tenants (provider_id, name, slug) VALUES ($1, 'Contoso', 'contoso') RETURNING id",
      [provider?.id],
    );
    tenantId = tenant?.id ?? "";
    const kek = randomBytes(32);
    const provideKeys = new EnvKeyProvider(kek);
    await q(
      "INSERT INTO tenant_keys (tenant_id, key_version, encrypted_dek, kek_id) VALUES ($1, 1, $2, 'env:RESTOW_MASTER_KEY')",
      [tenantId, (await provideKeys.wrapDek(generateDek(1))).toString("base64")],
    );
    storage = { primary: new LocalStorageBackend(join(work, "storage")), copies: [] };
    deps = {
      db: appDb,
      providerDb,
      runtime: {
        keyrings: new TenantCache<TenantKeyring>((id) =>
          loadTenantKeyring({ db: appDb, tenantId: id, keyProvider: provideKeys }),
        ),
        storage: new TenantCache<StorageTargets>(async () => storage),
        logger: noopLogger,
        now: () => clock,
        shutdownSignal: new AbortController().signal,
      },
    };
    const [cluster] = await owner
      .insert(pveClusters)
      .values({ tenantId, name: "lab", fingerprint: "c".repeat(64), storageId: "restow" })
      .returning();
    clusterId = cluster?.id ?? "";
    await owner
      .insert(pveNodes)
      .values({ tenantId, clusterId, name: "pve1", secretHash: "0".repeat(64) });
    const [guest] = await owner
      .insert(pveGuests)
      .values({ tenantId, clusterId, vmid: 101, kind: "vm", node: "pve1" })
      .returning();
    guestId = guest?.id ?? "";
  }, 90_000);

  afterAll(async () => {
    await Promise.all([appDb?.$client.end(), providerDb?.$client.end(), owner?.$client.end()]);
    await dropTestDatabase(adminUrl as string, TEST_DB);
    const admin = createDb(adminUrl as string);
    for (const role of roleNames) {
      await admin.$client.query(`DROP ROLE IF EXISTS ${role}`);
    }
    await admin.$client.end();
    if (work) await rm(work, { recursive: true, force: true });
  });

  /** A VM restore point as the API commits it: blocks, map, config, sealed manifest, references. */
  async function commit(
    sequence: number,
    blocks: Buffer[],
    backupAt: Date,
    tamper = false,
    forGuest?: { id: string; vmid: number },
  ): Promise<string> {
    const target = forGuest ?? { id: guestId, vmid: 101 };
    const keys = await deps.runtime.keyrings.get(tenantId);
    const index = new PgChunkIndex(tenantRunner(appDb, tenantId), tenantId);
    const writer = new ChunkWriter({ tenantId, storage, keys, index });
    const entries = [];
    for (const b of blocks) {
      const written = await writer.write(b);
      entries.push({
        flags: BLOCK_FLAG_PRESENT,
        sha256: tamper ? sha(Buffer.from("other")) : sha(b),
        chunks: written.chunks,
      });
    }
    const diskSize = blocks.reduce((s, b) => s + b.length, 0);
    const map = { diskSize, entries };
    const mapObj = await writer.write(encodeBlockMap(map));
    const conf = await writer.write(Buffer.from("scsi0: x\n"));
    await writer.close();
    const ids = [
      ...new Set([...entries.flatMap((e) => e.chunks), ...mapObj.chunks, ...conf.chunks]),
    ];
    await index.addReferences(ids);
    const snapshotId = crypto.randomUUID();
    const manifest = buildPveManifest({
      tenantId,
      snapshotId,
      guestId: target.id,
      createdAt: backupAt,
      sequence,
      state: {
        kind: "pve-vm",
        clusterId,
        vmid: target.vmid,
        node: "pve1",
        archiveName: `vm/${target.vmid}/${backupAt.toISOString()}`,
        storageId: "restow",
      },
      config: { chunks: conf.chunks, size: conf.size, sha256: conf.sha256 },
      firewall: null,
      disks: [
        {
          device: "drive-scsi0",
          diskSize,
          map: { chunks: mapObj.chunks, size: mapObj.size, sha256: mapObj.sha256 },
          changedBlocks: blocks.length,
          zeroBlocks: 0,
          bitmapMode: "new",
        },
      ],
      packs: [],
    });
    const path = manifestKey(tenantId, snapshotId);
    await writeToAllTargets(storage, path, await sealManifest(manifest, keys.current, path));
    await owner.insert(pveSnapshots).values({
      id: snapshotId,
      tenantId,
      clusterId,
      guestId: target.id,
      sequence,
      kind: "vm",
      archiveName: `vm/${target.vmid}/${backupAt.toISOString().replace(/\.\d{3}Z$/, "Z")}`,
      storageId: "restow",
      manifestPath: path,
      disks: [
        {
          device: "drive-scsi0",
          size: diskSize,
          map: { chunks: mapObj.chunks, size: mapObj.size, sha256: mapObj.sha256 },
          hashesDigest: "",
          changedBlocks: blocks.length,
          zeroBlocks: 0,
          dataBlocks: blocks.length,
          bitmapMode: "new",
        },
      ],
      chunkRefs: ids.length,
      backupAt,
    });
    await owner
      .update(pveGuests)
      .set({ lastSnapshotId: snapshotId })
      .where(eq(pveGuests.id, target.id));
    return snapshotId;
  }

  const blockOf = (fill: number) => Buffer.alloc(PVE_BLOCK_SIZE, fill);
  const refTotal = async () =>
    Number(
      (
        await owner.execute<{ total: string }>(
          sql`SELECT coalesce(sum(refcount),0) AS total FROM chunks`,
        )
      ).rows[0]?.total,
    );

  it("plans due jobs as backup tasks on the guest's node", async () => {
    const [job] = await owner
      .insert(pveJobs)
      .values({
        tenantId,
        name: "nightly",
        scopeAll: true,
        schedule: { kind: "daily", timeOfDay: "22:00", timeZone: "Europe/Berlin" },
        nextRunAt: new Date(clock.getTime() - 1000),
      })
      .returning();
    expect(coveredBy(job as never, await owner.select().from(pveGuests))).toHaveLength(1);
    // A guest an administrator excluded from backup is planned by no job (0.4.7).
    const excluded = (await owner.select().from(pveGuests)).map((guest) => ({
      ...guest,
      excludedAt: clock,
    }));
    expect(coveredBy(job as never, excluded)).toHaveLength(0);
    // A restored copy in the pool restow-restore, or a leftover temporary guest, is not taken by
    // the job for all guests; put into a job by hand, that job backs it up (S14).
    const all = await owner.select().from(pveGuests);
    const restored = all.map((guest) => ({ ...guest, pool: "restow-restore" }));
    expect(coveredBy(job as never, restored)).toHaveLength(0);
    const temporary = all.map((guest) => ({ ...guest, tags: ["restow-boottest"] }));
    expect(coveredBy(job as never, temporary)).toHaveLength(0);
    const assigned = restored.map((guest) => ({ ...guest, jobId: job?.id ?? null }));
    expect(coveredBy(job as never, assigned)).toHaveLength(1);
    expect(await planJobs(deps, clock)).toBe(1);
    expect(await planJobs(deps, clock)).toBe(0);
    const tasks = await owner.select().from(pveTasks);
    expect(tasks).toEqual([
      expect.objectContaining({
        kind: "backup",
        status: "pending",
        params: expect.objectContaining({ vmid: 101 }),
      }),
    ]);
    const [after] = await owner.select().from(pveJobs);
    expect(after?.nextRunAt?.getTime()).toBeGreaterThan(clock.getTime());
  });

  it("plans no backup task while new starts are paused for an update (#46)", async () => {
    await owner.delete(pveTasks);
    await owner.update(pveJobs).set({ nextRunAt: new Date(clock.getTime() - 1000) });
    const summary = await pvePass({ ...deps, startsPaused: () => true });
    expect(summary).toMatchObject({ tasks: 0, pruned: 0, verified: 0, restoreTests: 0 });
    expect(await owner.select().from(pveTasks)).toEqual([]);
    // Once the pause lifts the job is still due and its task comes.
    expect(await planJobs(deps, clock)).toBe(1);
  });

  it("retention prunes old restore points and releases exactly their references", async () => {
    const shared = blockOf(1);
    const a = await commit(1, [shared, blockOf(2)], new Date(clock.getTime() - 3 * DAY));
    const b = await commit(2, [shared, blockOf(3)], new Date(clock.getTime() - 2 * DAY));
    const c = await commit(3, [shared, blockOf(4)], new Date(clock.getTime() - DAY));
    const before = await refTotal();
    await owner
      .update(pveJobs)
      .set({ settings: { retention: { keepDaily: 2, keepWeekly: 0, keepMonthly: 0 } } });
    await owner
      .update(pveGuests)
      .set({ jobId: (await owner.select().from(pveJobs))[0]?.id ?? null });
    expect(await applyRetention(deps, clock)).toBe(1);
    const snaps = await owner.select().from(pveSnapshots);
    expect(snaps.find((s) => s.id === a)?.status).toBe("pruned");
    expect(
      snaps
        .filter((s) => s.status === "active")
        .map((s) => s.id)
        .sort(),
    ).toEqual([b, c].sort());
    // The pruned restore point held 4 references (two blocks, its map, its config).
    expect(await refTotal()).toBe(before - (snaps.find((s) => s.id === a)?.chunkRefs ?? 0));
    // The shared block is still held by the others; the block only `a` had is not.
    const zero = await owner.select().from(chunks).where(eq(chunks.refcount, 0));
    expect(zero.length).toBeGreaterThanOrEqual(1);
    expect(await storage.primary.head(manifestKey(tenantId, a)).catch(() => null)).toBeNull();
  });

  it('prunes nothing while the primary is write-once (docs/STORAGE.md, "Write-once storage")', async () => {
    // The last test of the primary found that it refuses to overwrite and delete.
    const worm = {
      ...storage,
      previous: [],
      keepGeneration: null,
      primaryTarget: "worm-target",
      targets: [
        {
          id: "worm-target",
          name: "NAS WORM",
          role: "primary" as const,
          backend: storage.primary,
          writeOnce: true,
        },
      ],
    };
    const wormDeps: PveDeps = {
      ...deps,
      runtime: { ...deps.runtime, storage: new TenantCache<StorageTargets>(async () => worm) },
    };
    const [job] = await owner.select().from(pveJobs);
    await owner
      .update(pveJobs)
      .set({ settings: { retention: { keepDaily: 1, keepWeekly: 0, keepMonthly: 0 } } });
    const active = async () =>
      (await owner.select().from(pveSnapshots))
        .filter((snap) => snap.status === "active")
        .map((snap) => snap.id)
        .sort();
    const before = await active();
    expect(before.length).toBeGreaterThan(1);
    const refs = await refTotal();
    expect(await applyRetention(wormDeps, clock)).toBe(0);
    // Every restore point stays restorable, no reference is released, no manifest touched.
    expect(await active()).toEqual(before);
    expect(await refTotal()).toBe(refs);
    for (const id of before) {
      expect(await storage.primary.head(manifestKey(tenantId, id))).not.toBeNull();
    }
    await owner.update(pveJobs).set({ settings: job?.settings ?? {} });
  });

  it("verify reads blocks back and notices one that does not match its map", async () => {
    await owner.update(pveGuests).set({ lastVerifyAt: null });
    expect(await verifyDue(deps, clock)).toBe(1);
    let [latest] = await owner.select().from(pveSnapshots).where(eq(pveSnapshots.sequence, 3));
    expect(latest?.verify).toMatchObject({ blocks: 2, mismatched: 0, errors: [] });
    const bad = await commit(4, [blockOf(9)], clock, true);
    await owner.update(pveGuests).set({ lastVerifyAt: null });
    await verifyDue(deps, clock);
    [latest] = await owner.select().from(pveSnapshots).where(eq(pveSnapshots.id, bad));
    expect(latest?.verify).toMatchObject({ blocks: 1, mismatched: 1 });
  });

  it("checks a restore point a check was asked for: a new one right away, an older one exactly (0.4.2)", async () => {
    // The weekly check ran a moment ago: without a request nothing is due.
    await owner.update(pveGuests).set({ lastVerifyAt: clock });
    await owner.update(pveSnapshots).set({ verifyRequestedAt: null });
    expect(await verifyDue(deps, clock)).toBe(0);
    // A new restore point, marked at its commit (the installation's default), is checked on the
    // next pass although the weekly clock is far from due.
    const fresh = await commit(5, [blockOf(31)], new Date(clock.getTime() + 60_000));
    await owner
      .update(pveSnapshots)
      .set({ verifyRequestedAt: clock })
      .where(eq(pveSnapshots.id, fresh));
    const later = new Date(clock.getTime() + 5 * 60 * 1000);
    expect(await verifyDue(deps, later)).toBe(1);
    let [row] = await owner.select().from(pveSnapshots).where(eq(pveSnapshots.id, fresh));
    expect(row?.verify).toMatchObject({ mismatched: 0, errors: [] });
    expect(row?.verifyRequestedAt).toBeNull();
    const [guest] = await owner.select().from(pveGuests).where(eq(pveGuests.id, guestId));
    expect(guest?.lastVerifyAt).toEqual(later);
    // An admin asks for an older restore point: that one is read, not the newest.
    const [older] = await owner
      .select()
      .from(pveSnapshots)
      .where(and(eq(pveSnapshots.guestId, guestId), eq(pveSnapshots.sequence, 3)));
    await owner
      .update(pveSnapshots)
      .set({ verify: null, verifyRequestedAt: later })
      .where(eq(pveSnapshots.id, older?.id ?? ""));
    // The newest one's result is marked, so a second read of it would show.
    await owner
      .update(pveSnapshots)
      .set({ verify: { checkedAt: "marker", blocks: 0, mismatched: 0, errors: [] } })
      .where(eq(pveSnapshots.id, fresh));
    expect(await verifyDue(deps, later)).toBe(1);
    [row] = await owner
      .select()
      .from(pveSnapshots)
      .where(eq(pveSnapshots.id, older?.id ?? ""));
    expect(row?.verify).toMatchObject({ blocks: 2, mismatched: 0 });
    expect(row?.verifyRequestedAt).toBeNull();
    [row] = await owner.select().from(pveSnapshots).where(eq(pveSnapshots.id, fresh));
    expect(row?.verify?.checkedAt).toBe("marker");
    // A request of a restore point pruned meanwhile is dropped, not read.
    await owner
      .update(pveSnapshots)
      .set({ status: "pruned", verifyRequestedAt: later })
      .where(eq(pveSnapshots.id, older?.id ?? ""));
    expect(await verifyDue(deps, later)).toBe(0);
    [row] = await owner
      .select()
      .from(pveSnapshots)
      .where(eq(pveSnapshots.id, older?.id ?? ""));
    expect(row?.verifyRequestedAt).toBeNull();
    await owner
      .update(pveSnapshots)
      .set({ status: "active" })
      .where(eq(pveSnapshots.id, older?.id ?? ""));
    await owner.delete(pveSnapshots).where(eq(pveSnapshots.id, fresh));
    const [newest] = await owner
      .select()
      .from(pveSnapshots)
      .where(eq(pveSnapshots.guestId, guestId))
      .orderBy(desc(pveSnapshots.sequence))
      .limit(1);
    await owner
      .update(pveGuests)
      .set({ lastSnapshotId: newest?.id ?? null })
      .where(eq(pveGuests.id, guestId));
  });

  it("a restore started in the PVE UI keeps the guest's checks out for two hours at most (S03)", async () => {
    const [run] = await owner
      .insert(pveRuns)
      .values({
        tenantId,
        clusterId,
        guestId,
        kind: "restore",
        origin: "pve",
        startedAt: new Date(clock.getTime() - 30 * 60 * 1000),
      })
      .returning();
    await owner.update(pveGuests).set({ lastVerifyAt: null });
    await owner.update(pveSnapshots).set({ verifyRequestedAt: null });
    // Going on: the restore reads the repository now.
    expect(await verifyDue(deps, clock)).toBe(0);
    // Its end was never reported (an older node): after two hours it no longer counts.
    await owner
      .update(pveRuns)
      .set({ startedAt: new Date(clock.getTime() - 3 * 60 * 60 * 1000) })
      .where(eq(pveRuns.id, run?.id ?? ""));
    expect(await verifyDue(deps, clock)).toBe(1);
    // A restore of Restow's own (a task) keeps the guest busy while it runs.
    await owner
      .update(pveRuns)
      .set({ origin: "restow" })
      .where(eq(pveRuns.id, run?.id ?? ""));
    await owner.update(pveGuests).set({ lastVerifyAt: null });
    expect(await verifyDue(deps, clock)).toBe(0);
    await owner.delete(pveRuns).where(eq(pveRuns.id, run?.id ?? ""));
  });

  it("plans no backup of the Restow server's own VM until an admin confirmed it", async () => {
    await owner.delete(pveTasks);
    await owner
      .update(pveGuests)
      .set({ restowServerDetected: true })
      .where(eq(pveGuests.id, guestId));
    await owner.update(pveJobs).set({ nextRunAt: new Date(clock.getTime() - 1000) });
    expect(await planJobs(deps, clock)).toBe(0);
    await owner
      .update(pveGuests)
      .set({ selfBackupConfirmedAt: clock })
      .where(eq(pveGuests.id, guestId));
    await owner.update(pveJobs).set({ nextRunAt: new Date(clock.getTime() - 1000) });
    expect(await planJobs(deps, clock)).toBe(1);
    await owner.delete(pveTasks);
    await owner
      .update(pveGuests)
      .set({ restowServerDetected: false, selfBackupConfirmedAt: null })
      .where(eq(pveGuests.id, guestId));
  });

  it("fails runs that never ended and releases what they staged", async () => {
    const keys = await deps.runtime.keyrings.get(tenantId);
    const index = new PgChunkIndex(tenantRunner(appDb, tenantId), tenantId);
    const writer = new ChunkWriter({ tenantId, storage, keys, index });
    const written = await writer.write(randomBytes(4096));
    await writer.close();
    await index.addReferences(written.chunks);
    const [run] = await owner
      .insert(pveRuns)
      .values({
        tenantId,
        clusterId,
        guestId,
        kind: "backup",
        startedAt: new Date(clock.getTime() - 3 * DAY),
      })
      .returning();
    await owner.insert(pveRunBlocks).values({
      tenantId,
      runId: run?.id ?? "",
      device: "drive-scsi0",
      blockIndex: 0,
      zero: false,
      length: 4096,
      sha256: "x",
      chunks: written.chunks,
    });
    clock = new Date(clock.getTime() + 1000);
    expect(await closeStaleRuns(deps, clock)).toBe(1);
    const [after] = await owner
      .select()
      .from(pveRuns)
      .where(eq(pveRuns.id, run?.id ?? ""));
    expect(after?.status).toBe("failed");
    const [chunk] = await owner
      .select()
      .from(chunks)
      .where(eq(chunks.storedId, written.chunks[0] ?? ""));
    expect(chunk?.refcount).toBe(0);
  });

  it("closes a restore, restore check or boot test that never reported failed, never succeeded, with its task (S02)", async () => {
    const [node] = await owner.select().from(pveNodes).where(eq(pveNodes.name, "pve1"));
    const nodeId = node?.id ?? "";
    const snapshotId = await commit(40, [blockOf(4)], new Date(clock.getTime() - 4 * DAY));
    const startedAt = new Date(clock.getTime() - 3 * DAY);
    const open = async (kind: "restore" | "restore_test" | "boot_test" | "backup") => {
      const [task] = await owner
        .insert(pveTasks)
        .values({
          tenantId,
          nodeId,
          guestId,
          kind: kind === "restore_test" ? "restore" : kind,
          status: "delivered",
          params: { snapshotId },
          deliveredAt: startedAt,
          expiresAt: new Date(startedAt.getTime() + DAY),
        })
        .returning();
      const [run] = await owner
        .insert(pveRuns)
        .values({
          tenantId,
          clusterId,
          guestId,
          nodeId,
          kind,
          snapshotId,
          taskId: task?.id ?? null,
          startedAt,
        })
        .returning();
      return { runId: run?.id ?? "", taskId: task?.id ?? "" };
    };
    const restore = await open("restore");
    const check = await open("restore_test");
    const boot = await open("boot_test");
    // A backup that committed its restore point did succeed, whatever came after.
    const backup = await open("backup");
    expect(await closeStaleRuns(deps, clock)).toBe(4);
    const row = async (id: string) =>
      (await owner.select().from(pveRuns).where(eq(pveRuns.id, id)))[0];
    const taskOf = async (id: string) =>
      (await owner.select().from(pveTasks).where(eq(pveTasks.id, id)))[0];
    const never = "The node never reported the result (restarted or unreachable).";
    for (const { runId, taskId } of [restore, check, boot]) {
      expect(await row(runId)).toMatchObject({ status: "failed", errorMessage: never });
      expect(await taskOf(taskId)).toMatchObject({ status: "failed", errorMessage: never });
    }
    // A boot test gets the outcome "error": no rating of the restore point, never green.
    expect((await row(boot.runId))?.stats.bootTest).toMatchObject({
      outcome: "error",
      reason: "node_error",
      message: never,
    });
    const [snap] = await owner.select().from(pveSnapshots).where(eq(pveSnapshots.id, snapshotId));
    expect(snap?.bootTest).toBeNull();
    expect(await row(backup.runId)).toMatchObject({ status: "succeeded", errorMessage: null });
    expect((await taskOf(backup.taskId))?.status).toBe("delivered");
    // A restore stopped in the UI whose node stays silent ends cancelled.
    const stopped = await open("restore");
    await owner
      .update(pveRuns)
      .set({ cancelRequestedAt: new Date(clock.getTime() - DAY) })
      .where(eq(pveRuns.id, stopped.runId));
    await owner
      .update(pveTasks)
      .set({ cancelRequestedAt: new Date(clock.getTime() - DAY) })
      .where(eq(pveTasks.id, stopped.taskId));
    await owner
      .update(pveNodes)
      .set({ lastSeenAt: new Date(clock.getTime() - 2 * DAY) })
      .where(eq(pveNodes.id, nodeId));
    expect(await closeCancelledRunsOfSilentNodes(deps, clock)).toBe(1);
    expect((await row(stopped.runId))?.status).toBe("cancelled");
    expect((await taskOf(stopped.taskId))?.status).toBe("cancelled");
    await owner.update(pveNodes).set({ lastSeenAt: clock }).where(eq(pveNodes.id, nodeId));
    const ids = [restore, check, boot, backup, stopped];
    await owner.delete(pveRuns).where(
      inArray(
        pveRuns.id,
        ids.map((x) => x.runId),
      ),
    );
    await owner.delete(pveTasks).where(
      inArray(
        pveTasks.id,
        ids.map((x) => x.taskId),
      ),
    );
  });

  it("plans the monthly restore check only where the node can run it, and stamps only that guest (S05)", async () => {
    await owner.delete(pveTasks);
    await owner.delete(pveRuns).where(eq(pveRuns.status, "running"));
    const [job] = await owner
      .insert(pveJobs)
      .values({
        tenantId,
        name: "with restore check",
        scopeAll: false,
        schedule: { kind: "daily", timeOfDay: "03:00", timeZone: "UTC" },
        settings: { restoreTest: { enabled: true, targetStorage: "local-lvm" } },
      })
      .returning();
    const jobId = job?.id ?? "";
    const [off] = await owner
      .insert(pveNodes)
      .values({
        tenantId,
        clusterId,
        name: "pve2",
        secretHash: "1".repeat(64),
        lastSeenAt: clock,
        facts: { restoresAllowed: false },
      })
      .returning();
    const [onNodeOff] = await owner
      .insert(pveGuests)
      .values({ tenantId, clusterId, vmid: 202, kind: "vm", node: "pve2", jobId })
      .returning();
    await commit(60, [blockOf(6)], new Date(clock.getTime() - DAY), false, {
      id: onNodeOff?.id ?? "",
      vmid: 202,
    });
    const [pve1] = await owner.select().from(pveNodes).where(eq(pveNodes.name, "pve1"));
    await owner
      .update(pveNodes)
      .set({ lastSeenAt: clock, facts: { restoresAllowed: true } })
      .where(eq(pveNodes.id, pve1?.id ?? ""));
    // Guest 202 waits longest (never checked), but its node has restores off: the next one.
    await owner
      .update(pveGuests)
      .set({ jobId, lastRestoreTestAt: new Date(clock.getTime() - 40 * DAY) })
      .where(eq(pveGuests.id, guestId));
    const tasksOf = async (id: string) =>
      owner
        .select()
        .from(pveTasks)
        .where(and(eq(pveTasks.guestId, id), eq(pveTasks.kind, "restore")));
    const guestRow = async (id: string) =>
      (await owner.select().from(pveGuests).where(eq(pveGuests.id, id)))[0];
    // The node of 101 has not reported for an hour: nothing is planned, nothing stamped.
    await owner
      .update(pveNodes)
      .set({ lastSeenAt: new Date(clock.getTime() - 60 * 60 * 1000) })
      .where(eq(pveNodes.id, pve1?.id ?? ""));
    expect(await planRestoreTests(deps, clock)).toBe(0);
    expect((await guestRow(guestId))?.lastRestoreTestAt).toEqual(
      new Date(clock.getTime() - 40 * DAY),
    );
    await owner
      .update(pveNodes)
      .set({ lastSeenAt: clock })
      .where(eq(pveNodes.id, pve1?.id ?? ""));
    expect(await planRestoreTests(deps, clock)).toBe(1);
    expect(await tasksOf(onNodeOff?.id ?? "")).toHaveLength(0);
    expect((await guestRow(onNodeOff?.id ?? ""))?.lastRestoreTestAt).toBeNull();
    const [task] = await tasksOf(guestId);
    expect(task).toMatchObject({
      nodeId: pve1?.id,
      params: expect.objectContaining({ restoreTest: true, targetStorage: "local-lvm" }),
    });
    expect((await guestRow(guestId))?.lastRestoreTestAt).toEqual(clock);
    // Planned once: the stamp holds it back.
    expect(await planRestoreTests(deps, clock)).toBe(0);
    await owner.delete(pveRuns).where(eq(pveRuns.taskId, task?.id ?? ""));
    await owner.delete(pveTasks).where(eq(pveTasks.id, task?.id ?? ""));
    await owner.delete(pveGuests).where(eq(pveGuests.id, onNodeOff?.id ?? ""));
    await owner.delete(pveNodes).where(eq(pveNodes.id, off?.id ?? ""));
    await owner
      .update(pveGuests)
      .set({ jobId: null, lastRestoreTestAt: null })
      .where(eq(pveGuests.id, guestId));
    await owner.delete(pveJobs).where(eq(pveJobs.id, jobId));
  });

  it("passes over a restore point of a privileged container by its own configuration, not the guest's flag (S21)", async () => {
    await owner.delete(pveTasks);
    await owner.delete(pveRuns).where(eq(pveRuns.status, "running"));
    const [job] = await owner
      .insert(pveJobs)
      .values({
        tenantId,
        name: "containers with restore check",
        scopeAll: false,
        schedule: { kind: "daily", timeOfDay: "03:00", timeZone: "UTC" },
        settings: { restoreTest: { enabled: true, targetStorage: "local-lvm" } },
      })
      .returning();
    const jobId = job?.id ?? "";
    const [pve1] = await owner.select().from(pveNodes).where(eq(pveNodes.name, "pve1"));
    await owner
      .update(pveNodes)
      .set({ lastSeenAt: clock, facts: { restoresAllowed: true } })
      .where(eq(pveNodes.id, pve1?.id ?? ""));
    // 211 is unprivileged now, but its newest restore point is of the privileged container it
    // was; it waits longest. 210 is privileged now, its newest restore point unprivileged.
    const container = async (vmid: number, privileged: boolean, guestConfig: string) => {
      const [guest] = await owner
        .insert(pveGuests)
        .values({ tenantId, clusterId, vmid, kind: "ct", node: "pve1", jobId, privileged })
        .returning();
      const [point] = await owner
        .insert(pveSnapshots)
        .values({
          tenantId,
          clusterId,
          guestId: guest?.id ?? "",
          sequence: 1,
          kind: "ct",
          archiveName: `ct/${vmid}/2026-10-20T22:00:00Z`,
          storageId: "restow",
          manifestPath: `ct-${vmid}`,
          guestConfig,
          backupAt: new Date(clock.getTime() - DAY),
        })
        .returning();
      await owner
        .update(pveGuests)
        .set({ lastSnapshotId: point?.id ?? null })
        .where(eq(pveGuests.id, guest?.id ?? ""));
      return guest?.id ?? "";
    };
    const wasPrivileged = await container(211, false, "arch: amd64\nhostname: old\n");
    const nowPrivileged = await container(210, true, "arch: amd64\nunprivileged: 1\n");
    await owner
      .update(pveGuests)
      .set({ lastRestoreTestAt: new Date(clock.getTime() - 40 * DAY) })
      .where(eq(pveGuests.id, nowPrivileged));
    const restoreTasks = async (id: string) =>
      owner
        .select()
        .from(pveTasks)
        .where(and(eq(pveTasks.guestId, id), eq(pveTasks.kind, "restore")));
    expect(await planRestoreTests(deps, clock)).toBe(1);
    expect(await restoreTasks(wasPrivileged)).toHaveLength(0);
    const [stamped] = await owner.select().from(pveGuests).where(eq(pveGuests.id, wasPrivileged));
    expect(stamped?.lastRestoreTestAt).toBeNull();
    expect(await restoreTasks(nowPrivileged)).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({ kind: "ct", restoreTest: true }),
      }),
    ]);
    // The same for boot tests: only the unprivileged restore point is booted.
    await owner
      .update(pveJobs)
      .set({ settings: { bootTest: { schedule: "weekly" } } })
      .where(eq(pveJobs.id, jobId));
    await owner
      .update(pveNodes)
      .set({ lastSeenAt: clock, facts: { restoresAllowed: true, capabilities: ["boot_test"] } })
      .where(eq(pveNodes.id, pve1?.id ?? ""));
    await owner.delete(pveRuns).where(inArray(pveRuns.guestId, [wasPrivileged, nowPrivileged]));
    await owner.delete(pveTasks);
    await planBootTests(deps, clock);
    const bootTasks = await owner.select().from(pveTasks).where(eq(pveTasks.kind, "boot_test"));
    expect(bootTasks.map((t) => t.guestId)).not.toContain(wasPrivileged);
    expect(bootTasks.map((t) => t.guestId)).toContain(nowPrivileged);
    await owner.delete(pveRuns).where(inArray(pveRuns.guestId, [wasPrivileged, nowPrivileged]));
    await owner.delete(pveTasks);
    await owner
      .update(pveGuests)
      .set({ lastSnapshotId: null })
      .where(inArray(pveGuests.id, [wasPrivileged, nowPrivileged]));
    await owner
      .delete(pveSnapshots)
      .where(inArray(pveSnapshots.guestId, [wasPrivileged, nowPrivileged]));
    await owner.delete(pveGuests).where(inArray(pveGuests.id, [wasPrivileged, nowPrivileged]));
    await owner.delete(pveJobs).where(eq(pveJobs.id, jobId));
  });

  it("plans no restore test of a container whose repository has a problem recorded (split, failed repair)", async () => {
    await owner.delete(pveTasks);
    await owner.delete(pveRuns).where(eq(pveRuns.status, "running"));
    const [job] = await owner
      .insert(pveJobs)
      .values({
        tenantId,
        name: "containers with a repository problem",
        scopeAll: false,
        schedule: { kind: "daily", timeOfDay: "03:00", timeZone: "UTC" },
        settings: { restoreTest: { enabled: true, targetStorage: "local-lvm" } },
      })
      .returning();
    const jobId = job?.id ?? "";
    const [pve1] = await owner.select().from(pveNodes).where(eq(pveNodes.name, "pve1"));
    await owner
      .update(pveNodes)
      .set({ lastSeenAt: clock, facts: { restoresAllowed: true } })
      .where(eq(pveNodes.id, pve1?.id ?? ""));
    const container = async (vmid: number, type: string | null) => {
      const [guest] = await owner
        .insert(pveGuests)
        .values({
          tenantId,
          clusterId,
          vmid,
          kind: "ct",
          node: "pve1",
          jobId,
          repositoryProblem: type
            ? { at: clock.toISOString(), type, heldBy: "copy", activePoints: 1 }
            : null,
        })
        .returning();
      const [point] = await owner
        .insert(pveSnapshots)
        .values({
          tenantId,
          clusterId,
          guestId: guest?.id ?? "",
          sequence: 1,
          kind: "ct",
          archiveName: `ct/${vmid}/2026-10-20T22:00:00Z`,
          storageId: "restow",
          manifestPath: `ct-${vmid}`,
          guestConfig: "arch: amd64\nunprivileged: 1\n",
          backupAt: new Date(clock.getTime() - DAY),
        })
        .returning();
      await owner
        .update(pveGuests)
        .set({ lastSnapshotId: point?.id ?? null })
        .where(eq(pveGuests.id, guest?.id ?? ""));
      return guest?.id ?? "";
    };
    // Both problem guests wait longer (never tested) than the healthy one.
    const split = await container(221, "pve-repository-split");
    const repairFailed = await container(222, "pve-repository-repair-failed");
    const healthy = await container(223, null);
    await owner
      .update(pveGuests)
      .set({ lastRestoreTestAt: new Date(clock.getTime() - 40 * DAY) })
      .where(eq(pveGuests.id, healthy));
    const ids = [split, repairFailed, healthy];
    const restoreTasks = async (id: string) =>
      owner
        .select()
        .from(pveTasks)
        .where(and(eq(pveTasks.guestId, id), eq(pveTasks.kind, "restore")));
    const stampOf = async (id: string) =>
      (await owner.select().from(pveGuests).where(eq(pveGuests.id, id)))[0]?.lastRestoreTestAt;
    try {
      expect(await planRestoreTests(deps, clock)).toBe(1);
      expect(await restoreTasks(split)).toHaveLength(0);
      expect(await restoreTasks(repairFailed)).toHaveLength(0);
      expect(await stampOf(split)).toBeNull();
      expect(await stampOf(repairFailed)).toBeNull();
      expect(await restoreTasks(healthy)).toHaveLength(1);
      // Once the problem is cleared (a backup found the repository, a repair succeeded), the
      // guest is tested on the next pass.
      await owner.update(pveGuests).set({ repositoryProblem: null }).where(eq(pveGuests.id, split));
      expect(await planRestoreTests(deps, clock)).toBe(1);
      expect(await restoreTasks(split)).toHaveLength(1);
      expect(await restoreTasks(repairFailed)).toHaveLength(0);
    } finally {
      await owner.delete(pveRuns).where(inArray(pveRuns.guestId, ids));
      await owner.delete(pveTasks).where(inArray(pveTasks.guestId, ids));
      await owner.update(pveGuests).set({ lastSnapshotId: null }).where(inArray(pveGuests.id, ids));
      await owner.delete(pveSnapshots).where(inArray(pveSnapshots.guestId, ids));
      await owner.delete(pveGuests).where(inArray(pveGuests.id, ids));
      await owner.delete(pveJobs).where(eq(pveJobs.id, jobId));
    }
  });

  it("closes a backup run its node no longer lists, after a grace, and only with a fresh list (#46)", async () => {
    const [node] = await owner.select().from(pveNodes).where(eq(pveNodes.name, "pve1"));
    const nodeId = node?.id ?? "";
    const minutesAgo = (minutes: number) => new Date(clock.getTime() - minutes * 60_000);
    const open = async (startedAt: Date) => {
      const [run] = await owner
        .insert(pveRuns)
        .values({ tenantId, clusterId, guestId, nodeId, kind: "backup", startedAt })
        .returning();
      return run?.id ?? "";
    };
    const statusOf = async (id: string) =>
      (await owner.select().from(pveRuns).where(eq(pveRuns.id, id)))[0];
    const dropped = await open(minutesAgo(30));
    const listed = await open(minutesAgo(30));
    const justOpened = await open(minutesAgo(5));

    // A helper before 0.4.0 sends no list: nothing is closed early.
    await owner
      .update(pveNodes)
      .set({ facts: { state: "idle" } })
      .where(eq(pveNodes.id, nodeId));
    expect(await closeRunsNodesDropped(deps, clock)).toBe(0);

    // A list from an hour ago says nothing about now.
    await owner
      .update(pveNodes)
      .set({ facts: { activeRuns: [listed], activeRunsAt: minutesAgo(60).toISOString() } })
      .where(eq(pveNodes.id, nodeId));
    expect(await closeRunsNodesDropped(deps, clock)).toBe(0);

    await owner
      .update(pveNodes)
      .set({ facts: { activeRuns: [listed], activeRunsAt: clock.toISOString() } })
      .where(eq(pveNodes.id, nodeId));
    expect(await closeRunsNodesDropped(deps, clock)).toBe(1);
    expect(await statusOf(dropped)).toMatchObject({
      status: "failed",
      errorMessage: expect.stringContaining("no longer works on this run"),
    });
    expect((await statusOf(listed))?.status).toBe("running");
    expect((await statusOf(justOpened))?.status).toBe("running");
    // Closed once.
    expect(await closeRunsNodesDropped(deps, clock)).toBe(0);
    await owner.delete(pveRuns).where(inArray(pveRuns.id, [listed, justOpened, dropped]));
  });

  it("ends a cancelled backup cancelled when its node stays silent, and only then (0.4.2)", async () => {
    const [node] = await owner.select().from(pveNodes).where(eq(pveNodes.name, "pve1"));
    const nodeId = node?.id ?? "";
    const minutesAgo = (minutes: number) => new Date(clock.getTime() - minutes * 60_000);
    const [run] = await owner
      .insert(pveRuns)
      .values({
        tenantId,
        clusterId,
        guestId,
        nodeId,
        kind: "backup",
        startedAt: minutesAgo(40),
        cancelRequestedAt: minutesAgo(20),
        cancelledBy: "admin@contoso.example",
      })
      .returning();
    const id = run?.id ?? "";
    // The node called after the stop was asked for: it is on it.
    await owner
      .update(pveNodes)
      .set({ lastSeenAt: minutesAgo(1) })
      .where(eq(pveNodes.id, nodeId));
    expect(await closeCancelledRunsOfSilentNodes(deps, clock)).toBe(0);
    // Silent since before the request, for longer than 15 minutes: nobody will end it.
    await owner
      .update(pveNodes)
      .set({ lastSeenAt: minutesAgo(25) })
      .where(eq(pveNodes.id, nodeId));
    expect(await closeCancelledRunsOfSilentNodes(deps, clock)).toBe(1);
    const [after] = await owner.select().from(pveRuns).where(eq(pveRuns.id, id));
    expect(after).toMatchObject({ status: "cancelled", cancelledBy: "admin@contoso.example" });
    expect(await closeCancelledRunsOfSilentNodes(deps, clock)).toBe(0);
    await owner.update(pveNodes).set({ lastSeenAt: clock }).where(eq(pveNodes.id, nodeId));
    await owner.delete(pveRuns).where(eq(pveRuns.id, id));
  });

  it("deletes an existing PVE API token once its enrollment token is used, revoked or expired", async () => {
    const secretRow = async (label: string) => {
      const [row] = await owner
        .insert(secrets)
        .values({ tenantId, kind: "pve_api_token", ciphertext: `sealed-${label}` })
        .returning();
      return row?.id ?? "";
    };
    const token = async (
      label: string,
      values: { expiresAt: Date; revokedAt?: Date; usedByNodeId?: string },
    ) => {
      const secretId = await secretRow(label);
      await owner.insert(pveEnrollmentTokens).values({
        tenantId,
        tokenHash: createHash("sha256").update(label).digest("hex"),
        pveTokenSecretId: secretId,
        ...values,
      });
      return secretId;
    };
    const later = new Date(clock.getTime() + DAY);
    const valid = await token("valid", { expiresAt: later });
    const expired = await token("expired", { expiresAt: new Date(clock.getTime() - 1000) });
    const revoked = await token("revoked", { expiresAt: later, revokedAt: clock });
    const used = await token("used", { expiresAt: later, usedByNodeId: guestId });

    expect(await dropPveTokenSecrets(deps, clock)).toBe(3);
    const left = (await owner.select({ id: secrets.id }).from(secrets)).map((r) => r.id);
    expect(left).toContain(valid);
    for (const gone of [expired, revoked, used]) {
      expect(left).not.toContain(gone);
    }
    const refs = await owner
      .select({ ref: pveEnrollmentTokens.pveTokenSecretId })
      .from(pveEnrollmentTokens);
    expect(refs.filter((r) => r.ref !== null).map((r) => r.ref)).toEqual([valid]);
    expect(await dropPveTokenSecrets(deps, clock)).toBe(0);
  });

  /** The repository's config and a key on the primary (the fake restic needs nothing more). */
  async function completeRepository(id: string): Promise<void> {
    await storage.primary.put(`pve-guests/${id}/config`, Buffer.from("config"));
    await storage.primary.put(`pve-guests/${id}/keys/${"a".repeat(64)}`, Buffer.from("key"));
  }

  it("reports a repository not complete on the primary instead of restic's own error", async () => {
    const keys = await deps.runtime.keyrings.get(tenantId);
    const secretId = randomUUID();
    await owner.insert(secrets).values({
      id: secretId,
      tenantId,
      kind: "pve_ct_repository",
      ciphertext: sealSecret(keys.current, secretId, "repository-password"),
    });
    const [ct] = await owner
      .insert(pveGuests)
      .values({
        tenantId,
        clusterId,
        vmid: 330,
        kind: "ct",
        node: "pve1",
        repositorySecretId: secretId,
      })
      .returning();
    const guest = ct?.id ?? "";
    // CT 109 on NFW-01: data and a snapshot, no config and no keys.
    await storage.primary.put(`pve-guests/${guest}/data/ab/${"ab".repeat(32)}`, Buffer.from("x"));
    const [point] = await owner
      .insert(pveSnapshots)
      .values({
        tenantId,
        clusterId,
        guestId: guest,
        sequence: 1,
        kind: "ct",
        archiveName: "ct/330/2026-10-16T14:07:57Z",
        storageId: "restow",
        resticSnapshotId: "f".repeat(64),
        manifestPath: `tenants/${tenantId}/manifests/${randomUUID()}`,
        backupAt: clock,
      })
      .returning();
    const result = await verifySnapshot(deps, point as never);
    expect(result.errors).toEqual([
      expect.stringContaining("holds data without its config or keys: it is split across targets"),
    ]);
    const [row] = await owner.select().from(pveGuests).where(eq(pveGuests.id, guest));
    expect(row?.repositoryProblem).toMatchObject({
      type: "pve-repository-split",
      activePoints: 1,
    });
    await owner.delete(pveGuests).where(eq(pveGuests.id, guest));
  });

  /** A container with a stored repository password and one active restore point. */
  async function containerWithActivePoint(vmid: number, snapshotId = "f".repeat(64)) {
    const keys = await deps.runtime.keyrings.get(tenantId);
    const secretId = randomUUID();
    await owner.insert(secrets).values({
      id: secretId,
      tenantId,
      kind: "pve_ct_repository",
      ciphertext: sealSecret(keys.current, secretId, "repository-password"),
    });
    const [ct] = await owner
      .insert(pveGuests)
      .values({ tenantId, clusterId, vmid, kind: "ct", node: "pve1", repositorySecretId: secretId })
      .returning();
    const [point] = await owner
      .insert(pveSnapshots)
      .values({
        tenantId,
        clusterId,
        guestId: ct?.id ?? "",
        sequence: 1,
        kind: "ct",
        archiveName: `ct/${vmid}/2026-10-16T14:07:57Z`,
        storageId: "restow",
        resticSnapshotId: snapshotId,
        manifestPath: `tenants/${tenantId}/manifests/${randomUUID()}`,
        backupAt: clock,
      })
      .returning();
    return { guest: ct?.id ?? "", point };
  }

  it("searches the dropped installation default and keeps the API's more specific finding", async () => {
    const defaults = new LocalStorageBackend(join(work, "installation-default"));
    const withDefault: PveDeps = { ...deps, installationDefault: async () => defaults };
    const { guest, point } = await containerWithActivePoint(331);
    // CT 100 after 0.4.1's promotion: complete on the installation default only.
    await defaults.put(`pve-guests/${guest}/config`, Buffer.from("config"));
    await defaults.put(`pve-guests/${guest}/keys/${"a".repeat(64)}`, Buffer.from("key"));
    const found = await verifySnapshot(withDefault, point as never);
    expect(found.errors).toEqual([expect.stringContaining("but on the installation default")]);
    const [row] = await owner.select().from(pveGuests).where(eq(pveGuests.id, guest));
    expect(row?.repositoryProblem).toMatchObject({
      type: "pve-repository-elsewhere",
      heldBy: "installation_default",
    });
    // Where the default cannot be searched (here: none given), what the API recorded stays.
    const blind: PveDeps = { ...deps, installationDefault: async () => null };
    const vague = await verifySnapshot(blind, point as never);
    expect(vague.errors).toEqual([expect.stringContaining("on no storage target")]);
    const [after] = await owner.select().from(pveGuests).where(eq(pveGuests.id, guest));
    expect(after?.repositoryProblem).toMatchObject({
      type: "pve-repository-elsewhere",
      heldBy: "installation_default",
    });
    await owner.delete(pveGuests).where(eq(pveGuests.id, guest));
  });

  it("refuses after a failed repair even with config and a key on the primary", async () => {
    const { guest, point } = await containerWithActivePoint(332);
    await completeRepository(guest);
    const problem = {
      at: clock.toISOString(),
      type: "pve-repository-repair-failed",
      heldBy: null,
      activePoints: 1,
    };
    await owner
      .update(pveGuests)
      .set({ repositoryProblem: problem })
      .where(eq(pveGuests.id, guest));
    const result = await verifySnapshot(deps, point as never);
    expect(result.errors).toEqual([expect.stringContaining("repository repair could not rebuild")]);
    const [row] = await owner.select().from(pveGuests).where(eq(pveGuests.id, guest));
    expect(row?.repositoryProblem).toEqual(problem);
    await owner.delete(pveGuests).where(eq(pveGuests.id, guest));
  });

  it("refuses while an active restore point's snapshot lies only on another target", async () => {
    const defaults = new LocalStorageBackend(join(work, "installation-default-split"));
    const withDefault: PveDeps = { ...deps, installationDefault: async () => defaults };
    const snapshotId = "d".repeat(64);
    const { guest, point } = await containerWithActivePoint(333, snapshotId);
    // Config and a key on the primary, the snapshot on the installation default: a prune on
    // the primary would remove the packs that snapshot needs.
    await completeRepository(guest);
    await defaults.put(`pve-guests/${guest}/snapshots/${snapshotId}`, Buffer.from("snapshot"));
    const result = await verifySnapshot(withDefault, point as never);
    expect(result.errors).toEqual([
      expect.stringContaining("lie on the installation default but not on the primary"),
    ]);
    const [row] = await owner.select().from(pveGuests).where(eq(pveGuests.id, guest));
    expect(row?.repositoryProblem).toMatchObject({
      type: "pve-repository-split",
      heldBy: "installation_default",
    });
    await owner.delete(pveGuests).where(eq(pveGuests.id, guest));
  });

  it("checks a container repository only while the file restore does not read it (#62)", async () => {
    const keys = await deps.runtime.keyrings.get(tenantId);
    const secretId = randomUUID();
    await owner.insert(secrets).values({
      id: secretId,
      tenantId,
      kind: "pve_ct_repository",
      ciphertext: sealSecret(keys.current, secretId, "repository-password"),
    });
    const [ct] = await owner
      .insert(pveGuests)
      .values({
        tenantId,
        clusterId,
        vmid: 300,
        kind: "ct",
        node: "pve1",
        repositorySecretId: secretId,
      })
      .returning();
    await completeRepository(ct?.id ?? "");
    const [point] = await owner
      .insert(pveSnapshots)
      .values({
        tenantId,
        clusterId,
        guestId: ct?.id ?? "",
        sequence: 1,
        kind: "ct",
        archiveName: "ct/300/2026-10-10T10:00:00Z",
        storageId: "restow",
        manifestPath: "unused",
        resticSnapshotId: "d".repeat(64),
        backupAt: clock,
      })
      .returning();
    await owner
      .update(pveGuests)
      .set({ lastSnapshotId: point?.id ?? null })
      .where(eq(pveGuests.id, ct?.id ?? ""));
    const guestRow = async () =>
      (
        await owner
          .select()
          .from(pveGuests)
          .where(eq(pveGuests.id, ct?.id ?? ""))
      )[0];

    // A download of its files holds the repository: the check waits, then leaves it for later.
    const reading = await acquireEndpointRepositoryLock(
      owner.$client,
      pveGuestRepositoryLockKey(ct?.id ?? ""),
      { mode: "shared" },
    );
    const waiting = { ...deps, repositoryLockWaitMs: 300 };
    try {
      await verifyDue(waiting, clock);
      expect((await guestRow())?.lastVerifyAt).toBeNull();
    } finally {
      await reading();
    }
    // Free again: the check runs (and reports that the scratch repository does not exist).
    await verifyDue(waiting, clock);
    expect((await guestRow())?.lastVerifyAt).toEqual(clock);
    const [checked] = await owner
      .select()
      .from(pveSnapshots)
      .where(eq(pveSnapshots.id, point?.id ?? ""));
    expect(checked?.verify?.errors.length).toBeGreaterThan(0);

    // Prepared ZIP downloads go an hour after they expired.
    await owner.insert(pveDownloads).values([
      {
        tenantId,
        snapshotId: point?.id ?? "",
        selection: [{ path: "/etc", type: "dir" }],
        expiresAt: new Date(clock.getTime() - 2 * 60 * 60 * 1000),
      },
      {
        tenantId,
        snapshotId: point?.id ?? "",
        selection: [{ path: "/etc", type: "dir" }],
        expiresAt: new Date(clock.getTime() - 60 * 1000),
      },
    ]);
    expect(await purgeDownloads(deps, clock)).toBe(1);
    expect(await owner.select().from(pveDownloads)).toHaveLength(1);
  }, 60_000);
  it("postpones a container check another run's lock keeps out, and never calls it failed", async () => {
    // A restic that logs every call and answers `check` as the mode file says.
    const fake = join(work, "restic-locks.sh");
    const calls = join(work, "restic-locks.calls");
    const mode = join(work, "restic-locks.mode");
    await writeFile(
      fake,
      [
        "#!/bin/sh",
        `echo "$*" >> '${calls}'`,
        // The restore point's snapshot is in the repository.
        `if [ "$1" = "snapshots" ]; then echo '[{"id":"${"e".repeat(64)}","time":"2026-10-10T11:00:00Z","tags":[]}]'; exit 0; fi`,
        'if [ "$1" != "check" ]; then exit 0; fi',
        `if [ "$(cat '${mode}')" = "ok" ]; then echo "no errors were found"; exit 0; fi`,
        "cat >&2 <<'EOF'",
        "repo already locked, waiting up to 2m0s for the lock",
        "unable to create lock in backend: repository is already locked by PID 4711 on host pve1 by root (UID 0, GID 0)",
        "lock was created at 2026-10-10 11:58:00 (2m0s ago)",
        "storage ID 1a2b3c4d",
        'the "unlock" command can be used to remove stale locks',
        "EOF",
        "exit 11",
      ].join("\n"),
    );
    await chmod(fake, 0o755);
    await writeFile(mode, "locked");
    await writeFile(calls, "");
    const checks = async () =>
      (await readFile(calls, "utf8")).split("\n").filter((line) => line.startsWith("check"));
    const before = process.env.RESTIC_BINARY;
    process.env.RESTIC_BINARY = fake;
    const keys = await deps.runtime.keyrings.get(tenantId);
    const newGuest = async (vmid: number, requestedAt: Date | null) => {
      const secretId = randomUUID();
      await owner.insert(secrets).values({
        id: secretId,
        tenantId,
        kind: "pve_ct_repository",
        ciphertext: sealSecret(keys.current, secretId, "repository-password"),
      });
      const [ct] = await owner
        .insert(pveGuests)
        .values({
          tenantId,
          clusterId,
          vmid,
          kind: "ct",
          node: "pve1",
          repositorySecretId: secretId,
        })
        .returning();
      await completeRepository(ct?.id ?? "");
      const [point] = await owner
        .insert(pveSnapshots)
        .values({
          tenantId,
          clusterId,
          guestId: ct?.id ?? "",
          sequence: 1,
          kind: "ct",
          archiveName: `ct/${vmid}/2026-10-10T11:00:00Z`,
          storageId: "restow",
          manifestPath: "unused",
          resticSnapshotId: "e".repeat(64),
          backupAt: clock,
          verifyRequestedAt: requestedAt,
        })
        .returning();
      await owner
        .update(pveGuests)
        .set({ lastSnapshotId: point?.id ?? null, lastVerifyAt: clock })
        .where(eq(pveGuests.id, ct?.id ?? ""));
      return { guestId: ct?.id ?? "", pointId: point?.id ?? "" };
    };
    const point = async (id: string) =>
      (await owner.select().from(pveSnapshots).where(eq(pveSnapshots.id, id)))[0];
    const guest = async (id: string) =>
      (await owner.select().from(pveGuests).where(eq(pveGuests.id, id)))[0];
    try {
      const committedAt = new Date(clock.getTime() - 60_000);
      const ct = await newGuest(310, committedAt);
      const [node] = await owner.select().from(pveNodes).where(eq(pveNodes.name, "pve1"));

      // Its next backup runs (or the node took it on): the check waits, nothing is recorded.
      const [run] = await owner
        .insert(pveRuns)
        .values({
          tenantId,
          clusterId,
          nodeId: node?.id ?? null,
          guestId: ct.guestId,
          kind: "backup",
          startedAt: clock,
        })
        .returning();
      await verifyDue(deps, clock);
      await owner
        .update(pveRuns)
        .set({ status: "succeeded" })
        .where(eq(pveRuns.id, run?.id ?? ""));
      const [task] = await owner
        .insert(pveTasks)
        .values({
          tenantId,
          nodeId: node?.id ?? "",
          guestId: ct.guestId,
          kind: "backup",
          status: "delivered",
          expiresAt: new Date(clock.getTime() + DAY),
        })
        .returning();
      await verifyDue(deps, clock);
      expect(await checks()).toEqual([]);
      expect((await point(ct.pointId))?.verifyRequestedAt).toEqual(committedAt);
      await owner
        .update(pveTasks)
        .set({ status: "done" })
        .where(eq(pveTasks.id, task?.id ?? ""));
      // Asked for, but not due yet (a moment after the commit): later.
      await owner
        .update(pveSnapshots)
        .set({ verifyRequestedAt: new Date(clock.getTime() + 60_000) })
        .where(eq(pveSnapshots.id, ct.pointId));
      await verifyDue(deps, clock);
      expect(await checks()).toEqual([]);
      await owner
        .update(pveSnapshots)
        .set({ verifyRequestedAt: committedAt })
        .where(eq(pveSnapshots.id, ct.pointId));

      // Locked (a record of a server before 0.5.0; a check runs without a lock now): the check
      // is postponed. Not failed, not checked, the weekly clock untouched. No restic unlock: a
      // check without a lock needs none.
      expect(await verifyDue(deps, clock)).toBe(0);
      expect(await checks()).toEqual(["check --no-lock --read-data-subset=5%"]);
      expect(await readFile(calls, "utf8")).not.toContain("unlock");
      let row = await point(ct.pointId);
      expect(row?.verifyRequestedAt).toEqual(new Date(clock.getTime() + VERIFY_POSTPONE_MS));
      expect(row?.verify?.checkedAt).toBeUndefined();
      expect(row?.verify?.errors).toEqual([]);
      expect(row?.verify?.notChecked).toMatchObject({
        reason: "locked",
        since: committedAt.toISOString(),
        attempts: 1,
      });
      expect(row?.verify?.notChecked?.gaveUpAt).toBeUndefined();
      // restic's own report of who holds the lock is kept.
      expect(row?.verify?.notChecked?.detail).toContain("locked by PID 4711 on host pve1");
      expect(row?.verify?.notChecked?.detail).toContain("lock was created at");
      expect(pveRestorePointReadiness(row?.verify)).toBeNull();
      expect((await guest(ct.guestId))?.lastVerifyAt).toEqual(clock);

      // Tried again after the pause; after two hours it reads "could not check" (yellow).
      await verifyDue(deps, new Date(clock.getTime() + 5 * 60_000));
      expect(await checks()).toHaveLength(1);
      const gaveUp = new Date(committedAt.getTime() + VERIFY_GIVE_UP_MS);
      await verifyDue(deps, gaveUp);
      expect(await checks()).toHaveLength(2);
      row = await point(ct.pointId);
      expect(row?.verifyRequestedAt).toBeNull();
      expect(row?.verify).toMatchObject({ blocks: 0, mismatched: 0, errors: [] });
      expect(row?.verify?.notChecked).toMatchObject({
        reason: "locked",
        attempts: 2,
        gaveUpAt: gaveUp.toISOString(),
      });
      expect(pveRestorePointReadiness(row?.verify)).toBe("yellow");
      // The weekly clock tries again after a day.
      expect((await guest(ct.guestId))?.lastVerifyAt).toEqual(new Date(gaveUp.getTime() - 6 * DAY));

      // The lock is gone: the next check runs and is green again. A lock file a run left behind
      // weeks ago is removed from the storage first, whatever restic unlock makes of it; a
      // fresh one (a live run refreshes its lock every five minutes) stays.
      await writeFile(mode, "ok");
      const nextDay = new Date(gaveUp.getTime() + DAY + 60_000);
      const lockName = (n: number) => `${n}`.repeat(64);
      const lockKey = (n: number) => `pve-guests/${ct.guestId}/locks/${lockName(n)}`;
      const lockPath = (n: number) =>
        join(work, "storage", "pve-guests", ct.guestId, "locks", lockName(n));
      for (const n of [1, 2]) {
        await storage.primary.put(lockKey(n), Buffer.from("lock"));
      }
      const weeksAgo = new Date(nextDay.getTime() - 18 * DAY);
      await utimes(lockPath(1), weeksAgo, weeksAgo);
      const minuteAgo = new Date(nextDay.getTime() - 60_000);
      await utimes(lockPath(2), minuteAgo, minuteAgo);
      await verifyDue(deps, nextDay);
      expect(await storage.primary.head(lockKey(1))).toBeNull();
      expect(await storage.primary.head(lockKey(2))).not.toBeNull();
      await storage.primary.delete(lockKey(2));
      row = await point(ct.pointId);
      const passedAt = row?.verify?.checkedAt;
      expect(typeof passedAt).toBe("string");
      expect(row?.verify).toMatchObject({ errors: [], mismatched: 0 });
      expect(row?.verify?.notChecked).toBeUndefined();
      expect(pveRestorePointReadiness(row?.verify)).toBe("green");
      expect((await guest(ct.guestId))?.lastVerifyAt).toEqual(nextDay);

      // The weekly check of a guest with a passed check: postponed, its last result stands, and
      // the request takes it from there (one try per pass).
      await writeFile(mode, "locked");
      const week = new Date(nextDay.getTime() + 8 * DAY);
      // (Every other guest was checked lately.)
      await owner
        .update(pveGuests)
        .set({ lastVerifyAt: week })
        .where(sql`${pveGuests.id} <> ${ct.guestId}`);
      await writeFile(calls, "");
      await verifyDue(deps, week);
      row = await point(ct.pointId);
      expect(row?.verify).toMatchObject({ checkedAt: passedAt, errors: [] });
      expect(row?.verify?.notChecked).toMatchObject({ reason: "locked", attempts: 1 });
      expect(row?.verifyRequestedAt).toEqual(new Date(week.getTime() + VERIFY_POSTPONE_MS));
      expect(pveRestorePointReadiness(row?.verify)).toBe("green");
      expect(await checks()).toHaveLength(1);
      await owner
        .update(pveSnapshots)
        .set({ verifyRequestedAt: null })
        .where(eq(pveSnapshots.id, ct.pointId));
      await owner.update(pveGuests).set({ lastVerifyAt: week }).where(eq(pveGuests.id, ct.guestId));

      // A shutdown stops the check: nothing is recorded, the next worker checks it.
      const stopping = await newGuest(315, committedAt);
      const shutdown = new AbortController();
      shutdown.abort();
      await verifyDue(
        { ...deps, runtime: { ...deps.runtime, shutdownSignal: shutdown.signal } },
        clock,
      );
      const untouched = await point(stopping.pointId);
      expect(untouched?.verify).toBeNull();
      expect(untouched?.verifyRequestedAt).toEqual(committedAt);
      await owner
        .update(pveSnapshots)
        .set({ verifyRequestedAt: null })
        .where(eq(pveSnapshots.id, stopping.pointId));
    } finally {
      if (before === undefined) {
        delete process.env.RESTIC_BINARY;
      } else {
        process.env.RESTIC_BINARY = before;
      }
    }
  }, 60_000);

  /** A container with a newest restore point, and a check asked for at `requestedAt`. */
  async function containerWithPoint(
    vmid: number,
    requestedAt: Date | null,
    options: { brokenSecret?: boolean } = {},
  ): Promise<{ guestId: string; pointId: string }> {
    const keys = await deps.runtime.keyrings.get(tenantId);
    const secretId = randomUUID();
    await owner.insert(secrets).values({
      id: secretId,
      tenantId,
      kind: "pve_ct_repository",
      // Sealed for another id: it cannot be opened (the check cannot start).
      ciphertext: sealSecret(
        keys.current,
        options.brokenSecret ? randomUUID() : secretId,
        "repository-password",
      ),
    });
    const [ct] = await owner
      .insert(pveGuests)
      .values({ tenantId, clusterId, vmid, kind: "ct", node: "pve1", repositorySecretId: secretId })
      .returning();
    // Complete on the primary, so the check is not refused as a repository problem.
    await completeRepository(ct?.id ?? "");
    const [point] = await owner
      .insert(pveSnapshots)
      .values({
        tenantId,
        clusterId,
        guestId: ct?.id ?? "",
        sequence: 1,
        kind: "ct",
        archiveName: `ct/${vmid}/2026-10-10T11:00:00Z`,
        storageId: "restow",
        manifestPath: "unused",
        resticSnapshotId: "f".repeat(64),
        backupAt: clock,
        verifyRequestedAt: requestedAt,
      })
      .returning();
    await owner
      .update(pveGuests)
      .set({ lastSnapshotId: point?.id ?? null, lastVerifyAt: clock })
      .where(eq(pveGuests.id, ct?.id ?? ""));
    return { guestId: ct?.id ?? "", pointId: point?.id ?? "" };
  }

  /**
   * A restic that logs every call; `check` hangs for the guests in `hangFor`, else passes.
   * `snapshots` lists the restore points' snapshot (`containerWithPoint`) and an old one no
   * restore point names (a run that never committed).
   */
  async function loggingRestic(name: string, hangFor: string[] = []) {
    const fake = join(work, `${name}.sh`);
    const calls = join(work, `${name}.calls`);
    const listed = JSON.stringify([
      { id: "f".repeat(64), time: "2026-10-10T11:00:00Z", tags: [] },
      { id: "e".repeat(64), time: "2026-01-01T00:00:00Z", tags: [] },
    ]);
    await writeFile(
      fake,
      [
        "#!/bin/sh",
        `echo "$*" >> '${calls}'`,
        `if [ "$1" = "snapshots" ]; then echo '${listed}'; exit 0; fi`,
        'if [ "$1" != "check" ]; then exit 0; fi',
        ...hangFor.map((id) => `case "$RESTIC_CACHE_DIR" in *${id}*) exec sleep 60;; esac`),
        'echo "no errors were found"',
      ].join("\n"),
    );
    await chmod(fake, 0o755);
    await writeFile(calls, "");
    return { fake, read: async () => (await readFile(calls, "utf8")).split("\n").filter(Boolean) };
  }

  async function withRestic<T>(fake: string, work: () => Promise<T>): Promise<T> {
    const before = process.env.RESTIC_BINARY;
    process.env.RESTIC_BINARY = fake;
    try {
      return await work();
    } finally {
      if (before === undefined) {
        delete process.env.RESTIC_BINARY;
      } else {
        process.env.RESTIC_BINARY = before;
      }
    }
  }

  const pointRow = async (id: string) =>
    (await owner.select().from(pveSnapshots).where(eq(pveSnapshots.id, id)))[0];

  /** Leave only these restore points asked for, so the other tests' rows stay out of the way. */
  async function onlyRequested(ids: string[]) {
    await owner
      .update(pveSnapshots)
      .set({ verifyRequestedAt: null })
      .where(ids.length > 0 ? notInArray(pveSnapshots.id, ids) : undefined);
  }

  it("checks a container on a write-once share without a lock, and never runs restic unlock there", async () => {
    // The storage takes new files but refuses every deletion (EPERM), as a WORM NFS share does.
    class WriteOnce extends LocalStorageBackend {
      override async delete(key: string): Promise<void> {
        throw Object.assign(new Error(`EPERM: operation not permitted, unlink '${key}'`), {
          code: "EPERM",
        });
      }
    }
    const worm: StorageTargets = { primary: new WriteOnce(join(work, "storage")), copies: [] };
    const warned: string[] = [];
    const logger: typeof noopLogger = {
      debug: () => undefined,
      info: () => undefined,
      error: () => undefined,
      warn: (message: string) => {
        warned.push(message);
      },
      child: () => logger,
    };
    const wormDeps: PveDeps = {
      ...deps,
      runtime: {
        ...deps.runtime,
        logger,
        storage: new TenantCache<StorageTargets>(async () => worm),
      },
    };
    const restic = await loggingRestic("restic-worm");
    const ct = await containerWithPoint(330, new Date(clock.getTime() - 60_000));
    await onlyRequested([ct.pointId]);
    // A lock file left behind weeks ago: stale, and the share will not let it go.
    const lock = `pve-guests/${ct.guestId}/locks/${"7".repeat(64)}`;
    await storage.primary.put(lock, Buffer.from("lock"));
    const weeksAgo = new Date(clock.getTime() - 18 * DAY);
    await utimes(join(work, "storage", lock), weeksAgo, weeksAgo);
    // And one of two hours ago: stale by the storage, its own time still to be read.
    const recent = `pve-guests/${ct.guestId}/locks/${"8".repeat(64)}`;
    await storage.primary.put(recent, Buffer.from("lock"));
    const hoursAgo = new Date(clock.getTime() - 2 * 60 * 60_000);
    await utimes(join(work, "storage", recent), hoursAgo, hoursAgo);

    await withRestic(restic.fake, async () => {
      expect(await verifyDue(wormDeps, clock)).toBe(1);
      // A lock weeks old by the storage goes by that time alone: its own time is not read.
      // Its removal is refused, so nothing can go: the recent lock is not read either. The
      // snapshot list is read, the check runs without a lock; no restic unlock.
      expect(await restic.read()).toEqual([
        "snapshots --json --no-lock",
        "check --no-lock --read-data-subset=5%",
      ]);
      const row = await pointRow(ct.pointId);
      expect(typeof row?.verify?.checkedAt).toBe("string");
      expect(row?.verify?.errors).toEqual([]);
      expect(row?.verifyRequestedAt).toBeNull();
      expect(warned).toContain(
        "pve: stale locks of a container repository cannot be removed: the storage refuses deletes (write-once storage)",
      );
      expect(warned).not.toContain("pve: the locks of a container repository could not be listed");
      expect(await storage.primary.head(lock)).not.toBeNull();

      // Retention's comparison of the repository leaves restic unlock, forget and prune out
      // there: they could only fail. It stays claimed and is tried again after the retry delay.
      const guestRow = async () =>
        (await owner.select().from(pveGuests).where(eq(pveGuests.id, ct.guestId)))[0];
      await writeFile(join(work, "restic-worm.calls"), "");
      const refused = await reconcileGuestRepository(wormDeps, (await guestRow()) as never, clock);
      expect(refused).toEqual({ forgotten: [], deletesRefused: true });
      expect(await restic.read()).toEqual([]);
      expect((await guestRow())?.repositoryReconciledAt).toEqual(
        new Date(clock.getTime() - PVE_RECONCILE_EVERY_MS + PVE_RECONCILE_RETRY_MS),
      );
      // Where deletes work, unlock, the list, forget and prune run (each with a time limit).
      // The recent lock's own time is read first (unreadable here: it is kept, not a day old).
      await storage.primary.delete(lock);
      await writeFile(join(work, "restic-worm.calls"), "");
      warned.length = 0;
      const done = await reconcileGuestRepository(
        { ...deps, runtime: { ...deps.runtime, logger } },
        (await guestRow()) as never,
        clock,
      );
      expect(done).toEqual({ forgotten: ["e".repeat(64)], deletesRefused: false });
      expect(await storage.primary.head(recent)).not.toBeNull();
      // The log says what happens to it: kept, not removed.
      expect(warned).toContain(
        "pve: the time of a container repository's lock could not be read; the lock is kept and judged again by the next pass (removed once it was stored more than a day ago)",
      );
      expect(warned.filter((line) => line.includes("removed by its storage time alone"))).toEqual(
        [],
      );
      await storage.primary.delete(recent);
      // The headroom check's dry run (docs/STORAGE.md, "A full target") runs only when the
      // file system under the test's folder is short of space: not counted here.
      expect(
        (await restic.read())
          .filter((line) => !line.includes("--dry-run"))
          .map((line) => line.split(" ")[0]),
      ).toEqual(["cat", "unlock", "snapshots", "forget", "prune"]);
      expect((await guestRow())?.repositoryReconciledAt).toEqual(clock);
    });
  }, 60_000);

  it("stops a check that takes too long, and one that cannot start, and checks the rest of the queue", async () => {
    const hanging = await containerWithPoint(340, new Date(clock.getTime() - 3 * 60_000));
    const broken = await containerWithPoint(341, new Date(clock.getTime() - 2 * 60_000), {
      brokenSecret: true,
    });
    const fine = await containerWithPoint(342, new Date(clock.getTime() - 60_000));
    await onlyRequested([hanging.pointId, broken.pointId, fine.pointId]);
    const restic = await loggingRestic("restic-hang", [hanging.guestId]);
    await withRestic(restic.fake, async () => {
      const started = Date.now();
      expect(await verifyDue({ ...deps, checkTimeoutMs: 300 }, clock)).toBe(1);
      expect(Date.now() - started).toBeLessThan(20_000);
    });
    // Timed out: tried again later, never failed.
    const timedOut = await pointRow(hanging.pointId);
    expect(timedOut?.verify?.notChecked).toMatchObject({ reason: "interrupted", attempts: 1 });
    expect(timedOut?.verify?.notChecked?.detail).toContain("did not finish within");
    expect(timedOut?.verify?.errors).toEqual([]);
    expect(timedOut?.verifyRequestedAt).toEqual(new Date(clock.getTime() + VERIFY_POSTPONE_MS));
    // Could not start (its repository password cannot be opened): postponed with the reason.
    const notStarted = await pointRow(broken.pointId);
    expect(notStarted?.verify?.notChecked).toMatchObject({ reason: "error", attempts: 1 });
    expect(notStarted?.verifyRequestedAt).toEqual(new Date(clock.getTime() + VERIFY_POSTPONE_MS));
    // The one behind them was checked.
    const checked = await pointRow(fine.pointId);
    expect(typeof checked?.verify?.checkedAt).toBe("string");
    expect(checked?.verifyRequestedAt).toBeNull();

    // A pass out of time starts no new check: the rest waits for the next pass.
    await owner
      .update(pveSnapshots)
      .set({ verifyRequestedAt: new Date(clock.getTime() - 60_000), verify: null })
      .where(sql`${pveSnapshots.id} IN (${broken.pointId}::uuid, ${fine.pointId}::uuid)`);
    await owner
      .update(pveSnapshots)
      .set({ verifyRequestedAt: null })
      .where(eq(pveSnapshots.id, hanging.pointId));
    await withRestic(restic.fake, () => verifyDue({ ...deps, verifyBudgetMs: 0 }, clock));
    const left = [await pointRow(broken.pointId), await pointRow(fine.pointId)];
    expect(left.filter((row) => row?.verify !== null)).toHaveLength(1);
    await onlyRequested([]);
  }, 60_000);

  it("closes restore and boot test runs nothing will close any more, so their guest is checked again", async () => {
    const ct = await containerWithPoint(350, null);
    const [node] = await owner.select().from(pveNodes).where(eq(pveNodes.name, "pve1"));
    const base = {
      tenantId,
      clusterId,
      nodeId: node?.id ?? null,
      guestId: ct.guestId,
      snapshotId: ct.pointId,
      origin: "pve" as const,
    };
    const ago = (ms: number) => new Date(clock.getTime() - ms);
    const task = async (status: "delivered" | "done") =>
      (
        await owner
          .insert(pveTasks)
          .values({
            tenantId,
            nodeId: node?.id ?? "",
            guestId: ct.guestId,
            kind: "restore",
            status,
          })
          .returning()
      )[0]?.id ?? null;
    const insert = async (values: Partial<typeof pveRuns.$inferInsert>) =>
      (
        await owner
          .insert(pveRuns)
          .values({ ...base, kind: "restore", ...values })
          .returning()
      )[0]?.id ?? "";
    // A restore without a task that never got its restic credential: it cannot read anything.
    const noCredential = await insert({ startedAt: ago(26 * 60 * 60_000), resticExpiresAt: null });
    // A restore started in the PVE UI 26 hours ago, past its credential's own 24 hours: the
    // credential lives as long as its open run (pveRunCredentialLive), so it may still read and
    // is left to its report or the 48 hours.
    const long = await insert({
      startedAt: ago(26 * 60 * 60_000),
      resticExpiresAt: ago(2 * 60 * 60_000),
    });
    // A boot test that ended 20 minutes ago, and the restore it ran (credential still valid).
    await insert({
      kind: "boot_test",
      origin: "restow",
      status: "failed",
      startedAt: ago(60 * 60_000),
      finishedAt: ago(20 * 60_000),
    });
    const ofBootTest = await insert({
      startedAt: ago(58 * 60_000),
      resticExpiresAt: new Date(clock.getTime() + DAY),
    });
    // A restore check whose task is done, and one whose task the node still holds.
    const taskDone = await insert({
      kind: "restore_test",
      origin: "restow",
      taskId: await task("done"),
      startedAt: ago(60 * 60_000),
    });
    const taskOpen = await insert({
      kind: "restore_test",
      origin: "restow",
      taskId: await task("delivered"),
      startedAt: ago(60 * 60_000),
    });
    // A restore started in the PVE UI before the boot test that may still read, and one just
    // opened.
    const live = await insert({
      startedAt: ago(90 * 60_000),
      resticExpiresAt: new Date(clock.getTime() + DAY),
    });
    const fresh = await insert({ startedAt: ago(60_000), resticExpiresAt: ago(1) });

    expect(await closeOrphanedRuns(deps, clock)).toBeGreaterThanOrEqual(3);
    const status = async (id: string) =>
      (await owner.select().from(pveRuns).where(eq(pveRuns.id, id)))[0];
    for (const id of [noCredential, ofBootTest, taskDone]) {
      const run = await status(id);
      expect(run?.status).toBe("failed");
      expect(run?.errorMessage).toBe(PVE_ORPHANED_RUN_MESSAGE);
      expect(run?.finishedAt).toEqual(clock);
    }
    for (const id of [taskOpen, live, fresh, long]) {
      expect((await status(id))?.status).toBe("running");
    }
    // A boot test run nothing closes any more gets the outcome "error", like a stale one.
    const [bootTestTask] = await owner
      .insert(pveTasks)
      .values({
        tenantId,
        nodeId: node?.id ?? "",
        guestId: ct.guestId,
        kind: "boot_test",
        status: "failed",
      })
      .returning();
    const bootTest = await insert({
      kind: "boot_test",
      origin: "restow",
      taskId: bootTestTask?.id ?? null,
      startedAt: ago(60 * 60_000),
    });
    expect(await closeOrphanedRuns(deps, clock)).toBe(1);
    const closedBootTest = await status(bootTest);
    expect(closedBootTest).toMatchObject({
      status: "failed",
      errorMessage: PVE_ORPHANED_RUN_MESSAGE,
    });
    expect(closedBootTest?.stats.bootTest).toMatchObject({
      outcome: "error",
      reason: "node_error",
      message: PVE_ORPHANED_RUN_MESSAGE,
    });
    // Once the rest is over too, the guest's check runs (it was busy before). A restore or
    // restore check never ends succeeded without its result: they end failed here as well.
    await owner
      .update(pveRuns)
      .set({ status: "failed", finishedAt: clock })
      .where(inArray(pveRuns.id, [taskOpen, live, fresh, long]));
    await owner
      .update(pveSnapshots)
      .set({ verifyRequestedAt: ago(60_000) })
      .where(eq(pveSnapshots.id, ct.pointId));
    await onlyRequested([ct.pointId]);
    const restic = await loggingRestic("restic-orphans");
    await withRestic(restic.fake, async () => {
      expect(await verifyDue(deps, clock)).toBe(1);
    });
    expect(await closeOrphanedRuns(deps, clock)).toBe(0);
  }, 60_000);

  it("runs a due after-backup check before the boot test and restore test of the same pass", async () => {
    const ct = await containerWithPoint(360, new Date(clock.getTime() - 60_000));
    await onlyRequested([ct.pointId]);
    const [node] = await owner.select().from(pveNodes).where(eq(pveNodes.name, "pve1"));
    // A node that announced boot tests and calls in, a job with a boot test after every
    // backup and a monthly restore test, for this container only.
    await owner
      .update(pveNodes)
      .set({ facts: { ...node?.facts, capabilities: ["boot_test"] }, lastSeenAt: clock })
      .where(eq(pveNodes.id, node?.id ?? ""));
    const [job] = await owner
      .insert(pveJobs)
      .values({
        tenantId,
        name: "after-backup tests",
        scopeAll: false,
        settings: {
          bootTest: { schedule: "after_backup" },
          restoreTest: { enabled: true, targetStorage: "local-lvm" },
        },
      })
      .returning();
    await owner
      .update(pveGuests)
      .set({ jobId: job?.id ?? null })
      .where(eq(pveGuests.id, ct.guestId));
    const testsOf = (kind: "boot_test" | "restore_test") =>
      owner
        .select()
        .from(pveRuns)
        .where(and(eq(pveRuns.guestId, ct.guestId), eq(pveRuns.kind, kind)));
    try {
      const restic = await loggingRestic("restic-tests-after-check");
      // The pass's order: the tests are planned first, the checks run last. A test planned now
      // would keep the guest busy (its run counts as running at once) until the node is done.
      expect(await planRestoreTests(deps, clock)).toBe(0);
      expect(await planBootTests(deps, clock)).toBe(0);
      expect(await testsOf("boot_test")).toHaveLength(0);
      expect(await testsOf("restore_test")).toHaveLength(0);
      await withRestic(restic.fake, async () => {
        expect(await verifyDue(deps, clock)).toBe(1);
      });
      expect((await pointRow(ct.pointId))?.verifyRequestedAt).toBeNull();
      // The next pass plans both tests.
      expect(await planRestoreTests(deps, clock)).toBe(1);
      expect(await planBootTests(deps, clock)).toBe(1);
      expect(await testsOf("boot_test")).toHaveLength(1);
      expect(await testsOf("restore_test")).toHaveLength(1);
    } finally {
      await owner.delete(pveRuns).where(eq(pveRuns.guestId, ct.guestId));
      await owner.delete(pveTasks).where(eq(pveTasks.guestId, ct.guestId));
      await owner.update(pveGuests).set({ jobId: null }).where(eq(pveGuests.id, ct.guestId));
      await owner.delete(pveJobs).where(eq(pveJobs.id, job?.id ?? ""));
      await owner
        .update(pveNodes)
        .set({ facts: node?.facts ?? {}, lastSeenAt: node?.lastSeenAt ?? null })
        .where(eq(pveNodes.id, node?.id ?? ""));
    }
  }, 60_000);

  it("keeps every restore point of a guest held on suspicion, and garbage collection keeps their chunks", async () => {
    const [job] = await owner.select().from(pveJobs);
    const [held] = await owner
      .insert(pveGuests)
      .values({ tenantId, clusterId, vmid: 102, kind: "vm", node: "pve1", jobId: job?.id ?? null })
      .returning();
    const vm = { id: held?.id ?? "", vmid: 102 };
    // Three restore points; the job keeps two daily ones, so the oldest is due.
    const oldest = await commit(
      1,
      [blockOf(20), blockOf(21)],
      new Date(clock.getTime() - 3 * DAY),
      false,
      vm,
    );
    await commit(2, [blockOf(20), blockOf(22)], new Date(clock.getTime() - 2 * DAY), false, vm);
    await commit(3, [blockOf(20), blockOf(23)], new Date(clock.getTime() - DAY), false, vm);
    const [suspicion] = await owner
      .insert(restorePointSuspicions)
      .values({
        tenantId,
        objectKind: "pve_guest",
        objectId: vm.id,
        runId: randomUUID(),
        restorePointId: randomUUID(),
        restorePointAt: new Date(clock.getTime() - DAY),
        verdict: "suspicious",
        findings: [{ code: "incompressible_data", value: 0.99, threshold: 0.95 }],
        signals: { compressibility: "fired" },
        metrics: { itemsChanged: null, itemsTotal: null, bytesAdded: 1 },
        signaturesVersion: "test",
      })
      .returning();
    const activeOf = async () =>
      (await owner.select().from(pveSnapshots).where(eq(pveSnapshots.guestId, vm.id)))
        .filter((snap) => snap.status === "active")
        .map((snap) => snap.id);

    // Held: nothing of it goes, and no reference of it is released.
    await applyRetention(deps, clock);
    expect(await activeOf()).toHaveLength(3);

    // Garbage collection runs over the shared chunk store (it drops what the other guest's
    // retention released) and never touches a chunk the held restore points reference.
    const run = tenantRunner(appDb, tenantId);
    const keys = await deps.runtime.keyrings.get(tenantId);
    const gc = await collectGarbage(
      {
        tenantId,
        storage,
        keys,
        catalog: new PgPackCatalog(run, tenantId),
        logger: noopLogger,
        signal: new AbortController().signal,
        now: () => new Date(Date.now() + DAY),
      },
      {
        cutoff: new Date(Date.now() + DAY),
        keep: new Set(),
        minDeadFraction: 0,
        supersededGraceMs: 0,
      },
    );
    expect(gc.chunksDropped).toBeGreaterThan(0);
    const [oldestRow] = await owner.select().from(pveSnapshots).where(eq(pveSnapshots.id, oldest));
    const readBack = await verifySnapshot(deps, oldestRow as never, () => 0);
    expect(readBack).toMatchObject({ mismatched: 0, errors: [] });
    expect(readBack.blocks).toBeGreaterThan(0);

    // Released: retention resumes and the oldest restore point goes.
    await owner
      .update(restorePointSuspicions)
      .set({ holdReleasedAt: clock, holdReleasedBy: "admin@contoso.example" })
      .where(eq(restorePointSuspicions.id, suspicion?.id ?? ""));
    await applyRetention(deps, clock);
    const left = await activeOf();
    expect(left).toHaveLength(2);
    expect(left).not.toContain(oldest);
  });
  /** A container with a real restic repository in the test storage (needs restic). */
  async function realContainer(vmid: number) {
    const keys = await deps.runtime.keyrings.get(tenantId);
    const secretId = randomUUID();
    const password = `repository-password-${vmid}`;
    await owner.insert(secrets).values({
      id: secretId,
      tenantId,
      kind: "pve_ct_repository",
      ciphertext: sealSecret(keys.current, secretId, password),
    });
    const [ct] = await owner
      .insert(pveGuests)
      .values({
        tenantId,
        clusterId,
        vmid,
        kind: "ct",
        node: "pve1",
        repositorySecretId: secretId,
        repositoryReadyAt: clock,
      })
      .returning();
    const id = ct?.id ?? "";
    const data = join(work, `ct-${vmid}`);
    await mkdir(data, { recursive: true });
    const inRepo = <T>(fn: Parameters<typeof withRepository<T>>[1]) =>
      withRepository(
        {
          storage: storage.primary,
          prefix: `pve-guests/${id}/`,
          repositoryPassword: password,
          repositoryKey: `test-${id}`,
          binary: resticBinary(),
          cacheBase: join(work, "restic-cache"),
        },
        fn,
      );
    await inRepo((session) => resticInit(session));
    let n = 0;
    /** A restic snapshot as restow-pve writes it, tagged with its run; its id. */
    const backup = async (runId: string) => {
      await writeFile(join(data, "file"), `content ${n++} ${runId}`);
      return inRepo(async (session) => {
        await runRestic(session, [
          "backup",
          "--host",
          "pve1",
          "--tag",
          `vmid=${vmid}`,
          "--tag",
          `run=${runId}`,
          data,
        ]);
        const listed = await resticSnapshots(session, { noLock: true });
        return listed.find((snap) => snap.tags.includes(`run=${runId}`))?.id ?? "";
      });
    };
    const listed = async () =>
      (await inRepo((session) => resticSnapshots(session, { noLock: true }))).map((s) => s.id);
    const point = async (
      sequence: number,
      resticSnapshotId: string,
      runId: string,
      status = "active",
    ) => {
      const [row] = await owner
        .insert(pveSnapshots)
        .values({
          tenantId,
          clusterId,
          guestId: id,
          sequence,
          kind: "ct",
          archiveName: `ct/${vmid}/2026-10-0${sequence}T10:00:00Z`,
          storageId: "restow",
          manifestPath: "unused",
          resticSnapshotId,
          runId,
          backupAt: new Date(clock.getTime() - (10 - sequence) * DAY),
          status: status as "active",
        })
        .returning();
      return row as NonNullable<typeof row>;
    };
    const row = async () => (await owner.select().from(pveGuests).where(eq(pveGuests.id, id)))[0];
    return { id, backup, listed, point, row };
  }

  it.skipIf(!resticOk)(
    "forgets the restic snapshots no restore point holds, again after a failed pass, never a running run's or an active one's (S09, S10)",
    async () => {
      const ct = await realContainer(320);
      const runs = { active: randomUUID(), pruned: randomUUID(), orphan: randomUUID() };
      const [node] = await owner.select().from(pveNodes).where(eq(pveNodes.name, "pve1"));
      // A backup of the container runs: its snapshot is written, its commit has not come yet.
      const [running] = await owner
        .insert(pveRuns)
        .values({
          tenantId,
          clusterId,
          nodeId: node?.id ?? null,
          guestId: ct.id,
          kind: "backup",
          startedAt: new Date(),
        })
        .returning();
      const ids = {
        active: await ct.backup(runs.active),
        pruned: await ct.backup(runs.pruned),
        orphan: await ct.backup(runs.orphan),
        running: await ct.backup(running?.id ?? ""),
      };
      await ct.point(1, ids.active, runs.active);
      // Pruned before 0.5.0 (or its forget failed): the row says pruned, restic still has it.
      await ct.point(2, ids.pruned, runs.pruned, "pruned");
      const later = new Date(Date.now() + PVE_ORPHAN_SNAPSHOT_GRACE_MS + 60_000);

      // The guest is busy (its backup runs): retention leaves it alone (S10).
      await applyRetention(deps, later);
      expect((await ct.listed()).sort()).toEqual(Object.values(ids).sort());

      // The repository is held (a file restore reads it): the pass fails and records nothing
      // but its claim, which makes the comparison due again in an hour, not on every pass.
      const reading = await acquireEndpointRepositoryLock(
        owner.$client,
        pveGuestRepositoryLockKey(ct.id),
        { mode: "shared" },
      );
      const failedAt = new Date();
      try {
        await expect(
          reconcileGuestRepository(
            { ...deps, repositoryLockWaitMs: 300 },
            (await ct.row()) as never,
            failedAt,
          ),
        ).rejects.toThrow();
      } finally {
        await reading();
      }
      expect((await ct.row())?.repositoryReconciledAt).toEqual(
        new Date(failedAt.getTime() - PVE_RECONCILE_EVERY_MS + PVE_RECONCILE_RETRY_MS),
      );
      expect(await ct.listed()).toContain(ids.pruned);

      // The next pass forgets the same snapshot. A snapshot without a restore point that is
      // younger than the grace stays (its commit may still come), as do the active and the
      // running one.
      const first = await reconcileGuestRepository(deps, (await ct.row()) as never, new Date());
      expect(first.forgotten).toEqual([ids.pruned]);
      expect((await ct.listed()).sort()).toEqual([ids.active, ids.orphan, ids.running].sort());
      expect((await ct.row())?.repositoryReconciledAt).not.toBeNull();

      // After the grace: the orphan of a run that never committed goes; the running run's
      // snapshot stays while it runs.
      const second = await reconcileGuestRepository(deps, (await ct.row()) as never, later);
      expect(second.forgotten).toEqual([ids.orphan]);
      expect((await ct.listed()).sort()).toEqual([ids.active, ids.running].sort());

      // The run ended without a commit: a day later the pass of retention compares again.
      await owner
        .update(pveRuns)
        .set({ status: "failed", finishedAt: new Date() })
        .where(eq(pveRuns.id, running?.id ?? ""));
      await applyRetention(deps, new Date(later.getTime() + DAY + 60_000));
      expect(await ct.listed()).toEqual([ids.active]);
      expect((await ct.row())?.repositoryBytes).toBeGreaterThan(0);
    },
    120_000,
  );

  it.skipIf(!resticOk)(
    "a failed comparison is tried again after an hour, not on every pass",
    async () => {
      const ct = await realContainer(323);
      const run = randomUUID();
      const id = await ct.backup(run);
      await ct.point(1, id, run, "pruned");
      // The previous comparison failed half an hour ago (its claim is still in the column).
      const failedAt = new Date(Date.now() - 30 * 60_000);
      const claim = new Date(failedAt.getTime() - PVE_RECONCILE_EVERY_MS + PVE_RECONCILE_RETRY_MS);
      await owner
        .update(pveGuests)
        .set({ repositoryReconciledAt: claim })
        .where(eq(pveGuests.id, ct.id));
      await applyRetention(deps, new Date());
      expect(await ct.listed()).toContain(id);
      expect((await ct.row())?.repositoryReconciledAt).toEqual(claim);
      // An hour after the failure it is due again and forgets the snapshot.
      const retryAt = new Date(failedAt.getTime() + PVE_RECONCILE_RETRY_MS + 60_000);
      await applyRetention(deps, retryAt);
      expect(await ct.listed()).not.toContain(id);
      expect((await ct.row())?.repositoryReconciledAt).toEqual(retryAt);
    },
    120_000,
  );

  it.skipIf(!resticOk)(
    "forgets and prunes nothing while the repository has a problem (split, a failed repair)",
    async () => {
      const defaults = new LocalStorageBackend(join(work, "installation-default-reconcile"));
      const warned: { message: string; problem: unknown }[] = [];
      const logger: typeof noopLogger = {
        debug: () => undefined,
        info: () => undefined,
        error: () => undefined,
        warn: (message: string, fields?: Record<string, unknown>) => {
          warned.push({ message, problem: fields?.problem });
        },
        child: () => logger,
      };
      const withDefault: PveDeps = {
        ...deps,
        installationDefault: async () => defaults,
        runtime: { ...deps.runtime, logger },
      };
      const ct = await realContainer(325);
      const runs = { pruned: randomUUID(), active: randomUUID() };
      const prunedId = await ct.backup(runs.pruned);
      await ct.point(1, prunedId, runs.pruned, "pruned");
      // An active restore point whose snapshot lies only on the installation default: split.
      const elsewhere = "c".repeat(64);
      await ct.point(2, elsewhere, runs.active);
      await defaults.put(`pve-guests/${ct.id}/snapshots/${elsewhere}`, Buffer.from("snapshot"));
      const now = new Date();
      const split = await reconcileGuestRepository(withDefault, (await ct.row()) as never, now);
      expect(split).toEqual({ forgotten: [], deletesRefused: false });
      expect(await ct.listed()).toContain(prunedId);
      expect(warned).toContainEqual({
        message: "pve retention: restic forget skipped",
        problem: expect.stringContaining("the repository is split"),
      });
      expect((await ct.row())?.repositoryProblem).toMatchObject({ type: "pve-repository-split" });
      // Left claimed: due again after the retry delay, not stamped as compared.
      expect((await ct.row())?.repositoryReconciledAt).toEqual(
        new Date(now.getTime() - PVE_RECONCILE_EVERY_MS + PVE_RECONCILE_RETRY_MS),
      );

      // A failed repair refuses even with the repository whole on the primary.
      await defaults.delete(`pve-guests/${ct.id}/snapshots/${elsewhere}`);
      await owner
        .update(pveSnapshots)
        .set({ status: "pruned", prunedAt: new Date() })
        .where(eq(pveSnapshots.resticSnapshotId, elsewhere));
      await owner
        .update(pveGuests)
        .set({
          repositoryProblem: {
            at: now.toISOString(),
            type: "pve-repository-repair-failed",
            heldBy: null,
            activePoints: 0,
          },
        })
        .where(eq(pveGuests.id, ct.id));
      const failed = await reconcileGuestRepository(withDefault, (await ct.row()) as never, now);
      expect(failed.forgotten).toEqual([]);
      expect(await ct.listed()).toContain(prunedId);

      // Once the problem is gone, the comparison forgets the pruned point's snapshot.
      await owner.update(pveGuests).set({ repositoryProblem: null }).where(eq(pveGuests.id, ct.id));
      const done = await reconcileGuestRepository(withDefault, (await ct.row()) as never, now);
      expect(done.forgotten).toEqual([prunedId]);
      expect(await ct.listed()).not.toContain(prunedId);
    },
    120_000,
  );

  it.skipIf(!resticOk)(
    "a restore point pruned while the repository is compared keeps the comparison due",
    async () => {
      const ct = await realContainer(324);
      const runs = { old: randomUUID(), late: randomUUID() };
      const ids = { old: await ct.backup(runs.old), late: await ct.backup(runs.late) };
      await ct.point(1, ids.old, runs.old, "pruned");
      await ct.point(2, ids.late, runs.late);
      // Retention prunes the second restore point after the comparison read the rows and
      // before it records itself (here: while it measures the repository after the forget).
      const prefix = `pve-guests/${ct.id}/`;
      let pruned = false;
      const prunedMeanwhile = async () => {
        if (!pruned) {
          pruned = true;
          await owner
            .update(pveSnapshots)
            .set({ status: "pruned", prunedAt: new Date() })
            .where(eq(pveSnapshots.resticSnapshotId, ids.late));
          await owner
            .update(pveGuests)
            .set({ repositoryReconciledAt: null })
            .where(eq(pveGuests.id, ct.id));
        }
      };
      const primary = storage.primary;
      const watched = new Proxy(primary, {
        get(target, key, receiver) {
          const value = Reflect.get(target, key, receiver);
          // The measurement after the prune (listWithSizes); the search for repository problems
          // before the comparison lists the prefix as well, before the rows are read.
          if (key === "listWithSizes" && typeof value === "function") {
            return async (listed: string, ...rest: unknown[]) => {
              if (listed === prefix) {
                await prunedMeanwhile();
              }
              return value.call(target, listed, ...rest);
            };
          }
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const racing = {
        ...deps,
        runtime: {
          ...deps.runtime,
          storage: new TenantCache<StorageTargets>(async () => ({ primary: watched, copies: [] })),
        },
      };
      const result = await reconcileGuestRepository(racing, (await ct.row()) as never, new Date());
      expect(pruned).toBe(true);
      expect(result.forgotten).toEqual([ids.old]);
      // Not stamped: the snapshot of the point pruned meanwhile is still there, and the next
      // pass must compare again instead of waiting a day.
      expect((await ct.row())?.repositoryReconciledAt).toBeNull();
      const next = await reconcileGuestRepository(deps, (await ct.row()) as never, new Date());
      expect(next.forgotten).toEqual([ids.late]);
      expect((await ct.row())?.repositoryReconciledAt).not.toBeNull();
    },
    120_000,
  );

  it.skipIf(!resticOk)(
    "a container check fails when its restic snapshot is gone or belongs to another run (S12)",
    async () => {
      const ct = await realContainer(321);
      const runA = randomUUID();
      const runB = randomUUID();
      const a = await ct.backup(runA);
      const b = await ct.backup(runB);
      const pointA = await ct.point(1, a, runA);
      expect(await verifySnapshot(deps, pointA)).toMatchObject({ errors: [] });
      // The restore point names the snapshot of another run.
      const wrong = await ct.point(2, b, randomUUID());
      const mixed = await verifySnapshot(deps, wrong);
      expect(mixed.errors.join("\n")).toContain(`belongs to run ${runB}`);
      // The snapshot file is gone from the storage (restic check alone passes then; restic's
      // local cache still has it).
      await storage.primary.delete(`pve-guests/${ct.id}/snapshots/${a}`);
      const gone = await verifySnapshot(deps, pointA);
      expect(gone.errors.join("\n")).toContain("is not in the repository");
    },
    120_000,
  );

  it("a container check whose restic cannot start or reads a damaged repository is a finding, not postponed", async () => {
    const damaged = join(work, "restic-damaged.sh");
    await writeFile(
      damaged,
      [
        "#!/bin/sh",
        'if [ "$1" = "snapshots" ]; then echo "Fatal: unable to open config file: config or key is damaged: ciphertext verification failed" >&2; exit 1; fi',
        "exit 0",
      ].join("\n"),
    );
    await chmod(damaged, 0o755);
    const before = process.env.RESTIC_BINARY;
    try {
      let vmid = 370;
      for (const binary of [damaged, join(work, "no-such-restic")]) {
        process.env.RESTIC_BINARY = binary;
        const keys = await deps.runtime.keyrings.get(tenantId);
        const secretId = randomUUID();
        await owner.insert(secrets).values({
          id: secretId,
          tenantId,
          kind: "pve_ct_repository",
          ciphertext: sealSecret(keys.current, secretId, "repository-password"),
        });
        const [ct] = await owner
          .insert(pveGuests)
          .values({
            tenantId,
            clusterId,
            vmid,
            kind: "ct",
            node: "pve1",
            repositorySecretId: secretId,
          })
          .returning();
        // Complete on the primary: what fails is restic, not the search for the repository.
        await completeRepository(ct?.id ?? "");
        const [point] = await owner
          .insert(pveSnapshots)
          .values({
            tenantId,
            clusterId,
            guestId: ct?.id ?? "",
            sequence: 1,
            kind: "ct",
            archiveName: `ct/${vmid}/2026-10-10T11:00:00Z`,
            storageId: "restow",
            manifestPath: "unused",
            resticSnapshotId: "e".repeat(64),
            backupAt: clock,
          })
          .returning();
        vmid++;
        const result = await verifySnapshot(deps, point as never);
        // Recorded as a failed check with restic's words, never "check did not run".
        expect(result.errors.join("\n")).toMatch(
          binary === damaged ? /ciphertext verification failed/ : /ENOENT/,
        );
      }
    } finally {
      if (before === undefined) {
        delete process.env.RESTIC_BINARY;
      } else {
        process.env.RESTIC_BINARY = before;
      }
    }
  });

  it("postpones a container check whose snapshot list could not be read, never fails it (S12)", async () => {
    const fake = join(work, "restic-unreachable.sh");
    await writeFile(
      fake,
      [
        "#!/bin/sh",
        'if [ "$1" = "snapshots" ]; then echo "Fatal: unable to open repository: Get "http://127.0.0.1/config": connection reset by peer" >&2; exit 1; fi',
        "exit 0",
      ].join("\n"),
    );
    await chmod(fake, 0o755);
    const before = process.env.RESTIC_BINARY;
    process.env.RESTIC_BINARY = fake;
    try {
      const keys = await deps.runtime.keyrings.get(tenantId);
      const secretId = randomUUID();
      await owner.insert(secrets).values({
        id: secretId,
        tenantId,
        kind: "pve_ct_repository",
        ciphertext: sealSecret(keys.current, secretId, "repository-password"),
      });
      const [ct] = await owner
        .insert(pveGuests)
        .values({
          tenantId,
          clusterId,
          vmid: 322,
          kind: "ct",
          node: "pve1",
          repositorySecretId: secretId,
        })
        .returning();
      await completeRepository(ct?.id ?? "");
      const [point] = await owner
        .insert(pveSnapshots)
        .values({
          tenantId,
          clusterId,
          guestId: ct?.id ?? "",
          sequence: 1,
          kind: "ct",
          archiveName: "ct/322/2026-10-10T11:00:00Z",
          storageId: "restow",
          manifestPath: "unused",
          resticSnapshotId: "f".repeat(64),
          backupAt: clock,
          verifyRequestedAt: new Date(clock.getTime() - 60_000),
        })
        .returning();
      await verifyDue(deps, clock);
      const [row] = await owner
        .select()
        .from(pveSnapshots)
        .where(eq(pveSnapshots.id, point?.id ?? ""));
      expect(row?.verify?.errors ?? []).toEqual([]);
      expect(row?.verify?.notChecked).toMatchObject({ reason: "interrupted", attempts: 1 });
      expect(row?.verify?.notChecked?.detail).toContain("connection reset by peer");
      expect(row?.verifyRequestedAt).toEqual(new Date(clock.getTime() + VERIFY_POSTPONE_MS));
      await owner
        .update(pveSnapshots)
        .set({ verifyRequestedAt: null })
        .where(eq(pveSnapshots.id, point?.id ?? ""));
    } finally {
      if (before === undefined) {
        delete process.env.RESTIC_BINARY;
      } else {
        process.env.RESTIC_BINARY = before;
      }
    }
  });

  it("stops pruning when restore mode comes on mid-pass: the rest stays active with its references", async () => {
    const [job] = await owner
      .insert(pveJobs)
      .values({
        tenantId,
        name: "keep one",
        scopeAll: false,
        schedule: { kind: "daily", timeOfDay: "22:00", timeZone: "Europe/Berlin" },
        settings: { retention: { keepDaily: 1, keepWeekly: 0, keepMonthly: 0 } },
      })
      .returning();
    const [row] = await owner
      .insert(pveGuests)
      .values({ tenantId, clusterId, vmid: 103, kind: "vm", node: "pve1", jobId: job?.id ?? null })
      .returning();
    const vm = { id: row?.id ?? "", vmid: 103 };
    // Four restore points; the job keeps one daily, so three are due.
    const points: string[] = [];
    for (const [index, fill] of [30, 31, 32, 33].entries()) {
      points.push(
        await commit(
          index + 1,
          [blockOf(fill)],
          new Date(clock.getTime() - (4 - index) * DAY),
          false,
          vm,
        ),
      );
    }
    const pointsOf = async () =>
      owner.select().from(pveSnapshots).where(eq(pveSnapshots.guestId, vm.id));
    const before = await refTotal();

    // Restore mode comes on (another process detected it) right after the first manifest went.
    let restoreMode = false;
    const manifests = new Set(points.map((id) => manifestKey(tenantId, id)));
    const primary = storage.primary;
    const watched = new Proxy(primary, {
      get(target, prop, receiver) {
        if (prop === "delete") {
          return async (key: string) => {
            await target.delete(key);
            if (manifests.has(key)) {
              restoreMode = true;
            }
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as StorageBackend;
    const watchedDeps: PveDeps = {
      ...deps,
      runtime: {
        ...deps.runtime,
        storage: new TenantCache<StorageTargets>(async () => ({ primary: watched, copies: [] })),
      },
    };
    const uninstall = installDeletionEnforcement({
      async decide(): Promise<DeletionDecision> {
        if (!restoreMode) {
          return { allowed: true, keepUnknownBefore: null, inRestoreMode: false };
        }
        return { allowed: false, reason: "restore_mode", restoreModeId: null };
      },
      holding: () => restoreMode,
    });
    try {
      await applyRetention(watchedDeps, clock);
    } finally {
      uninstall();
    }

    const after = await pointsOf();
    const pruned = after.filter((snap) => snap.status === "pruned");
    expect(pruned).toHaveLength(1);
    expect(points.slice(0, 3)).toContain(pruned[0]?.id);
    // The two due restore points after it stay active, their manifests and references too: a
    // garbage collection after restore mode keeps their chunks.
    const active = after.filter((snap) => snap.status === "active");
    expect(active).toHaveLength(3);
    for (const snap of active) {
      expect(await storage.primary.head(manifestKey(tenantId, snap.id))).not.toBeNull();
    }
    expect(await refTotal()).toBe(before - (pruned[0]?.chunkRefs ?? 0));
  });
});
