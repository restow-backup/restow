import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type AgentRunSpec, agentRunFinishSchema } from "./runs.js";

/** The fixtures the Go agent decodes strictly (agent/internal/api/contract_test.go). */
function fixture(name: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(
      new URL(`../../../../../agent/internal/api/testdata/contract/${name}`, import.meta.url),
      "utf8",
    ),
  ) as Record<string, unknown>;
}

describe("the contract of a database run with the agent (docs/DATABASES.md 9) [DB-007]", () => {
  it("hands the agent the fields it reads and reads every field of its report", () => {
    const spec = fixture("db-run-spec.json") as unknown as AgentRunSpec;
    const keys: (keyof AgentRunSpec)[] = [
      "runId",
      "kind",
      "connection",
      "repository",
      "restore",
      "maxDurationSeconds",
    ];
    expect(Object.keys(spec).sort()).toEqual([...keys].sort());
    expect(Object.keys(spec.connection).sort()).toEqual(
      [
        "allowUnencrypted",
        "authMethod",
        "connectionId",
        "engine",
        "host",
        "instanceKey",
        "loginDatabase",
        "password",
        "pinnedFingerprintSha256",
        "port",
        "selection",
        "user",
      ].sort(),
    );
    // A restore reads its one dump from the server: no repository, no snapshot id.
    expect(spec.kind).toBe("restore");
    expect(spec.repository).toBeNull();
    expect(Object.keys(spec.restore ?? {}).sort()).toEqual([
      "engineOptions",
      "fileName",
      "sha256",
      "targetName",
    ]);
    const backup = fixture("db-run-spec-backup.json") as unknown as AgentRunSpec;
    expect(backup.restore).toBeNull();
    expect(Object.keys(backup.repository ?? {}).sort()).toEqual(
      ["password", "repositoryPassword", "url", "username"].sort(),
    );
    expect(fixture("task-db-backup.json")).toMatchObject({
      kind: "db_backup",
      params: { runId: spec.runId },
    });
    const finish = agentRunFinishSchema.parse(fixture("db-run-finish.json"));
    expect(finish).toMatchObject({ status: "partial", error: { code: "db_dump_failed" } });
    expect(finish.backups.map((backup) => backup.kind)).toEqual(["database", "globals"]);
    expect(finish.backups[0]?.objects).toEqual({ TABLE: 2, "TABLE DATA": 2, VIEW: 1 });
    expect(finish.instance?.databases).toHaveLength(2);
  });
});
