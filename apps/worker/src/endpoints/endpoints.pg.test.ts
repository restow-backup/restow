/**
 * Postgres-backed tests of the endpoint jobs (docs/AGENT.md) with the real
 * restic binary: retention prunes to the endpoint's policy, the repository
 * check finds a damaged pack, the restore test rates a snapshot green only
 * when every sampled hash matches, and the monitor raises each alert once.
 *
 * The jobs run on the provisioned application and installation roles, as in
 * production, so Row Level Security binds them. Needs RESTOW_TEST_DATABASE_URL
 * (a superuser; the database `restow_worker_endpoints_test` is recreated) and
 * restic (RESTIC_BINARY, else the PATH).
 */
import { spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EnvKeyProvider,
  GIB,
  Keyring,
  LocalStorageBackend,
  type StorageTargets,
  type TenantKeyring,
  defaultEndpointConfig,
  endpointPasswordKey,
  endpointPrefix,
  generateDek,
  hashSecret,
  noopLogger,
  openEndpointPassword,
  openRepository,
  resticBinary,
  resticInit,
  resticSnapshots,
  runRestic,
  sealSecret,
  withRepository,
} from "@restow/core";
import {
  type Database,
  EndpointRepositoryBusyError,
  type RoleLogin,
  acquireEndpointRepositoryLock,
  createDb,
  endpointDownloads,
  endpointReports,
  endpointRepositoryLocks,
  endpointRuns,
  endpointSamples,
  endpointSnapshotFlags,
  endpointTasks,
  endpoints,
  notifications,
  reportDeliveries,
  webhookDeliveries,
  webhooks,
} from "@restow/db";
import { runMigrations } from "@restow/db/migrate";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TenantCache, loadTenantKeyring, withTenantTx } from "../handlers/framework.js";
import { dropTestDatabase } from "../testing/database.js";
import { endpointCheck } from "./check.js";
import type { EndpointJobDeps } from "./common.js";
import { LOCKED_ALERT_ATTEMPTS, clearLocksBeforeMaintenance } from "./maintenance.js";
import { RUN_SILENCE_LIMIT_MS, endpointMonitor } from "./monitor.js";
import { endpointRetention } from "./retention.js";
import { RestoreTestIncompleteError, endpointVerify } from "./verify.js";

const adminUrl = process.env.RESTOW_TEST_DATABASE_URL;
const TEST_DB = "restow_worker_endpoints_test";

function resticAvailable(): boolean {
  const result = spawnSync(resticBinary(), ["version"], { encoding: "utf8" });
  return result.status === 0 && /^restic 0\.\d+/.test(result.stdout);
}

