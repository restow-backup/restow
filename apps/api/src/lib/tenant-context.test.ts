import type { Database } from "@restow/db";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  type DbExecutor,
  isTransaction,
  isUuid,
  pinTenantStatement,
  withTenantTx,
} from "./tenant-context.js";

const TENANT = "0f1e2d3c-4b5a-4978-8899-aabbccddeeff";
const dialect = new PgDialect();

function render(statement: SQL): { sql: string; params: unknown[] } {
  const query = dialect.sqlToQuery(statement);
  return { sql: query.sql, params: query.params };
}

describe("isUuid", () => {
  it("accepts canonical UUIDs only", () => {
    expect(isUuid(TENANT)).toBe(true);
    expect(isUuid(TENANT.toUpperCase())).toBe(true);
    expect(isUuid("not-a-uuid")).toBe(false);
    expect(isUuid("")).toBe(false);
    expect(isUuid(`${TENANT}'; drop table tenants; --`)).toBe(false);
  });
});

describe("pinTenantStatement", () => {
  it("uses set_config with a bound parameter, transaction-local", () => {
    const { sql, params } = render(pinTenantStatement(TENANT));
    expect(sql).toBe("select set_config('app.tenant_id', $1, true)");
    expect(params).toEqual([TENANT]);
  });

  it("rejects anything that is not a UUID before it reaches SQL", () => {
    expect(() => pinTenantStatement("1 or 1=1")).toThrow(TypeError);
    expect(() => pinTenantStatement("")).toThrow(TypeError);
  });
});

/** A minimal fake of the Drizzle database: records executed statements in order. */
function fakeDb(log: string[]) {
  const tx = {
    rollback() {},
    async execute(statement: SQL) {
      log.push(render(statement).sql);
    },
  };
  const db = {
    async transaction<T>(fn: (t: typeof tx) => Promise<T>): Promise<T> {
      log.push("BEGIN");
      const result = await fn(tx);
      log.push("COMMIT");
      return result;
    },
  };
  return { db: db as unknown as Database, tx: tx as unknown as DbExecutor };
}

describe("withTenantTx", () => {
  it("pins the tenant inside the transaction before running the callback", async () => {
    const log: string[] = [];
    const { db } = fakeDb(log);
    const result = await withTenantTx(db, TENANT, async () => {
      log.push("work");
      return 42;
    });
    expect(result).toBe(42);
    expect(log).toEqual([
      "BEGIN",
      "select set_config('app.tenant_id', $1, true)",
      "work",
      "COMMIT",
    ]);
  });

  it("refuses to open a transaction for an invalid tenant id", async () => {
    const log: string[] = [];
    const { db } = fakeDb(log);
    await expect(withTenantTx(db, "nope", async () => 1)).rejects.toThrow(TypeError);
    expect(log).toEqual([]);
  });
});

describe("isTransaction", () => {
  it("tells a transaction (has rollback) from the pool-backed database", () => {
    const { db, tx } = fakeDb([]);
    expect(isTransaction(tx)).toBe(true);
    expect(isTransaction(db)).toBe(false);
  });
});
