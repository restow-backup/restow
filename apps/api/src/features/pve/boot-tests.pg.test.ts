/**
 * Boot tests of Proxmox VE restore points (docs/PVE.md, "Boot test") against Postgres, driven
 * through /agent/pve/v1 the way restow-pve drives them (docs/PVE-PROTOCOL.md):
 *
 *   - a node that announced no capabilities (an older restow-pve) gets no boot test, and one
 *     queued for it fails instead of being delivered,
 *   - "Boot test now" queues one task and one run per restore point, with the job's limits,
 *   - the heartbeat holds a boot test back while a backup runs on the node, and hands out one
 *     at a time,
 *   - the node's result: green (guest agent answered), yellow, red rate the restore point and
 *     readiness; skipped and a failed task rate nothing.
 *
 * No PVE node: the heartbeats and task results are what restow-pve sends.
 */
import { randomUUID } from "node:crypto";
import { pveGuests, pveRuns, pveSnapshots, pveTasks } from "@restow/db";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  basic,
  type EndpointFixture,
  startFixture,
  testDatabaseAdminUrl,
} from "../endpoints/testing/fixture.js";

const DATABASE = "restow_api_pve_boot_test";
const canRun = Boolean(testDatabaseAdminUrl);

type Shared = typeof import("../../db.js");
type Service = typeof import("./service.js");
type BootTests = typeof import("./boot-tests.js");
type Protection = typeof import("./protection.js");
type TenantContext = typeof import("../../lib/tenant-context.js");

interface Node {
  nodeId: string;
  nodeSecret: string;
  clusterId: string;
}

interface Task {
  id: string;
  kind: string;
  params: Record<string, unknown>;
}

