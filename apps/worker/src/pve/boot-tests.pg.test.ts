/**
 * Boot tests of Proxmox VE restore points in the worker (docs/PVE.md, "Boot test") against
 * Postgres: the jobs' schedules become boot_test tasks only for nodes that announced the
 * capability, one per node at a time and never beside a backup on the node; after every backup
 * once per restore point, weekly a week after the last; a red or yellow result raises its event
 * once. The node's side is not involved: the results are written the way the API records them.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { EnvKeyProvider, noopLogger, type StorageTargets, type TenantKeyring } from "@restow/core";
import {
  createDb,
  type Database,
  deriveAuthLogin,
  notifications,
  pveClusters,
  pveGuests,
  pveJobs,
  pveNodes,
  pveRuns,
  pveSnapshots,
  pveTasks,
  type RoleLogin,
} from "@restow/db";
import { runMigrations } from "@restow/db/migrate";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadTenantKeyring, TenantCache } from "../handlers/framework.js";
import { dropTestDatabase } from "../testing/database.js";
import { alertBootTests, type PveDeps, planBootTests, pvePass } from "./maintenance.js";

const adminUrl = process.env.RESTOW_TEST_DATABASE_URL;
const TEST_DB = "restow_worker_pve_boot_test";
const DAY = 24 * 60 * 60 * 1000;

describe.skipIf(!adminUrl)("boot tests in the worker against Postgres", () => {
  let owner: Database;
  let appDb: Database;
  let providerDb: Database;
  let deps: PveDeps;
  let tenantId: string;
  let clusterId: string;
  let jobId: string;
  const nodeIds: Record<string, string> = {};
  const guestIds: Record<number, string> = {};
  // The worker's clock: a fixed instant, never compared with the real one.
  let clock = new Date(Date.UTC(2030, 4, 6, 12));
  const roleNames: string[] = [];

  beforeAll(async () => {
    const admin = createDb(adminUrl as string);
    await admin.$client.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await admin.$client.query(`CREATE DATABASE ${TEST_DB}`);
    await admin.$client.end();
    const url = new URL(adminUrl as string);
    url.pathname = `/${TEST_DB}`;
    const suffix = randomBytes(4).toString("hex");
    const tenantLogin: RoleLogin = { name: `restow_wb_app_${suffix}`, password: "a1".repeat(8) };
    const installationLogin: RoleLogin = {
      name: `restow_wb_inst_${suffix}`,
      password: "b2".repeat(8),
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
    deps = {
      db: appDb,
      providerDb,
      runtime: {
        keyrings: new TenantCache<TenantKeyring>((id) =>
          loadTenantKeyring({ db: appDb, tenantId: id, keyProvider: provideKeys }),
        ),
        storage: new TenantCache<StorageTargets>(async () => {
          throw new Error("boot tests need no storage");
        }),
        logger: noopLogger,
        now: () => clock,
        shutdownSignal: new AbortController().signal,
      },
    };
    const [cluster] = await owner
      .insert(pveClusters)
      .values({ tenantId, name: "lab", fingerprint: "d".repeat(64), storageId: "restow" })
      .returning();
    clusterId = cluster?.id ?? "";
    // pve1 announced boot tests, pve2 is an older helper, pve3 announced them but is busy.
    for (const [name, capabilities] of [
      ["pve1", ["boot_test"]],
      ["pve2", undefined],
      ["pve3", ["boot_test"]],
    ] as const) {
      const [node] = await owner
        .insert(pveNodes)
        .values({
          tenantId,
          clusterId,
          name,
          secretHash: "0".repeat(64),
          facts: capabilities ? { capabilities: [...capabilities] } : {},
          lastSeenAt: clock,
        })
        .returning();
      nodeIds[name] = node?.id ?? "";
    }
    const [job] = await owner
      .insert(pveJobs)
      .values({
        tenantId,
        name: "Nightly",
        scopeAll: true,
        settings: { bootTest: { schedule: "after_backup", maxMemoryMiB: 4096 } },
      })
      .returning();
    jobId = job?.id ?? "";
    for (const [vmid, node] of [
      [101, "pve1"],
      [102, "pve1"],
      [201, "pve2"],
      [301, "pve3"],
    ] as const) {
      const [guest] = await owner
        .insert(pveGuests)
        .values({ tenantId, clusterId, vmid, kind: "vm", node, name: `vm${vmid}` })
        .returning();
      guestIds[vmid] = guest?.id ?? "";
      await addPoint(vmid, 1, new Date(clock.getTime() - DAY));
    }
    // pve3 runs a backup right now.
    await owner.insert(pveRuns).values({
      tenantId,
      clusterId,
      nodeId: nodeIds.pve3,
      guestId: guestIds[301] as string,
      kind: "backup",
      status: "running",
      startedAt: clock,
    });
  }, 90_000);

  afterAll(async () => {
    await Promise.all([appDb?.$client.end(), providerDb?.$client.end(), owner?.$client.end()]);
    await dropTestDatabase(adminUrl as string, TEST_DB);
    const admin = createDb(adminUrl as string);
    for (const role of roleNames) {
      await admin.$client.query(`DROP ROLE IF EXISTS ${role}`);
    }
    await admin.$client.end();
  });

  async function addPoint(vmid: number, sequence: number, backupAt: Date): Promise<string> {
    const guestId = guestIds[vmid] as string;
    const [point] = await owner
      .insert(pveSnapshots)
      .values({
        tenantId,
        clusterId,
        guestId,
        sequence,
        kind: "vm",
        archiveName: `vm/${vmid}/${backupAt.toISOString().replace(/\.\d+Z$/, "Z")}`,
        storageId: "restow",
        manifestPath: `pve/manifests/${randomUUID()}`,
        disks: [
          {
            device: "drive-scsi0",
            size: 2 ** 30,
            map: { chunks: [], size: 0, sha256: "" },
            hashesDigest: "",
            changedBlocks: 0,
            zeroBlocks: 0,
            dataBlocks: 10,
            bitmapMode: "new",
          },
        ],
        backupAt,
      })
      .returning();
    await owner
      .update(pveGuests)
      .set({ lastSnapshotId: point?.id ?? null })
      .where(eq(pveGuests.id, guestId));
    return point?.id ?? "";
  }

  /** The worker's clock moves on; the nodes keep sending heartbeats. */
  async function advance(ms: number) {
    clock = new Date(clock.getTime() + ms);
    await owner.update(pveNodes).set({ lastSeenAt: clock });
  }

  const openBootTasks = () =>
    owner
      .select()
      .from(pveTasks)
      .where(
        and(eq(pveTasks.kind, "boot_test"), inArray(pveTasks.status, ["pending", "delivered"])),
      );

  /** End every open boot test as the API records a node's result. */
  async function finishAll(outcome: string) {
    for (const task of await openBootTasks()) {
      await owner
        .update(pveTasks)
        .set({ status: "done", finishedAt: clock })
        .where(eq(pveTasks.id, task.id));
      const result = {
        outcome,
        reason: outcome === "red" ? "guest_stopped" : "no_guest_agent",
        message: `the test was ${outcome}`,
        checkedAt: clock.toISOString(),
      };
      await owner
        .update(pveRuns)
        .set({ status: "succeeded", finishedAt: clock, stats: { bootTest: result } })
        .where(eq(pveRuns.taskId, task.id));
      await owner
        .update(pveSnapshots)
        .set({
          bootTest: {
            ...result,
            durationMs: 1,
            bootSeconds: null,
            guestAgent: false,
            tempVmid: 9001,
            storage: "local-lvm",
            cleanedUp: true,
            runId: "",
          } as never,
        })
        .where(eq(pveSnapshots.id, task.params.snapshotId as string));
    }
  }

  it("plans one boot test per capable node, never on an older node or beside a backup", async () => {
    // Not while new starts are paused for an update.
    const paused = await pvePass({ ...deps, startsPaused: () => true });
    expect(paused.bootTests).toBe(0);
    expect(await openBootTasks()).toHaveLength(0);
    expect(await planBootTests(deps, clock)).toBe(1);
    const tasks = await openBootTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.nodeId).toBe(nodeIds.pve1);
    expect(tasks[0]?.params).toMatchObject({ maxMemoryMiB: 4096, kind: "vm", jobId });
    const [run] = await owner
      .select()
      .from(pveRuns)
      .where(eq(pveRuns.taskId, tasks[0]?.id ?? ""));
    expect(run).toMatchObject({ kind: "boot_test", status: "running" });
    // While pve1's test waits, nothing more for pve1.
    expect(await planBootTests(deps, clock)).toBe(0);
  });

  it("after every backup: the next guest, then nothing until a new restore point", async () => {
    await finishAll("green");
    expect(await planBootTests(deps, clock)).toBe(1);
    await finishAll("green");
    // Both restore points of pve1 have a boot test; the guests elsewhere get none.
    expect(await planBootTests(deps, clock)).toBe(0);
    await advance(DAY);
    await addPoint(101, 2, clock);
    expect(await planBootTests(deps, clock)).toBe(1);
    const [task] = await openBootTasks();
    expect(task?.guestId).toBe(guestIds[101]);
  });

  it("raises boot_test.failed and boot_test.unproven once per run", async () => {
    await finishAll("red");
    // Another guest's test without proof.
    await advance(60_000);
    await addPoint(102, 2, clock);
    expect(await planBootTests(deps, clock)).toBe(1);
    await finishAll("yellow");
    expect(await alertBootTests(deps, clock)).toBe(2);
    expect(await alertBootTests(deps, clock)).toBe(0);
    const raised = await owner
      .select()
      .from(notifications)
      .where(inArray(notifications.event, ["boot_test.failed", "boot_test.unproven"]));
    expect(raised.map((n) => [n.event, n.level, n.details?.pveGuestId]).sort()).toEqual(
      [
        ["boot_test.failed", "error", guestIds[101]],
        ["boot_test.unproven", "warning", guestIds[102]],
      ].sort(),
    );
  });

  it("weekly: a week after the last boot test", async () => {
    await owner
      .update(pveJobs)
      .set({ settings: { bootTest: { schedule: "weekly" } } })
      .where(eq(pveJobs.id, jobId));
    expect(await planBootTests(deps, clock)).toBe(0);
    await advance(7 * DAY);
    expect(await planBootTests(deps, clock)).toBe(1);
    await finishAll("green");
    expect(await planBootTests(deps, clock)).toBe(1);
    await finishAll("green");
    expect(await planBootTests(deps, clock)).toBe(0);
  });

  it("plans nothing for a node that was not seen lately, or with boot tests off in the job", async () => {
    clock = new Date(clock.getTime() + 8 * DAY);
    expect(await planBootTests(deps, clock)).toBe(0);
    await advance(0);
    await owner
      .update(pveJobs)
      .set({ settings: { bootTest: { schedule: "off" } } })
      .where(eq(pveJobs.id, jobId));
    expect(await planBootTests(deps, clock)).toBe(0);
  });
});
