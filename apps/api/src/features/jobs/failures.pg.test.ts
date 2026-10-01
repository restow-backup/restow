/**
 * Postgres-backed tests of how failed jobs reach the API: the job's classified
 * cause with its steps and docs page, the causes behind the failed items of a
 * finished job (in a list and grouped on the detail), and rows written before
 * failure records existed, which must keep working with only their text.
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server (the database
 * `restow_api_job_failures_test` is recreated there and dropped after).
 */
import { randomUUID } from "node:crypto";
import {
  type Database,
  type FailureRecordJson,
  createDb,
  itemFailures,
  jobProgress,
  jobs,
  protectedObjects,
  providers,
  sources,
  tenants,
} from "@restow/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  dropDatabase,
  recreateDatabase,
  testDatabaseAdminUrl,
} from "../snapshots/testing/explorer-fixture.js";
import { getJob, listJobs, listLiveJobs } from "./service.js";

const DATABASE = "restow_api_job_failures_test";

function record(code: string, overrides: Partial<FailureRecordJson> = {}): FailureRecordJson {
  return {
    v: 1,
    code,
    transient: false,
    params: {},
    technical: { httpStatus: 403 },
    occurredAt: "2026-09-29T10:00:00.000Z",
    step: "enumerate",
    retry: null,
    ...overrides,
  };
}

