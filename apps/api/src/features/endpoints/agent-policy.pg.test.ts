/**
 * Postgres-backed test of agent policies (docs/AGENT.md, "Richtlinien") and of the update pause as
 * the agents see it (docs/UPDATING.md, "Runs in progress during an update"):
 *
 * - without a policy anywhere nothing about a machine changes (no `config.policy`, no new version)
 *   and the agent's configuration carries `startsPaused: false` and nothing else new;
 * - the installation's policy reaches the machines of every tenant: their configuration gets the
 *   effective policy and a new version, an `update_config` task, and the audit log says so in both
 *   chains; the same policy saved again changes nothing;
 * - a tenant overrides what is not locked and is refused (409) what is; invalid values are 422;
 * - a job's level wins over the tenant's, through the job's own write; a job may not set a locked
 *   setting;
 * - `GET /agent/v1/config` folds bandwidth and AC power in and sends window, catch-up and retries;
 * - while an update pauses new runs, config and heartbeat say so and no backup request is handed
 *   out; it goes out with the first heartbeat after the pause.
 *
 * It does not need restic: the machines are inserted, not enrolled. Runs when
 * RESTOW_TEST_DATABASE_URL points at a Postgres server as a superuser (the database
 * `restow_api_agent_policy_test` is recreated there and dropped after).
 */
import { randomUUID } from "node:crypto";
import { generateAgentSecret } from "@restow/core";
import {
  auditLog,
  backupJobMembers,
  backupJobs,
  type EndpointConfig,
  endpoints,
  endpointTasks,
  settings,
  tenants,
} from "@restow/db";
import { and, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ProblemError } from "../../problem.js";
import {
  basic,
  type EndpointFixture,
  startFixture,
  testDatabaseAdminUrl,
} from "./testing/fixture.js";

const DATABASE = "restow_api_agent_policy_test";
const ZONE = "Europe/Berlin";

const NIGHT = { days: [1, 2, 3, 4, 5], from: "20:00", to: "06:00" };

function config(overrides: Partial<EndpointConfig> = {}): EndpointConfig {
  return {
    profile: "server",
    schedule: { kind: "daily", timeOfDay: "22:00", timeZone: ZONE },
    paths: ["/srv"],
    excludes: [],
    hooks: {},
    bandwidthKbps: null,
    onlyOnAcPower: false,
    useVss: false,
    ...overrides,
  };
}

