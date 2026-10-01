/**
 * Postgres-backed tests of the statistics for servers and clients backed up by
 * the agent (docs/AGENT.md): the recovery readiness series, the protected
 * objects and verified-share figures, the provider tenant rows and the backup
 * outcomes count endpoints next to the mailbox objects, rated by the rule the
 * verify page uses. Own database, so the tenants here never change the
 * expectations of stats.pg.test.ts (whose provider scope adds up every tenant).
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server as a
 * superuser (the database `restow_api_stats_endpoints_test` is recreated there
 * and dropped after, the roles with it). Without it the suite is skipped.
 */
import { randomUUID } from "node:crypto";
import {
  type Database,
  type EndpointConfig,
  createDb,
  endpointReports,
  endpointRuns,
  endpoints,
  jobs,
  protectedObjects,
  providers,
  snapshots,
  sources,
  tenants,
  verifyReports,
} from "@restow/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type TestDatabaseRoles, provisionTestRoles } from "../../testing/database-roles.js";
import {
  dropDatabase,
  recreateDatabase,
  testDatabaseAdminUrl,
} from "../snapshots/testing/explorer-fixture.js";
import type { StatsDto } from "./dto.js";

const DATABASE = "restow_api_stats_endpoints_test";

type Service = typeof import("./service.js");
type VerifyService = typeof import("../verify/service.js");
type SharedDb = typeof import("../../db.js");

const at = (month: number, day: number, hour = 12, minute = 0) =>
  new Date(Date.UTC(2026, month - 1, day, hour, minute));

/** The period under test and "now" a day after it. */
const PERIOD = { from: "2026-09-01", to: "2026-09-07" };
const NOW = at(9, 8, 12);

const CONFIG: EndpointConfig = {
  profile: "server",
  schedule: { kind: "daily", timeOfDay: "22:00", timeZone: "Europe/Berlin" },
  paths: ["/etc"],
  excludes: [],
  hooks: {},
  bandwidthKbps: null,
  onlyOnAcPower: false,
  useVss: false,
};

function one<T>(rows: readonly T[]): T {
  const [first] = rows;
  if (first === undefined) {
    throw new Error("insert returned no row");
  }
  return first;
}

interface Fixture {
  /** Endpoints only: a server with a history, a client without a backup, a revoked server. */
  machines: string;
  /** A mailbox with a green check plus a server that was backed up and never tested. */
  mixed: string;
  /** A tenant whose endpoints must never show up in the others' figures. */
  neighbour: string;
  /** Nothing at all. */
  empty: string;
  /** Protected objects only, as before endpoints existed. */
  mailboxes: string;
}

const ready = (green: number, yellow: number, red: number, unverified: number) => ({
  green,
  yellow,
  red,
  unverified,
});

/** One point per day of the period, labelled like the series. */
const days = <T extends object>(points: T[]) =>
  points.map((entry, index) => ({ t: `2026-09-0${index + 1}`, ...entry }));

