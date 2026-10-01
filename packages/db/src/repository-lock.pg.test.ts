/**
 * The lock of an endpoint repository against a real Postgres: exclusive holders
 * keep everyone out, shared holders keep only exclusive ones out, a waiter
 * gets the lock once it is released, and an error in the work releases it.
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  EndpointRepositoryBusyError,
  acquireEndpointRepositoryLock,
  withEndpointRepositoryLock,
} from "./repository-lock.js";

const url = process.env.RESTOW_TEST_DATABASE_URL;

describe.skipIf(!url)("the lock of an endpoint repository", () => {
  let pool: pg.Pool;

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: url, max: 8 });
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("keeps everyone out while it is held exclusively", async () => {
    const endpoint = randomUUID();
    const release = await acquireEndpointRepositoryLock(pool, endpoint, { mode: "exclusive" });
    await expect(
      acquireEndpointRepositoryLock(pool, endpoint, { mode: "exclusive" }),
    ).rejects.toBeInstanceOf(EndpointRepositoryBusyError);
    await expect(
      acquireEndpointRepositoryLock(pool, endpoint, { mode: "shared" }),
    ).rejects.toBeInstanceOf(EndpointRepositoryBusyError);
    // Another endpoint's repository is not affected.
    const other = await acquireEndpointRepositoryLock(pool, randomUUID(), { mode: "exclusive" });
    await other();
    await release();
    const again = await acquireEndpointRepositoryLock(pool, endpoint, { mode: "exclusive" });
    await again();
  });

  it("lets shared holders work side by side, and keeps an exclusive one out", async () => {
    const endpoint = randomUUID();
    const first = await acquireEndpointRepositoryLock(pool, endpoint, { mode: "shared" });
    const second = await acquireEndpointRepositoryLock(pool, endpoint, { mode: "shared" });
    await expect(
      acquireEndpointRepositoryLock(pool, endpoint, { mode: "exclusive" }),
    ).rejects.toBeInstanceOf(EndpointRepositoryBusyError);
    await first();
    await second();
    const exclusive = await acquireEndpointRepositoryLock(pool, endpoint, { mode: "exclusive" });
    await exclusive();
  });

  it("makes a waiter wait for the holder instead of running beside it", async () => {
    const endpoint = randomUUID();
    const order: string[] = [];
    const holder = withEndpointRepositoryLock(pool, endpoint, { mode: "exclusive" }, async () => {
      order.push("first starts");
      await new Promise((resolve) => setTimeout(resolve, 300));
      order.push("first ends");
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const waiter = withEndpointRepositoryLock(
      pool,
      endpoint,
      { mode: "shared", waitMs: 5000, pollMs: 50 },
      async () => {
        order.push("second runs");
      },
    );
    await Promise.all([holder, waiter]);
    expect(order).toEqual(["first starts", "first ends", "second runs"]);
  });

  it("releases the lock when the work fails, and a second release does nothing", async () => {
    const endpoint = randomUUID();
    await expect(
      withEndpointRepositoryLock(pool, endpoint, { mode: "exclusive" }, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const release = await acquireEndpointRepositoryLock(pool, endpoint, { mode: "exclusive" });
    await release();
    await release();
    const again = await acquireEndpointRepositoryLock(pool, endpoint, { mode: "exclusive" });
    await again();
  });
});
