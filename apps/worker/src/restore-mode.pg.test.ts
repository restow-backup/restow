/**
 * Restore mode after restoring a database dump (restore-mode.ts, docs/STORAGE.md "Restore mode
 * and progress markers"), against Postgres and real directories: a database copied at a moment
 * D (`CREATE DATABASE ... TEMPLATE`, what a dump taken then restores) is put back while the
 * storage holds backups written after D. Every deletion pass then deletes nothing, the worker
 * switches restore mode on by itself and raises the alert, the key mirror never overwrites the
 * newer key, and new backups still write. The cases that must not trigger (a healthy
 * installation, another installation's markers, a copy filled by the mirror, a target that
 * cannot be read) are covered too. Runs when RESTOW_TEST_DATABASE_URL is set.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  chunksHeldByPartialManifests,
  type DeletionGuard,
  DeletionsHeldError,
  EnvKeyProvider,
  generateDek,
  installDeletionEnforcement,
  LocalStorageBackend,
  mirrorTenantStorage,
  noopLogger,
  type PackCatalog,
  partialManifestKey,
  progressPrefix,
  resetProgressMarkerThrottle,
  type ScrubEnvironment,
  type StorageTargets,
  sweepOrphanPacks,
  wrapDek,
} from "@restow/core";
import {
  createDb,
  type Database,
  endRestoreMode,
  packs,
  providers,
  rebaseStorageProgress,
  snapshots,
  tenantKeys,
  tenants,
} from "@restow/db";
import { runMigrations } from "@restow/db/migrate";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  discardAbandonedSnapshots,
  mirrorTenantKeys,
  type ResolvedTenantStorage,
  tenantRunner,
} from "./handlers/framework.js";
import { mailFilesCleanupTask } from "./handlers/mail-files-cleanup.js";
import { PgPackCatalog } from "./handlers/scrub.js";
import {
  configureRestoreModeRuntime,
  createWorkerRestoreModeGuard,
  pruneTenantProgressMarkers,
  RestoreModeJobHold,
  reportKeyMirrorFinding,
  withTenantProgressMarkers,
} from "./restore-mode.js";
import { dropTestDatabase, ignoreTerminatedConnection } from "./testing/database.js";

const adminUrl = process.env.RESTOW_TEST_DATABASE_URL;
const LIVE_DB = "restow_worker_restore_mode_test";
const DUMP_DB = "restow_worker_restore_mode_dump";
const kek = Buffer.alloc(32, 0x3c);
const DAY = 86_400_000;

function urlOf(name: string): string {
  const url = new URL(adminUrl as string);
  url.pathname = `/${name}`;
  return url.toString();
}

async function admin<T>(fn: (db: Database) => Promise<T>): Promise<T> {
  const db = createDb(adminUrl as string);
  try {
    return await fn(db);
  } finally {
    await db.$client.end();
  }
}

/** Copy `from` to `to` as it stands now: what a dump taken at this moment restores. */
async function cloneDatabase(from: string, to: string): Promise<void> {
  await admin(async (db) => {
    for (let attempt = 0; attempt < 200; attempt++) {
      const { rows } = await db.$client.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1",
        [from],
      );
      if ((rows[0]?.n ?? 0) === 0) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await db.$client.query(`DROP DATABASE IF EXISTS ${to} WITH (FORCE)`);
    await db.$client.query(`CREATE DATABASE ${to} TEMPLATE ${from}`);
  });
}

async function filesUnder(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else {
        out.push(path);
      }
    }
  };
  await walk(root);
  return out.sort();
}

/** Every file under `root` with its SHA-256, progress markers left out. */
async function treeHash(root: string): Promise<Record<string, string>> {
  const tree: Record<string, string> = {};
  for (const path of await filesUnder(root)) {
    const key = relative(root, path);
    if (key.includes("/progress/")) {
      continue;
    }
    tree[key] = createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
  }
  return tree;
}

/** Make every file under `root` look `ageMs` old (the orphan sweep's grace is 24 hours). */
async function age(root: string, ageMs: number): Promise<void> {
  const when = new Date(Date.now() - ageMs);
  for (const path of await filesUnder(root)) {
    await utimes(path, when, when);
  }
}

