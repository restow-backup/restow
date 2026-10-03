/**
 * Postgres-backed tests of the backup jobs routes, through the same Hono routes the web UI calls:
 * create, read, change and delete mail and machine jobs; the validation problems that name the
 * field; the scope (an object or machine in one job, moving, the one job over all objects, overrides);
 * what a machine job writes into `endpoints.config` (and that it writes nothing twice); the
 * refusal to change a machine's configuration by hand once a job owns it; "run now"; the roles;
 * tenant isolation under Row Level Security; and the audit entries written in the same
 * transaction.
 *
 * The routes run on the application role that Row Level Security binds; the suite's own handle is
 * the owner, for fixtures and assertions. Authentication is replaced by a stand-in that admits a
 * role named in a test header, like the other feature suites.
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server as a superuser (the database
 * `restow_api_backup_jobs_test` is recreated there and dropped after, the roles with it).
 */
import { randomBytes, randomUUID } from "node:crypto";
import { defaultEndpointConfig, enrolledEndpointConfig } from "@restow/core";
import {
  type Database,
  auditLog,
  backupJobMembers,
  backupJobs,
  createDb,
  endpointTasks,
  endpoints,
  jobs,
  protectedObjects,
  providers,
  sources,
  tenants,
  user,
} from "@restow/db";
import { and, eq } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import PgBoss from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SessionUser } from "../../auth.js";
import { type Role, type TenantRole, roleSatisfies } from "../../middleware/rbac.js";
import type { TenantEnv } from "../../middleware/session.js";
import { ProblemError } from "../../problem.js";
import { type TestDatabaseRoles, provisionTestRoles } from "../../testing/database-roles.js";
import {
  dropDatabase,
  recreateDatabase,
  testDatabaseAdminUrl,
} from "../snapshots/testing/explorer-fixture.js";
import type {
  BackupJobDto,
  BackupJobListDto,
  BackupJobMembersDto,
  JobCandidatesDto,
  JobDefaultsDto,
  RunBackupJobResult,
} from "./dto.js";

const DATABASE = "restow_api_backup_jobs_test";
const ROLE_HEADER = "x-test-role";
const SESSION_HEADER = "x-test-session-age";
const ZONE = "Europe/Berlin";

interface Problem {
  status: number;
  type?: string;
  field?: string;
  code?: string;
  issues?: { path: string[] }[];
  conflicts?: { targetId: string; jobId: string; jobName: string }[];
}

function stand(minimum: TenantRole, userId: string): MiddlewareHandler<TenantEnv> {
  return async (c, next) => {
    const role = (c.req.header(ROLE_HEADER) ?? "tenant_admin") as Role;
    if (!roleSatisfies(role, minimum)) {
      throw new ProblemError(403, "Insufficient role", {
        detail: `This endpoint requires the ${minimum} role.`,
      });
    }
    c.set("tenantId", c.req.header("x-restow-tenant") ?? "");
    c.set("role", role);
    c.set("user", { id: userId, email: `${role}@contoso.example` } as unknown as SessionUser);
    // A session opened `x-test-session-age` seconds ago with a passkey (the step-up looks at it).
    const age = Number(c.req.header(SESSION_HEADER) ?? "5");
    c.set("auth", {
      session: { createdAt: new Date(Date.now() - age * 1000), authMethod: "passkey" },
    } as never);
    await next();
  };
}

