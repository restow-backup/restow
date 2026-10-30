/**
 * Postgres-backed test of "what runs right now" for the "All tenants" start page
 * (`GET /api/v1/tenant-running`) through the real application (apps/api/src/app.ts), with real
 * sessions on the application and installation roles Row Level Security binds:
 *
 *   - only provider admins reach the route: an anonymous request is 401, a tenant's own
 *     administrator 403;
 *   - each tenant's runs come out apart: a mail run, a machine's run and a Proxmox VE run are
 *     listed under their own tenant, runs that wait or ended are not, and the next planned start
 *     is the earliest over the tenants;
 *   - a member of the provider team limited to one tenant sees that tenant's runs only, and not
 *     the others' next start either.
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server; without it the suite is skipped.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { defaultEndpointConfig } from "@restow/core";
import {
  account,
  backupJobs,
  createDb,
  type Database,
  endpointRuns,
  endpoints,
  jobProgress,
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
import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerApiExtension, resetExtensionsForTesting } from "../../extensions.js";
import { provisionTestRoles, type TestDatabaseRoles } from "../../testing/database-roles.js";
import {
  dropDatabase,
  recreateDatabase,
  testDatabaseAdminUrl,
} from "../snapshots/testing/explorer-fixture.js";
import type { AllTenantsRunningDto } from "./dto.js";

const DATABASE = "restow_api_tenant_running_test";
const PUBLIC_URL = "http://localhost:3000";
const OWNER_EMAIL = "owner@example.com";
const PASSWORD = "correct-horse-battery-1";
const SETUP_TOKEN = "7QKMZ-RT4VX-9HBNP-2WCAE";

const NOW = Date.now();
const MINUTE = 60_000;
const ago = (minutes: number) => new Date(NOW - minutes * MINUTE);
const ahead = (minutes: number) => new Date(NOW + minutes * MINUTE);
const INTERVAL = { kind: "interval" as const, intervalMinutes: 240, timeZone: "UTC" };

function one<T>(rows: readonly T[]): T {
  const [first] = rows;
  if (first === undefined) {
    throw new Error("insert returned no row");
  }
  return first;
}

describe.skipIf(!testDatabaseAdminUrl)("what runs right now in every tenant", () => {
  let owner: Database;
  let roles: TestDatabaseRoles | undefined;
  let app: Hono;
  let authModule: typeof import("../../auth.js");
  let ownerCookie: string;
  let alpha: string;
  let beta: string;
  let gamma: string;
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

  /**
   * Alpha: a mail run and a machine's run going on, one mail run waiting, one ended; a mail job
   * planned in three hours, and an export that is active (not a run the widget lists). Beta: a
   * Proxmox VE guest being backed up, a job planned in one hour. Gamma: nothing runs, no job,
   * only a retention job that is active.
   */
  async function seed(): Promise<void> {
    const m365 = one(
      await owner
        .insert(sources)
        .values({ tenantId: alpha, kind: "m365", name: "M365", status: "active" })
        .returning(),
    ).id;
    const mailbox = one(
      await owner
        .insert(protectedObjects)
        .values({
          tenantId: alpha,
          sourceId: m365,
          kind: "mailbox",
          externalId: "anna@alpha.example",
          displayName: "Anna Alpha",
        })
        .returning(),
    ).id;
    await owner.insert(backupJobs).values({
      tenantId: alpha,
      kind: "mail",
      name: "All mailboxes",
      scopeMode: "all",
      schedule: INTERVAL,
      nextRunAt: ahead(180),
    });
    const mail = (status: "queued" | "active" | "completed") => ({
      tenantId: alpha,
      queue: "backup" as const,
      status,
      protectedObjectId: mailbox,
      createdAt: ago(10),
      startedAt: status === "queued" ? null : ago(8),
      completedAt: status === "completed" ? ago(1) : null,
    });
    const active = one(await owner.insert(jobs).values(mail("active")).returning()).id;
    await owner.insert(jobs).values([mail("queued"), mail("completed")]);
    // Exports, imports and maintenance are not what "Running now" lists; they must not make a
    // tenant look busy nor use up the limit.
    await owner.insert(jobs).values([
      { ...mail("active"), queue: "export" as const, protectedObjectId: null },
      { ...mail("active"), tenantId: gamma, queue: "retention" as const, protectedObjectId: null },
    ]);
    await owner.insert(jobProgress).values({
      tenantId: alpha,
      jobId: active,
      total: 20,
      done: 5,
      bytesProcessed: 5_000_000,
    });

    const machine = one(
      await owner
        .insert(endpoints)
        .values({
          tenantId: alpha,
          hostname: "web01",
          os: "linux",
          arch: "amd64",
          profile: "server",
          secretHash: randomUUID(),
          config: defaultEndpointConfig("linux", "server", { timeZone: "UTC" }),
        })
        .returning(),
    ).id;
    await owner.insert(endpointRuns).values([
      {
        tenantId: alpha,
        endpointId: machine,
        kind: "backup",
        status: "running",
        startedAt: ago(3),
      },
      {
        tenantId: alpha,
        endpointId: machine,
        kind: "backup",
        status: "succeeded",
        startedAt: ago(60),
        finishedAt: ago(50),
      },
    ]);

    const cluster = one(
      await owner
        .insert(pveClusters)
        .values({ tenantId: beta, name: "lab", fingerprint: randomUUID(), storageId: "restow" })
        .returning(),
    ).id;
    const pveJob = one(
      await owner
        .insert(pveJobs)
        .values({ tenantId: beta, name: "Every guest", scopeAll: true, nextRunAt: ahead(60) })
        .returning(),
    ).id;
    const guest = one(
      await owner
        .insert(pveGuests)
        .values({
          tenantId: beta,
          clusterId: cluster,
          vmid: 200,
          kind: "vm",
          name: "db01",
          jobId: pveJob,
        })
        .returning(),
    ).id;
    await owner.insert(pveRuns).values({
      tenantId: beta,
      clusterId: cluster,
      guestId: guest,
      kind: "backup",
      status: "running",
      startedAt: ago(2),
      progress: {
        bytesDone: 3000,
        bytesTotal: 9000,
        bytesUploaded: 100,
        bytesPerSecond: 25,
        at: ago(0.1).toISOString(),
      },
    });
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
    gamma = await createTenant("Gamma");
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

  it("refuses anyone who is not a provider admin", async () => {
    expect((await call("/api/v1/tenant-running")).status).toBe(401);

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
    // Their own tenant's start page carries the widget; the provider's overview is not theirs.
    const response = await call("/api/v1/tenant-running", cookie);
    expect(response.status).toBe(403);
    expect(((await response.json()) as { title: string }).title).toBe("Provider admin required");
  });

  it("lists each tenant's runs apart, without the runs that wait or ended", async () => {
    const response = await call("/api/v1/tenant-running", ownerCookie);
    expect(response.status).toBe(200);
    const body = (await response.json()) as AllTenantsRunningDto;
    expect(body.unavailable).toBe(0);
    // Only tenants with something running, by name: Gamma and the own organisation are quiet.
    expect(body.tenants.map((entry) => entry.name)).toEqual(["Alpha", "Beta"]);

    const [a, b] = body.tenants;
    expect(a?.tenantId).toBe(alpha);
    expect(a?.runs.map((run) => [run.source, run.state, run.subject?.name]).sort()).toEqual([
      ["endpoint", "running", "web01"],
      ["mail", "running", "Anna Alpha"],
    ]);
    const mailRun = a?.runs.find((run) => run.source === "mail");
    expect(mailRun?.progress).toMatchObject({
      itemsDone: 5,
      itemsTotal: 20,
      bytesProcessed: 5_000_000,
    });
    expect(a?.pve).toEqual([]);
    expect(a?.truncated).toBe(false);

    expect(b?.tenantId).toBe(beta);
    expect(b?.runs).toEqual([]);
    expect(b?.pve).toHaveLength(1);
    expect(b?.pve[0]).toMatchObject({
      kind: "backup",
      guest: { vmid: 200, name: "db01", kind: "vm" },
      jobName: "Every guest",
      progress: { bytesDone: 3000, bytesTotal: 9000, bytesPerSecond: 25 },
    });
  });

  it("names the earliest planned start over the tenants", async () => {
    const body = (await (
      await call("/api/v1/tenant-running", ownerCookie)
    ).json()) as AllTenantsRunningDto;
    expect(body.next?.tenantId).toBe(beta);
    expect(body.next?.name).toBe("Beta");
    expect(Date.parse(body.next?.at as string)).toBe(ahead(60).getTime());
    const alphaEntry = body.tenants.find((entry) => entry.tenantId === alpha);
    expect(Date.parse(alphaEntry?.nextRunAt as string)).toBe(ahead(180).getTime());
    expect(gamma).toBeTruthy();
  });

  it("shows a member limited to one tenant that tenant's runs only", async () => {
    const userId = await createAccount("tech-alpha@example.com", "admin");
    await owner.insert(providerMembers).values({ userId, role: "read_only", allTenants: false });
    await owner.insert(providerMemberTenants).values({ userId, tenantId: alpha });
    const cookie = await signIn("tech-alpha@example.com");

    const response = await call("/api/v1/tenant-running", cookie);
    expect(response.status).toBe(200);
    const body = (await response.json()) as AllTenantsRunningDto;
    expect(body.tenants.map((entry) => entry.tenantId)).toEqual([alpha]);
    // Beta's guest and Beta's earlier start are not theirs to see.
    expect(JSON.stringify(body)).not.toContain("db01");
    expect(body.next?.tenantId).toBe(alpha);
  });

  it("reads on the application role, which Row Level Security binds", async () => {
    const shared = await import("../../db.js");
    // Unpinned, the pool the runs are read on sees no tenant's rows at all.
    const unpinned = await shared.db.select().from(pveRuns);
    expect(unpinned).toHaveLength(0);
    expect((await owner.select().from(pveRuns)).length).toBe(1);
  });

  it("says that runs were cut off only when there are more than it lists", async () => {
    // A tenant's answer is kept for a few seconds, so each count gets a tenant of its own.
    async function tenantWithGuests(name: string, count: number): Promise<string> {
      const tenantId = await createTenant(name);
      const cluster = one(
        await owner
          .insert(pveClusters)
          .values({ tenantId, name: "big", fingerprint: randomUUID(), storageId: "restow" })
          .returning(),
      ).id;
      const guestRows = await owner
        .insert(pveGuests)
        .values(
          Array.from({ length: count }, (_, index) => ({
            tenantId,
            clusterId: cluster,
            vmid: 1000 + index,
            kind: "vm" as const,
            name: `guest${index}`,
          })),
        )
        .returning({ id: pveGuests.id });
      await owner.insert(pveRuns).values(
        guestRows.map((row, index) => ({
          tenantId,
          clusterId: cluster,
          guestId: row.id,
          kind: "backup" as const,
          status: "running" as const,
          // The first guest started first, the last one is the newest.
          startedAt: ago(count - index),
        })),
      );
      return tenantId;
    }
    const exactly = await tenantWithGuests("Exactly", 50);
    const over = await tenantWithGuests("Over", 51);
    const body = (await (
      await call("/api/v1/tenant-running", ownerCookie)
    ).json()) as AllTenantsRunningDto;

    // Exactly as many as are listed: nothing is cut off.
    const full = body.tenants.find((entry) => entry.tenantId === exactly);
    expect(full?.pve).toHaveLength(50);
    expect(full?.truncated).toBe(false);

    // One more: the newest 50 are listed and the page is told.
    const cut = body.tenants.find((entry) => entry.tenantId === over);
    expect(cut?.pve).toHaveLength(50);
    expect(cut?.truncated).toBe(true);
    expect(cut?.pve.some((run) => run.guest.name === "guest0")).toBe(false);
  }, 60_000);
});
