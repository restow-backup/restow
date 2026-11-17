import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { dbProbeSpecSchema, parseDbInventory, parseDbProbeResult } from "./facts.js";
import { judgeDbHealth } from "./health.js";
import { dbFoundDatabases, dbInstanceIdentityOf, dbInstanceKey } from "./identity.js";
import { evaluateDbRights } from "./rights.js";

/** The fixtures the Go agent decodes strictly (agent/internal/api/contract_test.go). */
function fixture(name: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(
      new URL(`../../../../agent/internal/api/testdata/contract/${name}`, import.meta.url),
      "utf8",
    ),
  ) as Record<string, unknown>;
}

describe("the database contract shared with the agent (docs/DATABASES.md 9)", () => {
  it("reads the spec and the task of a connection test", () => {
    expect(dbProbeSpecSchema.parse(fixture("db-probe-spec.json"))).toMatchObject({
      host: "db01.corp.example",
      database: "erp",
      authMethod: "password",
      allowUnencrypted: false,
      pinnedFingerprintSha256: expect.stringMatching(/^3A:91:/),
    });
    const task = fixture("task-db-probe.json");
    expect(task).toMatchObject({ kind: "db_probe", params: { probeId: expect.any(String) } });
  });

  it("reads the PostgreSQL facts of an agent and judges them", () => {
    const result = parseDbProbeResult(fixture("db-probe-result-postgresql.json"));
    expect(result?.tls.fingerprintSha256).toMatch(/^3A:91/);
    if (!result) throw new Error("not read");
    const identity = dbInstanceIdentityOf(result);
    expect(identity && dbInstanceKey(identity)).toBe("postgresql:7300000000000000042");
    expect(
      dbFoundDatabases(result).map((database) => [database.name, database.accessible]),
    ).toEqual([
      ["erp", true],
      ["postgres", true],
      ["hr", false],
    ]);
    expect(evaluateDbRights(result)?.capabilities.backup).toMatchObject({
      state: "partial",
      missing: ["CONNECT hr"],
    });
  });

  it("reads MariaDB, a failed sign-in and an SQLite file", () => {
    const maria = parseDbProbeResult(fixture("db-probe-result-mariadb.json"));
    if (!maria) throw new Error("not read");
    expect(evaluateDbRights(maria)?.capabilities).toMatchObject({
      backup: { state: "granted" },
      pitr: { state: "missing", note: "binlog_off" },
    });
    expect(dbFoundDatabases(maria).map((database) => database.name)).toEqual(["shop"]);
    const failed = parseDbProbeResult(fixture("db-probe-result-failed.json"));
    expect(failed).toMatchObject({ login: "failed", error: { code: "db_login_failed" } });
    expect(failed && evaluateDbRights(failed)).toBeNull();
    const sqlite = parseDbProbeResult(fixture("db-probe-result-sqlite.json"));
    expect(sqlite && dbFoundDatabases(sqlite)).toEqual([
      { name: "data.db", identity: "1835021", sizeBytes: 2097152, accessible: true },
    ]);
  });

  it("reads the inventory of a heartbeat", () => {
    const heartbeat = fixture("heartbeat-db-inventory.json");
    expect(heartbeat.capabilities).toEqual(["db_runner_v1"]);
    expect(parseDbInventory(heartbeat.databaseInventory)?.instances.map((i) => i.name)).toEqual([
      "16/main",
      "shop-db",
    ]);
  });

  it("reads the health checks of a db_health task and what the agent posts (D2)", () => {
    expect(fixture("task-db-health.json")).toMatchObject({
      kind: "db_health",
      params: { windowSeconds: 360 },
    });
    const plan = fixture("db-health-plan.json") as {
      checks: { spec: unknown; intervalSeconds: number }[];
    };
    const specs = plan.checks.map((check) => dbProbeSpecSchema.parse(check.spec));
    expect(specs[0]).toMatchObject({ purpose: "health", sizes: true, timeoutSeconds: 10 });
    expect(specs[0]?.pinnedFingerprintSha256).toMatch(/^3A:91/);
    expect(specs[1]).toMatchObject({ engine: "sqlite", path: "/srv/app/data.db" });
    const samples = (fixture("db-health-samples.json") as { samples: { result: unknown }[] })
      .samples;
    const connection = {
      engine: "postgresql" as const,
      instanceKey: "postgresql:7300000000000000042",
      tlsFingerprint: specs[0]?.pinnedFingerprintSha256 ?? null,
    };
    const [good, pinned] = samples.map((sample) => {
      const result = parseDbProbeResult(sample.result);
      if (!result) throw new Error("not read");
      return judgeDbHealth(result, connection);
    });
    expect(good).toMatchObject({
      ok: true,
      latencyMs: 18,
      connectionsUsed: 12,
      sizes: [{ name: "erp", identity: "16384", sizeBytes: 734003200 }],
    });
    expect(pinned).toMatchObject({ ok: false, errorCode: "db_tls_changed" });
  });
});