function resolvedStorage(root: string): ResolvedTenantStorage {
  const primary = new LocalStorageBackend(join(root, "primary"));
  const copy = new LocalStorageBackend(join(root, "copy"));
  return {
    primary,
    copies: [copy],
    previous: [],
    keepGeneration: null,
    defaultGeneration: null,
    storageGeneration: null,
    primaryTarget: "target-primary",
    targets: [
      {
        id: "target-primary",
        name: "primary",
        role: "primary",
        backend: primary,
        writeOnce: false,
      },
      { id: "target-copy", name: "copy", role: "copy", backend: copy, writeOnce: false },
    ],
  } as unknown as ResolvedTenantStorage;
}

function scrubEnv(db: Database, tenantId: string, storage: StorageTargets): ScrubEnvironment {
  return {
    tenantId,
    storage,
    keys: { open: () => Buffer.alloc(0) } as unknown as ScrubEnvironment["keys"],
    catalog: new PgPackCatalog(tenantRunner(db, tenantId), tenantId) as unknown as PackCatalog,
    logger: noopLogger,
    signal: new AbortController().signal,
    now: () => new Date(),
  };
}

async function newTenant(db: Database): Promise<string> {
  const [provider] = await db.insert(providers).values({ name: "p" }).returning();
  const [tenant] = await db
    .insert(tenants)
    .values({
      providerId: provider?.id as string,
      name: "Contoso",
      slug: `c-${randomUUID().slice(0, 8)}`,
    })
    .returning();
  const tenantId = tenant?.id as string;
  await db.insert(tenantKeys).values({
    tenantId,
    keyVersion: 1,
    encryptedDek: wrapDek(kek, generateDek(1)).toString("base64"),
    kekId: "env:test",
  });
  return tenantId;
}

async function putPack(
  db: Database | null,
  storage: StorageTargets,
  tenantId: string,
  name: string,
): Promise<string> {
  const path = `tenants/${tenantId}/packs/${name.slice(0, 2)}/${name}`;
  const bytes = Buffer.from(`pack ${name}`);
  for (const target of [storage.primary, ...storage.copies]) {
    await target.put(path, bytes);
  }
  if (db) {
    await db.insert(packs).values({
      tenantId,
      path,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.length,
    });
  }
  return path;
}

const q = async <R extends Record<string, unknown>>(
  db: Database,
  text: string,
  values: unknown[] = [],
) => (await db.$client.query<R>(text, values)).rows;

