/**
 * The native SQL Server backup (W2a, docs/BAREMETAL-WINDOWS.md 5.1) against Postgres, through
 * /agent/v1 the way the agent drives it and through the session service the machine page uses.
 * The agent's requests are the shared contract fixtures (agent/internal/api/testdata/contract),
 * with the ids the server handed out put in:
 *
 *   - the heartbeat keeps the Windows facts and the capability, writes the inventory (a new
 *     family_guid is another row, a database missing from a complete inventory is dropped and
 *     comes back), and a heartbeat without an inventory keeps the instances;
 *   - a `sql` run keeps its backups (LSNs as decimal strings), its databases and notices;
 *     it never belongs to a task;
 *   - a check is judged by the server: green, red with evidence, incomplete without a rating;
 *   - a restore under a new name: name rules, a name the inventory knows, the capability gate, a
 *     revoked machine, the audit; the restore script is a download of its own (audited);
 *   - while an update pauses new runs, a check waits; a stop reaches SQL runs.
 *
 * The machines are inserted, not enrolled; restic is not needed.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { generateAgentSecret } from "@restow/core";
import {
  auditLog,
  type EndpointConfig,
  endpointReports,
  endpointRuns,
  endpointSqlBackups,
  endpointSqlDatabases,
  endpoints,
  endpointTasks,
} from "@restow/db";
import { and, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  basic,
  type EndpointFixture,
  startFixture,
  testDatabaseAdminUrl,
} from "./testing/fixture.js";

const DATABASE = "restow_api_endpoint_sql_test";

type Json = Record<string, unknown>;

function fixtureJson(name: string): Json {
  return JSON.parse(
    readFileSync(
      new URL(`../../../../../agent/internal/api/testdata/contract/${name}`, import.meta.url),
      "utf8",
    ),
  ) as Json;
}

const SQL_SETTINGS = {
  enabled: true,
  mode: "alongside" as const,
  instances: "all" as const,
  databases: "all" as const,
  exclude: [],
  verify: { enabled: true, weekday: 7, time: "03:00", maxGiB: 200, physicalOnly: false },
};

function windowsConfig(extra: Partial<EndpointConfig> = {}): EndpointConfig {
  return {
    profile: "server",
    schedule: { kind: "daily", timeOfDay: "22:00", timeZone: "Europe/Berlin" },
    paths: ["C:\\Data"],
    excludes: [],
    hooks: {},
    bandwidthKbps: null,
    onlyOnAcPower: false,
    useVss: true,
    sql: SQL_SETTINGS,
    ...extra,
  };
}

describe.skipIf(!testDatabaseAdminUrl)("the native SQL Server backup against Postgres", () => {
  let fixture: EndpointFixture;
  let app: Hono;
  let service: typeof import("./sql.js");
  let cancel: typeof import("./cancel.js");
  let appDb: typeof import("../../db.js")["db"];
  let ip = 10;
  const actor = { label: "admin@contoso.example", userId: null, ip: "192.0.2.1" };

  beforeAll(async () => {
    fixture = await startFixture(DATABASE);
    service = await import("./sql.js");
    cancel = await import("./cancel.js");
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

  async function machine(options: { os?: "windows" | "linux"; config?: EndpointConfig } = {}) {
    const secret = generateAgentSecret();
    const id = randomUUID();
    await fixture.db.insert(endpoints).values({
      id,
      tenantId: fixture.tenantId,
      hostname: `sql-${id.slice(0, 8)}`,
      os: options.os ?? "windows",
      arch: "amd64",
      profile: "server",
      agentVersion: "0.5.0",
      secretHash: secret.hash,
      config: options.config ?? windowsConfig(),
      configVersion: 1,
      lastSeenAt: new Date(),
    });
    return { id, secret: secret.value };
  }

  function agent(who: { id: string; secret: string }, path: string, json: unknown) {
    return app.request(`/agent/v1${path}`, {
      method: "POST",
      headers: {
        ...basic(who.id, who.secret),
        "content-type": "application/json",
        "x-forwarded-for": `198.51.100.${ip++ % 250}`,
      },
      body: JSON.stringify(json),
    });
  }

  async function beat(who: { id: string; secret: string }, extra: Json = {}) {
    const response = await agent(who, "/heartbeat", {
      agentVersion: "0.5.0",
      osVersion: "Windows Server 2022 Standard 21H2 (build 20348.2340)",
      state: "idle",
      nextRunAt: null,
      configVersion: 1,
      ...extra,
    });
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json()) as {
      tasks: { id: string; kind: string; params: Json }[];
      cancel: { tasks: string[]; runs: string[] };
    };
  }

  /** The fixture heartbeat: capability, Windows facts and the SQL inventory. */
  function windowsHeartbeat(): Json {
    const heartbeat = fixtureJson("heartbeat-windows-sql.json");
    return {
      capabilities: heartbeat.capabilities,
      machine: heartbeat.machine,
      sqlInventory: heartbeat.sqlInventory,
    };
  }

  async function startRun(who: { id: string; secret: string }, kind: string, taskId?: string) {
    const response = await agent(who, "/runs", {
      kind,
      ...(taskId ? { taskId } : {}),
      startedAt: new Date(Date.now() - 60_000).toISOString(),
    });
    return response;
  }

  async function finish(who: { id: string; secret: string }, runId: string, body: Json) {
    const response = await agent(who, `/runs/${runId}/finish`, {
      ...body,
      finishedAt: new Date().toISOString(),
    });
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json()) as { status: string };
  }

  async function databases(endpointId: string) {
    return fixture.db
      .select()
      .from(endpointSqlDatabases)
      .where(eq(endpointSqlDatabases.endpointId, endpointId))
      .orderBy(endpointSqlDatabases.database);
  }

  /** A machine that reported its inventory and made one `sql` run of the fixture. */
  async function backedUp() {
    const who = await machine();
    await beat(who, windowsHeartbeat());
    const started = await startRun(who, "sql");
    expect(started.status, await started.clone().text()).toBe(201);
    const { runId } = (await started.json()) as { runId: string };
    await finish(who, runId, fixtureJson("finish-sql.json"));
    const [sales] = (await databases(who.id)).filter((row) => row.database === "Sales");
    return { who, runId, salesId: sales?.id ?? "" };
  }

  it("keeps the Windows facts, the capability and the inventory of a heartbeat", async () => {
    const who = await machine();
    await beat(who, windowsHeartbeat());
    const [row] = await fixture.db.select().from(endpoints).where(eq(endpoints.id, who.id));
    expect(row?.settings.agent?.capabilities).toEqual(["sql_native_v1"]);
    expect(row?.settings.agent?.machine?.windows).toMatchObject({
      productName: "Windows Server 2022 Standard",
      build: 20348,
      roles: { sqlServer: true },
    });
    expect(row?.settings.sqlInstances?.instances).toEqual([
      expect.objectContaining({
        name: "SQLEXPRESS",
        state: "ok",
        login: expect.objectContaining({ sysadmin: true }),
      }),
      expect.objectContaining({
        name: "RESTOWB",
        state: "error",
        error: expect.objectContaining({ code: "sql_login_missing", number: 18456 }),
      }),
    ]);
    expect((await databases(who.id)).map((db) => db.database)).toEqual(["Sales", "master"]);

    // A heartbeat without an inventory removes nothing.
    await beat(who, { capabilities: ["sql_native_v1"] });
    const [again] = await fixture.db.select().from(endpoints).where(eq(endpoints.id, who.id));
    expect(again?.settings.sqlInstances?.instances).toHaveLength(2);

    // Sales missing from a complete inventory: dropped; back again: cleared.
    const inventory = structuredClone(windowsHeartbeat().sqlInventory) as {
      instances: { databases: Json[] }[];
    };
    const sales = inventory.instances[0]?.databases.pop() as Json;
    await beat(who, { sqlInventory: inventory });
    expect(
      (await databases(who.id)).find((db) => db.database === "Sales")?.droppedAt,
    ).not.toBeNull();
    inventory.instances[0]?.databases.push(sales);
    await beat(who, { sqlInventory: inventory });
    expect((await databases(who.id)).find((db) => db.database === "Sales")?.droppedAt).toBeNull();

    // The same name with another family_guid is another database.
    inventory.instances[0]?.databases.push({
      ...sales,
      familyGuid: randomUUID(),
      databaseGuid: randomUUID(),
    });
    await beat(who, { sqlInventory: inventory });
    expect((await databases(who.id)).filter((db) => db.database === "Sales")).toHaveLength(2);

    // A truncated inventory drops nothing.
    await beat(who, {
      sqlInventory: {
        ...inventory,
        truncated: true,
        instances: [{ name: "SQLEXPRESS", state: "ok", databases: [] }],
      },
    });
    expect((await databases(who.id)).every((db) => db.droppedAt === null)).toBe(true);
  });

  it("keeps the inventory of a Windows agent only, and no Windows facts of another system", async () => {
    const who = await machine({ os: "linux", config: windowsConfig({ sql: undefined }) });
    await beat(who, windowsHeartbeat());
    const [row] = await fixture.db.select().from(endpoints).where(eq(endpoints.id, who.id));
    expect(row?.settings.agent?.machine).toEqual({
      virtualization: "vm",
      technology: "",
      desktop: false,
    });
    expect(row?.settings.sqlInstances).toBeUndefined();
    expect(await databases(who.id)).toEqual([]);
  });

  it("keeps the backups of a sql run, which never belongs to a task", async () => {
    const { who, runId, salesId } = await backedUp();
    const [run] = await fixture.db.select().from(endpointRuns).where(eq(endpointRuns.id, runId));
    expect(run).toMatchObject({ kind: "sql", status: "partial" });
    expect(run?.stats?.sql).toEqual({
      instance: "SQLEXPRESS",
      databases: [
        { name: "Sales", outcome: "backed_up", bytes: 734265344 },
        expect.objectContaining({
          name: "Archive",
          outcome: "skipped",
          code: "sql_staging_too_small",
        }),
      ],
    });
    expect(run?.stats?.notices).toEqual([
      expect.objectContaining({ code: "sql_log_growing", subjects: ["Sales"] }),
    ]);
    expect(run?.failure).toMatchObject({ code: "endpoint.sql_staging_too_small" });
    const backups = await fixture.db
      .select()
      .from(endpointSqlBackups)
      .where(eq(endpointSqlBackups.endpointId, who.id));
    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatchObject({
      databaseId: salesId,
      runId,
      kind: "full",
      copyOnly: true,
      compressed: false,
      firstLsn: "37000000012800001",
      lastLsn: "37000000014400001",
      databaseBackupLsn: "36000000011200037",
      resticSnapshotId: "18eb0f31e91b9c0452a42c9fcf31d37b771774327c9370af2b19bd2d64b4ea1e",
      status: "active",
    });
    expect(backups[0]?.fileList).toHaveLength(2);
    // The file backup decides the machine's last backup: it has folders.
    const [endpoint] = await fixture.db.select().from(endpoints).where(eq(endpoints.id, who.id));
    expect(endpoint?.lastSuccessAt).toBeNull();

    // A sql run with a task is refused.
    const [task] = await fixture.db
      .insert(endpointTasks)
      .values({ tenantId: fixture.tenantId, endpointId: who.id, kind: "backup_now", params: {} })
      .returning();
    expect((await startRun(who, "sql", task?.id)).status).toBe(409);

    const overview = await service.getSqlOverview(appDb, fixture.tenantId, who.id);
    expect(overview).toMatchObject({ capable: true, enabled: true });
    expect(overview.instances.map((instance) => [instance.name, instance.signIn])).toEqual([
      ["RESTOWB", "missing"],
      ["SQLEXPRESS", "ok"],
    ]);
    expect(overview.instances[0]?.loginScripts.sysadmin).toContain(
      "CREATE LOGIN [NT SERVICE\\RestowAgent] FROM WINDOWS",
    );
    const sales = overview.databases.find((db) => db.name === "Sales");
    expect(sales).toMatchObject({
      rating: "unverified",
      selected: true,
      lastBackup: { bytes: 734265344 },
    });
    expect(overview.databases.find((db) => db.name === "master")?.rating).toBe("not_protected");
  });

  it("counts a sql run as the machine's backup when it has no folders", async () => {
    const who = await machine({ config: windowsConfig({ paths: [] }) });
    await beat(who, windowsHeartbeat());
    const { runId } = (await (await startRun(who, "sql")).json()) as { runId: string };
    await finish(who, runId, fixtureJson("finish-sql.json"));
    const [endpoint] = await fixture.db.select().from(endpoints).where(eq(endpoints.id, who.id));
    expect(endpoint?.lastSuccessAt).not.toBeNull();
    expect(endpoint?.lastSnapshotId).toBeNull();
  });

  /** A check task delivered and started; the fixture's ids replaced by the server's. */
  async function verifyRun(who: { id: string; secret: string }, databaseId?: string) {
    const requested = await service.requestSqlVerify(
      appDb,
      fixture.tenantId,
      who.id,
      databaseId ? { databaseId } : {},
      actor,
    );
    expect(requested.queued).toEqual(["SQLEXPRESS"]);
    const { tasks } = await beat(who);
    const task = tasks.find((item) => item.kind === "sql_verify");
    expect(task).toBeDefined();
    const started = await startRun(who, "sql_verify", task?.id);
    expect(started.status).toBe(201);
    const { runId } = (await started.json()) as { runId: string };
    return {
      runId,
      params: task?.params as { databases: { databaseId: string; backupId: string }[] },
    };
  }

  function withIds(report: Json, ids: { databaseId: string; backupId: string }[]): Json {
    const copy = structuredClone(report) as { sqlVerify: { databases: Json[] } };
    copy.sqlVerify.databases = copy.sqlVerify.databases.map((database, index) => ({
      ...database,
      ...(ids[index] ?? { databaseId: randomUUID(), backupId: randomUUID() }),
    }));
    return copy;
  }

  async function reportsOf(runId: string) {
    return fixture.db.select().from(endpointReports).where(eq(endpointReports.runId, runId));
  }

  it("judges a check green, red with evidence, or incomplete without a rating", async () => {
    const { who, salesId } = await backedUp();
    const green = await verifyRun(who);
    expect(green.params.databases.map((db) => db.databaseId)).toEqual([salesId]);
    await finish(
      who,
      green.runId,
      withIds(fixtureJson("finish-sql-verify-green.json"), green.params.databases),
    );
    const [greenReport] = await reportsOf(green.runId);
    expect(greenReport).toMatchObject({
      kind: "sql_verify",
      origin: "agent",
      readiness: "green",
      snapshotId: "18eb0f31e91b9c0452a42c9fcf31d37b771774327c9370af2b19bd2d64b4ea1e",
      summary: expect.objectContaining({
        databaseId: salesId,
        outcome: "green",
        method: "restore+checkdb",
      }),
    });
    const [endpoint] = await fixture.db.select().from(endpoints).where(eq(endpoints.id, who.id));
    expect(endpoint?.lastRestoreTestAt).toBeNull();
    let overview = await service.getSqlOverview(appDb, fixture.tenantId, who.id);
    expect(overview.databases.find((db) => db.id === salesId)?.rating).toBe("green");

    const red = await verifyRun(who);
    // The second database of the red fixture is not in the task: it is ignored.
    await finish(
      who,
      red.runId,
      withIds(fixtureJson("finish-sql-verify-red.json"), red.params.databases),
    );
    const redReports = await reportsOf(red.runId);
    expect(redReports).toHaveLength(1);
    expect(redReports[0]).toMatchObject({
      readiness: "red",
      summary: expect.objectContaining({
        outcome: "red",
        evidence: [expect.objectContaining({ source: "checkdb", number: 8928 })],
      }),
    });
    overview = await service.getSqlOverview(appDb, fixture.tenantId, who.id);
    expect(overview.databases.find((db) => db.id === salesId)?.rating).toBe("red");

    const incomplete = await verifyRun(who, salesId);
    await finish(
      who,
      incomplete.runId,
      withIds(fixtureJson("finish-sql-verify-incomplete.json"), incomplete.params.databases),
    );
    const [incompleteReport] = await reportsOf(incomplete.runId);
    expect(incompleteReport).toMatchObject({
      readiness: null,
      summary: expect.objectContaining({ outcome: "incomplete", code: "sql_verify_no_space" }),
    });
    // An incomplete check leaves the rating where it was.
    overview = await service.getSqlOverview(appDb, fixture.tenantId, who.id);
    const sales = overview.databases.find((db) => db.id === salesId);
    expect(sales?.rating).toBe("red");
    expect(sales?.lastVerification).toMatchObject({
      outcome: "incomplete",
      code: "sql_verify_no_space",
    });

    // A database of the task the agent said nothing about is incomplete.
    const silent = await verifyRun(who);
    await finish(who, silent.runId, {
      status: "failed",
      errors: [{ code: "sql_script_failed", message: "crash" }],
      logTail: "",
    });
    const [silentReport] = await reportsOf(silent.runId);
    expect(silentReport).toMatchObject({
      readiness: null,
      summary: expect.objectContaining({ code: "sql_script_failed" }),
    });
  });

  it("holds a check back while an update pauses new runs, and gives one per instance", async () => {
    const { who } = await backedUp();
    await service.requestSqlVerify(appDb, fixture.tenantId, who.id, {}, actor);
    expect(await service.requestSqlVerify(appDb, fixture.tenantId, who.id, {}, actor)).toEqual({
      queued: [],
      alreadyQueued: ["SQLEXPRESS"],
    });
    await service.requestSqlInventory(appDb, fixture.tenantId, who.id, actor);
    await fixture.db.execute(sql`
      INSERT INTO job_start_pause (mode, phase, version, lead_seconds, request, requested_by,
        deadline_at, expires_at)
      VALUES ('wait', 'draining', '0.5.0', 0, '{}', '{"userId":null,"label":"x","ip":null}',
        now() + interval '1 hour', now() + interval '3 hours')`);
    try {
      const held = await beat(who);
      expect(held.tasks.map((task) => task.kind)).toEqual(["sql_inventory"]);
    } finally {
      await fixture.db.execute(sql`DELETE FROM job_start_pause`);
    }
    // The inventory request finished on delivery.
    const inventory = await fixture.db
      .select()
      .from(endpointTasks)
      .where(and(eq(endpointTasks.endpointId, who.id), eq(endpointTasks.kind, "sql_inventory")));
    expect(inventory[0]?.status).toBe("done");
    expect((await beat(who)).tasks.map((task) => task.kind)).toEqual(["sql_verify"]);
  });

  it("restores under a new name with the name rules, the capability gate and the audit", async () => {
    const { who, salesId } = await backedUp();
    const { backups } = await service.listSqlBackups(appDb, fixture.tenantId, who.id, salesId);
    const backupId = backups[0]?.id ?? "";
    await expect(
      service.requestSqlRestore(
        appDb,
        fixture.tenantId,
        who.id,
        { backupId, newName: "Sales" },
        actor,
      ),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      service.requestSqlRestore(
        appDb,
        fixture.tenantId,
        who.id,
        { backupId, newName: "Sales_copy", targetInstance: "NOPE" },
        actor,
      ),
    ).rejects.toMatchObject({ status: 422 });
    const { taskId } = await service.requestSqlRestore(
      appDb,
      fixture.tenantId,
      who.id,
      { backupId, newName: "Sales_restored_20261105" },
      actor,
    );
    const [task] = await fixture.db
      .select()
      .from(endpointTasks)
      .where(eq(endpointTasks.id, taskId));
    expect(task?.params).toMatchObject({
      backupId,
      instance: "SQLEXPRESS",
      targetInstance: "SQLEXPRESS",
      database: "Sales",
      newName: "Sales_restored_20261105",
      sha256: "d1eaf3a515cec69d9d87a01baf2dcb0f23ed1d11eba77aa652c69bd95a78e607",
      checkdb: true,
      maxGiB: 200,
    });
    const delivered = await beat(who);
    expect(delivered.tasks.map((item) => item.id)).toContain(taskId);
    const started = await startRun(who, "sql_restore", taskId);
    expect(started.status).toBe(201);
    const { runId } = (await started.json()) as { runId: string };
    expect(await cancel.cancelEndpointBackup(appDb, fixture.tenantId, who.id, actor)).toEqual({
      withdrawn: 0,
      stopping: 1,
    });
    expect((await beat(who)).cancel.runs).toEqual([runId]);
    const restore = structuredClone(fixtureJson("finish-sql-restore.json")) as { sqlRestore: Json };
    restore.sqlRestore.backupId = backupId;
    await finish(who, runId, restore);
    const [run] = await fixture.db.select().from(endpointRuns).where(eq(endpointRuns.id, runId));
    expect(run?.stats?.sql).toMatchObject({
      instance: "SQLEXPRESS",
      newName: "Sales_restored_20261105",
      checkdb: "clean",
      databases: [expect.objectContaining({ name: "Sales", outcome: "restored" })],
    });
    const actions = await fixture.db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(eq(auditLog.target, who.id));
    expect(actions.map((row) => row.action)).toEqual(
      expect.arrayContaining(["endpoint.sql.restore.requested", "endpoint.sql.restore.finished"]),
    );

    const script = await service.sqlRestoreScript(appDb, fixture.tenantId, who.id, backupId, actor);
    expect(script.fileName).toBe("restore-Sales-20261105T020140Z.ps1");
    expect(script.body).toContain('"database":"Sales"');
    expect(script.body).not.toMatch(/password"\s*:/i);

    // Retention forgot the snapshot: no restore, no script.
    await fixture.db
      .update(endpointSqlBackups)
      .set({ status: "pruned" })
      .where(eq(endpointSqlBackups.id, backupId));
    await expect(
      service.requestSqlRestore(
        appDb,
        fixture.tenantId,
        who.id,
        { backupId, newName: "Other" },
        actor,
      ),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      service.sqlRestoreScript(appDb, fixture.tenantId, who.id, backupId, actor),
    ).rejects.toMatchObject({
      status: 409,
    });
  });

  it("hands the agent the task params of the shared fixtures, key for key", async () => {
    // The agent decodes task params with a plain json.Unmarshal (internal/core/sql.go): a key
    // the server names otherwise arrives as a zero value. The backup of finish-sql.json is the
    // backup of task-sql-verify.json and task-sql-restore.json; only the ids are the server's.
    const { who, salesId } = await backedUp();
    const { backups } = await service.listSqlBackups(appDb, fixture.tenantId, who.id, salesId);
    const backupId = backups[0]?.id ?? "";

    const verify = await verifyRun(who);
    const verifyFixture = structuredClone(fixtureJson("task-sql-verify.json")) as {
      params: { databases: Json[] };
    };
    verifyFixture.params.databases = verifyFixture.params.databases.map((db) => ({
      ...db,
      databaseId: salesId,
      backupId,
    }));
    expect(verify.params).toEqual(verifyFixture.params);

    const { taskId } = await service.requestSqlRestore(
      appDb,
      fixture.tenantId,
      who.id,
      { backupId, newName: "Sales_restored_20261105" },
      actor,
    );
    const [task] = await fixture.db
      .select()
      .from(endpointTasks)
      .where(eq(endpointTasks.id, taskId));
    const restoreFixture = structuredClone(fixtureJson("task-sql-restore.json")) as {
      params: Json;
    };
    restoreFixture.params.backupId = backupId;
    expect(task?.params).toEqual(restoreFixture.params);
  });

  it("offers no SQL action to an older agent or a revoked machine", async () => {
    const { who, salesId } = await backedUp();
    await fixture.db
      .update(endpoints)
      .set({ settings: sql`jsonb_set(${endpoints.settings}, '{agent,capabilities}', '[]'::jsonb)` })
      .where(eq(endpoints.id, who.id));
    await expect(
      service.requestSqlVerify(appDb, fixture.tenantId, who.id, {}, actor),
    ).rejects.toMatchObject({
      status: 409,
      type: "urn:restow:problem:endpoint-sql-unsupported",
    });
    await expect(
      service.requestSqlInventory(appDb, fixture.tenantId, who.id, actor),
    ).rejects.toMatchObject({
      status: 409,
    });
    await fixture.db.update(endpoints).set({ status: "revoked" }).where(eq(endpoints.id, who.id));
    await expect(
      service.requestSqlVerify(appDb, fixture.tenantId, who.id, { databaseId: salesId }, actor),
    ).rejects.toMatchObject({ status: 409, type: "urn:restow:problem:endpoint-revoked" });
    // Confirming the TDE certificate is a note of the admin's, possible any time.
    const confirmed = await service.confirmSqlTde(appDb, fixture.tenantId, who.id, salesId, actor);
    const [row] = await fixture.db
      .select()
      .from(endpointSqlDatabases)
      .where(eq(endpointSqlDatabases.id, salesId));
    expect(row?.tdeConfirmedAt?.toISOString()).toBe(confirmed.confirmedAt);
    expect(row?.tdeConfirmedBy).toBe("admin@contoso.example");
  });

  it("hands the agent the SQL settings of the contract, without the check plan", async () => {
    const expected = fixtureJson("config-sql.json").sql as Json;
    const who = await machine({
      config: windowsConfig({
        sql: { ...SQL_SETTINGS, ...(expected as object) } as EndpointConfig["sql"],
      }),
    });
    const response = await app.request("/agent/v1/config", {
      headers: { ...basic(who.id, who.secret), "x-forwarded-for": "198.51.100.251" },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { sql?: Json };
    expect(body.sql).toEqual(expected);
  });

  it("keeps another tenant out", async () => {
    const { who } = await backedUp();
    await expect(
      service.getSqlOverview(appDb, fixture.otherTenantId, who.id),
    ).rejects.toMatchObject({
      status: 404,
    });
  });
});
