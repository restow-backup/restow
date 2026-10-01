/**
 * Postgres-backed tests of the per-snapshot verification rule across every
 * view that shows it: the readiness overview, the report detail, the
 * integration API (/status, /verify/latest), the explorer's snapshot list and
 * the backup page's snapshot history and object list.
 *
 * The tenant: Ada's mailbox was verified green on backup #1 and backed up
 * again (#2, not checked yet; #3 did not finish); Bob's mailbox is verified
 * on its only backup; Cy's OneDrive was verified, then the storage check found
 * damage in its data; Dan's mailbox was never backed up.
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server (the database
 * `restow_api_verification_test` is recreated there and dropped after).
 */
import { randomUUID } from "node:crypto";
import {
  type Database,
  type NewVerifyReport,
  createDb,
  jobs,
  protectedObjects,
  providers,
  snapshots,
  sources,
  tenants,
  users,
  verifyReports,
} from "@restow/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { loadTenantSummary } from "../../routes/v1/status.js";
import { latestVerification, verifyLatestSchema } from "../../routes/v1/verify.js";
import { snapshotsQuerySchema } from "../jobs/schemas.js";
import { listBackupTargets, listSnapshots as listSnapshotHistory } from "../jobs/service.js";
import { listSnapshots } from "../snapshots/service.js";
import {
  dropDatabase,
  recreateDatabase,
  testDatabaseAdminUrl,
} from "../snapshots/testing/explorer-fixture.js";
import {
  type VerifyActor,
  getReport,
  listReports,
  readinessOverview,
  runVerify,
} from "./service.js";

// The API never runs jobs; enqueueing is pg-boss' business and not under test here.
vi.mock("../jobs/queue.js", async (importOriginal) => {
  const { randomUUID: uuid } = await import("node:crypto");
  return {
    ...(await importOriginal<typeof import("../jobs/queue.js")>()),
    sendJob: async () => uuid(),
  };
});

const DATABASE = "restow_api_verification_test";
const NOW = new Date("2026-09-23T12:00:00.000Z");
const day = (n: number, hour = 2) => new Date(Date.UTC(2026, 8, n, hour));

/** Reads come from a documentation address (RFC 5737). */
const ACTOR: VerifyActor = { userId: null, email: "admin@contoso.test", ip: "198.51.100.7" };
const ADMIN = { role: "tenant_admin" as const, userId: null, email: "admin@contoso.test" };

interface Fixture {
  tenantId: string;
  ada: string;
  bob: string;
  cy: string;
  dan: string;
  eve: string;
  adaFirst: string;
  adaSecond: string;
  adaRunning: string;
  bobOnly: string;
  cyOnly: string;
  adaGreenReport: string;
  cyFinding: string;
}

function one<T>(rows: readonly T[]): T {
  const [first] = rows;
  if (first === undefined) {
    throw new Error("insert returned no row");
  }
  return first;
}