async function seed(db: Database): Promise<Fixture> {
  const provider = one(await db.insert(providers).values({ name: "Provider" }).returning());
  const tenant = async (name: string) =>
    one(
      await db
        .insert(tenants)
        .values({ providerId: provider.id, name, slug: name.toLowerCase() })
        .returning(),
    ).id;
  const machines = await tenant("Machines");
  const mixed = await tenant("Mixed");
  const neighbour = await tenant("Neighbour");
  const empty = await tenant("Empty");
  const mailboxes = await tenant("Mailboxes");

  const endpoint = async (
    tenantId: string,
    hostname: string,
    profile: "server" | "client",
    createdAt: Date,
    revokedAt: Date | null = null,
  ) =>
    one(
      await db
        .insert(endpoints)
        .values({
          tenantId,
          hostname,
          os: "linux",
          arch: "amd64",
          profile,
          secretHash: randomUUID().replace(/-/g, ""),
          config: { ...CONFIG, profile },
          status: revokedAt ? "revoked" : "active",
          createdAt,
          updatedAt: revokedAt ?? createdAt,
          revokedAt,
        })
        .returning(),
    ).id;

  const run = async (
    tenantId: string,
    endpointId: string,
    values: {
      status: "running" | "succeeded" | "partial" | "failed";
      finishedAt: Date | null;
      snapshotId?: string;
      kind?: "backup" | "restore" | "verify_sample";
      errors?: { code?: string; message: string }[];
    },
  ) => {
    await db.insert(endpointRuns).values({
      tenantId,
      endpointId,
      kind: values.kind ?? "backup",
      status: values.status,
      startedAt: values.finishedAt ? new Date(values.finishedAt.getTime() - 60_000) : at(9, 7),
      finishedAt: values.finishedAt,
      snapshotId: values.snapshotId ?? null,
      errors: values.errors ?? [],
    });
  };
  const test = async (
    tenantId: string,
    endpointId: string,
    snapshotId: string,
    readiness: "green" | "yellow" | "red",
    checkedAt: Date,
    origin: "server" | "agent" = "server",
  ) => {
    await db.insert(endpointReports).values({
      tenantId,
      endpointId,
      kind: "restore_test",
      origin,
      snapshotId,
      readiness,
      checkedAt,
    });
  };

  // --- Machines: endpoints only --------------------------------------------
  const web = await endpoint(machines, "web", "server", at(8, 1));
  // Previous period: backup A, proven green the next day.
  await run(machines, web, { status: "succeeded", finishedAt: at(8, 28), snapshotId: "snap-a" });
  await test(machines, web, "snap-a", "green", at(8, 29, 18));
  await run(machines, web, {
    status: "failed",
    finishedAt: at(8, 30),
    errors: [{ code: "read_error", message: "permission denied" }],
  });
  // 09-02: two backups on one day; only the newer (partial) one is tested, on 09-03.
  await run(machines, web, { status: "succeeded", finishedAt: at(9, 2, 8), snapshotId: "snap-b" });
  await test(machines, web, "snap-b", "green", at(9, 2, 10));
  await run(machines, web, { status: "partial", finishedAt: at(9, 2, 20), snapshotId: "snap-c" });
  await test(machines, web, "snap-c", "green", at(9, 3, 18));
  // 09-03 and 09-04: failed runs. Only a restart of the agent is not a failed backup.
  await run(machines, web, {
    status: "failed",
    finishedAt: at(9, 3, 9),
    errors: [{ code: "read_error", message: "permission denied" }],
  });
  await run(machines, web, { status: "failed", finishedAt: at(9, 4, 9) });
  await run(machines, web, {
    status: "failed",
    finishedAt: at(9, 4, 10),
    errors: [
      { code: "interrupted", message: "agent restarted" },
      { code: "read_error", message: "permission denied" },
    ],
  });
  await run(machines, web, {
    status: "failed",
    finishedAt: at(9, 4, 11),
    errors: [{ code: "interrupted", message: "agent restarted" }],
  });
  // 09-05: a backup whose restore test failed.
  await run(machines, web, { status: "succeeded", finishedAt: at(9, 5, 10), snapshotId: "snap-d" });
  await test(machines, web, "snap-d", "red", at(9, 5, 18));
  // 09-06: neither of these is a backup that finished.
  await run(machines, web, { status: "running", finishedAt: null });
  await run(machines, web, { status: "succeeded", kind: "restore", finishedAt: at(9, 6, 9) });
  await run(machines, web, {
    status: "failed",
    kind: "verify_sample",
    finishedAt: at(9, 6, 9),
    errors: [{ code: "hash_mismatch", message: "differs" }],
  });
  await db.insert(endpointReports).values({
    tenantId: machines,
    endpointId: web,
    kind: "repository_check",
    origin: "server",
    readiness: "green",
    checkedAt: at(9, 6, 10),
  });

  // A client that joined on 09-03 and never delivered a backup.
  await endpoint(machines, "laptop", "client", at(9, 3, 8));
  // A server that was proven, then revoked on 09-04: protected until then only.
  const old = await endpoint(machines, "old", "server", at(8, 1), at(9, 4, 12));
  await run(machines, old, { status: "succeeded", finishedAt: at(8, 28), snapshotId: "old-a" });
  await test(machines, old, "old-a", "green", at(8, 29, 18));

  // --- Mixed: a mailbox and a server ---------------------------------------
  const source = one(
    await db
      .insert(sources)
      .values({ tenantId: mixed, kind: "m365", name: "Mixed M365", status: "active" })
      .returning(),
  ).id;
  const anna = one(
    await db
      .insert(protectedObjects)
      .values({
        tenantId: mixed,
        sourceId: source,
        kind: "mailbox",
        externalId: "anna",
        displayName: "Anna",
        status: "active",
        createdAt: at(8, 1),
      })
      .returning(),
  ).id;
  const annaSnapshot = one(
    await db
      .insert(snapshots)
      .values({
        tenantId: mixed,
        protectedObjectId: anna,
        sequence: 1,
        byteSize: 1000,
        startedAt: at(8, 28),
        completedAt: at(8, 28),
        manifestPath: `tenants/${mixed}/manifests/${randomUUID()}`,
      })
      .returning(),
  ).id;
  await db.insert(verifyReports).values({
    tenantId: mixed,
    protectedObjectId: anna,
    snapshotId: annaSnapshot,
    recoveryReadiness: "green",
    checkedAt: at(8, 29, 6),
    details: { origin: "verify" },
  });
  await db.insert(jobs).values({
    tenantId: mixed,
    queue: "backup",
    status: "completed",
    protectedObjectId: anna,
    startedAt: at(9, 2, 1),
    completedAt: at(9, 2, 2),
  });
  const database = await endpoint(mixed, "db", "server", at(8, 1));
  await run(mixed, database, { status: "succeeded", finishedAt: at(9, 2, 22), snapshotId: "db-1" });
  await run(mixed, database, { status: "failed", finishedAt: at(9, 3, 22) });

  // --- Neighbour: endpoints that no other tenant may see --------------------
  const other = await endpoint(neighbour, "other", "server", at(8, 1));
  await run(neighbour, other, { status: "succeeded", finishedAt: at(9, 2), snapshotId: "n-1" });
  await test(neighbour, other, "n-1", "green", at(9, 3));

  // --- Mailboxes: protected objects and no endpoint at all ------------------
  const mailboxSource = one(
    await db
      .insert(sources)
      .values({ tenantId: mailboxes, kind: "imap", name: "IMAP", status: "active" })
      .returning(),
  ).id;
  await db.insert(protectedObjects).values({
    tenantId: mailboxes,
    sourceId: mailboxSource,
    kind: "imap",
    externalId: "info",
    displayName: "Info",
    status: "active",
    createdAt: at(8, 1),
  });

  return { machines, mixed, neighbour, empty, mailboxes };
}

