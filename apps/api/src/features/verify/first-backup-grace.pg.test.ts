/**
 * Postgres-backed regression coverage for the first-backup grace period's
 * "since" date and its interaction with a first backup already in flight
 * (docs/ARCHITECTURE.md, readiness overview).
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server (the
 * database `restow_api_first_backup_grace_test` is recreated there and
 * dropped after).
 */
import { randomUUID } from "node:crypto";
import {
  type Database,
  createDb,
  jobs,
  protectedObjects,
  providers,
  sources,
  tenants,
} from "@restow/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  dropDatabase,
  recreateDatabase,
  testDatabaseAdminUrl,
} from "../snapshots/testing/explorer-fixture.js";
import { readinessOverview } from "./service.js";

const DATABASE = "restow_api_first_backup_grace_test";
const NOW = new Date("2026-09-23T12:00:00.000Z");
const TWO_DAYS_AGO = new Date(NOW.getTime() - 48 * 60 * 60 * 1000);

function one<T>(rows: readonly T[]): T {
  const [first] = rows;
  if (first === undefined) {
    throw new Error("insert returned no row");
  }
  return first;
}

interface Fixture {
  tenantId: string;
  legacy: string;
  reincluded: string;
  firstBackupRunning: string;
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

  // A row written before `active_since` existed: created and active from the
  // start, so the column is left null and the readiness view must still
  // judge it by `created_at`, the same as before the column was added.
  const legacy = one(
    await db
      .insert(protectedObjects)
      .values({
        tenantId,
        sourceId: source.id,
        kind: "mailbox",
        externalId: "legacy@contoso.test",
        displayName: "Legacy",
        status: "active",
        createdAt: TWO_DAYS_AGO,
      })
      .returning(),
  ).id;

  // Created excluded two days ago (the directory's rules never selected it),
  // included moments ago: protection itself is brand new, so the old
  // `created_at` must not make it look overdue.
  const reincluded = one(
    await db
      .insert(protectedObjects)
      .values({
        tenantId,
        sourceId: source.id,
        kind: "mailbox",
        externalId: "reincluded@contoso.test",
        displayName: "Reincluded",
        status: "active",
        createdAt: TWO_DAYS_AGO,
        activeSince: NOW,
      })
      .returning(),
  ).id;

  // Protected two days ago (past the grace period), but its first backup is
  // already queued: it is being worked on, not neglected.
  const firstBackupRunning = one(
    await db
      .insert(protectedObjects)
      .values({
        tenantId,
        sourceId: source.id,
        kind: "mailbox",
        externalId: "running@contoso.test",
        displayName: "Running",
        status: "active",
        createdAt: TWO_DAYS_AGO,
        activeSince: TWO_DAYS_AGO,
      })
      .returning(),
  ).id;
  await db.insert(jobs).values({
    id: randomUUID(),
    tenantId,
    queue: "backup",
    status: "queued",
    protectedObjectId: firstBackupRunning,
    payload: { jobId: randomUUID(), tenantId, protectedObjectId: firstBackupRunning },
  });

  return { tenantId, legacy, reincluded, firstBackupRunning };
}

describe.skipIf(!testDatabaseAdminUrl)("first-backup grace period against Postgres", () => {
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

  it("falls back to created_at for a row written before active_since existed", async () => {
    const overview = await readinessOverview(db, f.tenantId, NOW);
    expect(byObject(overview.objects, f.legacy)).toMatchObject({
      state: "no_backup",
      overdue: true,
    });
  });

  it("is not overdue when protection restarted recently, whatever created_at says", async () => {
    const overview = await readinessOverview(db, f.tenantId, NOW);
    expect(byObject(overview.objects, f.reincluded)).toMatchObject({
      state: "no_backup",
      overdue: false,
    });
  });

  it("is not overdue while its first backup is already queued", async () => {
    const overview = await readinessOverview(db, f.tenantId, NOW);
    expect(byObject(overview.objects, f.firstBackupRunning)).toMatchObject({
      state: "no_backup",
      overdue: false,
    });
  });
});