const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe.skipIf(!adminUrl || !resticAvailable())(
  "endpoint jobs against Postgres and restic",
  () => {
    let owner: Database;
    let deps: EndpointJobDeps;
    let appDb: Database;
    let providerDb: Database;
    let work: string;
    let storageDir: string;
    let contoso: string;
    let fabrikam: string;
    let clock = new Date();
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
        name: `restow_w_app_${suffix}`,
        password: randomBytes(12).toString("hex"),
      };
      const installationLogin: RoleLogin = {
        name: `restow_w_inst_${suffix}`,
        password: randomBytes(12).toString("hex"),
      };
      roleNames.push(tenantLogin.name, installationLogin.name);
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

      work = await mkdtemp(join(tmpdir(), "restow-worker-endpoints-"));
      storageDir = join(work, "storage");

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

      // A tenant key wrapped under the master key, as the API creates it.
      const kek = randomBytes(32);
      const provideKeys = new EnvKeyProvider(kek);
      const dek = generateDek(1);
      for (const tenantId of [contoso, fabrikam]) {
        await q(
          "INSERT INTO tenant_keys (tenant_id, key_version, encrypted_dek, kek_id) VALUES ($1, 1, $2, 'env:RESTOW_MASTER_KEY')",
          [tenantId, (await provideKeys.wrapDek(dek)).toString("base64")],
        );
      }
      (globalThis as { __dek?: typeof dek }).__dek = dek;

      const keyrings = new TenantCache<TenantKeyring>((tenantId) =>
        loadTenantKeyring({ db: appDb, tenantId, keyProvider: provideKeys }),
      );
      const storage = new TenantCache<StorageTargets>(async () => ({
        primary: new LocalStorageBackend(storageDir),
        copies: [],
      }));
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

    interface Made {
      id: string;
      tenantId: string;
      password: string;
      source: string;
    }

    const snapshotDir = (id: string) => join(storageDir, "endpoints", id, "snapshots");

    /** The snapshot files of an endpoint's repository, by name. */
    const snapshotFiles = async (id: string) =>
      readdir(snapshotDir(id)).catch(() => [] as string[]);

    /**
     * Run a backup into the repository as a machine would, dated `taken` by the
     * agent; `record` makes it a run the server knows about, its snapshot file
     * stored at `storedAt` (the storage's own time, which the server trusts).
     */
    async function backUp(
      made: Pick<Made, "id" | "tenantId" | "password" | "source">,
      options: { taken: Date; storedAt?: Date; record: boolean },
    ): Promise<string> {
      const before = new Set(await snapshotFiles(made.id));
      const open = await openRepository({
        storage: new LocalStorageBackend(storageDir),
        prefix: endpointPrefix(made.id),
        repositoryPassword: made.password,
        repositoryKey: made.id,
        cacheBase: join(work, "cache"),
      });
      try {
        await writeFile(join(made.source, "a.txt"), `alpha ${randomUUID()}\n`);
        await runRestic(open.session, [
          "backup",
          made.source,
          "--time",
          options.taken.toISOString().slice(0, 19).replace("T", " "),
        ]);
      } finally {
        await open.close();
      }
      const created = (await snapshotFiles(made.id)).find((name) => !before.has(name)) as string;
      const storedAt = options.storedAt ?? options.taken;
      await utimes(join(snapshotDir(made.id), created), storedAt, storedAt);
      if (options.record) {
        await owner.insert(endpointRuns).values({
          tenantId: made.tenantId,
          endpointId: made.id,
          kind: "backup",
          status: "succeeded",
          startedAt: storedAt,
          finishedAt: storedAt,
          snapshotId: created,
        });
      }
      return created;
    }

    /** An endpoint with a real repository holding `snapshots` recorded daily backups of a small folder. */
    async function makeEndpoint(
      options: {
        tenantId?: string;
        profile?: "server" | "client";
        snapshots?: number;
        settings?: Record<string, unknown>;
      } = {},
    ): Promise<Made> {
      const tenantId = options.tenantId ?? contoso;
      const id = randomUUID();
      const password = randomBytes(24).toString("base64url");
      const secretId = randomUUID();
      const dek = (globalThis as { __dek?: ReturnType<typeof generateDek> }).__dek as ReturnType<
        typeof generateDek
      >;
      await owner.$client.query(
        "INSERT INTO secrets (id, tenant_id, kind, ciphertext, key_version) VALUES ($1, $2, 'endpoint_repository', $3, 1)",
        [secretId, tenantId, sealSecret(dek, secretId, password)],
      );
      const source = join(work, `src-${id}`);
      await mkdir(join(source, "docs"), { recursive: true });
      await writeFile(join(source, "a.txt"), "alpha\n");
      await writeFile(join(source, "docs", "b.txt"), "bravo\n");
      await writeFile(join(source, "big.bin"), randomBytes(200_000));
      const profile = options.profile ?? "server";
      await owner.insert(endpoints).values({
        id,
        tenantId,
        hostname: `host-${id.slice(0, 4)}`,
        os: "linux",
        arch: "amd64",
        profile,
        status: "active",
        secretHash: hashSecret("rsea_x"),
        repositorySecretId: secretId,
        config: defaultEndpointConfig("linux", profile, { timeZone: "Europe/Berlin" }),
        settings: options.settings ?? {},
        lastSeenAt: new Date(),
      });
      const storage = new LocalStorageBackend(storageDir);
      const open = await openRepository({
        storage,
        prefix: endpointPrefix(id),
        repositoryPassword: password,
        repositoryKey: id,
        cacheBase: join(work, "cache"),
      });
      try {
        await resticInit(open.session);
      } finally {
        await open.close();
      }
      const made = { id, tenantId, password, source };
      const count = options.snapshots ?? 0;
      for (let index = 0; index < count; index++) {
        // One snapshot per day, the newest a day old, each reported by a run.
        const taken = new Date(Date.now() - (count - index) * DAY);
        await backUp(made, { taken, record: true });
      }
      return made;
    }

    async function snapshotIds(made: Made): Promise<string[]> {
      return withRepository(
        {
          storage: new LocalStorageBackend(storageDir),
          prefix: endpointPrefix(made.id),
          repositoryPassword: made.password,
          repositoryKey: made.id,
          cacheBase: join(work, "cache"),
        },
        async (session) => (await resticSnapshots(session)).map((snapshot) => snapshot.id),
      );
    }

    const reportsOf = (id: string, kind?: "restore_test" | "repository_check" | "retention") =>
      owner
        .select()
        .from(endpointReports)
        .where(
          and(
            eq(endpointReports.endpointId, id),
            kind ? eq(endpointReports.kind, kind) : undefined,
          ),
        );

    const endpointOf = async (id: string) =>
      (await owner.select().from(endpoints).where(eq(endpoints.id, id)))[0];

    const eventsOf = async (tenantId: string, event?: string) =>
      (await owner.select().from(notifications).where(eq(notifications.tenantId, tenantId))).filter(
        (row) => !event || row.event === event,
      );

    /** Run `job` with a restic that answers every command with "repository is already locked". */
    async function withLockedRestic<T>(job: () => Promise<T>): Promise<T> {
      const fake = join(work, "restic-locked.sh");
      await writeFile(
        fake,
        '#!/bin/sh\necho "unable to create lock in backend: repository is already locked" >&2\nexit 11\n',
      );
      await chmod(fake, 0o755);
      const previous = process.env.RESTIC_BINARY;
      process.env.RESTIC_BINARY = fake;
      try {
        return await job();
      } finally {
        if (previous === undefined) {
          Reflect.deleteProperty(process.env, "RESTIC_BINARY");
        } else {
          process.env.RESTIC_BINARY = previous;
        }
      }
    }

    describe("retention", () => {
      it("prunes to the endpoint's policy and reports what it did", async () => {
        const made = await makeEndpoint({
          snapshots: 4,
          settings: { retention: { keepDaily: 2, keepWeekly: 0, keepMonthly: 0 } },
        });
        expect(await snapshotIds(made)).toHaveLength(4);
        clock = new Date();
        await endpointRetention(deps, { tenantId: made.tenantId, endpointId: made.id });
        expect(await snapshotIds(made)).toHaveLength(2);
        const [report] = await reportsOf(made.id, "retention");
        expect(report).toMatchObject({ kind: "retention", origin: "server", readiness: null });
        expect(report?.summary).toMatchObject({ removedSnapshots: 2, keptSnapshots: 2 });
        expect(report?.summary.repositoryBytes).toBeGreaterThan(0);
        expect((await endpointOf(made.id))?.lastRetentionAt).toBeInstanceOf(Date);
      }, 120_000);

      it("keeps 30 daily, 12 weekly and 12 monthly snapshots when nothing else is set", async () => {
        const made = await makeEndpoint({ snapshots: 3 });
        await endpointRetention(deps, { tenantId: made.tenantId, endpointId: made.id });
        expect(await snapshotIds(made)).toHaveLength(3);
        const [report] = await reportsOf(made.id, "retention");
        expect(report?.summary).toMatchObject({ removedSnapshots: 0, keptSnapshots: 3 });
      }, 120_000);

      it("does not touch a revoked endpoint", async () => {
        const made = await makeEndpoint({
          snapshots: 3,
          settings: { retention: { keepDaily: 1, keepWeekly: 0, keepMonthly: 0 } },
        });
        await owner.update(endpoints).set({ status: "revoked" }).where(eq(endpoints.id, made.id));
        await endpointRetention(deps, { tenantId: made.tenantId, endpointId: made.id });
        expect(await snapshotIds(made)).toHaveLength(3);
        expect(await reportsOf(made.id, "retention")).toEqual([]);
      }, 120_000);

      it("decides by the server's records, not by the times the agent wrote: forged snapshots dated in the future delete nothing", async () => {
        const made = await makeEndpoint({ snapshots: 3 });
        const genuine = await snapshotFiles(made.id);
        // A compromised machine adds snapshots dated years ahead; no run reported them.
        for (let day = 1; day <= 4; day++) {
          await backUp(made, {
            taken: new Date(Date.UTC(2031, 0, day)),
            storedAt: new Date(Date.now() - 2 * HOUR),
            record: false,
          });
        }
        clock = new Date();
        const before = (await eventsOf(made.tenantId, "endpoint.suspicious_snapshot")).length;
        await endpointRetention(deps, { tenantId: made.tenantId, endpointId: made.id });
        // restic's own --keep-daily 30 would have kept the four forged ones and dropped the rest.
        expect(await snapshotIds(made)).toHaveLength(7);
        for (const id of genuine) {
          expect(await snapshotFiles(made.id)).toContain(id);
        }
        const [report] = await reportsOf(made.id, "retention");
        expect(report?.summary).toMatchObject({
          removedSnapshots: 0,
          keptSnapshots: 7,
          unrecordedSnapshots: 4,
          futureSnapshots: 4,
        });
        const flags = await owner
          .select()
          .from(endpointSnapshotFlags)
          .where(eq(endpointSnapshotFlags.endpointId, made.id));
        expect(flags).toHaveLength(4);
        expect(flags.every((flag) => flag.alertedAt instanceof Date)).toBe(true);
        expect(flags.every((flag) => flag.reasons.join() === "unrecorded,future_time")).toBe(true);
        const alerts = await eventsOf(made.tenantId, "endpoint.suspicious_snapshot");
        expect(alerts).toHaveLength(before + 1);
        expect(alerts.at(-1)).toMatchObject({ level: "error" });
        expect(alerts.at(-1)?.details).toMatchObject({ endpointId: made.id, count: 4, future: 4 });

        // Told once: the next run keeps them and says nothing new.
        await endpointRetention(deps, { tenantId: made.tenantId, endpointId: made.id });
        expect(await eventsOf(made.tenantId, "endpoint.suspicious_snapshot")).toHaveLength(
          before + 1,
        );
      }, 180_000);

      it("drops the mark of a snapshot whose run reported it late", async () => {
        const made = await makeEndpoint({ snapshots: 1 });
        const late = await backUp(made, {
          taken: new Date(Date.now() - 3 * HOUR),
          storedAt: new Date(Date.now() - 3 * HOUR),
          record: false,
        });
        clock = new Date();
        await endpointRetention(deps, { tenantId: made.tenantId, endpointId: made.id });
        const marks = () =>
          owner
            .select({ snapshotId: endpointSnapshotFlags.snapshotId })
            .from(endpointSnapshotFlags)
            .where(eq(endpointSnapshotFlags.endpointId, made.id));
        expect(await marks()).toEqual([{ snapshotId: late }]);
        await owner.insert(endpointRuns).values({
          tenantId: made.tenantId,
          endpointId: made.id,
          kind: "backup",
          status: "succeeded",
          startedAt: new Date(Date.now() - 3 * HOUR),
          finishedAt: new Date(Date.now() - 3 * HOUR),
          snapshotId: late,
        });
        await endpointRetention(deps, { tenantId: made.tenantId, endpointId: made.id });
        expect(await marks()).toEqual([]);
      }, 120_000);

      it("forgets old recorded snapshots by id and never one no run reported", async () => {
        const made = await makeEndpoint({
          snapshots: 3,
          settings: { retention: { keepDaily: 1, keepWeekly: 0, keepMonthly: 0 } },
        });
        const recorded = await snapshotFiles(made.id);
        const stray = await backUp(made, {
          taken: new Date(Date.now() - 10 * DAY),
          storedAt: new Date(Date.now() - 10 * DAY),
          record: false,
        });
        clock = new Date();
        await endpointRetention(deps, { tenantId: made.tenantId, endpointId: made.id });
        const left = await snapshotFiles(made.id);
        expect(left).toContain(stray);
        expect(left.filter((id) => recorded.includes(id))).toHaveLength(1);
        expect(left).toHaveLength(2);
        const [report] = await reportsOf(made.id, "retention");
        expect(report?.summary).toMatchObject({ removedSnapshots: 2, unrecordedSnapshots: 1 });
      }, 180_000);

      it("keeps the repository password sealed next to the repository and measures its size", async () => {
        const made = await makeEndpoint({ snapshots: 1 });
        clock = new Date();
        await endpointRetention(deps, { tenantId: made.tenantId, endpointId: made.id });
        const storage = new LocalStorageBackend(storageDir);
        const document = await storage.get(endpointPasswordKey(made.id));
        const dek = (globalThis as { __dek?: ReturnType<typeof generateDek> }).__dek as ReturnType<
          typeof generateDek
        >;
        const keyring = new Keyring(made.tenantId, [dek]);
        expect(openEndpointPassword(document, (blob) => keyring.open(blob), made.id)).toEqual({
          tenantId: made.tenantId,
          endpointId: made.id,
          password: made.password,
        });
        // restic does not see the file, and the repository stays whole.
        expect(await snapshotIds(made)).toHaveLength(1);
        const row = await endpointOf(made.id);
        expect(row?.repositoryBytes).toBeGreaterThan(0);
        expect(row?.repositoryMeasuredAt).toBeInstanceOf(Date);
      }, 120_000);

      it("cannot open another tenant's endpoint", async () => {
        const made = await makeEndpoint({ snapshots: 1 });
        await expect(
          endpointRetention(deps, { tenantId: fabrikam, endpointId: made.id }),
        ).rejects.toThrow(/does not exist/);
      }, 60_000);
    });

    describe("repository check", () => {
      it("reports a healthy repository green", async () => {
        const made = await makeEndpoint({ snapshots: 2 });
        await endpointCheck(deps, {
          tenantId: made.tenantId,
          endpointId: made.id,
          subsetPercent: 100,
        });
        const [report] = await reportsOf(made.id, "repository_check");
        expect(report).toMatchObject({ readiness: "green", origin: "server" });
        expect(report?.summary.subset).toBe("1/1");
        expect((await endpointOf(made.id))?.lastCheckAt).toBeInstanceOf(Date);
      }, 120_000);

      it("does not count a locked repository as checked, and alerts once when it stays locked", async () => {
        const made = await makeEndpoint({ snapshots: 1 });
        const start = new Date();
        const before = (await eventsOf(made.tenantId, "endpoint.repository_locked")).length;
        for (let attempt = 0; attempt < LOCKED_ALERT_ATTEMPTS + 1; attempt++) {
          clock = new Date(start.getTime() + attempt * 3 * HOUR);
          await expect(
            withLockedRestic(() =>
              endpointCheck(deps, { tenantId: made.tenantId, endpointId: made.id }),
            ),
          ).rejects.toMatchObject({ failure: "locked" });
        }
        const row = await endpointOf(made.id);
        expect(row?.lastCheckAt).toBeNull();
        expect(row?.maintenanceLockedCount).toBe(LOCKED_ALERT_ATTEMPTS + 1);
        expect(row?.lockedAlertedAt).toBeInstanceOf(Date);
        expect(await reportsOf(made.id, "repository_check")).toEqual([]);
        const alerts = await eventsOf(made.tenantId, "endpoint.repository_locked");
        expect(alerts).toHaveLength(before + 1);
        expect(alerts.at(-1)?.details).toMatchObject({
          endpointId: made.id,
          attempts: LOCKED_ALERT_ATTEMPTS,
        });

        // The next run that gets the lock checks, and the count starts again.
        clock = new Date(start.getTime() + 30 * HOUR);
        await endpointCheck(deps, {
          tenantId: made.tenantId,
          endpointId: made.id,
          subsetPercent: 100,
        });
        const after = await endpointOf(made.id);
        expect(after?.lastCheckAt).toEqual(clock);
        expect(after).toMatchObject({ maintenanceLockedCount: 0, lockedAlertedAt: null });
      }, 120_000);

      it("does not alert about a lock that went away quickly", async () => {
        const made = await makeEndpoint({ snapshots: 1 });
        const start = new Date();
        for (let attempt = 0; attempt < LOCKED_ALERT_ATTEMPTS + 2; attempt++) {
          clock = new Date(start.getTime() + attempt * 10 * 60 * 1000);
          await expect(
            withLockedRestic(() =>
              endpointRetention(deps, { tenantId: made.tenantId, endpointId: made.id }),
            ),
          ).rejects.toMatchObject({ failure: "locked" });
        }
        // Eight attempts within 80 minutes: a long backup, not yet a finding.
        expect((await endpointOf(made.id))?.lockedAlertedAt).toBeNull();
        expect(
          (await eventsOf(made.tenantId, "endpoint.repository_locked")).filter(
            (row) => row.details?.endpointId === made.id,
          ),
        ).toEqual([]);
      }, 120_000);

      it("removes stale locks and the agent's leftover locks before maintenance, never a running agent's", async () => {
        const made = await makeEndpoint({ snapshots: 0 });
        const storage = new LocalStorageBackend(storageDir);
        const prefix = endpointPrefix(made.id);
        const lock = (n: number) => `${n}`.repeat(64).slice(0, 64);
        const now = new Date();
        const stale = new Date(now.getTime() - 2 * HOUR);
        // A lock planted long ago (its content may say anything, a time far ahead included),
        // a fresh lock the agent wrote, and a fresh lock of someone else (the server).
        for (const name of [lock(1), lock(2), lock(3)]) {
          await storage.put(`${prefix}locks/${name}`, Buffer.from(name));
        }
        await utimes(join(storageDir, "endpoints", made.id, "locks", lock(1)), stale, stale);
        await owner.insert(endpointRepositoryLocks).values([
          { tenantId: made.tenantId, endpointId: made.id, name: lock(2) },
          // A record whose file is gone already, and one whose upload may still be on its way.
          {
            tenantId: made.tenantId,
            endpointId: made.id,
            name: lock(4),
            createdAt: new Date(now.getTime() - 10 * 60 * 1000),
          },
          { tenantId: made.tenantId, endpointId: made.id, name: lock(5), createdAt: now },
        ]);
        // While a run of the agent is in progress, its lock stays.
        const [run] = await owner
          .insert(endpointRuns)
          .values({
            tenantId: made.tenantId,
            endpointId: made.id,
            kind: "backup",
            status: "running",
            startedAt: now,
          })
          .returning();
        expect(
          await clearLocksBeforeMaintenance(deps, made.tenantId, made.id, { storage, prefix }, now),
        ).toBe(1);
        expect((await storage.list(`${prefix}locks/`)).map((key) => key.slice(-64)).sort()).toEqual(
          [lock(2), lock(3)],
        );
        await owner
          .update(endpointRuns)
          .set({ status: "succeeded", finishedAt: now })
          .where(eq(endpointRuns.id, run?.id ?? ""));
        expect(
          await clearLocksBeforeMaintenance(deps, made.tenantId, made.id, { storage, prefix }, now),
        ).toBe(1);
        expect((await storage.list(`${prefix}locks/`)).map((key) => key.slice(-64))).toEqual([
          lock(3),
        ]);
        const records = await owner
          .select()
          .from(endpointRepositoryLocks)
          .where(eq(endpointRepositoryLocks.endpointId, made.id));
        expect(records.map((record) => record.name)).toEqual([lock(5)]);
      }, 60_000);

      it("finds a damaged pack and rates the repository red", async () => {
        const made = await makeEndpoint({ snapshots: 1 });
        const dataDir = join(storageDir, "endpoints", made.id, "data");
        const [folder] = await readdir(dataDir);
        const [pack] = await readdir(join(dataDir, folder as string));
        const path = join(dataDir, folder as string, pack as string);
        const bytes = await readFile(path);
        const damaged = Buffer.from(bytes);
        damaged[Math.floor(damaged.length / 2)] =
          (damaged[Math.floor(damaged.length / 2)] ?? 0) ^ 0xff;
        await writeFile(path, damaged);
        await endpointCheck(deps, {
          tenantId: made.tenantId,
          endpointId: made.id,
          subsetPercent: 100,
        });
        const [report] = await reportsOf(made.id, "repository_check");
        expect(report).toMatchObject({ readiness: "red", origin: "server" });
        expect(report?.summary.errorMessage).toBeTruthy();
      }, 120_000);
    });

    describe("restore test", () => {
      async function sample(made: Made, tamper = false) {
        const [latest] = await snapshotIds(made);
        const files = ["a.txt", "docs/b.txt", "big.bin"];
        const rows = await Promise.all(
          files.map(async (name, index) => {
            const bytes = await readFile(join(made.source, name));
            return {
              tenantId: made.tenantId,
              endpointId: made.id,
              runId: randomUUID(),
              snapshotId: latest as string,
              path: join(made.source, name),
              sha256: tamper && index === 1 ? sha256("other") : sha256(bytes),
              size: bytes.length,
            };
          }),
        );
        const [run] = await owner
          .insert(endpointRuns)
          .values({
            tenantId: made.tenantId,
            endpointId: made.id,
            kind: "backup",
            status: "succeeded",
            startedAt: new Date(),
            finishedAt: new Date(),
            snapshotId: latest,
          })
          .returning();
        await owner
          .insert(endpointSamples)
          .values(rows.map((row) => ({ ...row, runId: run?.id ?? "" })));
        await owner
          .update(endpoints)
          .set({ lastSnapshotId: latest })
          .where(eq(endpoints.id, made.id));
        return latest as string;
      }

      it("rates the snapshot green only when every hash matches, and asks the endpoint to restore the same files", async () => {
        const made = await makeEndpoint({ snapshots: 1 });
        const snapshot = await sample(made);
        await endpointVerify(deps, { tenantId: made.tenantId, endpointId: made.id });
        const [report] = await reportsOf(made.id, "restore_test");
        // The summary names restic's reason when a file could not be read.
        expect(report, JSON.stringify(report?.summary)).toMatchObject({
          origin: "server",
          snapshotId: snapshot,
          readiness: "green",
        });
        expect(report?.summary).toMatchObject({ files: 3, matched: 3, mismatched: [] });
        expect((await endpointOf(made.id))?.lastRestoreTestAt).toBeInstanceOf(Date);

        const tasks = await owner
          .select()
          .from(endpointTasks)
          .where(eq(endpointTasks.endpointId, made.id));
        expect(tasks).toHaveLength(1);
        expect(tasks[0]).toMatchObject({ kind: "verify_sample", status: "pending" });
        expect((tasks[0]?.params as { snapshotId: string }).snapshotId).toBe(snapshot);
        expect((tasks[0]?.params as { files: unknown[] }).files).toHaveLength(3);
        expect(tasks[0]?.expiresAt).toBeInstanceOf(Date);

        // Again: a new report, but the endpoint is not asked twice for the same snapshot.
        await endpointVerify(deps, { tenantId: made.tenantId, endpointId: made.id });
        expect(
          await owner.select().from(endpointTasks).where(eq(endpointTasks.endpointId, made.id)),
        ).toHaveLength(1);
      }, 120_000);

      it("rates the snapshot red when one hash differs", async () => {
        const made = await makeEndpoint({ snapshots: 1 });
        await sample(made, true);
        await endpointVerify(deps, { tenantId: made.tenantId, endpointId: made.id });
        const [report] = await reportsOf(made.id, "restore_test");
        expect(report?.readiness).toBe("red");
        expect(report?.summary).toMatchObject({ files: 3, matched: 2 });
        expect(report?.summary.mismatched).toHaveLength(1);
        expect(report?.summary.mismatched?.[0]).toMatchObject({ actual: expect.any(String) });
      }, 120_000);

      it("does nothing without samples", async () => {
        const made = await makeEndpoint({ snapshots: 1 });
        const [latest] = await snapshotIds(made);
        await owner
          .update(endpoints)
          .set({ lastSnapshotId: latest })
          .where(eq(endpoints.id, made.id));
        await endpointVerify(deps, { tenantId: made.tenantId, endpointId: made.id });
        expect(await reportsOf(made.id)).toEqual([]);
      }, 60_000);

      it("runs retention, the check and a restore test started together one after another, and rates a sound backup green", async () => {
        const made = await makeEndpoint({ snapshots: 2 });
        const snapshot = await sample(made);
        clock = new Date();
        const payload = { tenantId: made.tenantId, endpointId: made.id };
        // What the scheduler did with a new endpoint: all three within a fraction of a second.
        const outcomes = await Promise.allSettled([
          endpointRetention(deps, payload),
          endpointCheck(deps, { ...payload, subsetPercent: 100 }),
          endpointVerify(deps, payload),
        ]);
        expect(outcomes.map((outcome) => outcome.status)).toEqual([
          "fulfilled",
          "fulfilled",
          "fulfilled",
        ]);
        const [test] = await reportsOf(made.id, "restore_test");
        expect(test, JSON.stringify(test?.summary)).toMatchObject({
          snapshotId: snapshot,
          readiness: "green",
        });
        expect(test?.summary).toMatchObject({ files: 3, matched: 3 });
        const [checkReport] = await reportsOf(made.id, "repository_check");
        expect(checkReport?.readiness).toBe("green");
        expect(await reportsOf(made.id, "retention")).toHaveLength(1);
      }, 180_000);

      it("waits for other work on the repository and, when it takes too long, retries instead of rating", async () => {
        const made = await makeEndpoint({ snapshots: 1 });
        await sample(made);
        clock = new Date();
        const payload = { tenantId: made.tenantId, endpointId: made.id };
        const impatient = { ...deps, maintenanceLockWaitMs: 300 };
        // Another job (in another worker, say) holds the repository.
        const release = await acquireEndpointRepositoryLock(owner.$client, made.id, {
          mode: "exclusive",
        });
        try {
          await expect(endpointVerify(impatient, payload)).rejects.toBeInstanceOf(
            EndpointRepositoryBusyError,
          );
          await expect(
            endpointCheck(impatient, { ...payload, subsetPercent: 100 }),
          ).rejects.toBeInstanceOf(EndpointRepositoryBusyError);
          await expect(endpointRetention(impatient, payload)).rejects.toBeInstanceOf(
            EndpointRepositoryBusyError,
          );
          // Nothing was rated, recorded as checked or counted as a locked repository.
          expect(await reportsOf(made.id)).toEqual([]);
          const row = await endpointOf(made.id);
          expect(row).toMatchObject({ lastCheckAt: null, maintenanceLockedCount: 0 });
        } finally {
          await release();
        }
        // A job that waits long enough runs once the other work is done.
        const holder = await acquireEndpointRepositoryLock(owner.$client, made.id, {
          mode: "exclusive",
        });
        setTimeout(() => void holder(), 500);
        await endpointVerify({ ...deps, maintenanceLockWaitMs: 10_000 }, payload);
        const [test] = await reportsOf(made.id, "restore_test");
        expect(test?.readiness).toBe("green");
      }, 120_000);

      /**
       * Run `job` with a restic that is the real one for everything but the dump of
       * `a.txt`, where it runs `failure` (shell) instead.
       */
      async function withFailingDump<T>(failure: string, job: () => Promise<T>): Promise<T> {
        const real = resticBinary();
        const fake = join(work, `restic-dump-${randomUUID()}.sh`);
        await writeFile(
          fake,
          `#!/bin/sh\nfor last; do :; done\nif [ "$1" = dump ]; then\n  case "$last" in\n    */a.txt) ${failure} ;;\n  esac\nfi\nexec ${JSON.stringify(real)} "$@"\n`,
        );
        await chmod(fake, 0o755);
        const previous = process.env.RESTIC_BINARY;
        process.env.RESTIC_BINARY = fake;
        try {
          return await job();
        } finally {
          if (previous === undefined) {
            Reflect.deleteProperty(process.env, "RESTIC_BINARY");
          } else {
            process.env.RESTIC_BINARY = previous;
          }
        }
      }

      it.each([
        [
          "fails for a reason that proves nothing about the backup",
          `echo "Fatal: cannot dump file: ReadFull(<data/0a1b2c3d4e>): read: connection reset by peer" >&2; exit 1`,
        ],
        [
          "times out",
          `printf 'bra' ; echo "Fatal: cannot dump file: Load(<data/0a1b2c3d4e>): context deadline exceeded" >&2; exit 1`,
        ],
        ["is stopped by a signal", "kill -9 $$"],
        ["crashes", `echo "panic: runtime error" >&2; exit 2`],
      ])(
        "rates nothing and retries when the dump of a sampled file %s",
        async (_name, failure) => {
          const made = await makeEndpoint({ snapshots: 1 });
          // One of the other files differs: even so, an incomplete test rates nothing.
          await sample(made, true);
          const payload = { tenantId: made.tenantId, endpointId: made.id };
          const error = await withFailingDump(failure, () =>
            endpointVerify(deps, payload).then(
              () => null,
              (thrown: unknown) => thrown,
            ),
          );
          expect(error).toBeInstanceOf(RestoreTestIncompleteError);
          expect((error as RestoreTestIncompleteError).reason).toMatch(/^restic dump /);
          // Neither red nor green, not counted as tested, the endpoint not asked to test yet.
          expect(await reportsOf(made.id)).toEqual([]);
          expect((await endpointOf(made.id))?.lastRestoreTestAt).toBeNull();
          expect(
            await owner.select().from(endpointTasks).where(eq(endpointTasks.endpointId, made.id)),
          ).toEqual([]);
          // The retry, with the repository readable again, rates the snapshot.
          await endpointVerify(deps, payload);
          const [report] = await reportsOf(made.id, "restore_test");
          expect(report?.readiness).toBe("red");
          expect(report?.summary).toMatchObject({ files: 3, matched: 2 });
        },
        120_000,
      );

      it("rates the snapshot red when restic finds the sampled data damaged", async () => {
        const made = await makeEndpoint({ snapshots: 1 });
        await sample(made);
        // Every 16th byte of every pack: no blob (32 bytes and more, encrypted) stays whole,
        // whichever trees and data a file needs.
        const dataDir = join(storageDir, "endpoints", made.id, "data");
        for (const folder of await readdir(dataDir)) {
          for (const pack of await readdir(join(dataDir, folder))) {
            const path = join(dataDir, folder, pack);
            const bytes = await readFile(path);
            for (let index = 0; index < bytes.length; index += 16) {
              bytes[index] = (bytes[index] ?? 0) ^ 0xff;
            }
            await writeFile(path, bytes);
          }
        }
        await endpointVerify(deps, { tenantId: made.tenantId, endpointId: made.id });
        const [report] = await reportsOf(made.id, "restore_test");
        expect(report?.readiness).toBe("red");
        expect(report?.summary).toMatchObject({ files: 3, matched: 0 });
        expect(report?.summary.mismatched).toHaveLength(3);
        for (const file of report?.summary.mismatched ?? []) {
          expect(file.reason).toContain("ciphertext verification failed");
        }
      }, 120_000);

      it("retries instead of rating when the repository is busy", async () => {
        const made = await makeEndpoint({ snapshots: 1 });
        await sample(made);
        const fake = join(work, "restic-busy.sh");
        await writeFile(
          fake,
          '#!/bin/sh\necho "unable to create lock in backend: repository is already locked" >&2\nexit 11\n',
        );
        await chmod(fake, 0o755);
        const previous = process.env.RESTIC_BINARY;
        process.env.RESTIC_BINARY = fake;
        try {
          await expect(
            endpointVerify(deps, { tenantId: made.tenantId, endpointId: made.id }),
          ).rejects.toBeInstanceOf(RestoreTestIncompleteError);
        } finally {
          if (previous === undefined) {
            // Not `process.env.X = undefined`: Node coerces that to the string
            // "undefined" instead of removing the variable.
            Reflect.deleteProperty(process.env, "RESTIC_BINARY");
          } else {
            process.env.RESTIC_BINARY = previous;
          }
        }
        expect(await reportsOf(made.id)).toEqual([]);
      }, 60_000);
    });

    describe("monitor", () => {
      async function bareEndpoint(
        overrides: Partial<typeof endpoints.$inferInsert> = {},
        tenantId = contoso,
      ) {
        const id = randomUUID();
        await owner.insert(endpoints).values({
          id,
          tenantId,
          hostname: `srv-${id.slice(0, 4)}`,
          displayName: "Fileserver",
          os: "linux",
          arch: "amd64",
          profile: "server",
          secretHash: hashSecret("rsea_x"),
          config: defaultEndpointConfig("linux", "server", { timeZone: "Europe/Berlin" }),
          lastSeenAt: new Date(clock.getTime() - 5 * 60 * 1000),
          ...overrides,
        });
        return id;
      }

      it("raises a failed backup once, with the machine's name, and feeds the tenant's rules", async () => {
        clock = new Date();
        const id = await bareEndpoint();
        await owner.$client.query(
          `INSERT INTO report_rules (tenant_id, name, trigger, events, throttle_minutes, email_recipients)
         VALUES ($1, 'Failures', 'event', ARRAY['backup.failed'], 0, ARRAY['it@contoso.example'])`,
          [contoso],
        );
        const [run] = await owner
          .insert(endpointRuns)
          .values({
            tenantId: contoso,
            endpointId: id,
            kind: "backup",
            status: "failed",
            startedAt: new Date(clock.getTime() - HOUR),
            finishedAt: new Date(clock.getTime() - 30 * 60 * 1000),
            errors: [{ message: "repository unreachable" }],
          })
          .returning();
        const before = (await eventsOf(contoso, "backup.failed")).length;
        const first = await endpointMonitor(deps);
        expect(first.runAlerts).toBe(1);
        const raised = (await eventsOf(contoso, "backup.failed")).filter(
          (row) => row.details?.runId === run?.id,
        );
        expect(raised).toHaveLength(1);
        expect(raised[0]).toMatchObject({ level: "error" });
        expect(raised[0]?.message).toContain("Fileserver");
        expect(raised[0]?.message).toContain("repository unreachable");
        expect(raised[0]?.details).toMatchObject({ endpointId: id, objectName: "Fileserver" });
        expect((await eventsOf(contoso, "backup.failed")).length).toBe(before + 1);

        const deliveries = await owner
          .select()
          .from(reportDeliveries)
          .where(eq(reportDeliveries.tenantId, contoso));
        expect(
          deliveries.filter((row) => row.event === "backup.failed").length,
        ).toBeGreaterThanOrEqual(1);

        // Nothing more the second time.
        const second = await endpointMonitor(deps);
        expect(second.runAlerts).toBe(0);
        expect((await eventsOf(contoso, "backup.failed")).length).toBe(before + 1);
      }, 60_000);

      it("does not alert about a run the agent lost to a restart, and marks it handled", async () => {
        clock = new Date();
        const id = await bareEndpoint();
        const [run] = await owner
          .insert(endpointRuns)
          .values({
            tenantId: contoso,
            endpointId: id,
            kind: "backup",
            status: "failed",
            startedAt: new Date(clock.getTime() - HOUR),
            finishedAt: new Date(clock.getTime() - 30 * 60 * 1000),
            errors: [{ message: "the agent was restarted", code: "interrupted" }],
          })
          .returning();
        const before = (await eventsOf(contoso, "backup.failed")).length;
        await endpointMonitor(deps);
        expect((await eventsOf(contoso, "backup.failed")).length).toBe(before);
        const [after] = await owner
          .select()
          .from(endpointRuns)
          .where(eq(endpointRuns.id, run?.id ?? ""));
        expect(after?.alertedAt).toBeInstanceOf(Date);
      }, 60_000);

      it("does not announce a failed restore test through its run", async () => {
        clock = new Date();
        const id = await bareEndpoint();
        await owner.insert(endpointRuns).values({
          tenantId: contoso,
          endpointId: id,
          kind: "verify_sample",
          status: "failed",
          startedAt: new Date(clock.getTime() - HOUR),
          finishedAt: new Date(clock.getTime() - HOUR + 1000),
          errors: [{ message: "sha256 differs" }],
        });
        const before = (await eventsOf(contoso)).length;
        await endpointMonitor(deps);
        expect((await eventsOf(contoso)).length).toBe(before);
      }, 60_000);

      it("closes a run that died with its agent and alerts about it", async () => {
        clock = new Date();
        const id = await bareEndpoint();
        const [run] = await owner
          .insert(endpointRuns)
          .values({
            tenantId: contoso,
            endpointId: id,
            kind: "backup",
            status: "running",
            startedAt: new Date(clock.getTime() - RUN_SILENCE_LIMIT_MS - HOUR),
          })
          .returning();
        const [fresh] = await owner
          .insert(endpointRuns)
          .values({
            tenantId: contoso,
            endpointId: id,
            kind: "backup",
            status: "running",
            startedAt: new Date(clock.getTime() - RUN_SILENCE_LIMIT_MS - HOUR),
            progress: {
              filesDone: 1,
              bytesDone: 1,
              updatedAt: new Date(clock.getTime() - 60_000).toISOString(),
            },
          })
          .returning();
        const summary = await endpointMonitor(deps);
        expect(summary.abandonedRuns).toBeGreaterThanOrEqual(1);
        const [closed] = await owner
          .select()
          .from(endpointRuns)
          .where(eq(endpointRuns.id, run?.id ?? ""));
        expect(closed).toMatchObject({ status: "failed" });
        expect(closed?.errors[0]?.message).toContain("stopped reporting");
        // A run that keeps reporting progress is alive.
        const [alive] = await owner
          .select()
          .from(endpointRuns)
          .where(eq(endpointRuns.id, fresh?.id ?? ""));
        expect(alive?.status).toBe("running");
        expect(
          (await eventsOf(contoso, "backup.failed")).some((row) => row.details?.runId === run?.id),
        ).toBe(true);
      }, 60_000);

      describe("a restore test whose agent went silent", () => {
        const SNAPSHOT = "5e".repeat(32);
        const FILES = [{ path: "/etc/hosts", sha256: "ab".repeat(32) }];

        /** A restore test of `snapshotId` that started long ago and never reported again. */
        async function silentTest(
          id: string,
          params: Record<string, unknown> = {},
        ): Promise<{ runId: string; taskId: string }> {
          const [task] = await owner
            .insert(endpointTasks)
            .values({
              tenantId: contoso,
              endpointId: id,
              kind: "verify_sample",
              status: "delivered",
              params: { snapshotId: SNAPSHOT, files: FILES, ...params },
              deliveredAt: new Date(clock.getTime() - RUN_SILENCE_LIMIT_MS - HOUR),
            })
            .returning();
          const [run] = await owner
            .insert(endpointRuns)
            .values({
              tenantId: contoso,
              endpointId: id,
              kind: "verify_sample",
              status: "running",
              taskId: task?.id,
              startedAt: new Date(clock.getTime() - RUN_SILENCE_LIMIT_MS - HOUR),
            })
            .returning();
          return { runId: run?.id ?? "", taskId: task?.id ?? "" };
        }

        const testsOf = (id: string) =>
          owner
            .select()
            .from(endpointTasks)
            .where(and(eq(endpointTasks.endpointId, id), eq(endpointTasks.kind, "verify_sample")));

        it("closes it as incomplete and offers it again, without an alert or a job.failed", async () => {
          clock = new Date();
          const id = await bareEndpoint({ lastSnapshotId: SNAPSHOT });
          const [hook] = await owner
            .insert(webhooks)
            .values({ tenantId: contoso, url: "https://rmm.example/hook", events: ["job.failed"] })
            .returning();
          try {
            const test = await silentTest(id);
            // A backup closed in the same pass is still announced: the webhook path works.
            const [backup] = await owner
              .insert(endpointRuns)
              .values({
                tenantId: contoso,
                endpointId: id,
                kind: "backup",
                status: "running",
                startedAt: new Date(clock.getTime() - RUN_SILENCE_LIMIT_MS - HOUR),
              })
              .returning();
            await endpointMonitor(deps);

            const [run] = await owner
              .select()
              .from(endpointRuns)
              .where(eq(endpointRuns.id, test.runId));
            expect(run).toMatchObject({ status: "failed" });
            expect(run?.errors[0]?.code).toBe("agent_stopped");
            const tasks = await testsOf(id);
            expect(tasks.find((task) => task.id === test.taskId)).toMatchObject({
              status: "failed",
              errorMessage: "agent stopped reporting",
            });
            // The same files again, after the first wait, as for a test the agent reported incomplete.
            const again = tasks.find((task) => task.id !== test.taskId);
            expect(again).toMatchObject({
              status: "pending",
              params: { snapshotId: SNAPSHOT, files: FILES, retry: 1 },
            });
            const notBefore = Date.parse(String(again?.params.notBefore));
            expect(notBefore).toBe(clock.getTime() + HOUR);
            expect(again?.expiresAt?.getTime()).toBe(notBefore + 7 * DAY);

            // Never red: no report, no alert, no job.failed for the test.
            expect(await reportsOf(id)).toEqual([]);
            expect(
              (await eventsOf(contoso)).filter((row) => row.details?.endpointId === id),
            ).toEqual(
              expect.not.arrayContaining([expect.objectContaining({ event: "verify.red" })]),
            );
            const sent = (
              await owner
                .select()
                .from(webhookDeliveries)
                .where(eq(webhookDeliveries.webhookId, hook?.id ?? ""))
            ).map(
              (delivery) => (delivery.payload as { data: { job: { id: string } } }).data.job.id,
            );
            expect(sent).toContain(backup?.id);
            expect(sent).not.toContain(test.runId);

            // Closed once: a later pass offers nothing more.
            await endpointMonitor(deps);
            expect(await testsOf(id)).toHaveLength(2);
          } finally {
            await owner.delete(webhooks).where(eq(webhooks.id, hook?.id ?? ""));
          }
        }, 60_000);

        it("offers it again only for the newest backup, while waits are left, and once", async () => {
          clock = new Date();
          // The waits are used up: the next backup brings a new test.
          const spent = await bareEndpoint({ lastSnapshotId: SNAPSHOT });
          await silentTest(spent, { retry: 6 });
          // A later wait doubles.
          const later = await bareEndpoint({ lastSnapshotId: SNAPSHOT });
          await silentTest(later, { retry: 2, notBefore: clock.toISOString() });
          // A newer backup came in since: the old one's rating would not count.
          const older = await bareEndpoint({ lastSnapshotId: "6f".repeat(32) });
          await silentTest(older);
          // A test of the same backup already waits.
          const waiting = await bareEndpoint({ lastSnapshotId: SNAPSHOT });
          await silentTest(waiting);
          await owner.insert(endpointTasks).values({
            tenantId: contoso,
            endpointId: waiting,
            kind: "verify_sample",
            status: "pending",
            params: { snapshotId: SNAPSHOT, files: FILES },
          });
          // A revoked machine runs no more tests.
          const revoked = await bareEndpoint({ lastSnapshotId: SNAPSHOT, status: "revoked" });
          await silentTest(revoked);

          await endpointMonitor(deps);
          const pending = async (id: string) =>
            (await testsOf(id)).filter((task) => task.status === "pending");
          expect(await pending(spent)).toEqual([]);
          const third = await pending(later);
          expect(third).toHaveLength(1);
          expect(third[0]?.params).toMatchObject({ retry: 3 });
          expect(Date.parse(String(third[0]?.params.notBefore))).toBe(clock.getTime() + 4 * HOUR);
          expect(await pending(older)).toEqual([]);
          expect(await pending(waiting)).toHaveLength(1);
          expect(await pending(revoked)).toEqual([]);
          for (const id of [spent, later, older, waiting, revoked]) {
            expect(await reportsOf(id)).toEqual([]);
          }
        }, 60_000);
      });

      it("raises restore-test and repository failures once, and news of recovery", async () => {
        clock = new Date();
        const id = await bareEndpoint();
        const red = await owner
          .insert(endpointReports)
          .values({
            tenantId: contoso,
            endpointId: id,
            kind: "restore_test",
            origin: "server",
            snapshotId: "a".repeat(64),
            readiness: "red",
            summary: {
              files: 3,
              matched: 2,
              mismatched: [{ path: "/x", expected: "e", actual: "a" }],
            },
            checkedAt: new Date(clock.getTime() - 3 * HOUR),
          })
          .returning();
        await owner.insert(endpointReports).values({
          tenantId: contoso,
          endpointId: id,
          kind: "repository_check",
          origin: "server",
          readiness: "red",
          summary: { errorMessage: "pack damaged" },
        });
        const first = await endpointMonitor(deps);
        expect(first.reportAlerts).toBe(2);
        const failed = (await eventsOf(contoso, "verify.red")).filter(
          (row) => row.details?.endpointId === id,
        );
        expect(failed).toHaveLength(1);
        expect(failed[0]?.message).toContain("1 of 3");
        expect(
          (await eventsOf(contoso, "scrub.corrupt")).filter(
            (row) => row.details?.endpointId === id,
          ),
        ).toHaveLength(1);
        expect((await endpointMonitor(deps)).reportAlerts).toBe(0);
        expect(red[0]?.id).toBeDefined();

        await owner.insert(endpointReports).values({
          tenantId: contoso,
          endpointId: id,
          kind: "restore_test",
          origin: "server",
          snapshotId: "b".repeat(64),
          readiness: "green",
          summary: { files: 3, matched: 3 },
        });
        expect((await endpointMonitor(deps)).reportAlerts).toBe(1);
        expect(
          (await eventsOf(contoso, "verify.recovered")).filter(
            (row) => row.details?.endpointId === id,
          ),
        ).toHaveLength(1);
      }, 60_000);

      it("does not call a first green test a recovery", async () => {
        clock = new Date();
        const id = await bareEndpoint();
        await owner.insert(endpointReports).values({
          tenantId: contoso,
          endpointId: id,
          kind: "restore_test",
          origin: "server",
          snapshotId: "c".repeat(64),
          readiness: "green",
          summary: {},
        });
        await endpointMonitor(deps);
        expect(
          (await eventsOf(contoso, "verify.recovered")).filter(
            (row) => row.details?.endpointId === id,
          ),
        ).toHaveLength(0);
      }, 60_000);

      it("alerts once about a server that stopped reporting, and again after it came back and left", async () => {
        clock = new Date();
        const id = await bareEndpoint({ lastSeenAt: new Date(clock.getTime() - 3 * HOUR) });
        const ofEndpoint = async () =>
          (await eventsOf(contoso, "endpoint.stale")).filter(
            (row) => row.details?.endpointId === id,
          );
        expect((await endpointMonitor(deps)).staleAlerts).toBeGreaterThanOrEqual(1);
        const raised = await ofEndpoint();
        expect(raised).toHaveLength(1);
        expect(raised[0]).toMatchObject({ level: "warning" });
        expect(raised[0]?.message).toContain("Fileserver");
        expect(raised[0]?.details).toMatchObject({ reason: "silent", profile: "server" });
        expect((await endpointOf(id))?.staleAlertedAt).toBeInstanceOf(Date);

        await endpointMonitor(deps);
        expect(await ofEndpoint()).toHaveLength(1);

        // The API clears the mark when the server reports again; a second silence alerts again.
        await owner
          .update(endpoints)
          .set({ staleAlertedAt: null, lastSeenAt: new Date(clock.getTime() - 4 * HOUR) })
          .where(eq(endpoints.id, id));
        await endpointMonitor(deps);
        expect(await ofEndpoint()).toHaveLength(2);
      }, 60_000);

      it("uses the limit set on the endpoint", async () => {
        clock = new Date();
        const id = await bareEndpoint({
          lastSeenAt: new Date(clock.getTime() - 3 * HOUR),
          settings: { staleAfterHours: 12 },
        });
        await endpointMonitor(deps);
        expect(
          (await eventsOf(contoso, "endpoint.stale")).filter(
            (row) => row.details?.endpointId === id,
          ),
        ).toHaveLength(0);
      }, 60_000);

      it("watches a client's backups, not its contact, and stays quiet about revoked endpoints", async () => {
        clock = new Date();
        const laptopOff = await bareEndpoint({
          profile: "client",
          lastSeenAt: new Date(clock.getTime() - 30 * DAY),
          lastSuccessAt: new Date(clock.getTime() - 2 * DAY),
          createdAt: new Date(clock.getTime() - 60 * DAY),
        });
        const laptopNoBackup = await bareEndpoint({
          profile: "client",
          lastSeenAt: new Date(clock.getTime() - 5 * 60 * 1000),
          lastSuccessAt: new Date(clock.getTime() - 9 * DAY),
          createdAt: new Date(clock.getTime() - 60 * DAY),
        });
        const revoked = await bareEndpoint({
          status: "revoked",
          lastSeenAt: new Date(clock.getTime() - 10 * DAY),
        });
        await endpointMonitor(deps);
        const about = async (id: string) =>
          (await eventsOf(contoso, "endpoint.stale")).filter(
            (row) => row.details?.endpointId === id,
          );
        expect(await about(laptopOff)).toHaveLength(0);
        expect(await about(revoked)).toHaveLength(0);
        const overdue = await about(laptopNoBackup);
        expect(overdue).toHaveLength(1);
        expect(overdue[0]?.details).toMatchObject({ reason: "backup_overdue", profile: "client" });
      }, 60_000);

      it("keeps each tenant's alerts to itself", async () => {
        clock = new Date();
        const id = await bareEndpoint(
          { lastSeenAt: new Date(clock.getTime() - 5 * HOUR) },
          fabrikam,
        );
        await endpointMonitor(deps);
        expect(
          (await eventsOf(fabrikam, "endpoint.stale")).filter(
            (row) => row.details?.endpointId === id,
          ),
        ).toHaveLength(1);
        expect(
          (await eventsOf(contoso, "endpoint.stale")).filter(
            (row) => row.details?.endpointId === id,
          ),
        ).toHaveLength(0);
      }, 60_000);

      it("lets a task nobody picked up expire", async () => {
        clock = new Date();
        const id = await bareEndpoint();
        const [task] = await owner
          .insert(endpointTasks)
          .values({
            tenantId: contoso,
            endpointId: id,
            kind: "restore",
            params: {},
            expiresAt: new Date(clock.getTime() - HOUR),
          })
          .returning();
        const summary = await endpointMonitor(deps);
        expect(summary.expiredTasks).toBeGreaterThanOrEqual(1);
        const [after] = await owner
          .select()
          .from(endpointTasks)
          .where(eq(endpointTasks.id, task?.id ?? ""));
        expect(after).toMatchObject({ status: "failed", errorMessage: "expired" });
      }, 60_000);

      it("warns when a repository nears its storage budget and says so again when it is used up", async () => {
        clock = new Date();
        const id = await bareEndpoint({
          repositoryBytes: 95 * GIB,
          settings: { quotaGib: 100 },
        });
        const quotaAlerts = async () =>
          (await eventsOf(contoso, "endpoint.storage_quota")).filter(
            (row) => row.details?.endpointId === id,
          );
        await endpointMonitor(deps);
        expect(await quotaAlerts()).toHaveLength(1);
        expect((await quotaAlerts())[0]).toMatchObject({ level: "warning" });
        expect((await quotaAlerts())[0]?.details).toMatchObject({
          level: "near",
          scope: "endpoint",
        });
        expect((await quotaAlerts())[0]?.message).toContain("95.0 GiB of 100.0 GiB (95 %)");
        await endpointMonitor(deps);
        expect(await quotaAlerts()).toHaveLength(1);

        await owner
          .update(endpoints)
          .set({ repositoryBytes: 100 * GIB })
          .where(eq(endpoints.id, id));
        await endpointMonitor(deps);
        expect(await quotaAlerts()).toHaveLength(2);
        expect((await quotaAlerts())[1]).toMatchObject({ level: "error" });
        expect((await endpointOf(id))?.quotaAlertLevel).toBe("exceeded");

        // Retention freed space: the warning is re-armed, and a refused upload is news again.
        await owner
          .update(endpoints)
          .set({ repositoryBytes: 10 * GIB })
          .where(eq(endpoints.id, id));
        await endpointMonitor(deps);
        expect((await endpointOf(id))?.quotaAlertLevel).toBeNull();
        await owner.update(endpoints).set({ quotaRefusedAt: clock }).where(eq(endpoints.id, id));
        await endpointMonitor(deps);
        expect(await quotaAlerts()).toHaveLength(3);
        expect((await quotaAlerts())[2]?.details).toMatchObject({
          level: "exceeded",
          scope: "tenant",
        });
      }, 60_000);

      it("tells a tenant once a day when its machines together near the tenant's budget", async () => {
        clock = new Date();
        const previous = process.env.RESTOW_ENDPOINT_TENANT_QUOTA_GIB;
        process.env.RESTOW_ENDPOINT_TENANT_QUOTA_GIB = "1000";
        try {
          await bareEndpoint(
            { repositoryBytes: 600 * GIB, settings: { quotaGib: 5000 } },
            fabrikam,
          );
          await bareEndpoint(
            { repositoryBytes: 350 * GIB, settings: { quotaGib: 5000 } },
            fabrikam,
          );
          const tenantAlerts = async () =>
            (await eventsOf(fabrikam, "endpoint.storage_quota")).filter(
              (row) => row.details?.scope === "tenant_total",
            );
          await endpointMonitor(deps);
          expect(await tenantAlerts()).toHaveLength(1);
          expect((await tenantAlerts())[0]?.details).toMatchObject({
            level: "near",
            tenantBudgetBytes: 1000 * GIB,
            objectName: "Fabrikam",
          });
          await endpointMonitor(deps);
          expect(await tenantAlerts()).toHaveLength(1);
        } finally {
          if (previous === undefined) {
            Reflect.deleteProperty(process.env, "RESTOW_ENDPOINT_TENANT_QUOTA_GIB");
          } else {
            process.env.RESTOW_ENDPOINT_TENANT_QUOTA_GIB = previous;
          }
        }
      }, 60_000);

      it("removes prepared downloads an hour after they expired, started or not", async () => {
        clock = new Date();
        const id = await bareEndpoint();
        const row = (expiresAt: Date, startedAt: Date | null = null) => ({
          tenantId: contoso,
          endpointId: id,
          snapshotId: "a".repeat(64),
          selection: [{ path: "/etc", type: "dir" as const }],
          expiresAt,
          startedAt,
        });
        const inserted = await owner
          .insert(endpointDownloads)
          .values([
            row(new Date(clock.getTime() - 3 * HOUR)),
            row(new Date(clock.getTime() - 2 * HOUR), new Date(clock.getTime() - 2 * HOUR)),
            row(new Date(clock.getTime() - 10 * 60 * 1000)),
            row(new Date(clock.getTime() + 5 * 60 * 1000)),
          ])
          .returning({ id: endpointDownloads.id });
        const [staleUnused, staleStarted, recentlyExpired, open] = inserted.map(
          (entry) => entry.id,
        );
        const summary = await endpointMonitor(deps);
        expect(summary.purgedDownloads).toBeGreaterThanOrEqual(2);
        const left = (
          await owner
            .select({ id: endpointDownloads.id })
            .from(endpointDownloads)
            .where(eq(endpointDownloads.endpointId, id))
        ).map((entry) => entry.id);
        expect(left.sort()).toEqual([recentlyExpired, open].sort());
        expect(left).not.toContain(staleUnused);
        expect(left).not.toContain(staleStarted);
      }, 60_000);
    });

    it("binds the application role to the tenant it works for", async () => {
      const made = await makeEndpoint({ snapshots: 0, tenantId: contoso });
      const seenByFabrikam = await withTenantTx(appDb, fabrikam, (tx) =>
        tx.select({ id: endpoints.id }).from(endpoints).where(eq(endpoints.id, made.id)),
      );
      expect(seenByFabrikam).toEqual([]);
      const seenByContoso = await withTenantTx(appDb, contoso, (tx) =>
        tx.select({ id: endpoints.id }).from(endpoints).where(eq(endpoints.id, made.id)),
      );
      expect(seenByContoso).toHaveLength(1);
    }, 60_000);
  },
);