describe.skipIf(!adminUrl)("restore mode after restoring a database dump", () => {
  let root: string;
  let live: Database;
  let dump: Database | null = null;
  let uninstall: (() => void) | null = null;

  beforeAll(async () => {
    await admin(async (db) => {
      await db.$client.query(`DROP DATABASE IF EXISTS ${LIVE_DB} WITH (FORCE)`);
      await db.$client.query(`CREATE DATABASE ${LIVE_DB}`);
    });
    await runMigrations(urlOf(LIVE_DB));
    live = createDb(urlOf(LIVE_DB));
    live.$client.on("error", ignoreTerminatedConnection);
    await live.$client.query("INSERT INTO settings DEFAULT VALUES");
  }, 120_000);

  afterEach(async () => {
    uninstall?.();
    uninstall = null;
    configureRestoreModeRuntime({ providerDb: null });
    resetProgressMarkerThrottle();
    if (root) {
      await rm(root, { recursive: true, force: true });
    }
  });

  afterAll(async () => {
    await live?.$client.end();
    await dump?.$client.end();
    await dropTestDatabase(adminUrl as string, DUMP_DB);
    await dropTestDatabase(adminUrl as string, LIVE_DB);
  });

  function guardOver(db: Database, storage: StorageTargets, strict = true) {
    const made = createWorkerRestoreModeGuard({
      providerDb: db,
      storageOf: async () => storage,
      logger: noopLogger,
    });
    uninstall?.();
    uninstall = installDeletionEnforcement(made.guard as DeletionGuard, { strict });
    return made;
  }

  function withMarkers(db: Database, storage: ResolvedTenantStorage, tenantId: string) {
    const installation = async () =>
      (await q<{ id: string }>(db, "SELECT id::text AS id FROM settings LIMIT 1"))[0]?.id ?? null;
    return withTenantProgressMarkers(storage, {
      tenantId,
      providerDb: db,
      installationId: installation,
      intervalMs: 0,
    });
  }

  it("deletes nothing, switches restore mode on and raises the alert; new backups still write", async () => {
    root = await mkdtemp(join(tmpdir(), "restow-restore-mode-"));
    const raw = resolvedStorage(root);
    const tenantId = await newTenant(live);
    let storage = withMarkers(live, raw, tenantId);
    guardOver(live, storage);

    // --- State at D: one backup, an in-progress snapshot of a job that is gone ---------------
    await putPack(live, storage, tenantId, "aa-before-the-dump");
    const inProgressId = randomUUID();
    const [object] = await q<{ id: string }>(
      live,
      `WITH s AS (INSERT INTO sources (tenant_id, kind, name, config) VALUES ($1, 'm365', 'M365', '{}') RETURNING id)
       INSERT INTO protected_objects (tenant_id, source_id, kind, external_id, display_name)
       SELECT $1, id, 'mailbox', 'alice@example.test', 'Alice' FROM s RETURNING id`,
      [tenantId],
    );
    await live.insert(snapshots).values({
      id: inProgressId,
      tenantId,
      protectedObjectId: object?.id as string,
      jobId: null,
      sequence: 1,
      startedAt: new Date(),
    });
    await live.$client.end();
    await cloneDatabase(LIVE_DB, DUMP_DB);
    live = createDb(urlOf(LIVE_DB));
    live.$client.on("error", ignoreTerminatedConnection);
    storage = withMarkers(live, raw, tenantId);
    guardOver(live, storage);

    // --- After D: more backups, a committed snapshot, a staged upload, a newer key ------------
    await putPack(live, storage, tenantId, "bb-after-the-dump");
    await putPack(live, storage, tenantId, "cc-after-the-dump");
    const manifest = `tenants/${tenantId}/manifests/${inProgressId}.json.zst`;
    await storage.primary.put(manifest, Buffer.from("committed after the dump"));
    await storage.copies[0]?.put(manifest, Buffer.from("committed after the dump"));
    const partial = partialManifestKey(tenantId, randomUUID());
    await storage.primary.put(partial, Buffer.from("checkpoint after the dump"));
    await storage.primary.put(
      `tenants/${tenantId}/staging/${randomUUID()}/0`,
      Buffer.from("upload after the dump"),
    );
    const newerKey = await new EnvKeyProvider(kek).wrapDek(generateDek(2));
    await storage.primary.put(`tenants/${tenantId}/keys/2`, newerKey);
    await storage.copies[0]?.put(`tenants/${tenantId}/keys/2`, newerKey);
    uninstall?.();
    uninstall = null;

    // --- The dump is restored: the worker runs against the copy taken at D -------------------
    dump = createDb(urlOf(DUMP_DB));
    dump.$client.on("error", ignoreTerminatedConnection);
    resetProgressMarkerThrottle();
    storage = withMarkers(dump, raw, tenantId);
    configureRestoreModeRuntime({ providerDb: dump });
    const { guard } = guardOver(dump, storage);
    await age(root, 3 * DAY);
    const before = await treeHash(root);

    // The orphan sweep: every pack written after D has no row in the restored database.
    expect(await sweepOrphanPacks(scrubEnv(dump, tenantId, storage), DAY)).toMatchObject({
      removed: 0,
      held: true,
    });
    // Abandoned checkpoints are read, never deleted.
    const held = await chunksHeldByPartialManifests(
      storage,
      tenantId,
      { open: () => Buffer.alloc(0) } as never,
      { abandoned: async () => true },
    );
    expect(held.discarded).toEqual([]);
    // The snapshot in progress at D was committed after it: its manifest stays.
    expect(
      await discardAbandonedSnapshots(
        tenantRunner(dump, tenantId),
        { tenantId, storage, logger: noopLogger },
        { tenant: true },
      ),
    ).toBe(0);
    // Staging and export areas without a row.
    const cleanup = await mailFilesCleanupTask.run(
      {
        tenantId,
        storage,
        keys: {},
        db: dump,
        now: () => new Date(),
        logger: noopLogger,
      } as never,
      { dryRun: false } as never,
    );
    expect(cleanup).toMatchObject({ restoreMode: true, strayScopesRemoved: 0 });
    // Pruning progress markers is a deletion pass of its own.
    await expect(pruneTenantProgressMarkers({ tenantId, storage })).rejects.toBeInstanceOf(
      DeletionsHeldError,
    );
    // A delete outside every pass is held as well (the backend's own check).
    await expect(storage.primary.delete(manifest)).rejects.toBeInstanceOf(DeletionsHeldError);

    // The key mirror: the restored database hands out version 2 again with another key.
    await dump.insert(tenantKeys).values({
      tenantId,
      keyVersion: 2,
      encryptedDek: (await new EnvKeyProvider(kek).wrapDek(generateDek(2))).toString("base64"),
      kekId: "env:test",
    });
    const findings = await mirrorTenantKeys({
      run: tenantRunner(dump, tenantId),
      tenantId,
      storage,
      logger: noopLogger,
      unwraps: async (bytes) => {
        await new EnvKeyProvider(kek).unwrapDek(bytes);
        return true;
      },
      report: (finding) => reportKeyMirrorFinding(dump as Database, finding, noopLogger),
    });
    expect(findings.map((finding) => [finding.targetId, finding.kind])).toEqual([
      ["target-primary", "conflict"],
      ["target-copy", "conflict"],
    ]);
    // Reported once per stored content, however often the mirror runs.
    await mirrorTenantKeys({
      run: tenantRunner(dump, tenantId),
      tenantId,
      storage,
      logger: noopLogger,
      report: (finding) => reportKeyMirrorFinding(dump as Database, finding, noopLogger),
    });

    // Nothing in storage was deleted or changed (the mirror only added the database's key 1).
    const unchanged = await treeHash(root);
    expect(unchanged).toMatchObject(before);
    expect(Object.keys(unchanged).filter((key) => !(key in before))).toEqual([
      `copy/tenants/${tenantId}/keys/1`,
      `primary/tenants/${tenantId}/keys/1`,
    ]);
    expect(
      (await readFile(join(root, "primary", `tenants/${tenantId}/keys/2`))).equals(newerKey),
    ).toBe(true);

    // Restore mode came on by itself, once, with its audit entry and its alert.
    const modes = await q<{ source: string; detection: { tenantId: string } }>(
      dump,
      "SELECT source, detection FROM installation_restore_mode WHERE ended_at IS NULL",
    );
    expect(modes).toHaveLength(1);
    expect(modes[0]).toMatchObject({ source: "detected", detection: { tenantId } });
    expect(
      await q(dump, "SELECT id FROM audit_log WHERE action = 'installation.restore_mode.detected'"),
    ).toHaveLength(1);
    expect(
      (
        await q<{ event: string }>(
          dump,
          "SELECT event FROM notifications WHERE tenant_id IS NULL ORDER BY created_at",
        )
      ).map((row) => row.event),
    ).toEqual([
      "installation.restore_mode",
      "installation.key_mirror_conflict",
      "installation.key_mirror_conflict",
    ]);
    expect(await q(dump, "SELECT id FROM key_mirror_findings")).toHaveLength(2);
    const refusals = await q<{ pass: string }>(
      dump,
      "SELECT DISTINCT pass FROM restore_mode_refusals ORDER BY pass",
    );
    expect(refusals.map((row) => row.pass)).toEqual(
      expect.arrayContaining(["orphan_sweep", "abandoned_checkpoint", "mail_files_cleanup"]),
    );

    // A new backup still writes, under a marker above everything storage already had.
    const markersBefore = await storage.primary.list(progressPrefix(tenantId));
    await putPack(dump, storage, tenantId, "dd-in-restore-mode");
    const markersAfter = await storage.primary.list(progressPrefix(tenantId));
    expect(markersAfter.length).toBe(markersBefore.length + 1);
    const newest = markersAfter.at(-1) as string;
    expect(markersBefore.every((key) => key < newest)).toBe(true);
    expect(guard.holding()).toBe(true);

    // --- A provider owner ends it, keeping storage-only data -------------------------------
    const [active] = await q<{ id: string }>(
      dump,
      "SELECT id::text AS id FROM installation_restore_mode WHERE ended_at IS NULL",
    );
    const markerMax = Math.max(
      ...markersAfter.map((key) => Number(/(\d+)\.json$/.exec(key)?.[1] ?? 0)),
    );
    await rebaseStorageProgress(dump.$client, tenantId, markerMax + 1_000_000);
    expect(
      await endRestoreMode(dump.$client, {
        id: active?.id as string,
        actor: { label: "owner@example.test" },
        checked: "Compared the restore points with the customer's records.",
        storageOnlyData: "keep",
        rebase: {},
      }),
    ).toBe(true);
    await dump.$client.query(
      "UPDATE installation_restore_mode SET keep_unknown_before = now() - interval '2 days'",
    );
    const { guard: after } = guardOver(dump, storage);
    expect(after.holding()).toBe(false);
    // A pack that became an orphan after the keep point is swept again; the older ones stay.
    const newOrphan = await putPack(null, storage, tenantId, "ee-new-orphan");
    const keepFloor = Date.now() - 2 * DAY;
    for (const target of ["primary", "copy"]) {
      const old = new Date(keepFloor - DAY);
      for (const path of await filesUnder(join(root, target))) {
        if (!path.includes("ee-new-orphan")) {
          await utimes(path, old, old);
        }
      }
      const recent = new Date(keepFloor + DAY / 2);
      await utimes(join(root, target, newOrphan), recent, recent);
    }
    const sweep = await sweepOrphanPacks(scrubEnv(dump, tenantId, storage), DAY);
    expect(sweep.removed).toBe(2);
    expect(
      (
        await stat(join(root, "primary", `tenants/${tenantId}/packs/bb/bb-after-the-dump`))
      ).isFile(),
    ).toBe(true);
    await expect(stat(join(root, "primary", newOrphan))).rejects.toThrow();
  });

  it("does not trigger on a healthy installation: the passes delete as before", async () => {
    root = await mkdtemp(join(tmpdir(), "restow-restore-mode-"));
    const raw = resolvedStorage(root);
    const tenantId = await newTenant(live);
    const storage = withMarkers(live, raw, tenantId);
    guardOver(live, storage);
    await putPack(live, storage, tenantId, "aa-known");
    const orphan = await putPack(null, storage, tenantId, "bb-orphan");
    await age(root, 3 * DAY);
    const sweep = await sweepOrphanPacks(scrubEnv(live, tenantId, storage), DAY);
    expect(sweep).toMatchObject({ removed: 2 });
    await expect(stat(join(root, "primary", orphan))).rejects.toThrow();
    expect(await pruneTenantProgressMarkersWith(live, tenantId, storage)).toBe(0);
    expect(
      await q(live, "SELECT id FROM installation_restore_mode WHERE ended_at IS NULL"),
    ).toHaveLength(0);
  });

  it("does not trigger on a copy filled by the mirror, and only warns about another installation", async () => {
    root = await mkdtemp(join(tmpdir(), "restow-restore-mode-"));
    const raw = resolvedStorage(root);
    const tenantId = await newTenant(live);
    const storage = withMarkers(live, raw, tenantId);
    const { guard } = guardOver(live, storage);
    await putPack(live, storage, tenantId, "aa-one");
    // A new copy target, filled from the primary: markers are never copied.
    const added = new LocalStorageBackend(join(root, "added-copy"));
    const packRows = await q<{ path: string; size: number; sha256: string }>(
      live,
      "SELECT path, size::int AS size, sha256 FROM packs WHERE tenant_id = $1",
      [tenantId],
    );
    await mirrorTenantStorage({
      tenantId,
      storage: { primary: raw.primary, copies: [added] },
      packs: packRows,
      logger: noopLogger,
    });
    expect(await added.list(`tenants/${tenantId}/packs/`)).toHaveLength(1);
    expect(await added.list(`tenants/${tenantId}/keys/`)).toHaveLength(0);
    expect(await added.list(progressPrefix(tenantId))).toEqual([]);
    const check = await guard.checkTargets(tenantId, [
      { id: "target-primary", backend: raw.primary },
      { id: "added-copy", backend: added },
    ]);
    expect(check.outcome).toBe("ok");
    // Another installation's marker above the database: a warning, deleting goes on.
    await raw.primary.put(
      `tenants/${tenantId}/progress/000000009999/00000000000009999999.json`,
      Buffer.from(JSON.stringify({ format: 1, installationId: "another-installation" })),
    );
    const foreign = await guard.checkTenant(tenantId, { force: true });
    expect(foreign.outcome).toBe("foreign");
    expect((await guard.decide({ pass: "orphan_sweep", tenantId })).allowed).toBe(true);
    expect(
      await q(live, "SELECT id FROM installation_restore_mode WHERE ended_at IS NULL"),
    ).toHaveLength(0);
  });

  it("refuses deleting while a target cannot be read, without switching restore mode on", async () => {
    root = await mkdtemp(join(tmpdir(), "restow-restore-mode-"));
    const raw = resolvedStorage(root);
    const tenantId = await newTenant(live);
    const broken = Object.assign(Object.create(raw.copies[0] as object), {
      list: async () => {
        throw new Error("the share is not mounted");
      },
    });
    const storage = {
      ...raw,
      copies: [broken],
      targets: [raw.targets?.[0], { ...raw.targets?.[1], backend: broken }],
    };
    const { guard } = guardOver(live, storage as never);
    expect(await guard.decide({ pass: "snapshot_retention", tenantId })).toMatchObject({
      allowed: false,
      reason: "progress_unknown",
    });
    expect(
      await q(live, "SELECT id FROM installation_restore_mode WHERE ended_at IS NULL"),
    ).toHaveLength(0);
  });

  it("holds only the dump's jobs when the detection comes after new backups were queued", async () => {
    root = await mkdtemp(join(tmpdir(), "restow-restore-mode-"));
    const raw = resolvedStorage(root);
    const tenantId = await newTenant(live);
    let storage = withMarkers(live, raw, tenantId);
    guardOver(live, storage);
    await putPack(live, storage, tenantId, "aa-before-the-dump");
    // A worker of the old timeline beat until shortly before the dump; a job of the dump.
    await live.$client.query(
      `INSERT INTO service_heartbeats (role, instance_id, version, started_at, beat_at)
       VALUES ('worker', $1, 'test', now() - interval '1 day', now() - interval '10 minutes')`,
      [randomUUID()],
    );
    const dumpJobCreatedOn = new Date(Date.now() - 15 * 60_000);
    await live.$client.end();
    await cloneDatabase(LIVE_DB, DUMP_DB);
    live = createDb(urlOf(LIVE_DB));
    live.$client.on("error", ignoreTerminatedConnection);
    storage = withMarkers(live, raw, tenantId);
    guardOver(live, storage);
    await putPack(live, storage, tenantId, "bb-after-the-dump");
    uninstall?.();
    uninstall = null;

    // The dump is restored and the stack started without the command line step: the scheduler
    // started first and queued an overdue backup before the worker compared the storage.
    await dump?.$client.end();
    dump = createDb(urlOf(DUMP_DB));
    dump.$client.on("error", ignoreTerminatedConnection);
    await dump.$client.query(
      `INSERT INTO service_heartbeats (role, instance_id, version, started_at, beat_at)
       VALUES ('scheduler', $1, 'test', now() - interval '30 seconds', now())`,
      [randomUUID()],
    );
    const newBackupCreatedOn = new Date(Date.now() - 20_000);
    resetProgressMarkerThrottle();
    storage = withMarkers(dump, raw, tenantId);
    const { guard } = createWorkerRestoreModeGuard({
      providerDb: dump,
      storageOf: async () => storage,
      logger: noopLogger,
      processStartedAt: new Date(Date.now() - 10_000),
    });
    const check = await guard.checkTenant(tenantId, { force: true });
    expect(check.activated?.created).toBe(true);
    const hold = new RestoreModeJobHold(dump, () => guard.restoreMode(true), noopLogger);
    // The dump's job is held; the backup queued after the restore runs.
    expect(await hold.holds(dumpJobCreatedOn)).not.toBeNull();
    expect(await hold.holds(newBackupCreatedOn)).toBeNull();
    expect(
      await hold.holdIfBeforeRestore("backup", { id: randomUUID(), createdOn: newBackupCreatedOn }),
    ).toBe(false);
    const [row] = await q<{ hold_jobs_before: Date; activated_at: Date }>(
      dump,
      "SELECT hold_jobs_before, activated_at FROM installation_restore_mode WHERE ended_at IS NULL",
    );
    const boundary = new Date(row?.hold_jobs_before as Date).getTime();
    // The scheduler's start, not the detection; after the old timeline's last beat.
    expect(boundary).toBeLessThanOrEqual(newBackupCreatedOn.getTime());
    expect(boundary).toBeLessThan(new Date(row?.activated_at as Date).getTime());
    expect(boundary).toBeGreaterThan(Date.now() - 10 * 60_000);
    await dump.$client.query("DELETE FROM installation_restore_mode");
  });
});

async function pruneTenantProgressMarkersWith(
  db: Database,
  tenantId: string,
  storage: StorageTargets,
): Promise<number> {
  configureRestoreModeRuntime({ providerDb: db });
  return pruneTenantProgressMarkers({ tenantId, storage });
}
