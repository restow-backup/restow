/**
 * Postgres-backed tests of the schedules surface, through the same Hono routes
 * the web UI calls: CRUD with next runs computed by the shared @restow/core
 * code, 422 problems naming the field, the read-only view of tenant users,
 * tenant isolation under Row Level Security, audit entries written in the same
 * transaction as the change, the last job of a run and the idempotent
 * "apply recommended schedules".
 *
 * The routes run on the application role that Row Level Security binds
 * (src/testing/database-roles.ts); the suite's own handle is the owner, for
 * fixtures and assertions. Authentication is replaced by a stand-in that
 * admits a role named in a test header and refuses a role below the route's
 * minimum exactly like requireTenant does.
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server as a
 * superuser (the database `restow_api_schedules_test` is recreated there and
 * dropped after, the roles with it). Without it the suite is skipped.
 */
import { randomBytes, randomUUID } from "node:crypto";
import {
  type Database,
  auditLog,
  backupJobs,
  createDb,
  jobs,
  protectedObjects,
  providers,
  schedules,
  sources,
  tenants,
} from "@restow/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
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
import type { ScheduleDto, ScheduleListDto } from "./service.js";

const DATABASE = "restow_api_schedules_test";
const ROLE_HEADER = "x-test-role";

/** Stand-in for requireTenant(minimum): the role comes from a header, the tenant from X-Restow-Tenant. */
function testTenantAccess(minimum: TenantRole, userId: string): MiddlewareHandler<TenantEnv> {
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
    await next();
  };
}

interface Problem {
  status: number;
  type?: string;
  field?: string;
  code?: string;
  issues?: { path: string[] }[];
}