async function createFixture(db: Database): Promise<Fixture> {
  const provider = one(await db.insert(providers).values({ name: "Provider" }).returning());
  const tenant = one(
    await db
      .insert(tenants)
      .values({
        providerId: provider.id,
        name: "Contoso",
        slug: `contoso-${randomUUID().slice(0, 8)}`,
      })
      .returning(),
  );
  const tenantId = tenant.id;
  const source = one(
    await db
      .insert(sources)
      .values({ tenantId, kind: "m365", name: "Contoso M365", status: "active" })
      .returning(),
  );
  const object = async (
    kind: "mailbox" | "onedrive",
    externalId: string,
    displayName: string,
    extra: { userId?: string; createdAt?: Date } = {},
  ) =>
    one(
      await db
        .insert(protectedObjects)
        .values({ tenantId, sourceId: source.id, kind, externalId, displayName, ...extra })
        .returning(),
    ).id;
  // Ada is a real Entra user, linked so the readiness overview can show her
  // address next to her name instead of the opaque Entra object id.
  const adaUser = one(
    await db
      .insert(users)
      .values({ tenantId, email: "ada@contoso.test", displayName: "Ada" })
      .returning(),
  ).id;
  const ada = await object("mailbox", "11111111-1111-4111-8111-111111111111", "Ada", {
    userId: adaUser,
  });
  const bob = await object("mailbox", "bob@contoso.test", "Bob");
  const cy = await object("onedrive", "b!cy", "Cy's OneDrive");
  const dan = await object("mailbox", "dan@contoso.test", "Dan");
  // Eve was protected two days ago and still has no backup: past the grace
  // period, so unlike Dan (protected moments ago) she counts as overdue.
  const eve = await object("mailbox", "eve@contoso.test", "Eve", {
    createdAt: new Date(NOW.getTime() - 48 * 60 * 60 * 1000),
  });

  const snapshot = async (objectId: string, sequence: number, completedAt: Date | null) =>
    one(
      await db
        .insert(snapshots)
        .values({
          tenantId,
          protectedObjectId: objectId,
          sequence,
          manifestPath: completedAt ? `tenants/${tenantId}/manifests/${randomUUID()}.json` : null,
          itemCount: 10 * sequence,
          byteSize: 4096 * sequence,
          startedAt: completedAt ?? day(22),
          completedAt,
        })
        .returning(),
    ).id;
  const adaFirst = await snapshot(ada, 1, day(20));
  const adaSecond = await snapshot(ada, 2, day(22));
  const adaRunning = await snapshot(ada, 3, null);
  const bobOnly = await snapshot(bob, 1, day(21));
  const cyOnly = await snapshot(cy, 1, day(21));

  const report = async (values: Omit<NewVerifyReport, "tenantId">) =>
    one(
      await db
        .insert(verifyReports)
        .values({ tenantId, ...values })
        .returning(),
    ).id;
  const checked = (snapshotId: string) => ({
    origin: "verify",
    kind: "verify",
    snapshot: { id: snapshotId, sequence: 1, completedAt: null, itemCount: 10, packCount: 1 },
    reasons: [],
    counts: { checked: 26, verified: 26, mismatch: 0, missing: 0, unreadable: 0 },
    items: [],
  });
  const adaGreenReport = await report({
    protectedObjectId: ada,
    snapshotId: adaFirst,
    recoveryReadiness: "green",
    details: checked(adaFirst),
    checkedAt: day(20, 3),
  });
  await report({
    protectedObjectId: bob,
    snapshotId: bobOnly,
    recoveryReadiness: "green",
    details: checked(bobOnly),
    checkedAt: day(21, 3),
  });
  await report({
    protectedObjectId: cy,
    snapshotId: cyOnly,
    recoveryReadiness: "green",
    details: checked(cyOnly),
    checkedAt: day(21, 3),
  });
  const cyFinding = await report({
    protectedObjectId: cy,
    snapshotId: null,
    kind: "health_check",
    recoveryReadiness: "red",
    details: {
      origin: "scrub",
      kind: "health_check",
      scrubJobId: randomUUID(),
      reasons: [{ code: "storage_corrupt", severity: "red", count: 1 }],
      packs: [{ path: `tenants/${tenantId}/packs/ab/cd`, targets: [] }],
    },
    checkedAt: day(22, 4),
  });
  return {
    tenantId,
    ada,
    bob,
    cy,
    dan,
    eve,
    adaFirst,
    adaSecond,
    adaRunning,
    bobOnly,
    cyOnly,
    adaGreenReport,
    cyFinding,
  };
}

