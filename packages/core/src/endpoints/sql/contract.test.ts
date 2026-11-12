import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { judgeSqlVerifyDatabase } from "./judge.js";
import {
  hasSqlCapability,
  parseCapabilities,
  parseRunNotices,
  parseSqlBackupReport,
  parseSqlInventory,
  parseSqlRestoreReport,
  parseSqlVerifyReport,
  parseWindowsFacts,
  windowsVersionText,
} from "./schemas.js";
import { type SqlVerifyCandidate, sqlVerifyTaskParams } from "./verify-plan.js";

/** The fixtures the Go agent decodes strictly (agent/internal/api/contract_test.go). */
function fixture(name: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(
      new URL(`../../../../../agent/internal/api/testdata/contract/${name}`, import.meta.url),
      "utf8",
    ),
  ) as Record<string, unknown>;
}

describe("the SQL contract shared with the agent", () => {
  it("reads the Windows facts and the SQL inventory of a heartbeat", () => {
    const heartbeat = fixture("heartbeat-windows-sql.json");
    expect(hasSqlCapability(parseCapabilities(heartbeat.capabilities))).toBe(true);
    const machine = heartbeat.machine as Record<string, unknown>;
    const windows = parseWindowsFacts(machine.windows);
    expect(windows).toMatchObject({
      productName: "Windows Server 2022 Standard",
      productType: "server",
      build: 20348,
      ubr: 2340,
      domainMember: true,
      domain: "corp.example",
      roles: { sqlServer: true, domainController: false },
      bitlocker: {
        state: "ok",
        volumes: [{ mount: "C:", protection: "on", conversion: "fully_encrypted" }],
      },
    });
    expect(windows?.sqlInstances.map((instance) => instance.name)).toEqual([
      "SQLEXPRESS",
      "RESTOWB",
    ]);
    expect(windows?.sqlInstances[0]?.serviceAccount).toBe("NT Service\\MSSQL$SQLEXPRESS");
    expect(windows && windowsVersionText(windows)).toBe(
      "Windows Server 2022 Standard 21H2 (build 20348.2340)",
    );

    const inventory = parseSqlInventory(heartbeat.sqlInventory);
    expect(inventory?.collectedAt).toBe("2026-11-05T02:00:03.000Z");
    expect(inventory?.truncated).toBe(false);
    const [ok, failed] = inventory?.instances ?? [];
    expect(ok?.state).toBe("ok");
    expect(ok?.login).toEqual({
      name: "NT SERVICE\\RestowAgent",
      sysadmin: true,
      canCreateDatabase: true,
    });
    expect(ok?.databases.map((database) => database.name)).toEqual(["master", "Sales"]);
    expect(ok?.databases[1]).toMatchObject({
      familyGuid: "6f1e8a52-3c1d-4a8e-9b0e-2b7d9f1c0a11",
      recoveryModel: "FULL",
      usedBytes: 734003200,
      lastFullBackupAt: "2026-11-04T22:10:00.000Z",
    });
    expect(failed).toMatchObject({
      name: "RESTOWB",
      state: "error",
      error: { code: "sql_login_missing", step: "connect", number: 18456 },
      databases: [],
    });
  });

  it("reads the end of a sql run with LSNs as strings", () => {
    const finish = fixture("finish-sql.json");
    const report = parseSqlBackupReport(finish.sql);
    expect(report?.instance).toBe("SQLEXPRESS");
    const [sales, archive] = report?.databases ?? [];
    expect(sales?.outcome).toBe("backed_up");
    expect(sales?.backup).toMatchObject({
      kind: "full",
      copyOnly: true,
      compressed: false,
      checksum: true,
      firstLsn: "37000000012800001",
      lastLsn: "37000000014400001",
      databaseBackupLsn: "36000000011200037",
      bytes: 734265344,
    });
    expect(sales?.backup?.fileList).toHaveLength(2);
    expect(archive).toMatchObject({ outcome: "skipped", code: "sql_staging_too_small" });
    expect(parseRunNotices(finish.notices)).toEqual([
      expect.objectContaining({ code: "sql_log_growing", subjects: ["Sales"] }),
    ]);
  });

  it("refuses to keep a backup the server cannot place", () => {
    const finish = fixture("finish-sql.json");
    const sql = structuredClone(finish.sql) as { databases: Record<string, unknown>[] };
    const first = sql.databases[0] as { backup: Record<string, unknown> };
    // As a JSON number it would lose digits: the server takes it as no LSN at all.
    first.backup.firstLsn = Number("37000000012800001");
    const report = parseSqlBackupReport(sql);
    expect(report?.databases[0]).toMatchObject({ outcome: "failed", code: "sql_backup_mismatch" });
  });

  it("reads the backup notices of a file run", () => {
    expect(parseRunNotices(fixture("finish-backup-notices.json").notices)).toEqual([
      {
        code: "app_files_not_app_backup",
        subjects: ["sql_server", "active_directory"],
        message:
          "Files of open databases are not a restorable SQL Server or Active Directory backup.",
      },
    ]);
    expect(parseRunNotices([{ code: "something_else" }])).toBeUndefined();
  });

  it("reads the end of a restore under a new name", () => {
    const report = parseSqlRestoreReport(fixture("finish-sql-restore.json").sqlRestore);
    expect(report).toMatchObject({
      instance: "SQLEXPRESS",
      newName: "Sales_restored_20261105",
      fetched: true,
      sha256Match: true,
      restored: true,
      checkdb: { ran: true, errors: [] },
    });
    expect(report?.moves).toHaveLength(2);
  });

  it("judges the three verification fixtures", () => {
    const green = parseSqlVerifyReport(fixture("finish-sql-verify-green.json").sqlVerify);
    expect(green?.databases.map(judgeSqlVerifyDatabase)).toEqual([
      { outcome: "green", evidence: [] },
    ]);

    const red = parseSqlVerifyReport(fixture("finish-sql-verify-red.json").sqlVerify);
    const [checkdb, restore] = red?.databases.map(judgeSqlVerifyDatabase) ?? [];
    expect(checkdb?.outcome).toBe("red");
    expect(checkdb?.evidence).toEqual([
      expect.objectContaining({ source: "checkdb", number: 8928 }),
    ]);
    expect(restore?.outcome).toBe("red");
    expect(restore?.evidence).toEqual([
      expect.objectContaining({ source: "restore", number: 3183 }),
    ]);

    const incomplete = parseSqlVerifyReport(fixture("finish-sql-verify-incomplete.json").sqlVerify);
    expect(incomplete?.databases[0]?.restore).toBeNull();
    expect(incomplete?.databases.map(judgeSqlVerifyDatabase)).toEqual([
      { outcome: "incomplete", code: "sql_verify_no_space", evidence: [] },
    ]);
  });

  it("builds the sql_verify task the agent decodes (task-sql-verify.json)", () => {
    // The agent reads task params with a plain json.Unmarshal: a key the server names otherwise
    // would arrive as a zero value (maxGiB 0 turns PHYSICAL_ONLY off). The server's builder must
    // give exactly the fixture's params from the same backup.
    const task = fixture("task-sql-verify.json") as { params: Record<string, unknown> };
    const params = task.params as {
      instance: string;
      maxGiB: number;
      physicalOnly: boolean;
      databases: {
        databaseId: string;
        backupId: string;
        name: string;
        snapshotId: string;
        pathInSnapshot: string;
        sha256: string;
        bytes: number;
        usedBytes: number;
        fileList: SqlVerifyCandidate["backup"]["fileList"];
      }[];
    };
    const candidates: SqlVerifyCandidate[] = params.databases.map((db) => ({
      databaseId: db.databaseId,
      name: db.name,
      usedBytes: db.usedBytes,
      backup: {
        id: db.backupId,
        snapshotId: db.snapshotId,
        pathInSnapshot: db.pathInSnapshot,
        sha256: db.sha256,
        bytes: db.bytes,
        fileList: db.fileList,
      },
    }));
    expect(
      sqlVerifyTaskParams(
        params.instance,
        { maxGiB: params.maxGiB, physicalOnly: params.physicalOnly },
        candidates,
      ),
    ).toEqual(task.params);
  });

  it("drops what does not fit instead of refusing it", () => {
    expect(parseWindowsFacts("windows")).toBeUndefined();
    expect(parseSqlInventory({ instances: [] })).toBeUndefined();
    expect(parseSqlBackupReport({ databases: [] })).toBeUndefined();
    const facts = parseWindowsFacts({
      productType: "toaster",
      build: -1,
      roles: { sqlServer: "yes" },
    });
    expect(facts).toMatchObject({ productType: "unknown", build: 0, roles: { sqlServer: false } });
    expect(parseCapabilities(["sql_native_v1", "Bad Code", 3, "sql_native_v1"])).toEqual([
      "sql_native_v1",
    ]);
  });
});