describe.skipIf(!testDatabaseAdminUrl)("agent policies against Postgres", () => {
  let fixture: EndpointFixture;
  let app: Hono;
  let ipCounter = 10;
  let policy: typeof import("./agent-policy.js");
  let jobsWrite: typeof import("../backup-jobs/write.js");
  let appDb: typeof import("../../db.js")["db"];
  const actor = { label: "admin@contoso.example", userId: null, ip: null };
  const providerActor = { id: "", email: "owner@provider.example", ip: null };

  beforeAll(async () => {
    fixture = await startFixture(DATABASE);
    providerActor.id = fixture.adminId;
    await fixture.db.insert(settings).values({ singleton: true });
    policy = await import("./agent-policy.js");
    jobsWrite = await import("../backup-jobs/write.js");
    appDb = (await import("../../db.js")).db;
    const { agentRoutes } = await import("./agent-routes.js");
    const { errorHandler } = await import("../../problem.js");
    app = new Hono();
    app.onError(errorHandler);
    app.route("/agent/v1", agentRoutes);
  }, 90_000);

  afterAll(async () => {
    await fixture?.cleanup();
  });

  beforeEach(async () => {
    await fixture.db.update(settings).set({ agentPolicy: {} });
    await fixture.db.update(tenants).set({ agentPolicy: {} });
    await fixture.db.execute(sql`DELETE FROM job_start_pause`);
  });

  async function machine(
    values: { tenantId?: string; config?: EndpointConfig } = {},
  ): Promise<{ id: string; secret: string; tenantId: string }> {
    const secret = generateAgentSecret();
    const tenantId = values.tenantId ?? fixture.tenantId;
    const id = randomUUID();
    await fixture.db.insert(endpoints).values({
      id,
      tenantId,
      hostname: `host-${id.slice(0, 8)}`,
      os: "linux",
      arch: "amd64",
      profile: "server",
      secretHash: secret.hash,
      config: values.config ?? config(),
      configVersion: 3,
    });
    return { id, secret: secret.value, tenantId };
  }

  async function inJob(endpointId: string, jobSettings: Record<string, unknown> = {}) {
    const [job] = await fixture.db
      .insert(backupJobs)
      .values({
        tenantId: fixture.tenantId,
        kind: "endpoint",
        name: `Job ${endpointId.slice(0, 6)}`,
        schedule: { kind: "daily", timeOfDay: "22:00", timeZone: ZONE },
        scopeMode: "selected",
        settings: { paths: ["/srv"], ...jobSettings },
      })
      .returning();
    await fixture.db.insert(backupJobMembers).values({
      tenantId: fixture.tenantId,
      jobId: job?.id ?? "",
      endpointId,
    });
    return job?.id ?? "";
  }

  async function stored(id: string) {
    const [row] = await fixture.db.select().from(endpoints).where(eq(endpoints.id, id));
    if (!row) throw new Error("machine missing");
    return row;
  }

  async function updateTasks(id: string) {
    return fixture.db
      .select()
      .from(endpointTasks)
      .where(and(eq(endpointTasks.endpointId, id), eq(endpointTasks.kind, "update_config")));
  }

  async function agentGet(who: { id: string; secret: string }) {
    const response = await app.request("/agent/v1/config", {
      headers: { ...basic(who.id, who.secret), "x-forwarded-for": `192.0.2.${ipCounter++}` },
    });
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json()) as Record<string, unknown>;
  }

  async function heartbeat(
    who: { id: string; secret: string; configVersion: number },
    extra: Record<string, unknown> = {},
  ) {
    const response = await app.request("/agent/v1/heartbeat", {
      method: "POST",
      headers: {
        ...basic(who.id, who.secret),
        "content-type": "application/json",
        "x-forwarded-for": `192.0.2.${ipCounter++}`,
      },
      body: JSON.stringify({
        agentVersion: "0.4.0",
        osVersion: "Debian 12",
        state: "idle",
        nextRunAt: null,
        configVersion: who.configVersion,
        ...extra,
      }),
    });
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json()) as {
      tasks: { kind: string; id: string }[];
      startsPaused: boolean;
    };
  }

  it("without a policy, a machine and its configuration stay as they were", async () => {
    const who = await machine();
    const result = await policy.updateGlobalAgentPolicy({ settings: {}, locks: [] }, providerActor);
    expect(result.machinesUpdated).toBe(0);
    const row = await stored(who.id);
    expect(row.configVersion).toBe(3);
    expect("policy" in row.config).toBe(false);
    const answer = await agentGet(who);
    expect(answer).toEqual({ ...config(), configVersion: 3, startsPaused: false });
  });

  it("the installation's policy reaches every tenant's machines, once", async () => {
    const mine = await machine();
    const theirs = await machine({ tenantId: fixture.otherTenantId });
    const result = await policy.updateGlobalAgentPolicy(
      { settings: { backupWindow: NIGHT, retries: 2 }, locks: ["backupWindow"] },
      providerActor,
    );
    // Both, and the machines of the tests before.
    expect(result.machinesUpdated).toBeGreaterThanOrEqual(2);
    expect(result.effective.backupWindow).toEqual({ value: NIGHT, source: "global", locked: true });
    for (const who of [mine, theirs]) {
      const row = await stored(who.id);
      expect(row.configVersion).toBe(4);
      expect(row.config.policy).toMatchObject({ backupWindow: NIGHT, retries: 2 });
      expect(await updateTasks(who.id)).toHaveLength(1);
    }
    const installationAudit = await fixture.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "settings.agent_policy.updated"));
    expect(installationAudit.at(-1)?.tenantId).toBeNull();
    expect(installationAudit.at(-1)?.details).toMatchObject({
      after: { locks: ["backupWindow"], settings: { retries: 2 } },
    });
    const machineAudit = await fixture.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "endpoint.config.changed"), eq(auditLog.target, mine.id)));
    expect(machineAudit.at(-1)?.details).toMatchObject({
      changed: ["config.policy"],
      via: { policy: "global" },
    });
    // The same again changes nothing.
    const again = await policy.updateGlobalAgentPolicy(
      { settings: { backupWindow: NIGHT, retries: 2 }, locks: ["backupWindow"] },
      providerActor,
    );
    expect(again.machinesUpdated).toBe(0);
    expect((await stored(mine.id)).configVersion).toBe(4);

    // The agent gets the wire form with the zone of its schedule.
    const answer = await agentGet(mine);
    expect(answer.policy).toEqual({
      backupWindow: { ...NIGHT, timeZone: ZONE },
      catchUp: { enabled: true, mode: "asap" },
      maxRetries: 2,
    });

    // Back to nothing: the key goes away and the agent gets a new version.
    await policy.updateGlobalAgentPolicy({ settings: {}, locks: [] }, providerActor);
    const row = await stored(mine.id);
    expect(row.configVersion).toBe(5);
    expect("policy" in row.config).toBe(false);
  });

  it("a tenant overrides what is not locked and is refused what is", async () => {
    const who = await machine();
    await policy.updateGlobalAgentPolicy(
      { settings: { retries: 2 }, locks: ["onlyOnAcPower"] },
      providerActor,
    );
    const view = await policy.updateTenantAgentPolicy(
      appDb,
      fixture.tenantId,
      { retries: 8 },
      actor,
    );
    expect(view.effective.retries).toEqual({ value: 8, source: "tenant", locked: false });
    expect(view.global.locks).toEqual(["onlyOnAcPower"]);
    expect((await stored(who.id)).config.policy?.retries).toBe(8);
    const audits = await fixture.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "tenant.agent_policy.updated"));
    expect(audits.at(-1)).toMatchObject({ tenantId: fixture.tenantId, targetType: "tenant" });

    await expect(
      policy.updateTenantAgentPolicy(appDb, fixture.tenantId, { onlyOnAcPower: true }, actor),
    ).rejects.toMatchObject({ status: 409, type: "urn:restow:problem:agent-policy-locked" });
    await expect(
      policy.updateTenantAgentPolicy(appDb, fixture.tenantId, { retries: 99 }, actor),
    ).rejects.toBeInstanceOf(ProblemError);
    await expect(
      policy.updateTenantAgentPolicy(
        appDb,
        fixture.tenantId,
        { backupWindow: { days: [], from: "20:00", to: "06:00" } },
        actor,
      ),
    ).rejects.toMatchObject({ status: 422, type: "urn:restow:problem:agent-policy-invalid" });
    // The other tenant is not touched.
    const other = await policy.getTenantAgentPolicy(appDb, fixture.otherTenantId);
    expect(other.effective.retries).toEqual({ value: 2, source: "global", locked: false });
  });

  it("a job's level wins, and a job may not set what is locked", async () => {
    const who = await machine();
    const jobId = await inJob(who.id);
    await policy.updateTenantAgentPolicy(
      appDb,
      fixture.tenantId,
      { retries: 3, onlyOnAcPower: true },
      actor,
    );
    expect((await stored(who.id)).config.policy).toMatchObject({ retries: 3, onlyOnAcPower: true });
    const jobActor = { userId: null, label: "admin@contoso.example", ip: null };
    await jobsWrite.updateBackupJob(
      appDb,
      fixture.tenantId,
      jobId,
      { settings: { paths: ["/srv"], policy: { retries: 0, backupWindow: NIGHT } } } as never,
      jobActor,
      { now: new Date() },
      { revealHooks: true },
    );
    const row = await stored(who.id);
    expect(row.config.policy).toMatchObject({
      retries: 0,
      backupWindow: NIGHT,
      onlyOnAcPower: true,
    });
    // A tenant change keeps the job's level on top.
    await policy.updateTenantAgentPolicy(appDb, fixture.tenantId, { retries: 4 }, actor);
    expect((await stored(who.id)).config.policy).toMatchObject({
      retries: 0,
      onlyOnAcPower: false,
    });

    await policy.updateGlobalAgentPolicy({ settings: {}, locks: ["retries"] }, providerActor);
    // The job's value is ignored now...
    expect((await stored(who.id)).config.policy?.retries).toBe(5);
    // ...may stay in the job unchanged, but not be changed.
    await jobsWrite.updateBackupJob(
      appDb,
      fixture.tenantId,
      jobId,
      {
        settings: { paths: ["/srv", "/etc"], policy: { retries: 0, backupWindow: NIGHT } },
      } as never,
      jobActor,
      { now: new Date() },
      { revealHooks: true },
    );
    await expect(
      jobsWrite.updateBackupJob(
        appDb,
        fixture.tenantId,
        jobId,
        { settings: { paths: ["/srv"], policy: { retries: 1 } } } as never,
        jobActor,
        { now: new Date() },
        { revealHooks: true },
      ),
    ).rejects.toMatchObject({ status: 409, type: "urn:restow:problem:agent-policy-locked" });
  });

  it("bandwidth and AC power reach the agent folded in", async () => {
    const own = await machine({ config: config({ bandwidthKbps: 800, onlyOnAcPower: false }) });
    const none = await machine();
    await policy.updateGlobalAgentPolicy(
      { settings: { bandwidthKbps: 2000, onlyOnAcPower: true }, locks: [] },
      providerActor,
    );
    expect(await agentGet(own)).toMatchObject({ bandwidthKbps: 800, onlyOnAcPower: true });
    expect(await agentGet(none)).toMatchObject({ bandwidthKbps: 2000, onlyOnAcPower: true });
    await policy.updateGlobalAgentPolicy(
      { settings: { bandwidthKbps: 2000 }, locks: ["bandwidthKbps"] },
      providerActor,
    );
    expect(await agentGet(own)).toMatchObject({ bandwidthKbps: 2000, onlyOnAcPower: false });
  });

  it("a job's explicit unlimited beats the policy's limit, but not a lock", async () => {
    const limited = await machine();
    const unlimited = await machine();
    const limitedJob = await inJob(limited.id);
    const unlimitedJob = await inJob(unlimited.id);
    const jobActor = { userId: null, label: "admin@contoso.example", ip: null };
    for (const [jobId, bandwidthKbps] of [
      [limitedJob, null],
      [unlimitedJob, 0],
    ] as const) {
      await jobsWrite.updateBackupJob(
        appDb,
        fixture.tenantId,
        jobId,
        { settings: { paths: ["/srv"], bandwidthKbps } } as never,
        jobActor,
        { now: new Date() },
        { revealHooks: true },
      );
    }
    await policy.updateTenantAgentPolicy(appDb, fixture.tenantId, { bandwidthKbps: 2000 }, actor);
    // A job without a limit of its own inherits the policy's (what stored jobs keep meaning)...
    expect(await agentGet(limited)).toMatchObject({ bandwidthKbps: 2000 });
    // ...one that chose "unlimited" uploads without a limit.
    expect((await stored(unlimited.id)).config.bandwidthKbps).toBe(0);
    expect(await agentGet(unlimited)).toMatchObject({ bandwidthKbps: null });
    // A lock of the installation wins over the choice.
    await policy.updateGlobalAgentPolicy(
      { settings: { bandwidthKbps: 1000 }, locks: ["bandwidthKbps"] },
      providerActor,
    );
    expect(await agentGet(unlimited)).toMatchObject({ bandwidthKbps: 1000 });
    expect(await agentGet(limited)).toMatchObject({ bandwidthKbps: 1000 });
  });

  it("keeps what a due backup waits for from the heartbeat: unknown, nothing, or a code", async () => {
    const who = await machine();
    const next = "2026-10-16T18:00:00.000Z";
    await heartbeat({ ...who, configVersion: 3 }, { waiting: "backup_window", nextRunAt: next });
    let row = await stored(who.id);
    expect(row.agentWaiting).toBe("backup_window");
    expect(row.nextRunAt?.toISOString()).toBe(next);
    const settingsBefore = row.settings;
    // Nothing waits any more.
    await heartbeat({ ...who, configVersion: 3 }, { waiting: "" });
    row = await stored(who.id);
    expect(row.agentWaiting).toBe("");
    // The settings column is not touched by it.
    expect(row.settings).toEqual(settingsBefore);
    // A code of a later agent is kept; an implausible one counts as not said, without a refusal.
    await heartbeat({ ...who, configVersion: 3 }, { waiting: "network_metered" });
    expect((await stored(who.id)).agentWaiting).toBe("network_metered");
    await heartbeat({ ...who, configVersion: 3 }, { waiting: "Not A Code!" });
    expect((await stored(who.id)).agentWaiting).toBeNull();
    // An agent before 0.4.0 says nothing: unknown.
    await heartbeat({ ...who, configVersion: 3 }, { waiting: "ac_power" });
    await heartbeat({ ...who, configVersion: 3 });
    expect((await stored(who.id)).agentWaiting).toBeNull();
  });

  it("shows one machine the policy that applies, with each value's source", async () => {
    const who = await machine({ config: config({ onlyOnAcPower: true }) });
    const alone = await machine({ config: config({ bandwidthKbps: 300 }) });
    const jobId = await inJob(who.id, { bandwidthKbps: 0, policy: { retries: 1 } });
    await policy.updateGlobalAgentPolicy(
      { settings: { backupWindow: NIGHT }, locks: ["backupWindow"] },
      providerActor,
    );
    await policy.updateTenantAgentPolicy(
      appDb,
      fixture.tenantId,
      { bandwidthKbps: 2000, retries: 3 },
      actor,
    );
    // The configuration of the machine in the job carries the job's choice (written by the job).
    await fixture.db
      .update(endpoints)
      .set({ config: config({ onlyOnAcPower: true, bandwidthKbps: 0 }) })
      .where(eq(endpoints.id, who.id));
    const view = await policy.getEndpointAgentPolicy(appDb, fixture.tenantId, who.id);
    expect(view.job).toEqual({ id: jobId, name: expect.any(String) });
    expect(view.effective.backupWindow).toEqual({ value: NIGHT, source: "global", locked: true });
    expect(view.effective.retries).toEqual({ value: 1, source: "job", locked: false });
    expect(view.effective.bandwidthKbps).toEqual({ value: null, source: "job", locked: false });
    expect(view.effective.onlyOnAcPower).toEqual({
      value: true,
      source: "machine",
      locked: false,
    });
    expect(view.effective.catchUp.source).toBe("default");
    const own = await policy.getEndpointAgentPolicy(appDb, fixture.tenantId, alone.id);
    expect(own.job).toBeNull();
    expect(own.effective.bandwidthKbps).toEqual({ value: 300, source: "machine", locked: false });
    expect(own.effective.retries).toEqual({ value: 3, source: "tenant", locked: false });
    // Another tenant's machine is not found.
    await expect(
      policy.getEndpointAgentPolicy(appDb, fixture.otherTenantId, who.id),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("while an update pauses new runs, agents are told and backup requests wait", async () => {
    const who = await machine();
    await fixture.db.insert(endpointTasks).values({
      tenantId: fixture.tenantId,
      endpointId: who.id,
      kind: "backup_now",
      params: {},
      expiresAt: new Date(Date.now() + 86_400_000),
    } as never);
    await fixture.db.execute(sql`
      INSERT INTO job_start_pause (mode, phase, version, lead_seconds, request, requested_by,
        deadline_at, expires_at)
      VALUES ('wait', 'draining', '0.4.0', 0, '{}', '{"userId":null,"label":"x","ip":null}',
        now() + interval '1 hour', now() + interval '3 hours')`);
    expect(await agentGet(who)).toMatchObject({ startsPaused: true, configVersion: 3 });
    const held = await heartbeat({ ...who, configVersion: 3 });
    expect(held).toEqual({ tasks: [], startsPaused: true });
    await fixture.db.execute(sql`DELETE FROM job_start_pause`);
    const after = await heartbeat({ ...who, configVersion: 3 });
    expect(after.startsPaused).toBe(false);
    expect(after.tasks.map((task) => task.kind)).toEqual(["backup_now"]);
    expect(await agentGet(who)).toMatchObject({ startsPaused: false });
  });
});
