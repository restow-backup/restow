/**
 * Postgres-backed tests of "confirm as empty" (empty.ts): which objects may be confirmed, what a
 * confirmation does to the rating (neutral `empty`, never yellow, never overdue, never keeping the
 * tenant from green), when it stops counting (any other finding of a newer check), the bulk path,
 * the audit trail and the tenant boundary.
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server (the database
 * `restow_api_empty_test` is recreated there and dropped after).
 */
import { randomUUID } from "node:crypto";
import {
  auditLog,
  backupJobs,
  createDb,
  type Database,
  emptyConfirmations,
  protectedObjects,
  providers,
  snapshots,
  sources,
  tenants,
  users,
  verifyReports,
} from "@restow/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenantTx } from "../../lib/tenant-context.js";
import { ProblemError } from "../../problem.js";
import { listProtectedObjects, objectsQuerySchema } from "../../routes/v1/objects.js";
import { listDirectoryUsers, usersQuerySchema } from "../../routes/v1/users.js";
import { latestVerification, verifyLatestQuerySchema } from "../../routes/v1/verify.js";
import { listObjects as listDirectoryObjects } from "../directory/service.js";
import { listObjects as listExplorerObjects } from "../snapshots/service.js";
import {
  dropDatabase,
  recreateDatabase,
  testDatabaseAdminUrl,
} from "../snapshots/testing/explorer-fixture.js";
import { aggregateTenant } from "../stats/aggregate.js";
import { buildStats } from "../stats/build.js";
import { collectTenantFacts } from "../stats/collect.js";
import { resolvePeriod } from "../stats/period.js";
import {
  confirmEmpty,
  EMPTY_AUDIT_ACTIONS,
  MAX_EMPTY_CONFIRMATIONS,
  revokeEmptyConfirmation,
} from "./empty.js";
import { readinessOverview, type VerifyActor } from "./service.js";

const DATABASE = "restow_api_empty_test";
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

type Reasons = { code: string; severity: "yellow" | "red"; count?: number; ageHours?: number }[];

const EMPTY: Reasons = [{ code: "snapshot_empty", severity: "yellow", count: 6 }];

interface Tenant {
  tenantId: string;
  sourceId: string;
}

async function createTenant(db: Database, name: string): Promise<Tenant> {
  const provider = one(
    await db
      .insert(providers)
      .values({ name: `${name} provider` })
      .returning(),
  );
  const tenant = one(
    await db
      .insert(tenants)
      .values({ providerId: provider.id, name, slug: `${name}-${randomUUID().slice(0, 8)}` })
      .returning(),
  );
  const source = one(
    await db
      .insert(sources)
      .values({ tenantId: tenant.id, kind: "m365", name: `${name} M365`, status: "active" })
      .returning(),
  );
  return { tenantId: tenant.id, sourceId: source.id };
}

/** An object with one backup and (with `reasons`) one check of it, a day old. */
async function object(
  db: Database,
  tenant: Tenant,
  name: string,
  reasons?: Reasons,
  content = { bytes: 0, items: 6 },
): Promise<{ id: string; snapshotId: string }> {
  const row = one(
    await db
      .insert(protectedObjects)
      .values({
        tenantId: tenant.tenantId,
        sourceId: tenant.sourceId,
        kind: "onedrive",
        externalId: `${name}-drive`,
        displayName: name,
        createdAt: ago(60 * 24),
      })
      .returning(),
  );
  const snapshot = one(
    await db
      .insert(snapshots)
      .values({
        tenantId: tenant.tenantId,
        protectedObjectId: row.id,
        sequence: 1,
        manifestPath: `tenants/${tenant.tenantId}/manifests/${randomUUID()}.json`,
        itemCount: content.items,
        byteSize: content.bytes,
        startedAt: ago(30),
        completedAt: ago(30),
      })
      .returning(),
  );
  if (reasons) {
    await report(db, tenant, row.id, snapshot.id, reasons, ago(24), content);
  }
  return { id: row.id, snapshotId: snapshot.id };
}

