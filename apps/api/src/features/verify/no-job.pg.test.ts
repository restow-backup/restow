/**
 * Postgres-backed tests of mail objects in no backup job: a mailbox, OneDrive or IMAP account that
 * no ENABLED mail job covers is not backed up any more, so the age of its last backup is no fault
 * ("In no backup job", like a guest or a file share). It is rated by whether its newest backup
 * restores, is never overdue, keeps the tenant from green, and shows up the same way in the
 * readiness overview, the report list, the directory, the integration API and the statistics.
 *
 * The tenant mirrors the case that led to it: a mailbox was taken out of its `selected` job; its
 * last backup is 378 hours old, and every readiness check since rated it red.
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server (the database
 * `restow_api_no_job_test` is recreated there and dropped after).
 */
import { randomUUID } from "node:crypto";
import {
  backupJobMembers,
  backupJobs,
  createDb,
  type Database,
  protectedObjects,
  providers,
  snapshots,
  sources,
  tenants,
  verifyReports,
} from "@restow/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenantTx } from "../../lib/tenant-context.js";
import { listProtectedObjects, objectsQuerySchema } from "../../routes/v1/objects.js";
import { loadTenantSummary } from "../../routes/v1/status.js";
import { latestVerification, verifyLatestQuerySchema } from "../../routes/v1/verify.js";
import { loadMailCoverage } from "../backup-jobs/coverage.js";
import { objectsQuerySchema as directoryQuerySchema } from "../directory/schemas.js";
import { listObjects } from "../directory/service.js";
import { listBackupTargets } from "../jobs/service.js";
import {
  dropDatabase,
  recreateDatabase,
  testDatabaseAdminUrl,
} from "../snapshots/testing/explorer-fixture.js";
import { listReportsQuerySchema } from "./schemas.js";
import { getReport, listReports, readinessOverview, type VerifyActor } from "./service.js";

