/**
 * VMs and containers of Proxmox VE in the overviews, against Postgres on the application role
 * that Row Level Security binds: the readiness summary and its rows, the dashboard's Status
 * widgets, GET /status's guest figures, the failures of the provider view, the warnings and the
 * statistics all count a guest by the same rule (features/pve/protection.ts), and never one of
 * another tenant.
 *
 * Contoso (no mailboxes, no machines; PVE jobs "Daily" (daily), "Paused" (off) and "All guests"
 * (every three days, scope all)):
 *   web   VM 101 in Daily, newest restore point read back green, an older one pruned
 *   db    VM 102 in Daily, restore point red (a block did not match), its newest backup failed
 *   cache CT 200 in no job of its own: the job for all guests covers it; restore point unchecked
 *   old   VM 103 in Paused: not protected, but its green restore point is still rated
 *   new   CT 201 in Daily since two days, never backed up: no backup, overdue
 *   tpl   VM 104 template in Daily: PVE cannot back it up, counted nowhere
 *   gone  VM 105 no longer reported by its node: counted nowhere
 * Fabrikam: one VM in no job (and no job for all guests) that keeps a red restore point: not
 * protected, but rated by its restore point and flagged as in no job.
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server as a superuser (the database
 * `restow_api_pve_overview_test` is recreated there and dropped after, the roles with it).
 */
import { randomBytes, randomUUID } from "node:crypto";
import {
  type Database,
  type PveJobSchedule,
  createDb,
  providers,
  pveClusters,
  pveGuests,
  pveJobs,
  pveRuns,
  pveSnapshots,
  tenants,
} from "@restow/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenantTx } from "../../lib/tenant-context.js";
import { type TestDatabaseRoles, provisionTestRoles } from "../../testing/database-roles.js";
import {
  dropDatabase,
  recreateDatabase,
  testDatabaseAdminUrl,
} from "../snapshots/testing/explorer-fixture.js";

const DATABASE = "restow_api_pve_overview_test";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = new Date("2026-10-07T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const STORAGE_ENV = { STORAGE_TARGET: "local", STORAGE_LOCAL_PATH: "/data/chunks" };

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
  guests: Record<"web" | "db" | "cache" | "old" | "new" | "tpl" | "gone" | "foreign", string>;
}

