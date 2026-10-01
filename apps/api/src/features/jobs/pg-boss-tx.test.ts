import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { pgBossExecutor, toDrizzleSql } from "./pg-boss-tx.js";

const dialect = new PgDialect();

describe("toDrizzleSql", () => {
  it("rebinds numbered placeholders, including repeated ones", () => {
    const query = dialect.sqlToQuery(
      toDrizzleSql("INSERT INTO job (a, b, c) VALUES ($1, $2, $1) RETURNING $3", ["x", 2, true]),
    );
    expect(query.sql).toBe("INSERT INTO job (a, b, c) VALUES ($1, $2, $3) RETURNING $4");
    expect(query.params).toEqual(["x", 2, "x", true]);
  });

  it("binds arrays and objects as one value", () => {
    const query = dialect.sqlToQuery(
      toDrizzleSql("SELECT $1::text[], $2::jsonb", [["a", "b"], { jobId: "j" }]),
    );
    expect(query.sql).toBe("SELECT $1::text[], $2::jsonb");
    expect(query.params).toEqual([["a", "b"], { jobId: "j" }]);
  });

  it("leaves text without placeholders alone and refuses a missing value", () => {
    expect(dialect.sqlToQuery(toDrizzleSql("SELECT 1", [])).sql).toBe("SELECT 1");
    expect(() => toDrizzleSql("SELECT $2", ["only one"])).toThrow(RangeError);
  });
});

describe("pgBossExecutor", () => {
  it("routes pg-boss statements through the executor and returns its rows", async () => {
    const seen: string[] = [];
    const executor = pgBossExecutor({
      async execute(query) {
        seen.push(dialect.sqlToQuery(query).sql);
        return { rows: [{ id: "boss-1" }] };
      },
    });
    const result = await executor.executeSql("SELECT $1", ["q"]);
    expect(seen).toEqual(["SELECT $1"]);
    expect(result.rows).toEqual([{ id: "boss-1" }]);
  });
});
