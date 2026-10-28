/**
 * Postgres-backed tests of the start page: GET /dashboard through the same
 * Hono routes the web UI calls, with the provider view off and on (a test
 * feature gate stands in for an extension, lib/features.ts) and per role,
 * with two tenants whose figures must never mix.
 *
 * The routes run on the provisioned database roles, as in production: the
 * application role that Row Level Security binds and the installation role
 * (src/testing/database-roles.ts). The suite's own handle is the owner, for
 * fixtures. Authentication is replaced by a middleware that sets the tenant
 * and role the way requireTenant does; requireTenant itself is covered by the
 * session tests.
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server as a
 * superuser (the database `restow_api_dashboard_test` is recreated there and
 * dropped after, the roles with it). Without it the suite is skipped.
 */
import { randomBytes, randomUUID } from "node:crypto";
import {
  backupJobMembers,
  backupJobs,
  createDb,
  type Database,
  endpointReports,
  endpointRuns,
  endpoints,
  jobProgress,
  jobs,
  packs,
  protectedObjects,
  providers,
  retentionPolicies,
  schedules,
  settings,
  snapshots,
  sources,
  storageTargets,
  tenants,
  users,
  verifyReports,
} from "@restow/db";
import { eq, inArray, sql } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { registerApiExtension, resetExtensionsForTesting } from "../../extensions.js";
import type { Role } from "../../middleware/rbac.js";
import type { TenantEnv } from "../../middleware/session.js";
import { provisionTestRoles, type TestDatabaseRoles } from "../../testing/database-roles.js";
import {
  dropDatabase,
  recreateDatabase,
  testDatabaseAdminUrl,
} from "../snapshots/testing/explorer-fixture.js";
import type { DashboardDto, TenantWidgetId } from "./dto.js";

const DATABASE = "restow_api_dashboard_test";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Noon (UTC) today, so "today" and "yesterday" never straddle midnight while the suite runs. */
const NOW = new Date(`${new Date().toISOString().slice(0, 10)}T12:00:00.000Z`);
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const dayKey = (date: Date) => date.toISOString().slice(0, 10);

/** Free space the fake statfs reports per repository path; any other path has none. */
const FREE_SPACE: Record<string, { freeBytes: number; totalBytes: number }> = {
  "/mnt/fabrikam": { freeBytes: 4e12, totalBytes: 8e12 },
  "/mnt/initech": { freeBytes: 1e12, totalBytes: 2e12 },
  "/data/chunks": { freeBytes: 9e12, totalBytes: 9e12 },
};

/** A valid installation default (a local path); nothing is read or written there. */
const STORAGE_ENV = { STORAGE_TARGET: "local", STORAGE_LOCAL_PATH: "/data/chunks" };
/** Paths on the server's system disk in this fixture (device 1, like `/`); every other is device 2. */
const SYSTEM_DISK_PATHS = new Set<string>();

const ALL_WIDGETS: TenantWidgetId[] = [
  "setup",
  "lastBackup",
  "readiness",
  "protectedObjects",
  "storage",
  "mailboxUsage",
  "endpoints",
  "backupTrend",
  "verificationHistory",
  "storageGrowth",
  "retention",
  "recentJobs",
];
const MEMBER_WIDGETS = ALL_WIDGETS.filter(
  (id) => id !== "mailboxUsage" && id !== "endpoints" && id !== "recentJobs",
);

function one<T>(rows: readonly T[]): T {
  const [first] = rows;
  if (first === undefined) {
    throw new Error("insert returned no row");
  }
  return first;
}

interface Fixture {
  installationId: string;
  contoso: string;
  fabrikam: string;
  globex: string;
  contosoJobIds: string[];
}

/**
 * Contoso (default storage, one backup schedule, no retention policy):
 *   Anna's mailbox   snapshot verified green, backed up today
 *   Anna's OneDrive  snapshot never verified (unverified), yesterday's run left 2 items behind
 *   an IMAP account  never backed up; today's run failed, and one two days ago
 *   packs: 1000 bytes written 40 days ago, 500 today
 * Fabrikam (own primary target failing its probe, IMAP source in error, a
 * 90-day retention policy, a cap of 1 mailbox with 2 protected):
 *   two IMAP accounts, one with a snapshot, and a failed job two hours ago
 * Globex (servers and clients backed up by the agent, no licensed mailbox):
 *   web      server, backup proven green
 *   db       server, restore test of its backup failed (red)
 *   laptop   client, backup never tested (unverified), its newest backup run failed
 *   fresh    server, no backup yet
 *   roamer   client, proven green, its newest run only says "interrupted" (no failure)
 *   quiet    server, proven green, silent for five hours
 *   retired  server, revoked: counted nowhere
 *   plus an orphaned IMAP account whose backup is proven green
 * Leaving: being deleted, never shown.
 */