describe.skipIf(!canRun)("boot tests of Proxmox VE restore points", () => {
  let fixture: EndpointFixture;
  let shared: Shared;
  let service: Service;
  let bootTests: BootTests;
  let protection: Protection;
  let tenantContext: TenantContext;
  let app: Hono;
  let node: Node;
  let guestId: string;
  const pointIds: string[] = [];
  const actor = () => ({
    label: "admin@contoso.example",
    userId: fixture.adminId,
    ip: "192.0.2.1",
  });

  beforeAll(async () => {
    fixture = await startFixture(DATABASE);
    shared = await import("../../db.js");
    service = await import("./service.js");
    bootTests = await import("./boot-tests.js");
    protection = await import("./protection.js");
    tenantContext = await import("../../lib/tenant-context.js");
    const { pveNodeRoutes } = await import("./node-routes.js");
    const { errorHandler } = await import("../../problem.js");
    app = new Hono();
    app.onError(errorHandler);
    app.route("/agent/pve/v1", pveNodeRoutes);

    const { token } = await service.createEnrollmentToken(shared.db, fixture.tenantId, actor(), {
      url: "https://restow.test.example",
    });
    const enrolled = await app.request("/agent/pve/v1/enroll", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "192.0.2.77" },
      body: JSON.stringify({
        token,
        clusterName: "lab",
        clusterFingerprint: "b".repeat(64),
        nodeName: "pve1",
        pveVersion: "9.2.1",
        helperVersion: "0.4.0",
        fleecingStorage: "local-lvm",
      }),
    });
    expect(enrolled.status).toBe(201);
    node = (await enrolled.json()) as Node;
    await tenantContext.withTenantTx(shared.db, fixture.tenantId, async (tx) => {
      const [guest] = await tx
        .insert(pveGuests)
        .values({
          tenantId: fixture.tenantId,
          clusterId: node.clusterId,
          vmid: 101,
          kind: "vm",
          name: "web01",
          node: "pve1",
          agent: true,
        })
        .returning();
      guestId = guest?.id ?? "";
      // Two restore points, the newer one last (relative to the moment the test runs).
      for (const [sequence, hoursAgo] of [
        [1, 48],
        [2, 2],
      ] as const) {
        const backupAt = new Date(Date.now() - hoursAgo * 3600_000);
        const [point] = await tx
          .insert(pveSnapshots)
          .values({
            tenantId: fixture.tenantId,
            clusterId: node.clusterId,
            guestId,
            sequence,
            kind: "vm",
            archiveName: `vm/101/${backupAt.toISOString().replace(/\.\d+Z$/, "Z")}`,
            storageId: "restow",
            manifestPath: `pve/manifests/${randomUUID()}`,
            guestConfig: "memory: 2048\nscsi0: local-lvm:vm-101-disk-0,size=32G\n",
            disks: [
              {
                device: "drive-scsi0",
                size: 32 * 2 ** 30,
                map: { chunks: [], size: 0, sha256: "" },
                hashesDigest: "",
                changedBlocks: 0,
                zeroBlocks: 0,
                dataBlocks: 256,
                bitmapMode: "new",
              },
            ],
            byteSize: 32 * 2 ** 30,
            backupAt,
          })
          .returning();
        pointIds.push(point?.id ?? "");
      }
      await tx
        .update(pveGuests)
        .set({ lastSnapshotId: pointIds[1], lastSuccessAt: new Date() })
        .where(eq(pveGuests.id, guestId));
    });
  }, 90_000);

  afterAll(async () => {
    await fixture?.cleanup();
  });

  function call(path: string, json?: unknown) {
    return app.request(`/agent/pve/v1${path}`, {
      method: json === undefined ? "GET" : "POST",
      headers: {
        ...basic(node.nodeId, node.nodeSecret),
        ...(json === undefined ? {} : { "content-type": "application/json" }),
      },
      body: json === undefined ? undefined : JSON.stringify(json),
    });
  }

  async function heartbeat(extra: Record<string, unknown> = {}): Promise<Task[]> {
    const response = await call("/heartbeat", {
      helperVersion: "0.4.0",
      pveVersion: "9.2.1",
      fleecingStorage: "local-lvm",
      pluginLoaded: true,
      state: "idle",
      problems: [],
      restoresAllowed: true,
      activeRuns: [],
      ...extra,
    });
    expect(response.status).toBe(200);
    return ((await response.json()) as { tasks: Task[] }).tasks;
  }

  const newest = () => pointIds[1] as string;
  const older = () => pointIds[0] as string;

  async function rows<T>(
    fn: (tx: Parameters<Parameters<TenantContext["withTenantTx"]>[2]>[0]) => Promise<T>,
  ) {
    return tenantContext.withTenantTx(shared.db, fixture.tenantId, fn);
  }

  async function readinessRow() {
    const loaded = await rows((tx) =>
      protection.loadGuestProtection(tx, fixture.tenantId, new Date()),
    );
    return loaded.rows.find((row) => row.id === guestId);
  }

  it("offers no boot test while the node announced none (an older restow-pve)", async () => {
    // An older helper sends no capabilities at all.
    const tasks = await heartbeat({ activeRuns: undefined });
    expect(tasks).toEqual([]);
    await expect(
      bootTests.requestBootTest(shared.db, fixture.tenantId, newest(), actor()),
    ).rejects.toMatchObject({ status: 409, extensions: { reason: "node_unsupported" } });
    const detail = await service.guestDetail(shared.db, fixture.tenantId, guestId);
    expect(detail.bootTest).toMatchObject({ blocker: "node_unsupported", schedule: "off" });
  });

  it("queues one boot test per restore point once the node announced it, with the job's limits", async () => {
    await heartbeat({ capabilities: ["boot_test"] });
    const overview = await service.overview(shared.db, fixture.tenantId);
    expect(overview.clusters[0]?.nodes[0]?.capabilities).toEqual(["boot_test"]);
    // The guest's job asks for weekly boot tests with 4 GiB at most.
    const job = await service.saveJob(
      shared.db,
      fixture.tenantId,
      null,
      {
        name: "Nightly",
        scopeAll: true,
        schedule: null,
        enabled: true,
        settings: { bootTest: { schedule: "weekly", maxMemoryMiB: 4096 } },
      },
      actor(),
    );
    expect(job.settings.bootTest).toEqual({ schedule: "weekly", maxMemoryMiB: 4096 });
    const first = await bootTests.requestBootTest(shared.db, fixture.tenantId, newest(), actor());
    expect(first.alreadyQueued).toBe(false);
    const again = await bootTests.requestBootTest(shared.db, fixture.tenantId, newest(), actor());
    expect(again).toEqual({ taskId: first.taskId, alreadyQueued: true });
    const [task] = await rows((tx) =>
      tx.select().from(pveTasks).where(eq(pveTasks.id, first.taskId)),
    );
    expect(task?.kind).toBe("boot_test");
    expect(task?.params).toMatchObject({
      kind: "vm",
      vmid: 101,
      maxMemoryMiB: 4096,
      timeoutSeconds: 300,
      dataBytes: 256 * 4 * 2 ** 20,
      diskBytes: 32 * 2 ** 30,
      snapshotId: newest(),
    });
    const detail = await service.guestDetail(shared.db, fixture.tenantId, guestId);
    expect(detail.bootTest).toMatchObject({ blocker: null, schedule: "weekly" });
    expect(detail.bootTest.lastBootTestAt).not.toBeNull();
    expect(detail.runs.find((run) => run.kind === "boot_test")?.status).toBe("running");
  });

  it("holds a boot test back while a backup runs on the node, and hands out one at a time", async () => {
    // A second boot test, of the older restore point, waits behind the first.
    await bootTests.requestBootTest(shared.db, fixture.tenantId, older(), actor());
    const busy = await heartbeat({ capabilities: ["boot_test"], activeRuns: [randomUUID()] });
    expect(busy.filter((t) => t.kind === "boot_test")).toEqual([]);
    const tasks = await heartbeat({ capabilities: ["boot_test"] });
    const boot = tasks.filter((t) => t.kind === "boot_test");
    expect(boot).toHaveLength(1);
    expect(boot[0]?.params.snapshotId).toBe(newest());
  });

  async function report(taskId: string, body: unknown, status = 204) {
    const response = await call(`/tasks/${taskId}/result`, body);
    expect(response.status, await response.clone().text()).toBe(status);
  }

  async function openBootTask(snapshotId: string): Promise<string> {
    const [task] = await rows((tx) =>
      tx
        .select()
        .from(pveTasks)
        .where(and(eq(pveTasks.kind, "boot_test"), eq(pveTasks.guestId, guestId))),
    ).then((list) =>
      list.filter(
        (t) =>
          (t.status === "pending" || t.status === "delivered") &&
          t.params.snapshotId === snapshotId,
      ),
    );
    if (task) {
      return task.id;
    }
    return (await bootTests.requestBootTest(shared.db, fixture.tenantId, snapshotId, actor()))
      .taskId;
  }

  const nodeResult = (outcome: string, extra: Record<string, unknown> = {}) => ({
    status: "done",
    result: {
      outcome,
      reason: outcome === "green" ? "agent_answered" : "no_guest_agent",
      message: `boot test ${outcome}`,
      durationMs: 95_000,
      bootSeconds: outcome === "green" ? 41.5 : null,
      guestAgent: outcome === "green",
      tempVmid: 9001,
      storage: "local-lvm",
      cleanedUp: true,
      log: "12:00:00 restoring\n12:01:00 started\n",
      ...extra,
    },
  });

  it("green: the guest agent answered; the restore point and readiness are green by the boot test", async () => {
    const taskId = await openBootTask(newest());
    await report(taskId, nodeResult("green"));
    const [run] = await rows((tx) => tx.select().from(pveRuns).where(eq(pveRuns.taskId, taskId)));
    expect(run).toMatchObject({ kind: "boot_test", status: "succeeded", errorMessage: null });
    expect(run?.logTail).toContain("started");
    expect(run?.stats.bootTest).toMatchObject({
      outcome: "green",
      guestAgent: true,
      tempVmid: 9001,
    });
    const [point] = await rows((tx) =>
      tx.select().from(pveSnapshots).where(eq(pveSnapshots.id, newest())),
    );
    expect(point?.bootTest).toMatchObject({ outcome: "green", reason: "agent_answered" });
    const row = await readinessRow();
    expect(row).toMatchObject({ state: "green", readiness: "green", basis: "boot_test" });
    expect(row?.bootTest).toMatchObject({ outcome: "green" });
    const detail = await service.guestDetail(shared.db, fixture.tenantId, guestId);
    expect(detail.snapshots.find((s) => s.id === newest())?.bootTest?.outcome).toBe("green");
  });

  it("yellow: started without an answer; red: did not boot; a red read-back stays red", async () => {
    let taskId = await openBootTask(newest());
    await report(taskId, nodeResult("yellow"));
    expect(await readinessRow()).toMatchObject({ state: "yellow", readiness: "yellow" });
    taskId = await openBootTask(newest());
    await report(taskId, nodeResult("red", { reason: "guest_stopped" }));
    expect(await readinessRow()).toMatchObject({ state: "red", basis: "boot_test" });
    const [run] = await rows((tx) => tx.select().from(pveRuns).where(eq(pveRuns.taskId, taskId)));
    // The test itself ran; the rating says the restore point failed it.
    expect(run?.status).toBe("succeeded");
    expect(run?.errorMessage).toBe("boot test red");
  });

  it("skipped, or a node that could not carry it out: the run says so, the rating stays", async () => {
    let taskId = await openBootTask(newest());
    await report(taskId, {
      status: "done",
      result: { outcome: "skipped", reason: "node_memory", message: "not enough memory" },
    });
    let [run] = await rows((tx) => tx.select().from(pveRuns).where(eq(pveRuns.taskId, taskId)));
    expect(run).toMatchObject({ status: "failed", errorMessage: "not enough memory" });
    expect(run?.stats.bootTest).toMatchObject({ outcome: "skipped", reason: "node_memory" });
    expect((await readinessRow())?.bootTest?.outcome).toBe("red");

    taskId = await openBootTask(newest());
    await report(taskId, { status: "failed", error: "PVE API answered 500" });
    [run] = await rows((tx) => tx.select().from(pveRuns).where(eq(pveRuns.taskId, taskId)));
    expect(run?.status).toBe("failed");
    expect(run?.stats.bootTest).toMatchObject({ outcome: "error", reason: "node_error" });
    expect((await readinessRow())?.bootTest?.outcome).toBe("red");
  });

  it("rates by what the reason stands for: no green without proof, an unknown reason keeps its message", async () => {
    const stored = async (taskId: string) => {
      const [run] = await rows((tx) => tx.select().from(pveRuns).where(eq(pveRuns.taskId, taskId)));
      return run;
    };
    const pointTest = async () =>
      (await rows((tx) => tx.select().from(pveSnapshots).where(eq(pveSnapshots.id, newest()))))[0]
        ?.bootTest;
    // A green whose init runs but whose services were not checked: amber, rated.
    let taskId = await openBootTask(newest());
    await report(taskId, nodeResult("green", { reason: "init_running_unverified" }));
    expect((await stored(taskId))?.stats.bootTest).toMatchObject({
      outcome: "yellow",
      reason: "init_running_unverified",
    });
    expect(await pointTest()).toMatchObject({ outcome: "yellow" });
    expect(await readinessRow()).toMatchObject({ state: "yellow" });
    // A panicked guest is red, also when the node said amber.
    taskId = await openBootTask(newest());
    await report(taskId, nodeResult("yellow", { reason: "guest_panicked" }));
    expect(await pointTest()).toMatchObject({ outcome: "red", reason: "guest_panicked" });
    // Not booted for a reason outside the restore point: skipped, the rating stays red.
    for (const reason of [
      "custom_qemu_args",
      "host_disk",
      "bridge_not_isolated",
      "node_resources",
    ]) {
      taskId = await openBootTask(newest());
      await report(taskId, nodeResult("green", { reason, message: `not booted: ${reason}` }));
      expect(await stored(taskId)).toMatchObject({
        status: "failed",
        errorMessage: `not booted: ${reason}`,
      });
      expect((await stored(taskId))?.stats.bootTest).toMatchObject({ outcome: "skipped", reason });
      expect(await pointTest()).toMatchObject({ outcome: "red", reason: "guest_panicked" });
    }
    // restow-pve 0.5.0 reports a test it could not prepare as error with its own reason.
    taskId = await openBootTask(newest());
    await report(taskId, {
      status: "done",
      result: { outcome: "error", reason: "setup_failed", message: "mp1 has no size" },
    });
    expect(await stored(taskId)).toMatchObject({
      status: "failed",
      errorMessage: "mp1 has no size",
    });
    expect((await stored(taskId))?.stats.bootTest).toMatchObject({
      outcome: "error",
      reason: "setup_failed",
    });
    expect(await pointTest()).toMatchObject({ outcome: "red", reason: "guest_panicked" });
    // A reason this server does not know: the node's outcome and message.
    taskId = await openBootTask(newest());
    await report(taskId, nodeResult("yellow", { reason: "a_newer_reason", message: "said so" }));
    expect((await stored(taskId))?.stats.bootTest).toMatchObject({
      outcome: "yellow",
      reason: "a_newer_reason",
      message: "said so",
    });
    // Leave the restore point red, as the tests after this one expect it.
    taskId = await openBootTask(newest());
    await report(taskId, nodeResult("red", { reason: "guest_stopped" }));
  });

  it("keeps a temporary guest the node could not remove, also when the test failed, until the inventory no longer lists it", async () => {
    // The isolation failed after the restore (outcome ""), and the temporary VM could not be
    // destroyed: the node sends its VMID and cleanedUp false with the failed task.
    const taskId = await openBootTask(newest());
    await report(taskId, {
      status: "failed",
      error: "isolating the temporary guest: PVE API answered 500",
      result: {
        outcome: "",
        reason: "",
        message: "",
        durationMs: 12_000,
        bootSeconds: null,
        guestAgent: false,
        tempVmid: 9007,
        storage: "local-zfs",
        cleanedUp: false,
        log: "12:00:00 restoring\n12:00:10 the temporary guest 9007 is still there\n",
      },
    });
    const [run] = await rows((tx) => tx.select().from(pveRuns).where(eq(pveRuns.taskId, taskId)));
    expect(run?.status).toBe("failed");
    expect(run?.stats.bootTest).toMatchObject({
      outcome: "error",
      tempVmid: 9007,
      storage: "local-zfs",
      cleanedUp: false,
    });
    expect(run?.errorMessage).toBe(
      "isolating the temporary guest: PVE API answered 500 The temporary guest 9007 on local-zfs could not be removed.",
    );
    // The node's log is kept, not dropped with the outcome.
    expect(run?.logTail).toContain("9007 is still there");
    // The rating of the restore point is not touched by a test that did not run to an end.
    expect((await readinessRow())?.bootTest?.outcome).toBe("red");
    const leftover = { vmid: 9007, storage: "local-zfs", node: "pve1", runId: run?.id };
    let overview = await service.overview(shared.db, fixture.tenantId);
    let guest = overview.guests.find((g) => g.id === guestId);
    expect(guest?.attention).toContain("boot_test_leftover");
    expect(guest?.bootTestLeftover).toMatchObject(leftover);
    const detail = await service.guestDetail(shared.db, fixture.tenantId, guestId);
    expect(detail.guest.bootTestLeftover).toMatchObject(leftover);

    // An inventory right after the run may have been taken before it: it proves nothing.
    let inventory = await call("/inventory", {
      guests: [{ vmid: 101, kind: "vm", name: "web01", node: "pve1", agent: true }],
    });
    expect(inventory.status).toBe(200);
    overview = await service.overview(shared.db, fixture.tenantId);
    expect(overview.guests.find((g) => g.id === guestId)?.attention).toContain(
      "boot_test_leftover",
    );
    // Later, still listed (restow-boottest-101 in restow-restore): still there.
    await rows((tx) =>
      tx
        .update(pveRuns)
        .set({ finishedAt: new Date(Date.now() - 10 * 60_000) })
        .where(eq(pveRuns.taskId, taskId)),
    );
    inventory = await call("/inventory", {
      guests: [
        { vmid: 101, kind: "vm", name: "web01", node: "pve1", agent: true },
        {
          vmid: 9007,
          kind: "vm",
          name: "restow-boottest-101",
          node: "pve1",
          pool: "restow-restore",
          tags: ["restow-boottest"],
        },
      ],
    });
    expect(inventory.status).toBe(200);
    overview = await service.overview(shared.db, fixture.tenantId);
    expect(overview.guests.find((g) => g.id === guestId)?.bootTestLeftover).toMatchObject(leftover);
    // The node removed it (its service started): the next inventory leaves it out.
    inventory = await call("/inventory", {
      guests: [{ vmid: 101, kind: "vm", name: "web01", node: "pve1", agent: true }],
    });
    expect(inventory.status).toBe(200);
    overview = await service.overview(shared.db, fixture.tenantId);
    guest = overview.guests.find((g) => g.id === guestId);
    expect(guest?.attention).not.toContain("boot_test_leftover");
    expect(guest?.bootTestLeftover).toBeNull();
    const [after] = await rows((tx) => tx.select().from(pveRuns).where(eq(pveRuns.taskId, taskId)));
    expect(
      (after?.stats.bootTest as { leftoverGoneAt?: string } | undefined)?.leftoverGoneAt,
    ).toBeTruthy();
  });

  it("a rated test whose temporary guest stayed: the rating stands, the leftover is named", async () => {
    const taskId = await openBootTask(newest());
    await report(taskId, nodeResult("green", { tempVmid: 9008, cleanedUp: false }));
    const [run] = await rows((tx) => tx.select().from(pveRuns).where(eq(pveRuns.taskId, taskId)));
    expect(run?.status).toBe("succeeded");
    expect(run?.errorMessage).toBe(
      "boot test green The temporary guest 9008 on local-lvm could not be removed.",
    );
    const [point] = await rows((tx) =>
      tx.select().from(pveSnapshots).where(eq(pveSnapshots.id, newest())),
    );
    expect(point?.bootTest).toMatchObject({ outcome: "green", tempVmid: 9008, cleanedUp: false });
    const overview = await service.overview(shared.db, fixture.tenantId);
    expect(overview.guests.find((g) => g.id === guestId)?.bootTestLeftover?.vmid).toBe(9008);
    // A later test on the node that removed a guest of that VMID ends it as well.
    const next = await openBootTask(newest());
    await report(next, nodeResult("green", { tempVmid: 9008, cleanedUp: true }));
    const again = await service.overview(shared.db, fixture.tenantId);
    expect(again.guests.find((g) => g.id === guestId)?.bootTestLeftover).toBeNull();
  });

  it("fails a queued boot test once the node stops announcing them", async () => {
    const taskId = await openBootTask(older());
    const tasks = await heartbeat({ capabilities: [] });
    expect(tasks.some((t) => t.id === taskId)).toBe(false);
    const [task] = await rows((tx) => tx.select().from(pveTasks).where(eq(pveTasks.id, taskId)));
    expect(task?.status).toBe("failed");
    const [run] = await rows((tx) => tx.select().from(pveRuns).where(eq(pveRuns.taskId, taskId)));
    expect(run?.status).toBe("failed");
    expect(run?.stats.bootTest).toMatchObject({ outcome: "error" });
    // The guest's last backup is not touched by a boot test.
    const [guest] = await rows((tx) =>
      tx.select().from(pveGuests).where(eq(pveGuests.id, guestId)),
    );
    expect(guest?.lastBackupAt).toBeNull();
  });
});