async function report(
  db: Database,
  tenant: Tenant,
  objectId: string,
  snapshotId: string,
  reasons: Reasons,
  checkedAt: Date,
  content = { bytes: 0, items: 6 },
  source?: Record<string, unknown>,
): Promise<void> {
  await db.insert(verifyReports).values({
    tenantId: tenant.tenantId,
    protectedObjectId: objectId,
    snapshotId,
    recoveryReadiness: reasons.some((reason) => reason.severity === "red")
      ? "red"
      : reasons.length > 0
        ? "yellow"
        : "green",
    details: {
      origin: "verify",
      kind: "verify",
      reasons,
      items: [],
      snapshot: {
        id: snapshotId,
        sequence: 1,
        completedAt: ago(30).toISOString(),
        itemCount: content.items,
        packCount: 1,
        contentBytes: content.bytes,
        contentObjects: content.bytes > 0 ? 1 : 0,
        ...(source ? { source } : {}),
      },
      counts: { checked: content.bytes > 0 ? 1 : 0, verified: content.bytes > 0 ? 1 : 0 },
    },
    checkedAt,
  });
}

describe.skipIf(!testDatabaseAdminUrl)("confirm as empty against Postgres", () => {
  let db: Database;
  let contoso: Tenant;
  let fabrikam: Tenant;
  let empty: { id: string; snapshotId: string };
  let emptyToo: { id: string; snapshotId: string };
  let full: { id: string; snapshotId: string };
  let unchecked: { id: string; snapshotId: string };
  let excluded: { id: string; snapshotId: string };

  beforeAll(async () => {
    db = createDb(await recreateDatabase(testDatabaseAdminUrl as string, DATABASE));
    contoso = await createTenant(db, "contoso");
    fabrikam = await createTenant(db, "fabrikam");
    empty = await object(db, contoso, "Empty drive", EMPTY);
    emptyToo = await object(db, contoso, "Empty site", EMPTY);
    full = await object(db, contoso, "Full drive", [], { bytes: 4096, items: 3 });
    unchecked = await object(db, contoso, "Unchecked drive");
    // Excluded later, with its old empty check: the overview does not list it.
    excluded = await object(db, contoso, "Excluded drive", EMPTY);
    await db
      .update(protectedObjects)
      .set({ status: "excluded" })
      .where(eq(protectedObjects.id, excluded.id));
  }, 60_000);

  afterAll(async () => {
    await db?.$client.end();
    await dropDatabase(testDatabaseAdminUrl as string, DATABASE);
  });

  const overview = () => readinessOverview(db, contoso.tenantId, NOW);
  const entry = async (id: string) => {
    const found = (await overview()).objects.find((item) => item.object.id === id);
    if (!found) {
      throw new Error(`no entry for ${id}`);
    }
    return found;
  };

  it("rates an empty object yellow with its content figures until someone confirms it", async () => {
    const item = await entry(empty.id);
    expect(item.state).toBe("yellow");
    expect(item.emptyConfirmation).toBeNull();
    expect(item.contentStats).toEqual({ items: 6, bytes: 0 });
    expect(item.report?.reasons.map((reason) => reason.code)).toEqual(["snapshot_empty"]);
    const { summary } = await overview();
    expect(summary).toMatchObject({ yellow: 2, empty: 0, overall: "red" });
  });

  it("confirms only objects whose newest check found them empty, and says why not", async () => {
    const stranger = randomUUID();
    const result = await confirmEmpty(
      db,
      contoso.tenantId,
      { objectIds: [empty.id, full.id, unchecked.id, stranger], note: "  Leeres Laufwerk  " },
      ACTOR,
    );
    expect(result.confirmed).toEqual([{ protectedObjectId: empty.id, displayName: "Empty drive" }]);
    expect(result.skipped).toEqual([
      { protectedObjectId: full.id, displayName: "Full drive", reason: "not_empty" },
      { protectedObjectId: unchecked.id, displayName: "Unchecked drive", reason: "no_report" },
      { protectedObjectId: stranger, displayName: null, reason: "not_found" },
    ]);
    const [audit] = await db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.action, EMPTY_AUDIT_ACTIONS.confirmed), eq(auditLog.target, empty.id)),
      );
    expect(audit).toMatchObject({
      tenantId: contoso.tenantId,
      actor: ACTOR.email,
      targetType: "protected_object",
    });
    expect(audit?.details).toMatchObject({
      name: "Empty drive",
      snapshotId: empty.snapshotId,
      itemCount: 6,
      note: "Leeres Laufwerk",
    });
  });

  it("shows a confirmed object as neutral empty: not yellow, not overdue, not keeping the tenant from green", async () => {
    const item = await entry(empty.id);
    expect(item.state).toBe("empty");
    expect(item.overdue).toBe(false);
    expect(item.emptyConfirmation).toMatchObject({
      confirmedBy: ACTOR.email,
      note: "Leeres Laufwerk",
      snapshotId: empty.snapshotId,
    });
    const { summary } = await overview();
    expect(summary).toMatchObject({ yellow: 1, empty: 1, toConfirm: 0 });
    // v1 knows no "empty": the object is green there, and the summary adds it to green.
    const v1 = await latestVerification(
      db,
      contoso.tenantId,
      verifyLatestQuerySchema.parse({}),
      NOW,
    );
    expect(v1.summary).not.toHaveProperty("empty");
    expect(v1.summary.green).toBe(summary.green + 1);
    expect(v1.items.find((row) => row.protectedObjectId === empty.id)?.state).toBe("green");
    // So do /v1/objects and /v1/users.
    const objects = await listProtectedObjects(
      db,
      contoso.tenantId,
      objectsQuerySchema.parse({}),
      NOW,
    );
    expect(objects.items.find((row) => row.id === empty.id)?.readiness).toMatchObject({
      state: "green",
      rating: "green",
      overdue: false,
    });
  });

  it("is never overdue, even when its check is weeks old", async () => {
    const later = new Date(NOW.getTime() + 30 * 24 * HOUR);
    const item = (await readinessOverview(db, contoso.tenantId, later)).objects.find(
      (row) => row.object.id === empty.id,
    );
    expect(item).toMatchObject({ state: "empty", overdue: false });
  });

  it("never confirms an excluded object: listed it is skipped, the filter passes it over", async () => {
    const result = await confirmEmpty(db, contoso.tenantId, { objectIds: [excluded.id] }, ACTOR);
    expect(result.confirmed).toEqual([]);
    expect(result.skipped).toEqual([
      { protectedObjectId: excluded.id, displayName: "Excluded drive", reason: "excluded" },
    ]);
    expect((await overview()).objects.some((item) => item.object.id === excluded.id)).toBe(false);
  });

  it("confirms every empty object not confirmed yet through the filter", async () => {
    const result = await confirmEmpty(
      db,
      contoso.tenantId,
      { filter: { state: "empty_unconfirmed" } },
      ACTOR,
    );
    expect(result.confirmed.map((row) => row.protectedObjectId)).toEqual([emptyToo.id]);
    expect(result.skipped).toEqual([]);
    const { summary } = await overview();
    expect(summary).toMatchObject({ yellow: 0, empty: 2 });
    expect(
      await db
        .select({ id: emptyConfirmations.id })
        .from(emptyConfirmations)
        .where(eq(emptyConfirmations.protectedObjectId, excluded.id)),
    ).toEqual([]);
    expect(
      await db
        .select({ id: auditLog.id })
        .from(auditLog)
        .where(
          and(eq(auditLog.action, EMPTY_AUDIT_ACTIONS.confirmed), eq(auditLog.target, excluded.id)),
        ),
    ).toEqual([]);
  });

  it("stops counting as soon as a newer check says anything else", async () => {
    await report(
      db,
      contoso,
      emptyToo.id,
      emptyToo.snapshotId,
      [...EMPTY, { code: "storage_unreadable", severity: "yellow", count: 1 }],
      ago(1),
    );
    const item = await entry(emptyToo.id);
    expect(item.state).toBe("yellow");
    expect(item.emptyConfirmation).toBeNull();
    // Empty again with nothing else: the confirmation counts again (the worker would have
    // deleted it had the check found content).
    await report(db, contoso, emptyToo.id, emptyToo.snapshotId, EMPTY, ago(0.5));
    expect((await entry(emptyToo.id)).state).toBe("empty");
  });

  it("refuses more than the bulk limit at once", async () => {
    const ids = Array.from({ length: MAX_EMPTY_CONFIRMATIONS + 1 }, () => randomUUID());
    await expect(
      confirmEmpty(db, contoso.tenantId, { objectIds: ids }, ACTOR),
    ).rejects.toBeInstanceOf(ProblemError);
  });

  it("keeps confirmations inside their tenant", async () => {
    const result = await confirmEmpty(db, fabrikam.tenantId, { objectIds: [emptyToo.id] }, ACTOR);
    expect(result.skipped).toEqual([
      { protectedObjectId: emptyToo.id, displayName: null, reason: "not_found" },
    ]);
    await expect(
      revokeEmptyConfirmation(db, fabrikam.tenantId, empty.id, ACTOR),
    ).rejects.toMatchObject({ status: 404 });
    expect(
      await db
        .select({ id: emptyConfirmations.id })
        .from(emptyConfirmations)
        .where(eq(emptyConfirmations.protectedObjectId, empty.id)),
    ).toHaveLength(1);
  });

  it("revokes a confirmation, audited, and the object reads yellow again", async () => {
    await revokeEmptyConfirmation(db, contoso.tenantId, empty.id, ACTOR);
    expect((await entry(empty.id)).state).toBe("yellow");
    const [audit] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, EMPTY_AUDIT_ACTIONS.revoked), eq(auditLog.target, empty.id)));
    expect(audit?.details).toMatchObject({ name: "Empty drive", snapshotId: empty.snapshotId });
    await expect(
      revokeEmptyConfirmation(db, contoso.tenantId, empty.id, ACTOR),
    ).rejects.toMatchObject({ status: 404 });
  });
  describe("empty by Microsoft 365 as well (0.5.0)", () => {
    let northwind: Tenant;
    let drive: { id: string; snapshotId: string };
    let contradicted: { id: string; snapshotId: string };
    const SOURCE_EMPTY: Reasons = [
      { code: "snapshot_empty_confirmed_by_source", severity: "yellow", count: 1 },
    ];
    const measure = { rootBytes: 0, rootChildren: 0, at: ago(30).getTime() };

    beforeAll(async () => {
      northwind = await createTenant(db, "northwind");
      // In a mail job, so nothing but the rating decides the tenant's overall state.
      await db.insert(backupJobs).values({
        tenantId: northwind.tenantId,
        kind: "mail",
        name: "All",
        scopeMode: "all",
        enabled: true,
        schedule: { kind: "cron", cron: "0 22 * * *", timeZone: "UTC" },
      });
      drive = await object(db, northwind, "msp@northwind.example");
      await report(db, northwind, drive.id, drive.snapshotId, SOURCE_EMPTY, ago(24), undefined, {
        service: "onedrive",
        verdict: "empty",
        bytes: 0,
        signal: {
          service: "onedrive",
          before: measure,
          after: measure,
          quota: { used: 12_288, deleted: 0, remaining: 1, total: 2, state: "normal" },
        },
      });
    }, 60_000);

    const northwindEntry = async (id: string) => {
      const found = (await readinessOverview(db, northwind.tenantId, NOW)).objects.find(
        (item) => item.object.id === id,
      );
      if (!found) {
        throw new Error(`no entry for ${id}`);
      }
      return found;
    };

    it("reads empty without a confirmation, with the figures, and counts for no attention", async () => {
      const item = await northwindEntry(drive.id);
      expect(item.state).toBe("empty");
      expect(item.emptyBySource).toBe(true);
      expect(item.emptyConfirmation).toBeNull();
      expect(item.overdue).toBe(false);
      expect(item.contentStats).toMatchObject({
        items: 6,
        bytes: 0,
        source: {
          service: "onedrive",
          verdict: "empty",
          rootBytesBefore: 0,
          rootBytesAfter: 0,
          quotaUsed: 12_288,
        },
      });
      const { summary } = await readinessOverview(db, northwind.tenantId, NOW);
      expect(summary).toMatchObject({ empty: 1, yellow: 0, red: 0, withoutJob: 0, overdue: 0 });
      expect(summary.overall).toBe("green");
      // Nothing for an admin to confirm, listed or by the filter.
      const listed = await confirmEmpty(db, northwind.tenantId, { objectIds: [drive.id] }, ACTOR);
      expect(listed).toEqual({
        confirmed: [],
        skipped: [
          {
            protectedObjectId: drive.id,
            displayName: "msp@northwind.example",
            reason: "empty_by_source",
          },
        ],
      });
      const filtered = await confirmEmpty(
        db,
        northwind.tenantId,
        { filter: { state: "empty_unconfirmed" } },
        ACTOR,
      );
      expect(filtered).toEqual({ confirmed: [], skipped: [] });
    });

    it("counts green, not needing attention, in the statistics the reports are built from", async () => {
      // The summary reports, the provider's report and the customer monthly report read these
      // figures (ee/api reports): a source-proven empty OneDrive must not count as yellow there.
      const period = resolvePeriod({ from: "2026-11-03", to: "2026-11-09" }, NOW);
      const facts = await withTenantTx(db, northwind.tenantId, (tx) =>
        collectTenantFacts(tx, { id: northwind.tenantId, name: "northwind" }, period),
      );
      const aggregate = aggregateTenant(facts, period, "tenant");
      expect(aggregate.readinessEnd).toEqual({ green: 1, yellow: 0, red: 0, unverified: 0 });
      expect(aggregate.overallEnd).toBe("green");
      const stats = buildStats({ period, scope: "tenant", tenants: [aggregate], generatedAt: NOW });
      expect(stats.kpis.verifiedShare.value).toBe(1);
    });

    it("reads empty in the restore explorer and the directory too", async () => {
      const explorer = await listExplorerObjects(db, northwind.tenantId, {
        role: "tenant_admin",
        userId: null,
        email: "admin@northwind.test",
      });
      expect(explorer.find((row) => row.id === drive.id)?.readiness).toBe("empty");
      const page = await listDirectoryObjects(
        db,
        northwind.tenantId,
        { page: 1, pageSize: 50, sort: "name", order: "asc" },
        NOW,
      );
      expect(page.items.find((row) => row.id === drive.id)?.readiness).toMatchObject({
        empty: "source",
      });
    });

    it("reads green and not overdue in /v1/users and /v1/objects, as /v1/verify does", async () => {
      // The maintainer's case: a person with a backed-up mailbox and a never-used OneDrive.
      const person = one(
        await db
          .insert(users)
          .values({ tenantId: northwind.tenantId, email: "msp@northwind.example" })
          .returning(),
      );
      const mailbox = await object(db, northwind, "msp@northwind.example mailbox", [], {
        bytes: 4096,
        items: 3,
      });
      await db
        .update(protectedObjects)
        .set({ kind: "mailbox", userId: person.id })
        .where(eq(protectedObjects.id, mailbox.id));
      await db
        .update(protectedObjects)
        .set({ userId: person.id })
        .where(eq(protectedObjects.id, drive.id));

      const v1 = await latestVerification(
        db,
        northwind.tenantId,
        verifyLatestQuerySchema.parse({}),
        NOW,
      );
      const verified = v1.items.find((row) => row.protectedObjectId === drive.id);
      expect(verified).toMatchObject({ state: "green", rating: "green", overdue: false });

      const objects = await listProtectedObjects(
        db,
        northwind.tenantId,
        objectsQuerySchema.parse({}),
        NOW,
      );
      expect(objects.items.find((row) => row.id === drive.id)?.readiness).toMatchObject({
        state: "green",
        rating: "green",
        overdue: false,
        inJob: true,
      });

      const directory = await listDirectoryUsers(
        db,
        northwind.tenantId,
        usersQuerySchema.parse({}),
        NOW,
      );
      const msp = directory.items.find((row) => row.id === person.id);
      expect(msp?.recoveryReadiness).toBe("green");
      expect(msp?.objects.find((row) => row.id === drive.id)?.readiness).toMatchObject({
        state: "green",
        rating: "green",
        overdue: false,
      });
      expect(msp?.objects.find((row) => row.id === mailbox.id)?.readiness.state).toBe("green");
    });

    it("turns red when Microsoft 365 reports content, and an admin confirmation no longer counts", async () => {
      contradicted = await object(db, northwind, "full@northwind.example");
      await report(
        db,
        northwind,
        contradicted.id,
        contradicted.snapshotId,
        [{ code: "backup_missing_source_content", severity: "red" }],
        ago(24),
      );
      await db.insert(emptyConfirmations).values({
        tenantId: northwind.tenantId,
        protectedObjectId: contradicted.id,
        snapshotId: contradicted.snapshotId,
        confirmedBy: "admin@northwind.test",
      });
      const item = await northwindEntry(contradicted.id);
      expect(item.state).toBe("red");
      expect(item.emptyBySource).toBe(false);
      expect(item.emptyConfirmation).toBeNull();
      const result = await confirmEmpty(
        db,
        northwind.tenantId,
        { objectIds: [contradicted.id] },
        ACTOR,
      );
      expect(result.skipped).toMatchObject([{ reason: "not_empty" }]);
    });
  });
});
