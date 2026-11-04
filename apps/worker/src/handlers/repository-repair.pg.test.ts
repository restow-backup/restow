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
  auditLog,
  createDb,
  type Database,
  deriveAuthLogin,
  pveClusters,
  pveGuests,
  pveSnapshots,
  type RoleLogin,
  type StorageRepositoryRepairEntry,
  type StorageRepositoryScanEntry,
  secrets,
  storageRepositoryRepairs,
  storageTargets,
} from "@restow/db";
import { runMigrations } from "@restow/db/migrate";
import { and, eq } from "drizzle-orm";
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

  async function queue(kind: "scan" | "apply", scanId: string | null = null): Promise<string> {
    const [row] = await owner
      .insert(storageRepositoryRepairs)
      .values({ tenantId, kind, scanId, requestedBy: "admin@contoso.example" })
      .returning();
    expect(await repositoryRepairPass(deps)).toBe(1);
    const [done] = await owner
      .select()
      .from(storageRepositoryRepairs)
      .where(eq(storageRepositoryRepairs.id, row?.id as string));
    expect(done?.status, done?.errorMessage ?? "").toBe("completed");
    return row?.id as string;
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
});