describe.skipIf(!testDatabaseAdminUrl)("backup jobs against Postgres", () => {
  let owner: Database;
  let appDb: Database;
  let roles: TestDatabaseRoles | undefined;
  let app: Hono;
  let contoso: string;
  let fabrikam: string;
  const objects: Record<string, string> = {};
  const machines: Record<string, string> = {};
  let foreignObject: string;
  const adminId = randomUUID();
  const clock = new Date("2026-10-02T10:00:00.000Z");

  beforeAll(async () => {
    const url = await recreateDatabase(testDatabaseAdminUrl as string, DATABASE);
    // The queues exist before the application role is created, as after the worker's first start.
    const boss = new PgBoss({ connectionString: url });
    await boss.start();
    for (const queue of ["backup", "verify"]) {
      // Like the worker's queues: one queued or running job per singleton key.
      await boss.createQueue(queue, { name: queue, policy: "stately" });
    }
    await boss.stop({ graceful: false, wait: true });
    roles = await provisionTestRoles(url);
    process.env.DATABASE_URL = roles.appUrl;
    process.env.DATABASE_PROVIDER_URL = roles.providerUrl;
    process.env.RESTOW_MASTER_KEY = randomBytes(32).toString("base64");
    owner = createDb(url);
    appDb = createDb(roles.appUrl);
    const { buildBackupJobsRoutes } = await import("./routes.js");
    const { errorHandler } = await import("../../problem.js");

    // The administrator who creates jobs is a person (`created_by` points at the account).
    await owner
      .insert(user)
      .values({ id: adminId, name: "Admin", email: "admin@contoso.example", emailVerified: true });
    const [provider] = await owner.insert(providers).values({ name: "Provider" }).returning();
    const made = await owner
      .insert(tenants)
      .values([
        {
          providerId: provider?.id ?? "",
          name: "Contoso",
          slug: "contoso",
          backupJobsMigratedAt: clock,
        },
        {
          providerId: provider?.id ?? "",
          name: "Fabrikam",
          slug: "fabrikam",
          backupJobsMigratedAt: clock,
        },
      ])
      .returning();
    contoso = made[0]?.id ?? "";
    fabrikam = made[1]?.id ?? "";
    const [m365] = await owner
      .insert(sources)
      .values({ tenantId: contoso, kind: "m365", name: "Contoso M365", status: "active" })
      .returning();
    for (const name of ["anna", "ben", "clara", "dora"]) {
      const [row] = await owner
        .insert(protectedObjects)
        .values({
          tenantId: contoso,
          sourceId: m365?.id ?? "",
          kind: "mailbox",
          externalId: `${name}@contoso.example`,
          displayName: name,
        })
        .returning();
      objects[name] = row?.id ?? "";
    }
    // An excluded mailbox and an imported one: neither can be backed up.
    const [excluded] = await owner
      .insert(protectedObjects)
      .values({
        tenantId: contoso,
        sourceId: m365?.id ?? "",
        kind: "mailbox",
        status: "excluded",
        externalId: "ex@contoso.example",
        displayName: "ex",
      })
      .returning();
    objects.excluded = excluded?.id ?? "";
    const [imported] = await owner
      .insert(sources)
      .values({ tenantId: contoso, kind: "import", name: "Imports", status: "active" })
      .returning();
    const [importedObject] = await owner
      .insert(protectedObjects)
      .values({
        tenantId: contoso,
        sourceId: imported?.id ?? "",
        kind: "mailbox",
        externalId: "old@contoso.example",
        displayName: "old",
      })
      .returning();
    objects.imported = importedObject?.id ?? "";
    const [fabrikamSource] = await owner
      .insert(sources)
      .values({ tenantId: fabrikam, kind: "imap", name: "Fabrikam IMAP", status: "active" })
      .returning();
    const [foreign] = await owner
      .insert(protectedObjects)
      .values({
        tenantId: fabrikam,
        sourceId: fabrikamSource?.id ?? "",
        kind: "imap",
        externalId: "ben@fabrikam.example",
      })
      .returning();
    foreignObject = foreign?.id ?? "";
    for (const [name, hooks] of [
      ["web01", "any"],
      ["web02", "any"],
      ["nohooks", "off"],
    ] as const) {
      const [row] = await owner
        .insert(endpoints)
        .values({
          tenantId: contoso,
          hostname: name,
          os: "linux",
          arch: "amd64",
          profile: "server",
          secretHash: randomUUID(),
          config: defaultEndpointConfig("linux", "server", { timeZone: ZONE }),
          settings: { agent: { hooks } },
        })
        .returning();
      machines[name] = row?.id ?? "";
    }

    app = new Hono();
    app.onError((error, c) => {
      // A 500 in a test is a bug: say what it was instead of the generic problem.
      if (!(error instanceof ProblemError)) {
        console.error(error);
      }
      return errorHandler(error, c);
    });
    app.route(
      "/backup-jobs",
      buildBackupJobsRoutes({
        db: appDb,
        requireAdmin: stand("tenant_admin", adminId),
        now: () => clock,
      }),
    );
  }, 60_000);

  afterAll(async () => {
    const shared = await import("../../db.js");
    await Promise.all([shared.db.$client.end(), shared.providerDb.$client.end()]);
    await appDb?.$client.end();
    await owner?.$client.end();
    await dropDatabase(testDatabaseAdminUrl as string, DATABASE);
    await roles?.drop(testDatabaseAdminUrl as string);
  });

  function call(
    method: string,
    path: string,
    options: { tenant?: string; role?: Role; body?: unknown; sessionAge?: number } = {},
  ) {
    const headers: Record<string, string> = {
      "x-restow-tenant": options.tenant ?? contoso,
      [ROLE_HEADER]: options.role ?? "tenant_admin",
      "x-forwarded-for": "192.0.2.10",
    };
    if (options.sessionAge !== undefined) {
      headers[SESSION_HEADER] = String(options.sessionAge);
    }
    if (options.body !== undefined) {
      headers["content-type"] = "application/json";
    }
    return app.request(`/backup-jobs${path}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  }

  async function json<T>(response: Response, status: number): Promise<T> {
    expect(response.status, await response.clone().text()).toBe(status);
    return (await response.json()) as T;
  }

  async function problem(response: Response, status: number): Promise<Problem> {
    expect(response.status, await response.clone().text()).toBe(status);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
    return (await response.json()) as Problem;
  }

  async function audits(action: string, target?: string) {
    const rows = await owner.select().from(auditLog).where(eq(auditLog.action, action));
    return target ? rows.filter((row) => row.target === target) : rows;
  }

  const mailSchedule = { kind: "interval", intervalMinutes: 480, timeZone: ZONE } as const;
  const machineJob = (name: string, ids: string[], extra: Record<string, unknown> = {}) => ({
    kind: "endpoint",
    name,
    schedule: { kind: "daily", timeOfDay: "02:30", timeZone: ZONE },
    scope: { mode: "selected", members: ids.map((id) => ({ id })) },
    settings: { paths: ["/srv", "/data"], excludes: ["*.iso"], bandwidthKbps: 2000 },
    ...extra,
  });

  // -------------------------------------------------------------------------
  // Mail jobs
  // -------------------------------------------------------------------------

  it("creates a mail job with its first runs, lists it and audits it", async () => {
    const job = await json<BackupJobDto>(
      await call("POST", "", {
        body: {
          kind: "mail",
          name: "Management",
          schedule: mailSchedule,
          verifySchedule: { kind: "cron", cron: "0 3 * * 0", timeZone: ZONE },
          scope: { mode: "selected", members: [{ id: objects.anna }, { id: objects.ben }] },
        },
      }),
      201,
    );
    expect(job).toMatchObject({
      kind: "mail",
      name: "Management",
      enabled: true,
      origin: "user",
      scopeMode: "selected",
      schedule: mailSchedule,
      verifySchedule: { kind: "cron", cron: "0 3 * * 0", timeZone: ZONE },
      scope: { count: 2, byKind: { mailbox: 2 }, overrides: 0 },
      // An interval starts at once.
      nextRunAt: "2026-10-02T10:00:00.000Z",
      state: "attention",
      restoreCheck: { total: 2, noBackup: 2, passed: 0 },
      repository: { kind: "installation_default" },
      retention: { policyId: null, keep: null },
    });
    const [entry] = await audits("backup_job.created", job.id);
    expect(entry).toMatchObject({
      tenantId: contoso,
      actorUserId: adminId,
      targetType: "backup_job",
      ip: "192.0.2.10",
    });
    expect(entry?.details).toMatchObject({ kind: "mail", name: "Management", members: 2 });

    const list = await json<BackupJobListDto>(await call("GET", "?kind=mail"), 200);
    expect(list.items.map((item) => item.name)).toContain("Management");
    // The two others are in no job.
    expect(list.uncovered.mail).toBe(2);

    const members = await json<BackupJobMembersDto>(await call("GET", `/${job.id}/members`), 200);
    expect(members.items.map((member) => member.name)).toEqual(["anna", "ben"]);
    expect(members.items[0]).toMatchObject({ covered: true, explicit: true, kind: "mailbox" });
    expect(members.items[0]?.effective.schedule).toMatchObject({ intervalMinutes: 480 });
  });

  it("changes a job, recomputes only the timers it has to and audits what changed", async () => {
    const job = await json<BackupJobDto>(
      await call("POST", "", {
        body: {
          kind: "mail",
          name: "Patched",
          schedule: mailSchedule,
          scope: { mode: "selected", members: [] },
        },
      }),
      201,
    );
    const renamed = await json<BackupJobDto>(
      await call("PATCH", `/${job.id}`, { body: { name: "Patched, renamed" } }),
      200,
    );
    expect(renamed.name).toBe("Patched, renamed");
    // The timer of an untouched schedule stays.
    expect(renamed.nextRunAt).toBeNull();
    const [row] = await owner.select().from(backupJobs).where(eq(backupJobs.id, job.id));
    expect(row?.nextRunAt?.toISOString()).toBe("2026-10-02T10:00:00.000Z");

    const paused = await json<BackupJobDto>(
      await call("PATCH", `/${job.id}`, { body: { enabled: false } }),
      200,
    );
    expect(paused).toMatchObject({ enabled: false, state: "paused" });
    const changed = await json<BackupJobDto>(
      await call("PATCH", `/${job.id}`, {
        body: { enabled: true, schedule: { kind: "daily", timeOfDay: "02:30", timeZone: ZONE } },
      }),
      200,
    );
    // A daily time is stored as its cron expression; the next run is the next 02:30 local time.
    expect(changed.schedule).toEqual({ kind: "cron", cron: "30 2 * * *", timeZone: ZONE });
    const [again] = await owner.select().from(backupJobs).where(eq(backupJobs.id, job.id));
    expect(again?.nextRunAt?.toISOString()).toBe("2026-10-03T00:30:00.000Z");

    const entries = await audits("backup_job.updated", job.id);
    expect(entries).toHaveLength(3);
    expect(entries[0]?.details).toMatchObject({
      changes: { name: { from: "Patched", to: "Patched, renamed" } },
    });
    // Nothing to change: no entry.
    await json<BackupJobDto>(await call("PATCH", `/${job.id}`, { body: { enabled: true } }), 200);
    expect(await audits("backup_job.updated", job.id)).toHaveLength(3);
  });

  it("keeps a job's timers when it is saved with the same schedule written in another way", async () => {
    // The editor sends the whole schedule on every save, the keys in its own order, a cron
    // expression with its own spacing. The stored document is the database's (jsonb keeps keys
    // in its own order): the same schedule must read as unchanged, or every rename resets the timer.
    const job = await json<BackupJobDto>(
      await call("POST", "", {
        body: {
          kind: "mail",
          name: "Same schedule",
          schedule: mailSchedule,
          verifySchedule: { kind: "cron", cron: "0 3 * * 0", timeZone: ZONE },
          scope: { mode: "selected", members: [] },
        },
      }),
      201,
    );
    const nextRun = new Date("2026-10-02T15:00:00.000Z");
    const verifyRun = new Date("2026-10-04T01:00:00.000Z");
    await owner
      .update(backupJobs)
      .set({ nextRunAt: nextRun, verifyNextRunAt: verifyRun })
      .where(eq(backupJobs.id, job.id));

    const saved = await json<BackupJobDto>(
      await call("PATCH", `/${job.id}`, {
        body: {
          name: "Same schedule, renamed",
          // Keys in another order than the database keeps them, spaces inside the cron expression.
          schedule: { timeZone: ZONE, intervalMinutes: 480, kind: "interval" },
          verifySchedule: { timeZone: ZONE, cron: "0  3 * * 0", kind: "cron" },
        },
      }),
      200,
    );
    expect(saved.name).toBe("Same schedule, renamed");
    const [row] = await owner.select().from(backupJobs).where(eq(backupJobs.id, job.id));
    expect(row?.nextRunAt?.toISOString()).toBe(nextRun.toISOString());
    expect(row?.verifyNextRunAt?.toISOString()).toBe(verifyRun.toISOString());
    // The audit entry names the rename and nothing else: the schedules did not change.
    const entries = await audits("backup_job.updated", job.id);
    expect(entries).toHaveLength(1);
    expect(Object.keys((entries[0]?.details as { changes: object }).changes)).toEqual(["name"]);

    // A schedule that does change still starts its timer afresh.
    await json<BackupJobDto>(
      await call("PATCH", `/${job.id}`, {
        body: { schedule: { kind: "interval", intervalMinutes: 240, timeZone: ZONE } },
      }),
      200,
    );
    const [moved] = await owner.select().from(backupJobs).where(eq(backupJobs.id, job.id));
    expect(moved?.nextRunAt?.toISOString()).not.toBe(nextRun.toISOString());
    expect(moved?.verifyNextRunAt?.toISOString()).toBe(verifyRun.toISOString());
  });

  it("refuses unusable jobs with a 422 problem that names the field", async () => {
    const cases: [Record<string, unknown>, string[]][] = [
      [
        { kind: "mail", name: "x", schedule: { kind: "cron", cron: "* * * * *", timeZone: ZONE } },
        ["schedule", "cron"],
      ],
      [
        {
          kind: "mail",
          name: "x",
          schedule: { kind: "interval", intervalMinutes: 5, timeZone: ZONE },
        },
        ["schedule", "intervalMinutes"],
      ],
      [
        {
          kind: "mail",
          name: "x",
          schedule: { kind: "daily", timeOfDay: "25:00", timeZone: ZONE },
        },
        ["schedule", "timeOfDay"],
      ],
      [
        {
          kind: "mail",
          name: "x",
          schedule: { kind: "interval", intervalMinutes: 60, timeZone: "Mars/Base" },
        },
        ["schedule", "timeZone"],
      ],
      [
        { kind: "mail", name: "x", schedule: { kind: "on_connect", timeZone: ZONE } },
        ["schedule", "kind"],
      ],
      [
        {
          kind: "mail",
          name: "x",
          verifySchedule: { kind: "cron", cron: "0 3 * *", timeZone: ZONE },
        },
        ["verifySchedule", "cron"],
      ],
      [{ kind: "mail", name: "x", settings: { paths: ["/srv"] } }, ["settings", "paths"]],
      [{ kind: "mail", name: "x", storageTargetId: randomUUID() }, ["storageTargetId"]],
      [{ kind: "mail", name: "x", retentionPolicyId: randomUUID() }, ["retentionPolicyId"]],
      [
        {
          kind: "mail",
          name: "x",
          scope: { mode: "selected", members: [{ id: objects.imported }] },
        },
        ["scope", "members", "0", "id"],
      ],
      [
        { kind: "mail", name: "x", scope: { mode: "selected", members: [{ id: foreignObject }] } },
        ["scope", "members", "0", "id"],
      ],
      [
        {
          kind: "mail",
          name: "x",
          scope: {
            mode: "selected",
            members: [{ id: objects.anna, overrides: { paths: ["/srv"] } }],
          },
        },
        ["scope", "members", "0", "overrides", "paths"],
      ],
      [
        {
          kind: "mail",
          name: "x",
          scope: { mode: "selected", members: [{ id: objects.dora }, { id: objects.dora }] },
        },
        ["scope", "members", "1", "id"],
      ],
      [machineJob("x", [machines.web01 ?? ""], { schedule: null }), ["schedule"]],
      [machineJob("x", [machines.web01 ?? ""], { settings: {} }), ["settings", "paths"]],
      [
        machineJob("x", [machines.web01 ?? ""], {
          schedule: { kind: "cron", cron: "0 3 * * *", timeZone: ZONE },
        }),
        ["schedule", "kind"],
      ],
      [
        machineJob("x", [machines.web01 ?? ""], {
          verifySchedule: { kind: "interval", intervalMinutes: 60, timeZone: ZONE },
        }),
        ["verifySchedule"],
      ],
      [machineJob("x", [machines.web01 ?? ""], { enabled: false }), ["enabled"]],
      [
        machineJob("x", [machines.web01 ?? ""], { scope: { mode: "all", members: [] } }),
        ["scope", "mode"],
      ],
      [machineJob("x", [randomUUID()]), ["scope", "members", "0", "id"]],
      // Time windows of the bandwidth limit: windows that overlap name the later one, a mail job has none.
      [
        machineJob("x", [machines.web01 ?? ""], {
          settings: {
            paths: ["/srv"],
            bandwidthWindows: [
              { days: [1, 2], from: "08:00", to: "12:00", kbps: 100 },
              { days: [2], from: "11:00", to: "14:00", kbps: 200 },
            ],
          },
        }),
        ["settings", "bandwidthWindows", "1", "window"],
      ],
      [
        machineJob("x", [machines.web01 ?? ""], {
          settings: {
            paths: ["/srv"],
            // Monday night runs into Tuesday morning, where the second window starts.
            bandwidthWindows: [
              { days: [1], from: "22:00", to: "06:00", kbps: 0 },
              { days: [2], from: "05:00", to: "07:00", kbps: 300 },
            ],
          },
        }),
        ["settings", "bandwidthWindows", "1", "window"],
      ],
      [
        { kind: "mail", name: "x", settings: { bandwidthWindows: [] } },
        ["settings", "bandwidthWindows"],
      ],
    ];
    const before = await owner.select().from(backupJobs).where(eq(backupJobs.tenantId, contoso));
    for (const [body, path] of cases) {
      const response = await call("POST", "", { body });
      const found = await problem(response, 422);
      expect(found.issues?.[0]?.path, JSON.stringify(body)).toEqual(path);
      // A shape the schema refuses has no `field`, only its issue path.
      if (found.field !== undefined) {
        expect(found.field, JSON.stringify(body)).toBe(path[0]);
      }
    }
    // Shape failures name the field as well.
    const bad = await problem(await call("POST", "", { body: { kind: "tape", name: "x" } }), 422);
    expect(bad.issues?.[0]?.path).toEqual(["kind"]);
    const settings = await problem(
      await call("POST", "", {
        body: machineJob("x", [], { settings: { paths: ["relative/path"] } }),
      }),
      422,
    );
    expect(settings.issues?.[0]?.path.slice(0, 2)).toEqual(["settings", "paths"]);
    // Nothing was made by any of them.
    const after = await owner.select().from(backupJobs).where(eq(backupJobs.tenantId, contoso));
    expect(after).toHaveLength(before.length);
  });

  it("keeps a name once per tenant and kind", async () => {
    await json<BackupJobDto>(
      await call("POST", "", {
        body: { kind: "mail", name: "Unique name", schedule: mailSchedule },
      }),
      201,
    );
    const taken = await problem(
      await call("POST", "", {
        body: { kind: "mail", name: "unique NAME", schedule: mailSchedule },
      }),
      422,
    );
    expect(taken).toMatchObject({ field: "name", code: "name_taken" });
    // Another tenant is free to use it.
    await json<BackupJobDto>(
      await call("POST", "", { tenant: fabrikam, body: { kind: "mail", name: "Unique name" } }),
      201,
    );
  });

  it("allows one job over all objects, and that job covers what no other job holds", async () => {
    const all = await json<BackupJobDto>(
      await call("POST", "", {
        body: {
          kind: "mail",
          name: "Everything else",
          schedule: mailSchedule,
          scope: { mode: "all", members: [] },
        },
      }),
      201,
    );
    const another = await problem(
      await call("POST", "", {
        body: { kind: "mail", name: "Second all", scope: { mode: "all", members: [] } },
      }),
      409,
    );
    expect(another.type).toBe("urn:restow:problem:backup-job-state");
    // Eligible objects: anna..dora; two of them belong to "Management", the excluded and the
    // imported mailbox are not covered.
    expect(all.scope.count).toBe(2);
    const members = await json<BackupJobMembersDto>(await call("GET", `/${all.id}/members`), 200);
    expect(members.items.map((member) => [member.name, member.explicit, member.covered])).toEqual([
      ["clara", false, true],
      ["dora", false, true],
    ]);
    const list = await json<BackupJobListDto>(await call("GET", "?kind=mail"), 200);
    expect(list.uncovered.mail).toBe(0);
    // Object overrides in an "all" job create the row the first time.
    const overridden = await json<BackupJobDto>(
      await call("PATCH", `/${all.id}/members/${objects.clara}`, {
        body: {
          overrides: { schedule: { kind: "interval", intervalMinutes: 60, timeZone: ZONE } },
        },
      }),
      200,
    );
    expect(overridden.scope.overrides).toBe(1);
    const [row] = await owner
      .select()
      .from(backupJobMembers)
      .where(eq(backupJobMembers.protectedObjectId, objects.clara ?? ""));
    expect(row?.nextRunAt?.toISOString()).toBe("2026-10-02T10:00:00.000Z");
    await call("DELETE", `/${all.id}`);
  });

  it("puts an object in one job at a time: refuses, lists what is in the way, or moves it", async () => {
    const first = await json<BackupJobDto>(
      await call("POST", "", {
        body: {
          kind: "mail",
          name: "Owner",
          scope: { mode: "selected", members: [{ id: objects.dora }] },
        },
      }),
      201,
    );
    const refused = await problem(
      await call("POST", "", {
        body: {
          kind: "mail",
          name: "Taker",
          scope: { mode: "selected", members: [{ id: objects.dora }] },
        },
      }),
      409,
    );
    expect(refused.type).toBe("urn:restow:problem:backup-job-member-in-other-job");
    expect(refused.conflicts).toEqual([
      { targetId: objects.dora, jobId: first.id, jobName: "Owner" },
    ]);
    const moved = await json<BackupJobDto>(
      await call("POST", "", {
        body: {
          kind: "mail",
          name: "Taker",
          moveMembers: true,
          scope: { mode: "selected", members: [{ id: objects.dora }] },
        },
      }),
      201,
    );
    expect(moved.scope.count).toBe(1);
    const after = await json<BackupJobDto>(await call("GET", `/${first.id}`), 200);
    expect(after.scope.count).toBe(0);
    const [entry] = await audits("backup_job.scope.changed", first.id);
    expect(entry?.details).toMatchObject({ removed: 1, movedTo: { id: moved.id, name: "Taker" } });
    // Adding by id to the other job is the same rule.
    const add = await problem(
      await call("POST", `/${first.id}/members`, { body: { members: [{ id: objects.dora }] } }),
      409,
    );
    expect(add.conflicts?.[0]?.jobId).toBe(moved.id);
  });

  it("replaces, adds to and removes from the scope, audited as a change of scope", async () => {
    // Mailboxes of its own: the ones above belong to other jobs by now.
    const [source] = await owner.select().from(sources).where(eq(sources.tenantId, contoso));
    const own: Record<string, string> = {};
    for (const name of ["owen", "pia", "quinn"]) {
      const [row] = await owner
        .insert(protectedObjects)
        .values({
          tenantId: contoso,
          sourceId: source?.id ?? "",
          kind: "mailbox",
          externalId: `${name}@contoso.example`,
          displayName: name,
        })
        .returning();
      own[name] = row?.id ?? "";
    }
    const job = await json<BackupJobDto>(
      await call("POST", "", { body: { kind: "mail", name: "Scope job", schedule: mailSchedule } }),
      201,
    );
    const replaced = await json<BackupJobDto>(
      await call("PUT", `/${job.id}/members`, {
        body: {
          members: [
            { id: own.owen },
            {
              id: own.pia,
              overrides: { verifySchedule: { kind: "cron", cron: "0 3 * * *", timeZone: ZONE } },
            },
          ],
        },
      }),
      200,
    );
    expect(replaced.scope).toMatchObject({ count: 2, overrides: 1 });
    const [first] = await audits("backup_job.scope.changed", job.id);
    expect(first?.details).toMatchObject({ added: 2, removed: 0 });
    const withClara = await json<BackupJobDto>(
      await call("POST", `/${job.id}/members`, { body: { members: [{ id: own.quinn }] } }),
      200,
    );
    expect(withClara.scope.count).toBe(3);
    const smaller = await json<BackupJobDto>(
      await call("DELETE", `/${job.id}/members/${own.owen}`),
      200,
    );
    expect(smaller.scope.count).toBe(2);
    const missing = await problem(await call("DELETE", `/${job.id}/members/${own.owen}`), 404);
    expect(missing.status).toBe(404);
    expect(await audits("backup_job.scope.changed", job.id)).toHaveLength(3);
    // Setting and clearing an override.
    const cleared = await json<BackupJobDto>(
      await call("PATCH", `/${job.id}/members/${own.pia}`, { body: { overrides: {} } }),
      200,
    );
    expect(cleared.scope.overrides).toBe(0);
    const ben = await owner
      .select()
      .from(backupJobMembers)
      .where(eq(backupJobMembers.protectedObjectId, own.pia ?? ""));
    expect(ben[0]?.verifyNextRunAt).toBeNull();
    await call("DELETE", `/${job.id}`);
  });

  it("deletes a job with its members and audits it, leaving the objects alone", async () => {
    const job = await json<BackupJobDto>(
      await call("POST", "", {
        body: {
          kind: "mail",
          name: "To delete",
          scope: { mode: "selected", members: [{ id: objects.clara }] },
        },
      }),
      201,
    );
    const response = await call("DELETE", `/${job.id}`);
    expect(response.status).toBe(204);
    expect(
      await owner.select().from(backupJobMembers).where(eq(backupJobMembers.jobId, job.id)),
    ).toHaveLength(0);
    expect((await problem(await call("GET", `/${job.id}`), 404)).status).toBe(404);
    const [entry] = await audits("backup_job.deleted", job.id);
    expect(entry?.details).toMatchObject({ name: "To delete", members: 1 });
    const [object] = await owner
      .select()
      .from(protectedObjects)
      .where(eq(protectedObjects.id, objects.clara ?? ""));
    expect(object?.status).toBe("active");
  });

  // -------------------------------------------------------------------------
  // Machine jobs
  // -------------------------------------------------------------------------

  async function machine(id: string | undefined) {
    const [row] = await owner
      .select()
      .from(endpoints)
      .where(eq(endpoints.id, id ?? ""));
    return row;
  }

  it("writes the effective configuration into the machines, once, and tells the agent", async () => {
    const before = await machine(machines.web01);
    const job = await json<BackupJobDto>(
      await call("POST", "", {
        body: machineJob("Web servers", [machines.web01 ?? "", machines.web02 ?? ""]),
      }),
      201,
    );
    expect(job).toMatchObject({
      kind: "endpoint",
      scope: { count: 2, byKind: { server: 2 } },
      schedule: { kind: "daily", timeOfDay: "02:30", timeZone: ZONE },
      settings: { paths: ["/srv", "/data"], excludes: ["*.iso"], bandwidthKbps: 2000 },
    });
    const web01 = await machine(machines.web01);
    expect(web01?.config).toMatchObject({
      profile: "server",
      schedule: { kind: "daily", timeOfDay: "02:30", timeZone: ZONE },
      paths: ["/srv", "/data"],
      excludes: ["*.iso"],
      bandwidthKbps: 2000,
    });
    // What no job decides stays as it was.
    expect(web01?.config.onlyOnAcPower).toBe(before?.config.onlyOnAcPower);
    expect(web01?.configVersion).toBe((before?.configVersion ?? 0) + 1);
    const tasks = await owner
      .select()
      .from(endpointTasks)
      .where(
        and(
          eq(endpointTasks.endpointId, machines.web01 ?? ""),
          eq(endpointTasks.kind, "update_config"),
        ),
      );
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.params).toEqual({ configVersion: web01?.configVersion });
    const [entry] = await audits("endpoint.config.changed", machines.web01);
    expect(entry?.details).toMatchObject({
      hostname: "web01",
      via: { job: { id: job.id, name: "Web servers" } },
    });
    // The machine list names the job a machine is in (and none for a machine that is in no job).
    const { listEndpoints } = await import("../endpoints/service.js");
    const listed = await listEndpoints(appDb, contoso);
    expect(listed.items.find((item) => item.id === machines.web01)?.job).toEqual({
      id: job.id,
      name: "Web servers",
    });
    expect(listed.items.find((item) => item.id === machines.nohooks)?.job).toBeNull();
    // The jobs page says how many machines are in no job.
    const overview = await json<BackupJobListDto>(await call("GET", "?kind=endpoint"), 200);
    expect(overview.uncovered.endpoint).toBe(1);
    // Saving the same job again changes nothing: no new version, no task.
    await json<BackupJobDto>(
      await call("PATCH", `/${job.id}`, {
        body: { settings: { paths: ["/srv", "/data"], excludes: ["*.iso"], bandwidthKbps: 2000 } },
      }),
      200,
    );
    expect((await machine(machines.web01))?.configVersion).toBe(web01?.configVersion);
    expect(
      await owner
        .select()
        .from(endpointTasks)
        .where(eq(endpointTasks.endpointId, machines.web01 ?? "")),
    ).toHaveLength(1);
  });

  it("rewrites the members when the job changes, applying overrides on top, and reaches only them", async () => {
    const [job] = await owner.select().from(backupJobs).where(eq(backupJobs.name, "Web servers"));
    const web02Before = await machine(machines.web02);
    // web02 gets a folder of its own; the others keep the job's.
    const withOverride = await json<BackupJobDto>(
      await call("PATCH", `/${job?.id}/members/${machines.web02}`, {
        body: { overrides: { paths: ["/srv", "/var/lib/app"], bandwidthKbps: null } },
      }),
      200,
    );
    expect(withOverride.scope.overrides).toBe(1);
    const web02 = await machine(machines.web02);
    expect(web02?.config).toMatchObject({ paths: ["/srv", "/var/lib/app"], bandwidthKbps: null });
    expect(web02?.configVersion).toBe((web02Before?.configVersion ?? 0) + 1);
    // Changing the job's folders reaches web01; web02's own folders stay.
    await json<BackupJobDto>(
      await call("PATCH", `/${job?.id}`, {
        body: {
          settings: {
            paths: ["/srv"],
            excludes: ["*.iso", "*.vmdk"],
            excludeLargerThanGib: 4,
            bandwidthKbps: 2000,
          },
          schedule: { kind: "interval", intervalMinutes: 120, timeZone: ZONE },
        },
      }),
      200,
    );
    const web01 = await machine(machines.web01);
    expect(web01?.config).toMatchObject({
      paths: ["/srv"],
      excludes: ["*.iso", "*.vmdk"],
      excludeLargerThanBytes: 4 * 1024 ** 3,
      schedule: { kind: "interval", intervalMinutes: 120, timeZone: ZONE },
    });
    expect((await machine(machines.web02))?.config).toMatchObject({
      paths: ["/srv", "/var/lib/app"],
      excludeLargerThanBytes: 4 * 1024 ** 3,
    });
    // A machine outside the job is not touched.
    const outside = await machine(machines.nohooks);
    expect(outside?.configVersion).toBe(1);
    expect(outside?.config.paths).toEqual(
      defaultEndpointConfig("linux", "server", { timeZone: ZONE }).paths,
    );
  });

  it("refuses to change by hand what a job decides and lets the rest through", async () => {
    const { updateEndpoint } = await import("../endpoints/service.js");
    const actor = { label: "admin", userId: adminId, ip: null };
    await expect(
      updateEndpoint(appDb, contoso, machines.web01 ?? "", { config: { paths: ["/etc"] } }, actor),
    ).rejects.toMatchObject({
      status: 409,
      type: "urn:restow:problem:endpoint-config-managed-by-job",
    });
    // The display name, the power switch and the quota are the machine's own.
    const result = await updateEndpoint(
      appDb,
      contoso,
      machines.web01 ?? "",
      { displayName: "Web 01", config: { onlyOnAcPower: true }, settings: { quotaGib: 50 } },
      actor,
    );
    expect(result.changed).toEqual(
      expect.arrayContaining(["displayName", "config.onlyOnAcPower", "settings.quotaGib"]),
    );
    // A machine in no job is still edited by hand.
    const free = await updateEndpoint(
      appDb,
      contoso,
      machines.nohooks ?? "",
      { config: { paths: ["/etc"] } },
      actor,
    );
    expect(free.changed).toContain("config.paths");
  });

  it("checks the machine's hook policy and needs a recent sign-in for a hook", async () => {
    const hooked = machineJob("Hooked", [machines.nohooks ?? ""], {
      settings: { paths: ["/etc"], hooks: { pre: "pg_dump" } },
    });
    // The agent on this machine does not allow hooks from the server.
    const refused = await problem(await call("POST", "", { body: hooked }), 409);
    expect(refused.type).toBe("urn:restow:problem:endpoint-hooks-not-allowed");
    expect(await owner.select().from(backupJobs).where(eq(backupJobs.name, "Hooked"))).toHaveLength(
      0,
    );

    const allowed = machineJob("Hooked", [machines.web02 ?? ""], {
      moveMembers: true,
      settings: { paths: ["/etc"], hooks: { pre: "pg_dump" } },
    });
    // An old session is asked to confirm it is the person; nothing is written.
    const stale = await problem(await call("POST", "", { body: allowed, sessionAge: 3600 }), 403);
    expect(stale.type).toBe("urn:restow:problem:recent-sign-in-required");
    expect(await owner.select().from(backupJobs).where(eq(backupJobs.name, "Hooked"))).toHaveLength(
      0,
    );
    const before = await machine(machines.web02);
    const job = await json<BackupJobDto>(
      await call("POST", "", { body: allowed, sessionAge: 30 }),
      201,
    );
    expect((await machine(machines.web02))?.config.hooks).toEqual({ pre: "pg_dump" });
    // The audit entry records that hooks changed, never their text.
    const [entry] = await audits("endpoint.config.changed", machines.web02);
    expect(JSON.stringify(entry?.details)).not.toContain("pg_dump");
    expect(before?.configVersion).toBeLessThan((await machine(machines.web02))?.configVersion ?? 0);
    expect(JSON.stringify((await audits("backup_job.created", job.id))[0]?.details)).not.toContain(
      "pg_dump",
    );
  });

  it("runs a machine job now: one request per member, once", async () => {
    const [job] = await owner.select().from(backupJobs).where(eq(backupJobs.name, "Web servers"));
    const first = await json<RunBackupJobResult>(
      await call("POST", `/${job?.id}/run`, { body: {} }),
      202,
    );
    expect(first.queued).toBeGreaterThanOrEqual(1);
    const tasks = await owner
      .select()
      .from(endpointTasks)
      .where(and(eq(endpointTasks.kind, "backup_now"), eq(endpointTasks.tenantId, contoso)));
    expect(tasks.length).toBe(first.queued);
    const again = await json<RunBackupJobResult>(await call("POST", `/${job?.id}/run`), 202);
    expect(again.queued).toBe(0);
    expect(again.skipped.every((skip) => skip.reason === "already_queued")).toBe(true);
    // The request shows until the machine starts it: as queued backup of the members and the job.
    const queuedMembers = await json<BackupJobMembersDto>(
      await call("GET", `/${job?.id}/members`),
      200,
    );
    const waiting = queuedMembers.items.filter((member) => member.pendingBackup);
    expect(waiting.length).toBe(first.queued);
    for (const member of waiting) {
      expect(member.pendingBackup?.status).toBe("pending");
      if (member.lastBackup.outcome !== "running") {
        expect(member.lastBackup.outcome).toBe("queued");
      }
    }
    const queuedJob = await json<BackupJobDto>(await call("GET", `/${job?.id}`), 200);
    expect(queuedJob.lastRun.queued).toBeGreaterThanOrEqual(0);
    const outside = await json<RunBackupJobResult>(
      await call("POST", `/${job?.id}/run`, { body: { targetIds: [machines.nohooks] } }),
      202,
    );
    expect(outside.skipped).toEqual([
      { targetId: machines.nohooks, name: "nohooks", reason: "not_in_job" },
    ]);
    const [entry] = await audits("backup_job.run_requested", job?.id);
    expect(entry?.details).toMatchObject({ kind: "endpoint", queued: first.queued });
  });

  // -------------------------------------------------------------------------
  // Run now (mail), reads, roles, isolation
  // -------------------------------------------------------------------------

  it("runs a mail job now for the chosen members and says why others were skipped", async () => {
    const job = await json<BackupJobDto>(
      await call("POST", "", {
        body: {
          kind: "mail",
          name: "Run me",
          schedule: mailSchedule,
          scope: { mode: "selected", members: [{ id: objects.clara }, { id: objects.excluded }] },
        },
      }),
      201,
    );
    const result = await json<RunBackupJobResult>(
      await call("POST", `/${job.id}/run`, {
        body: { targetIds: [objects.clara, objects.excluded, objects.ben] },
      }),
      202,
    );
    expect(result.queued).toBe(1);
    expect(result.skipped).toEqual([
      { targetId: objects.excluded, name: "ex", reason: "excluded" },
      { targetId: objects.ben, name: "ben", reason: "not_in_job" },
    ]);
    const queued = await owner
      .select()
      .from(jobs)
      .where(eq(jobs.protectedObjectId, objects.clara ?? ""));
    expect(queued).toHaveLength(1);
    expect(queued[0]?.payload).toMatchObject({
      backupJobId: job.id,
      protectedObjectId: objects.clara,
    });
    // The same object again is already queued.
    const twice = await json<RunBackupJobResult>(
      await call("POST", `/${job.id}/run`, { body: { targetIds: [objects.clara] } }),
      202,
    );
    expect(twice).toEqual({
      queued: 0,
      skipped: [{ targetId: objects.clara, name: "clara", reason: "already_queued" }],
    });
    expect(await audits("backup_job.run_requested", job.id)).toHaveLength(2);
    const runs = await json<{ items: { id: string; source: string; type: string }[] }>(
      await call("GET", `/${job.id}/runs`),
      200,
    );
    expect(runs.items.map((run) => [run.source, run.type])).toEqual([["mail", "backup"]]);
  });

  it("offers the editor its defaults and the objects and machines to pick", async () => {
    const mail = await json<JobDefaultsDto>(await call("GET", "/defaults?kind=mail"), 200);
    expect(mail).toMatchObject({
      kind: "mail",
      schedule: { kind: "interval", intervalMinutes: 480 },
      verifySchedule: { kind: "cron", cron: "0 3 * * 0" },
      repository: { kind: "installation_default" },
    });
    const endpoint = await json<JobDefaultsDto>(await call("GET", "/defaults?kind=endpoint"), 200);
    expect(endpoint.schedule).toMatchObject({ kind: "daily" });
    expect(endpoint.settings.paths?.length).toBeGreaterThan(0);
    expect(endpoint.endpointRetention).toEqual({ keepDaily: 30, keepWeekly: 12, keepMonthly: 12 });

    const candidates = await json<JobCandidatesDto>(
      await call("GET", "/candidates?kind=mail&q=AN"),
      200,
    );
    expect(candidates.items.map((item) => item.name)).toEqual(["anna"]);
    // Excluded and imported mailboxes cannot be picked.
    const all = await json<JobCandidatesDto>(await call("GET", "/candidates?kind=mail"), 200);
    expect(all.items.map((item) => item.name)).not.toContain("ex");
    expect(all.items.map((item) => item.name)).not.toContain("old");
    expect(all.items.find((item) => item.name === "anna")?.job?.name).toBe("Management");
    const machinesList = await json<JobCandidatesDto>(
      await call("GET", "/candidates?kind=endpoint"),
      200,
    );
    // web01 got a display name from the hand-made change above.
    expect(machinesList.items.map((item) => item.name).sort()).toEqual([
      "Web 01",
      "nohooks",
      "web02",
    ]);
    expect(machinesList.items.find((item) => item.name === "Web 01")?.job?.name).toBe(
      "Web servers",
    );
  });

  it("is for administrators, and a tenant never sees another tenant's jobs", async () => {
    const [mine] = await owner.select().from(backupJobs).where(eq(backupJobs.name, "Management"));
    expect((await call("GET", "", { role: "tenant_user" })).status).toBe(403);
    expect(
      (await call("POST", "", { role: "tenant_user", body: { kind: "mail", name: "x" } })).status,
    ).toBe(403);
    expect((await call("GET", `/${mine?.id}`, { tenant: fabrikam })).status).toBe(404);
    expect(
      (await call("PATCH", `/${mine?.id}`, { tenant: fabrikam, body: { name: "stolen" } })).status,
    ).toBe(404);
    expect((await call("DELETE", `/${mine?.id}`, { tenant: fabrikam })).status).toBe(404);
    expect((await call("POST", `/${mine?.id}/run`, { tenant: fabrikam })).status).toBe(404);
    const theirs = await json<BackupJobListDto>(await call("GET", "", { tenant: fabrikam }), 200);
    expect(theirs.items.map((item) => item.name)).toEqual(["Unique name"]);
    // An object of the other tenant cannot be put into a job.
    const cross = await problem(
      await call("POST", "", {
        tenant: fabrikam,
        body: {
          kind: "mail",
          name: "Cross",
          scope: { mode: "selected", members: [{ id: objects.anna }] },
        },
      }),
      422,
    );
    expect(cross.issues?.[0]?.path).toEqual(["scope", "members", "0", "id"]);
  });

  it("masks hook texts for a viewer who may not change the configuration", async () => {
    const { visibleSettings } = await import("./service.js");
    expect(
      visibleSettings({ paths: ["/a"], hooks: { pre: "secret", post: "also" } }, false),
    ).toEqual({
      paths: ["/a"],
      hooks: { pre: "********", post: "********" },
    });
    expect(visibleSettings({ hooks: { pre: "secret" } }, true)).toEqual({
      hooks: { pre: "secret" },
    });
  });
  // -------------------------------------------------------------------------
  // Bandwidth windows
  // -------------------------------------------------------------------------

  describe("bandwidth windows", () => {
    const office = { days: [1, 2, 3, 4, 5], from: "08:00", to: "18:00", kbps: 2000 };
    const night = { days: [5, 1, 3, 2, 4], from: "22:00", to: "06:00", kbps: 0 };
    // Friday's night window ends at 06:00 on Saturday, so the weekend's starts there.
    const weekend = { days: [7, 6], from: "06:00", to: "22:00", kbps: 8000 };
    let id = "";
    let jobId = "";

    const windowed = (extra: Record<string, unknown> = {}) =>
      machineJob("Night owls", [id], {
        settings: {
          paths: ["/srv"],
          bandwidthKbps: 500,
          bandwidthWindows: [night, office],
          ...extra,
        },
      });

    const tasksOf = async () =>
      owner.select().from(endpointTasks).where(eq(endpointTasks.endpointId, id));

    beforeAll(async () => {
      const [row] = await owner
        .insert(endpoints)
        .values({
          tenantId: contoso,
          hostname: "night01",
          os: "linux",
          arch: "amd64",
          profile: "server",
          secretHash: randomUUID(),
          config: defaultEndpointConfig("linux", "server", { timeZone: ZONE }),
          settings: { agent: { hooks: "any" } },
        })
        .returning();
      id = row?.id ?? "";
    });

    afterAll(async () => {
      // The machine goes again, so no other test sees a machine it does not know.
      await owner.delete(backupJobMembers).where(eq(backupJobMembers.endpointId, id));
      await owner.delete(endpointTasks).where(eq(endpointTasks.endpointId, id));
      await owner.delete(endpoints).where(eq(endpoints.id, id));
    });

    it("stores the windows of a job in their normal order and writes them into the machine", async () => {
      const job = await json<BackupJobDto>(await call("POST", "", { body: windowed() }), 201);
      jobId = job.id;
      // Days sorted, windows in the order of the week: the night window starts on Monday at 22:00, the office window at 08:00.
      expect(job.settings).toMatchObject({
        bandwidthKbps: 500,
        bandwidthWindows: [
          { days: [1, 2, 3, 4, 5], from: "08:00", to: "18:00", kbps: 2000 },
          { days: [1, 2, 3, 4, 5], from: "22:00", to: "06:00", kbps: 0 },
        ],
      });
      const written = await machine(id);
      expect(written?.config).toMatchObject({
        bandwidthKbps: 500,
        bandwidthWindows: job.settings.bandwidthWindows,
        schedule: { kind: "daily", timeOfDay: "02:30", timeZone: ZONE },
      });
      expect(written?.configVersion).toBe(2);
      expect(await tasksOf()).toHaveLength(1);
    });

    it("writes nothing when the same windows are saved again, in another order or spelling", async () => {
      const before = await machine(id);
      await json<BackupJobDto>(
        await call("PATCH", `/${jobId}`, {
          body: {
            settings: {
              paths: ["/srv"],
              bandwidthKbps: 500,
              bandwidthWindows: [
                { ...night, days: [1, 2, 3, 4, 5] },
                { ...office, days: [5, 4, 3, 2, 1] },
              ],
            },
          },
        }),
        200,
      );
      const after = await machine(id);
      expect(after?.configVersion).toBe(before?.configVersion);
      expect(after?.config).toEqual(before?.config);
      expect(await tasksOf()).toHaveLength(1);
    });

    it("changes the machine, with a new version and a task, only when the windows change", async () => {
      const before = await machine(id);
      const changed = await json<BackupJobDto>(
        await call("PATCH", `/${jobId}`, {
          body: {
            settings: {
              paths: ["/srv"],
              bandwidthKbps: 500,
              bandwidthWindows: [office, night, weekend],
            },
          },
        }),
        200,
      );
      expect(changed.settings.bandwidthWindows).toHaveLength(3);
      const after = await machine(id);
      expect(after?.configVersion).toBe((before?.configVersion ?? 0) + 1);
      expect(after?.config.bandwidthWindows).toHaveLength(3);
      expect(await tasksOf()).toHaveLength(2);
      const [entry] = (await audits("endpoint.config.changed", id)).slice(-1);
      expect(entry?.details).toMatchObject({ changed: ["config.bandwidthWindows"] });
      // The job's own audit entry says what the job looked like, windows included.
      const [updated] = (await audits("backup_job.updated", jobId)).slice(-1);
      expect(JSON.stringify(updated?.details)).toContain("bandwidthWindows");
    });

    it("follows the time zone of the schedule, which is the job's to change", async () => {
      const before = await machine(id);
      await json<BackupJobDto>(
        await call("PATCH", `/${jobId}`, {
          body: { schedule: { kind: "on_connect", intervalMinutes: 240, timeZone: "Asia/Tokyo" } },
        }),
        200,
      );
      const after = await machine(id);
      expect(after?.config.schedule).toMatchObject({ kind: "on_connect", timeZone: "Asia/Tokyo" });
      // The windows themselves did not move: they are read in the new zone from now on.
      expect(after?.config.bandwidthWindows).toEqual(before?.config.bandwidthWindows);
    });

    it("refuses windows that cannot be saved, naming the window and its field, and changes nothing", async () => {
      const before = await machine(id);
      const refuse = async (windows: unknown[], path: string[], code?: string) => {
        const found = await problem(
          await call("PATCH", `/${jobId}`, {
            body: { settings: { paths: ["/srv"], bandwidthWindows: windows } },
          }),
          422,
        );
        // A shape the schema refuses names the window by number, a rule of the service by text.
        expect(found.issues?.[0]?.path.map(String), JSON.stringify(windows)).toEqual(path);
        if (code) {
          expect(found.code).toBe(code);
        }
      };
      await refuse(
        [office, { ...night, days: [2], from: "17:00", to: "19:00" }],
        ["settings", "bandwidthWindows", "1", "window"],
        "bandwidth_window_overlap",
      );
      // The week wraps: Sunday night runs into Monday morning.
      await refuse(
        [
          { days: [7], from: "22:00", to: "06:00", kbps: 0 },
          { days: [1], from: "05:59", to: "07:00", kbps: 100 },
        ],
        ["settings", "bandwidthWindows", "1", "window"],
        "bandwidth_window_overlap",
      );
      await refuse([{ ...office, days: [] }], ["settings", "bandwidthWindows", "0", "days"]);
      await refuse([{ ...office, from: "8:00" }], ["settings", "bandwidthWindows", "0", "from"]);
      await refuse([{ ...office, kbps: -5 }], ["settings", "bandwidthWindows", "0", "kbps"]);
      // Windows that touch are fine.
      await json<BackupJobDto>(
        await call("PATCH", `/${jobId}`, {
          body: {
            settings: {
              paths: ["/srv"],
              bandwidthKbps: 500,
              bandwidthWindows: [
                { days: [1], from: "08:00", to: "12:00", kbps: 100 },
                { days: [1], from: "12:00", to: "18:00", kbps: 200 },
              ],
            },
          },
        }),
        200,
      );
      expect((await machine(id))?.config.bandwidthWindows).toHaveLength(2);
      // The refusals changed nothing before that last, good save.
      expect(before?.config.bandwidthWindows).toHaveLength(3);
    });

    it("takes the limit and the windows of a member as one setting", async () => {
      const own = { days: [6, 7], from: "06:00", to: "22:00", kbps: 4000 };
      const set = async (overrides: Record<string, unknown>) =>
        json<BackupJobDto>(
          await call("PATCH", `/${jobId}/members/${id}`, { body: { overrides } }),
          200,
        );
      // A limit of its own, as one was written before windows existed, leaves the job's windows out.
      await set({ bandwidthKbps: 100 });
      expect((await machine(id))?.config).toMatchObject({ bandwidthKbps: 100 });
      expect((await machine(id))?.config.bandwidthWindows).toBeUndefined();
      // Its own limit and windows.
      await set({ bandwidthKbps: 100, bandwidthWindows: [own] });
      expect((await machine(id))?.config).toMatchObject({
        bandwidthKbps: 100,
        bandwidthWindows: [own],
      });
      // Windows alone keep the job's default limit.
      await set({ bandwidthWindows: [own] });
      expect((await machine(id))?.config).toMatchObject({
        bandwidthKbps: 500,
        bandwidthWindows: [own],
      });
      // "No windows" stated next to its own limit, and an unlimited machine.
      await set({ bandwidthKbps: null, bandwidthWindows: [] });
      const unlimited = await machine(id);
      expect(unlimited?.config.bandwidthKbps).toBeNull();
      expect(unlimited?.config.bandwidthWindows).toBeUndefined();
      // Its windows are checked like the job's.
      const refused = await problem(
        await call("PATCH", `/${jobId}/members/${id}`, {
          body: {
            overrides: {
              bandwidthWindows: [own, { ...own, days: [7], from: "20:00", to: "23:00" }],
            },
          },
        }),
        422,
      );
      expect(refused.issues?.[0]?.path).toEqual(["overrides", "bandwidthWindows", "1", "window"]);
      // Without an override the machine runs the job's limit and windows again.
      await set({});
      expect((await machine(id))?.config).toMatchObject({
        bandwidthKbps: 500,
        bandwidthWindows: [
          { days: [1], from: "08:00", to: "12:00", kbps: 100 },
          { days: [1], from: "12:00", to: "18:00", kbps: 200 },
        ],
      });
    });

    it("leaves no windows behind when the job has none, and refuses to change them by hand while a job owns them", async () => {
      const { updateEndpoint } = await import("../endpoints/service.js");
      const actor = { label: "admin", userId: adminId, ip: null };
      await expect(
        updateEndpoint(appDb, contoso, id, { config: { bandwidthWindows: [office] } }, actor),
      ).rejects.toMatchObject({
        status: 409,
        type: "urn:restow:problem:endpoint-config-managed-by-job",
      });
      await json<BackupJobDto>(
        await call("PATCH", `/${jobId}`, {
          body: { settings: { paths: ["/srv"], bandwidthKbps: 500 } },
        }),
        200,
      );
      expect((await machine(id))?.config.bandwidthWindows).toBeUndefined();
      expect("bandwidthWindows" in ((await machine(id))?.config ?? {})).toBe(false);
    });

    it("lets a machine without a job set, change and remove its own windows, checked like a job's", async () => {
      const { updateEndpoint } = await import("../endpoints/service.js");
      const actor = { label: "admin", userId: adminId, ip: null };
      // Leave the job: the machine waits for another (no schedule); the rest of its configuration
      // stays its own.
      expect((await call("DELETE", `/${jobId}`)).status).toBe(204);
      // It keeps the time zone the job gave it (set to Asia/Tokyo by a test above).
      expect((await machine(id))?.config.schedule).toMatchObject({ kind: "none" });
      const free = await updateEndpoint(
        appDb,
        contoso,
        id,
        { config: { bandwidthWindows: [night, office] } },
        actor,
      );
      expect(free.changed).toEqual(["config.bandwidthWindows"]);
      expect((await machine(id))?.config.bandwidthWindows).toEqual([
        { days: [1, 2, 3, 4, 5], from: "08:00", to: "18:00", kbps: 2000 },
        { days: [1, 2, 3, 4, 5], from: "22:00", to: "06:00", kbps: 0 },
      ]);
      // The same windows again change nothing.
      expect(
        (
          await updateEndpoint(
            appDb,
            contoso,
            id,
            { config: { bandwidthWindows: [office, night] } },
            actor,
          )
        ).changed,
      ).toEqual([]);
      await expect(
        updateEndpoint(
          appDb,
          contoso,
          id,
          { config: { bandwidthWindows: [office, { ...office, from: "17:00", to: "19:00" }] } },
          actor,
        ),
      ).rejects.toMatchObject({
        status: 422,
        type: "urn:restow:problem:endpoint-invalid-bandwidth-windows",
        extensions: { issues: [{ path: ["config", "bandwidthWindows", "1", "window"] }] },
      });
      const removed = await updateEndpoint(
        appDb,
        contoso,
        id,
        { config: { bandwidthWindows: null } },
        actor,
      );
      expect(removed.changed).toEqual(["config.bandwidthWindows"]);
      expect("bandwidthWindows" in ((await machine(id))?.config ?? {})).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // A machine in no job (release 0.2.1)
  // -------------------------------------------------------------------------

  describe("a machine in no job", () => {
    it("backs up only through a job, and stops again when it leaves it", async () => {
      const service = await import("../endpoints/service.js");
      const actor = { label: "admin", userId: adminId, ip: null };
      const [row] = await owner
        .insert(endpoints)
        .values({
          tenantId: contoso,
          hostname: "fresh01",
          os: "linux",
          arch: "amd64",
          profile: "server",
          secretHash: randomUUID(),
          config: enrolledEndpointConfig("linux", "server", { timeZone: ZONE }),
          settings: { agent: { hooks: "off" } },
        })
        .returning();
      const id = row?.id ?? "";
      const noJob = { status: 409, type: "urn:restow:problem:endpoint-no-job" };
      // No backup on request and no schedule by hand; `none` and the folders are accepted.
      await expect(
        service.createTask(appDb, contoso, id, { kind: "backup_now" }, actor),
      ).rejects.toMatchObject(noJob);
      await expect(
        service.updateEndpoint(
          appDb,
          contoso,
          id,
          { config: { schedule: { kind: "daily", timeOfDay: "01:00", timeZone: ZONE } } },
          actor,
        ),
      ).rejects.toMatchObject(noJob);
      const kept = await service.updateEndpoint(
        appDb,
        contoso,
        id,
        { config: { schedule: { kind: "none", timeZone: ZONE }, paths: ["/etc", "/srv"] } },
        actor,
      );
      expect(kept.changed).toEqual(["config.paths"]);
      // The list does not call it healthy.
      const listed = await service.listEndpoints(appDb, contoso);
      expect(listed.items.find((item) => item.id === id)).toMatchObject({
        job: null,
        attention: ["never_seen", "no_job"],
      });

      // In a job, the job's schedule reaches the machine, with a new version for the agent.
      const job = await json<BackupJobDto>(
        await call("POST", "", { body: machineJob("Fresh", [id]) }),
        201,
      );
      const started = await machine(id);
      expect(started?.config.schedule).toEqual({
        kind: "daily",
        timeOfDay: "02:30",
        timeZone: ZONE,
      });
      expect(started?.configVersion).toBe(3);
      await service.createTask(appDb, contoso, id, { kind: "backup_now" }, actor);

      // Taken out of the job, it waits again: schedule `none`, a new version, the waiting request
      // dropped; its folders stay for the next job.
      await json<BackupJobDto>(await call("DELETE", `/${job.id}/members/${id}`), 200);
      const stopped = await machine(id);
      expect(stopped?.config.schedule).toEqual({ kind: "none", timeZone: ZONE });
      expect(stopped?.config.paths).toEqual(["/srv", "/data"]);
      expect(stopped?.configVersion).toBe(4);
      const tasks = await owner
        .select()
        .from(endpointTasks)
        .where(eq(endpointTasks.endpointId, id));
      expect(
        tasks.filter((task) => task.kind === "update_config").map((task) => task.params),
      ).toContainEqual({ configVersion: 4 });
      expect(tasks.find((task) => task.kind === "backup_now")).toMatchObject({
        status: "failed",
        errorMessage: "the machine left its backup job",
      });
      const entries = await audits("endpoint.config.changed", id);
      expect(entries.map((entry) => entry.details)).toContainEqual(
        expect.objectContaining({
          changed: ["config.schedule"],
          via: { job: { id: job.id, name: "Fresh" }, left: true },
        }),
      );

      // Back in through the scope, out through a scope without it.
      await json<BackupJobDto>(
        await call("PUT", `/${job.id}/members`, { body: { members: [{ id }] } }),
        200,
      );
      expect((await machine(id))?.config.schedule.kind).toBe("daily");
      await json<BackupJobDto>(
        await call("PUT", `/${job.id}/members`, { body: { members: [] } }),
        200,
      );
      expect((await machine(id))?.config.schedule.kind).toBe("none");

      // Added again, then the job is deleted: waiting again.
      await json<BackupJobDto>(
        await call("POST", `/${job.id}/members`, { body: { members: [{ id }] } }),
        200,
      );
      expect((await machine(id))?.config.schedule.kind).toBe("daily");
      expect((await call("DELETE", `/${job.id}`)).status).toBe(204);
      expect((await machine(id))?.config.schedule.kind).toBe("none");
    });

    it("moves a machine from one job to another without a pause in between", async () => {
      const [row] = await owner
        .insert(endpoints)
        .values({
          tenantId: contoso,
          hostname: "fresh02",
          os: "linux",
          arch: "amd64",
          profile: "server",
          secretHash: randomUUID(),
          config: enrolledEndpointConfig("linux", "server", { timeZone: ZONE }),
          settings: { agent: { hooks: "off" } },
        })
        .returning();
      const id = row?.id ?? "";
      await json<BackupJobDto>(await call("POST", "", { body: machineJob("First", [id]) }), 201);
      await json<BackupJobDto>(
        await call("POST", "", {
          body: machineJob("Second", [id], {
            moveMembers: true,
            schedule: { kind: "interval", intervalMinutes: 60, timeZone: ZONE },
          }),
        }),
        201,
      );
      expect((await machine(id))?.config.schedule).toEqual({
        kind: "interval",
        intervalMinutes: 60,
        timeZone: ZONE,
      });
    });
  });
});