describe.skipIf(!testDatabaseAdminUrl)("schedules against Postgres", () => {
  let owner: Database;
  let appDb: Database;
  let roles: TestDatabaseRoles | undefined;
  let app: Hono;
  let contoso: string;
  let fabrikam: string;
  let mailboxId: string;
  let foreignMailboxId: string;
  let m365SourceId: string;
  const adminId = randomUUID();
  let clock = new Date("2026-03-04T10:00:00.000Z");

  beforeAll(async () => {
    const url = await recreateDatabase(testDatabaseAdminUrl as string, DATABASE);
    roles = await provisionTestRoles(url);
    // The API's shared handles and configuration read the environment on import.
    process.env.DATABASE_URL = roles.appUrl;
    process.env.DATABASE_PROVIDER_URL = roles.providerUrl;
    process.env.RESTOW_MASTER_KEY = randomBytes(32).toString("base64");
    owner = createDb(url);
    appDb = createDb(roles.appUrl);

    const { buildSchedulesRoutes } = await import("./routes.js");
    const { errorHandler } = await import("../../problem.js");

    const [provider] = await owner.insert(providers).values({ name: "Provider" }).returning();
    const created = await owner
      .insert(tenants)
      .values([
        { providerId: provider?.id ?? "", name: "Contoso", slug: "contoso" },
        { providerId: provider?.id ?? "", name: "Fabrikam", slug: "fabrikam" },
      ])
      .returning();
    contoso = created[0]?.id ?? "";
    fabrikam = created[1]?.id ?? "";
    const [m365] = await owner
      .insert(sources)
      .values({ tenantId: contoso, kind: "m365", name: "Contoso M365", status: "active" })
      .returning();
    m365SourceId = m365?.id ?? "";
    const [imap] = await owner
      .insert(sources)
      .values({ tenantId: fabrikam, kind: "imap", name: "Fabrikam IMAP", status: "active" })
      .returning();
    const [mailbox] = await owner
      .insert(protectedObjects)
      .values({
        tenantId: contoso,
        sourceId: m365?.id ?? "",
        kind: "mailbox",
        externalId: "anna@contoso.example",
        displayName: "Anna Berg",
      })
      .returning();
    mailboxId = mailbox?.id ?? "";
    const [foreign] = await owner
      .insert(protectedObjects)
      .values({
        tenantId: fabrikam,
        sourceId: imap?.id ?? "",
        kind: "imap",
        externalId: "ben@fabrikam.example",
      })
      .returning();
    foreignMailboxId = foreign?.id ?? "";

    app = new Hono();
    app.onError(errorHandler);
    app.route(
      "/schedules",
      buildSchedulesRoutes({
        db: appDb,
        requireReader: testTenantAccess("tenant_user", adminId),
        requireAdmin: testTenantAccess("tenant_admin", adminId),
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
    options: { tenant?: string; role?: Role; body?: unknown } = {},
  ) {
    const headers: Record<string, string> = {
      "x-restow-tenant": options.tenant ?? contoso,
      [ROLE_HEADER]: options.role ?? "tenant_admin",
      "x-forwarded-for": "192.0.2.10",
    };
    if (options.body !== undefined) {
      headers["content-type"] = "application/json";
    }
    return app.request(`/schedules${path}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  }

  async function auditEntries(action: string, target: string) {
    return owner
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, action), eq(auditLog.target, target)));
  }

  async function create(body: Record<string, unknown>, tenant = contoso): Promise<ScheduleDto> {
    const response = await call("POST", "", { body, tenant });
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as ScheduleDto;
  }

  /**
   * A backup or verify schedule an older release made: the API no longer makes them (they are
   * jobs now), so the fixtures write the rows themselves, as an installation that is moved to
   * jobs still has them.
   */
  async function legacy(values: {
    kind: "backup" | "verify";
    tenantId?: string;
    protectedObjectId?: string;
    intervalMinutes?: number;
    cron?: string;
    supersededByJobId?: string;
  }): Promise<string> {
    const [row] = await owner
      .insert(schedules)
      .values({
        tenantId: values.tenantId ?? contoso,
        kind: values.kind,
        protectedObjectId: values.protectedObjectId ?? null,
        intervalMinutes: values.intervalMinutes ?? null,
        cron: values.cron ?? null,
        timezone: "Europe/Berlin",
        supersededByJobId: values.supersededByJobId ?? null,
        nextRunAt: clock,
      })
      .returning();
    return row?.id ?? "";
  }

  it("creates schedules with their first run and audits each one", async () => {
    const directory = await create({ kind: "directory", intervalMinutes: 480 });
    expect(directory).toMatchObject({
      kind: "directory",
      protectedObject: null,
      intervalMinutes: 480,
      cron: null,
      timezone: "Europe/Berlin",
      enabled: true,
      supersededByJobId: null,
      // An interval starts at once.
      nextRunAt: "2026-03-04T10:00:00.000Z",
      lastRunAt: null,
      lastJob: null,
    });

    const scrub = await create({ kind: "scrub", cron: "0 3 * * 0", timezone: "Europe/Berlin" });
    expect(scrub.nextRunAt).toBe("2026-03-08T02:00:00.000Z");

    const [entry] = await auditEntries("schedule.created", scrub.id);
    expect(entry).toMatchObject({
      tenantId: contoso,
      actorUserId: adminId,
      targetType: "schedule",
      ip: "192.0.2.10",
    });
    expect(entry?.details).toMatchObject({
      kind: "scrub",
      cron: "0 3 * * 0",
      timezone: "Europe/Berlin",
    });
    await call("DELETE", `/${scrub.id}`);
  });

  it("makes no backup or restore-check schedule any more: those are jobs", async () => {
    for (const kind of ["backup", "verify"]) {
      const response = await call("POST", "", { body: { kind, intervalMinutes: 480 } });
      expect(response.status).toBe(422);
      const problem = (await response.json()) as Problem;
      expect(problem).toMatchObject({ field: "kind", code: "kind_replaced_by_jobs" });
    }
    const rows = await owner
      .select()
      .from(schedules)
      .where(and(eq(schedules.tenantId, contoso), inArray(schedules.kind, ["backup", "verify"])));
    expect(rows).toEqual([]);
  });

  it("refuses unusable schedules with a 422 problem naming the field", async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ kind: "retention", cron: "0 3 * *" }, "cron"],
      [{ kind: "retention", cron: "* * * * *" }, "cron"],
      [{ kind: "retention", cron: "0 3 * * *", timezone: "Europe/Atlantis" }, "timezone"],
      [{ kind: "retention", intervalMinutes: 60, cron: "0 3 * * *" }, "intervalMinutes"],
      [{ kind: "retention" }, "intervalMinutes"],
      [{ kind: "retention", intervalMinutes: 5 }, "intervalMinutes"],
      [{ kind: "scrub", intervalMinutes: 60, protectedObjectId: mailboxId }, "protectedObjectId"],
    ];
    const before = await owner.select().from(schedules).where(eq(schedules.tenantId, contoso));
    for (const [body, field] of cases) {
      const response = await call("POST", "", { body });
      expect(response.status, JSON.stringify(body)).toBe(422);
      expect(response.headers.get("content-type")).toContain("application/problem+json");
      const problem = (await response.json()) as Problem;
      expect(problem.field, JSON.stringify(body)).toBe(field);
      expect(problem.issues?.[0]?.path).toEqual([field]);
    }
    // Schema failures name the field in the issue path as well.
    const archive = await call("POST", "", { body: { kind: "archive", intervalMinutes: 60 } });
    expect(archive.status).toBe(422);
    expect(((await archive.json()) as Problem).issues?.[0]?.path).toEqual(["kind"]);

    const after = await owner.select().from(schedules).where(eq(schedules.tenantId, contoso));
    expect(after).toHaveLength(before.length);
  });

  it("previews the next five runs across the Berlin daylight-saving switch", async () => {
    clock = new Date("2026-03-27T12:00:00.000Z");
    const response = await call("POST", "/preview", {
      role: "tenant_user",
      body: { cron: "30 3 * * *", timezone: "Europe/Berlin" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      next: [
        "2026-03-28T02:30:00.000Z",
        "2026-03-29T01:30:00.000Z",
        "2026-03-30T01:30:00.000Z",
        "2026-03-31T01:30:00.000Z",
        "2026-04-01T01:30:00.000Z",
      ],
    });
    const bad = await call("POST", "/preview", { body: { cron: "0 3 * * *", timezone: "Mars" } });
    expect(bad.status).toBe(422);
    expect(((await bad.json()) as Problem).field).toBe("timezone");
    clock = new Date("2026-03-04T10:00:00.000Z");
  });

  it("changes cadence, zone and state, recomputing the next run only when it matters", async () => {
    const created = await create({ kind: "retention", cron: "30 4 * * *" });
    expect(created.nextRunAt).toBe("2026-03-05T03:30:00.000Z");

    clock = new Date("2026-03-04T11:00:00.000Z");
    const paused = await call("PATCH", `/${created.id}`, { body: { enabled: false } });
    expect(paused.status).toBe(200);
    expect(await paused.json()).toMatchObject({ enabled: false, nextRunAt: null });

    // Switched on again in the afternoon: the nightly run stays at night.
    clock = new Date("2026-03-05T14:00:00.000Z");
    const resumed = (await (
      await call("PATCH", `/${created.id}`, { body: { enabled: true } })
    ).json()) as ScheduleDto;
    expect(resumed.nextRunAt).toBe("2026-03-06T03:30:00.000Z");

    // Switching to an interval clears the cron expression.
    const interval = (await (
      await call("PATCH", `/${created.id}`, { body: { intervalMinutes: 720 } })
    ).json()) as ScheduleDto;
    expect(interval).toMatchObject({ intervalMinutes: 720, cron: null });

    const both = await call("PATCH", `/${created.id}`, {
      body: { intervalMinutes: 60, cron: "0 3 * * *" },
    });
    expect(both.status).toBe(422);
    expect(((await both.json()) as Problem).field).toBe("intervalMinutes");

    const updates = await auditEntries("schedule.updated", created.id);
    expect(updates).toHaveLength(3);
    expect(updates.map((entry) => entry.details?.changes)).toContainEqual({
      intervalMinutes: { from: null, to: 720 },
      cron: { from: "30 4 * * *", to: null },
    });

    // Nothing to change: no write, no audit entry.
    const same = await call("PATCH", `/${created.id}`, { body: { intervalMinutes: 720 } });
    expect(same.status).toBe(200);
    expect(await auditEntries("schedule.updated", created.id)).toHaveLength(3);

    const missing = await call("PATCH", `/${randomUUID()}`, { body: { enabled: false } });
    expect(missing.status).toBe(404);
    clock = new Date("2026-03-04T10:00:00.000Z");
  });

  it("lets tenant users read but not change anything", async () => {
    const list = await call("GET", "", { role: "tenant_user" });
    expect(list.status).toBe(200);
    const { items } = (await list.json()) as ScheduleListDto;
    const target = items[0] as ScheduleDto;

    const attempts = [
      call("POST", "", { role: "tenant_user", body: { kind: "backup", intervalMinutes: 60 } }),
      call("PATCH", `/${target.id}`, { role: "tenant_user", body: { enabled: false } }),
      call("DELETE", `/${target.id}`, { role: "tenant_user" }),
      call("POST", "/recommended", { role: "tenant_user" }),
    ];
    for (const response of await Promise.all(attempts)) {
      expect(response.status).toBe(403);
    }
    const [unchanged] = await owner.select().from(schedules).where(eq(schedules.id, target.id));
    expect(unchanged?.enabled).toBe(target.enabled);
  });

  it("never names another person's object or a job to a tenant user", async () => {
    // The stand-in signs tenant users in as tenant_user@contoso.example.
    const [own] = await owner
      .insert(protectedObjects)
      .values({
        tenantId: contoso,
        sourceId: m365SourceId,
        kind: "onedrive",
        externalId: "tenant_user@contoso.example",
        displayName: "Own OneDrive",
      })
      .returning();
    const ownId = own?.id ?? "";
    const foreignId = await legacy({
      kind: "backup",
      protectedObjectId: mailboxId,
      intervalMinutes: 720,
    });
    const mineId = await legacy({
      kind: "backup",
      protectedObjectId: ownId,
      intervalMinutes: 720,
    });
    const foreign = { id: foreignId };
    const mine = { id: mineId };
    const jobId = randomUUID();
    await owner.insert(jobs).values({
      id: jobId,
      tenantId: contoso,
      queue: "backup",
      status: "completed",
      protectedObjectId: mailboxId,
      payload: { jobId, tenantId: contoso, scheduleId: foreign.id },
      completedAt: new Date("2026-03-04T09:00:00.000Z"),
      createdAt: new Date("2026-03-04T08:00:00.000Z"),
    });

    const response = await call("GET", "", { role: "tenant_user" });
    expect(response.status).toBe(200);
    const text = await response.text();
    for (const secret of ["anna@contoso.example", "Anna Berg", mailboxId, jobId]) {
      expect(text).not.toContain(secret);
    }
    const member = JSON.parse(text) as ScheduleListDto;
    expect(member.items.find((item) => item.id === foreign.id)).toMatchObject({
      protectedObject: { id: null, name: null, kind: "mailbox" },
      lastJob: { id: null, status: "completed", finishedAt: "2026-03-04T09:00:00.000Z" },
    });
    expect(member.items.find((item) => item.id === mine.id)?.protectedObject).toEqual({
      id: ownId,
      name: "Own OneDrive",
      kind: "onedrive",
    });

    // Administrators see both objects and the job.
    const admin = (await (await call("GET", "")).json()) as ScheduleListDto;
    expect(admin.items.find((item) => item.id === foreign.id)).toMatchObject({
      protectedObject: { id: mailboxId, name: "Anna Berg", kind: "mailbox" },
      lastJob: { id: jobId, status: "completed" },
    });
  });

  it("keeps every tenant to its own schedules", async () => {
    const own = await create({ kind: "retention", cron: "30 4 * * *" }, fabrikam);
    const contosoList = (await (await call("GET", "")).json()) as ScheduleListDto;
    expect(contosoList.items.map((item) => item.id)).not.toContain(own.id);
    const fabrikamList = (await (
      await call("GET", "", { tenant: fabrikam })
    ).json()) as ScheduleListDto;
    expect(fabrikamList.items.map((item) => item.id)).toEqual([own.id]);

    // Another tenant's schedule id is simply not found, whatever the role.
    expect((await call("PATCH", `/${own.id}`, { body: { enabled: false } })).status).toBe(404);
    expect((await call("DELETE", `/${own.id}`)).status).toBe(404);
    const [still] = await owner.select().from(schedules).where(eq(schedules.id, own.id));
    expect(still?.enabled).toBe(true);
  });

  it("shows the most telling job of the last run", async () => {
    const schedule = { id: await legacy({ kind: "verify", cron: "0 2 * * *" }) };
    const insertRun = async (createdAt: string, statuses: ("completed" | "failed")[]) => {
      const ids: string[] = [];
      for (const status of statuses) {
        const id = randomUUID();
        ids.push(id);
        await owner.insert(jobs).values({
          id,
          tenantId: contoso,
          queue: "verify",
          status,
          protectedObjectId: mailboxId,
          payload: { jobId: id, tenantId: contoso, scheduleId: schedule.id },
          completedAt: new Date(createdAt),
          createdAt: new Date(createdAt),
        });
      }
      return ids;
    };
    await insertRun("2026-03-02T02:00:00.000Z", ["failed"]);
    const latest = await insertRun("2026-03-03T02:00:00.000Z", [
      "completed",
      "failed",
      "completed",
    ]);

    const { items } = (await (await call("GET", "")).json()) as ScheduleListDto;
    const listed = items.find((item) => item.id === schedule.id);
    expect(listed?.lastJob).toEqual({
      id: latest[1],
      status: "failed",
      finishedAt: "2026-03-03T02:00:00.000Z",
    });
  });

  it("writes the audit entry in the same transaction as the change", async () => {
    const schedule = await create({ kind: "scrub", cron: "0 4 * * 6" });
    // Make the audit append fail for deletions: the deletion must roll back with it.
    await owner.execute(
      sql`ALTER TABLE audit_log ADD CONSTRAINT schedules_test_no_delete_audit CHECK (action <> 'schedule.deleted') NOT VALID`,
    );
    try {
      const response = await call("DELETE", `/${schedule.id}`);
      expect(response.status).toBe(500);
    } finally {
      await owner.execute(
        sql`ALTER TABLE audit_log DROP CONSTRAINT schedules_test_no_delete_audit`,
      );
    }
    const [kept] = await owner.select().from(schedules).where(eq(schedules.id, schedule.id));
    expect(kept?.id).toBe(schedule.id);

    const deleted = await call("DELETE", `/${schedule.id}`);
    expect(deleted.status).toBe(204);
    expect(await owner.select().from(schedules).where(eq(schedules.id, schedule.id))).toEqual([]);
    const [entry] = await auditEntries("schedule.deleted", schedule.id);
    expect(entry?.details).toMatchObject({ kind: "scrub", cron: "0 4 * * 6" });
  });

  it("applies the missing recommended schedules once and records it", async () => {
    // Contoso has a directory sync, retention and a tenant-wide restore check (the one of an
    // older release); the storage check was deleted again and nothing backs up as a whole. A
    // Microsoft 365 source makes directory sync recommended, and backups are a job.
    const listed = (await (await call("GET", "")).json()) as ScheduleListDto;
    expect(listed.missingKinds).toEqual(["backup", "scrub"]);

    const response = await call("POST", "/recommended", { body: { timezone: "Europe/Vienna" } });
    expect(response.status).toBe(200);
    const applied = (await response.json()) as {
      created: ScheduleDto[];
      jobCreated: { id: string; name: string } | null;
      missingKinds: string[];
    };
    expect(
      applied.created.map((item) => [item.kind, item.intervalMinutes, item.cron, item.timezone]),
    ).toEqual([
      ["scrub", null, "0 4 * * 6", "Europe/Vienna"],
      ["scrub", null, "0 5 1 * *", "Europe/Vienna"],
    ]);
    // The backup recommendation became the tenant's mail job (restore checks stay as they were),
    // named in the installation's default language: the tenant has none of its own.
    expect(applied.jobCreated?.name).toBe("Mail-Sicherung");
    expect(applied.missingKinds).toEqual([]);
    const [job] = await owner.select().from(backupJobs).where(eq(backupJobs.tenantId, contoso));
    expect(job).toMatchObject({
      kind: "mail",
      scopeMode: "all",
      schedule: { kind: "interval", intervalMinutes: 480, timeZone: "Europe/Vienna" },
      verifySchedule: null,
    });
    expect(job?.nextRunAt?.toISOString()).toBe(clock.toISOString());
    const [tenant] = await owner.select().from(tenants).where(eq(tenants.id, contoso));
    expect(tenant?.scheduleDefaultsAppliedAt?.toISOString()).toBe(clock.toISOString());
    expect(await auditEntries("schedule.recommended.applied", contoso)).toHaveLength(1);

    // Idempotent: nothing more to add, nothing more to record.
    const again = await call("POST", "/recommended");
    expect(again.status).toBe(200);
    const second = (await again.json()) as { created: unknown[]; jobCreated: unknown };
    expect(second.created).toEqual([]);
    expect(second.jobCreated).toBeNull();
    expect(await auditEntries("schedule.recommended.applied", contoso)).toHaveLength(1);
    expect(
      await owner.select().from(backupJobs).where(eq(backupJobs.tenantId, contoso)),
    ).toHaveLength(1);

    const zone = await call("POST", "/recommended", { body: { timezone: "Nowhere/Town" } });
    expect(zone.status).toBe(422);
    expect(((await zone.json()) as Problem).field).toBe("timezone");
  });

  it("gives a tenant without any job the default mail job with its restore checks", async () => {
    // Fabrikam has an IMAP source only (no directory sync) and one retention schedule.
    const listed = (await (await call("GET", "", { tenant: fabrikam })).json()) as ScheduleListDto;
    expect(listed.missingKinds).toEqual(["backup", "verify", "scrub"]);
    const applied = (await (await call("POST", "/recommended", { tenant: fabrikam })).json()) as {
      created: ScheduleDto[];
      jobCreated: { name: string } | null;
      missingKinds: string[];
    };
    expect(applied.created.map((item) => item.kind)).toEqual(["scrub", "scrub"]);
    expect(applied.jobCreated?.name).toBe("Mail-Sicherung");
    expect(applied.missingKinds).toEqual([]);
    const [job] = await owner.select().from(backupJobs).where(eq(backupJobs.tenantId, fabrikam));
    expect(job).toMatchObject({
      scopeMode: "all",
      schedule: { kind: "interval", intervalMinutes: 480 },
      verifySchedule: { kind: "cron", cron: "0 3 * * 0" },
    });
    // The list no longer asks for what the job covers.
    const after = (await (await call("GET", "", { tenant: fabrikam })).json()) as ScheduleListDto;
    expect(after.missingKinds).toEqual([]);
  });

  it("leaves a schedule a job took over on record, unchangeable, and the others alone", async () => {
    const [job] = await owner.select().from(backupJobs).where(eq(backupJobs.tenantId, contoso));
    const taken = await legacy({
      kind: "backup",
      intervalMinutes: 960,
      supersededByJobId: job?.id,
    });
    const running = await legacy({ kind: "backup", cron: "0 1 * * *" });
    const list = (await (await call("GET", "")).json()) as ScheduleListDto;
    expect(list.items.find((item) => item.id === taken)?.supersededByJobId).toBe(job?.id);
    expect(list.items.find((item) => item.id === running)?.supersededByJobId).toBeNull();

    for (const response of [
      await call("PATCH", `/${taken}`, { body: { enabled: false } }),
      await call("DELETE", `/${taken}`),
    ]) {
      expect(response.status).toBe(409);
      expect(((await response.json()) as Problem).type).toBe(
        "urn:restow:problem:schedule-superseded",
      );
    }
    const [row] = await owner.select().from(schedules).where(eq(schedules.id, taken));
    expect(row).toMatchObject({ enabled: true, supersededByJobId: job?.id });
    // One no job could take over is still the administrator's to change or delete.
    expect((await call("PATCH", `/${running}`, { body: { enabled: false } })).status).toBe(200);
    expect((await call("DELETE", `/${running}`)).status).toBe(204);
  });
});