const DATABASE = "restow_api_no_job_test";
const NOW = new Date("2026-11-09T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const ago = (hours: number) => new Date(NOW.getTime() - hours * HOUR);
const ACTOR: VerifyActor = { userId: null, email: "admin@contoso.test", ip: "198.51.100.7" };

function one<T>(rows: readonly T[]): T {
  const [first] = rows;
  if (first === undefined) {
    throw new Error("insert returned no row");
  }
  return first;
}

type Reasons = { code: string; severity: string; count?: number; ageHours?: number }[];

interface Fixture {
  tenantId: string;
  sourceId: string;
  /** In the enabled `selected` job. */
  inJob: string;
  /** Taken out of it: in no job. */
  removed: string;
  /** Member of a disabled job only. */
  ofDisabled: string;
  /** In no job, and its backup does not restore. */
  damaged: string;
  /** In no job and never backed up. */
  never: string;
  /** Excluded by an admin, with a backup. */
  excluded: string;
  reports: Map<string, string>;
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
  const reports = new Map<string, string>();
  const object = async (
    name: string,
    options: {
      status?: "active" | "excluded";
      backupHoursAgo?: number;
      reasons?: Reasons;
      createdAt?: Date;
    } = {},
  ) => {
    const row = one(
      await db
        .insert(protectedObjects)
        .values({
          tenantId,
          sourceId: source.id,
          kind: "mailbox",
          externalId: `${name}@contoso.test`,
          displayName: name,
          status: options.status ?? "active",
          createdAt: options.createdAt ?? ago(60 * 24),
        })
        .returning(),
    );
    if (options.backupHoursAgo === undefined) {
      return row.id;
    }
    const snapshot = one(
      await db
        .insert(snapshots)
        .values({
          tenantId,
          protectedObjectId: row.id,
          sequence: 1,
          manifestPath: `tenants/${tenantId}/manifests/${randomUUID()}.json`,
          itemCount: 10,
          byteSize: 4096,
          startedAt: ago(options.backupHoursAgo),
          completedAt: ago(options.backupHoursAgo),
        })
        .returning(),
    );
    const reasons = options.reasons ?? [];
    const report = one(
      await db
        .insert(verifyReports)
        .values({
          tenantId,
          protectedObjectId: row.id,
          snapshotId: snapshot.id,
          recoveryReadiness: reasons.some((reason) => reason.severity === "red") ? "red" : "green",
          details: { origin: "verify", kind: "verify", reasons, items: [] },
          // Checked a day after the backup: the age reasons are those of that moment.
          checkedAt: ago(options.backupHoursAgo - 24),
        })
        .returning(),
    );
    reports.set(row.id, report.id);
    return row.id;
  };
  const outdated: Reasons = [{ code: "snapshot_outdated", severity: "red", ageHours: 378 }];
  const inJob = await object("injob", { backupHoursAgo: 400, reasons: outdated });
  const removed = await object("removed", { backupHoursAgo: 400, reasons: outdated });
  const ofDisabled = await object("ofdisabled", { backupHoursAgo: 400, reasons: outdated });
  const damaged = await object("damaged", {
    backupHoursAgo: 400,
    reasons: [
      { code: "items_missing", severity: "red", count: 2 },
      { code: "snapshot_outdated", severity: "red", ageHours: 378 },
    ],
  });
  const never = await object("never", { createdAt: ago(72) });
  const excluded = await object("excluded", {
    status: "excluded",
    backupHoursAgo: 400,
    reasons: outdated,
  });

  const job = async (name: string, enabled: boolean) =>
    one(
      await db
        .insert(backupJobs)
        .values({
          tenantId,
          kind: "mail",
          name,
          scopeMode: "selected",
          enabled,
          schedule: { kind: "cron", cron: "0 22 * * *", timeZone: "UTC" },
        })
        .returning(),
    ).id;
  const selected = await job("Selected", true);
  const disabled = await job("Disabled", false);
  await db.insert(backupJobMembers).values([
    { tenantId, jobId: selected, protectedObjectId: inJob },
    { tenantId, jobId: disabled, protectedObjectId: ofDisabled },
  ]);
  return {
    tenantId,
    sourceId: source.id,
    inJob,
    removed,
    ofDisabled,
    damaged,
    never,
    excluded,
    reports,
  };
}

describe.skipIf(!testDatabaseAdminUrl)("mail objects in no backup job against Postgres", () => {
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

  const coverage = () => withTenantTx(db, f.tenantId, (tx) => loadMailCoverage(tx, f.tenantId));

  describe("which objects are in no backup job", () => {
    it("is every active object that no enabled job covers, and no other", async () => {
      const { withoutJob } = await coverage();
      expect([...withoutJob].sort()).toEqual([f.removed, f.ofDisabled, f.damaged, f.never].sort());
      // Not an excluded object (its status says why nothing backs it up), nor one in a job.
      expect(withoutJob.has(f.excluded)).toBe(false);
      expect(withoutJob.has(f.inJob)).toBe(false);
    });

    it("reads a job over everything as covering what the others do not hold", async () => {
      const all = one(
        await db
          .insert(backupJobs)
          .values({
            tenantId: f.tenantId,
            kind: "mail",
            name: "All",
            scopeMode: "all",
            enabled: false,
          })
          .returning(),
      );
      // Disabled: nothing changes.
      const before = await coverage();
      expect(before.withoutJob.has(f.removed)).toBe(true);
      // Enabled: it covers every eligible object no job holds, the disabled job's member excluded.
      await db.update(backupJobs).set({ enabled: true }).where(eq(backupJobs.id, all.id));
      const after = await coverage();
      expect([...after.withoutJob]).toEqual([f.ofDisabled]);
      await db.delete(backupJobs).where(eq(backupJobs.id, all.id));
    });
  });

  describe("the readiness overview", () => {
    it("rates an object in no job by whether its backup restores, not by its age, and never overdue", async () => {
      const overview = await readinessOverview(db, f.tenantId, NOW);
      // In its job, the age counts: red, and the weekly check is long overdue.
      expect(byObject(overview.objects, f.inJob)).toMatchObject({
        state: "red",
        overdue: true,
        inJob: true,
      });
      for (const id of [f.removed, f.ofDisabled]) {
        expect(byObject(overview.objects, id)).toMatchObject({
          state: "green",
          readiness: "green",
          overdue: false,
          inJob: false,
        });
        // The age is set aside, not listed as a finding next to the green rating.
        const item = byObject(overview.objects, id);
        expect(item?.report?.reasons).toEqual([]);
        expect(item?.report?.setAsideReasons.map((reason) => reason.code)).toEqual([
          "snapshot_outdated",
        ]);
      }
      // A backup that does not restore stays red.
      expect(byObject(overview.objects, f.damaged)).toMatchObject({
        state: "red",
        overdue: false,
        inJob: false,
      });
    });

    it("keeps the existing treatment for an object without any backup, and leaves excluded ones out", async () => {
      const overview = await readinessOverview(db, f.tenantId, NOW);
      expect(byObject(overview.objects, f.never)).toMatchObject({
        state: "no_backup",
        // Pinned: the readiness keeps the first-backup rule (overdue after the grace period),
        // while the worker raises no `backup.overdue` alert for an object in no job.
        overdue: true,
        inJob: false,
      });
      expect(byObject(overview.objects, f.excluded)).toBeUndefined();
    });

    it("counts them in the summary withoutJob and keeps the tenant from green", async () => {
      const { summary } = await readinessOverview(db, f.tenantId, NOW);
      // removed, ofDisabled and damaged have a backup; never has none.
      expect(summary).toMatchObject({
        total: 5,
        withoutJob: 3,
        objectsWithoutJob: 3,
        guestsWithoutJob: 0,
        sharesWithoutJob: 0,
      });
      expect(summary.overall).toBe("red");
    });

    it("is yellow, not red, when the only trouble is that nothing backs the objects up", async () => {
      const second = one(await db.insert(providers).values({ name: "Provider 2" }).returning());
      const tenant = one(
        await db
          .insert(tenants)
          .values({
            providerId: second.id,
            name: "Fabrikam",
            slug: `fabrikam-${randomUUID().slice(0, 8)}`,
          })
          .returning(),
      );
      const source = one(
        await db
          .insert(sources)
          .values({ tenantId: tenant.id, kind: "m365", name: "Fabrikam M365", status: "active" })
          .returning(),
      );
      const row = one(
        await db
          .insert(protectedObjects)
          .values({
            tenantId: tenant.id,
            sourceId: source.id,
            kind: "mailbox",
            externalId: "solo@fabrikam.test",
            displayName: "Solo",
            createdAt: ago(60 * 24),
          })
          .returning(),
      );
      const snapshot = one(
        await db
          .insert(snapshots)
          .values({
            tenantId: tenant.id,
            protectedObjectId: row.id,
            sequence: 1,
            manifestPath: `tenants/${tenant.id}/manifests/${randomUUID()}.json`,
            itemCount: 10,
            byteSize: 4096,
            startedAt: ago(400),
            completedAt: ago(400),
          })
          .returning(),
      );
      await db.insert(verifyReports).values({
        tenantId: tenant.id,
        protectedObjectId: row.id,
        snapshotId: snapshot.id,
        recoveryReadiness: "red",
        details: {
          origin: "verify",
          kind: "verify",
          reasons: [{ code: "snapshot_outdated", severity: "red", ageHours: 378 }],
          items: [],
        },
        checkedAt: ago(376),
      });
      const { summary } = await readinessOverview(db, tenant.id, NOW);
      expect(summary).toMatchObject({
        total: 1,
        green: 1,
        red: 0,
        overdue: 0,
        withoutJob: 1,
        objectsWithoutJob: 1,
        overall: "yellow",
      });
      // The integration API reads the same.
      expect((await loadTenantSummary(db, tenant.id, NOW)).recoveryReadiness).toBe("yellow");
    });
  });

  describe("the report of an object in no job", () => {
    it("rates the report without the age and sets it aside, in the list and in the detail", async () => {
      const page = await listReports(
        db,
        f.tenantId,
        listReportsQuerySchema.parse({ objectId: f.removed }),
      );
      expect(page.items[0]).toMatchObject({ readiness: "green", reasons: [] });
      expect(page.items[0]?.setAsideReasons.map((reason) => reason.code)).toEqual([
        "snapshot_outdated",
      ]);
      const detail = await getReport(db, f.tenantId, f.reports.get(f.removed) as string, ACTOR);
      expect(detail).toMatchObject({ readiness: "green", reasons: [] });
      // The same report of an object in its job keeps the age as a finding.
      const inJob = await getReport(db, f.tenantId, f.reports.get(f.inJob) as string, ACTOR);
      expect(inJob.readiness).toBe("red");
      expect(inJob.reasons.map((reason) => reason.code)).toEqual(["snapshot_outdated"]);
    });
  });

  describe("the integration API", () => {
    it("says inJob on the readiness of every object and rates by the restore, not the age", async () => {
      const page = await listProtectedObjects(
        db,
        f.tenantId,
        objectsQuerySchema.parse({ limit: "50" }),
        NOW,
      );
      const readiness = (id: string) => page.items.find((item) => item.id === id)?.readiness;
      expect(readiness(f.inJob)).toMatchObject({ state: "red", inJob: true, overdue: true });
      expect(readiness(f.removed)).toMatchObject({ state: "green", inJob: false, overdue: false });
      expect(readiness(f.damaged)).toMatchObject({ state: "red", inJob: false });
      expect(readiness(f.never)).toMatchObject({ state: "no_backup", inJob: false });
      // Excluded: its status says why; it is not "in no job".
      expect(readiness(f.excluded)).toMatchObject({ inJob: true });
    });

    it("reports inJob and objectsWithoutJob in GET /verify/latest", async () => {
      const latest = await latestVerification(
        db,
        f.tenantId,
        verifyLatestQuerySchema.parse({ limit: "50" }),
        NOW,
      );
      expect(latest.summary).toMatchObject({ withoutJob: 3, objectsWithoutJob: 3 });
      const item = (id: string) => latest.items.find((entry) => entry.protectedObjectId === id);
      expect(item(f.removed)).toMatchObject({ state: "green", inJob: false, overdue: false });
      expect(item(f.inJob)).toMatchObject({ state: "red", inJob: true });
    });
  });

  describe("the backup page", () => {
    it("rates the object by whether its backup restores in the list of backup targets", async () => {
      const targets = await listBackupTargets(db, f.tenantId);
      const verify = (id: string) => targets.find((target) => target.id === id)?.latestVerify;
      expect(verify(f.inJob)).toMatchObject({ recoveryReadiness: "red" });
      expect(verify(f.removed)).toMatchObject({ recoveryReadiness: "green" });
      expect(verify(f.damaged)).toMatchObject({ recoveryReadiness: "red" });
    });
  });

  describe("the directory", () => {
    it("flags the objects in no job and rates them without the age of their backup", async () => {
      const result = await listObjects(db, f.tenantId, directoryQuerySchema.parse({}));
      const row = (id: string) => result.items.find((item) => item.id === id);
      expect(row(f.removed)).toMatchObject({
        withoutJob: true,
        coverage: "none",
        readiness: { rating: "green" },
      });
      // A job that is switched off covers nothing: "in a job that does not run" and in no job.
      expect(row(f.ofDisabled)).toMatchObject({ withoutJob: true, readiness: { rating: "green" } });
      expect(row(f.inJob)).toMatchObject({ withoutJob: false, readiness: { rating: "red" } });
      expect(row(f.damaged)).toMatchObject({ withoutJob: true, readiness: { rating: "red" } });
      expect(row(f.excluded)).toMatchObject({ withoutJob: false });
    });
  });
});