describe.skipIf(!testDatabaseAdminUrl)("statistics of endpoints against Postgres", () => {
  let owner: Database;
  let roles: TestDatabaseRoles | undefined;
  let shared: SharedDb;
  let service: Service;
  let verify: VerifyService;
  let f: Fixture;

  const deps = () => ({ db: shared.db, providerDb: shared.providerDb, now: () => NOW });
  const scope = (id: string, name: string) => ({
    kind: "tenant" as const,
    tenant: { id, name, slug: name.toLowerCase() },
  });
  const load = async (id: string, name: string): Promise<StatsDto> =>
    (await service.loadStats(deps(), scope(id, name), PERIOD)).stats;

  beforeAll(async () => {
    const url = await recreateDatabase(testDatabaseAdminUrl as string, DATABASE);
    roles = await provisionTestRoles(url);
    // The API's shared handles and configuration read the environment on import.
    process.env.DATABASE_URL = roles.appUrl;
    process.env.DATABASE_PROVIDER_URL = roles.providerUrl;

    owner = createDb(url);
    f = await seed(owner);
    shared = await import("../../db.js");
    service = await import("./service.js");
    verify = await import("../verify/service.js");
  }, 60_000);

  afterAll(async () => {
    if (shared) {
      await Promise.all([shared.db.$client.end(), shared.providerDb.$client.end()]);
    }
    await owner?.$client.end();
    await dropDatabase(testDatabaseAdminUrl as string, DATABASE);
    await roles?.drop(testDatabaseAdminUrl as string);
  });

  describe("a tenant with endpoints only", () => {
    let stats: StatsDto;

    beforeAll(async () => {
      stats = await load(f.machines, "Machines");
    });

    it("is available and counted, not reported as having nothing protected", () => {
      expect(Array.isArray(stats.series.readiness)).toBe(true);
      expect(Array.isArray(stats.series.backups)).toBe(true);
      expect(Array.isArray(stats.tables.failuresByCause)).toBe(true);
      // Protected at the start: web and the server revoked later; at the end: web and the client.
      expect(stats.kpis.protectedObjects).toEqual({ value: 2, previous: 2 });
      expect(stats.kpis.verifiedShare).toEqual({ value: 0, previous: 1 });
    });

    it("rates each endpoint at the end of each day by the restore test of its newest backup", () => {
      // web: green, then unverified (newest backup of 09-02 untested until 09-03 18:00), yellow
      // (partial), red from 09-05 (the test of backup D failed). The repository check of 09-06
      // was green and changes nothing. laptop: unverified from 09-03 (no backup). old: green
      // until it is revoked at noon of 09-04.
      expect(stats.series.readiness).toEqual(
        days([
          ready(2, 0, 0, 0),
          ready(1, 0, 0, 1),
          ready(1, 1, 0, 1),
          ready(0, 1, 0, 1),
          ready(0, 0, 1, 1),
          ready(0, 0, 1, 1),
          ready(0, 0, 1, 1),
        ]),
      );
    });

    it("counts finished backup runs: partial as succeeded, a restart of the agent not at all", () => {
      expect(stats.series.backups).toEqual(
        days([
          { succeeded: 0, failed: 0, cancelled: 0 },
          { succeeded: 2, failed: 0, cancelled: 0 },
          { succeeded: 0, failed: 1, cancelled: 0 },
          // One failed run without errors, one with an interrupted and a real error: both failed.
          // The run that only says "interrupted" is skipped.
          { succeeded: 0, failed: 2, cancelled: 0 },
          { succeeded: 1, failed: 0, cancelled: 0 },
          // A running backup, a restore and a restore test are no finished backups.
          { succeeded: 0, failed: 0, cancelled: 0 },
          { succeeded: 0, failed: 0, cancelled: 0 },
        ]),
      );
      // Current: 3 succeeded, 3 failed. Previous: web's 08-28 and old's 08-28 succeeded, 08-30 failed.
      expect(stats.kpis.backupSuccessRate).toEqual({ value: 0.5, previous: 0.6667 });
    });

    it("leaves the chunk store figures alone: endpoints add nothing there", () => {
      expect(stats.series.volume).toEqual({ unavailable: "no_backups_yet" });
      expect(stats.series.storage).toEqual({ unavailable: "no_backups_yet" });
      expect(stats.series.restores).toEqual({ unavailable: "no_backups_yet" });
      expect(stats.tables.largestObjects).toEqual({ unavailable: "no_backups_yet" });
      expect(stats.kpis.logicalBytes).toEqual({ value: null, previous: null });
      expect(stats.kpis.physicalBytes).toEqual({ value: null, previous: null });
      expect(stats.series.throttling).toEqual({ unavailable: "no_microsoft_365_source" });
      expect(stats.tables.failuresByCause).toEqual([]);
      expect(stats.kpis.failedItems).toEqual({ value: 0, previous: 0 });
    });

    it("agrees with the recovery-readiness page once nothing changed after the period", async () => {
      const page = await verify.readinessOverview(shared.db, f.machines, NOW);
      expect(page.endpoints.map((row) => [row.hostname, row.state])).toEqual([
        ["laptop", "no_backup"],
        ["web", "red"],
      ]);
      const last = Array.isArray(stats.series.readiness) ? stats.series.readiness.at(-1) : null;
      expect(last).toEqual({
        t: PERIOD.to,
        green: page.summary.green,
        yellow: page.summary.yellow,
        red: page.summary.red,
        unverified: page.summary.unverified + page.summary.noBackup,
      });
      expect(stats.kpis.protectedObjects.value).toBe(page.summary.total);
    });
  });

  describe("a tenant with mailbox objects and endpoints", () => {
    it("sums both in the readiness series and the protected objects", async () => {
      const stats = await load(f.mixed, "Mixed");
      // Anna's mailbox is proven on its one backup; the server was backed up and never tested.
      expect(stats.series.readiness).toEqual(
        days([
          ready(1, 0, 0, 1),
          ready(1, 0, 0, 1),
          ready(1, 0, 0, 1),
          ready(1, 0, 0, 1),
          ready(1, 0, 0, 1),
          ready(1, 0, 0, 1),
          ready(1, 0, 0, 1),
        ]),
      );
      expect(stats.kpis.protectedObjects).toEqual({ value: 2, previous: 2 });
      expect(stats.kpis.verifiedShare).toEqual({ value: 0.5, previous: 0.5 });

      // The job based backup and the endpoint backup of 09-02 are one day's outcomes.
      expect(stats.series.backups).toEqual(
        days([
          { succeeded: 0, failed: 0, cancelled: 0 },
          { succeeded: 2, failed: 0, cancelled: 0 },
          { succeeded: 0, failed: 1, cancelled: 0 },
          { succeeded: 0, failed: 0, cancelled: 0 },
          { succeeded: 0, failed: 0, cancelled: 0 },
          { succeeded: 0, failed: 0, cancelled: 0 },
          { succeeded: 0, failed: 0, cancelled: 0 },
        ]),
      );
      expect(stats.kpis.backupSuccessRate).toEqual({ value: 0.6667, previous: null });
      // The mailbox has a backup, so its chunk store figures exist; the endpoint adds none.
      expect(stats.kpis.logicalBytes).toEqual({ value: 1000, previous: 1000 });
    });

    it("agrees with the recovery-readiness page", async () => {
      const stats = await load(f.mixed, "Mixed");
      const page = await verify.readinessOverview(shared.db, f.mixed, NOW);
      const last = Array.isArray(stats.series.readiness) ? stats.series.readiness.at(-1) : null;
      expect(last).toEqual({
        t: PERIOD.to,
        green: page.summary.green,
        yellow: page.summary.yellow,
        red: page.summary.red,
        unverified: page.summary.unverified + page.summary.noBackup,
      });
      expect(stats.kpis.protectedObjects.value).toBe(page.summary.total);
    });
  });

  describe("tenants apart", () => {
    it("keeps another tenant's endpoints out of the figures", async () => {
      const stats = await load(f.neighbour, "Neighbour");
      expect(stats.kpis.protectedObjects).toEqual({ value: 1, previous: 1 });
      expect(stats.series.readiness).toEqual(
        days([
          // Backed up on 09-02 at noon, tested at noon of 09-03.
          ready(0, 0, 0, 1),
          ready(0, 0, 0, 1),
          ready(1, 0, 0, 0),
          ready(1, 0, 0, 0),
          ready(1, 0, 0, 0),
          ready(1, 0, 0, 0),
          ready(1, 0, 0, 0),
        ]),
      );
    });

    it("still reports a tenant without endpoints as before, and an empty one as unavailable", async () => {
      const mailboxes = await load(f.mailboxes, "Mailboxes");
      expect(mailboxes.kpis.protectedObjects).toEqual({ value: 1, previous: 1 });
      expect(mailboxes.series.readiness).toEqual(
        days(Array.from({ length: 7 }, () => ready(0, 0, 0, 1))),
      );
      const empty = await load(f.empty, "Empty");
      expect(empty.series.readiness).toEqual({ unavailable: "no_protected_objects" });
      expect(empty.series.backups).toEqual({ unavailable: "no_protected_objects" });
      expect(empty.kpis.protectedObjects).toEqual({ value: 0, previous: 0 });
    });

    it("adds every tenant's endpoints up in the provider scope and in its tenant rows", async () => {
      const { stats } = await service.loadStats(deps(), { kind: "provider" }, PERIOD);
      // Machines 2, Mixed 2, Neighbour 1, Mailboxes 1, Empty 0 at the end of the period.
      expect(stats.kpis.protectedObjects).toEqual({ value: 6, previous: 6 });
      expect(stats.tables.tenants).toEqual([
        expect.objectContaining({ name: "Empty", objects: 0, readiness: null }),
        expect.objectContaining({ name: "Machines", objects: 2, readiness: "red" }),
        expect.objectContaining({ name: "Mailboxes", objects: 1, readiness: "red" }),
        expect.objectContaining({
          name: "Mixed",
          objects: 2,
          readiness: "red",
          successRate: 0.6667,
        }),
        expect.objectContaining({ name: "Neighbour", objects: 1, readiness: "green" }),
      ]);
    });
  });
});
