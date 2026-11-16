/**
 * Repository copies (docs/STORAGE.md, "restic repositories on copies") against Postgres and the
 * real restic binary, with two local storage targets (a primary and a copy):
 *
 *   - a machine's, a file share's and a container's repository are created on the copy target at
 *     the same prefix with the same password and filled with `restic copy`; a later pass copies
 *     only what is new; a snapshot no record names is never copied;
 *   - retention on the copy follows the server's (a machine's grouped retention, the pruned
 *     restore points of a file share and a container), never touches the primary, stops in
 *     restore mode and on a write-once copy target while copying goes on;
 *   - the copy opens with the same password once the primary's repository is gone, and names a
 *     restore point by the primary's id (`snapshotIdIn`);
 *   - the status rows: pending for a copy target added later, failed and retried after an hour,
 *     the daily catch-up, the alert after two days (once, a warning), tenant isolation.
 *
 * Needs RESTOW_TEST_DATABASE_URL (a superuser; the database is recreated) and restic
 * (RESTIC_BINARY, else the PATH).
 */
import { spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type DeletionDecision,
  type DeletionGuard,
  defaultEndpointConfig,
  EnvKeyProvider,
  endpointPrefix,
  fileShareRepositoryPrefix,
  generateDek,
  hashSecret,
  installDeletionEnforcement,
  LocalStorageBackend,
  noopLogger,
  REPOSITORY_COPY_MARKER_FILE,
  type ResolvedStorageTarget,
  type ResticSnapshot,
  resticBinary,
  resticCheckStructure,
  resticInit,
  resticSnapshots,
  runRestic,
  type StorageBackend,
  type StorageTargets,
  sealSecret,
  snapshotIdIn,
  type TenantKeyring,
  withRepository,
} from "@restow/core";
import {
  createDb,
  type Database,
  deriveAuthLogin,
  endpointReports,
  endpointRuns,
  endpointSamples,
  endpoints,
  fileShareSnapshots,
  fileShares,
  notifications,
  pveClusters,
  pveGuests,
  pveSnapshots,
  type RepositoryCopy,
  type RoleLogin,
  repositoryCopies,
} from "@restow/db";
import { runMigrations } from "@restow/db/migrate";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { endpointCheck } from "../endpoints/check.js";
import { endpointVerify, RestoreTestIncompleteError } from "../endpoints/verify.js";
import type { FileShareDeps } from "../file-shares/common.js";
import { purgeShare } from "../file-shares/purge.js";
import { loadTenantKeyring, TenantCache, withTenantTx } from "../handlers/framework.js";
import { dropTestDatabase } from "../testing/database.js";
import {
  COPY_ALERT_AFTER_MS,
  COPY_CATCH_UP_MS,
  COPY_RETRY_MS,
  copyDue,
  FOREIGN_REPOSITORY_MESSAGE,
  type RepositoryCopyDeps,
  repositoryCopyPass,
} from "./copies.js";

const adminUrl = process.env.RESTOW_TEST_DATABASE_URL;
const TEST_DB = "restow_worker_repository_copies_test";

