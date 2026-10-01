/**
 * Postgres-backed tests of the statistics: every dataset over a seeded
 * tenant with known figures (current and previous period), the provider
 * scope across tenants, tenant isolation, the CSV export and the PDF report
 * with their audit entries, and who may ask for which scope.
 *
 * The API's pools run on the provisioned database roles, as in production
 * (src/testing/database-roles.ts): the application role that Row Level
 * Security binds, and the installation role. The suite's own handle is the
 * owner, for fixtures and assertions. better-auth's session lookup is
 * replaced at its module boundary; memberships and tenants come from the
 * database, and a test feature gate stands in for the extension that opens
 * the provider scope (lib/features.ts).
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server as a
 * superuser (the database `restow_api_stats_test` is recreated there and
 * dropped after, the roles with it). Without it the suite is skipped;
 * docs/TESTING.md lists it under integration.
 */
import { randomUUID } from "node:crypto";
import {
  type Database,
  auditLog,
  createDb,
  itemFailures,
  jobs,
  member,
  organization,
  packs,
  protectedObjects,
  providers,
  restoreJobs,
  snapshots,
  sources,
  tenants,
  user,
  verifyReports,
} from "@restow/db";
import { and, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { extractText, getDocumentProxy } from "unpdf";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { registerApiExtension, resetExtensionsForTesting } from "../../extensions.js";
import { type TestDatabaseRoles, provisionTestRoles } from "../../testing/database-roles.js";
import {
  dropDatabase,
  recreateDatabase,
  testDatabaseAdminUrl,
} from "../snapshots/testing/explorer-fixture.js";
import type { StatsDto } from "./dto.js";

const DATABASE = "restow_api_stats_test";

/** Sessions by the `x-test-user` header; better-auth itself is not under test here. */
const sessions = vi.hoisted(() => new Map<string, unknown>());
vi.mock("../../auth.js", () => ({
  auth: {
    api: {
      getSession: async ({ headers }: { headers: Headers }) =>
        sessions.get(headers.get("x-test-user") ?? "") ?? null,
    },
  },
}));

type Service = typeof import("./service.js");
type VerifyService = typeof import("../verify/service.js");
type SharedDb = typeof import("../../db.js");

const at = (month: number, day: number, hour = 12, minute = 0) =>
  new Date(Date.UTC(2026, month - 1, day, hour, minute));

/** The period under test and "now" a day after it. */
const PERIOD = { from: "2026-09-01", to: "2026-09-07" };
const NOW = at(9, 8, 12);
const CLIENT_IP = "198.51.100.23";

function one<T>(rows: readonly T[]): T {
  const [first] = rows;
  if (first === undefined) {
    throw new Error("insert returned no row");
  }
  return first;
}

interface Fixture {
  contoso: string;
  fabrikam: string;
  adatum: string;
  northwind: string;
  anna: string;
  bob: string;
  info: string;
  fabrikamImap: string;
  /** Northwind's objects by display name. */
  northwindObjects: Record<"Carla" | "Dora" | "Emil" | "Frank" | "Gina" | "Hugo", string>;
}

/**
 * Contoso (Microsoft 365 and IMAP), the tenant every figure below is known
 * for; Fabrikam (IMAP only) with one backup; Adatum with nothing at all;
 * Northwind, whose objects walk through the verification rules and the
 * protection statuses; and a tenant being deleted, which no scope may include.
 */
async function seed(db: Database): Promise<Fixture> {
  const provider = one(await db.insert(providers).values({ name: "Provider" }).returning());
  const tenant = async (name: string, status: "active" | "deleting" = "active") => {
    const organizationId = randomUUID();
    await db.insert(organization).values({
      id: organizationId,
      name,
      slug: `${name.toLowerCase()}-${organizationId.slice(0, 6)}`,
      createdAt: at(1, 1),
    });
    return one(
      await db
        .insert(tenants)
        .values({
          providerId: provider.id,
          organizationId,
          name,
          slug: name.toLowerCase(),
          status,
        })
        .returning(),
    );
  };
  const contoso = await tenant("Contoso");
  const fabrikam = await tenant("Fabrikam");
  const adatum = await tenant("Adatum");
  const northwind = await tenant("Northwind");
  const leaving = await tenant("Leaving", "deleting");

  // --- People and sessions ------------------------------------------------
  const person = async (
    key: string,
    role: string | null,
    memberOf?: { org: string; role: string },
  ) => {
    const id = randomUUID();
    const email = `${key}@example.test`;
    await db.insert(user).values({ id, name: key, email, emailVerified: true, role });
    if (memberOf) {
      await db.insert(member).values({
        id: randomUUID(),
        organizationId: memberOf.org,
        userId: id,
        role: memberOf.role,
        createdAt: at(1, 1),
      });
    }
    sessions.set(key, {
      user: { id, email, name: key, role, banned: false, twoFactorEnabled: false },
      session: { id: randomUUID(), userId: id, authMethod: "passkey", activeOrganizationId: null },
    });
  };
  await person("operator", "admin");
  await person("contoso-admin", null, { org: contoso.organizationId as string, role: "admin" });
  await person("contoso-user", null, { org: contoso.organizationId as string, role: "member" });

  // --- Contoso -------------------------------------------------------------
  const tenantId = contoso.id;
  const m365 = one(
    await db
      .insert(sources)
      .values({ tenantId, kind: "m365", name: "Contoso M365", status: "active" })
      .returning(),
  ).id;
  const imap = one(
    await db
      .insert(sources)
      .values({ tenantId, kind: "imap", name: "Contoso IMAP", status: "active" })
      .returning(),
  ).id;
  const object = async (
    owner: string,
    sourceId: string,
    kind: "mailbox" | "onedrive" | "imap",
    displayName: string,
    createdAt: Date,
    status: "active" | "excluded" | "orphaned" = "active",
  ) =>
    one(
      await db
        .insert(protectedObjects)
        .values({
          tenantId: owner,
          sourceId,
          kind,
          externalId: `${displayName}-${randomUUID().slice(0, 6)}`,
          displayName,
          status,
          createdAt,
        })
        .returning(),
    ).id;
  const anna = await object(tenantId, m365, "mailbox", "Anna", at(8, 1));
  const bob = await object(tenantId, m365, "onedrive", "Bob", at(8, 1));
  // Created inside the period: two protected objects before it, three after.
  const info = await object(tenantId, imap, "imap", "Info", at(9, 3, 8));
  await object(tenantId, m365, "mailbox", "Former", at(8, 1), "excluded");

  const snapshot = async (
    owner: string,
    protectedObjectId: string,
    sequence: number,
    byteSize: number,
    completedAt: Date | null,
    extra: Partial<typeof snapshots.$inferInsert> = {},
  ) =>
    one(
      await db
        .insert(snapshots)
        .values({
          tenantId: owner,
          protectedObjectId,
          sequence,
          byteSize,
          startedAt: completedAt ?? at(9, 7),
          completedAt,
          manifestPath: completedAt ? `tenants/${owner}/manifests/${randomUUID()}` : null,
          updatedAt: completedAt ?? at(9, 7),
          ...extra,
        })
        .returning(),
    ).id;
  // Pruned before the period: part of no retained total at its start.
  await snapshot(tenantId, anna, 1, 900, at(8, 20), { status: "pruned", updatedAt: at(8, 30) });
  const annaBefore = await snapshot(tenantId, anna, 2, 1000, at(8, 28));
  const annaLatest = await snapshot(tenantId, anna, 3, 1200, at(9, 2));
  // Still running: neither logical bytes nor a backup yet.
  await snapshot(tenantId, anna, 4, 99_999, null);
  await snapshot(tenantId, bob, 1, 5000, at(8, 29));
  const bobLatest = await snapshot(tenantId, bob, 2, 5000, at(9, 4));
  await snapshot(tenantId, info, 1, 300, at(9, 5));

  const pack = async (owner: string, size: number, createdAt: Date) => {
    await db.insert(packs).values({
      tenantId: owner,
      path: `tenants/${owner}/packs/${randomUUID()}`,
      sha256: randomUUID().replace(/-/g, ""),
      size,
      createdAt,
    });
  };
  await pack(tenantId, 2000, at(8, 28));
  await pack(tenantId, 1000, at(8, 29));
  await pack(tenantId, 500, at(9, 2));
  await pack(tenantId, 100, at(9, 5));

  const job = async (
    owner: string,
    values: Pick<typeof jobs.$inferInsert, "queue" | "status"> & Partial<typeof jobs.$inferInsert>,
  ) =>
    one(
      await db
        .insert(jobs)
        .values({ tenantId: owner, ...values })
        .returning(),
    ).id;
  const run = (started: Date, seconds: number) => ({
    startedAt: started,
    completedAt: new Date(started.getTime() + seconds * 1000),
  });
  // Previous period: 2 succeeded, 1 failed; 1.5 s throttling.
  await job(tenantId, {
    queue: "backup",
    status: "completed",
    protectedObjectId: anna,
    ...run(at(8, 28, 1), 300),
  });
  await job(tenantId, {
    queue: "backup",
    status: "completed",
    protectedObjectId: bob,
    payload: { result: { throttleWaitMs: 1500, throttleWaits: 1 } },
    ...run(at(8, 29, 1), 300),
  });
  const previousFailed = await job(tenantId, {
    queue: "backup",
    status: "failed",
    protectedObjectId: bob,
    ...run(at(8, 30, 1), 30),
  });
  // Current period: 3 succeeded, 1 failed, 1 cancelled; 47 s throttling in 4 waits.
  const annaRun = await job(tenantId, {
    queue: "backup",
    status: "completed",
    protectedObjectId: anna,
    payload: { result: { throttleWaitMs: 30_000, throttleWaits: 2 } },
    ...run(at(9, 2, 1), 600),
  });
  const failedRun = await job(tenantId, {
    queue: "backup",
    status: "failed",
    protectedObjectId: bob,
    // A failed run keeps the running totals only.
    payload: { runtime: { throttle: { totalWaitMs: 5000, waits: 1 } } },
    ...run(at(9, 3, 1), 45),
  });
  await job(tenantId, {
    queue: "backup",
    status: "completed",
    protectedObjectId: bob,
    payload: { runtime: { throttle: { totalWaitMs: 12_000, waits: 1 } } },
    ...run(at(9, 4, 0), 1800),
  });
  const infoRun = await job(tenantId, {
    queue: "backup",
    status: "completed",
    protectedObjectId: info,
    // Malformed totals are ignored, not added.
    payload: { result: { throttleWaitMs: "lots", throttleWaits: -3 } },
    ...run(at(9, 5, 2), 60),
  });
  await job(tenantId, {
    queue: "backup",
    status: "cancelled",
    protectedObjectId: bob,
    ...run(at(9, 6, 1), 5),
  });
  // Neither finished nor in the period: not counted.
  await job(tenantId, {
    queue: "backup",
    status: "active",
    protectedObjectId: anna,
    startedAt: at(9, 7),
  });
  await job(tenantId, {
    queue: "backup",
    status: "completed",
    protectedObjectId: anna,
    ...run(at(9, 9), 10),
  });
  await job(tenantId, {
    queue: "verify",
    status: "completed",
    protectedObjectId: anna,
    ...run(at(9, 3, 3), 60),
  });

  const restore = async (
    status: "completed" | "failed" | "queued",
    started: Date,
    seconds: number,
  ) => {
    const jobId = await job(tenantId, {
      queue: "restore",
      status,
      protectedObjectId: anna,
      ...(status === "queued" ? {} : run(started, seconds)),
    });
    await db
      .insert(restoreJobs)
      .values({ tenantId, jobId, snapshotId: annaLatest, targetType: "original" });
  };
  await restore("completed", at(8, 31, 9), 30);
  await restore("completed", at(9, 6, 10), 120);
  await restore("failed", at(9, 7, 10), 20);
  await restore("queued", at(9, 7, 11), 0);

  const failure = async (
    jobId: string,
    protectedObjectId: string,
    reason: string,
    createdAt: Date,
  ) => {
    await db.insert(itemFailures).values({
      tenantId,
      jobId,
      protectedObjectId,
      itemRef: `item-${randomUUID().slice(0, 6)}`,
      reason,
      createdAt,
    });
  };
  await failure(previousFailed, bob, "disk full", at(8, 30, 2));
  await failure(
    annaRun,
    anna,
    "Graph 404 ErrorItemNotFound: The item A was not found.",
    at(9, 2, 1),
  );
  await failure(failedRun, bob, "Graph 404 ErrorItemNotFound: item 3f2b1c0d", at(9, 3, 1));
  await failure(infoRun, info, "=cmd|' /C calc'!A0", at(9, 5, 2));

  /** A restore check of one snapshot. */
  const report = async (
    protectedObjectId: string,
    snapshotId: string | null,
    recoveryReadiness: "green" | "yellow" | "red",
    checkedAt: Date,
    owner = tenantId,
  ) => {
    await db.insert(verifyReports).values({
      tenantId: owner,
      protectedObjectId,
      snapshotId,
      recoveryReadiness,
      checkedAt,
      details: { origin: "verify" },
    });
  };
  /** A storage finding: the storage check found damage in the object's data. */
  const finding = async (owner: string, protectedObjectId: string, checkedAt: Date) => {
    await db.insert(verifyReports).values({
      tenantId: owner,
      protectedObjectId,
      snapshotId: null,
      recoveryReadiness: "red",
      checkedAt,
      details: { origin: "scrub", scrubJobId: null, packs: [] },
    });
  };
  // Anna's previous backup was proven; her backup of 09-02 only from 09-03 on.
  await report(anna, annaBefore, "green", at(8, 29, 6));
  await report(anna, annaLatest, "yellow", at(9, 3, 6));
  await report(bob, bobLatest, "red", at(9, 5, 10));

  // --- Fabrikam: IMAP only, one backup, never checked ------------------------
  const fabrikamSource = one(
    await db
      .insert(sources)
      .values({ tenantId: fabrikam.id, kind: "imap", name: "Fabrikam IMAP", status: "active" })
      .returning(),
  ).id;
  const fabrikamImap = await object(fabrikam.id, fabrikamSource, "imap", "Fabrikam Info", at(8, 1));
  await snapshot(fabrikam.id, fabrikamImap, 1, 700, at(9, 3));
  await pack(fabrikam.id, 350, at(9, 3));
  await job(fabrikam.id, {
    queue: "backup",
    status: "completed",
    protectedObjectId: fabrikamImap,
    ...run(at(9, 3, 4), 90),
  });

  // --- Northwind: the verification rules and the protection statuses --------
  const northwindSource = one(
    await db
      .insert(sources)
      .values({ tenantId: northwind.id, kind: "imap", name: "Northwind IMAP", status: "active" })
      .returning(),
  ).id;
  const northwindObject = (name: string, status: "active" | "excluded" | "orphaned" = "active") =>
    object(northwind.id, northwindSource, "imap", name, at(8, 1), status);
  // Proven on its backup of 08-20, backed up again on 09-03 and not checked since.
  const carla = await northwindObject("Carla");
  const carlaChecked = await snapshot(northwind.id, carla, 1, 800, at(8, 20));
  await report(carla, carlaChecked, "green", at(8, 21, 6), northwind.id);
  await snapshot(northwind.id, carla, 2, 1000, at(9, 3));
  // Proven, then the storage check found damage in its data on 09-04.
  const dora = await northwindObject("Dora");
  const doraBackup = await snapshot(northwind.id, dora, 1, 2000, at(8, 20));
  await report(dora, doraBackup, "green", at(8, 25, 6), northwind.id);
  await finding(northwind.id, dora, at(9, 4, 3));
  // Damage found, then a check after it: the check already accounted for it.
  const emil = await northwindObject("Emil");
  const emilBackup = await snapshot(northwind.id, emil, 1, 600, at(8, 20));
  await finding(northwind.id, emil, at(8, 22, 6));
  await report(emil, emilBackup, "yellow", at(8, 26, 6), northwind.id);
  // Gone from the source but still backed up: protected while its backup exists.
  const frank = await northwindObject("Frank", "orphaned");
  const frankBackup = await snapshot(northwind.id, frank, 1, 400, at(8, 20));
  await report(frank, frankBackup, "green", at(8, 21, 6), northwind.id);
  // Gone from the source without a backup: nothing is protected.
  const gina = await northwindObject("Gina", "orphaned");
  // Excluded: no longer protected, however large its backup.
  const hugo = await northwindObject("Hugo", "excluded");
  const hugoBackup = await snapshot(northwind.id, hugo, 1, 50_000, at(8, 20));
  await report(hugo, hugoBackup, "green", at(8, 21, 6), northwind.id);

  // --- The tenant being deleted: data no scope may show --------------------
  const leavingSource = one(
    await db
      .insert(sources)
      .values({ tenantId: leaving.id, kind: "m365", name: "Leaving M365", status: "active" })
      .returning(),
  ).id;
  const leavingObject = await object(leaving.id, leavingSource, "mailbox", "Leaving", at(8, 1));
  await snapshot(leaving.id, leavingObject, 1, 1_000_000, at(9, 2));

  return {
    contoso: contoso.id,
    fabrikam: fabrikam.id,
    adatum: adatum.id,
    northwind: northwind.id,
    northwindObjects: {
      Carla: carla,
      Dora: dora,
      Emil: emil,
      Frank: frank,
      Gina: gina,
      Hugo: hugo,
    },
    anna,
    bob,
    info,
    fabrikamImap,
  };
}

describe.skipIf(!testDatabaseAdminUrl)("statistics against Postgres", () => {
  let owner: Database;
  let roles: TestDatabaseRoles | undefined;
  let shared: SharedDb;
  let service: Service;
  let verify: VerifyService;
  let app: Hono;
  let f: Fixture;
  /** Whether the test gate opens the provider scope (`stats.allTenants`). */
  let allTenants = false;

  const deps = () => ({ db: shared.db, providerDb: shared.providerDb, now: () => NOW });
  const tenantScope = (id: string, name: string) => ({
    kind: "tenant" as const,
    tenant: { id, name, slug: name.toLowerCase() },
  });

  const request = (path: string, userKey: string, tenantId?: string) =>
    app.request(`/api/v1/stats${path}`, {
      headers: {
        "x-test-user": userKey,
        "x-forwarded-for": CLIENT_IP,
        ...(tenantId ? { "x-restow-tenant": tenantId } : {}),
      },
    });
  const query = (extra: Record<string, string> = {}) =>
    `?${new URLSearchParams({ ...PERIOD, ...extra }).toString()}`;

  const auditRows = (action: string) =>
    owner.select().from(auditLog).where(eq(auditLog.action, action));

  beforeAll(async () => {
    const url = await recreateDatabase(testDatabaseAdminUrl as string, DATABASE);
    roles = await provisionTestRoles(url);
    // The API's shared handles and configuration read the environment on import.
    process.env.DATABASE_URL = roles.appUrl;
    process.env.DATABASE_PROVIDER_URL = roles.providerUrl;
    registerApiExtension({
      name: "test-gate",
      featureGate: {
        isEnabled: async (_db, feature) => feature === "stats.allTenants" && allTenants,
      },
    });

    owner = createDb(url);
    f = await seed(owner);
    shared = await import("../../db.js");
    service = await import("./service.js");
    verify = await import("../verify/service.js");
    const { statsRoutes } = await import("./routes.js");
    const { errorHandler, notFoundHandler } = await import("../../problem.js");
    app = new Hono();
    app.onError(errorHandler);
    app.notFound(notFoundHandler);
    app.route("/api/v1/stats", statsRoutes);
  }, 60_000);

  afterAll(async () => {
    resetExtensionsForTesting();
    if (shared) {
      await Promise.all([shared.db.$client.end(), shared.providerDb.$client.end()]);
    }
    await owner?.$client.end();
    await dropDatabase(testDatabaseAdminUrl as string, DATABASE);
    await roles?.drop(testDatabaseAdminUrl as string);
  });

  describe("tenant scope", () => {
    let stats: StatsDto;

    beforeAll(async () => {
      stats = (await service.loadStats(deps(), tenantScope(f.contoso, "Contoso"), PERIOD)).stats;
    });

    it("describes the period and the one before it", () => {
      expect(stats.period).toEqual({ ...PERIOD, granularity: "day", days: 7 });
      expect(stats.previous).toEqual({ from: "2026-08-25", to: "2026-08-31" });
      expect(stats.scope).toBe("tenant");
      expect(stats.generatedAt).toBe(NOW.toISOString());
    });

    it("computes every key figure with its previous-period value", () => {
      expect(stats.kpis).toEqual({
        backupSuccessRate: { value: 0.75, previous: 0.6667 },
        protectedObjects: { value: 3, previous: 2 },
        logicalBytes: { value: 6500, previous: 6000 },
        physicalBytes: { value: 3600, previous: 3000 },
        dedupRatio: { value: 3.47, previous: 2 },
        restores: { value: 2, previous: 1 },
        verifiedShare: { value: 0.3333, previous: 0.5 },
        throttlingWaitSeconds: { value: 47, previous: 1.5 },
        failedItems: { value: 3, previous: 1 },
      });
    });

    it("splits backup outcomes by day", () => {
      expect(stats.series.backups).toEqual([
        { t: "2026-09-01", succeeded: 0, failed: 0, cancelled: 0 },
        { t: "2026-09-02", succeeded: 1, failed: 0, cancelled: 0 },
        { t: "2026-09-03", succeeded: 0, failed: 1, cancelled: 0 },
        { t: "2026-09-04", succeeded: 1, failed: 0, cancelled: 0 },
        { t: "2026-09-05", succeeded: 1, failed: 0, cancelled: 0 },
        { t: "2026-09-06", succeeded: 0, failed: 0, cancelled: 1 },
        { t: "2026-09-07", succeeded: 0, failed: 0, cancelled: 0 },
      ]);
    });

    it("shows what backups covered and added, and how the store grew", () => {
      expect(stats.series.volume).toEqual([
        { t: "2026-09-01", logicalBytes: 0, physicalBytes: 0 },
        { t: "2026-09-02", logicalBytes: 1200, physicalBytes: 500 },
        { t: "2026-09-03", logicalBytes: 0, physicalBytes: 0 },
        { t: "2026-09-04", logicalBytes: 5000, physicalBytes: 0 },
        { t: "2026-09-05", logicalBytes: 300, physicalBytes: 100 },
        { t: "2026-09-06", logicalBytes: 0, physicalBytes: 0 },
        { t: "2026-09-07", logicalBytes: 0, physicalBytes: 0 },
      ]);
      expect(stats.series.storage).toEqual(
        [3000, 3500, 3500, 3500, 3600, 3600, 3600].map((bytes, index) => ({
          t: `2026-09-0${index + 1}`,
          bytes,
        })),
      );
    });

    it("measures job run times per kind", () => {
      expect(stats.series.jobDurations).toEqual([
        { kind: "backup", p50Seconds: 600, p95Seconds: 1680, count: 3 },
        { kind: "restore", p50Seconds: 120, p95Seconds: 120, count: 1 },
        { kind: "verify", p50Seconds: 60, p95Seconds: 60, count: 1 },
      ]);
    });

    it("adds up Graph throttling from the results and the running totals", () => {
      expect(stats.series.throttling).toEqual([
        { t: "2026-09-01", waitSeconds: 0, events: 0 },
        { t: "2026-09-02", waitSeconds: 30, events: 2 },
        { t: "2026-09-03", waitSeconds: 5, events: 1 },
        { t: "2026-09-04", waitSeconds: 12, events: 1 },
        { t: "2026-09-05", waitSeconds: 0, events: 0 },
        { t: "2026-09-06", waitSeconds: 0, events: 0 },
        { t: "2026-09-07", waitSeconds: 0, events: 0 },
      ]);
    });

    it("counts finished restores only", () => {
      expect(stats.series.restores).toEqual([
        { t: "2026-09-01", completed: 0, failed: 0 },
        { t: "2026-09-02", completed: 0, failed: 0 },
        { t: "2026-09-03", completed: 0, failed: 0 },
        { t: "2026-09-04", completed: 0, failed: 0 },
        { t: "2026-09-05", completed: 0, failed: 0 },
        { t: "2026-09-06", completed: 1, failed: 0 },
        { t: "2026-09-07", completed: 0, failed: 1 },
      ]);
    });

    it("rates readiness at the end of each day", () => {
      const ready = (green: number, yellow: number, red: number, unverified: number) => ({
        green,
        yellow,
        red,
        unverified,
      });
      expect(stats.series.readiness).toEqual(
        [
          ready(1, 0, 0, 1),
          // Anna's backup of 09-02 is newer than her green check: not proven until 09-03.
          ready(0, 0, 0, 2),
          ready(0, 1, 0, 2),
          ready(0, 1, 0, 2),
          ready(0, 1, 1, 1),
          ready(0, 1, 1, 1),
          ready(0, 1, 1, 1),
        ].map((counts, index) => ({ t: `2026-09-0${index + 1}`, ...counts })),
      );
    });

    it("groups failed items by cause and lists the largest objects with their state", () => {
      expect(stats.tables.failuresByCause).toEqual([
        {
          cause: "Graph 404 ErrorItemNotFound",
          count: 2,
          lastAt: at(9, 3, 1).toISOString(),
        },
        { cause: "=cmd|' /C calc'!A0", count: 1, lastAt: at(9, 5, 2).toISOString() },
      ]);
      expect(stats.tables.largestObjects).toEqual([
        {
          id: f.bob,
          name: "Bob",
          kind: "onedrive",
          logicalBytes: 5000,
          lastBackupAt: at(9, 4).toISOString(),
          state: "red",
        },
        {
          id: f.anna,
          name: "Anna",
          kind: "mailbox",
          logicalBytes: 1200,
          lastBackupAt: at(9, 2).toISOString(),
          state: "yellow",
        },
        {
          id: f.info,
          name: "Info",
          kind: "imap",
          logicalBytes: 300,
          lastBackupAt: at(9, 5).toISOString(),
          state: "unverified",
        },
      ]);
      expect(stats.tables.tenants).toBeUndefined();
    });

    it("says which datasets a tenant has no source for instead of reporting zeros", async () => {
      const fabrikam = (
        await service.loadStats(deps(), tenantScope(f.fabrikam, "Fabrikam"), PERIOD)
      ).stats;
      expect(fabrikam.series.throttling).toEqual({ unavailable: "no_microsoft_365_source" });
      expect(fabrikam.kpis.throttlingWaitSeconds).toEqual({ value: null, previous: null });
      // Fabrikam's own figures only: nothing of Contoso leaks in.
      expect(fabrikam.kpis.protectedObjects).toEqual({ value: 1, previous: 1 });
      expect(fabrikam.kpis.physicalBytes).toEqual({ value: 350, previous: 0 });
      expect(fabrikam.tables.largestObjects).toEqual([
        expect.objectContaining({ id: f.fabrikamImap, logicalBytes: 700, state: "unverified" }),
      ]);

      const adatum = (await service.loadStats(deps(), tenantScope(f.adatum, "Adatum"), PERIOD))
        .stats;
      expect(adatum.series.backups).toEqual({ unavailable: "no_protected_objects" });
      expect(adatum.series.storage).toEqual({ unavailable: "no_backups_yet" });
      expect(adatum.tables.largestObjects).toEqual({ unavailable: "no_backups_yet" });
      expect(adatum.kpis.backupSuccessRate).toEqual({ value: null, previous: null });
    });

    it("groups by week and month on request", async () => {
      const weekly = (
        await service.loadStats(deps(), tenantScope(f.contoso, "Contoso"), {
          ...PERIOD,
          granularity: "week",
        })
      ).stats;
      // 2026-09-01 is a Tuesday: the first week is clipped to the period.
      expect(weekly.series.backups).toEqual([
        { t: "2026-09-01", succeeded: 3, failed: 1, cancelled: 1 },
        { t: "2026-09-07", succeeded: 0, failed: 0, cancelled: 0 },
      ]);
      expect(weekly.kpis).toEqual(stats.kpis);
    });
  });

  describe("verification rules", () => {
    let stats: StatsDto;

    beforeAll(async () => {
      stats = (await service.loadStats(deps(), tenantScope(f.northwind, "Northwind"), PERIOD))
        .stats;
    });

    it("rates each object by the check of its newest backup and by later storage findings", () => {
      const ready = (green: number, yellow: number, red: number, unverified: number) => ({
        green,
        yellow,
        red,
        unverified,
      });
      expect(stats.series.readiness).toEqual(
        [
          // Carla, Dora and Frank proven green, Emil yellow (checked after the damage).
          ready(3, 1, 0, 0),
          ready(3, 1, 0, 0),
          // Carla's backup of 09-03 is newer than her green check.
          ready(2, 1, 0, 1),
          // The storage check found damage in Dora's data after her green check.
          ready(1, 1, 1, 1),
          ready(1, 1, 1, 1),
          ready(1, 1, 1, 1),
          ready(1, 1, 1, 1),
        ].map((counts, index) => ({ t: `2026-09-0${index + 1}`, ...counts })),
      );
      expect(stats.kpis.verifiedShare).toEqual({ value: 0.5, previous: 1 });
    });

    it("counts the same objects everywhere: orphans with a backup in, excluded objects out", () => {
      // Carla, Dora, Emil and orphaned Frank; not orphaned Gina (no backup) or excluded Hugo.
      expect(stats.kpis.protectedObjects).toEqual({ value: 4, previous: 4 });
      expect(stats.kpis.logicalBytes).toEqual({ value: 4000, previous: 3800 });
      const readiness = stats.series.readiness;
      expect(Array.isArray(readiness) && readiness.at(-1)).toMatchObject({
        green: 1,
        yellow: 1,
        red: 1,
        unverified: 1,
      });
      expect(stats.tables.largestObjects).toEqual([
        expect.objectContaining({ name: "Dora", logicalBytes: 2000, state: "red" }),
        expect.objectContaining({ name: "Carla", logicalBytes: 1000, state: "unverified" }),
        expect.objectContaining({ name: "Emil", logicalBytes: 600, state: "yellow" }),
        expect.objectContaining({ name: "Frank", logicalBytes: 400, state: "green" }),
      ]);
    });

    it("agrees with the recovery-readiness page once nothing changed after the period", async () => {
      // Nothing happens in either tenant between the end of the period and NOW.
      for (const [tenantId, name] of [
        [f.northwind, "Northwind"],
        [f.contoso, "Contoso"],
      ] as const) {
        const figures = (await service.loadStats(deps(), tenantScope(tenantId, name), PERIOD))
          .stats;
        const page = await verify.readinessOverview(shared.db, tenantId, NOW);
        const last = Array.isArray(figures.series.readiness)
          ? figures.series.readiness.at(-1)
          : undefined;
        expect(last).toEqual({
          t: PERIOD.to,
          green: page.summary.green,
          yellow: page.summary.yellow,
          red: page.summary.red,
          unverified: page.summary.unverified + page.summary.noBackup,
        });
        expect(figures.kpis.protectedObjects.value).toBe(page.summary.total);
        const pageStates = new Map(page.objects.map((entry) => [entry.object.id, entry.state]));
        const largest = Array.isArray(figures.tables.largestObjects)
          ? figures.tables.largestObjects
          : [];
        expect(largest.length).toBeGreaterThan(0);
        for (const row of largest) {
          expect(row.state).toBe(pageStates.get(row.id));
        }
      }
    });
  });

  describe("provider scope", () => {
    it("adds up every tenant except the one being deleted, one row per tenant", async () => {
      const { stats, tenants: covered } = await service.loadStats(
        deps(),
        { kind: "provider" },
        PERIOD,
      );
      expect(covered.map((tenant) => tenant.name)).toEqual([
        "Adatum",
        "Contoso",
        "Fabrikam",
        "Northwind",
      ]);
      expect(stats.scope).toBe("provider");
      expect(stats.kpis.backupSuccessRate).toEqual({ value: 0.8, previous: 0.6667 });
      expect(stats.kpis.protectedObjects).toEqual({ value: 8, previous: 7 });
      expect(stats.kpis.logicalBytes).toEqual({ value: 11_200, previous: 9800 });
      // Proven: Anna, Carla, Dora, Emil, Frank at the start; Anna, Emil, Frank at the end.
      expect(stats.kpis.verifiedShare).toEqual({ value: 0.375, previous: 0.7143 });
      expect(stats.kpis.physicalBytes).toEqual({ value: 3950, previous: 3000 });
      // Contoso has Microsoft 365, so throttling is available for the provider.
      expect(stats.kpis.throttlingWaitSeconds).toEqual({ value: 47, previous: 1.5 });
      expect(stats.series.backups).toEqual(
        expect.arrayContaining([{ t: "2026-09-03", succeeded: 1, failed: 1, cancelled: 0 }]),
      );
      expect(stats.tables.tenants).toEqual([
        {
          id: f.adatum,
          name: "Adatum",
          objects: 0,
          successRate: null,
          logicalBytes: 0,
          physicalBytes: 0,
          readiness: null,
          failures: 0,
        },
        {
          id: f.contoso,
          name: "Contoso",
          objects: 3,
          successRate: 0.75,
          logicalBytes: 6500,
          physicalBytes: 3600,
          readiness: "red",
          failures: 3,
        },
        {
          id: f.fabrikam,
          name: "Fabrikam",
          objects: 1,
          successRate: 1,
          logicalBytes: 700,
          physicalBytes: 350,
          readiness: "red",
          failures: 0,
        },
        {
          id: f.northwind,
          name: "Northwind",
          objects: 4,
          successRate: null,
          logicalBytes: 4000,
          physicalBytes: 0,
          readiness: "red",
          failures: 0,
        },
      ]);
      const largest = stats.tables.largestObjects;
      expect(Array.isArray(largest) && largest.map((row) => [row.name, row.tenant?.name])).toEqual([
        ["Bob", "Contoso"],
        ["Dora", "Northwind"],
        ["Anna", "Contoso"],
        ["Carla", "Northwind"],
        ["Fabrikam Info", "Fabrikam"],
        ["Emil", "Northwind"],
        ["Frank", "Northwind"],
        ["Info", "Contoso"],
      ]);
    });
  });

  describe("routes", () => {
    it("serves a tenant admin and refuses a tenant user", async () => {
      const ok = await request(`${query()}`, "contoso-admin", f.contoso);
      expect(ok.status).toBe(200);
      const body = (await ok.json()) as StatsDto;
      expect(body.kpis.protectedObjects).toEqual({ value: 3, previous: 2 });

      const refused = await request(`${query()}`, "contoso-user", f.contoso);
      expect(refused.status).toBe(403);
      expect(await refused.json()).toMatchObject({ title: "Insufficient role" });
      for (const path of ["/export.csv", "/report.pdf"]) {
        const response = await request(
          `${path}${query({ dataset: "backups" })}`,
          "contoso-user",
          f.contoso,
        );
        expect(response.status).toBe(403);
      }
      expect((await request(`${query()}`, "nobody", f.contoso)).status).toBe(401);
    });

    it("refuses an invalid period", async () => {
      const response = await request("?from=2026-09-10&to=2026-09-01", "contoso-admin", f.contoso);
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({
        type: "urn:restow:problem:stats-period-invalid",
        reason: "from_after_to",
      });
    });

    it("exports a dataset as CSV and audits the export", async () => {
      const response = await request(
        `/export.csv${query({ dataset: "failuresByCause" })}`,
        "contoso-admin",
        f.contoso,
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/csv; charset=utf-8");
      expect(response.headers.get("content-disposition")).toContain(
        'filename="restow-stats-contoso-failuresByCause-2026-09-01-2026-09-07.csv"',
      );
      const bytes = new Uint8Array(await response.arrayBuffer());
      expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
      const csv = new TextDecoder().decode(bytes.subarray(3));
      expect(csv).toBe(
        [
          "cause,count,lastAt",
          `Graph 404 ErrorItemNotFound,2,${at(9, 3, 1).toISOString()}`,
          `'=cmd|' /C calc'!A0,1,${at(9, 5, 2).toISOString()}`,
          "",
        ].join("\r\n"),
      );

      const [entry] = await auditRows("stats.exported");
      expect(entry).toMatchObject({
        tenantId: f.contoso,
        actor: "contoso-admin@example.test",
        target: "failuresByCause",
        targetType: "stats",
        ip: CLIENT_IP,
        details: {
          scope: "tenant",
          format: "csv",
          dataset: "failuresByCause",
          from: PERIOD.from,
          to: PERIOD.to,
          granularity: "day",
          rows: 2,
        },
      });
    });

    it("refuses datasets that do not exist in the scope or have no source", async () => {
      const tenants = await request(
        `/export.csv${query({ dataset: "tenants" })}`,
        "contoso-admin",
        f.contoso,
      );
      expect(tenants.status).toBe(422);
      expect(await tenants.json()).toMatchObject({
        type: "urn:restow:problem:stats-dataset-not-in-scope",
      });
      const throttling = await request(
        `/export.csv${query({ dataset: "throttling" })}`,
        "operator",
        f.fabrikam,
      );
      expect(throttling.status).toBe(409);
      expect(await throttling.json()).toMatchObject({
        type: "urn:restow:problem:stats-dataset-unavailable",
        reason: "no_microsoft_365_source",
      });
      const unknown = await request(
        `/export.csv${query({ dataset: "passwords" })}`,
        "contoso-admin",
        f.contoso,
      );
      expect(unknown.status).toBe(422);
    });

    it("renders the report in German, and audits it", async () => {
      const response = await request(
        `/report.pdf${query({ lang: "de" })}`,
        "contoso-admin",
        f.contoso,
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/pdf");
      expect(response.headers.get("content-disposition")).toContain(
        'filename="restow-stats-contoso-2026-09-01-2026-09-07.pdf"',
      );
      const pdf = await getDocumentProxy(new Uint8Array(await response.arrayBuffer()));
      const { totalPages, text } = await extractText(pdf, { mergePages: true });
      expect(totalPages).toBeGreaterThanOrEqual(2);
      expect(text).toContain("Mandant: Contoso");
      expect(text).toContain("Zeitraum: 01.09.2026 bis 07.09.2026, pro Tag");
      expect(text).toContain("75 %");
      expect(text).toContain(`Seite ${totalPages} von ${totalPages}`);

      const [entry] = await auditRows("stats.report_generated");
      expect(entry).toMatchObject({
        tenantId: f.contoso,
        actor: "contoso-admin@example.test",
        target: "report",
        ip: CLIENT_IP,
        details: expect.objectContaining({ scope: "tenant", format: "pdf", language: "de" }),
      });
    });

    it("refuses the provider scope to tenant admins and while it is off", async () => {
      const tenantAdmin = await request(`${query({ scope: "provider" })}`, "contoso-admin");
      expect(tenantAdmin.status).toBe(403);
      expect(await tenantAdmin.json()).toMatchObject({ title: "Provider admin required" });

      const off = await request(`${query({ scope: "provider" })}`, "operator");
      expect(off.status).toBe(403);
      expect(await off.json()).toMatchObject({
        type: "urn:restow:problem:feature-unavailable",
        feature: "stats.allTenants",
      });
      const report = await request(`/report.pdf${query({ scope: "provider" })}`, "operator");
      expect(report.status).toBe(403);
    });

    // Four tenants through JSON, CSV and a rendered PDF, each audited: 0.3 s alone, 2.4 s in a
    // CI-like full run, 3.7 s and more (past vitest's 5 s default) on a busier machine.
    it("serves the provider scope while it is on and audits in every chain", async () => {
      allTenants = true;
      try {
        const response = await request(`${query({ scope: "provider" })}`, "operator");
        expect(response.status).toBe(200);
        const body = (await response.json()) as StatsDto;
        expect(body.scope).toBe("provider");
        expect(Array.isArray(body.tables.tenants) && body.tables.tenants.length).toBe(4);

        const csv = await request(
          `/export.csv${query({ scope: "provider", dataset: "tenants" })}`,
          "operator",
        );
        expect(csv.status).toBe(200);
        expect(csv.headers.get("content-disposition")).toContain(
          'filename="restow-stats-all-tenants-tenants-2026-09-01-2026-09-07.csv"',
        );
        expect(await csv.text()).toContain(`${f.contoso},Contoso,3,0.75,6500,3600,red,3\r\n`);

        const installation = await owner
          .select()
          .from(auditLog)
          .where(and(eq(auditLog.action, "stats.exported"), isNull(auditLog.tenantId)));
        expect(installation).toHaveLength(1);
        expect(installation[0]).toMatchObject({
          actor: "operator@example.test",
          target: "tenants",
          details: expect.objectContaining({ scope: "provider", tenants: 4 }),
        });
        const perTenant = (await auditRows("stats.exported")).filter(
          (entry) => entry.tenantId !== null && entry.target === "tenants",
        );
        expect(perTenant.map((entry) => entry.tenantId).sort()).toEqual(
          [f.adatum, f.contoso, f.fabrikam, f.northwind].sort(),
        );

        const report = await request(
          `/report.pdf${query({ scope: "provider", lang: "en" })}`,
          "operator",
        );
        expect(report.status).toBe(200);
        const pdf = await getDocumentProxy(new Uint8Array(await report.arrayBuffer()));
        const { text } = await extractText(pdf, { mergePages: true });
        expect(text).toContain("All tenants (4 tenants)");
        expect(text).toContain("Fabrikam");
        expect(text).not.toContain("Leaving");
      } finally {
        allTenants = false;
      }
    }, 30_000);
  });
});
