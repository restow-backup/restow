/**
 * The queue policies against the real pg-boss: a `stately` queue holds one active and one
 * queued job per singleton key, and the queued one of a key that is still running must not
 * keep other keys' jobs from starting. Unpatched pg-boss 10 fetched the oldest job without
 * looking at its key, hit job_i3's unique violation activating it, swallowed the error and
 * returned nothing: one object's long first backup with its next run queued behind it held
 * the whole backup queue for every tenant (patches/pg-boss@10.4.2.patch).
 * Runs when RESTOW_TEST_DATABASE_URL is set.
 */
import { createDb } from "@restow/db";
import { runMigrations } from "@restow/db/migrate";
import PgBoss from "pg-boss";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pgBossQueueOptions, sendOptionsFor } from "./queues.js";
import { dropTestDatabase, ignoreTerminatedConnection } from "./testing/database.js";

const adminUrl = process.env.RESTOW_TEST_DATABASE_URL;
const TEST_DB = "restow_worker_queues_test";

describe.skipIf(!adminUrl)("stately queues against the real pg-boss", () => {
  let boss: PgBoss;
  let db: ReturnType<typeof createDb>;
  let tenantId: string;

  const q = async <R extends Record<string, unknown>>(text: string, values: unknown[] = []) =>
    (await db.$client.query<R>(text, values)).rows;

  beforeAll(async () => {
    const admin = createDb(adminUrl as string);
    await admin.$client.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await admin.$client.query(`CREATE DATABASE ${TEST_DB}`);
    await admin.$client.end();
    const url = new URL(adminUrl as string);
    url.pathname = `/${TEST_DB}`;
    await runMigrations(url.toString());
    db = createDb(url.toString());
    db.$client.on("error", ignoreTerminatedConnection);
    boss = new PgBoss({ connectionString: url.toString(), schedule: false, supervise: false });
    boss.on("error", ignoreTerminatedConnection);
    await boss.start();
    await boss.createQueue("backup", pgBossQueueOptions("backup"));
    await boss.createQueue("solo", { name: "solo", policy: "singleton" });
    const [provider] = await q<{ id: string }>(
      "INSERT INTO providers (name) VALUES ('p') RETURNING id",
    );
    const [tenant] = await q<{ id: string }>(
      "INSERT INTO tenants (provider_id, name, slug) VALUES ($1, 'Contoso', 'contoso') RETURNING id",
      [provider?.id],
    );
    tenantId = tenant?.id ?? "";
  }, 60_000);

  afterAll(async () => {
    await boss?.stop({ graceful: false, wait: true });
    await db?.$client.end();
    await dropTestDatabase(adminUrl as string, TEST_DB);
  });

  beforeEach(async () => {
    await q("DELETE FROM jobs");
    await q("DELETE FROM pgboss.job");
  });

  const backup = (protectedObjectId: string, n: number) => {
    const payload = { jobId: crypto.randomUUID(), tenantId, protectedObjectId, n };
    return boss.send("backup", payload, sendOptionsFor("backup", payload));
  };

  it("starts another object's backup while one object runs with its next run queued behind it", async () => {
    const objectA = crypto.randomUUID();
    const objectB = crypto.randomUUID();
    const running = await backup(objectA, 1);
    const [first] = await boss.fetch("backup");
    expect(first?.id).toBe(running);
    // The scheduler's next tick (or "Run now") queues A again: stately allows one queued.
    const queuedA = await backup(objectA, 2);
    expect(queuedA).not.toBeNull();
    const otherB = await backup(objectB, 3);

    const [next] = await boss.fetch("backup");
    expect(next?.id).toBe(otherB);
    // A's queued run waits for A's active one, and starts once it is done.
    expect(await boss.fetch("backup")).toEqual([]);
    await boss.complete("backup", running as string);
    const [afterwards] = await boss.fetch("backup");
    expect(afterwards?.id).toBe(queuedA);
  });

  it("skips a busy key in a batch fetch and hands out the rest", async () => {
    const objectA = crypto.randomUUID();
    await backup(objectA, 1);
    await boss.fetch("backup");
    await backup(objectA, 2);
    const others = [await backup(crypto.randomUUID(), 3), await backup(crypto.randomUUID(), 4)];
    const batch = await boss.fetch("backup", { batchSize: 5 });
    expect(batch.map((job) => job.id).sort()).toEqual([...others].sort());
  });

  it("does the same for a singleton queue", async () => {
    const running = await boss.send("solo", { n: 1 }, { singletonKey: "a" });
    await boss.fetch("solo");
    await boss.send("solo", { n: 2 }, { singletonKey: "a" });
    const other = await boss.send("solo", { n: 3 }, { singletonKey: "b" });
    const [next] = await boss.fetch("solo");
    expect(next?.id).toBe(other);
    expect(running).not.toBeNull();
  });
});
