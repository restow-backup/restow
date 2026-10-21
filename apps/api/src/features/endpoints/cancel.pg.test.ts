/**
 * Stopping a machine's backup from the UI and updating agents with the server (0.4.2), against
 * Postgres through /agent/v1 the way the agent drives it:
 *
 *   - a queued "back up now" is withdrawn at once; a delivered one goes out as a cancel order and
 *     starting its run is refused,
 *   - a running backup is told to stop with the heartbeat and ends `cancelled` (not `failed`);
 *     the machine's last backup is untouched and no failure is raised,
 *   - "update now" and the fleet phase of an update tell a behind agent to update; the request is
 *     cleared once it runs the release,
 *   - the fleet status counts nodes and agents across tenants: updated, pending, unreachable and
 *     paused; the pause moves to the phase `fleet` once (one api process wins).
 *
 * The machines are inserted, not enrolled; restic is not needed.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateAgentSecret } from "@restow/core";
import {
  auditLog,
  backupJobMembers,
  backupJobs,
  endpointRuns,
  endpoints,
  endpointTasks,
  pveClusters,
  pveNodes,
  tenants,
} from "@restow/db";
import { eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  basic,
  type EndpointFixture,
  startFixture,
  testDatabaseAdminUrl,
} from "./testing/fixture.js";

const DATABASE = "restow_api_endpoint_cancel_test";
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

interface Heartbeat {
  tasks: { id: string; kind: string }[];
  cancel: { tasks: string[]; runs: string[] };
  updateNow: boolean;
}

describe.skipIf(!testDatabaseAdminUrl)("stopping machine backups against Postgres", () => {
  let fixture: EndpointFixture;
  let app: Hono;
  let cancel: typeof import("./cancel.js");
  let appDb: typeof import("../../db.js")["db"];
  let fleet: typeof import("../updates/fleet.js");
  let dist = "";
  let previousDist: string | undefined;
  let ip = 10;
  const actor = { label: "admin@contoso.example", userId: null, ip: null };

  beforeAll(async () => {
    fixture = await startFixture(DATABASE);
    previousDist = process.env.RESTOW_AGENT_DIR;
    dist = await mkdtemp(join(tmpdir(), "restow-endpoint-cancel-"));
    process.env.RESTOW_AGENT_DIR = dist;
    await mkdir(join(dist, "9.0.0", "linux-amd64"), { recursive: true });
    await writeFile(join(dist, "9.0.0", "linux-amd64", "restow-agent"), "agent 9.0.0");
    await writeFile(
      join(dist, "9.0.0", "SHA256SUMS"),
      `${sha256("agent 9.0.0")}  linux-amd64/restow-agent\n`,
    );
    await writeFile(join(dist, "9.0.0", "SHA256SUMS.sig"), "-----BEGIN SSH SIGNATURE-----\n");
    cancel = await import("./cancel.js");
    fleet = await import("../updates/fleet.js");
    appDb = (await import("../../db.js")).db;
    const { agentRoutes } = await import("./agent-routes.js");
    const { errorHandler } = await import("../../problem.js");
    app = new Hono();
    app.onError(errorHandler);
    app.route("/agent/v1", agentRoutes);
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

  async function machine(tenantId = fixture.tenantId, agentVersion = "0.4.1") {
    const secret = generateAgentSecret();
    const id = randomUUID();
    await fixture.db.insert(endpoints).values({
      id,
      tenantId,
      hostname: `host-${id.slice(0, 8)}`,
      os: "linux",
      arch: "amd64",
      profile: "server",
      agentVersion,
      secretHash: secret.hash,
      config: {
        profile: "server",
        schedule: { kind: "daily", timeOfDay: "22:00", timeZone: "Europe/Berlin" },
        paths: ["/srv"],
        excludes: [],
        hooks: {},
        bandwidthKbps: null,
        onlyOnAcPower: false,
        useVss: false,
      },
      configVersion: 1,
      lastSeenAt: new Date(),
    });
    const [job] = await fixture.db
      .insert(backupJobs)
      .values({
        tenantId,
        kind: "endpoint",
        name: `Job ${id.slice(0, 6)}`,
        schedule: { kind: "daily", timeOfDay: "22:00", timeZone: "Europe/Berlin" },
        scopeMode: "selected",
        settings: { paths: ["/srv"] },
      })
      .returning();
    await fixture.db
      .insert(backupJobMembers)
      .values({ tenantId, jobId: job?.id ?? "", endpointId: id });
    return { id, secret: secret.value };
  }

  function agent(who: { id: string; secret: string }, path: string, json: unknown) {
    return app.request(`/agent/v1${path}`, {
      method: "POST",
      headers: {
        ...basic(who.id, who.secret),
        "content-type": "application/json",
        "x-forwarded-for": `192.0.2.${ip++}`,
      },
      body: JSON.stringify(json),
    });
  }

  async function beat(
    who: { id: string; secret: string },
    extra: Record<string, unknown> = {},
  ): Promise<Heartbeat> {
    const response = await agent(who, "/heartbeat", {
      agentVersion: "0.4.1",
      osVersion: "Debian 12",
      state: "idle",
      nextRunAt: null,
      configVersion: 1,
      ...extra,
    });
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json()) as Heartbeat;
  }

  async function backupNow(endpointId: string) {
    const [task] = await fixture.db
      .insert(endpointTasks)
      .values({
        tenantId: fixture.tenantId,
        endpointId,
        kind: "backup_now",
        params: {},
        expiresAt: new Date(Date.now() + 86_400_000),
      })
      .returning();
    return task?.id ?? "";
  }

  it("withdraws a queued backup; a delivered one is refused when the agent starts it", async () => {
    const who = await machine();
    const first = await backupNow(who.id);
    expect(await cancel.cancelEndpointBackup(appDb, fixture.tenantId, who.id, actor)).toEqual({
      withdrawn: 1,
      stopping: 0,
    });
    const [row] = await fixture.db.select().from(endpointTasks).where(eq(endpointTasks.id, first));
    expect(row).toMatchObject({ status: "cancelled", cancelledBy: "admin@contoso.example" });
    expect((await beat(who)).tasks).toEqual([]);

    const second = await backupNow(who.id);
    expect((await beat(who)).tasks.map((t) => t.id)).toEqual([second]);
    expect(await cancel.cancelEndpointBackup(appDb, fixture.tenantId, who.id, actor)).toEqual({
      withdrawn: 0,
      stopping: 1,
    });
    expect((await beat(who)).cancel).toEqual({ tasks: [second], runs: [] });
    const start = await agent(who, "/runs", {
      kind: "backup",
      taskId: second,
      startedAt: new Date().toISOString(),
    });
    expect(start.status).toBe(409);
    const [after] = await fixture.db
      .select()
      .from(endpointTasks)
      .where(eq(endpointTasks.id, second));
    expect(after?.status).toBe("cancelled");
    expect((await beat(who)).cancel).toEqual({ tasks: [], runs: [] });
    await expect(
      cancel.cancelEndpointBackup(appDb, fixture.tenantId, who.id, actor),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("stops a running backup with the heartbeat; it ends cancelled, not failed", async () => {
    const who = await machine();
    const started = await agent(who, "/runs", {
      kind: "backup",
      startedAt: new Date().toISOString(),
    });
    expect(started.status).toBe(201);
    const { runId } = (await started.json()) as { runId: string };
    expect(await cancel.cancelEndpointBackup(appDb, fixture.tenantId, who.id, actor)).toEqual({
      withdrawn: 0,
      stopping: 1,
    });
    const hb = await beat(who, { state: "running" });
    expect(hb.cancel).toEqual({ tasks: [], runs: [runId] });
    const finished = await agent(who, `/runs/${runId}/finish`, {
      status: "failed",
      finishedAt: new Date().toISOString(),
      errors: [{ code: "cancelled", message: "The backup was cancelled in Restow." }],
      logTail: "",
    });
    expect(finished.status).toBe(200);
    expect(await finished.json()).toEqual({ runId, status: "cancelled" });
    const [run] = await fixture.db.select().from(endpointRuns).where(eq(endpointRuns.id, runId));
    expect(run).toMatchObject({
      status: "cancelled",
      cancelledBy: "admin@contoso.example",
      failure: null,
    });
    const [row] = await fixture.db.select().from(endpoints).where(eq(endpoints.id, who.id));
    expect(row?.lastBackupAt).toBeNull();
    const audits = await fixture.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "endpoint.backup.cancelled"));
    expect(audits.some((a) => a.target === who.id)).toBe(true);
  });

  it("tells a behind agent to update now; the request ends once it runs the release", async () => {
    const who = await machine();
    expect((await beat(who)).updateNow).toBe(false);
    await cancel.requestEndpointUpdate(appDb, fixture.tenantId, who.id, actor);
    expect((await beat(who)).updateNow).toBe(true);
    expect((await beat(who, { agentVersion: "9.0.0" })).updateNow).toBe(false);
    const [row] = await fixture.db.select().from(endpoints).where(eq(endpoints.id, who.id));
    expect(row?.updateRequestedAt).toBeNull();
    // The fleet phase tells every behind agent; a development build never.
    await fixture.db.execute(sql`
      INSERT INTO job_start_pause (mode, phase, version, lead_seconds, request, requested_by,
        deadline_at, expires_at)
      VALUES ('wait', 'fleet', '9.0.0', 0, '{}', '{"userId":null,"label":"x","ip":null}',
        now() + interval '15 minutes', now() + interval '16 minutes')`);
    try {
      expect((await beat(who)).updateNow).toBe(true);
      expect((await beat(who, { agentVersion: "0.4.1-dev" })).updateNow).toBe(false);
    } finally {
      await fixture.db.execute(sql`DELETE FROM job_start_pause`);
    }
  });

  it("counts nodes and agents against the release and moves the pause to the fleet phase once", async () => {
    await fixture.db.delete(endpoints);
    const now = new Date();
    const behind = await machine(fixture.tenantId, "0.4.1");
    await machine(fixture.tenantId, "9.0.0");
    const silent = await machine(fixture.otherTenantId, "0.4.0");
    await fixture.db
      .update(endpoints)
      .set({ lastSeenAt: new Date(now.getTime() - 60 * 60 * 1000) })
      .where(eq(endpoints.id, silent.id));
    const held = await machine(fixture.otherTenantId, "0.4.0");
    await fixture.db
      .update(endpoints)
      .set({ settings: { autoUpdatePaused: true } })
      .where(eq(endpoints.id, held.id));
    const [cluster] = await fixture.db
      .insert(pveClusters)
      .values({
        tenantId: fixture.tenantId,
        name: "lab",
        fingerprint: "f".repeat(64),
        storageId: "restow",
      })
      .returning();
    await fixture.db.insert(pveNodes).values({
      tenantId: fixture.tenantId,
      clusterId: cluster?.id ?? "",
      name: "pve1",
      helperVersion: "0.4.1",
      secretHash: "x",
      lastSeenAt: now,
    });
    const { providerDb } = await import("../../db.js");
    const status = await fleet.fleetStatus(providerDb, "9.0.0", now);
    expect(status.counts.agent).toEqual({
      updated: 1,
      pending: 1,
      unreachable: 1,
      paused: 1,
      total: 4,
    });
    expect(status.counts.pve_node).toMatchObject({ pending: 1, total: 1 });
    expect(status.counts.all.pending).toBe(2);
    expect(status.members[0]?.state).toBe("pending");
    expect(status.members.map((m) => m.id)).toEqual(
      expect.arrayContaining([behind.id, silent.id, held.id]),
    );
    expect(status.members.find((m) => m.id === silent.id)).toMatchObject({
      state: "unreachable",
      tenantName: "Fabrikam",
    });
    expect(status.commands.pve_node).toBe("/opt/restow-pve/bin/restow-pve update");

    await fixture.db.execute(sql`
      INSERT INTO job_start_pause (mode, phase, version, lead_seconds, request, requested_by,
        deadline_at, expires_at, announced_at)
      VALUES ('wait', 'announced', '9.0.0', 0, '{}', '{"userId":null,"label":"x","ip":null}',
        now(), now() + interval '2 hours', now())`);
    const [pause] = await fixture.db
      .execute<{ id: string }>(sql`SELECT id FROM job_start_pause`)
      .then((r) => r.rows);
    const moved = await fleet.enterFleetPhase(providerDb, { id: pause?.id ?? "" }, now);
    expect(moved?.phase).toBe("fleet");
    expect(moved?.deadlineAt.getTime()).toBe(now.getTime() + fleet.FLEET_WINDOW_MS);
    // A second api process finds it moved already.
    expect(await fleet.enterFleetPhase(providerDb, { id: pause?.id ?? "" }, now)).toBeNull();
    await fixture.db.execute(sql`DELETE FROM job_start_pause`);
    await fixture.db.update(tenants).set({ agentUpdatesPaused: false });
  });
});