async function seed(db: Database): Promise<Fixture> {
  const provider = one(await db.insert(providers).values({ name: "Provider" }).returning());
  const installation = one(
    await db
      .insert(settings)
      .values({
        singleton: true,
        mailTransport: "smtp",
        mailConfig: {
          transport: "smtp",
          host: "mail.example.test",
          port: 587,
          security: "starttls",
          from: "restow@example.test",
        },
      })
      .returning(),
  );

  const tenant = async (name: string, extra: Partial<typeof tenants.$inferInsert> = {}) =>
    one(
      await db
        .insert(tenants)
        .values({
          providerId: provider.id,
          name,
          slug: `${name.toLowerCase()}-${randomUUID().slice(0, 6)}`,
          ...extra,
        })
        .returning(),
    ).id;
  const contoso = await tenant("Contoso");
  const fabrikam = await tenant("Fabrikam", { mailboxCap: 1 });
  const globex = await tenant("Globex");
  await tenant("Leaving", { status: "deleting" });

  const source = async (tenantId: string, kind: "m365" | "imap", status: "active" | "error") =>
    one(
      await db
        .insert(sources)
        .values({ tenantId, kind, name: `${kind}-${randomUUID().slice(0, 6)}`, status })
        .returning(),
    ).id;
  const object = async (
    tenantId: string,
    sourceId: string,
    kind: "mailbox" | "onedrive" | "imap",
    displayName: string,
    userId: string | null = null,
  ) =>
    one(
      await db
        .insert(protectedObjects)
        .values({ tenantId, sourceId, kind, displayName, userId, externalId: randomUUID() })
        .returning(),
    ).id;
  const snapshot = async (tenantId: string, protectedObjectId: string, at: Date) =>
    one(
      await db
        .insert(snapshots)
        .values({
          tenantId,
          protectedObjectId,
          sequence: 1,
          manifestPath: `tenants/${tenantId}/manifests/${randomUUID()}`,
          itemCount: 10,
          byteSize: 4000,
          startedAt: at,
          completedAt: at,
        })
        .returning(),
    ).id;
  const job = async (
    tenantId: string,
    protectedObjectId: string,
    status: "completed" | "failed",
    at: Date,
    failedItems = 0,
  ) => {
    const row = one(
      await db
        .insert(jobs)
        .values({
          tenantId,
          queue: "backup",
          status,
          protectedObjectId,
          startedAt: at,
          completedAt: at,
          createdAt: at,
          errorMessage: status === "failed" ? "The server refused the login." : null,
        })
        .returning(),
    );
    await db
      .insert(jobProgress)
      .values({ tenantId, jobId: row.id, total: 10, done: 10 - failedItems, failed: failedItems });
    return row.id;
  };

  // Contoso
  const contosoM365 = await source(contoso, "m365", "active");
  const contosoImap = await source(contoso, "imap", "active");
  const anna = one(
    await db.insert(users).values({ tenantId: contoso, email: "anna@contoso.test" }).returning(),
  ).id;
  const annaMail = await object(contoso, contosoM365, "mailbox", "Anna Example", anna);
  const annaDrive = await object(contoso, contosoM365, "onedrive", "Anna Example", anna);
  const imapAccount = await object(contoso, contosoImap, "imap", "info@contoso.test");
  const mailSnapshot = await snapshot(contoso, annaMail, ago(HOUR));
  await snapshot(contoso, annaDrive, ago(25 * HOUR));
  await db.insert(verifyReports).values({
    tenantId: contoso,
    protectedObjectId: annaMail,
    snapshotId: mailSnapshot,
    recoveryReadiness: "green",
    checkedAt: ago(30 * 60_000),
  });
  const contosoJobIds = [
    await job(contoso, annaMail, "completed", ago(HOUR)),
    await job(contoso, annaDrive, "completed", ago(25 * HOUR), 2),
    await job(contoso, imapAccount, "failed", ago(2 * HOUR)),
    // In the 24 hours before the last 24: the provider view's trend of failures.
    await job(contoso, imapAccount, "failed", ago(40 * HOUR)),
  ];
  await db.insert(packs).values([
    {
      tenantId: contoso,
      path: "p/old",
      sha256: "a".repeat(64),
      size: 1000,
      createdAt: ago(40 * DAY),
    },
    { tenantId: contoso, path: "p/new", sha256: "b".repeat(64), size: 500, createdAt: ago(HOUR) },
  ]);
  await db
    .insert(schedules)
    .values({ tenantId: contoso, kind: "backup", intervalMinutes: 480, enabled: true });

  // Fabrikam
  const fabrikamImap = await source(fabrikam, "imap", "error");
  const first = await object(fabrikam, fabrikamImap, "imap", "sales@fabrikam.test");
  await object(fabrikam, fabrikamImap, "imap", "support@fabrikam.test");
  await snapshot(fabrikam, first, ago(3 * DAY));
  await job(fabrikam, first, "failed", ago(2 * HOUR));
  await db.insert(storageTargets).values({
    tenantId: fabrikam,
    kind: "local",
    role: "primary",
    config: { basePath: "/mnt/fabrikam" },
    status: "error",
    errorMessage: "The path is not writable.",
  });
  await db.insert(retentionPolicies).values({
    tenantId: fabrikam,
    name: "Ninety days",
    isDefault: true,
    appliesTo: { target: "snapshots", keepDays: 90, keepLast: 3 },
  });

  await seedGlobex(db, globex, source, object, snapshot);

  return { installationId: installation.id, contoso, fabrikam, globex, contosoJobIds };
}

/** Globex: the endpoints of the fixture (see `seed`), next to an orphaned account with a proven backup. */
async function seedGlobex(
  db: Database,
  tenantId: string,
  source: (tenantId: string, kind: "m365" | "imap", status: "active" | "error") => Promise<string>,
  object: (
    tenantId: string,
    sourceId: string,
    kind: "mailbox" | "onedrive" | "imap",
    displayName: string,
  ) => Promise<string>,
  snapshot: (tenantId: string, protectedObjectId: string, at: Date) => Promise<string>,
): Promise<void> {
  const config = {
    profile: "server" as const,
    schedule: { kind: "daily" as const, timeOfDay: "22:00", timeZone: "Europe/Berlin" },
    paths: ["/etc"],
    excludes: [],
    hooks: {},
    bandwidthKbps: null,
    onlyOnAcPower: false,
    useVss: false,
  };
  // Every machine is in a backup job: one in none would need attention for that alone (`no_job`).
  const machineJob = one(
    await db
      .insert(backupJobs)
      .values({ tenantId, kind: "endpoint", name: "Machines", schedule: config.schedule })
      .returning(),
  ).id;
  const endpoint = async (
    hostname: string,
    profile: "server" | "client",
    extra: Partial<typeof endpoints.$inferInsert> = {},
  ) => {
    const id = one(
      await db
        .insert(endpoints)
        .values({
          tenantId,
          hostname,
          os: "linux",
          arch: "amd64",
          profile,
          secretHash: randomUUID().replace(/-/g, ""),
          config: { ...config, profile },
          createdAt: ago(30 * DAY),
          lastSeenAt: ago(5 * 60_000),
          ...extra,
        })
        .returning(),
    ).id;
    await db
      .insert(backupJobMembers)
      .values({ tenantId, jobId: machineJob, endpointId: id, overrides: {} });
    return id;
  };
  const run = async (
    endpointId: string,
    finishedAgo: number,
    status: "succeeded" | "failed",
    extra: Partial<typeof endpointRuns.$inferInsert> = {},
  ) => {
    await db.insert(endpointRuns).values({
      tenantId,
      endpointId,
      kind: "backup",
      status,
      startedAt: ago(finishedAgo + 60_000),
      finishedAt: ago(finishedAgo),
      ...extra,
    });
  };
  const restoreTest = async (
    endpointId: string,
    snapshotId: string,
    readiness: "green" | "red",
    checkedAgo: number,
  ) => {
    await db.insert(endpointReports).values({
      tenantId,
      endpointId,
      kind: "restore_test",
      origin: "server",
      snapshotId,
      readiness,
      checkedAt: ago(checkedAgo),
    });
  };
  const readError = [{ code: "read_error", message: "permission denied" }];

  const web = await endpoint("web", "server", { lastSuccessAt: ago(2 * HOUR) });
  await run(web, 2 * HOUR, "succeeded", { snapshotId: "snap-web" });
  await restoreTest(web, "snap-web", "green", HOUR);

  const database = await endpoint("db", "server", { lastSuccessAt: ago(3 * HOUR) });
  await run(database, 3 * HOUR, "succeeded", { snapshotId: "snap-db" });
  await restoreTest(database, "snap-db", "red", 2 * HOUR);

  const laptop = await endpoint("laptop", "client", {
    lastSeenAt: ago(30 * 60_000),
    lastSuccessAt: ago(20 * HOUR),
  });
  await run(laptop, 20 * HOUR, "succeeded", { snapshotId: "snap-laptop" });
  await run(laptop, HOUR, "failed", { errors: readError });

  await endpoint("fresh", "server", { createdAt: ago(HOUR) });

  const roamer = await endpoint("roamer", "client", { lastSuccessAt: ago(10 * HOUR) });
  await run(roamer, 10 * HOUR, "succeeded", { snapshotId: "snap-roamer" });
  await restoreTest(roamer, "snap-roamer", "green", 9 * HOUR);
  await run(roamer, 30 * 60_000, "failed", {
    errors: [{ code: "interrupted", message: "The agent was restarted." }],
  });

  const quiet = await endpoint("quiet", "server", {
    lastSeenAt: ago(5 * HOUR),
    lastSuccessAt: ago(6 * HOUR),
  });
  await run(quiet, 6 * HOUR, "succeeded", { snapshotId: "snap-quiet" });
  await restoreTest(quiet, "snap-quiet", "green", 5 * HOUR);

  // Revoked: its newest backup failed and it finished more recently than any other, yet it counts nowhere.
  const retired = await endpoint("retired", "server", {
    status: "revoked",
    revokedAt: ago(2 * DAY),
    lastSuccessAt: ago(HOUR),
  });
  await run(retired, HOUR, "failed", { errors: readError });

  // An orphaned account still counts in the readiness widget while its backup exists.
  const legacySource = await source(tenantId, "imap", "active");
  const legacy = await object(tenantId, legacySource, "imap", "legacy@globex.test");
  await db
    .update(protectedObjects)
    .set({ status: "orphaned" })
    .where(eq(protectedObjects.id, legacy));
  const legacySnapshot = await snapshot(tenantId, legacy, ago(2 * DAY));
  await db.insert(verifyReports).values({
    tenantId,
    protectedObjectId: legacy,
    snapshotId: legacySnapshot,
    recoveryReadiness: "green",
    checkedAt: ago(2 * DAY),
  });
}