function resticAvailable(): boolean {
  const result = spawnSync(resticBinary(), ["version"], { encoding: "utf8" });
  return result.status === 0 && /^restic 0\.\d+/.test(result.stdout);
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
/** restic runs several times per pass: far above the 5 s default. */
const SLOW = 120_000;

describe("copyDue", () => {
  const now = new Date("2026-11-07T12:00:00Z");
  const ago = (ms: number) => new Date(now.getTime() - ms);

  it("is due without a row, and for a row never attempted", () => {
    expect(copyDue(undefined, null, now)).toBe(true);
    expect(copyDue({ lastAttemptAt: null, state: "pending" }, null, now)).toBe(true);
  });

  it("is due after a backup newer than the last attempt, however many there were", () => {
    const row = { lastAttemptAt: ago(HOUR), state: "current" as const };
    expect(copyDue(row, ago(10 * 60_000), now)).toBe(true);
    expect(copyDue(row, ago(2 * HOUR), now)).toBe(false);
    expect(copyDue(row, null, now)).toBe(false);
  });

  it("catches up once a day without any backup", () => {
    expect(copyDue({ lastAttemptAt: ago(COPY_CATCH_UP_MS), state: "current" }, null, now)).toBe(
      true,
    );
    expect(copyDue({ lastAttemptAt: ago(COPY_CATCH_UP_MS - 1), state: "behind" }, null, now)).toBe(
      false,
    );
  });

  it("tries a failed copy again after an hour, not on every pass", () => {
    const fresh = ago(5 * 60_000);
    expect(copyDue({ lastAttemptAt: ago(10 * 60_000), state: "failed" }, fresh, now)).toBe(false);
    expect(copyDue({ lastAttemptAt: ago(COPY_RETRY_MS), state: "failed" }, null, now)).toBe(true);
  });
});

describe.skipIf(!adminUrl || !resticAvailable())(
  "repository copies against Postgres and restic",
  () => {
    let owner: Database;
    let appDb: Database;
    let providerDb: Database;
    let deps: RepositoryCopyDeps;
    let work: string;
    let primaryDir: string;
    let copyDir: string;
    let contoso: string;
    let fabrikam: string;
    let clock = new Date();
    const roleNames: string[] = [];
    /** What the tenant's storage resolves to; the tests change it. */
    const layout: {
      copies: ResolvedStorageTarget[];
      primaryBackend: StorageBackend | null;
    } = { copies: [], primaryBackend: null };
    let uninstallGuard: (() => void) | null = null;

    const copyTarget = (over: Partial<ResolvedStorageTarget> = {}): ResolvedStorageTarget => ({
      id: "11111111-1111-4111-8111-111111111111",
      name: "Offsite",
      role: "copy",
      backend: new LocalStorageBackend(copyDir),
      ...over,
    });

    beforeAll(async () => {
      const admin = createDb(adminUrl as string);
      await admin.$client.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
      await admin.$client.query(`CREATE DATABASE ${TEST_DB}`);
      await admin.$client.end();
      const url = new URL(adminUrl as string);
      url.pathname = `/${TEST_DB}`;
      const suffix = randomBytes(4).toString("hex");
      const tenantLogin: RoleLogin = {
        name: `restow_rc_app_${suffix}`,
        password: randomBytes(12).toString("hex"),
      };
      const installationLogin: RoleLogin = {
        name: `restow_rc_inst_${suffix}`,
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
      work = await mkdtemp(join(tmpdir(), "restow-repository-copies-"));
      primaryDir = join(work, "primary");
      copyDir = join(work, "copy");

      const q = <T extends Record<string, unknown>>(text: string, values: unknown[] = []) =>
        owner.$client.query<T>(text, values).then((result) => result.rows);
      const [provider] = await q<{ id: string }>(
        "INSERT INTO providers (name) VALUES ('p') RETURNING id",
      );
      const created = await q<{ id: string }>(
        "INSERT INTO tenants (provider_id, name, slug) VALUES ($1, 'Contoso', 'contoso'), ($1, 'Fabrikam', 'fabrikam') RETURNING id",
        [provider?.id],
      );
      contoso = created[0]?.id ?? "";
      fabrikam = created[1]?.id ?? "";
      const kek = randomBytes(32);
      const provideKeys = new EnvKeyProvider(kek);
      const dek = generateDek(1);
      for (const tenantId of [contoso, fabrikam]) {
        await q(
          "INSERT INTO tenant_keys (tenant_id, key_version, encrypted_dek, kek_id) VALUES ($1, 1, $2, 'env:RESTOW_MASTER_KEY')",
          [tenantId, (await provideKeys.wrapDek(dek)).toString("base64")],
        );
      }
      (globalThis as { __copyDek?: typeof dek }).__copyDek = dek;
      const keyrings = new TenantCache<TenantKeyring>((tenantId) =>
        loadTenantKeyring({ db: appDb, tenantId, keyProvider: provideKeys }),
      );
      // Never cached (a TTL of 0): every pass sees the layout the test set.
      const storage = new TenantCache<StorageTargets>(async () => {
        const primary = layout.primaryBackend ?? new LocalStorageBackend(primaryDir);
        return {
          primary,
          copies: layout.copies.map((copy) => copy.backend),
          previous: [],
          targets: [
            { id: "installation_default", name: null, role: "primary", backend: primary },
            ...layout.copies,
          ],
          primaryTarget: "installation_default",
        } as StorageTargets;
      }, 0);
      deps = {
        db: appDb,
        providerDb,
        runtime: {
          keyrings,
          storage,
          logger: noopLogger,
          now: () => clock,
          shutdownSignal: new AbortController().signal,
        },
        lockWaitMs: 5_000,
      };
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

    beforeEach(async () => {
      // Every test starts without repositories: a pass handles only what the test made.
      await owner.delete(repositoryCopies);
      await owner.delete(endpoints);
      await owner.delete(fileShares);
      await owner.delete(pveClusters);
      await owner.delete(notifications);
      clock = new Date();
      layout.copies = [copyTarget()];
      layout.primaryBackend = null;
    });

    afterEach(() => {
      uninstallGuard?.();
      uninstallGuard = null;
    });

    const dekOf = () =>
      (globalThis as { __copyDek?: ReturnType<typeof generateDek> }).__copyDek as ReturnType<
        typeof generateDek
      >;

    async function storeSecret(tenantId: string, kind: string, password: string): Promise<string> {
      const secretId = randomUUID();
      await owner.$client.query(
        "INSERT INTO secrets (id, tenant_id, kind, ciphertext, key_version) VALUES ($1, $2, $3, $4, 1)",
        [secretId, tenantId, kind, sealSecret(dekOf(), secretId, password)],
      );
      return secretId;
    }

    interface Repo {
      id: string;
      tenantId: string;
      prefix: string;
      password: string;
      source: string;
    }

    const accessOf = (repo: Pick<Repo, "id" | "prefix" | "password">, dir: string) => ({
      storage: new LocalStorageBackend(dir),
      prefix: repo.prefix,
      repositoryPassword: repo.password,
      repositoryKey: dir === primaryDir ? repo.id : `${repo.id}.copy`,
      cacheBase: join(work, "cache"),
    });

    const snapshotsOn = (repo: Repo, dir: string): Promise<ResticSnapshot[]> =>
      withRepository(accessOf(repo, dir), (session) => resticSnapshots(session, { noLock: true }));

    /** A repository on the primary with a small source folder. */
    async function makeRepository(tenantId: string, id: string, prefix: string): Promise<Repo> {
      const password = randomBytes(24).toString("base64url");
      const source = join(work, `src-${id}`);
      await mkdir(join(source, "docs"), { recursive: true });
      await writeFile(join(source, "a.txt"), "alpha\n");
      await writeFile(join(source, "docs", "b.txt"), "bravo\n");
      await writeFile(join(source, "big.bin"), randomBytes(100_000));
      const repo = { id, tenantId, prefix, password, source };
      await withRepository(accessOf(repo, primaryDir), (session) => resticInit(session));
      return repo;
    }

    /** One backup into the primary's repository; the new snapshot's id. */
    async function backUp(repo: Repo): Promise<string> {
      await writeFile(join(repo.source, "a.txt"), `alpha ${randomUUID()}\n`);
      return withRepository(accessOf(repo, primaryDir), async (session) => {
        const before = new Set((await resticSnapshots(session)).map((snapshot) => snapshot.id));
        await runRestic(session, ["backup", repo.source]);
        const created = (await resticSnapshots(session)).find(
          (snapshot) => !before.has(snapshot.id),
        );
        return created?.id as string;
      });
    }

    /** A machine with `snapshots` backups its runs reported, one a day, the newest a day old. */
    async function makeMachine(
      options: { snapshots?: number; tenantId?: string; settings?: Record<string, unknown> } = {},
    ): Promise<Repo & { snapshotIds: string[] }> {
      const tenantId = options.tenantId ?? contoso;
      const id = randomUUID();
      const repo = await makeRepository(tenantId, id, endpointPrefix(id));
      await owner.insert(endpoints).values({
        id,
        tenantId,
        hostname: `host-${id.slice(0, 4)}`,
        os: "linux",
        arch: "amd64",
        profile: "server",
        status: "active",
        secretHash: hashSecret("rsea_x"),
        repositorySecretId: await storeSecret(tenantId, "endpoint_repository", repo.password),
        config: defaultEndpointConfig("linux", "server", { timeZone: "Europe/Berlin" }),
        settings: options.settings ?? {},
        lastSeenAt: new Date(),
      });
      const count = options.snapshots ?? 0;
      const snapshotIds: string[] = [];
      for (let index = 0; index < count; index++) {
        snapshotIds.push(
          await recordedBackup(repo, new Date(clock.getTime() - (count - index) * DAY)),
        );
      }
      return { ...repo, snapshotIds };
    }

    /** A backup of a machine that a run reported, finished at `finishedAt`. */
    async function recordedBackup(repo: Repo, finishedAt: Date): Promise<string> {
      const snapshotId = await backUp(repo);
      await owner.insert(endpointRuns).values({
        tenantId: repo.tenantId,
        endpointId: repo.id,
        kind: "backup",
        status: "succeeded",
        startedAt: finishedAt,
        finishedAt,
        snapshotId,
      });
      return snapshotId;
    }

    const rowsOf = (ownerId: string): Promise<RepositoryCopy[]> =>
      owner.select().from(repositoryCopies).where(eq(repositoryCopies.ownerId, ownerId));

    const rowOf = async (ownerId: string): Promise<RepositoryCopy> =>
      (await rowsOf(ownerId))[0] as RepositoryCopy;

    /** Everything refused: restore mode is on. */
    function restoreModeGuard(): DeletionGuard {
      return {
        async decide(): Promise<DeletionDecision> {
          return { allowed: false, reason: "restore_mode", restoreModeId: null };
        },
        holding: () => true,
      };
    }

    it(
      "copies every recorded restore point of a machine to the copy target, same prefix and password, and checks it",
      async () => {
        const machine = await makeMachine({ snapshots: 3 });
        // A snapshot no run reported: the server neither copies nor forgets it.
        const unrecorded = await backUp(machine);

        const summary = await repositoryCopyPass(deps);
        expect(summary).toMatchObject({ copied: 3, current: 1, failed: 0, forgotten: 0 });

        // The same prefix on the copy target, opened with the same password.
        const onCopy = await snapshotsOn(machine, copyDir);
        expect(onCopy.map((snapshot) => snapshot.original).sort()).toEqual(
          [...machine.snapshotIds].sort(),
        );
        expect(onCopy.some((snapshot) => snapshot.original === unrecorded)).toBe(false);
        // restic copy writes ids of its own; the primary's id finds the copy.
        for (const id of machine.snapshotIds) {
          expect(onCopy.map((snapshot) => snapshot.id)).not.toContain(id);
          expect(snapshotIdIn(onCopy, id)).toMatch(/^[0-9a-f]{64}$/);
        }
        await withRepository(accessOf(machine, copyDir), (session) =>
          resticCheckStructure(session),
        );
        // Marked as a copy: a move and the repository repair leave it out.
        expect(
          await new LocalStorageBackend(copyDir).head(
            `${machine.prefix}${REPOSITORY_COPY_MARKER_FILE}`,
          ),
        ).not.toBeNull();

        const row = await rowOf(machine.id);
        expect(row).toMatchObject({
          tenantId: contoso,
          kind: "machine",
          prefix: machine.prefix,
          targetId: copyTarget().id,
          state: "current",
          primarySnapshots: 3,
          missingSnapshots: 0,
          lastSnapshotId: machine.snapshotIds[2],
          lastCheckOk: true,
          lastError: null,
          troubleSince: null,
          deletionsDeferred: null,
        });
        expect(row.lastCopiedAt).not.toBeNull();
        // The sample of pack data was read back on this first pass (weekly from then on).
        expect(row.lastDataCheckAt).not.toBeNull();
      },
      SLOW,
    );

    it(
      "copies only what is new after later backup runs: several runs between two passes, one copy",
      async () => {
        const machine = await makeMachine({ snapshots: 2 });
        expect((await repositoryCopyPass(deps)).copied).toBe(2);
        const first = await rowOf(machine.id);

        // Nothing new, the day is not over: the pass leaves the repository alone.
        clock = new Date(clock.getTime() + HOUR);
        expect(await repositoryCopyPass(deps)).toMatchObject({ copied: 0, current: 0 });
        expect((await rowOf(machine.id)).lastAttemptAt).toEqual(first.lastAttemptAt);

        // Two runs finish on two later days (the daily rule keeps one snapshot a day); the next
        // pass, the pending judgement window over, copies both at once.
        const newer = [
          await recordedBackup(machine, new Date(clock.getTime() + 36 * HOUR)),
          await recordedBackup(machine, new Date(clock.getTime() + 72 * HOUR)),
        ];
        clock = new Date(clock.getTime() + 81 * HOUR);
        expect(await repositoryCopyPass(deps)).toMatchObject({ copied: 2, current: 1 });
        const onCopy = await snapshotsOn(machine, copyDir);
        expect(onCopy).toHaveLength(4);
        expect(onCopy.map((snapshot) => snapshot.original)).toEqual(expect.arrayContaining(newer));
        expect(await rowOf(machine.id)).toMatchObject({
          state: "current",
          primarySnapshots: 4,
          missingSnapshots: 0,
        });
      },
      SLOW,
    );

    it(
      "applies the machine's retention on the copy and never deletes on the primary",
      async () => {
        const machine = await makeMachine({ snapshots: 4 });
        expect((await repositoryCopyPass(deps)).copied).toBe(4);

        // The policy tightens: the newest daily snapshot only.
        await owner
          .update(endpoints)
          .set({ settings: { retention: { keepDaily: 1, keepWeekly: 0, keepMonthly: 0 } } })
          .where(eq(endpoints.id, machine.id));
        clock = new Date(clock.getTime() + COPY_CATCH_UP_MS);
        const summary = await repositoryCopyPass(deps);
        expect(summary).toMatchObject({ copied: 0, forgotten: 3, current: 1 });

        const onCopy = await snapshotsOn(machine, copyDir);
        expect(onCopy.map((snapshot) => snapshot.original)).toEqual([machine.snapshotIds[3]]);
        // The prune left a sound repository behind.
        await withRepository(accessOf(machine, copyDir), (session) =>
          resticCheckStructure(session),
        );
        // The copy pass decides nothing on the primary: its retention job does.
        expect(await snapshotsOn(machine, primaryDir)).toHaveLength(4);
        expect(await rowOf(machine.id)).toMatchObject({
          state: "current",
          lastForgotten: 3,
          primarySnapshots: 1,
          missingSnapshots: 0,
          deletionsDeferred: null,
        });

        // A forgotten restore point is not copied again by the next pass.
        clock = new Date(clock.getTime() + COPY_CATCH_UP_MS);
        expect(await repositoryCopyPass(deps)).toMatchObject({ copied: 0, forgotten: 0 });
        expect(await snapshotsOn(machine, copyDir)).toHaveLength(1);
      },
      SLOW,
    );

    it(
      "restore mode keeps deletions off the copy while copying goes on",
      async () => {
        const machine = await makeMachine({ snapshots: 3 });
        expect((await repositoryCopyPass(deps)).copied).toBe(3);
        await owner
          .update(endpoints)
          .set({ settings: { retention: { keepDaily: 1, keepWeekly: 0, keepMonthly: 0 } } })
          .where(eq(endpoints.id, machine.id));
        const newest = await recordedBackup(machine, new Date(clock.getTime() + HOUR));

        uninstallGuard = installDeletionEnforcement(restoreModeGuard());
        clock = new Date(clock.getTime() + 8 * HOUR);
        const held = await repositoryCopyPass(deps);
        // The new restore point reached the copy; nothing was forgotten there.
        expect(held).toMatchObject({ copied: 1, forgotten: 0, failed: 0 });
        const during = await snapshotsOn(machine, copyDir);
        expect(during).toHaveLength(4);
        expect(during.map((snapshot) => snapshot.original)).toContain(newest);
        expect(await rowOf(machine.id)).toMatchObject({
          state: "current",
          deletionsDeferred: "restore_mode",
          lastForgotten: 0,
        });

        // Restore mode ends: the next pass applies the retention.
        uninstallGuard();
        uninstallGuard = null;
        clock = new Date(clock.getTime() + COPY_CATCH_UP_MS);
        expect(await repositoryCopyPass(deps)).toMatchObject({ forgotten: 3 });
        expect((await snapshotsOn(machine, copyDir)).map((s) => s.original)).toEqual([newest]);
        expect((await rowOf(machine.id)).deletionsDeferred).toBeNull();
      },
      SLOW,
    );

    it(
      "copies to a write-once copy target and defers every deletion there",
      async () => {
        layout.copies = [copyTarget({ writeOnce: true })];
        const machine = await makeMachine({ snapshots: 3 });
        expect((await repositoryCopyPass(deps)).copied).toBe(3);
        await owner
          .update(endpoints)
          .set({ settings: { retention: { keepDaily: 1, keepWeekly: 0, keepMonthly: 0 } } })
          .where(eq(endpoints.id, machine.id));
        clock = new Date(clock.getTime() + COPY_CATCH_UP_MS);
        expect(await repositoryCopyPass(deps)).toMatchObject({ forgotten: 0, failed: 0 });
        expect(await snapshotsOn(machine, copyDir)).toHaveLength(3);
        expect(await rowOf(machine.id)).toMatchObject({
          state: "current",
          deletionsDeferred: "write_once",
          lastForgotten: 0,
        });
      },
      SLOW,
    );

    it(
      "the copy opens with the repository password after the primary's repository is gone, and finds a restore point by the primary's id",
      async () => {
        const machine = await makeMachine({ snapshots: 2 });
        expect((await repositoryCopyPass(deps)).copied).toBe(2);

        // The primary loses the repository (the folder is gone).
        await rename(join(primaryDir, "endpoints", machine.id), join(work, `lost-${machine.id}`));
        const primary = new LocalStorageBackend(primaryDir);
        const copy = new LocalStorageBackend(copyDir);
        // What the read fallback looks at (apps/api endpoints/repository.ts `backendHolding`).
        expect(await primary.head(`${machine.prefix}config`)).toBeNull();
        expect(await copy.head(`${machine.prefix}config`)).not.toBeNull();

        const wanted = machine.snapshotIds[0] as string;
        const content = await withRepository(accessOf(machine, copyDir), async (session) => {
          const listed = await resticSnapshots(session, { noLock: true });
          const id = snapshotIdIn(listed, wanted);
          expect(id).not.toBeNull();
          expect(id).not.toBe(wanted);
          const { stdout } = await runRestic(session, [
            "dump",
            "--no-lock",
            id as string,
            join(machine.source, "docs", "b.txt"),
          ]);
          return stdout;
        });
        expect(content).toBe("bravo\n");

        // The server's own repository check and restore test stay on the primary. With its
        // repository gone they say so: the check is red with the reason, the restore test is
        // incomplete (it rates nothing); neither is ever green.
        await owner
          .update(endpoints)
          .set({ lastSnapshotId: wanted })
          .where(eq(endpoints.id, machine.id));
        const [reportingRun] = await owner
          .select({ id: endpointRuns.id })
          .from(endpointRuns)
          .where(eq(endpointRuns.snapshotId, wanted));
        await owner.insert(endpointSamples).values({
          tenantId: contoso,
          endpointId: machine.id,
          runId: reportingRun?.id as string,
          snapshotId: wanted,
          path: join(machine.source, "docs", "b.txt"),
          sha256: createHash("sha256").update("bravo\n").digest("hex"),
          size: 6,
        });
        await endpointCheck(deps, { tenantId: contoso, endpointId: machine.id });
        await expect(
          endpointVerify(deps, { tenantId: contoso, endpointId: machine.id }),
        ).rejects.toBeInstanceOf(RestoreTestIncompleteError);
        const reports = await owner
          .select()
          .from(endpointReports)
          .where(eq(endpointReports.endpointId, machine.id));
        expect(reports.map((report) => [report.kind, report.readiness])).toEqual([
          ["repository_check", "red"],
        ]);
        expect(String(reports[0]?.summary.errorMessage)).toMatch(/config|repository/i);

        // The pass says what is wrong, and deletes nothing on the copy.
        clock = new Date(clock.getTime() + COPY_CATCH_UP_MS);
        expect(await repositoryCopyPass(deps)).toMatchObject({ failed: 1, forgotten: 0 });
        expect(await rowOf(machine.id)).toMatchObject({
          state: "failed",
          lastError: "the repository is not on the primary storage target",
        });
        expect(await snapshotsOn(machine, copyDir)).toHaveLength(2);
      },
      SLOW,
    );

    it(
      "a file share's copy holds its active restore points and forgets the ones retention pruned",
      async () => {
        const id = randomUUID();
        const share = await makeRepository(contoso, id, fileShareRepositoryPrefix(id));
        await owner.insert(fileShares).values({
          id,
          tenantId: contoso,
          name: "Data",
          protocol: "nfs",
          server: "nfs.example.test",
          exportPath: "/srv/data",
          repositorySecretId: await storeSecret(contoso, "file_share_repository", share.password),
          repositoryReadyAt: new Date(),
        });
        const ids: string[] = [];
        for (let sequence = 1; sequence <= 3; sequence++) {
          const resticSnapshotId = await backUp(share);
          ids.push(resticSnapshotId);
          await owner.insert(fileShareSnapshots).values({
            tenantId: contoso,
            fileShareId: id,
            sequence,
            resticSnapshotId,
            snapshotTime: new Date(clock.getTime() - (4 - sequence) * DAY),
            files: 3,
            createdAt: new Date(clock.getTime() - (4 - sequence) * DAY),
          });
        }
        // A snapshot of a run that never recorded a restore point stays on the primary only.
        await backUp(share);

        expect(await repositoryCopyPass(deps)).toMatchObject({ copied: 3, current: 1 });
        expect((await snapshotsOn(share, copyDir)).map((s) => s.original).sort()).toEqual(
          [...ids].sort(),
        );
        expect(await rowOf(id)).toMatchObject({ kind: "file_share", prefix: share.prefix });

        // The share's retention pruned the oldest restore point.
        await owner
          .update(fileShareSnapshots)
          .set({ status: "pruned", prunedAt: clock })
          .where(eq(fileShareSnapshots.resticSnapshotId, ids[0] as string));
        clock = new Date(clock.getTime() + COPY_CATCH_UP_MS);
        expect(await repositoryCopyPass(deps)).toMatchObject({ copied: 0, forgotten: 1 });
        expect((await snapshotsOn(share, copyDir)).map((s) => s.original).sort()).toEqual(
          [ids[1], ids[2]].sort(),
        );
        expect(await rowOf(id)).toMatchObject({ state: "current", primarySnapshots: 2 });

        // Purging the share deletes its repository on the primary and its copy on the copy target.
        const cachesRemoved: string[] = [];
        const purged = await purgeShare(
          {
            ...deps,
            runner: {
              removeCache: async (shareId: string) => {
                cachesRemoved.push(shareId);
              },
            } as unknown as FileShareDeps["runner"],
          },
          { tenantId: contoso, fileShareId: id },
        );
        expect(purged?.objects).toBeGreaterThan(0);
        expect(await new LocalStorageBackend(primaryDir).list(share.prefix)).toEqual([]);
        expect(await new LocalStorageBackend(copyDir).list(share.prefix)).toEqual([]);
        expect(cachesRemoved).toEqual([id]);
        // The share is gone: the next pass drops its row.
        await repositoryCopyPass(deps);
        expect(await rowsOf(id)).toEqual([]);
      },
      SLOW,
    );

    it(
      "a container's copy follows its restore points, and nothing is forgotten while it is held on suspicion",
      async () => {
        const [cluster] = await owner
          .insert(pveClusters)
          .values({
            tenantId: contoso,
            name: "lab",
            fingerprint: "c".repeat(64),
            storageId: "restow",
          })
          .returning();
        const id = randomUUID();
        const guest = await makeRepository(contoso, id, `pve-guests/${id}/`);
        await owner.insert(pveGuests).values({
          id,
          tenantId: contoso,
          clusterId: cluster?.id as string,
          vmid: 109,
          kind: "ct",
          node: "pve1",
          name: "web",
          repositorySecretId: await storeSecret(contoso, "pve_ct_repository", guest.password),
          repositoryReadyAt: new Date(),
        });
        const points: { rowId: string; resticId: string }[] = [];
        for (let sequence = 1; sequence <= 2; sequence++) {
          const resticId = await backUp(guest);
          const backupAt = new Date(clock.getTime() - (3 - sequence) * DAY);
          const [row] = await owner
            .insert(pveSnapshots)
            .values({
              tenantId: contoso,
              clusterId: cluster?.id as string,
              guestId: id,
              sequence,
              kind: "ct",
              archiveName: `ct/109/${backupAt.toISOString().replace(/\.\d{3}Z$/, "Z")}`,
              storageId: "restow",
              manifestPath: `ct-109-${sequence}`,
              backupAt,
              resticSnapshotId: resticId,
              createdAt: backupAt,
            })
            .returning();
          points.push({ rowId: row?.id as string, resticId });
        }
        expect(await repositoryCopyPass(deps)).toMatchObject({ copied: 2, current: 1 });
        expect(await rowOf(id)).toMatchObject({ kind: "container", state: "current" });

        // Retention pruned the older restore point, but the guest is held on suspicion.
        await owner
          .update(pveSnapshots)
          .set({ status: "pruned", prunedAt: clock })
          .where(eq(pveSnapshots.id, points[0]?.rowId as string));
        await owner.$client.query(
          `INSERT INTO restore_point_suspicions
             (tenant_id, object_kind, object_id, run_id, restore_point_id, restore_point_at,
              verdict, metrics, signatures_version)
           VALUES ($1, 'pve_guest', $2, gen_random_uuid(), $3, now(), 'suspicious', '{}'::jsonb, 'test')`,
          [contoso, id, points[1]?.rowId],
        );
        clock = new Date(clock.getTime() + COPY_CATCH_UP_MS);
        expect(await repositoryCopyPass(deps)).toMatchObject({ forgotten: 0 });
        expect(await snapshotsOn(guest, copyDir)).toHaveLength(2);

        // Released: the copy forgets what retention pruned.
        await owner.$client.query("DELETE FROM restore_point_suspicions WHERE object_id = $1", [
          id,
        ]);
        clock = new Date(clock.getTime() + COPY_CATCH_UP_MS);
        expect(await repositoryCopyPass(deps)).toMatchObject({ forgotten: 1 });
        expect((await snapshotsOn(guest, copyDir)).map((s) => s.original)).toEqual([
          points[1]?.resticId,
        ]);
      },
      SLOW,
    );

    it(
      "a copy target added later receives every repository on the next pass, and its rows go when it is removed",
      async () => {
        layout.copies = [];
        const machine = await makeMachine({ snapshots: 2 });
        expect(await repositoryCopyPass(deps)).toMatchObject({ copied: 0 });
        expect(await rowsOf(machine.id)).toEqual([]);

        const second = copyTarget({
          id: "22222222-2222-4222-8222-222222222222",
          name: "Second",
          backend: new LocalStorageBackend(join(work, "copy-2")),
        });
        layout.copies = [second];
        expect(await repositoryCopyPass(deps)).toMatchObject({ copied: 2, current: 1 });
        expect(await rowOf(machine.id)).toMatchObject({ targetId: second.id, state: "current" });
        expect(await second.backend.head(`${machine.prefix}config`)).not.toBeNull();

        layout.copies = [];
        await repositoryCopyPass(deps);
        expect(await rowsOf(machine.id)).toEqual([]);
        // What the target held stays there: removing a copy target deletes nothing.
        expect(await second.backend.head(`${machine.prefix}config`)).not.toBeNull();
      },
      SLOW,
    );

    it(
      "a copy target that is down fails the copy, is tried again an hour later and alerts once after two days",
      async () => {
        const machine = await makeMachine({ snapshots: 1 });
        const healthy = new LocalStorageBackend(copyDir);
        const state = { down: true };
        const flaky = new Proxy(healthy, {
          get(target, property, receiver) {
            const value = Reflect.get(target, property, receiver);
            if (typeof value !== "function") return value;
            return (...args: unknown[]) => {
              if (state.down) {
                return Promise.reject(new Error("connect ECONNREFUSED 10.0.0.9:9000"));
              }
              return (value as (...a: unknown[]) => unknown).apply(target, args);
            };
          },
        }) as StorageBackend;
        layout.copies = [copyTarget({ backend: flaky })];

        const started = clock;
        expect(await repositoryCopyPass(deps)).toMatchObject({ failed: 1, copied: 0, alerts: 0 });
        const failed = await rowOf(machine.id);
        expect(failed).toMatchObject({ state: "failed", lastCopiedAt: null, alertedAt: null });
        expect(failed.lastError).toContain("ECONNREFUSED");
        expect(failed.troubleSince).toEqual(started);

        // Not on every pass: an hour later.
        clock = new Date(started.getTime() + 10 * 60_000);
        await repositoryCopyPass(deps);
        expect((await rowOf(machine.id)).lastAttemptAt).toEqual(started);
        clock = new Date(started.getTime() + COPY_RETRY_MS);
        await repositoryCopyPass(deps);
        expect((await rowOf(machine.id)).lastAttemptAt).toEqual(clock);
        expect((await rowOf(machine.id)).troubleSince).toEqual(started);
        expect(await owner.select().from(notifications)).toEqual([]);

        // Two days behind: one warning, not a critical event, and not again on later passes.
        clock = new Date(started.getTime() + COPY_ALERT_AFTER_MS + 60_000);
        expect((await repositoryCopyPass(deps)).alerts).toBe(1);
        clock = new Date(clock.getTime() + 2 * HOUR);
        expect((await repositoryCopyPass(deps)).alerts).toBe(0);
        const raised = await owner.select().from(notifications);
        expect(raised).toHaveLength(1);
        expect(raised[0]).toMatchObject({
          tenantId: contoso,
          level: "warning",
          event: "storage.copy_behind",
        });
        expect(raised[0]?.details).toMatchObject({
          ownerId: machine.id,
          kind: "machine",
          targetName: "Offsite",
          state: "failed",
        });
        expect(raised[0]?.message).toContain("Offsite");

        // The target is back: the catch-up copies, and the episode is over.
        state.down = false;
        clock = new Date(clock.getTime() + COPY_RETRY_MS);
        expect(await repositoryCopyPass(deps)).toMatchObject({ copied: 1, current: 1, alerts: 0 });
        expect(await rowOf(machine.id)).toMatchObject({
          state: "current",
          lastError: null,
          troubleSince: null,
          alertedAt: null,
          missingSnapshots: 0,
        });
      },
      SLOW,
    );

    it(
      "a copy that stops half way keeps what it finished, counts the lag and forgets nothing",
      async () => {
        const machine = await makeMachine({ snapshots: 3 });
        const healthy = new LocalStorageBackend(copyDir);
        // The copy target runs full after the first copied snapshot was saved.
        const state = { full: true, snapshots: 0 };
        const filling = new Proxy(healthy, {
          get(target, property, receiver) {
            const value = Reflect.get(target, property, receiver);
            if (property !== "put") {
              return typeof value === "function" ? value.bind(target) : value;
            }
            return async (key: string, ...rest: unknown[]) => {
              if (state.full && key.includes("/snapshots/") && ++state.snapshots > 1) {
                throw Object.assign(new Error("ENOSPC: no space left on device, write"), {
                  code: "ENOSPC",
                });
              }
              return (value as (...a: unknown[]) => Promise<void>).call(target, key, ...rest);
            };
          },
        }) as StorageBackend;
        layout.copies = [copyTarget({ backend: filling })];

        expect(await repositoryCopyPass(deps)).toMatchObject({ copied: 1, failed: 1 });
        const row = await rowOf(machine.id);
        expect(row).toMatchObject({
          state: "failed",
          primarySnapshots: 3,
          missingSnapshots: 2,
          lastSnapshotId: machine.snapshotIds[0],
          lastForgotten: 0,
        });
        expect(row.lastError).toContain("restic copy failed");
        expect(row.troubleSince).not.toBeNull();

        // Room again: the retry an hour later copies the rest.
        state.full = false;
        clock = new Date(clock.getTime() + COPY_RETRY_MS);
        expect(await repositoryCopyPass(deps)).toMatchObject({ copied: 2, current: 1 });
        expect(await rowOf(machine.id)).toMatchObject({
          state: "current",
          missingSnapshots: 0,
          lastError: null,
          troubleSince: null,
        });
      },
      SLOW,
    );

    it(
      "never writes into a repository on the copy target that is no copy (what a cancelled move left)",
      async () => {
        const machine = await makeMachine({ snapshots: 2 });
        // The copy target holds the primary's own repository files under the prefix.
        await cp(
          join(primaryDir, "endpoints", machine.id),
          join(copyDir, "endpoints", machine.id),
          { recursive: true },
        );
        const copy = new LocalStorageBackend(copyDir);
        const before = (await copy.list(machine.prefix)).sort();

        expect(await repositoryCopyPass(deps)).toMatchObject({ copied: 0, failed: 1 });
        expect(await rowOf(machine.id)).toMatchObject({
          state: "failed",
          lastError: FOREIGN_REPOSITORY_MESSAGE,
        });
        const after = (await copy.list(machine.prefix))
          .filter((key) => !key.startsWith(`${machine.prefix}locks/`))
          .sort();
        expect(after).toEqual(before.filter((key) => !key.startsWith(`${machine.prefix}locks/`)));
        expect(after).not.toContain(`${machine.prefix}${REPOSITORY_COPY_MARKER_FILE}`);
      },
      SLOW,
    );

    it(
      "keeps the rows of each tenant to itself",
      async () => {
        const ours = await makeMachine({ snapshots: 1 });
        const theirs = await makeMachine({ snapshots: 1, tenantId: fabrikam });
        expect(await repositoryCopyPass(deps)).toMatchObject({ copied: 2, current: 2 });
        const seen = await withTenantTx(appDb, contoso, (tx) => tx.select().from(repositoryCopies));
        expect(seen.map((row) => row.ownerId)).toEqual([ours.id]);
        const other = await withTenantTx(appDb, fabrikam, (tx) =>
          tx.select().from(repositoryCopies),
        );
        expect(other.map((row) => row.ownerId)).toEqual([theirs.id]);
        // Each repository lies under its own prefix on the copy target, with its own password.
        expect(await snapshotsOn(theirs, copyDir)).toHaveLength(1);
        await expect(
          snapshotsOn({ ...theirs, password: ours.password }, copyDir),
        ).rejects.toThrow();
      },
      SLOW,
    );
  },
);
