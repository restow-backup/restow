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
    expect(script).toContain("$readerSid = Get-RestowServiceSid $SqlServiceAccount");
    expect(script).toContain("$staging = New-RestowStagingFolder $StagingDir $readerSid");
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
    expect(script).toContain("$acl = New-RestowStagingSecurity $true $ReaderSid");
    expect(script).toContain("[void][System.IO.Directory]::CreateDirectory($folder, $acl)");
    expect(script).toContain("$SqlServiceAccount = 'NT SERVICE\\MSSQLSERVER'");
    expect(script).toContain("$SqlServiceAccount = 'NT SERVICE\\MSSQL$' + $instanceName");
    expect(script).toContain(
      "FileSystemAccessRule($ReaderSid, 'ReadAndExecute', $inherit, $propagate, $allow)",
    );
    // SYSTEM, Administrators and the user running the script get full control; nobody else.
    expect(script).toContain("'S-1-5-18'");
    expect(script).toContain("'S-1-5-32-544'");
    expect(script).toContain("[System.Security.Principal.WindowsIdentity]::GetCurrent().User");
    expect(script.match(/FileSystemAccessRule\(/g)).toHaveLength(2);
    // A file gets the same entries without inheritance flags.
    expect(script).toContain("$acl = New-Object System.Security.AccessControl.FileSecurity");
    expect(script).toContain("$inherit = [System.Security.AccessControl.InheritanceFlags]::None");
  });

  it("fetches the file right into its folder, with a name SQL Server can open", () => {
    // The whole snapshot path below the staging folder would repeat the machine's staging path in
    // the name RESTORE opens; SQL Server takes at most 259 characters (error 3057).
    const script = renderSqlRestoreScript(input);
    expect(script).toContain(
      "restore ($Data.backup.snapshotId + ':' + $folderInSnapshot) --include ('/' + $fileName) --target $staging",
    );
    expect(script).toContain("$bak = Join-Path $staging $fileName");
    expect(script).not.toContain("--include $Data.backup.pathInSnapshot");
    const lengthCheck = script.indexOf("if ($bak.Length -gt 259) {");
    expect(lengthCheck).toBeGreaterThan(0);
    expect(script.indexOf("& $Restic -r $Repository")).toBeGreaterThan(lengthCheck);
  });

  it("gives what restic fetched the folder's access again before SQL Server reads it", () => {
    // restic restores the security descriptors of the snapshot: the agent's staging folders grant
    // only the SQL Server service of the machine that made the backup, so another instance here
    // could not open the file (RESTORE FILELISTONLY, OS error 5) without this step.
    const script = renderSqlRestoreScript(input);
    const restic = script.indexOf("& $Restic -r $Repository");
    const exitCheck = script.indexOf("restic restore ended with exit code");
    const access = script.indexOf("  Set-RestowStagingAccess $staging $readerSid\n");
    const hash = script.indexOf("Get-FileHash -LiteralPath $bak");
    const fileList = script.indexOf("$command = New-RestowCommand $connection 'FileListOnly'");
    expect(restic).toBeGreaterThan(0);
    expect(access).toBeGreaterThan(exitCheck);
    expect(exitCheck).toBeGreaterThan(restic);
    // Before the file is read at all (also the hash), and so before FILELISTONLY and RESTORE.
    expect(hash).toBeGreaterThan(access);
    expect(fileList).toBeGreaterThan(hash);
    expect(script.split("\n").filter((line) => line.includes("Set-RestowStagingAccess $"))).toEqual(
      ["  Set-RestowStagingAccess $staging $readerSid"],
    );
    // Every item gets the DACL of the staging folder, top down, and a link is refused, never
    // followed (as the agent's SetReadSIDs does).
    const body = script.slice(script.indexOf("function Set-RestowStagingAccess"));
    const fn = body.slice(0, body.indexOf("\n}\n") + 3);
    expect(fn).toContain("$folderAcl = New-RestowStagingSecurity $true $ReaderSid");
    expect(fn).toContain("$fileAcl = New-RestowStagingSecurity $false $ReaderSid");
    expect(fn).toContain("[System.IO.Directory]::SetAccessControl($Folder, $folderAcl)");
    expect(fn).toContain("foreach ($item in @(Get-ChildItem -LiteralPath $dir -Force))");
    expect(fn).toContain(
      "if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {",
    );
    expect(fn).toContain("[System.IO.Directory]::SetAccessControl($item.FullName, $folderAcl)");
    expect(fn).toContain("[System.IO.File]::SetAccessControl($item.FullName, $fileAcl)");
    expect(fn).not.toMatch(/-Recurse/);
    // The reparse check comes before any change to the item, and a folder is listed only after
    // it has the new DACL.
    expect(fn.indexOf("ReparsePoint")).toBeLessThan(fn.indexOf("SetAccessControl($item.FullName"));
    expect(fn.indexOf("SetAccessControl($item.FullName, $folderAcl)")).toBeLessThan(
      fn.indexOf("$pending.Push($item.FullName)"),
    );
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
