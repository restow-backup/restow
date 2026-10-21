/**
 * Stopping Proxmox VE backups from the UI (0.4.2) against Postgres, driven through
 * /agent/pve/v1 the way restow-pve drives it:
 *
 *   - a queued backup is withdrawn before the node sees it (cancelled, with a run in History),
 *   - a delivered one goes to the node as a cancel order and opening its run is refused,
 *   - a running backup is "cancelling" until the node reports its end, then `cancelled`,
 *     never `failed`; the server refuses its uploads in the meantime,
 *   - a paused queue hands out no backup; "cancel all queued" per node and per tenant,
 *   - "update now" and the fleet phase of an update tell the node to update.
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditLog, pveGuests, pveNodes, pveRuns, pveTasks } from "@restow/db";
import { and, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  basic,
  type EndpointFixture,
  startFixture,
  testDatabaseAdminUrl,
} from "../endpoints/testing/fixture.js";

const DATABASE = "restow_api_pve_cancel_test";
const canRun = Boolean(testDatabaseAdminUrl);
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

interface Node {
  nodeId: string;
  nodeSecret: string;
  clusterId: string;
}

interface Heartbeat {
  tasks: { id: string; kind: string }[];
  cancel: { tasks: string[]; runs: { id: string; vmid: number; taskId: string | null }[] };
  queuePaused: boolean;
  update: { version: string; now: boolean } | null;
}

describe.skipIf(!canRun)("stopping Proxmox VE backups against Postgres", () => {
  let fixture: EndpointFixture;
  let shared: typeof import("../../db.js");
  let service: typeof import("./service.js");
  let cancel: typeof import("./cancel.js");
  let app: Hono;
  let node: Node;
  let vm: string;
  let ct: string;
  let dist = "";
  let previousDist: string | undefined;
  const actor = () => ({ label: "admin@contoso.example", userId: fixture.adminId, ip: null });

  beforeAll(async () => {
    fixture = await startFixture(DATABASE);
    // A signed release that carries restow-pve: the node is offered 9.0.0.
    previousDist = process.env.RESTOW_AGENT_DIR;
    dist = await mkdtemp(join(tmpdir(), "restow-pve-cancel-"));
    process.env.RESTOW_AGENT_DIR = dist;
    await mkdir(join(dist, "9.0.0", "linux-amd64"), { recursive: true });
    await writeFile(join(dist, "9.0.0", "linux-amd64", "restow-pve"), "pve 9.0.0");
    await writeFile(
      join(dist, "9.0.0", "SHA256SUMS"),
      `${sha256("pve 9.0.0")}  linux-amd64/restow-pve\n`,
    );
    await writeFile(join(dist, "9.0.0", "SHA256SUMS.sig"), "-----BEGIN SSH SIGNATURE-----\n");
    shared = await import("../../db.js");
    service = await import("./service.js");
    cancel = await import("./cancel.js");
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
      headers: { "content-type": "application/json", "x-forwarded-for": "192.0.2.50" },
      body: JSON.stringify({
        token,
        clusterName: "lab",
        clusterFingerprint: "e".repeat(64),
        nodeName: "pve1",
        pveVersion: "9.2.1",
        helperVersion: "0.4.1",
        fleecingStorage: "local-lvm",
      }),
    });
    expect(enrolled.status).toBe(201);
    node = (await enrolled.json()) as Node;
    const inventory = await call("/inventory", {
      guests: [
        { vmid: 101, kind: "vm", name: "web", node: "pve1", status: "running", disks: [] },
        { vmid: 200, kind: "ct", name: "db", node: "pve1", status: "running" },
      ],
    });
    expect(inventory.status).toBe(200);
    const guests = await fixture.db.select().from(pveGuests);
    vm = guests.find((g) => g.vmid === 101)?.id ?? "";
    ct = guests.find((g) => g.vmid === 200)?.id ?? "";
  }, 90_000);

  afterAll(async () => {
    if (previousDist === undefined) {
      Reflect.deleteProperty(process.env, "RESTOW_AGENT_DIR");
    } else {
      process.env.RESTOW_AGENT_DIR = previousDist;
    }
    if (dist) await rm(dist, { recursive: true, force: true });
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

  async function beat(extra: Record<string, unknown> = {}): Promise<Heartbeat> {
    const response = await call("/heartbeat", {
      helperVersion: "0.4.1",
      pveVersion: "9.2.1",
      fleecingStorage: "local-lvm",
      pluginLoaded: true,
      state: "idle",
      problems: [],
      restoresAllowed: true,
      activeRuns: [],
      ...extra,
    });
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json()) as Heartbeat;
  }

  const openRun = (time: string) =>
    call("/runs", {
      vmid: 101,
      kind: "vm",
      archiveName: `vm/101/${time}`,
      storageId: "restow",
      startedAt: time,
    });

  const runsOf = (guestId: string) =>
    fixture.db.select().from(pveRuns).where(eq(pveRuns.guestId, guestId));

  it("withdraws a queued backup before the node sees it, with a cancelled run in History", async () => {
    const queued = await service.backupNow(
      shared.db,
      fixture.tenantId,
      vm,
      { verifyRead: false },
      actor(),
    );
    const result = await cancel.cancelGuestBackup(shared.db, fixture.tenantId, vm, actor());
    expect(result).toEqual({ withdrawn: 1, stopping: 0 });
    const [task] = await fixture.db.select().from(pveTasks).where(eq(pveTasks.id, queued.taskId));
    expect(task).toMatchObject({ status: "cancelled", cancelledBy: "admin@contoso.example" });
    const runs = await runsOf(vm);
    expect(runs).toEqual([
      expect.objectContaining({
        status: "cancelled",
        taskId: queued.taskId,
        cancelledBy: "admin@contoso.example",
      }),
    ]);
    // The node never gets it; the guest's last backup is untouched.
    expect((await beat()).tasks).toEqual([]);
    const [guest] = await fixture.db.select().from(pveGuests).where(eq(pveGuests.id, vm));
    expect(guest?.lastBackupAt).toBeNull();
    const audits = await fixture.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "pve.backup.cancelled"));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ target: vm, actor: "admin@contoso.example" });
    // Nothing left to cancel.
    await expect(
      cancel.cancelGuestBackup(shared.db, fixture.tenantId, vm, actor()),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("sends a delivered task as a cancel order and refuses to open its run", async () => {
    const queued = await service.backupNow(
      shared.db,
      fixture.tenantId,
      vm,
      { verifyRead: false },
      actor(),
    );
    expect((await beat()).tasks.map((t) => t.id)).toEqual([queued.taskId]);
    expect(await cancel.cancelGuestBackup(shared.db, fixture.tenantId, vm, actor())).toEqual({
      withdrawn: 0,
      stopping: 1,
    });
    const hb = await beat({ state: "running" });
    expect(hb.cancel).toEqual({ tasks: [queued.taskId], runs: [] });
    // A node that starts it anyway (an older restow-pve) cannot open a run for it.
    expect((await openRun("2026-10-21T10:00:00Z")).status).toBe(409);
    const result = await call(`/tasks/${queued.taskId}/result`, {
      status: "failed",
      error: 'vzdump ended with "job errors"',
    });
    expect(result.status).toBe(204);
    const [task] = await fixture.db.select().from(pveTasks).where(eq(pveTasks.id, queued.taskId));
    expect(task?.status).toBe("cancelled");
    const runs = (await runsOf(vm)).filter((r) => r.taskId === queued.taskId);
    expect(runs).toEqual([expect.objectContaining({ status: "cancelled" })]);
    expect((await beat()).cancel).toEqual({ tasks: [], runs: [] });
  });

  it("ends a running backup cancelled, not failed, and refuses its uploads meanwhile", async () => {
    // A backup started in PVE: no task, the node finds the vzdump task by the VMID.
    const opened = await openRun("2026-10-21T11:00:00Z");
    expect(opened.status).toBe(201);
    const { runId } = (await opened.json()) as { runId: string };
    expect(await cancel.cancelGuestBackup(shared.db, fixture.tenantId, vm, actor())).toEqual({
      withdrawn: 0,
      stopping: 1,
    });
    // Asking again keeps the first request.
    await cancel.cancelGuestBackup(shared.db, fixture.tenantId, vm, {
      ...actor(),
      label: "second@contoso.example",
    });
    const overview = await service.overview(shared.db, fixture.tenantId);
    expect(overview.guests.find((g) => g.id === vm)).toMatchObject({
      activity: "running",
      cancelling: true,
      cancelledBy: "admin@contoso.example",
    });
    const hb = await beat({ state: "running", activeRuns: [runId] });
    expect(hb.cancel.runs).toEqual([{ id: runId, vmid: 101, taskId: null }]);
    expect(hb.tasks).toEqual([]);
    const refused = await call(`/runs/${runId}/incremental`, {
      devices: [{ device: "drive-scsi0", size: 4096 }],
    });
    expect(refused.status).toBe(409);
    const finished = await call(`/runs/${runId}/finish`, {
      status: "failed",
      error: "interrupted by signal",
    });
    expect(finished.status).toBe(204);
    const [run] = await fixture.db.select().from(pveRuns).where(eq(pveRuns.id, runId));
    expect(run).toMatchObject({ status: "cancelled", cancelledBy: "admin@contoso.example" });
    const after = await service.overview(shared.db, fixture.tenantId);
    expect(after.guests.find((g) => g.id === vm)).toMatchObject({
      activity: null,
      cancelling: false,
      lastRunStatus: "cancelled",
      lastRunCancelledBy: "admin@contoso.example",
      attention: expect.not.arrayContaining(["last_backup_failed"]),
    });
  });

  it("ends a stopped task's run cancelled when only the task result arrives, also sent again late", async () => {
    const queued = await service.backupNow(
      shared.db,
      fixture.tenantId,
      vm,
      { verifyRead: false },
      actor(),
    );
    expect((await beat()).tasks.map((t) => t.id)).toEqual([queued.taskId]);
    const opened = await openRun("2026-10-21T12:00:00Z");
    expect(opened.status).toBe(201);
    const { runId } = (await opened.json()) as { runId: string };
    expect(await cancel.cancelGuestBackup(shared.db, fixture.tenantId, vm, actor())).toEqual({
      withdrawn: 0,
      stopping: 1,
    });
    // The node stopped vzdump; its run's end never reached the server, only the task's result.
    const result = { status: "failed", error: "cancelled in Restow: interrupted by signal" };
    expect((await call(`/tasks/${queued.taskId}/result`, result)).status).toBe(204);
    const settled = async () => {
      const [task] = await fixture.db.select().from(pveTasks).where(eq(pveTasks.id, queued.taskId));
      const [run] = await fixture.db.select().from(pveRuns).where(eq(pveRuns.id, runId));
      expect(task?.status).toBe("cancelled");
      expect(run).toMatchObject({ status: "cancelled", cancelledBy: "admin@contoso.example" });
    };
    await settled();
    // restow-pve kept the result and sends it again (or reports the end as done): taken, and
    // the run without a restore point stays cancelled.
    expect((await call(`/tasks/${queued.taskId}/result`, result)).status).toBe(204);
    await settled();
    expect(
      (await call(`/tasks/${queued.taskId}/result`, { status: "done", result: { warnings: [] } }))
        .status,
    ).toBe(204);
    await settled();
    const [guest] = await fixture.db.select().from(pveGuests).where(eq(pveGuests.id, vm));
    const after = await service.overview(shared.db, fixture.tenantId);
    expect(after.guests.find((g) => g.id === vm)).toMatchObject({
      activity: null,
      lastRunStatus: "cancelled",
    });
    // A cancelled backup is not the guest's last backup.
    expect(guest?.lastBackupAt).toBeNull();
  });

  it("holds backups while the node's queue is paused and withdraws every queued one", async () => {
    const paused = await cancel.setNodeQueuePaused(
      shared.db,
      fixture.tenantId,
      node.nodeId,
      true,
      actor(),
    );
    expect(paused.queuePausedBy).toBe("admin@contoso.example");
    await service.backupNow(shared.db, fixture.tenantId, vm, { verifyRead: false }, actor());
    await service.backupNow(shared.db, fixture.tenantId, ct, { verifyRead: false }, actor());
    const hb = await beat();
    expect(hb).toMatchObject({ tasks: [], queuePaused: true });
    const overview = await service.overview(shared.db, fixture.tenantId);
    expect(overview.clusters[0]?.nodes[0]).toMatchObject({
      queuePausedBy: "admin@contoso.example",
      queuedBackups: 2,
    });
    expect(
      await cancel.cancelQueuedBackups(shared.db, fixture.tenantId, node.nodeId, actor()),
    ).toEqual({ withdrawn: 2, stopping: 0 });
    await cancel.setNodeQueuePaused(shared.db, fixture.tenantId, node.nodeId, false, actor());
    expect((await beat()).tasks).toEqual([]);
    // After resuming, a new backup goes out again; the tenant-wide cancel takes a delivered one.
    const queued = await service.backupNow(
      shared.db,
      fixture.tenantId,
      ct,
      { verifyRead: false },
      actor(),
    );
    expect((await beat()).tasks.map((t) => t.id)).toEqual([queued.taskId]);
    expect(await cancel.cancelQueuedBackups(shared.db, fixture.tenantId, null, actor())).toEqual({
      withdrawn: 0,
      stopping: 1,
    });
    const actions = await fixture.db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(sql`${auditLog.action} LIKE 'pve.queue.%'`);
    expect(actions.map((a) => a.action).sort()).toEqual([
      "pve.queue.cancelled",
      "pve.queue.cancelled",
      "pve.queue.paused",
      "pve.queue.resumed",
    ]);
  });

  it("tells the node to update now, on request and while the fleet phase of an update holds", async () => {
    expect((await beat()).update).toEqual({ version: "9.0.0", now: false });
    // The inventory says which release the node runs and that it is behind (0.4.3).
    const nodeView = async () =>
      (await service.overview(shared.db, fixture.tenantId)).clusters[0]?.nodes[0];
    expect(await nodeView()).toMatchObject({
      helperVersion: "0.4.1",
      offeredVersion: "9.0.0",
      outdated: true,
      updateVersion: "9.0.0",
    });
    await cancel.requestNodeUpdate(shared.db, fixture.tenantId, node.nodeId, actor());
    expect((await beat()).update).toEqual({ version: "9.0.0", now: true });
    // The node reports the new release: the request is done.
    expect((await beat({ helperVersion: "9.0.0" })).update).toBeNull();
    expect(await nodeView()).toMatchObject({
      helperVersion: "9.0.0",
      offeredVersion: "9.0.0",
      outdated: false,
      updateVersion: null,
    });
    const [row] = await fixture.db.select().from(pveNodes).where(eq(pveNodes.id, node.nodeId));
    expect(row?.updateRequestedAt).toBeNull();
    // The server was updated and its nodes follow: every behind node is told, no backup goes out.
    await fixture.db.execute(sql`
      INSERT INTO job_start_pause (mode, phase, version, lead_seconds, request, requested_by,
        deadline_at, expires_at)
      VALUES ('wait', 'fleet', '9.0.0', 0, '{}', '{"userId":null,"label":"x","ip":null}',
        now() + interval '15 minutes', now() + interval '16 minutes')`);
    try {
      await service.backupNow(shared.db, fixture.tenantId, vm, { verifyRead: false }, actor());
      const hb = await beat();
      expect(hb.update).toEqual({ version: "9.0.0", now: true });
      expect(hb.tasks).toEqual([]);
    } finally {
      await fixture.db.execute(sql`DELETE FROM job_start_pause`);
    }
    const open = await fixture.db
      .select()
      .from(pveTasks)
      .where(and(eq(pveTasks.guestId, vm), eq(pveTasks.status, "pending")));
    expect(open).toHaveLength(1);
  });
});
