/**
 * Server-side work for Proxmox VE guests against Postgres and a local
 * storage target: due jobs become backup tasks, retention prunes restore
 * points and releases exactly their chunk references (the map-aware
 * reference count of docs/PROXMOX.md 2.4), verify reads a block sample back
 * and notices a block that does not match its map, stale runs fail and give
 * their staged references back. A container check another run's restic lock
 * keeps out is postponed, then recorded as "could not check", never failed.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BLOCK_FLAG_PRESENT,
  buildPveManifest,
  ChunkWriter,
  collectGarbage,
  EnvKeyProvider,
  encodeBlockMap,
  generateDek,
  LocalStorageBackend,
  manifestKey,
  noopLogger,
  PVE_BLOCK_SIZE,
  pveRestorePointReadiness,
  type StorageTargets,
  sealManifest,
  sealSecret,
  type TenantKeyring,
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
  forgetResticSnapshots,
  PVE_ORPHANED_RUN_MESSAGE,
  type PveDeps,
  planBootTests,
  planJobs,
  planRestoreTests,
  purgeDownloads,
  pvePass,
  VERIFY_GIVE_UP_MS,
  VERIFY_POSTPONE_MS,
  verifyDue,
  verifySnapshot,
} from "./maintenance.js";

const adminUrl = process.env.RESTOW_TEST_DATABASE_URL;
const TEST_DB = "restow_worker_pve_test";
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const DAY = 24 * 60 * 60 * 1000;

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

  /** A restic that logs every call; `check` hangs for the guests in `hangFor`, else passes. */
  async function loggingRestic(name: string, hangFor: string[] = []) {
    const fake = join(work, `${name}.sh`);
    const calls = join(work, `${name}.calls`);
    await writeFile(
      fake,
      [
        "#!/bin/sh",
        `echo "$*" >> '${calls}'`,
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

    await withRestic(restic.fake, async () => {
      expect(await verifyDue(wormDeps, clock)).toBe(1);
      expect(await restic.read()).toEqual(["check --no-lock --read-data-subset=5%"]);
      const row = await pointRow(ct.pointId);
      expect(typeof row?.verify?.checkedAt).toBe("string");
      expect(row?.verify?.errors).toEqual([]);
      expect(row?.verifyRequestedAt).toBeNull();
      expect(warned).toContain(
        "pve: stale locks of a container repository cannot be removed: the storage refuses deletes (write-once storage)",
      );
      expect(warned).not.toContain("pve: the locks of a container repository could not be listed");
      expect(await storage.primary.head(lock)).not.toBeNull();

      // Retention leaves restic forget and prune out there: they could only fail.
      const [guest] = await owner.select().from(pveGuests).where(eq(pveGuests.id, ct.guestId));
      await writeFile(join(work, "restic-worm.calls"), "");
      await forgetResticSnapshots(wormDeps, guest as never, ["f".repeat(64)]);
      expect(await restic.read()).toEqual([]);
      // Where deletes work, unlock, forget and prune run (each with a time limit).
      await storage.primary.delete(lock);
      await forgetResticSnapshots(deps, guest as never, ["f".repeat(64)]);
      expect((await restic.read()).map((line) => line.split(" ")[0])).toEqual([
        "unlock",
        "forget",
        "prune",
      ]);
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
    // The restore of a boot test on an older node: no task, its credential long expired.
    const expired = await insert({
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
    for (const id of [expired, ofBootTest, taskDone]) {
      const run = await status(id);
      expect(run?.status).toBe("failed");
      expect(run?.errorMessage).toBe(PVE_ORPHANED_RUN_MESSAGE);
      expect(run?.finishedAt).toEqual(clock);
    }
    for (const id of [taskOpen, live, fresh]) {
      expect((await status(id))?.status).toBe("running");
    }
    // Once the rest is over too, the guest's check runs (it was busy before).
    await owner
      .update(pveRuns)
      .set({ status: "succeeded" })
      .where(inArray(pveRuns.id, [taskOpen, live, fresh]));
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
});
