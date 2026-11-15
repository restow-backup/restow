/**
 * The repository-copy lock a promotion of a copy target takes exclusively (docs/STORAGE.md,
 * "Promoting a copy"): the worker's jobs that delete in a tenant's restic repositories (a
 * machine's retention and removal, a file share's retention and purge) wait for it, and the
 * retention of containers leaves the tenant for its next pass. Runs when RESTOW_TEST_DATABASE_URL
 * points at Postgres (advisory locks only, no schema).
 */
import { randomUUID } from "node:crypto";
import {
  acquireEndpointRepositoryLock,
  createDb,
  type Database,
  EndpointRepositoryBusyError,
  repositoryCopiesLockKey,
} from "@restow/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { besidePromotion, unlessPromoting } from "./promotion-lock.js";

const url = process.env.RESTOW_TEST_DATABASE_URL;

describe.skipIf(!url)("work beside a promotion of a copy target", () => {
  let db: Database;

  beforeAll(() => {
    db = createDb(url as string);
  });

  afterAll(async () => {
    await db?.$client.end();
  });

  it("waits while a promotion holds the lock, and runs once it is released", async () => {
    const tenantId = randomUUID();
    const promotion = await acquireEndpointRepositoryLock(
      db.$client,
      repositoryCopiesLockKey(tenantId),
      { mode: "exclusive" },
    );
    let ran = false;
    const waiting = besidePromotion(db, tenantId, async () => {
      ran = true;
      return "done";
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(ran).toBe(false);
    await promotion();
    // It looks again every few seconds.
    expect(await waiting).toBe("done");
    expect(ran).toBe(true);
  }, 20_000);

  it("holds no connection of the pool while it waits", async () => {
    const tenantId = randomUUID();
    const small = createDb(url as string, { max: 2 });
    const promotion = await acquireEndpointRepositoryLock(
      db.$client,
      repositoryCopiesLockKey(tenantId),
      { mode: "exclusive" },
    );
    try {
      // Three jobs wait out the promotion on a pool of two; the pool still answers.
      const waiting = [1, 2, 3].map((n) =>
        besidePromotion(small, tenantId, async () => n, 10_000, 50),
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      const { rows } = await small.$client.query<{ one: number }>("SELECT 1 AS one");
      expect(rows[0]?.one).toBe(1);
      await promotion();
      expect(await Promise.all(waiting)).toEqual([1, 2, 3]);
    } finally {
      await promotion();
      await small.$client.end();
    }
  }, 20_000);

  it("gives up after its wait (pg-boss tries the job again), and a pass skips the tenant", async () => {
    const tenantId = randomUUID();
    const promotion = await acquireEndpointRepositoryLock(
      db.$client,
      repositoryCopiesLockKey(tenantId),
      { mode: "exclusive" },
    );
    try {
      await expect(besidePromotion(db, tenantId, async () => "never", 50)).rejects.toBeInstanceOf(
        EndpointRepositoryBusyError,
      );
      expect(await unlessPromoting(db, tenantId, async () => 1)).toBeNull();
      // Other tenants are not held.
      expect(await unlessPromoting(db, randomUUID(), async () => 1)).toBe(1);
    } finally {
      await promotion();
    }
    expect(await unlessPromoting(db, tenantId, async () => 2)).toBe(2);
  });
});
