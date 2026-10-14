/**
 * grantContinuation against a real pg-boss schema (#47): an interrupted job
 * that is handed out again keeps its attempt count, and on its first attempt
 * gains one instead. Runs when RESTOW_TEST_DATABASE_URL is set.
 */
import { createDb } from "@restow/db";
import PgBoss from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { grantContinuation } from "./continuation.js";

const adminUrl = process.env.RESTOW_TEST_DATABASE_URL;
const TEST_DB = "restow_worker_continuation_test";

describe.skipIf(!adminUrl)("grantContinuation against pg-boss", () => {
  let boss: PgBoss;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    const admin = createDb(adminUrl as string);
    try {
      await admin.$client.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
      await admin.$client.query(`CREATE DATABASE ${TEST_DB}`);
    } finally {
      await admin.$client.end();
    }
    const url = new URL(adminUrl as string);
    url.pathname = `/${TEST_DB}`;
    boss = new PgBoss({ connectionString: url.toString() });
    await boss.start();
    await boss.createQueue("backup", { name: "backup", retryLimit: 5, retryDelay: 1 });
    db = createDb(url.toString());
  }, 60_000);

  afterAll(async () => {
    await boss?.stop({ graceful: false, wait: true });
    await db?.$client.end();
  });

  async function active() {
    const id = await boss.send("backup", { n: 1 });
    const [job] = await boss.fetch("backup", { includeMetadata: true });
    expect(job?.id).toBe(id);
    return job as PgBoss.JobWithMetadata;
  }

  it("raises the limit on the first attempt, takes a counted attempt back later", async () => {
    const first = await active();
    expect(await grantContinuation(db, "backup", first.id)).toEqual({
      retryCount: 0,
      retryLimit: 6,
    });

    // pg-boss fails it into a retry and hands it out again: one attempt counted of six.
    await boss.fail("backup", first.id, { message: "expired" });
    await db.$client.query("UPDATE pgboss.job SET start_after = now() WHERE id = $1", [first.id]);
    const [again] = await boss.fetch("backup", { includeMetadata: true });
    expect(again).toMatchObject({ id: first.id, retryCount: 1, retryLimit: 6 });
    await boss.complete("backup", first.id);

    const later = await active();
    await db.$client.query("UPDATE pgboss.job SET retry_count = 3 WHERE id = $1", [later.id]);
    expect(await grantContinuation(db, "backup", later.id)).toEqual({
      retryCount: 2,
      retryLimit: 5,
    });
  });

  it("leaves a job alone that is no longer active", async () => {
    const job = await active();
    await boss.complete("backup", job.id);
    expect(await grantContinuation(db, "backup", job.id)).toBeNull();
  });
});
