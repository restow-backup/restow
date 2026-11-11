/**
 * Postgres-backed test of the backup's age in the readiness views (0.5.0): a check rates the age
 * of the backup it read when it runs, but the backup keeps getting older. A mailbox whose
 * backups stopped right after a green check (an expired Entra secret, say) must not stay green
 * until the next weekly check: the overview, the tenant rating and the integration API judge
 * the age now, yellow after 48 hours, red after 7 days, as the check itself would.
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server (the database
 * `restow_api_verify_age_test` is recreated there and dropped after).
 */
import { randomUUID } from "node:crypto";
import {
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
import { listProtectedObjects } from "../../routes/v1/objects.js";
import { loadTenantSummary } from "../../routes/v1/status.js";
import { listMembers } from "../backup-jobs/read.js";
import { objectsQuerySchema as directoryQuerySchema } from "../directory/schemas.js";
import { listObjects } from "../directory/service.js";
import {
  dropDatabase,
  recreateDatabase,
  testDatabaseAdminUrl,
} from "../snapshots/testing/explorer-fixture.js";
import { readinessOverview } from "./service.js";

const DATABASE = "restow_api_verify_age_test";
const NOW = new Date("2026-11-09T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const ago = (hours: number) => new Date(NOW.getTime() - hours * HOUR);

function one<T>(rows: readonly T[]): T {
  const [first] = rows;
  if (first === undefined) {
    throw new Error("insert returned no row");
  }
  return first;
}

describe.skipIf(!testDatabaseAdminUrl)("the backup's age in the readiness views", () => {
  let db: Database;
  let tenantId: string;
  const ids = new Map<string, string>();

  /** A mailbox whose last backup is `hours` old, rated green by a check an hour after it. */
  async function mailbox(name: string, hours: number, status: "active" | "orphaned" = "active") {
    const source = one(
      await db
        .insert(sources)
        .values({ tenantId, kind: "m365", name: `M365 ${name}`, status: "active" })
        .returning(),
    );
    const object = one(
      await db
        .insert(protectedObjects)
        .values({
          tenantId,
          sourceId: source.id,
          kind: "mailbox",
          externalId: `${name}@contoso.test`,
          displayName: name,
          status,
          createdAt: ago(60 * 24),
        })
        .returning(),
    );
    const snapshot = one(
      await db
        .insert(snapshots)
        .values({
          tenantId,
          protectedObjectId: object.id,
          sequence: 1,
          manifestPath: `tenants/${tenantId}/manifests/${randomUUID()}.json`,
          itemCount: 10,
          byteSize: 4096,
          startedAt: ago(hours),
          completedAt: ago(hours),
        })
        .returning(),
    );
    await db.insert(verifyReports).values({
      tenantId,
      protectedObjectId: object.id,
      snapshotId: snapshot.id,
      recoveryReadiness: "green",
      details: { origin: "verify", kind: "verify", reasons: [], items: [] },
      checkedAt: ago(hours - 1),
    });
    ids.set(name, object.id);
  }

  beforeAll(async () => {
    db = createDb(await recreateDatabase(testDatabaseAdminUrl as string, DATABASE));
    const provider = one(await db.insert(providers).values({ name: "Provider" }).returning());
    tenantId = one(
      await db
        .insert(tenants)
        .values({
          providerId: provider.id,
          name: "Contoso",
          slug: `contoso-${randomUUID().slice(0, 8)}`,
        })
        .returning(),
    ).id;
    // One enabled job over every mailbox: each is backed up on schedule (and is not, here).
    await db.insert(backupJobs).values({
      tenantId,
      kind: "mail",
      name: "All mail",
      scopeMode: "all",
      enabled: true,
      schedule: { kind: "cron", cron: "0 22 * * *", timeZone: "UTC" },
    });
    await mailbox("current", 10);
  }, 60_000);

  afterAll(async () => {
    await db?.$client.end();
    await dropDatabase(testDatabaseAdminUrl as string, DATABASE);
  });

  const item = async (name: string) =>
    (await readinessOverview(db, tenantId, NOW)).objects.find(
      (entry) => entry.object.id === ids.get(name),
    );

  it("keeps a green check green while the backup is current", async () => {
    expect(await item("current")).toMatchObject({ state: "green", readiness: "green" });
    expect((await item("current"))?.report?.reasons).toEqual([]);
  });

  it("turns a green check yellow once its backup is three days old, and the tenant with it [READY-004]", async () => {
    await mailbox("stale", 72);
    expect(await item("stale")).toMatchObject({ state: "yellow", readiness: "yellow" });
    expect((await item("stale"))?.report?.reasons).toEqual([
      expect.objectContaining({ code: "snapshot_stale", severity: "yellow", ageHours: 72 }),
    ]);
    const { summary } = await readinessOverview(db, tenantId, NOW);
    expect(summary).toMatchObject({ green: 1, yellow: 1, overall: "yellow" });
    expect((await loadTenantSummary(db, tenantId, NOW)).recoveryReadiness).toBe("yellow");
  });

  it("turns it red once the backup is older than seven days [READY-004]", async () => {
    await mailbox("outdated", 8 * 24);
    expect(await item("outdated")).toMatchObject({ state: "red", readiness: "red" });
    expect((await item("outdated"))?.report?.reasons.map((reason) => reason.code)).toEqual([
      "snapshot_outdated",
    ]);
    expect((await loadTenantSummary(db, tenantId, NOW)).recoveryReadiness).toBe("red");
  });

  it("rates the age now in the integration API, the directory and the job view too [READY-004]", async () => {
    await mailbox("api-stale", 72);
    await mailbox("api-outdated", 8 * 24);
    const objects = await listProtectedObjects(db, tenantId, { limit: 100 }, NOW);
    const ratingOf = (name: string) =>
      objects.items.find((entry) => entry.id === ids.get(name))?.readiness;
    expect(ratingOf("current")).toMatchObject({ state: "green", rating: "green" });
    expect(ratingOf("api-stale")).toMatchObject({ rating: "yellow" });
    expect(ratingOf("api-outdated")).toMatchObject({ state: "red", rating: "red" });

    const directory = await listObjects(
      db,
      tenantId,
      directoryQuerySchema.parse({ pageSize: 100 }),
      NOW,
    );
    const listed = (name: string) =>
      directory.items.find((entry) => entry.id === ids.get(name))?.readiness?.rating;
    expect(listed("current")).toBe("green");
    expect(listed("api-stale")).toBe("yellow");
    expect(listed("api-outdated")).toBe("red");

    const [job] = await db.select().from(backupJobs).where(eq(backupJobs.tenantId, tenantId));
    const members = await listMembers(db, tenantId, job?.id as string, { revealHooks: false }, NOW);
    const member = (name: string) =>
      members.items.find((entry) => entry.targetId === ids.get(name))?.restoreCheck.state;
    expect(member("current")).toBe("green");
    expect(member("api-stale")).toBe("yellow");
    expect(member("api-outdated")).toBe("red");
  });

  it("still rates a mailbox removed from its source without the age of its last backup [READY-010]", async () => {
    await mailbox("removed", 30 * 24, "orphaned");
    expect(await item("removed")).toMatchObject({ state: "green", readiness: "green" });
  });
});
