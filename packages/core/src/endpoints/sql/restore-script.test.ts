import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  type RestoreScriptInput,
  renderSqlRestoreScript,
  restoreScriptData,
} from "./restore-script.js";

const GOLDEN = new URL("./testdata/restore-script.golden.ps1", import.meta.url);

const input: RestoreScriptInput = {
  endpointId: "3d2c1b0a-9f8e-4d7c-8b6a-5f4e3d2c1b0a",
  hostname: "sql01",
  instance: "SQLEXPRESS",
  database: "Sales",
  backup: {
    snapshotId: "18eb0f31e91b9c0452a42c9fcf31d37b771774327c9370af2b19bd2d64b4ea1e",
    pathInSnapshot:
      "/C/ProgramData/Restow/data/staging/sql/SQLEXPRESS/Sales~8de4e0ea/full-20261105T020011Z.bak",
    sha256: "D1EAF3A515CEC69D9D87A01BAF2DCB0F23ED1D11EBA77AA652C69BD95A78E607",
    bytes: 734265344,
    firstLsn: "37000000012800001",
    lastLsn: "37000000014400001",
    backupFinish: "2026-11-05T02:01:40.000Z",
    fileList: [
      {
        logicalName: "Sales",
        type: "D",
        fileGroup: "PRIMARY",
        fileId: 1,
        sizeBytes: 1073741824,
        physicalName: "Q:\\Data\\Sales.mdf",
      },
      {
        logicalName: "Sales_log",
        type: "L",
        fileGroup: "",
        fileId: 2,
        sizeBytes: 268435456,
        physicalName: "L:\\Log\\Sales_log.ldf",
      },
    ],
  },
  repositoryHint: "S3 storage target, folder endpoints/3d2c1b0a-9f8e-4d7c-8b6a-5f4e3d2c1b0a",
};

describe("renderSqlRestoreScript", () => {
  it("matches the golden script", () => {
    const script = renderSqlRestoreScript(input);
    if (process.env.UPDATE_GOLDEN === "1") {
      writeFileSync(GOLDEN, script);
    }
    expect(script).toBe(readFileSync(GOLDEN, "utf8"));
    expect(script.startsWith("\uFEFF#Requires -Version 5.1")).toBe(true);
  });

  it("keeps the data one line of JSON without control characters", () => {
    const hostile = {
      ...input,
      database: "Sa\nles'@\r\n'@; Remove-Item C:\\ -Recurse\u2028",
    };
    const data = restoreScriptData(hostile);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what must be gone
    expect(data).not.toMatch(/[\u0000-\u001f\u2028\u2029]/);
    const script = renderSqlRestoreScript(hostile);
    // The here-string ends only at a line that starts with '@: the data is a single line that
    // starts with {.
    const lines = script.split("\n");
    const start = lines.indexOf("$Data = @'");
    expect(lines[start + 1]?.startsWith("{")).toBe(true);
    expect(lines[start + 2]).toBe("'@ | ConvertFrom-Json");
    expect(JSON.parse(lines[start + 1] ?? "").database).toBe(
      "Sales'@'@; Remove-Item C:\\ -Recurse",
    );
    expect(JSON.parse(lines[start + 1] ?? "").backup.sha256).toBe(
      input.backup.sha256.toLowerCase(),
    );
  });

  it("builds no T-SQL from names in the client", () => {
    const script = renderSqlRestoreScript(input);
    const assignments = script.split("\n").filter((line) => line.includes("CommandText ="));
    expect(assignments).toEqual([
      "  $command.CommandText = $Statements[$Name]",
      "  $command.CommandText = $command.CommandText.Replace('{{MOVES}}', (New-RestowMoveClause $files.Count))",
    ]);
    expect(script).not.toMatch(/Invoke-Expression|\biex\b/i);
    expect(script).toContain("QUOTENAME(@db)");
  });

  it("works in a new folder of its own and deletes only that folder", () => {
    const script = renderSqlRestoreScript(input);
    // -StagingDir is the parent: the script makes a new restow-sql-restore-<guid> folder below it
    // (below TEMP without it) and never deletes, empties or reuses the folder the user named.
    expect(script).toContain("if (-not $StagingDir) { $StagingDir = $env:TEMP }");
    expect(script).toContain("$staging = New-RestowStagingFolder $StagingDir $SqlServiceAccount");
    expect(script).toContain(
      "$folder = Join-Path $Parent ('restow-sql-restore-' + [guid]::NewGuid().ToString('N'))",
    );
    expect(script).toContain(
      "if (Test-Path -LiteralPath $folder) { throw ('The folder ' + $folder + ' exists already.') }",
    );
    const removals = script.split("\n").filter((line) => line.includes("Remove-Item"));
    expect(removals).toEqual([
      "    Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue",
    ]);
    expect(script).not.toMatch(/New-Item[^\n]*StagingDir/);
    expect(script).not.toMatch(/--target \$StagingDir/);
    expect(script).toContain("--target $staging");
    // The removal sits in the finally of the try that starts right after the folder exists, so
    // a failed restic run or a wrong SHA-256 removes the fetched file, and only it.
    const created = script.indexOf("$staging = New-RestowStagingFolder");
    expect(script.slice(created).split("\n").slice(1, 3)).toEqual(["$connection = $null", "try {"]);
  });

  it("gives the SQL Server service, and only those who need it, access to the fetched file", () => {
    const script = renderSqlRestoreScript(input);
    expect(script).toContain("$acl.SetAccessRuleProtection($true, $false)");
    expect(script).toContain("[void][System.IO.Directory]::CreateDirectory($folder, $acl)");
    expect(script).toContain("$SqlServiceAccount = 'NT SERVICE\\MSSQLSERVER'");
    expect(script).toContain("$SqlServiceAccount = 'NT SERVICE\\MSSQL$' + $instanceName");
    expect(script).toContain(
      "FileSystemAccessRule($readerSid, 'ReadAndExecute', $inherit, $propagate, $allow)",
    );
    // SYSTEM, Administrators and the user running the script get full control; nobody else.
    expect(script).toContain("'S-1-5-18'");
    expect(script).toContain("'S-1-5-32-544'");
    expect(script).toContain("[System.Security.Principal.WindowsIdentity]::GetCurrent().User");
    expect(script.match(/FileSystemAccessRule\(/g)).toHaveLength(2);
  });

  it("checks the name again in the batch of the RESTORE", () => {
    const script = renderSqlRestoreScript(input);
    expect(script).toContain(
      "IF DB_ID(@new) IS NOT NULL BEGIN; THROW 50003, N'A database of this name exists already.', 1; END; RESTORE DATABASE @new",
    );
  });

  it("has no imports, so the CI can render it without a build", () => {
    const source = readFileSync(new URL("./restore-script.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).not.toMatch(/\brequire\(/);
    expect(source).not.toMatch(/^\s*export\s+(\*|\{[^}]*\})\s+from\s/m);
  });
});