async function seed(db: Database): Promise<Fixture> {
  const provider = one(await db.insert(providers).values({ name: "Provider" }).returning());
  const tenant = async (name: string) =>
    one(
      await db
        .insert(tenants)
        .values({ providerId: provider.id, name, slug: `${name.toLowerCase()}-${randomUUID()}` })
        .returning(),
    ).id;
  const contoso = await tenant("Contoso");
  const fabrikam = await tenant("Fabrikam");

  const cluster = async (tenantId: string) =>
    one(
      await db
        .insert(pveClusters)
        .values({ tenantId, name: "lab", fingerprint: randomUUID(), storageId: "restow" })
        .returning(),
    ).id;
  const contosoCluster = await cluster(contoso);
  const fabrikamCluster = await cluster(fabrikam);

  const daily: PveJobSchedule = { kind: "daily", timeOfDay: "22:00", timeZone: "UTC" };
  const job = async (
    name: string,
    extra: Partial<typeof pveJobs.$inferInsert> = {},
  ): Promise<string> =>
    one(
      await db
        .insert(pveJobs)
        .values({ tenantId: contoso, name, schedule: daily, createdAt: ago(30 * DAY), ...extra })
        .returning(),
    ).id;
  const dailyJob = await job("Daily");
  const pausedJob = await job("Paused", { enabled: false });
  await job("All guests", {
    scopeAll: true,
    schedule: { kind: "interval", intervalMinutes: 3 * 24 * 60, timeZone: "UTC" },
  });

  const guest = async (
    tenantId: string,
    clusterId: string,
    vmid: number,
    name: string,
    extra: Partial<typeof pveGuests.$inferInsert> = {},
  ) =>
    one(
      await db
        .insert(pveGuests)
        .values({
          tenantId,
          clusterId,
          vmid,
          kind: "vm",
          name,
          node: "pve1",
          createdAt: ago(20 * DAY),
          ...extra,
        })
        .returning(),
    ).id;
  const web = await guest(contoso, contosoCluster, 101, "web", {
    jobId: dailyJob,
    lastSuccessAt: ago(2 * HOUR),
  });
  const database = await guest(contoso, contosoCluster, 102, "db", {
    jobId: dailyJob,
    lastSuccessAt: ago(26 * HOUR),
  });
  const cache = await guest(contoso, contosoCluster, 200, "cache", {
    kind: "ct",
    lastSuccessAt: ago(5 * HOUR),
  });
  const old = await guest(contoso, contosoCluster, 103, "old", {
    jobId: pausedJob,
    lastSuccessAt: ago(10 * DAY),
  });
  const fresh = await guest(contoso, contosoCluster, 201, "new", {
    kind: "ct",
    jobId: dailyJob,
    createdAt: ago(2 * DAY),
  });
  const tpl = await guest(contoso, contosoCluster, 104, "tpl", { jobId: dailyJob, template: true });
  const gone = await guest(contoso, contosoCluster, 105, "gone", {
    jobId: dailyJob,
    present: false,
    lastSuccessAt: ago(DAY),
  });
  const foreign = await guest(fabrikam, fabrikamCluster, 101, "fabrikam-vm");

  let sequence = 0;
  const point = async (
    tenantId: string,
    clusterId: string,
    guestId: string,
    at: Date,
    verify: { mismatched: number; errors: string[] } | null,
    extra: Partial<typeof pveSnapshots.$inferInsert> = {},
  ) => {
    sequence += 1;
    await db.insert(pveSnapshots).values({
      tenantId,
      clusterId,
      guestId,
      sequence,
      kind: "vm",
      archiveName: `vm/${sequence}/${at.toISOString()}`,
      storageId: "restow",
      manifestPath: `tenants/${tenantId}/pve/${sequence}`,
      backupAt: at,
      verify: verify
        ? { checkedAt: new Date(at.getTime() + HOUR).toISOString(), blocks: 8, ...verify }
        : null,
      ...extra,
    });
  };
  await point(contoso, contosoCluster, web, ago(3 * DAY), null, {
    status: "pruned",
    prunedAt: ago(DAY),
  });
  await point(contoso, contosoCluster, web, ago(2 * HOUR), { mismatched: 0, errors: [] });
  await point(contoso, contosoCluster, database, ago(26 * HOUR), {
    mismatched: 1,
    errors: ["scsi0: block 7 does not match its SHA-256"],
  });
  await point(contoso, contosoCluster, cache, ago(5 * HOUR), null);
  await point(contoso, contosoCluster, old, ago(10 * DAY), { mismatched: 0, errors: [] });
  await point(fabrikam, fabrikamCluster, foreign, ago(HOUR), { mismatched: 1, errors: ["x"] });

  const run = async (
    guestId: string,
    status: "succeeded" | "failed",
    finishedAt: Date,
    kind: "backup" | "restore" = "backup",
  ) =>
    db.insert(pveRuns).values({
      tenantId: contoso,
      clusterId: contosoCluster,
      guestId,
      kind,
      status,
      startedAt: new Date(finishedAt.getTime() - HOUR),
      finishedAt,
      errorMessage: status === "failed" ? "vzdump failed" : null,
    });
  await run(web, "succeeded", ago(2 * HOUR));
  await run(database, "succeeded", ago(26 * HOUR));
  await run(database, "failed", ago(2 * HOUR));
  await run(cache, "succeeded", ago(5 * HOUR));
  await run(web, "failed", ago(30 * HOUR), "restore");

  return {
    contoso,
    fabrikam,
    guests: { web, db: database, cache, old, new: fresh, tpl, gone, foreign },
  };
}

