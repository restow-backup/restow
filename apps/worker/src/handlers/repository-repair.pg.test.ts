/**
 * The repository repair (docs/STORAGE.md, "Repository repair") against Postgres and the real
 * restic binary, on the state of the 2026-10-16 field incident: the installation default holds
 * the first half of containers' repositories (config, keys, early packs), NFW-01 (now the
 * primary) the rest, or nothing; one container's config and keys are gone for good.
 *
 *   - the scan classifies each repository (`split`, `elsewhere`, `data_only`, `ok`) and changes
 *     nothing;
 *   - "apply" rebuilds the split and the elsewhere repositories on the primary (restic checks
 *     them and still finds every snapshot, the restore points stay active), marks the restore
 *     points of the one that cannot be opened as lost and lets its next backup begin a new chain,
 *     and leaves the complete one alone; every step is audited.
 *
 * Needs Postgres (RESTOW_TEST_DATABASE_URL, a superuser) and restic (RESTIC_BINARY, else PATH).
 */
import { spawn, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EnvKeyProvider,
  generateDek,
  LocalStorageBackend,
  manifestKey,
  noopLogger,
  resticBinary,
  type StorageTargets,
  sealSecret,
  type TenantKeyring,
} from "@restow/core";
import {
  acquireEndpointRepositoryLock,
  auditLog,
  createDb,
  type Database,
  deriveAuthLogin,
  pveClusters,
  pveGuestRepositoryLockKey,
  pveGuests,
  pveRuns,
  pveSnapshots,
  type RoleLogin,
  type StorageRepositoryRepairEntry,
  type StorageRepositoryScanEntry,
  secrets,
  storageRepositoryRepairs,
  storageTargets,
} from "@restow/db";
import { runMigrations } from "@restow/db/migrate";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dropTestDatabase } from "../testing/database.js";
import {
  loadTenantKeyring,
  PgSecretReader,
  resolveTenantStorage,
  TenantCache,
  tenantRunner,
} from "./framework.js";
import { type RepairDeps, repositoryRepairPass } from "./repository-repair.js";

const adminUrl = process.env.RESTOW_TEST_DATABASE_URL;
const TEST_DB = "restow_worker_repository_repair_test";

function resticAvailable(): boolean {
  try {
    return spawnSync(resticBinary(), ["version"]).status === 0;
  } catch {
    return false;
  }
}

const canRun = Boolean(adminUrl) && resticAvailable();