describe.skipIf(!testDatabaseAdminUrl)("dashboard against Postgres", () => {
  let owner: Database;
  let roles: TestDatabaseRoles | undefined;
  let appDb: Database;
  let installationDb: Database;
  let brokenDb: Database;
  let f: Fixture;
  let app: Hono;
  let degraded: Hono;

  /** Sets what requireTenant would: the tenant from a header and the role from another. */
  const access: MiddlewareHandler<TenantEnv> = async (c, next) => {
    const tenantId = c.req.header("x-test-tenant") ?? "";
    const role = (c.req.header("x-test-role") ?? "tenant_user") as Role;
    const tenant = one(
      await owner
        .select({
          id: tenants.id,
          name: tenants.name,
          slug: tenants.slug,
          organizationId: tenants.organizationId,
          status: tenants.status,
        })
        .from(tenants)
        .where(eq(tenants.id, tenantId)),
    );
    c.set("tenantId", tenant.id);
    c.set("tenant", tenant);
    c.set("role", role);
    c.set("isProviderAdmin", role === "provider_admin");
    c.set("memberships", []);
    // A provider team member limited to some tenants (middleware/session.ts loadProviderAccess).
    if (c.req.header("x-test-limited") === "1") {
      c.set("providerAccess", { role: "administrator", allTenants: false, tenantIds: new Set() });
    }
    await next();
  };

  /** Whether the test gate opens the provider view (`dashboard.allTenants`). */
  let allTenants = false;
  function setProviderView(on: boolean) {
    allTenants = on;
  }

  async function dashboard(
    tenantId: string,
    role: Role,
    query = "",
    on: Hono = app,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; body: DashboardDto & { type?: string } }> {
    const response = await on.request(`/dashboard${query}`, {
      headers: { "x-test-tenant": tenantId, "x-test-role": role, ...headers },
    });
    return { status: response.status, body: (await response.json()) as DashboardDto };
  }

  function ok<T>(result: { state: "ok"; data: T } | { state: "error" } | undefined): T {
    if (result?.state !== "ok") {
      throw new Error(`widget not ok: ${JSON.stringify(result)}`);
    }
    return result.data;
  }

  beforeAll(async () => {
    const url = await recreateDatabase(testDatabaseAdminUrl as string, DATABASE);
    roles = await provisionTestRoles(url);
    // The API's shared handles and configuration read the environment on import.
    process.env.DATABASE_URL = roles.appUrl;
    process.env.DATABASE_PROVIDER_URL = roles.providerUrl;
    process.env.RESTOW_MASTER_KEY = randomBytes(32).toString("base64");
    registerApiExtension({
      name: "test-gate",
      featureGate: {
        isEnabled: async (_db, feature) => feature === "dashboard.allTenants" && allTenants,
      },
    });

    owner = createDb(url);
    appDb = createDb(roles.appUrl);
    installationDb = createDb(roles.providerUrl);
    // Nothing listens on port 1: every query on this pool fails.
    brokenDb = createDb("postgres://nobody:nothing@127.0.0.1:1/none");
    f = await seed(owner);

    const { audit } = await import("../../lib/audit.js");
    await audit(owner, {
      action: "settings.mail.tested",
      actor: "admin@provider.test",
      target: "admin@provider.test",
      targetType: "email",
      details: { transport: "smtp", ok: true, reason: null, unsaved: false },
    });

    const { createDashboardRoutes } = await import("./routes.js");
    const { errorHandler } = await import("../../problem.js");
    const build = (providerDb: Database) => {
      const hono = new Hono();
      hono.onError(errorHandler);
      hono.route(
        "/dashboard",
        createDashboardRoutes({
          db: appDb,
          providerDb,
          env: STORAGE_ENV,
          now: () => NOW,
          // No filesystem is read: the repositories of the fixture report this free space.
          filesystemSpace: async (path) => FREE_SPACE[path] ?? null,
          systemDisk: {
            deviceOf: async (path) =>
              path === "/" || path.startsWith("/etc/") || SYSTEM_DISK_PATHS.has(path) ? 1 : 2,
            mountinfo: async () => null,
          },
          access,
        }),
      );
      return hono;
    };
    app = build(installationDb);
    degraded = build(brokenDb);
  }, 60_000);

  afterAll(async () => {
    resetExtensionsForTesting();
    const shared = await import("../../db.js");
    await Promise.all([
      shared.db.$client.end(),
      shared.providerDb.$client.end(),
      shared.authDb.$client.end(),
    ]);
    await Promise.all([
      owner?.$client.end(),
      appDb?.$client.end(),
      installationDb?.$client.end(),
      brokenDb?.$client.end(),
    ]);
    await dropDatabase(testDatabaseAdminUrl as string, DATABASE);
    await roles?.drop(testDatabaseAdminUrl as string);
  });

  describe("without the provider view", () => {
    beforeEach(() => setProviderView(false));

    it("gives tenant admins every tenant widget and the tenant's own mailboxes", async () => {
      const { status, body } = await dashboard(f.contoso, "tenant_admin");
      expect(status).toBe(200);
      expect(body).not.toHaveProperty("edition");
      expect(Object.keys(body.widgets)).toEqual(ALL_WIDGETS);
      expect(Object.values(body.widgets).every((widget) => widget.state === "ok")).toBe(true);
      expect(body.provider).toBeNull();
      // Anna's mailbox (+ her OneDrive, which does not count twice) and the IMAP account = 2.
      expect(ok(body.widgets.mailboxUsage)).toEqual({
        scope: "tenant",
        used: 2,
        tenant: { used: 2, cap: null },
      });
    });

    it("counts the installation's mailboxes for a provider admin", async () => {
      const { body } = await dashboard(f.contoso, "provider_admin");
      // Contoso 2 and Fabrikam's two IMAP accounts = 4.
      expect(ok(body.widgets.mailboxUsage)).toEqual({
        scope: "installation",
        used: 4,
        tenant: { used: 2, cap: null },
      });
    });

    it("leaves the admin widgets out for plain members", async () => {
      const { status, body } = await dashboard(f.contoso, "tenant_user");
      expect(status).toBe(200);
      expect(Object.keys(body.widgets)).toEqual(MEMBER_WIDGETS);
      expect(body.widgets.endpoints).toBeUndefined();
      expect(body.viewer).toEqual({
        role: "tenant_user",
        isProviderAdmin: false,
        canAdminister: false,
      });
      expect(ok(body.widgets.setup).items.some((item) => item.actionable)).toBe(false);
    });

    it("refuses the provider view, even to a provider admin", async () => {
      const member = await dashboard(f.contoso, "tenant_admin", "?provider=true");
      expect(member.status).toBe(403);
      const provider = await dashboard(f.contoso, "provider_admin", "?provider=true");
      expect(provider.status).toBe(403);
      expect(provider.body.type).toBe("urn:restow:problem:feature-unavailable");
    });

    it("returns the same tenant widgets as with the provider view on", async () => {
      const off = await dashboard(f.contoso, "tenant_admin");
      setProviderView(true);
      const on = await dashboard(f.contoso, "tenant_admin");
      expect(on.body.widgets).toEqual(off.body.widgets);
    });
  });

  describe("with the provider view", () => {
    beforeEach(() => setProviderView(true));

    it("reports the provider view as unavailable without the module that builds it", async () => {
      const { status, body } = await dashboard(f.contoso, "provider_admin", "?provider=true");
      expect(status).toBe(200);
      expect(Object.keys(body.widgets)).toEqual(ALL_WIDGETS);
      expect(ok(body.widgets.mailboxUsage)).toMatchObject({ scope: "installation", used: 4 });

      // The cross-tenant matrix is an extension (ee/api,
      // provider-dashboard/view.pg.test.ts); without it the core reports the
      // provider view as unavailable instead of failing the whole page.
      expect(body.provider).toEqual({ state: "error" });
    });

    it("refuses the provider view to tenant admins and members", async () => {
      for (const role of ["tenant_admin", "tenant_user"] as const) {
        const { status } = await dashboard(f.contoso, role, "?provider=true");
        expect(status).toBe(403);
      }
    });

    it("refuses the provider view to a provider team member limited to some tenants", async () => {
      // The view lists every tenant; a member who may reach only some does not get to see the others.
      for (const query of ["?provider=true", "?provider=only"]) {
        const { status } = await dashboard(f.contoso, "provider_admin", query, app, {
          "x-test-limited": "1",
        });
        expect(status, query).toBe(403);
      }
      // Their own tenant's page still works.
      const own = await dashboard(f.contoso, "provider_admin", "", app, { "x-test-limited": "1" });
      expect(own.status).toBe(200);
    });

    it("leaves the provider view out unless it is asked for", async () => {
      const { body } = await dashboard(f.contoso, "provider_admin");
      expect(body.provider).toBeNull();
    });

    it("shows a tenant admin the tenant's own mailboxes and cap, not the installation", async () => {
      const { body } = await dashboard(f.fabrikam, "tenant_admin");
      expect(ok(body.widgets.mailboxUsage)).toEqual({
        scope: "tenant",
        used: 2,
        tenant: { used: 2, cap: 1 },
      });
    });
  });

  describe("which parts of the page are asked for", () => {
    beforeEach(() => setProviderView(true));

    it("answers the setup alone for the sidebar's Start checklist", async () => {
      const { status, body } = await dashboard(f.contoso, "tenant_admin", "?widgets=setup");
      expect(status).toBe(200);
      expect(Object.keys(body.widgets)).toEqual(["setup"]);
      expect(ok(body.widgets.setup)).toMatchObject({ complete: true, total: 7 });
    });

    it("leaves out a widget the viewer may not see, even when it is asked for", async () => {
      const { body } = await dashboard(f.contoso, "tenant_user", "?widgets=setup,recentJobs");
      expect(Object.keys(body.widgets)).toEqual(["setup"]);
    });

    it("refuses a widget the page does not know", async () => {
      for (const query of ["?widgets=nope", "?widgets=setup,nope", "?widgets="]) {
        const { status } = await dashboard(f.contoso, "tenant_admin", query);
        expect(status, query).toBe(422);
      }
    });

    it("answers the provider view alone for All tenants, reading no tenant widget", async () => {
      const { status, body } = await dashboard(f.contoso, "provider_admin", "?provider=only");
      expect(status).toBe(200);
      expect(body.widgets).toEqual({});
      // Without the module that builds the matrix the provider view is reported as unavailable.
      expect(body.provider).toEqual({ state: "error" });
    });

    it("refuses the provider-only view to tenant admins and while the feature is off", async () => {
      expect((await dashboard(f.contoso, "tenant_admin", "?provider=only")).status).toBe(403);
      setProviderView(false);
      expect((await dashboard(f.contoso, "provider_admin", "?provider=only")).status).toBe(403);
    });

    it("rejects a provider value it does not know", async () => {
      expect((await dashboard(f.contoso, "provider_admin", "?provider=maybe")).status).toBe(422);
    });
  });

  describe("widgets", () => {
    beforeEach(() => setProviderView(false));

    it("flags the unverified backup in the readiness widget", async () => {
      const { body } = await dashboard(f.contoso, "tenant_user");
      expect(ok(body.widgets.readiness)).toMatchObject({
        overall: "red",
        total: 3,
        green: 1,
        unverified: 1,
        noBackup: 1,
      });
    });

    it("reports last backups per type next to the protected kinds", async () => {
      const { body } = await dashboard(f.contoso, "tenant_user");
      const lastBackup = ok(body.widgets.lastBackup);
      expect(lastBackup.protectedKinds).toEqual({
        mailbox: 1,
        onedrive: 1,
        imap: 1,
        site: 0,
        group: 0,
      });
      expect(lastBackup.lastSuccess.mail).toBe(ago(HOUR).toISOString());
      // Yesterday's OneDrive run left items behind and the IMAP run failed: neither is a success.
      expect(lastBackup.lastSuccess.imap).toBeNull();
    });

    it("counts backup outcomes, verification ratings and bytes per day", async () => {
      const { body } = await dashboard(f.contoso, "tenant_user");
      const trend = ok(body.widgets.backupTrend);
      expect(trend.days).toBe(60);
      expect(trend.series).toHaveLength(60);
      expect(trend.series.at(-1)).toEqual({
        date: dayKey(NOW),
        succeeded: 1,
        withItemFailures: 0,
        failed: 1,
      });
      expect(trend.series.at(-2)).toEqual({
        date: dayKey(ago(DAY)),
        succeeded: 0,
        withItemFailures: 1,
        failed: 0,
      });

      const verification = ok(body.widgets.verificationHistory);
      expect(verification.series.at(-1)).toEqual({
        date: dayKey(NOW),
        green: 1,
        yellow: 0,
        red: 0,
      });

      const growth = ok(body.widgets.storageGrowth);
      expect(growth).toMatchObject({ days: 30, requestedDays: 30, granularity: "day" });
      expect(growth.series).toHaveLength(30);
      expect(growth.series[0]?.bytes).toBe(1000);
      expect(growth.series.at(-1)).toEqual({ date: dayKey(NOW), bytes: 1500 });
      expect(growth.growthBytes).toBe(500);
      expect(growth.forecast?.method).toBe("linear");
      expect(growth.forecast?.points).toHaveLength(30);
      expect(growth.forecast?.band).toBeNull();
      // Contoso shares the installation default with other tenants: its free space is not theirs to read.
      expect(growth.capacity).toBeNull();
    });

    it("says honestly that everything is kept when there is no retention policy", async () => {
      const contoso = ok((await dashboard(f.contoso, "tenant_user")).body.widgets.retention);
      expect(contoso).toMatchObject({
        policy: null,
        scopedPolicies: 0,
        activeHolds: 0,
        snapshots: { active: 2, pruned: 0 },
        lastRun: null,
      });
      const fabrikam = ok((await dashboard(f.fabrikam, "tenant_user")).body.widgets.retention);
      expect(fabrikam.policy).toEqual({ name: "Ninety days", keepDays: 90, keepLast: 3 });
    });

    it("judges the setup from the data", async () => {
      const contoso = ok((await dashboard(f.contoso, "tenant_admin")).body.widgets.setup);
      expect(contoso).toMatchObject({ complete: true, done: 7 });
      expect(contoso.items.filter((item) => !item.actionable).map((item) => item.id)).toEqual([
        "notificationMail",
      ]);

      const fabrikam = ok((await dashboard(f.fabrikam, "provider_admin")).body.widgets.setup);
      const states = Object.fromEntries(
        fabrikam.items.map((item) => [item.id, [item.state, item.reason]]),
      );
      expect(states).toEqual({
        storage: ["attention", "target_error"],
        source: ["attention", "source_error"],
        objects: ["done", null],
        schedules: ["open", "no_backup_schedule"],
        firstBackup: ["done", null],
        firstVerification: ["open", null],
        notificationMail: ["done", null],
      });
      expect(fabrikam.items.every((item) => item.actionable)).toBe(true);
    });

    describe("the backup schedule step with backup jobs", () => {
      async function tenantWithoutSchedules(): Promise<string> {
        const [provider] = await owner.select().from(providers).limit(1);
        const [row] = await owner
          .insert(tenants)
          .values({
            providerId: (provider as { id: string }).id,
            name: "Jobs",
            slug: `jobs-${randomUUID().slice(0, 6)}`,
          })
          .returning();
        return (row as { id: string }).id;
      }
      const schedulesStep = async (tenantId: string) => {
        const setup = ok((await dashboard(tenantId, "tenant_admin")).body.widgets.setup);
        const item = setup.items.find((entry) => entry.id === "schedules");
        return item ? [item.state, item.reason] : null;
      };

      it("counts a mail job with a schedule, not one that is off or never runs, nor a schedule a job took over", async () => {
        const tenantId = await tenantWithoutSchedules();
        expect(await schedulesStep(tenantId)).toEqual(["open", "no_backup_schedule"]);
        const [manual] = await owner
          .insert(backupJobs)
          .values({ tenantId, kind: "mail", name: "Manual", scopeMode: "all" })
          .returning();
        const schedule = { kind: "interval", intervalMinutes: 480, timeZone: "UTC" } as const;
        await owner
          .insert(backupJobs)
          .values({ tenantId, kind: "mail", name: "Off", schedule, enabled: false });
        // A machine job is the agent's schedule, not a backup of mail.
        await owner
          .insert(backupJobs)
          .values({ tenantId, kind: "endpoint", name: "Servers", schedule });
        await owner.execute(
          sql`INSERT INTO schedules (tenant_id, kind, interval_minutes, timezone, superseded_by_job_id)
              VALUES (${tenantId}, 'backup', 480, 'UTC', ${manual?.id})`,
        );
        expect(await schedulesStep(tenantId)).toEqual(["open", "no_backup_schedule"]);
        await owner
          .insert(backupJobs)
          .values({ tenantId, kind: "mail", name: "Scheduled", schedule });
        expect(await schedulesStep(tenantId)).toEqual(["done", null]);
      });

      it("keeps the mail bound of the jobs when a member has a schedule of its own", async () => {
        const tenantId = await tenantWithoutSchedules();
        const staleMail = async () =>
          ok((await dashboard(tenantId, "tenant_admin")).body.widgets.lastBackup).staleAfterHours
            .mail;
        const [daily] = await owner
          .insert(backupJobs)
          .values({
            tenantId,
            kind: "mail",
            name: "Daily",
            scopeMode: "all",
            schedule: { kind: "cron", cron: "0 22 * * *", timeZone: "UTC" },
          })
          .returning();
        expect(await staleMail()).toBe(48);
        const [source] = await owner
          .insert(sources)
          .values({ tenantId, kind: "m365", name: "M365", status: "active" })
          .returning();
        const [mailbox] = await owner
          .insert(protectedObjects)
          .values({
            tenantId,
            sourceId: (source as { id: string }).id,
            kind: "mailbox",
            externalId: "weekly@jobs.example",
          })
          .returning();
        // Backed up on Sundays only (the scheduler runs it on the member's own schedule): that
        // bounds this member alone (the worker's alert), not the tenant's newest mail backup.
        await owner.insert(backupJobMembers).values({
          tenantId,
          jobId: (daily as { id: string }).id,
          protectedObjectId: (mailbox as { id: string }).id,
          overrides: { schedule: { kind: "cron", cron: "0 3 * * 0", timeZone: "UTC" } },
        });
        expect(await staleMail()).toBe(48);
      });

      it("lets a tenant that protects only machines finish the source, object, backup and check steps", async () => {
        const tenantId = await tenantWithoutSchedules();
        const steps = async () => {
          const setup = ok((await dashboard(tenantId, "tenant_admin")).body.widgets.setup);
          return Object.fromEntries(setup.items.map((item) => [item.id, item.state]));
        };
        expect(await steps()).toMatchObject({
          source: "open",
          objects: "open",
          firstBackup: "open",
          firstVerification: "open",
        });
        const schedule = { kind: "daily", timeOfDay: "22:00", timeZone: "UTC" } as const;
        await owner
          .insert(backupJobs)
          .values({ tenantId, kind: "endpoint", name: "Servers", schedule });
        const [machine] = await owner
          .insert(endpoints)
          .values({
            tenantId,
            hostname: "srv-only",
            os: "linux",
            arch: "amd64",
            profile: "server",
            secretHash: randomUUID().replace(/-/g, ""),
            config: {
              profile: "server",
              schedule,
              paths: ["/etc"],
              excludes: [],
              hooks: {},
              bandwidthKbps: null,
              onlyOnAcPower: false,
              useVss: false,
            },
            lastSuccessAt: new Date(),
          })
          .returning();
        await owner.insert(endpointReports).values({
          tenantId,
          endpointId: (machine as { id: string }).id,
          kind: "restore_test",
          origin: "agent",
          readiness: "green",
        });
        expect(await steps()).toMatchObject({
          source: "done",
          objects: "done",
          schedules: "done",
          firstBackup: "done",
          firstVerification: "done",
        });
      });
    });

    describe("the default storage of a tenant without a target of its own", () => {
      /** A tenant that wrote nothing yet and has no storage target: its data would go to the installation default. */
      async function bareTenant(): Promise<string> {
        const [provider] = await owner.select().from(providers).limit(1);
        const [row] = await owner
          .insert(tenants)
          .values({
            providerId: (provider as { id: string }).id,
            name: "Bare",
            slug: `bare-${randomUUID().slice(0, 6)}`,
          })
          .returning();
        return (row as { id: string }).id;
      }
      const storageStep = async (tenantId: string) => {
        const setup = ok((await dashboard(tenantId, "tenant_admin")).body.widgets.setup);
        const item = setup.items.find((entry) => entry.id === "storage");
        return item ? [item.state, item.reason] : null;
      };

      it("asks for a test until the installation or the tenant tested the default", async () => {
        const tenantId = await bareTenant();
        expect(await storageStep(tenantId)).toEqual(["open", "default_untested"]);
      });

      it("counts the installation-level test of the default as tested", async () => {
        const { audit } = await import("../../lib/audit.js");
        const tenantId = await bareTenant();
        // The test belongs to no tenant: the installation page records it in the installation chain.
        await audit(owner, {
          action: "settings.default_storage.tested",
          actor: "admin@provider.test",
          target: "installation_default",
          targetType: "storage_location",
          details: { ok: true, failedStep: null, errorCode: null },
        });
        expect(await storageStep(tenantId)).toEqual(["done", null]);
        const widget = ok((await dashboard(tenantId, "tenant_admin")).body.widgets.storage);
        expect(widget.target).toEqual({ source: "installation_default", status: "ok" });
        // Every tenant on the default gets it, and a tenant with a target of its own does not.
        expect(await storageStep(await bareTenant())).toEqual(["done", null]);
        expect(await storageStep(f.fabrikam)).toEqual(["attention", "target_error"]);
      });

      it("lets the newest test decide, whichever chain recorded it", async () => {
        const { audit } = await import("../../lib/audit.js");
        const tenantId = await bareTenant();
        // The installation test of the previous case passed; a newer failing one wins ...
        await audit(owner, {
          action: "settings.default_storage.tested",
          actor: "admin@provider.test",
          target: "installation_default",
          targetType: "storage_location",
          details: { ok: false, failedStep: "write", errorCode: "EACCES" },
        });
        expect(await storageStep(tenantId)).toEqual(["attention", "target_error"]);
        // ... until the tenant itself tests the default and it passes.
        await audit(owner, {
          tenantId,
          action: "storage.default.tested",
          actor: "admin@bare.test",
          target: "installation_default",
          targetType: "storage_location",
          details: { ok: true },
        });
        expect(await storageStep(tenantId)).toEqual(["done", null]);
      });
    });

    it("settles the optional notification mail step without a test mail", async () => {
      const { audit } = await import("../../lib/audit.js");
      const mailStep = async () => {
        const setup = ok((await dashboard(f.contoso, "provider_admin")).body.widgets.setup);
        const item = setup.items.find((entry) => entry.id === "notificationMail");
        return { complete: setup.complete, done: setup.done, step: [item?.state, item?.reason] };
      };
      const testMail = (ok: boolean) =>
        audit(owner, {
          action: "settings.mail.tested",
          actor: "admin@provider.test",
          target: "admin@provider.test",
          targetType: "email",
          details: { transport: "smtp", ok, reason: ok ? null : "connection", unsaved: false },
        });
      const keep = one(await owner.select().from(settings));
      try {
        // The wizard's skip left no transport: nothing is mailed, so the step is not needed.
        await owner.update(settings).set({ mailTransport: null, mailConfig: null });
        expect(await mailStep()).toEqual({
          complete: true,
          done: 7,
          step: ["not_needed", "mail_skipped"],
        });

        // A transport whose newest test failed needs attention ...
        await owner
          .update(settings)
          .set({ mailTransport: keep.mailTransport, mailConfig: keep.mailConfig });
        await testMail(false);
        expect(await mailStep()).toEqual({
          complete: false,
          done: 6,
          step: ["attention", "test_failed"],
        });

        // ... unless the operator marked the mail as not needed ...
        await owner.update(settings).set({ mailNotNeeded: true });
        expect(await mailStep()).toEqual({
          complete: true,
          done: 7,
          step: ["not_needed", "mail_marked"],
        });

        // ... and a test mail that went out settles it for good.
        await testMail(true);
        expect(await mailStep()).toEqual({ complete: true, done: 7, step: ["done", null] });
      } finally {
        await owner.update(settings).set({
          mailTransport: keep.mailTransport,
          mailConfig: keep.mailConfig,
          mailNotNeeded: keep.mailNotNeeded,
        });
      }
    });

    it("shows a failing storage target in the storage widget", async () => {
      const fabrikam = ok((await dashboard(f.fabrikam, "tenant_user")).body.widgets.storage);
      expect(fabrikam.target).toEqual({ source: "tenant", status: "error" });
      const contoso = ok((await dashboard(f.contoso, "tenant_user")).body.widgets.storage);
      expect(contoso).toEqual({
        logicalBytes: 8000,
        physicalBytes: 1500,
        repositoryBytes: 0,
        target: { source: "installation_default", status: "ok" },
        immutability: { objectLock: 0, deletionDelay: 0, primary: "none", warnings: 0 },
        systemDisk: null,
      });
    });

    it("warns of a primary on the server's system disk, with the trend for provider admins", async () => {
      const day = 24 * 60 * 60 * 1000;
      const keep = one(await owner.select().from(settings));
      SYSTEM_DISK_PATHS.add("/data/chunks");
      try {
        await owner.update(settings).set({
          diskAlerts: {
            system: {
              low: false,
              since: null,
              notifiedAt: null,
              freeBytes: 40e9,
              totalBytes: 100e9,
              samples: [
                { at: new Date(NOW.getTime() - 2 * day).toISOString(), freeBytes: 60e9 },
                { at: new Date(NOW.getTime() - day).toISOString(), freeBytes: 50e9 },
                { at: NOW.toISOString(), freeBytes: 40e9 },
              ],
            },
          },
        });
        // Contoso writes to the installation default (/data/chunks).
        const forAdmin = ok((await dashboard(f.contoso, "provider_admin")).body.widgets.storage);
        expect(forAdmin.systemDisk).toMatchObject({
          freeBytes: 40e9,
          totalBytes: 100e9,
          trend: {
            bytesPerDay: -10e9,
            fullOn: new Date(NOW.getTime() + 4 * day).toISOString(),
            basisHours: 48,
          },
        });
        expect(forAdmin.systemDisk?.samples).toHaveLength(3);
        // The tenant learns that, not the provider's figures.
        const forTenant = ok((await dashboard(f.contoso, "tenant_user")).body.widgets.storage);
        expect(forTenant.systemDisk).toEqual({
          freeBytes: null,
          totalBytes: null,
          trend: null,
          samples: [],
        });
        // A tenant with a repository of its own elsewhere gets no warning.
        const fabrikam = ok((await dashboard(f.fabrikam, "provider_admin")).body.widgets.storage);
        expect(fabrikam.systemDisk).toBeNull();
      } finally {
        SYSTEM_DISK_PATHS.clear();
        await owner.update(settings).set({ diskAlerts: keep.diskAlerts });
      }
    });

    it("counts the protected servers and clients and what needs an admin", async () => {
      const { body } = await dashboard(f.globex, "tenant_admin");
      expect(ok(body.widgets.endpoints)).toEqual({
        // The revoked server is not protected.
        protected: 6,
        machines: 6,
        withoutJob: 0,
        servers: 4,
        clients: 2,
        // web, roamer and quiet proven green; db failed its restore test; laptop's backup was
        // never read back; fresh has no backup yet.
        readiness: { green: 3, yellow: 0, red: 1, unverified: 1, noBackup: 1 },
        notReady: 3,
        // laptop only: roamer's newest run says "interrupted" (the agent restarted), and the
        // revoked server's failed run is not counted.
        failedLastBackup: 1,
        // db (restore test failed), laptop (last backup failed), quiet (server silent for 5 hours).
        needingAttention: 3,
        otherAttention: 3,
        // The newest good backup of a protected machine, not the revoked server's.
        lastSuccessAt: ago(2 * HOUR).toISOString(),
      });
    });

    it("answers with zeros for a tenant without endpoints, for the page to show no card", async () => {
      const { body } = await dashboard(f.contoso, "tenant_admin");
      expect(ok(body.widgets.endpoints)).toEqual({
        protected: 0,
        machines: 0,
        withoutJob: 0,
        servers: 0,
        clients: 0,
        readiness: { green: 0, yellow: 0, red: 0, unverified: 0, noBackup: 0 },
        notReady: 0,
        failedLastBackup: 0,
        needingAttention: 0,
        otherAttention: 0,
        lastSuccessAt: null,
      });
    });

    it("does not count a machine taken out of its job as protected, and never rates the tenant green for it", async () => {
      const [member] = await owner
        .select()
        .from(backupJobMembers)
        .where(
          sql`${backupJobMembers.tenantId} = ${f.globex} AND ${backupJobMembers.endpointId} IS NOT NULL`,
        )
        .limit(1);
      if (!member) throw new Error("expected a machine in a job");
      await owner.delete(backupJobMembers).where(sql`${backupJobMembers.id} = ${member.id}`);
      try {
        const { body } = await dashboard(f.globex, "tenant_admin");
        expect(ok(body.widgets.endpoints)).toMatchObject({
          protected: 5,
          machines: 6,
          withoutJob: 1,
        });
        expect(ok(body.widgets.readiness).withoutJob).toBe(1);
        expect(ok(body.widgets.protectedObjects).machines).toMatchObject({
          protected: 5,
          withoutJob: 1,
        });
        expect(ok(body.widgets.lastBackup).machines).toMatchObject({ protected: 5, withoutJob: 1 });
        // The machines' daily job: twice a day without a backup is overdue.
        expect(ok(body.widgets.lastBackup).staleAfterHours.machines).toBe(48);
      } finally {
        await owner.insert(backupJobMembers).values(member);
      }
    });

    it("counts the same machines in the readiness widget and on the verify page", async () => {
      const { body } = await dashboard(f.globex, "tenant_admin");
      const readiness = ok(body.widgets.readiness);
      const endpointsWidget = ok(body.widgets.endpoints);
      // The orphaned account plus the six protected machines.
      expect(readiness).toMatchObject({
        total: 7,
        green: 4,
        yellow: 0,
        red: 1,
        unverified: 1,
        noBackup: 1,
      });
      expect(readiness.total).toBe(endpointsWidget.protected + 1);

      const { readinessOverview } = await import("../verify/service.js");
      const page = await readinessOverview(appDb, f.globex, NOW);
      const onPage = (state: string) => page.endpoints.filter((row) => row.state === state).length;
      expect(endpointsWidget.readiness).toEqual({
        green: onPage("green"),
        yellow: onPage("yellow"),
        red: onPage("red"),
        unverified: onPage("unverified"),
        noBackup: onPage("no_backup"),
      });
      expect(page.summary).toMatchObject({ total: readiness.total, red: readiness.red });
      expect(page.endpoints).toHaveLength(endpointsWidget.protected);
    });

    it("lists the tenant's recent jobs for admins", async () => {
      const { body } = await dashboard(f.contoso, "tenant_admin");
      const jobsWidget = ok(body.widgets.recentJobs);
      expect(jobsWidget.items.map((job) => job.id).sort()).toEqual([...f.contosoJobIds].sort());
      expect(jobsWidget.items[0]).toMatchObject({
        status: "completed",
        object: { kind: "mailbox", displayName: "Anna Example" },
        progress: { total: 10, done: 10, failed: 0 },
      });
    });
  });

  describe("tenant isolation", () => {
    beforeEach(() => setProviderView(false));

    it("never mixes one tenant's figures into another's", async () => {
      const contoso = (await dashboard(f.contoso, "tenant_admin")).body;
      const fabrikam = (await dashboard(f.fabrikam, "tenant_admin")).body;
      expect(contoso.tenant.id).toBe(f.contoso);
      expect(fabrikam.tenant.id).toBe(f.fabrikam);

      expect(ok(fabrikam.widgets.protectedObjects).active).toBe(2);
      expect(ok(contoso.widgets.protectedObjects).active).toBe(3);
      expect(ok(fabrikam.widgets.storage).physicalBytes).toBe(0);
      const fabrikamJobs = ok(fabrikam.widgets.recentJobs).items.map((job) => job.id);
      expect(fabrikamJobs).toHaveLength(1);
      expect(fabrikamJobs.some((id) => f.contosoJobIds.includes(id))).toBe(false);
      // The endpoints of Globex never reach another tenant's widget, nor the other way round.
      const globex = (await dashboard(f.globex, "tenant_admin")).body;
      expect(ok(contoso.widgets.endpoints).protected).toBe(0);
      expect(ok(fabrikam.widgets.endpoints).protected).toBe(0);
      expect(ok(globex.widgets.endpoints).protected).toBe(6);
      expect(ok(globex.widgets.protectedObjects).total).toBe(1);
      const fabrikamTrend = ok(fabrikam.widgets.backupTrend).series;
      expect(fabrikamTrend.reduce((sum, day) => sum + day.succeeded, 0)).toBe(0);
      expect(ok(fabrikam.widgets.storageGrowth).series.at(-1)?.bytes).toBe(0);
    });
  });

  describe("a failing data source", () => {
    beforeEach(() => setProviderView(false));

    it("fails only the widgets that need it", async () => {
      const { status, body } = await dashboard(f.contoso, "provider_admin", "", degraded);
      expect(status).toBe(200);
      // The notification mail test and the installation's mailbox usage (a
      // provider admin's scope) live on the installation pool, which is down here.
      expect(body.widgets.setup).toEqual({ state: "error" });
      expect(body.widgets.mailboxUsage).toEqual({ state: "error" });
      for (const id of ALL_WIDGETS.filter(
        (widget) => widget !== "setup" && widget !== "mailboxUsage",
      )) {
        expect(body.widgets[id]?.state, id).toBe("ok");
      }
    });

    it("fails the endpoints widget alone when its source fails, and the page still answers", async () => {
      // The endpoint tables become unreadable for a moment.
      await owner.execute(sql`alter table endpoint_reports rename to endpoint_reports_offline`);
      try {
        const { status, body } = await dashboard(f.globex, "tenant_admin");
        expect(status).toBe(200);
        expect(Object.keys(body.widgets)).toEqual(ALL_WIDGETS);
        expect(body.widgets.endpoints).toEqual({ state: "error" });
        // Sources that never read the endpoint tables are untouched.
        for (const id of [
          "setup",
          "mailboxUsage",
          "backupTrend",
          "verificationHistory",
          "storageGrowth",
          "retention",
          "recentJobs",
        ] as const) {
          expect(body.widgets[id]?.state, id).toBe("ok");
        }
      } finally {
        await owner.execute(sql`alter table endpoint_reports_offline rename to endpoint_reports`);
      }
      const { body } = await dashboard(f.globex, "tenant_admin");
      expect(body.widgets.endpoints?.state).toBe("ok");
    });
  });
  describe("the storage growth window", () => {
    let initech: string;
    const GB = 1e9;

    beforeAll(async () => {
      // Initech: its own local repository and 400 days of mail data, 1 GB a day in winter
      // (October to March) and 3 GB a day in summer, one pack per day.
      const [provider] = await owner.select({ id: providers.id }).from(providers).limit(1);
      initech = one(
        await owner
          .insert(tenants)
          .values({
            providerId: provider?.id ?? "",
            name: "Initech",
            slug: `initech-${randomUUID().slice(0, 6)}`,
          })
          .returning(),
      ).id;
      await owner.insert(storageTargets).values({
        tenantId: initech,
        kind: "local",
        role: "primary",
        config: { basePath: "/mnt/initech" },
        status: "ok",
      });
      const rows = Array.from({ length: 400 }, (_, index) => {
        const at = ago(index * DAY);
        const month = at.getUTCMonth();
        return {
          tenantId: initech,
          path: `p/${index}`,
          sha256: index.toString(16).padStart(64, "0"),
          size: month >= 3 && month <= 8 ? 3 * GB : GB,
          createdAt: at,
        };
      });
      await owner.insert(packs).values(rows);
    });

    const growthOf = async (tenantId: string, query: string) => {
      const { status, body } = await dashboard(tenantId, "tenant_user", query);
      expect(status).toBe(200);
      return ok(body.widgets.storageGrowth);
    };

    it("sums a year up per month in the database and dates each month with its last day", async () => {
      const growth = await growthOf(initech, "?widgets=storageGrowth&storageDays=365");
      expect(growth).toMatchObject({ days: 365, requestedDays: 365, granularity: "month" });
      // The cut month a year ago, eleven whole ones and this month so far: 13 rows, not 365.
      expect(growth.series).toHaveLength(13);
      expect(growth.series.at(-1)?.date).toBe(dayKey(NOW));
      const [total] = await owner
        .select({ bytes: sql<number>`sum(${packs.size})`.mapWith(Number) })
        .from(packs)
        .where(eq(packs.tenantId, initech));
      expect(growth.series.at(-1)?.bytes).toBe(total?.bytes);
      // What was written before the window is the baseline, not growth.
      const [before] = await owner
        .select({ bytes: sql<number>`sum(${packs.size})`.mapWith(Number) })
        .from(packs)
        .where(
          sql`${packs.tenantId} = ${initech} and ${packs.createdAt} < ${new Date(
            Date.parse(`${dayKey(NOW)}T00:00:00.000Z`) - 364 * DAY,
          ).toISOString()}`,
        );
      expect(growth.growthBytes).toBe((total?.bytes ?? 0) - (before?.bytes ?? 0));
      // The months between are each a calendar month's last day.
      for (const point of growth.series.slice(0, -1)) {
        const next = new Date(`${point.date}T00:00:00.000Z`);
        next.setUTCDate(next.getUTCDate() + 1);
        expect(next.getUTCDate(), point.date).toBe(1);
      }
    });

    it("shows a band from the slowest to the fastest month, and when the repository runs full", async () => {
      const growth = await growthOf(initech, "?widgets=storageGrowth&storageDays=365");
      const band = growth.forecast?.band;
      expect(band?.slowestBytesPerDay).toBe(GB);
      expect(band?.fastestBytesPerDay).toBe(3 * GB);
      expect(growth.forecast?.horizonDays).toBe(365);
      expect(growth.capacity).toMatchObject({
        source: "filesystem",
        freeBytes: 1e12,
        totalBytes: 2e12,
      });
      const today = Date.parse(`${dayKey(NOW)}T00:00:00.000Z`);
      const inDays = (days: number) => dayKey(new Date(today + days * DAY));
      expect(growth.capacity?.runsFull).toMatchObject({
        earliest: inDays(Math.ceil(1e12 / (3 * GB))),
        latest: inDays(Math.ceil(1e12 / GB)),
      });
      expect(growth.capacity?.runsFull?.estimate).not.toBeNull();
    });

    it("sums three months up per week and draws one line for a month", async () => {
      const quarter = await growthOf(initech, "?widgets=storageGrowth&storageDays=90");
      expect(quarter.granularity).toBe("week");
      expect(quarter.series.length).toBeGreaterThanOrEqual(13);
      expect(quarter.series.length).toBeLessThanOrEqual(14);
      expect(quarter.forecast?.band).not.toBeNull();
      const week = await growthOf(initech, "?widgets=storageGrowth&storageDays=7&forecastDays=30");
      expect(week).toMatchObject({ days: 7, granularity: "day" });
      expect(week.series).toHaveLength(7);
      // The estimate looks no further ahead than the history shown.
      expect(week.forecast?.horizonDays).toBe(7);
      expect(week.forecast?.band).toBeNull();
    });

    it("clamps the window to the history that exists", async () => {
      // Contoso wrote its first data 40 days ago.
      const growth = await growthOf(f.contoso, "?storageDays=365&forecastDays=90");
      expect(growth).toMatchObject({ days: 41, requestedDays: 365, granularity: "week" });
      expect(growth.series.at(-1)?.bytes).toBe(1500);
      expect(growth.growthBytes).toBe(1500);
      expect(growth.forecast?.horizonDays).toBe(41);
      // Fabrikam has written nothing: a week of zeros, nothing to estimate.
      const empty = await growthOf(f.fabrikam, "?storageDays=365");
      expect(empty).toMatchObject({ days: 7, requestedDays: 365, forecast: null });
      // Its own repository reports free space, but without growth there is no day it runs full.
      expect(empty.capacity).toMatchObject({
        freeBytes: 4e12,
        runsFull: { estimate: null, earliest: null, latest: null },
      });
    });

    it("names no day when machines write to the same repository", async () => {
      await owner.insert(storageTargets).values({
        tenantId: f.globex,
        kind: "local",
        role: "primary",
        config: { basePath: "/mnt/fabrikam" },
        status: "ok",
      });
      try {
        const growth = await growthOf(f.globex, "?storageDays=30");
        expect(growth.capacity).toMatchObject({ freeBytes: 4e12, runsFull: null });
      } finally {
        await owner.delete(storageTargets).where(eq(storageTargets.tenantId, f.globex));
      }
    });

    it("reads the installation default's free space only for a tenant that has it to itself", async () => {
      const { soleTenantOnDefault } = await import("./queries.js");
      expect(await soleTenantOnDefault(installationDb, f.contoso)).toBe(false);
      // Every other tenant on the default (Globex, and those other tests added) gets a bucket
      // of its own for a moment: then Contoso has the default to itself.
      const others = await owner
        .select({ id: tenants.id })
        .from(tenants)
        .where(
          sql`${tenants.id} <> ${f.contoso} and not exists (select 1 from ${storageTargets} where ${storageTargets.tenantId} = ${tenants.id} and ${storageTargets.role} = 'primary')`,
        );
      await owner.insert(storageTargets).values(
        others.map(({ id }) => ({
          tenantId: id,
          kind: "s3" as const,
          role: "primary" as const,
          config: { bucket: `b-${id}`, region: "eu-central-1" },
          status: "ok" as const,
        })),
      );
      try {
        expect(await soleTenantOnDefault(installationDb, f.contoso)).toBe(true);
        const growth = await growthOf(f.contoso, "");
        expect(growth.capacity).toMatchObject({ source: "filesystem", freeBytes: 9e12 });
        // An S3 repository reports no capacity.
        expect((await growthOf(f.globex, "")).capacity).toBeNull();
      } finally {
        await owner.delete(storageTargets).where(
          inArray(
            storageTargets.tenantId,
            others.map(({ id }) => id),
          ),
        );
      }
    });

    it("refuses a window it does not offer", async () => {
      for (const query of [
        "?storageDays=3",
        "?storageDays=367",
        "?storageDays=1e2",
        "?storageDays=abc",
        "?forecastDays=0",
        "?forecastDays=400",
      ]) {
        const { status } = await dashboard(f.contoso, "tenant_user", query);
        expect(status, query).toBe(422);
      }
    });

    it("leaves the provider view alone", async () => {
      setProviderView(true);
      try {
        const { status, body } = await dashboard(
          f.contoso,
          "provider_admin",
          "?provider=only&storageDays=365",
        );
        expect(status).toBe(200);
        expect(body.widgets).toEqual({});
      } finally {
        setProviderView(false);
      }
    });
  });
});
