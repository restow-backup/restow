/**
 * The API side of the repository repair (docs/STORAGE.md, "Repository repair"): a scan is
 * queued (one scan or repair at a time per tenant), and a repair needs the typed word and the
 * newest completed scan. The worker does the work (apps/worker handlers/repository-repair.ts).
 * Runs when RESTOW_TEST_DATABASE_URL points at Postgres.
 */
import { createDb, type Database, providers, storageRepositoryRepairs, tenants } from "@restow/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ProblemError } from "../../problem.js";
import {
  dropDatabase,
  recreateDatabase,
  testDatabaseAdminUrl,
} from "../snapshots/testing/explorer-fixture.js";
import {
  REPAIR_CONFIRMATION,
  repositoryRepairs,
  requestRepositoryRepair,
  requestRepositoryScan,
} from "./repository-repair.js";

const DATABASE = "restow_api_storage_repair_test";

describe.skipIf(!testDatabaseAdminUrl)("queueing a repository scan and repair", () => {
  let db: Database;
  let tenantId: string;
  const actor = {
    id: "00000000-0000-4000-8000-000000000001",
    email: "admin@example.com",
    ip: null,
  };

  beforeAll(async () => {
    const url = await recreateDatabase(testDatabaseAdminUrl as string, DATABASE);
    db = createDb(url);
    const [provider] = await db.insert(providers).values({ name: "Provider" }).returning();
    const [tenant] = await db
      .insert(tenants)
      .values({ providerId: provider?.id as string, name: "Tenant", slug: "tenant" })
      .returning();
    tenantId = tenant?.id as string;
  }, 60_000);

  afterAll(async () => {
    await db.$client.end();
    await dropDatabase(testDatabaseAdminUrl as string, DATABASE);
  });

  async function refusal(work: Promise<unknown>): Promise<ProblemError> {
    const error = await work.then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ProblemError);
    return error as ProblemError;
  }

  it("queues one scan at a time, and a repair only of the newest completed scan", async () => {
    expect(await repositoryRepairs(db, tenantId)).toEqual({ scan: null, repair: null });
    const scan = await requestRepositoryScan(db, tenantId, actor);
    expect(scan).toMatchObject({ kind: "scan", status: "queued", requestedBy: actor.email });
    // A second one while the first is queued.
    const busy = await refusal(requestRepositoryScan(db, tenantId, actor));
    expect(busy.status).toBe(409);
    expect(busy.type).toBe("urn:restow:problem:storage-repair-in-progress");

    // Not yet completed: no repair.
    const early = await refusal(
      requestRepositoryRepair(
        db,
        tenantId,
        { scanId: scan.id, confirm: REPAIR_CONFIRMATION },
        actor,
      ),
    );
    expect(early.type).toBe("urn:restow:problem:storage-repair-needs-scan");

    await db
      .update(storageRepositoryRepairs)
      .set({ status: "completed", result: { repositories: [] } })
      .where(eq(storageRepositoryRepairs.id, scan.id));
    // The typed word must match.
    const typo = await refusal(
      requestRepositoryRepair(db, tenantId, { scanId: scan.id, confirm: "repair" }, actor),
    );
    expect(typo.status).toBe(422);
    const repair = await requestRepositoryRepair(
      db,
      tenantId,
      { scanId: scan.id, confirm: ` ${REPAIR_CONFIRMATION} ` },
      actor,
    );
    expect(repair).toMatchObject({ kind: "apply", status: "queued", scanId: scan.id });
    const state = await repositoryRepairs(db, tenantId);
    expect(state.scan?.id).toBe(scan.id);
    expect(state.repair?.id).toBe(repair.id);

    // A newer scan makes the older one stale for a repair.
    await db
      .update(storageRepositoryRepairs)
      .set({ status: "completed" })
      .where(eq(storageRepositoryRepairs.id, repair.id));
    const newer = await requestRepositoryScan(db, tenantId, actor);
    await db
      .update(storageRepositoryRepairs)
      .set({ status: "completed" })
      .where(eq(storageRepositoryRepairs.id, newer.id));
    const stale = await refusal(
      requestRepositoryRepair(
        db,
        tenantId,
        { scanId: scan.id, confirm: REPAIR_CONFIRMATION },
        actor,
      ),
    );
    expect(stale.type).toBe("urn:restow:problem:storage-repair-needs-scan");
  });
});
