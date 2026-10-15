/**
 * Postgres-backed test of the "All tenants" overview of Jobs (#63) through the real application
 * (apps/api/src/app.ts), with real sessions on the application and installation roles Row Level
 * Security binds:
 *
 *   - only provider admins reach `GET /api/v1/tenant-jobs` and `GET /api/v1/tenant-jobs/:id`: an
 *     anonymous request is 401, a tenant's own administrator 403;
 *   - the figures of two tenants come out right and apart: mail, machine and Proxmox VE jobs
 *     counted, running and waiting backups, the newest outcomes (objects outside every job, an
 *     imported mailbox and a VM template never count), the last and the next run;
 *   - a member of the provider team limited to one tenant sees that tenant only and cannot open
 *     another tenant's jobs;
 *   - one tenant's jobs are listed read-only with their state.
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server; without it the suite is skipped.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { defaultEndpointConfig } from "@restow/core";
import {
  account,
  backupJobMembers,
  backupJobs,
  createDb,
  type Database,
  endpointRuns,
  endpoints,
  endpointTasks,
  jobs,
  member,
  protectedObjects,
  providerMembers,
  providerMemberTenants,
  pveClusters,
  pveGuests,
  pveJobs,
  pveRuns,
  sources,
  tenants,
  twoFactor,
  user,
} from "@restow/db";
import { symmetricDecrypt } from "better-auth/crypto";
import { eq, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerApiExtension, resetExtensionsForTesting } from "../../extensions.js";
import { provisionTestRoles, type TestDatabaseRoles } from "../../testing/database-roles.js";
import {
  dropDatabase,
  recreateDatabase,
  testDatabaseAdminUrl,
} from "../snapshots/testing/explorer-fixture.js";
import type { TenantJobListDto, TenantJobSummariesDto, TenantJobSummaryDto } from "./dto.js";

const DATABASE = "restow_api_tenant_jobs_test";
const PUBLIC_URL = "http://localhost:3000";
const OWNER_EMAIL = "owner@example.com";
const PASSWORD = "correct-horse-battery-1";
const SETUP_TOKEN = "7QKMZ-RT4VX-9HBNP-2WCAE";

// Day 15 at noon is the moment the tests run: the states depend on the real clock (a job is
// overdue a day past its period), so fixed calendar dates would turn them over by themselves.
const NOW = Date.now();
const at = (day: number, hour = 12) =>
  new Date(NOW + (day - 15) * 24 * 3_600_000 + (hour - 12) * 3_600_000);
const INTERVAL = { kind: "interval" as const, intervalMinutes: 240, timeZone: "UTC" };

function one<T>(rows: readonly T[]): T {
  const [first] = rows;
  if (first === undefined) {
    throw new Error("insert returned no row");
  }
  return first;
}

describe.skipIf(!testDatabaseAdminUrl)("the jobs of every tenant at a glance", () => {
  let owner: Database;
  let roles: TestDatabaseRoles | undefined;
  let app: Hono;
  let authModule: typeof import("../../auth.js");
  let ownerCookie: string;
  let alpha: string;
  let beta: string;
  let ipCounter = 0;

  function call(path: string, cookie?: string): Promise<Response> {
    return Promise.resolve(
      app.fetch(
        new Request(`${PUBLIC_URL}${path}`, {
          headers: { origin: PUBLIC_URL, ...(cookie ? { cookie } : {}) },
        }),
      ),
    );
  }

  function authPost(path: string, body: Record<string, unknown>, cookie?: string, ip = "") {
    return authModule.auth.handler(
      new Request(`${PUBLIC_URL}/api/auth${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: PUBLIC_URL,
          "x-forwarded-for": ip,
          ...(cookie ? { cookie } : {}),
        },
        body: JSON.stringify(body),
      }),
    );
  }

  function sessionCookieOf(response: Response): string {
    const cookie = response.headers
      .getSetCookie()
      .map((line) => line.split(";")[0] ?? "")
      .find((pair) => pair.includes("session_token="));
    if (!cookie) {
      throw new Error(`the response set no session cookie (status ${response.status})`);
    }
    return cookie;
  }

  /** Sign in with the password and enrol the mandatory authenticator app. */
  async function signIn(email: string): Promise<string> {
    ipCounter += 1;
    const ip = `198.51.100.${ipCounter}`;
    const response = await authPost("/sign-in/email", { email, password: PASSWORD }, undefined, ip);
    expect(response.status).toBe(200);
    const passwordOnly = sessionCookieOf(response);
    const enable = await authPost("/two-factor/enable", { password: PASSWORD }, passwordOnly, ip);
    expect(enable.status).toBe(200);
    const [row] = await owner.select({ id: user.id }).from(user).where(eq(user.email, email));
    const context = await authModule.auth.$context;
    const [stored] = await owner
      .select({ secret: twoFactor.secret })
      .from(twoFactor)
      .where(eq(twoFactor.userId, row?.id as string));
    const rawSecret = await symmetricDecrypt({
      key: context.secretConfig,
      data: stored?.secret as string,
    });
    const { code } = await authModule.auth.api.generateTOTP({ body: { secret: rawSecret } });
    const verify = await authPost("/two-factor/verify-totp", { code }, passwordOnly, ip);
    expect(verify.status).toBe(200);
    return sessionCookieOf(verify);
  }

  async function createAccount(email: string, role: "admin" | "user"): Promise<string> {
    const context = await authModule.auth.$context;
    const userId = randomUUID();
    await owner.insert(user).values({ id: userId, name: email, email, emailVerified: false, role });
    await owner.insert(account).values({
      id: randomUUID(),
      accountId: userId,
      providerId: "credential",
      userId,
      password: await context.password.hash(PASSWORD),
    });
    return userId;
  }

  async function createTenant(name: string): Promise<string> {
    const response = await app.fetch(
      new Request(`${PUBLIC_URL}/api/v1/tenants`, {
        method: "POST",
        headers: { origin: PUBLIC_URL, "content-type": "application/json", cookie: ownerCookie },
        body: JSON.stringify({ name, slug: name.toLowerCase() }),
      }),
    );
    expect(response.status).toBe(201);
    return ((await response.json()) as { id: string }).id;
  }

  /** Alpha: mail and machine jobs. Beta: a paused mail job and a Proxmox VE job for all guests. */
  async function seed(): Promise<void> {
    // --- Alpha: mail
    const m365 = one(
      await owner
        .insert(sources)
        .values({ tenantId: alpha, kind: "m365", name: "M365", status: "active" })
        .returning(),
    ).id;
    const imports = one(
      await owner
        .insert(sources)
        .values({ tenantId: alpha, kind: "import", name: "Imports", status: "active" })
        .returning(),
    ).id;
    const object = async (
      name: string,
      sourceId = m365,
      status: "active" | "excluded" = "active",
    ) =>
      one(
        await owner
          .insert(protectedObjects)
          .values({
            tenantId: alpha,
            sourceId,
            kind: "mailbox",
            status,
            externalId: `${name}@alpha.example`,
            displayName: name,
          })
          .returning(),
      ).id;
    const anna = await object("anna");
    const ben = await object("ben");
    const carl = await object("carl");
    const excluded = await object("ex", m365, "excluded");
    const imported = await object("old", imports);
    await owner.insert(backupJobs).values({
      tenantId: alpha,
      kind: "mail",
      name: "All mailboxes",
      scopeMode: "all",
      schedule: INTERVAL,
      nextRunAt: at(20, 14),
    });
    const run = (
      protectedObjectId: string,
      status: "queued" | "active" | "completed" | "failed",
      createdAt: Date,
      failedItems = 0,
    ) => ({
      tenantId: alpha,
      queue: "backup" as const,
      status,
      protectedObjectId,
      createdAt,
      completedAt: status === "completed" || status === "failed" ? createdAt : null,
      itemFailureSummary:
        failedItems > 0 ? { total: failedItems, stored: failedItems, byCause: {} } : null,
    });
    await owner.insert(jobs).values([
      run(anna, "failed", at(10)),
      run(anna, "completed", at(11)),
      run(anna, "queued", at(15)),
      run(ben, "completed", at(10)),
      run(ben, "failed", at(12)),
      run(carl, "completed", at(13), 2),
      run(carl, "active", at(15)),
      // Neither can be in a job: their failures count nowhere.
      run(excluded, "failed", at(14)),
      run(imported, "failed", at(14)),
    ]);

    // --- Alpha: machines
    const machine = async (hostname: string, nextRunAt: Date) =>
      one(
        await owner
          .insert(endpoints)
          .values({
            tenantId: alpha,
            hostname,
            os: "linux",
            arch: "amd64",
            profile: "server",
            secretHash: randomUUID(),
            config: defaultEndpointConfig("linux", "server", { timeZone: "UTC" }),
            nextRunAt,
          })
          .returning(),
      ).id;
    const web01 = await machine("web01", at(16, 22));
    const loose = await machine("loose", at(16, 1));
    const machineJob = one(
      await owner
        .insert(backupJobs)
        .values({ tenantId: alpha, kind: "endpoint", name: "Servers", schedule: INTERVAL })
        .returning(),
    ).id;
    await owner
      .insert(backupJobMembers)
      .values({ tenantId: alpha, jobId: machineJob, endpointId: web01 });
    await owner.insert(endpointRuns).values([
      {
        tenantId: alpha,
        endpointId: web01,
        kind: "backup",
        status: "succeeded",
        startedAt: at(12),
        finishedAt: at(12, 13),
      },
      {
        tenantId: alpha,
        endpointId: web01,
        kind: "backup",
        status: "partial",
        startedAt: at(14),
        finishedAt: at(14, 13),
      },
      // In no job: its failure counts nowhere.
      {
        tenantId: alpha,
        endpointId: loose,
        kind: "backup",
        status: "failed",
        startedAt: at(14),
        finishedAt: at(14, 14),
      },
    ]);
    await owner
      .insert(endpointTasks)
      .values({ tenantId: alpha, endpointId: web01, kind: "backup_now", status: "pending" });

    // --- Beta: a paused mail job, and Proxmox VE
    await owner.insert(backupJobs).values({
      tenantId: beta,
      kind: "mail",
      name: "Paused",
      enabled: false,
      schedule: INTERVAL,
      nextRunAt: at(16),
    });
    const cluster = one(
      await owner
        .insert(pveClusters)
        .values({ tenantId: beta, name: "lab", fingerprint: randomUUID(), storageId: "restow" })
        .returning(),
    ).id;
    await owner.insert(pveJobs).values({
      tenantId: beta,
      name: "Every guest",
      scopeAll: true,
      schedule: { kind: "daily", timeOfDay: "22:00", timeZone: "UTC" },
      nextRunAt: at(16, 22),
    });
    const guest = async (vmid: number, kind: "vm" | "ct", template = false) =>
      one(
        await owner
          .insert(pveGuests)
          .values({ tenantId: beta, clusterId: cluster, vmid, kind, name: `g${vmid}`, template })
          .returning(),
      ).id;
    const vm = await guest(100, "vm");
    const ct = await guest(101, "ct");
    const template = await guest(102, "vm", true);
    const busy = await guest(103, "vm");
    const pveRun = (
      guestId: string,
      status: "running" | "succeeded" | "failed",
      day: number,
      unreadable = 0,
    ) => ({
      tenantId: beta,
      clusterId: cluster,
      guestId,
      kind: "backup" as const,
      status,
      startedAt: at(day),
      finishedAt: status === "running" ? null : at(day, 13),
      stats: unreadable > 0 ? { resticUnreadable: unreadable } : {},
    });
    await owner
      .insert(pveRuns)
      .values([
        pveRun(vm, "failed", 12),
        pveRun(vm, "succeeded", 13),
        pveRun(ct, "succeeded", 13, 3),
        pveRun(template, "failed", 14),
        pveRun(busy, "running", 15),
      ]);
  }

  beforeAll(async () => {
    const url = await recreateDatabase(testDatabaseAdminUrl as string, DATABASE);
    roles = await provisionTestRoles(url);
    process.env.DATABASE_URL = roles.appUrl;
    process.env.DATABASE_PROVIDER_URL = roles.providerUrl;
    process.env.RESTOW_MASTER_KEY = randomBytes(32).toString("base64");
    process.env.BETTER_AUTH_SECRET = randomBytes(32).toString("base64");
    process.env.RESTOW_PUBLIC_URL = PUBLIC_URL;
    process.env.RESTOW_SETUP_TOKEN = SETUP_TOKEN;
    // Several tenants: the gate of `tenants.additional` answers yes.
    registerApiExtension({ name: "test-gate", featureGate: { isEnabled: async () => true } });
    owner = createDb(url);
    ({ app } = await import("../../app.js"));
    authModule = await import("../../auth.js");
    const { DISCLAIMER_VERSION: version } = await import("../../lib/disclaimer.js");

    const setup = await app.fetch(
      new Request(`${PUBLIC_URL}/api/v1/setup`, {
        method: "POST",
        headers: {
          origin: PUBLIC_URL,
          "content-type": "application/json",
          "x-restow-setup-token": SETUP_TOKEN,
        },
        body: JSON.stringify({
          disclaimer: { version, accepted: true },
          operatingMode: "local",
          providerName: "Operator",
          firstAdmin: { name: "Owner", email: OWNER_EMAIL, password: PASSWORD },
          mail: {
            transport: "smtp",
            smtp: {
              host: "mail.example.com",
              port: 587,
              security: "starttls",
              from: "r@example.com",
            },
          },
          sendTest: false,
        }),
      }),
    );
    expect(setup.status).toBe(201);
    ownerCookie = await signIn(OWNER_EMAIL);
    alpha = await createTenant("Alpha");
    beta = await createTenant("Beta");
    await seed();
  }, 120_000);

  afterAll(async () => {
    resetExtensionsForTesting();
    const shared = await import("../../db.js");
    await Promise.all([
      shared.db.$client.end(),
      shared.providerDb.$client.end(),
      shared.authDb.$client.end(),
    ]);
    await owner?.$client.end();
    Reflect.deleteProperty(process.env, "RESTOW_SETUP_TOKEN");
    await dropDatabase(testDatabaseAdminUrl as string, DATABASE);
    await roles?.drop(testDatabaseAdminUrl as string);
  }, 30_000);

  const rowOf = (body: TenantJobSummariesDto, tenantId: string): TenantJobSummaryDto => {
    const row = body.tenants.find((entry) => entry.tenantId === tenantId);
    if (!row) {
      throw new Error(`no row for ${tenantId}`);
    }
    return row;
  };

  it("refuses anyone who is not a provider admin", async () => {
    expect((await call("/api/v1/tenant-jobs")).status).toBe(401);
    expect((await call(`/api/v1/tenant-jobs/${alpha}`)).status).toBe(401);

    const adminId = await createAccount("alpha-admin@example.com", "user");
    const [row] = await owner
      .select({ organizationId: tenants.organizationId })
      .from(tenants)
      .where(eq(tenants.id, alpha));
    await owner.insert(member).values({
      id: randomUUID(),
      organizationId: row?.organizationId as string,
      userId: adminId,
      role: "owner",
      createdAt: new Date(),
    });
    const cookie = await signIn("alpha-admin@example.com");
    // Their own tenant's Jobs page works; the provider's overview does not, not even for their tenant.
    for (const path of ["/api/v1/tenant-jobs", `/api/v1/tenant-jobs/${alpha}`]) {
      const response = await call(path, cookie);
      expect(response.status, path).toBe(403);
      expect(((await response.json()) as { title: string }).title).toBe("Provider admin required");
    }
  });

  it("reads every tenant on the application role, which Row Level Security binds", async () => {
    const shared = await import("../../db.js");
    // Unpinned, the pool the figures are read on sees no tenant's jobs at all.
    const unpinned = await shared.db.execute<{ count: number }>(
      sql`SELECT count(*)::int AS count FROM backup_jobs`,
    );
    expect(unpinned.rows[0]?.count).toBe(0);
    expect((await owner.select().from(backupJobs)).length).toBe(3);
  });

  it("counts each tenant's jobs, running and waiting backups and outcomes apart", async () => {
    const response = await call("/api/v1/tenant-jobs", ownerCookie);
    expect(response.status).toBe(200);
    const body = (await response.json()) as TenantJobSummariesDto;
    // The own organisation the setup created, and the two customers, by name.
    expect(body.tenants.map((row) => row.name)).toEqual(["Alpha", "Beta", "Operator"]);

    const a = rowOf(body, alpha);
    expect(a.state).toBe("ok");
    expect(a.kinds?.mail).toEqual({
      jobs: 1,
      paused: 0,
      running: 1,
      queued: 1,
      outcome: "failed",
      failed: 1,
      warning: 1,
      lastRunAt: at(13).toISOString(),
      nextRunAt: at(20, 14).toISOString(),
    });
    expect(a.kinds?.endpoint).toEqual({
      jobs: 1,
      paused: 0,
      running: 0,
      queued: 1,
      outcome: "warning",
      failed: 0,
      warning: 1,
      lastRunAt: at(14, 13).toISOString(),
      nextRunAt: at(16, 22).toISOString(),
    });
    expect(a.kinds?.pve).toMatchObject({ jobs: 0, running: 0, outcome: null, nextRunAt: null });

    const b = rowOf(body, beta);
    expect(b.kinds?.mail).toMatchObject({ jobs: 1, paused: 1, outcome: null, nextRunAt: null });
    expect(b.kinds?.endpoint).toMatchObject({ jobs: 0, running: 0, queued: 0, outcome: null });
    // The template's failure does not count: PVE cannot back up a VM template.
    expect(b.kinds?.pve).toEqual({
      jobs: 1,
      paused: 0,
      running: 1,
      queued: 0,
      outcome: "warning",
      failed: 0,
      warning: 1,
      lastRunAt: at(13, 13).toISOString(),
      nextRunAt: at(16, 22).toISOString(),
    });
  });

  it("shows a member limited to one tenant that tenant only", async () => {
    const userId = await createAccount("tech-alpha@example.com", "admin");
    await owner.insert(providerMembers).values({ userId, role: "read_only", allTenants: false });
    await owner.insert(providerMemberTenants).values({ userId, tenantId: alpha });
    const cookie = await signIn("tech-alpha@example.com");

    const response = await call("/api/v1/tenant-jobs", cookie);
    expect(response.status).toBe(200);
    const body = (await response.json()) as TenantJobSummariesDto;
    expect(body.tenants.map((row) => row.tenantId)).toEqual([alpha]);

    expect((await call(`/api/v1/tenant-jobs/${alpha}`, cookie)).status).toBe(200);
    const other = await call(`/api/v1/tenant-jobs/${beta}`, cookie);
    expect(other.status).toBe(403);
    expect(((await other.json()) as { reason: string }).reason).toBe("scope");
  });

  it("lists one tenant's jobs read-only, with the state its Jobs page shows", async () => {
    const alphaJobs = (await (
      await call(`/api/v1/tenant-jobs/${alpha}`, ownerCookie)
    ).json()) as TenantJobListDto;
    expect(alphaJobs.items.map((job) => [job.kind, job.name, job.scopeCount, job.state])).toEqual([
      ["mail", "All mailboxes", 3, "failing"],
      // Its newest backup left files behind; that weighs more than the backup asked for.
      ["endpoint", "Servers", 1, "attention"],
    ]);
    const mail = alphaJobs.items.find((job) => job.kind === "mail");
    expect(mail).toMatchObject({ scopeMode: "all", schedule: INTERVAL, enabled: true });
    expect(mail?.lastRun).toMatchObject({ failed: 1, running: 1 });
    // Nothing that only an administrator of the job may read.
    expect(JSON.stringify(alphaJobs)).not.toContain("settings");

    const betaJobs = (await (
      await call(`/api/v1/tenant-jobs/${beta}`, ownerCookie)
    ).json()) as TenantJobListDto;
    expect(betaJobs.items.map((job) => [job.kind, job.name, job.scopeCount, job.state])).toEqual([
      ["mail", "Paused", 0, "paused"],
      ["pve", "Every guest", 3, "running"],
    ]);
    expect(betaJobs.items.find((job) => job.kind === "pve")?.lastRun).toEqual({
      at: at(13, 13).toISOString(),
      failed: 0,
      partial: 1,
      running: 1,
      queued: 0,
    });

    expect((await call(`/api/v1/tenant-jobs/${randomUUID()}`, ownerCookie)).status).toBe(404);
  });
});