describe.skipIf(!testDatabaseAdminUrl)("failed jobs against Postgres", () => {
  let db: Database;
  let tenantId: string;
  let objectId: string;

  beforeAll(async () => {
    db = createDb(await recreateDatabase(testDatabaseAdminUrl as string, DATABASE));
    const [provider] = await db.insert(providers).values({ name: "P" }).returning();
    const [tenant] = await db
      .insert(tenants)
      .values({
        providerId: provider?.id as string,
        name: "Tenant",
        slug: `t-${randomUUID().slice(0, 8)}`,
      })
      .returning();
    tenantId = tenant?.id as string;
    const [source] = await db
      .insert(sources)
      .values({ tenantId, kind: "m365", name: "M365", status: "active" })
      .returning();
    const [object] = await db
      .insert(protectedObjects)
      .values({
        tenantId,
        sourceId: source?.id as string,
        kind: "mailbox",
        externalId: "alice@example.test",
        displayName: "Alice",
      })
      .returning();
    objectId = object?.id as string;
  }, 60_000);

  afterAll(async () => {
    await db?.$client.end();
    await dropDatabase(testDatabaseAdminUrl as string, DATABASE);
  });

  async function job(
    status: "failed" | "completed" | "queued",
    extra: Partial<typeof jobs.$inferInsert> = {},
  ) {
    const [row] = await db
      .insert(jobs)
      .values({
        tenantId,
        queue: "backup",
        status,
        protectedObjectId: objectId,
        startedAt: new Date("2026-09-29T09:59:00.000Z"),
        completedAt: status === "queued" ? null : new Date("2026-09-29T10:00:00.000Z"),
        ...extra,
      })
      .returning();
    return row?.id as string;
  }

  async function failItem(jobId: string, itemRef: string, failure: FailureRecordJson | null) {
    await db.insert(itemFailures).values({
      tenantId,
      jobId,
      protectedObjectId: objectId,
      itemRef,
      reason: `reason of ${itemRef}`,
      failure,
    });
  }

  it("explains a failed job: cause, steps, retryability and docs page", async () => {
    const id = await job("failed", {
      errorMessage: "GraphError: Graph GET failed with 403",
      failure: record("graph.access_denied", {
        params: { permission: "Mail.ReadWrite", httpStatus: 403 },
      }),
    });
    const dto = await getJob(db, tenantId, id);
    expect(dto.errorMessage).toBe("GraphError: Graph GET failed with 403");
    expect(dto.failure).toMatchObject({
      code: "graph.access_denied",
      category: "microsoft",
      transient: false,
      retryable: true,
      step: "enumerate",
      params: { permission: "Mail.ReadWrite" },
      technical: { httpStatus: 403 },
    });
    expect(dto.failure?.steps.map((step) => step.id)).toEqual([
      "verify_permissions",
      "check_access_policy",
      "exclude_object",
    ]);
    expect(dto.failure?.docsUrl).toMatch(/^https?:\/\/.+\/$/);
    expect(dto.retryable).toBe(true);
  });

  it("shows the retry state of a run that failed but will be tried again", async () => {
    const id = await job("queued", {
      completedAt: null,
      errorMessage: "GraphError: 503",
      failure: record("graph.service_unavailable", {
        transient: true,
        retry: { attempt: 2, limit: 6, nextAttemptAt: "2026-09-29T10:03:00.000Z" },
      }),
    });
    const dto = await getJob(db, tenantId, id);
    expect(dto.status).toBe("queued");
    expect(dto.failure).toMatchObject({
      transient: true,
      retry: { attempt: 2, limit: 6, nextAttemptAt: "2026-09-29T10:03:00.000Z" },
    });
  });

  it("keeps old rows working: no record means no failure, the text stays", async () => {
    const id = await job("failed", { errorMessage: "Error: something from an older version" });
    await failItem(id, "mail/Inbox/old.eml", null);
    const dto = await getJob(db, tenantId, id);
    expect(dto.failure).toBeNull();
    expect(dto.errorMessage).toBe("Error: something from an older version");
    expect(dto.failures).toMatchObject([{ itemRef: "mail/Inbox/old.eml", failure: null }]);
    expect(dto.failureGroups).toEqual([]);
  });

  it("ignores a stored record it cannot read", async () => {
    const id = await job("failed", {
      errorMessage: "boom",
      failure: { nonsense: true } as unknown as FailureRecordJson,
    });
    expect((await getJob(db, tenantId, id)).failure).toBeNull();
  });

  it("groups the failed items of a job by cause, most frequent first, with the latest example", async () => {
    const id = await job("completed");
    await db.insert(jobProgress).values({ tenantId, jobId: id, total: 10, done: 5, failed: 6 });
    for (const ref of ["a", "b", "c"]) {
      await failItem(
        id,
        `mail/Inbox/${ref}.eml`,
        record("graph.item_too_large", {
          params: { httpStatus: 413 },
          technical: { httpStatus: 413 },
        }),
      );
    }
    await failItem(id, "mail/Inbox/d.eml", record("graph.item_unreadable"));
    await failItem(id, "mail/Inbox/e.eml", record("graph.item_unreadable"));
    await failItem(id, "mail/Inbox/legacy.eml", null);

    const detail = await getJob(db, tenantId, id);
    expect(detail.failureCount).toBe(6);
    expect(detail.failureGroups.map((group) => [group.failure.code, group.count])).toEqual([
      ["graph.item_too_large", 3],
      ["graph.item_unreadable", 2],
    ]);
    expect(detail.failureGroups[0]?.failure.steps.map((step) => step.id)).toEqual([
      "item_stays_failed",
    ]);
    expect(detail.itemCauses).toEqual([
      { code: "graph.item_too_large", count: 3 },
      { code: "graph.item_unreadable", count: 2 },
    ]);
    const byRef = new Map(detail.failures.map((failure) => [failure.itemRef, failure]));
    expect(byRef.get("mail/Inbox/a.eml")?.failure?.code).toBe("graph.item_too_large");
    expect(byRef.get("mail/Inbox/legacy.eml")?.failure).toBeNull();
  });

  it("shows the item causes in lists of finished jobs only", async () => {
    const finished = await job("completed");
    await db
      .insert(jobProgress)
      .values({ tenantId, jobId: finished, total: 4, done: 2, failed: 2 });
    await failItem(finished, "x", record("graph.item_too_large"));
    await failItem(finished, "y", record("graph.item_too_large"));
    const running = await job("queued", { completedAt: null });
    await db.update(jobs).set({ status: "active" }).where(eq(jobs.id, running));
    await db.insert(jobProgress).values({ tenantId, jobId: running, total: 4, done: 1, failed: 1 });
    await failItem(running, "z", record("graph.item_too_large"));

    const page = await listJobs(db, tenantId, { limit: 50 } as never);
    const byId = new Map(page.items.map((item) => [item.id, item]));
    expect(byId.get(finished)?.itemCauses).toEqual([{ code: "graph.item_too_large", count: 2 }]);
    // Its counts still move; the list does not claim a cause for a running job.
    expect(byId.get(running)?.itemCauses).toEqual([]);

    const live = await listLiveJobs(db, tenantId, new Date(0));
    expect(live.find((item) => item.id === finished)?.itemCauses).toEqual([
      { code: "graph.item_too_large", count: 2 },
    ]);
  });
});
