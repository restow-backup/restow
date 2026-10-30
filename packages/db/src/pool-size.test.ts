import { describe, expect, it } from "vitest";
import { createDb } from "./index.js";
import {
  DEFAULT_DB_POOL_MAX,
  dbPoolSizesFromEnv,
  MAX_DB_POOL_MAX,
  parseDbPoolMax,
  workerPoolWarning,
} from "./pool-size.js";

describe("dbPoolSizesFromEnv", () => {
  it("keeps node-postgres's 10 connections everywhere when nothing is set", () => {
    expect(dbPoolSizesFromEnv({})).toEqual({ app: 10, installation: 10, queue: 10 });
    expect(DEFAULT_DB_POOL_MAX).toBe(10);
  });

  it("treats empty values (the .env.example lines) as unset", () => {
    const env = { RESTOW_DB_POOL_MAX: "", RESTOW_DB_PROVIDER_POOL_MAX: "  " };
    expect(dbPoolSizesFromEnv(env)).toEqual({ app: 10, installation: 10, queue: 10 });
  });

  it("reads each pool from its own variable", () => {
    expect(
      dbPoolSizesFromEnv({
        RESTOW_DB_POOL_MAX: "40",
        RESTOW_DB_PROVIDER_POOL_MAX: "6",
        RESTOW_DB_BOSS_POOL_MAX: " 12 ",
      }),
    ).toEqual({ app: 40, installation: 6, queue: 12 });
  });
});

describe("parseDbPoolMax", () => {
  it.each(["0", "-3", "abc", "2.5", "1e2", "10 connections", String(MAX_DB_POOL_MAX + 1)])(
    "refuses %j with a message that names the variable",
    (value) => {
      expect(() => parseDbPoolMax({ RESTOW_DB_POOL_MAX: value }, "RESTOW_DB_POOL_MAX")).toThrow(
        /RESTOW_DB_POOL_MAX must be a whole number from 1 to 500/,
      );
    },
  );

  it("accepts the bounds", () => {
    expect(parseDbPoolMax({ X: "1" }, "X")).toBe(1);
    expect(parseDbPoolMax({ X: String(MAX_DB_POOL_MAX) }, "X")).toBe(MAX_DB_POOL_MAX);
  });

  it("stops the config of a process on a bad value", () => {
    expect(() => dbPoolSizesFromEnv({ RESTOW_DB_BOSS_POOL_MAX: "many" })).toThrow(
      /RESTOW_DB_BOSS_POOL_MAX/,
    );
  });
});

describe("workerPoolWarning", () => {
  it("is silent with the defaults (2 jobs, 10 connections)", () => {
    expect(workerPoolWarning({ concurrency: 2, poolMax: 10 })).toBeNull();
  });

  it("is silent when the pool holds the jobs plus headroom", () => {
    expect(workerPoolWarning({ concurrency: 24, poolMax: 26 })).toBeNull();
  });

  it("warns when the jobs outnumber the pool and names the size to set", () => {
    const warning = workerPoolWarning({ concurrency: 24, poolMax: 10 });
    expect(warning).toMatch(/RESTOW_DB_POOL_MAX=10/);
    expect(warning).toMatch(/WORKER_CONCURRENCY=24/);
    expect(warning).toMatch(/at least 26/);
  });
});

describe("createDb pool size", () => {
  it("defaults to the node-postgres pool and takes an explicit size", async () => {
    const url = "postgres://u@127.0.0.1:1/x";
    const plain = createDb(url);
    const sized = createDb(url, { max: 33 });
    try {
      expect(plain.$client.options.max).toBe(DEFAULT_DB_POOL_MAX);
      expect(sized.$client.options.max).toBe(33);
    } finally {
      await plain.$client.end();
      await sized.$client.end();
    }
  });
});