describe.skipIf(!testDatabaseAdminUrl)("VMs and containers in the overviews", () => {
  let owner: Database;
  let appDb: Database;
  let providerDb: Database;
  let roles: TestDatabaseRoles | undefined;
  let f: Fixture;

  beforeAll(async () => {
    const url = await recreateDatabase(testDatabaseAdminUrl as string, DATABASE);
    roles = await provisionTestRoles(url);
    process.env.DATABASE_URL = roles.appUrl;
    process.env.DATABASE_PROVIDER_URL = roles.providerUrl;
    process.env.RESTOW_MASTER_KEY = randomBytes(32).toString("base64");
    owner = createDb(url);
    appDb = createDb(roles.appUrl);
    providerDb = createDb(roles.providerUrl);
    f = await seed(owner);
  }, 60_000);

  afterAll(async () => {
    const shared = await import("../../db.js");
    await Promise.all([shared.db.$client.end(), shared.providerDb.$client.end()]);
    await Promise.all([owner?.$client.end(), appDb?.$client.end(), providerDb?.$client.end()]);
    await dropDatabase(testDatabaseAdminUrl as string, DATABASE);
    await roles?.drop(testDatabaseAdminUrl as string);
  });

  it("rates the protected guests in the readiness summary, by the restore check of their newest restore point", async () => {
    const { readinessOverview } = await import("../verify/service.js");
    const overview = await readinessOverview(appDb, f.contoso, NOW);
    const byName = Object.fromEntries(overview.guests.map((row) => [row.name, row]));
    expect(Object.keys(byName).sort()).toEqual(["cache", "db", "new", "old", "web"]);
    expect(byName.web).toMatchObject({ state: "green", readiness: "green", inJob: true });
    expect(byName.db).toMatchObject({ state: "red", readiness: "red", inJob: true });
    expect(byName.cache).toMatchObject({ state: "unverified", readiness: null, inJob: true });
    expect(byName.old).toMatchObject({ state: "green", inJob: false });
    expect(byName.new).toMatchObject({ state: "no_backup", overdue: true, inJob: true });
    expect(overview.summary).toMatchObject({
      total: 5,
      green: 2,
      red: 1,
      unverified: 1,
      noBackup: 1,
      withoutJob: 0,
      guestsWithoutJob: 1,
      overall: "red",
    });
  });

  it("counts the guests on the Status tab: protected, in no job, failed, restore points, overdue bound", async () => {
    const { loadDashboard } = await import("../dashboard/service.js");
    const { dashboardQuerySchema } = await import("../dashboard/schemas.js");
    const dto = await loadDashboard(
      { db: appDb, providerDb, env: STORAGE_ENV, now: () => NOW },
      {
        tenant: {
          id: f.contoso,
          name: "Contoso",
          slug: "contoso",
          status: "active",
          organizationId: null,
        } as never,
        role: "tenant_admin",
        isProviderAdmin: false,
      },
      dashboardQuerySchema.parse({ widgets: "lastBackup,protectedObjects,readiness" }),
    );
    const { lastBackup, protectedObjects, readiness } = dto.widgets;
    expect(lastBackup?.state).toBe("ok");
    expect(lastBackup?.state === "ok" && lastBackup.data).toMatchObject({
      guests: { protected: 4, withoutJob: 1, lastSuccessAt: ago(2 * HOUR).toISOString() },
      // The most relaxed enabled PVE job runs every three days: overdue after six.
      staleAfterHours: { guests: 144 },
    });
    expect(protectedObjects?.state === "ok" && protectedObjects.data).toMatchObject({
      active: 0,
      machines: { protected: 0, withoutJob: 0, failedLastBackup: 0 },
      guests: { protected: 4, withoutJob: 1, failedLastBackup: 1, restorePoints: 4 },
      noBackup: 1,
    });
    expect(readiness?.state === "ok" && readiness.data).toMatchObject({
      total: 5,
      overall: "red",
      guestsWithoutJob: 1,
    });
  });

  it("answers GET /status's guest figures and counts failed guest runs in the provider view's failures", async () => {
    const { loadGuestCounts } = await import("./protection.js");
    expect((await loadGuestCounts(appDb, f.contoso, NOW)).counts).toEqual({
      total: 5,
      protected: 4,
      withoutJob: 1,
      failedLastBackup: 1,
      lastSuccessAt: ago(2 * HOUR).toISOString(),
      restorePoints: 4,
    });
    const { loadTenantHealthExtras } = await import("../dashboard/queries.js");
    // The failed backup of db two hours ago, and the failed restore of web the day before.
    expect(await loadTenantHealthExtras(appDb, f.contoso, NOW)).toMatchObject({
      failures24h: 1,
      failuresPrevious24h: 1,
    });
  });

  it("keeps every tenant to its own guests", async () => {
    const { loadGuestCounts } = await import("./protection.js");
    const { readinessOverview } = await import("../verify/service.js");
    // Fabrikam's guest is in no job and nothing covers it: not protected, rated by its old
    // restore point.
    expect((await loadGuestCounts(appDb, f.fabrikam, NOW)).counts).toEqual({
      total: 1,
      protected: 0,
      withoutJob: 1,
      failedLastBackup: 0,
      lastSuccessAt: ago(HOUR).toISOString(),
      restorePoints: 1,
    });
    const overview = await readinessOverview(appDb, f.fabrikam, NOW);
    expect(overview.guests.map((row) => row.name)).toEqual(["fabrikam-vm"]);
    expect(overview.summary).toMatchObject({ total: 1, red: 1, guestsWithoutJob: 1 });
    // Row Level Security: a transaction pinned to Fabrikam sees none of Contoso's rows, whatever
    // the query asks for.
    const seen = await withTenantTx(appDb, f.fabrikam, (tx) =>
      tx.select({ id: pveGuests.id }).from(pveGuests),
    );
    expect(seen.map((row) => row.id)).toEqual([f.guests.foreign]);
    const points = await withTenantTx(appDb, f.fabrikam, (tx) =>
      tx.select({ id: pveSnapshots.id }).from(pveSnapshots),
    );
    expect(points).toHaveLength(1);
  });

  it("counts a failed guest backup on the warnings page, apart from the mailboxes and machines", async () => {
    const { listWarnings } = await import("../warnings/service.js");
    const list = await listWarnings(appDb, f.contoso);
    expect(list.counts).toEqual({ open: 0, acknowledged: 0, failed: 0, failedGuests: 1 });
    expect((await listWarnings(appDb, f.fabrikam)).counts.failedGuests).toBe(0);
  });

  it("puts the guests into the statistics: readiness and backup outcomes", async () => {
    const { collectGuestFacts } = await import("../stats/guest-facts.js");
    const { resolvePeriod } = await import("../stats/period.js");
    const period = resolvePeriod({ from: "2026-10-01", to: "2026-10-07" }, NOW);
    const facts = await withTenantTx(appDb, f.contoso, (tx) =>
      collectGuestFacts(tx, f.contoso, period),
    );
    // The template and the guest no longer reported are left out.
    expect(facts.list.map((row) => row.id).sort()).toEqual(
      [f.guests.web, f.guests.db, f.guests.cache, f.guests.old, f.guests.new].sort(),
    );
    expect(facts.list.find((row) => row.id === f.guests.old)?.inJob).toBe(false);
    expect(facts.restorePoints).toHaveLength(5);
    expect(facts.restorePoints.find((row) => row.guestId === f.guests.db)?.check?.readiness).toBe(
      "red",
    );
    const runs = Object.fromEntries(
      facts.backupRuns.map((row) => [`${row.day}/${row.status}`, row.count]),
    );
    expect(runs).toEqual({
      "2026-10-07/succeeded": 2,
      "2026-10-07/failed": 1,
      "2026-10-06/succeeded": 1,
    });

    const { aggregateTenant } = await import("../stats/aggregate.js");
    const { collectTenantFacts } = await import("../stats/collect.js");
    const tenantFacts = await withTenantTx(appDb, f.contoso, (tx) =>
      collectTenantFacts(tx, { id: f.contoso, name: "Contoso" }, period),
    );
    const aggregate = aggregateTenant(tenantFacts, period, "tenant");
    expect(aggregate.readinessEnd).toEqual({ green: 2, yellow: 0, red: 1, unverified: 2 });
    expect(aggregate.available.objects).toBe(true);
  });
});