describe.skipIf(!testDatabaseAdminUrl)("verification per snapshot against Postgres", () => {
  let db: Database;
  let f: Fixture;

  beforeAll(async () => {
    db = createDb(await recreateDatabase(testDatabaseAdminUrl as string, DATABASE));
    f = await createFixture(db);
  }, 60_000);

  afterAll(async () => {
    await db?.$client.end();
    await dropDatabase(testDatabaseAdminUrl as string, DATABASE);
  });

  const byObject = <T extends { object: { id: string } }>(items: readonly T[], id: string) =>
    items.find((item) => item.object.id === id);

  describe("an object backed up again after a green check", () => {
    it("is unverified in the readiness overview, with the older check as history", async () => {
      const overview = await readinessOverview(db, f.tenantId, NOW);

      expect(byObject(overview.objects, f.ada)).toMatchObject({
        state: "unverified",
        readiness: null,
        checkedAt: null,
        report: null,
        overdue: false,
        latestSnapshotId: f.adaSecond,
        latestSnapshotAt: day(22).toISOString(),
        previousCheck: {
          reportId: f.adaGreenReport,
          readiness: "green",
          checkedAt: day(20, 3).toISOString(),
          snapshotId: f.adaFirst,
        },
        // A real address, never the opaque Entra object id used as externalId.
        object: {
          displayName: "Ada",
          externalId: "11111111-1111-4111-8111-111111111111",
          email: "ada@contoso.test",
        },
      });
      expect(byObject(overview.objects, f.bob)).toMatchObject({
        state: "green",
        readiness: "green",
        latestSnapshotId: f.bobOnly,
        previousCheck: null,
      });
      expect(byObject(overview.objects, f.cy)).toMatchObject({
        state: "red",
        readiness: "red",
        report: { id: f.cyFinding, origin: "scrub" },
      });
      expect(byObject(overview.objects, f.dan)).toMatchObject({
        state: "no_backup",
        readiness: null,
        latestSnapshotId: null,
        // Protected moments ago: waiting for its first backup, not a problem yet.
        overdue: false,
      });
      expect(byObject(overview.objects, f.eve)).toMatchObject({
        state: "no_backup",
        readiness: null,
        latestSnapshotId: null,
        // Protected two days ago and still nothing: past the grace period.
        overdue: true,
      });
      expect(overview.summary).toMatchObject({
        total: 5,
        green: 1,
        red: 1,
        unverified: 1,
        noBackup: 2,
        overall: "red",
        // The newest look at any object: the storage finding.
        lastCheckedAt: day(22, 4).toISOString(),
      });
    });

    it("is unverified in /api/v1/status", async () => {
      const summary = await loadTenantSummary(db, f.tenantId, NOW);
      expect(summary.recoveryReadiness).toBe("red");
      expect(summary.readiness).toMatchObject({ unverified: 1, green: 1, red: 1, noBackup: 2 });
      expect(summary.lastVerifyAt).toBe(day(22, 4).toISOString());
    });

    it("is unverified in the integration verify API", async () => {
      const report = await latestVerification(db, f.tenantId, { limit: 100 }, NOW);
      expect(verifyLatestSchema.parse(report)).toEqual(report);
      const ada = report.items.find((item) => item.protectedObjectId === f.ada);
      expect(ada).toMatchObject({
        state: "unverified",
        rating: null,
        report: null,
        latestSnapshotId: f.adaSecond,
        previousCheck: { reportId: f.adaGreenReport, rating: "green", snapshotId: f.adaFirst },
      });
      expect(report.summary.unverified).toBe(1);
    });

    it("shows each backup with its own verification in the explorer's snapshot list", async () => {
      const points = await listSnapshots(db, f.tenantId, ADMIN, { objectId: f.ada, limit: 100 });
      expect(points.map((point) => [point.sequence, point.verification])).toEqual([
        [2, { state: "unverified", checkedAt: null, reportId: null }],
        [1, { state: "green", checkedAt: day(20, 3).toISOString(), reportId: f.adaGreenReport }],
      ]);
      // Damage found after the check rates the checked backup red as well.
      const drive = await listSnapshots(db, f.tenantId, ADMIN, { objectId: f.cy, limit: 100 });
      expect(drive[0]?.verification).toEqual({
        state: "red",
        checkedAt: day(22, 4).toISOString(),
        reportId: f.cyFinding,
      });
    });

    it("shows each backup with its own verification in the snapshot history", async () => {
      const history = await listSnapshotHistory(
        db,
        f.tenantId,
        f.ada,
        snapshotsQuerySchema.parse({}),
      );
      expect(history.snapshots.map((entry) => [entry.sequence, entry.state])).toEqual([
        [3, "incomplete"],
        [2, "completed"],
        [1, "completed"],
      ]);
      expect(history.snapshots.map((entry) => entry.verification?.state ?? null)).toEqual([
        null,
        "unverified",
        "green",
      ]);
      // The object's newest backup is not verified, so nothing reads as proven.
      expect(history.latestVerify).toBeNull();

      const bob = await listSnapshotHistory(db, f.tenantId, f.bob, snapshotsQuerySchema.parse({}));
      expect(bob.latestVerify).toEqual({
        kind: "verify",
        recoveryReadiness: "green",
        checkedAt: day(21, 3).toISOString(),
      });
    });

    it("never shows the older check as the backup page's latest verification", async () => {
      const targets = await listBackupTargets(db, f.tenantId);
      const of = (id: string) => targets.find((target) => target.id === id)?.latestVerify;
      expect(of(f.ada)).toBeNull();
      expect(of(f.bob)).toMatchObject({ recoveryReadiness: "green" });
      expect(of(f.cy)).toMatchObject({ recoveryReadiness: "red", kind: "health_check" });
      expect(of(f.dan)).toBeNull();
    });

    it("names the checked backup on the report and the newer one beside it", async () => {
      const detail = await getReport(db, f.tenantId, f.adaGreenReport, ACTOR);
      expect(detail.snapshotId).toBe(f.adaFirst);
      expect(detail.latestBackup).toEqual({
        snapshotId: f.adaSecond,
        sequence: 2,
        completedAt: day(22).toISOString(),
        verification: { state: "unverified", checkedAt: null, reportId: null },
      });

      const finding = await getReport(db, f.tenantId, f.cyFinding, ACTOR);
      expect(finding.snapshotId).toBeNull();
      expect(finding.latestBackup).toBeNull();

      const history = await listReports(db, f.tenantId, { objectId: f.ada, limit: 10 });
      expect(history.items.map((item) => item.snapshotId)).toEqual([f.adaFirst]);
    });

    it("checks only the unverified objects when asked to", async () => {
      const result = await runVerify(
        db,
        f.tenantId,
        { kind: "verify", unverifiedOnly: true },
        ACTOR,
      );
      expect(result.queued.map((check) => check.protectedObjectId)).toEqual([f.ada]);
      expect(result.skipped).toEqual([
        { protectedObjectId: f.dan, displayName: "Dan", reason: "no_backup" },
        { protectedObjectId: f.eve, displayName: "Eve", reason: "no_backup" },
      ]);
      // The queued check shows as running; the backup stays unverified until it reports.
      const overview = await readinessOverview(db, f.tenantId, NOW);
      expect(byObject(overview.objects, f.ada)).toMatchObject({
        state: "unverified",
        running: { status: "queued", kind: "verify" },
      });
      await db.delete(jobs).where(eq(jobs.tenantId, f.tenantId));
    });
  });

  describe("once the newer backup was checked", () => {
    let newReport: string;

    beforeAll(async () => {
      newReport = one(
        await db
          .insert(verifyReports)
          .values({
            tenantId: f.tenantId,
            protectedObjectId: f.ada,
            snapshotId: f.adaSecond,
            recoveryReadiness: "yellow",
            details: {
              origin: "verify",
              reasons: [{ code: "snapshot_stale", severity: "yellow" }],
            },
            checkedAt: day(22, 6),
          })
          .returning(),
      ).id;
    });

    it("rates the object by that check everywhere", async () => {
      const overview = await readinessOverview(db, f.tenantId, NOW);
      expect(byObject(overview.objects, f.ada)).toMatchObject({
        state: "yellow",
        readiness: "yellow",
        checkedAt: day(22, 6).toISOString(),
        report: { id: newReport },
        previousCheck: null,
      });
      const status = await loadTenantSummary(db, f.tenantId, NOW);
      expect(status.readiness).toMatchObject({ unverified: 0, yellow: 1 });

      const points = await listSnapshots(db, f.tenantId, ADMIN, { objectId: f.ada, limit: 100 });
      expect(points.map((point) => point.verification.state)).toEqual(["yellow", "green"]);

      const targets = await listBackupTargets(db, f.tenantId);
      expect(targets.find((target) => target.id === f.ada)?.latestVerify).toMatchObject({
        recoveryReadiness: "yellow",
      });

      const older = await getReport(db, f.tenantId, f.adaGreenReport, ACTOR);
      expect(older.latestBackup?.verification).toEqual({
        state: "yellow",
        checkedAt: day(22, 6).toISOString(),
        reportId: newReport,
      });
      const current = await getReport(db, f.tenantId, newReport, ACTOR);
      expect(current.latestBackup).toBeNull();
    });

    it("lets a check after a storage finding rate the backup again", async () => {
      await db.insert(verifyReports).values({
        tenantId: f.tenantId,
        protectedObjectId: f.cy,
        snapshotId: f.cyOnly,
        recoveryReadiness: "green",
        details: { origin: "verify", reasons: [] },
        checkedAt: day(22, 8),
      });
      const overview = await readinessOverview(db, f.tenantId, NOW);
      expect(byObject(overview.objects, f.cy)).toMatchObject({ state: "green" });
      const drive = await listSnapshots(db, f.tenantId, ADMIN, { objectId: f.cy, limit: 100 });
      expect(drive[0]?.verification.state).toBe("green");
    });
  });
});