describe.skipIf(!canRun)("the repository repair rebuilds split repositories", () => {
  let owner: Database;
  let appDb: Database;
  let providerDb: Database;
  let deps: RepairDeps;
  let work: string;
  let tenantId: string;
  let clusterId: string;
  let defaultDir: string;
  let nfwDir: string;
  let keys: TenantCache<TenantKeyring>;
  const roleNames: string[] = [];
  const clock = new Date("2026-11-04T10:00:00Z");

  function restic(args: string[], password: string, cwd?: string) {
    return new Promise<{ code: number | null; out: string }>((resolve, reject) => {
      const child = spawn(resticBinary(), args, {
        cwd,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: work,
          RESTIC_PASSWORD: password,
          RESTIC_CACHE_DIR: join(work, "cache"),
        },
      });
      let out = "";
      child.stdout.on("data", (chunk) => {
        out += chunk;
      });
      child.stderr.on("data", (chunk) => {
        out += chunk;
      });
      child.once("error", reject);
      child.once("close", (code) => resolve({ code, out }));
    });
  }

  async function ok(args: string[], password: string, cwd?: string): Promise<string> {
    const result = await restic(args, password, cwd);
    expect(result.code, result.out).toBe(0);
    return result.out;
  }

  /** A container whose repository was created on `dir` and backed up once (restic itself). */
  async function container(vmid: number, dir: string) {
    const [guest] = await owner
      .insert(pveGuests)
      .values({ tenantId, clusterId, vmid, kind: "ct", name: `ct${vmid}`, node: "pve1" })
      .returning();
    const guestId = guest?.id as string;
    const password = randomBytes(16).toString("hex");
    const repo = join(dir, "pve-guests", guestId);
    await ok(["-r", repo, "init"], password);
    const data = join(work, `data-${vmid}`);
    await mkdir(data, { recursive: true });
    for (let i = 0; i < 6; i++) {
      await writeFile(join(data, `f${i}`), randomBytes(2 * 1024 * 1024));
    }
    const out = await ok(["-r", repo, "backup", "--json", "--pack-size", "4", "."], password, data);
    const summary = out
      .split("\n")
      .map((line) => {
        try {
          return JSON.parse(line) as { message_type?: string; snapshot_id?: string };
        } catch {
          return {};
        }
      })
      .find((line) => line.message_type === "summary");
    const keyring = await keys.get(tenantId);
    const secretId = randomUUID();
    await owner.insert(secrets).values({
      id: secretId,
      tenantId,
      kind: "pve_ct_repository",
      ciphertext: sealSecret(keyring.current, secretId, password),
      keyVersion: keyring.current.version,
    });
    await owner
      .update(pveGuests)
      .set({ repositorySecretId: secretId, repositoryReadyAt: new Date("2026-10-16T13:54:28Z") })
      .where(eq(pveGuests.id, guestId));
    const pointId = randomUUID();
    const [point] = await owner
      .insert(pveSnapshots)
      .values({
        id: pointId,
        manifestPath: manifestKey(tenantId, pointId),
        tenantId,
        clusterId,
        guestId,
        sequence: 1,
        kind: "ct",
        archiveName: `ct/${vmid}/2026-10-16T14:07:57Z`,
        storageId: "restow",
        resticSnapshotId: summary?.snapshot_id ?? null,
        backupAt: new Date("2026-10-16T14:07:57Z"),
      })
      .returning();
    return { guestId, password, repo, pointId: point?.id as string };
  }

  /** Move `subdir` of a repository from one storage directory to another. */
  async function moveDir(from: string, to: string) {
    await mkdir(join(to, ".."), { recursive: true });
    await cp(from, to, { recursive: true });
    await rm(from, { recursive: true, force: true });
  }

  beforeAll(async () => {
    const admin = createDb(adminUrl as string);
    await admin.$client.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await admin.$client.query(`CREATE DATABASE ${TEST_DB}`);
    await admin.$client.end();
    const url = new URL(adminUrl as string);
    url.pathname = `/${TEST_DB}`;
    const suffix = randomBytes(4).toString("hex");
    const tenantLogin: RoleLogin = {
      name: `restow_rr_app_${suffix}`,
      password: randomBytes(12).toString("hex"),
    };
    const installationLogin: RoleLogin = {
      name: `restow_rr_inst_${suffix}`,
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
    work = await mkdtemp(join(tmpdir(), "restow-repair-"));
    defaultDir = join(work, "data-chunks");
    nfwDir = join(work, "nfw-01");
    await mkdir(defaultDir, { recursive: true });
    await mkdir(nfwDir, { recursive: true });
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
    const provideKeys = new EnvKeyProvider(randomBytes(32));
    await q(
      "INSERT INTO tenant_keys (tenant_id, key_version, encrypted_dek, kek_id) VALUES ($1, 1, $2, 'env:RESTOW_MASTER_KEY')",
      [tenantId, (await provideKeys.wrapDek(generateDek(1))).toString("base64")],
    );
    keys = new TenantCache<TenantKeyring>((id) =>
      loadTenantKeyring({ db: appDb, tenantId: id, keyProvider: provideKeys }),
    );
    const defaultBackend = new LocalStorageBackend(defaultDir);
    const defaults: StorageTargets = { primary: defaultBackend, copies: [] };
    const storage = new TenantCache<StorageTargets>(async (id) =>
      resolveTenantStorage({
        run: tenantRunner(appDb, id),
        tenantId: id,
        secretReader: new PgSecretReader(tenantRunner(appDb, id), id, await keys.get(id)),
        defaults,
        logger: noopLogger,
      }),
    );
    deps = {
      db: appDb,
      providerDb,
      runtime: { keyrings: keys, storage, logger: noopLogger, now: () => clock },
      installationDefault: async () => defaultBackend,
    };
    const [cluster] = await owner
      .insert(pveClusters)
      .values({ tenantId, name: "lab", fingerprint: "c".repeat(64), storageId: "restow" })
      .returning();
    clusterId = cluster?.id ?? "";
  }, 120_000);

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

  /** Queue a scan or repair and run one pass; the finished row. */
  async function run(kind: "scan" | "apply", scanId: string | null = null, with_ = deps) {
    const [row] = await owner
      .insert(storageRepositoryRepairs)
      .values({ tenantId, kind, scanId, requestedBy: "admin@contoso.example" })
      .returning();
    expect(await repositoryRepairPass(with_)).toBe(1);
    const [done] = await owner
      .select()
      .from(storageRepositoryRepairs)
      .where(eq(storageRepositoryRepairs.id, row?.id as string));
    return done as NonNullable<typeof done>;
  }

  async function queue(
    kind: "scan" | "apply",
    scanId: string | null = null,
    with_ = deps,
  ): Promise<string> {
    const done = await run(kind, scanId, with_);
    expect(done.status, done.errorMessage ?? "").toBe("completed");
    return done.id;
  }

  async function result<T>(id: string): Promise<T[]> {
    const [row] = await owner
      .select()
      .from(storageRepositoryRepairs)
      .where(eq(storageRepositoryRepairs.id, id));
    return (row?.result?.repositories ?? []) as T[];
  }

  it("classifies, rebuilds, and marks what is lost", async () => {
    // CT 109: backed up on the installation default; then the run went on on NFW-01 (index,
    // snapshot and half of the packs there), and NFW-01 became the primary (0.4.1's promotion).
    const ct109 = await container(109, defaultDir);
    // CT 100: complete on the installation default only (the promotion dropped it).
    const ct100 = await container(100, defaultDir);
    // CT 105: its config and keys are gone with the installation default's folder.
    const ct105 = await container(105, defaultDir);
    // CT 117: began a new chain on NFW-01 and is complete there.
    const ct117 = await container(117, nfwDir);
    await owner.insert(storageTargets).values({
      tenantId,
      name: "NFW-01",
      kind: "local",
      role: "primary",
      config: { basePath: nfwDir },
    });

    const nfw109 = join(nfwDir, "pve-guests", ct109.guestId);
    await moveDir(join(ct109.repo, "index"), join(nfw109, "index"));
    await moveDir(join(ct109.repo, "snapshots"), join(nfw109, "snapshots"));
    const shards = (await readdir(join(ct109.repo, "data"))).sort();
    for (const shard of shards.slice(0, Math.ceil(shards.length / 2))) {
      await moveDir(join(ct109.repo, "data", shard), join(nfw109, "data", shard));
    }
    await mkdir(join(nfw109, "locks"), { recursive: true });
    // CT 105 on the installation default: data only.
    await rm(join(ct105.repo, "config"));
    await rm(join(ct105.repo, "keys"), { recursive: true, force: true });

    // The scan: classifies, changes nothing.
    const scanId = await queue("scan");
    const scanned = new Map(
      (await result<StorageRepositoryScanEntry>(scanId)).map((entry) => [entry.ownerId, entry]),
    );
    expect(scanned.get(ct109.guestId)).toMatchObject({
      class: "split",
      repairable: true,
      activePoints: 1,
    });
    expect(scanned.get(ct109.guestId)?.holdings.map((h) => [h.target, h.config])).toEqual(
      expect.arrayContaining([
        [expect.any(String), false],
        ["installation_default", true],
      ]),
    );
    expect(scanned.get(ct100.guestId)).toMatchObject({ class: "elsewhere", repairable: true });
    expect(scanned.get(ct105.guestId)).toMatchObject({ class: "data_only", repairable: false });
    expect(scanned.get(ct117.guestId)).toMatchObject({ class: "ok", filesToCopy: 0 });
    // Nothing was written to the primary by the scan.
    expect(
      await new LocalStorageBackend(nfwDir).head(`pve-guests/${ct109.guestId}/config`),
    ).toBeNull();
    const [scannedAudit] = await owner
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.tenantId, tenantId), eq(auditLog.action, "storage.repositories.scanned")),
      );
    expect(scannedAudit?.details).toMatchObject({ repositories: 4 });

    // Apply.
    const applyId = await queue("apply", scanId);
    const applied = new Map(
      (await result<StorageRepositoryRepairEntry>(applyId)).map((entry) => [entry.ownerId, entry]),
    );
    expect(applied.get(ct109.guestId)).toMatchObject({ outcome: "merged", lostPoints: 0 });
    expect(applied.get(ct100.guestId)).toMatchObject({ outcome: "merged", lostPoints: 0 });
    expect(applied.get(ct105.guestId)).toMatchObject({ outcome: "lost", lostPoints: 1 });
    expect(applied.get(ct117.guestId)).toMatchObject({ outcome: "unchanged" });

    // CT 109 and CT 100 are whole on NFW-01: restic reads every pack and finds the snapshot.
    for (const ct of [ct109, ct100]) {
      const repo = join(nfwDir, "pve-guests", ct.guestId);
      await ok(["-r", repo, "check", "--read-data"], ct.password);
      const listed = JSON.parse(await ok(["-r", repo, "snapshots", "--json"], ct.password)) as {
        id: string;
      }[];
      const [point] = await owner
        .select()
        .from(pveSnapshots)
        .where(eq(pveSnapshots.id, ct.pointId));
      expect(point?.status).toBe("active");
      expect(listed.map((s) => s.id)).toContain(point?.resticSnapshotId);
    }
    // CT 105: its restore point is lost, the guest begins a new chain at its next backup.
    const [lost] = await owner
      .select()
      .from(pveSnapshots)
      .where(eq(pveSnapshots.id, ct105.pointId));
    expect(lost).toMatchObject({ status: "unavailable", unavailableReason: "lost" });
    const [guest105] = await owner.select().from(pveGuests).where(eq(pveGuests.id, ct105.guestId));
    expect(guest105?.repositoryReadyAt).toBeNull();
    expect(guest105?.repositorySecretId).toBeNull();
    expect(guest105?.repositoryChains[0]).toMatchObject({
      reason: "lost",
      unavailablePoints: 1,
      actor: "admin@contoso.example",
    });
    const actions = (
      await owner.select({ action: auditLog.action, target: auditLog.target }).from(auditLog)
    ).map((row) => `${row.action}:${row.target}`);
    expect(actions).toEqual(
      expect.arrayContaining([
        `storage.repository.merged:${ct109.guestId}`,
        `storage.repository.merged:${ct100.guestId}`,
        `storage.repository.lost:${ct105.guestId}`,
      ]),
    );

    // A second scan: everything that could be rebuilt is complete now.
    const again = await result<StorageRepositoryScanEntry>(await queue("scan"));
    const byId = new Map(again.map((entry) => [entry.ownerId, entry.class]));
    expect(byId.get(ct109.guestId)).toBe("ok");
    expect(byId.get(ct100.guestId)).toBe("ok");
    expect(byId.get(ct117.guestId)).toBe("ok");
  }, 300_000);

  it("refuses a repair without a completed scan", async () => {
    const [row] = await owner
      .insert(storageRepositoryRepairs)
      .values({
        tenantId,
        kind: "apply",
        scanId: randomUUID(),
        requestedBy: "admin@contoso.example",
      })
      .returning();
    await repositoryRepairPass(deps);
    const [done] = await owner
      .select()
      .from(storageRepositoryRepairs)
      .where(eq(storageRepositoryRepairs.id, row?.id as string));
    expect(done?.status).toBe("failed");
    expect(done?.errorMessage).toContain("no completed scan");
  });

  async function guestRow(guestId: string) {
    const [row] = await owner.select().from(pveGuests).where(eq(pveGuests.id, guestId));
    return row;
  }

  async function pointRow(pointId: string) {
    const [row] = await owner.select().from(pveSnapshots).where(eq(pveSnapshots.id, pointId));
    return row;
  }

  const nfw = () => new LocalStorageBackend(nfwDir);

  /** The first pack of a repository folder (restic creates every shard folder, most empty). */
  async function firstPack(repo: string): Promise<{ shard: string; pack: string }> {
    for (const shard of (await readdir(join(repo, "data"))).sort()) {
      const [pack] = await readdir(join(repo, "data", shard));
      if (pack) {
        return { shard, pack };
      }
    }
    throw new Error(`no pack in ${repo}`);
  }

  it("never acts on a place it could not read, nor on what changed since the scan", async () => {
    // CT 120: complete on the installation default only. CT 121: on no target at all, while
    // its restore point still refers to it.
    const ct120 = await container(120, defaultDir);
    const ct121 = await container(121, nfwDir);
    await rm(ct121.repo, { recursive: true, force: true });
    const firstScanId = await queue("scan");
    const first = new Map(
      (await result<StorageRepositoryScanEntry>(firstScanId)).map((e) => [e.ownerId, e]),
    );
    expect(first.get(ct120.guestId)?.class).toBe("elsewhere");
    expect(first.get(ct121.guestId)?.class).toBe("missing");

    // The share of the installation default is not mounted: an empty folder.
    const away = `${defaultDir}.away`;
    await cp(defaultDir, away, { recursive: true });
    await rm(defaultDir, { recursive: true, force: true });
    await mkdir(defaultDir, { recursive: true });
    try {
      const refused = await run("apply", firstScanId);
      expect(refused.status).toBe("failed");
      expect(refused.errorMessage).toContain('"Installation default" could not be read');
      expect(refused.errorMessage).toContain("empty");
      // A scan now says so, and a repair of that scan is refused.
      const blind = await run("scan");
      expect(blind.status).toBe("completed");
      expect(blind.result?.unreachable).toEqual([
        expect.objectContaining({ id: "installation_default" }),
      ]);
      const onBlind = await run("apply", blind.id);
      expect(onBlind.status).toBe("failed");
      expect(onBlind.errorMessage).toContain("the scan could not read");
    } finally {
      await rm(defaultDir, { recursive: true, force: true });
      await cp(away, defaultDir, { recursive: true });
      await rm(away, { recursive: true, force: true });
    }
    // Nothing happened: no file on NFW-01, every restore point active.
    expect(await nfw().list(`pve-guests/${ct120.guestId}/`)).toEqual([]);
    expect((await pointRow(ct120.pointId))?.status).toBe("active");
    expect((await pointRow(ct121.pointId))?.status).toBe("active");

    // A scan, then the repository changes (one pack lands on NFW-01: split now, not elsewhere).
    const scanId = await queue("scan");
    const { shard, pack } = await firstPack(ct120.repo);
    await mkdir(join(nfwDir, "pve-guests", ct120.guestId, "data", shard), { recursive: true });
    await cp(
      join(ct120.repo, "data", shard, pack),
      join(nfwDir, "pve-guests", ct120.guestId, "data", shard, pack),
    );
    const applied = new Map(
      (await result<StorageRepositoryRepairEntry>(await queue("apply", scanId))).map((e) => [
        e.ownerId,
        e,
      ]),
    );
    expect(applied.get(ct120.guestId)).toMatchObject({ outcome: "unchanged" });
    expect(applied.get(ct120.guestId)?.detail).toContain("not what the confirmed scan found");
    expect(await nfw().head(`pve-guests/${ct120.guestId}/config`)).toBeNull();
    // On no target: left as it is, never marked lost by the repair.
    expect(applied.get(ct121.guestId)).toMatchObject({ outcome: "unchanged", lostPoints: 0 });
    expect((await pointRow(ct121.pointId))?.status).toBe("active");
    expect((await guestRow(ct121.guestId))?.repositorySecretId).not.toBeNull();
    // Out of the way of the tests below.
    await owner.delete(pveGuests).where(inArray(pveGuests.id, [ct120.guestId, ct121.guestId]));
  }, 300_000);

  it("copies config and keys last and takes them away again when the result is not sound", async () => {
    const ct122 = await container(122, defaultDir);
    const scanId = await queue("scan");
    const broken: RepairDeps = {
      ...deps,
      restic: {
        check: async () => {
          throw new Error("pack 1234 is missing");
        },
        snapshots: async () => [],
      },
    };
    const failed = new Map(
      (await result<StorageRepositoryRepairEntry>(await queue("apply", scanId, broken))).map(
        (e) => [e.ownerId, e],
      ),
    );
    expect(failed.get(ct122.guestId)).toMatchObject({ outcome: "failed" });
    expect(failed.get(ct122.guestId)?.movedTo).toContain(`pve-guests/${ct122.guestId}.orphaned-`);
    const prefix = `pve-guests/${ct122.guestId}/`;
    const onNfw = await nfw().list(prefix);
    // The data is there, but nothing that opens it.
    expect(onNfw.some((key) => key.startsWith(`${prefix}data/`))).toBe(true);
    expect(onNfw).not.toContain(`${prefix}config`);
    expect(onNfw.some((key) => key.startsWith(`${prefix}keys/`))).toBe(false);
    // Moved aside, not deleted.
    const aside = failed.get(ct122.guestId)?.movedTo as string;
    expect(await nfw().head(`${aside}config`)).not.toBeNull();
    // Backups, retention and the check refuse on the guest until a repair succeeds.
    expect((await guestRow(ct122.guestId))?.repositoryProblem).toMatchObject({
      type: "pve-repository-repair-failed",
      activePoints: 1,
    });
    expect((await pointRow(ct122.pointId))?.status).toBe("active");

    // Repaired for real: the mark goes, restic reads every pack.
    const again = await queue("scan");
    const merged = new Map(
      (await result<StorageRepositoryRepairEntry>(await queue("apply", again))).map((e) => [
        e.ownerId,
        e,
      ]),
    );
    expect(merged.get(ct122.guestId)).toMatchObject({ outcome: "merged", lostPoints: 0 });
    expect((await guestRow(ct122.guestId))?.repositoryProblem).toBeNull();
    await ok(
      ["-r", join(nfwDir, "pve-guests", ct122.guestId), "check", "--read-data"],
      ct122.password,
    );
  }, 300_000);

  it("stops at a file it cannot copy and verify, before config and keys", async () => {
    const ct123 = await container(123, defaultDir);
    // Damage one pack on the only place that holds it: its name no longer matches its content.
    const { shard, pack } = await firstPack(ct123.repo);
    await writeFile(join(ct123.repo, "data", shard, pack), randomBytes(64));
    const scanId = await queue("scan");
    const applied = new Map(
      (await result<StorageRepositoryRepairEntry>(await queue("apply", scanId))).map((e) => [
        e.ownerId,
        e,
      ]),
    );
    expect(applied.get(ct123.guestId)).toMatchObject({ outcome: "failed" });
    expect(applied.get(ct123.guestId)?.detail).toContain("could not be copied and verified");
    const prefix = `pve-guests/${ct123.guestId}/`;
    const onNfw = await nfw().list(prefix);
    expect(onNfw).not.toContain(`${prefix}config`);
    expect(onNfw.some((key) => key.startsWith(`${prefix}keys/`))).toBe(false);
    expect((await guestRow(ct123.guestId))?.repositoryProblem).toMatchObject({
      type: "pve-repository-repair-failed",
    });
    await owner.delete(pveGuests).where(eq(pveGuests.id, ct123.guestId));
  }, 300_000);

  it("refuses while a backup runs, and waits for a repository's lock", async () => {
    const ct124 = await container(124, defaultDir);
    const scanId = await queue("scan");
    const [backup] = await owner
      .insert(pveRuns)
      .values({ tenantId, clusterId, guestId: ct124.guestId, kind: "backup", status: "running" })
      .returning();
    const refused = await run("apply", scanId);
    expect(refused.status).toBe("failed");
    expect(refused.errorMessage).toContain("a Proxmox VE backup of this tenant is running");
    expect(await nfw().list(`pve-guests/${ct124.guestId}/`)).toEqual([]);
    await owner.delete(pveRuns).where(eq(pveRuns.id, backup?.id as string));

    // Retention or a file restore holds the repository: the repair does not go past it.
    const release = await acquireEndpointRepositoryLock(
      appDb.$client,
      pveGuestRepositoryLockKey(ct124.guestId),
      { mode: "exclusive" },
    );
    try {
      const busy = new Map(
        (
          await result<StorageRepositoryRepairEntry>(
            await queue("apply", await queue("scan"), { ...deps, repositoryLockWaitMs: 200 }),
          )
        ).map((e) => [e.ownerId, e]),
      );
      expect(busy.get(ct124.guestId)).toMatchObject({ outcome: "failed" });
      expect(busy.get(ct124.guestId)?.detail).toContain("busy");
      expect(await nfw().list(`pve-guests/${ct124.guestId}/`)).toEqual([]);
    } finally {
      await release();
    }
    await owner.delete(pveGuests).where(eq(pveGuests.id, ct124.guestId));
  }, 300_000);

  it("marks only points from before the repair lost, and says the chain goes on", async () => {
    const ct125 = await container(125, defaultDir);
    const missingPoint = async (createdAt: Date, sequence: number) => {
      const id = randomUUID();
      await owner.insert(pveSnapshots).values({
        id,
        manifestPath: manifestKey(tenantId, id),
        tenantId,
        clusterId,
        guestId: ct125.guestId,
        sequence,
        kind: "ct",
        archiveName: `ct/125/${createdAt.toISOString()}`,
        storageId: "restow",
        resticSnapshotId: "e".repeat(64),
        backupAt: createdAt,
        createdAt,
      });
      return id;
    };
    // Its snapshot is in no part of the repository.
    const before = await missingPoint(new Date(clock.getTime() - 3_600_000), 2);
    // Committed after the repair began (it lists restic's snapshots later): not judged.
    const after = await missingPoint(new Date(clock.getTime() + 3_600_000), 3);
    const scanId = await queue("scan");
    const applied = new Map(
      (await result<StorageRepositoryRepairEntry>(await queue("apply", scanId))).map((e) => [
        e.ownerId,
        e,
      ]),
    );
    expect(applied.get(ct125.guestId)).toMatchObject({ outcome: "merged", lostPoints: 1 });
    expect((await pointRow(before))?.status).toBe("unavailable");
    expect((await pointRow(after))?.status).toBe("active");
    expect((await pointRow(ct125.pointId))?.status).toBe("active");
    const guest = await guestRow(ct125.guestId);
    expect(guest?.repositoryChains[0]).toMatchObject({
      reason: "points_lost",
      unavailablePoints: 1,
    });
    // The chain goes on: the repository stays recorded.
    expect(guest?.repositoryReadyAt).not.toBeNull();
    expect(guest?.repositorySecretId).not.toBeNull();
  }, 300_000);
});
