/**
 * Postgres-backed test of the provider view of the start page (Service
 * Provider): GET /dashboard?provider=true through the same Hono routes the
 * web UI calls, with the cross-tenant loader (./view.ts) registered as the
 * `providerDashboard` feature hook exactly as ee/api/src/index.ts does, and
 * two tenants whose figures must never mix. Same fixtures as the core suite
 * apps/api/src/features/dashboard/dashboard.pg.test.ts.
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server as a
 * superuser (the database `restow_ee_provider_dashboard_test` is recreated
 * there and dropped after, the roles with it). Without it the suite is
 * skipped.
 */
import { randomBytes, randomUUID } from "node:crypto";
import {
  type Database,
  createDb,
  jobProgress,
  jobs,
  license,
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
import { eq } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  registerApiExtension,
  resetExtensionsForTesting,
} from "../../../../apps/api/src/extensions.js";
import type {
  DashboardDto,
  TenantWidgetId,
} from "../../../../apps/api/src/features/dashboard/dto.js";
import {
  dropDatabase,
  recreateDatabase,
  testDatabaseAdminUrl,
} from "../../../../apps/api/src/features/snapshots/testing/explorer-fixture.js";
import type { Role } from "../../../../apps/api/src/middleware/rbac.js";
import type { TenantEnv } from "../../../../apps/api/src/middleware/session.js";
import {
  type TestDatabaseRoles,
  provisionTestRoles,
} from "../../../../apps/api/src/testing/database-roles.js";
import { licenseFeatureGate } from "../license/gate.js";
import { providerDashboardLoader } from "./view.js";

const DATABASE = "restow_ee_provider_dashboard_test";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Noon (UTC) today, so "today" and "yesterday" never straddle midnight while the suite runs. */
const NOW = new Date(`${new Date().toISOString().slice(0, 10)}T12:00:00.000Z`);
const ago = (ms: number) => new Date(NOW.getTime() - ms);

/** A valid installation default (a local path); nothing is read or written there. */
const STORAGE_ENV = { STORAGE_TARGET: "local", STORAGE_LOCAL_PATH: "/data/chunks" };

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

  return { installationId: installation.id, contoso, fabrikam, contosoJobIds };
}

