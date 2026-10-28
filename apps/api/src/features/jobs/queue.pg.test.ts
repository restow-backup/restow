/**
 * Enqueueing on a stately queue against Postgres and the (patched) pg-boss: a
 * queued twin is refused, one queued beside a running job of the same key is
 * taken and waits for it, and it never holds back another key's job
 * (patches/pg-boss@10.4.2.patch: before, it blocked the queue's head).
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server (the database
 * `restow_api_job_queue_test` is recreated there and dropped after).
 */
import { randomUUID } from "node:crypto";
import type { BackupJobPayload } from "@restow/core";
import { createDb, type Database, jobs, providers, tenants } from "@restow/db";
import PgBoss from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  dropDatabase,
  recreateDatabase,
  testDatabaseAdminUrl,
} from "../snapshots/testing/explorer-fixture.js";
import { sendJob } from "./queue.js";

const DATABASE = "restow_api_job_queue_test";

describe.skipIf(!testDatabaseAdminUrl)("sendJob against the real pg-boss", () => {
  let db: Database;
  let boss: PgBoss;
  let tenantId: string;

  beforeAll(async () => {
    const url = await recreateDatabase(testDatabaseAdminUrl as string, DATABASE);
    db = createDb(url);
    boss = new PgBoss({ connectionString: url, schedule: false, supervise: false });
    await boss.start();
    await boss.createQueue("backup", { name: "backup", policy: "stately" });
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
  }, 60_000);

  afterAll(async () => {
    await boss?.stop({ graceful: false, wait: true });
    await db?.$client.end();
    await dropDatabase(testDatabaseAdminUrl as string, DATABASE);
  });

  const payload = (protectedObjectId: string): BackupJobPayload => ({
    jobId: randomUUID(),
    tenantId,
    protectedObjectId,
  });

  /** Enqueue the way the API does: the pg-boss job and its `jobs` row in one transaction. */
  const enqueue = (job: BackupJobPayload) =>
    db.transaction(async (tx) => {
      const id = await sendJob(tx, "backup", job, db);
      if (id !== null) {
        await tx.insert(jobs).values({
          id: job.jobId,
          tenantId,
          queue: "backup",
          status: "queued",
          // The key is read from the payload; no protected_objects row is needed for it.
          payload: { ...job },
          pgBossJobId: id,
        });
      }
      return id;
    });

  it("queues one follow-up beside a running backup, and it holds back no other object", async () => {
    const objectA = randomUUID();
    const first = payload(objectA);
    const firstId = await enqueue(first);
    expect(firstId).not.toBeNull();
    // A queued twin: pg-boss itself refuses it.
    expect(await enqueue(payload(objectA))).toBeNull();

    // The worker starts it: pg-boss and the jobs row say active.
    const [fetched] = await boss.fetch("backup");
    expect(fetched?.id).toBe(firstId);
    await db.$client.query("UPDATE jobs SET status = 'active' WHERE id = $1", [first.jobId]);
    // "Back up now" while it runs: one follow-up is queued and waits.
    const followUp = await enqueue(payload(objectA));
    expect(followUp).not.toBeNull();
    // Another object's backup, queued after it, is still handed out first.
    const otherId = await enqueue(payload(randomUUID()));
    expect(otherId).not.toBeNull();
    const [next] = await boss.fetch("backup");
    expect(next?.id).toBe(otherId);
  });
});