describe.skipIf(!testDatabaseAdminUrl)("dashboard against Postgres", () => {
  let owner: Database;
  let roles: TestDatabaseRoles | undefined;
  let appDb: Database;
  let installationDb: Database;
  let brokenDb: Database;
  let f: Fixture;
  let app: Hono;

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
    await next();
  };

  async function setEdition(edition: "community" | "business" | "service_provider") {
    await owner.update(license).set({ active: false });
    if (edition !== "community") {
      await owner.insert(license).values({
        edition,
        multiTenant: edition === "service_provider",
        installationId: f.installationId,
        active: true,
      });
    }
  }

  async function dashboard(
    tenantId: string,
    role: Role,
    query = "",
    on: Hono = app,
  ): Promise<{ status: number; body: DashboardDto & { type?: string } }> {
    const response = await on.request(`/dashboard${query}`, {
      headers: { "x-test-tenant": tenantId, "x-test-role": role },
    });
    return { status: response.status, body: (await response.json()) as DashboardDto };
  }

  function ok<T>(result: { state: "ok"; data: T } | { state: "error" } | undefined): T {
    if (!result || result.state !== "ok") {
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

    owner = createDb(url);
    appDb = createDb(roles.appUrl);
    installationDb = createDb(roles.providerUrl);
    // Nothing listens on port 1: every query on this pool fails.
    brokenDb = createDb("postgres://nobody:nothing@127.0.0.1:1/none");
    f = await seed(owner);

    const { audit } = await import("../../../../apps/api/src/lib/audit.js");
    await audit(owner, {
      action: "settings.mail.tested",
      actor: "admin@provider.test",
      target: "admin@provider.test",
      targetType: "email",
      details: { transport: "smtp", ok: true, reason: null, unsaved: false },
    });

    registerApiExtension({
      name: "provider-dashboard-test",
      hooks: { providerDashboard: providerDashboardLoader },
      featureGate: licenseFeatureGate,
    });
    const { createDashboardRoutes } = await import(
      "../../../../apps/api/src/features/dashboard/routes.js"
    );
    const { errorHandler } = await import("../../../../apps/api/src/problem.js");
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
          access,
        }),
      );
      return hono;
    };
    app = build(installationDb);
  }, 60_000);

  afterAll(async () => {
    resetExtensionsForTesting();
    const shared = await import("../../../../apps/api/src/db.js");
    await Promise.all([shared.db.$client.end(), shared.providerDb.$client.end()]);
    await Promise.all([
      owner?.$client.end(),
      appDb?.$client.end(),
      installationDb?.$client.end(),
      brokenDb?.$client.end(),
    ]);
    await dropDatabase(testDatabaseAdminUrl as string, DATABASE);
    await roles?.drop(testDatabaseAdminUrl as string);
  });

  describe("Service Provider edition", () => {
    beforeEach(() => setEdition("service_provider"));

    it("adds the provider view for provider admins", async () => {
      const { status, body } = await dashboard(f.contoso, "provider_admin", "?provider=true");
      expect(status).toBe(200);
      expect(Object.keys(body.widgets)).toEqual(ALL_WIDGETS);
      expect(ok(body.widgets.mailboxUsage)).toMatchObject({
        scope: "installation",
        used: 4,
      });

      const view = ok(body.provider ?? undefined);
      expect(view.tenants.map((tenant) => tenant.name)).toEqual(["Contoso", "Fabrikam"]);
      const [contoso, fabrikam] = view.tenants;
      expect(contoso).toMatchObject({
        loaded: true,
        kind: "customer",
        readiness: "red",
        protectedObjects: 3,
        ready: 1,
        needsAttention: 0,
        notRestorable: 0,
        unverified: 1,
        noBackup: 1,
        failures24h: 1,
        failuresPrevious24h: 1,
        mailboxes: 2,
        storageError: false,
        physicalBytes: 1500,
      });
      expect(fabrikam).toMatchObject({
        loaded: true,
        unverified: 1,
        noBackup: 1,
        failures24h: 1,
        failuresPrevious24h: 0,
        mailboxes: 2,
        mailboxCap: 1,
        storageError: true,
      });
      expect(view.kpis).toEqual({
        tenants: 2,
        suspendedTenants: 0,
        unavailableTenants: 0,
        tenantsNotReady: 2,
        readiness: { total: 5, green: 1, yellow: 0, red: 0, unverified: 2, noBackup: 2 },
        protectedObjects: 5,
        unverifiedObjects: 2,
        failures24h: 2,
        failuresPrevious24h: 1,
        mailboxes: 4,
        physicalBytes: 1500,
      });
      const alerts = view.alerts.map((alert) => `${alert.tenantName}:${alert.kind}`);
      expect(alerts).toEqual(
        expect.arrayContaining([
          "Contoso:unverified",
          "Fabrikam:unverified",
          "Fabrikam:storage_error",
          "Fabrikam:over_cap",
          "Contoso:failed_jobs",
        ]),
      );
      expect(view.alerts[0]?.severity).toBe("destructive");
    });

    it("lists the operator's own organisation, but does not count it as a customer", async () => {
      const [provider] = await owner.select().from(providers).limit(1);
      const [own] = await owner
        .insert(tenants)
        .values({
          providerId: (provider as { id: string }).id,
          name: "Own organisation",
          slug: `own-${randomUUID().slice(0, 6)}`,
          kind: "internal",
        })
        .returning();
      const ownId = (own as { id: string }).id;
      try {
        const { body } = await dashboard(f.contoso, "provider_admin", "?provider=true");
        const view = ok(body.provider ?? undefined);
        expect(view.tenants.map((tenant) => [tenant.name, tenant.kind])).toEqual([
          ["Contoso", "customer"],
          ["Fabrikam", "customer"],
          ["Own organisation", "internal"],
        ]);
        // The customers are still two, and the own organisation adds none of the customer figures.
        expect(view.kpis).toMatchObject({ tenants: 2, suspendedTenants: 0, tenantsNotReady: 2 });
        expect(view.kpis.readiness).toEqual({
          total: 5,
          green: 1,
          yellow: 0,
          red: 0,
          unverified: 2,
          noBackup: 2,
        });
      } finally {
        await owner.delete(tenants).where(eq(tenants.id, ownId));
      }
    });

    it("answers the provider view alone for the All tenants overview", async () => {
      const { status, body } = await dashboard(f.contoso, "provider_admin", "?provider=only");
      expect(status).toBe(200);
      expect(body.widgets).toEqual({});
      const view = ok(body.provider ?? undefined);
      expect(view.tenants.map((tenant) => tenant.name)).toEqual(["Contoso", "Fabrikam"]);
    });
  });
});
