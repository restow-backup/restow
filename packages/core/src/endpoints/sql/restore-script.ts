/**
 * The restore script for another machine (W2a, docs/BAREMETAL-WINDOWS.md 5.1.4): one SQL Server
 * backup, fetched from the machine's restic repository with restic and restored under a new name
 * on the computer that runs it, without the server and without a new access to the repository.
 *
 * This file has no imports on purpose: the CI renders the script on a Windows runner without a
 * build of the monorepo (`node --experimental-strip-types scripts/ci/render-sql-restore-script.mts`),
 * and a test keeps it that way.
 *
 * What the script does, in Windows PowerShell 5.1 with System.Data.SqlClient (integrated sign-in of
 * whoever runs it, no stored credential):
 *   1. restic restores exactly the backup file (`--include`) into a new staging folder of the
 *      script's own: `restow-sql-restore-<guid>` below `-StagingDir` or below TEMP, created with
 *      a protected DACL (SYSTEM, Administrators, the user running it, and Read for the SQL Server
 *      service SID of the target instance, which opens the file with its own account); only
 *      that folder is deleted at the end, never the folder the user named;
 *   2. the file's SHA-256 must be the one recorded when the backup was made;
 *   3. the new name must not exist on the instance; `RESTORE FILELISTONLY` of the fetched file
 *      gives the files to move (into the instance's default data and log folders unless given);
 *   4. `RESTORE DATABASE @new FROM DISK = @path WITH MOVE @l<n> TO @p<n>, ..., CHECKSUM, RECOVERY`;
 *   5. with `-CheckDb`, `DBCC CHECKDB` on the copy; then the script's staging folder goes.
 *
 * Every T-SQL text is fixed; names and paths go as SqlParameter, and the only text put together
 * is the list of MOVE placeholders (`New-RestowMoveClause`, from an integer loop). The data of the
 * backup (names, paths, hashes) sits in a single-quoted here-string as one line of JSON, with
 * control characters removed, so nothing in it is ever read as PowerShell. The script starts with a
 * UTF-8 byte order mark: Windows PowerShell 5.1 reads a file without one in the ANSI code page and
 * would garble a database name with umlauts.
 */

export interface RestoreScriptFile {
  logicalName: string;
  type: string;
  fileGroup: string;
  fileId: number;
  sizeBytes: number;
  physicalName: string;
}

export interface RestoreScriptInput {
  endpointId: string;
  hostname: string;
  instance: string;
  database: string;
  backup: {
    snapshotId: string;
    pathInSnapshot: string;
    sha256: string;
    bytes: number;
    firstLsn: string;
    lastLsn: string;
    backupFinish: string;
    fileList: RestoreScriptFile[];
  };
  /**
   * Where the repository lies, as far as the server knows (the storage target and the folder of the
   * machine); shown when -Repository is missing, never used as the repository on its own.
   */
  repositoryHint: string;
}

export const RESTORE_SCRIPT_FORMAT = "restow-sql-restore-v1";

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is removed
const CONTROL = /[\u0000-\u001f\u007f\u2028\u2029]/g;

function clean(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(CONTROL, "");
  }
  if (Array.isArray(value)) {
    return value.map(clean);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, clean(item)]),
    );
  }
  return value;
}

/** The data block: one line of JSON (a line of it can never start with `'@`). */
export function restoreScriptData(input: RestoreScriptInput): string {
  const data = clean({
    format: RESTORE_SCRIPT_FORMAT,
    endpointId: input.endpointId,
    hostname: input.hostname,
    instance: input.instance,
    database: input.database,
    repositoryHint: input.repositoryHint,
    backup: {
      snapshotId: input.backup.snapshotId,
      pathInSnapshot: input.backup.pathInSnapshot,
      sha256: input.backup.sha256.toLowerCase(),
      bytes: input.backup.bytes,
      firstLsn: input.backup.firstLsn,
      lastLsn: input.backup.lastLsn,
      backupFinish: input.backup.backupFinish,
      fileList: input.backup.fileList.map((file) => ({
        logicalName: file.logicalName,
        type: file.type,
        fileGroup: file.fileGroup,
        fileId: file.fileId,
        sizeBytes: file.sizeBytes,
        physicalName: file.physicalName,
      })),
    },
  });
  return JSON.stringify(data);
}

const SCRIPT = String.raw`#Requires -Version 5.1
<#
.SYNOPSIS
  Restores one SQL Server backup from a machine's restic repository under a new name.

.DESCRIPTION
  Fetches the backup file with restic, checks its SHA-256, and restores it on this computer
  under a new name with RESTORE DATABASE ... WITH MOVE, CHECKSUM, RECOVERY. It never replaces an
  existing database. Run it as a Windows account that may restore databases on the instance
  (sysadmin or dbcreator), in Windows PowerShell 5.1.

  The repository password comes from the machine's page ("Show repository password") or from
  "restow-restore endpoint-password" with the master key; pass it as a file (-PasswordFile).

  The backup file is fetched into a new folder restow-sql-restore-<id> below -StagingDir (an
  existing folder) or below TEMP. Only SYSTEM, the Administrators, you and the SQL Server service
  (-SqlServiceAccount, by default the service SID of -Instance) can open it, and only this new
  folder is deleted at the end.

.EXAMPLE
  .\restore.ps1 -Repository 'D:\Backups\endpoints\<id>' -PasswordFile .\password.txt -Instance '.\SQLEXPRESS' -CheckDb
#>
[CmdletBinding()]
param(
  [string]$Repository,
  [Parameter(Mandatory = $true)][string]$PasswordFile,
  [string]$Restic = 'restic.exe',
  [string]$Instance = '.',
  [string]$NewName,
  [string]$DataPath,
  [string]$LogPath,
  [string]$StagingDir,
  [string]$SqlServiceAccount,
  [switch]$CheckDb,
  [switch]$KeepStaging
)

Set-StrictMode -Version 3
$ErrorActionPreference = 'Stop'

$Data = @'
{{DATA}}
'@ | ConvertFrom-Json

if ($Data.format -ne 'restow-sql-restore-v1') { throw 'This script carries data of an unknown format.' }
if (-not $Repository) {
  throw ('Pass the restic repository of the machine with -Repository (on its storage target: ' + $Data.repositoryHint + ').')
}
if (-not $NewName) { $NewName = $Data.database }
if ($NewName.Length -lt 1 -or $NewName.Length -gt 128 -or $NewName -match '[\x00-\x1f]') {
  throw 'The new name must have 1 to 128 characters and no control characters.'
}
if (@('master', 'model', 'msdb', 'tempdb') -contains $NewName.ToLowerInvariant()) {
  throw 'A system database cannot be the target of this script.'
}
if ($NewName.ToLowerInvariant().Contains('__restow_verify_')) {
  throw 'The new name must not contain __restow_verify_ (reserved for check databases).'
}
if (-not $StagingDir) { $StagingDir = $env:TEMP }
if (-not $SqlServiceAccount) {
  # The service SID of the instance on this computer: NT SERVICE\MSSQLSERVER for the default
  # instance, NT SERVICE\MSSQL$<name> for a named one.
  $instanceName = 'MSSQLSERVER'
  $slash = $Instance.LastIndexOf('\')
  if ($slash -ge 0) { $instanceName = $Instance.Substring($slash + 1) }
  if ($instanceName.ToUpperInvariant() -eq 'MSSQLSERVER') {
    $SqlServiceAccount = 'NT SERVICE\MSSQLSERVER'
  } else {
    $SqlServiceAccount = 'NT SERVICE\MSSQL$' + $instanceName
  }
}

$Statements = @{
  DbExists     = 'SELECT DB_ID(@new)'
  Defaults     = "SELECT CONVERT(nvarchar(4000), SERVERPROPERTY('InstanceDefaultDataPath')), CONVERT(nvarchar(4000), SERVERPROPERTY('InstanceDefaultLogPath'))"
  FileListOnly = 'RESTORE FILELISTONLY FROM DISK = @path'
  Restore      = "IF DB_ID(@new) IS NOT NULL BEGIN; THROW 50003, N'A database of this name exists already.', 1; END; RESTORE DATABASE @new FROM DISK = @path WITH {{MOVES}}, CHECKSUM, RECOVERY, STATS = 5"
  CheckDb      = "DECLARE @sql nvarchar(max) = N'DBCC CHECKDB (' + QUOTENAME(@db) + N') WITH NO_INFOMSGS, ALL_ERRORMSGS'; EXEC sp_executesql @sql"
}

function New-RestowMoveClause([int]$Count) {
  $clauses = New-Object System.Collections.Generic.List[string]
  for ($i = 0; $i -lt $Count; $i++) {
    $clauses.Add('MOVE @l' + $i + ' TO @p' + $i)
  }
  return [string]::Join(', ', $clauses)
}

function New-RestowCommand([System.Data.SqlClient.SqlConnection]$Connection, [string]$Name) {
  $command = $Connection.CreateCommand()
  $command.CommandText = $Statements[$Name]
  $command.CommandTimeout = 0
  return $command
}

function Add-RestowParameter([System.Data.SqlClient.SqlCommand]$Command, [string]$Name, [string]$Value) {
  $parameter = $Command.Parameters.Add($Name, [System.Data.SqlDbType]::NVarChar, 4000)
  $parameter.Value = $Value
}

# New-RestowStagingFolder creates a new folder of the script's own below an existing folder,
# with a protected DACL: full control for SYSTEM, the Administrators and the user running the
# script, Read and Execute for the SQL Server service. It never reuses a folder that exists.
function New-RestowStagingFolder([string]$Parent, [string]$Reader) {
  if (-not (Test-Path -LiteralPath $Parent -PathType Container)) {
    throw ('The staging folder ' + $Parent + ' does not exist; pass an existing folder with -StagingDir.')
  }
  $folder = Join-Path $Parent ('restow-sql-restore-' + [guid]::NewGuid().ToString('N'))
  if (Test-Path -LiteralPath $folder) { throw ('The folder ' + $folder + ' exists already.') }
  try {
    $readerSid = (New-Object System.Security.Principal.NTAccount $Reader).Translate([System.Security.Principal.SecurityIdentifier])
  } catch {
    throw ('The SQL Server service account ' + $Reader + ' is not known on this computer; pass the account SQL Server runs as with -SqlServiceAccount.')
  }
  $inherit = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
  $propagate = [System.Security.AccessControl.PropagationFlags]::None
  $allow = [System.Security.AccessControl.AccessControlType]::Allow
  $acl = New-Object System.Security.AccessControl.DirectorySecurity
  $acl.SetAccessRuleProtection($true, $false)
  $owners = @(
    (New-Object System.Security.Principal.SecurityIdentifier 'S-1-5-18'),
    (New-Object System.Security.Principal.SecurityIdentifier 'S-1-5-32-544'),
    [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  )
  foreach ($sid in $owners) {
    $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', $inherit, $propagate, $allow)))
  }
  $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($readerSid, 'ReadAndExecute', $inherit, $propagate, $allow)))
  [void][System.IO.Directory]::CreateDirectory($folder, $acl)
  return $folder
}

function Get-RestowSafeName([string]$Value) {
  $safe = ($Value -replace '[^A-Za-z0-9_-]+', '_').Trim('_')
  if (-not $safe) { $safe = 'database' }
  if ($safe.Length -gt 60) { $safe = $safe.Substring(0, 60) }
  return $safe
}

Write-Host ('Backup of ' + $Data.database + ' on ' + $Data.hostname + '\' + $Data.instance + ', finished ' + $Data.backup.backupFinish)

# 1. Fetch exactly the backup file from the repository, into a new folder of this script.
$staging = New-RestowStagingFolder $StagingDir $SqlServiceAccount
$connection = $null
try {
  & $Restic -r $Repository --password-file $PasswordFile restore $Data.backup.snapshotId --include $Data.backup.pathInSnapshot --target $staging
  if ($LASTEXITCODE -ne 0) { throw ('restic restore ended with exit code ' + $LASTEXITCODE + '.') }
  $relative = $Data.backup.pathInSnapshot.TrimStart('/') -replace '/', '\'
  $bak = Join-Path $staging $relative
  if (-not (Test-Path -LiteralPath $bak -PathType Leaf)) { throw ('restic did not restore ' + $Data.backup.pathInSnapshot + '.') }

  # 2. The file must be the one that was backed up.
  $hash = (Get-FileHash -LiteralPath $bak -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($hash -ne $Data.backup.sha256) {
    throw ('The fetched file has the SHA-256 ' + $hash + ', the backup recorded ' + $Data.backup.sha256 + '. It is not restored.')
  }
  Write-Host 'SHA-256 matches the backup.'

  Add-Type -AssemblyName System.Data
  $builder = New-Object System.Data.SqlClient.SqlConnectionStringBuilder
  $builder['Data Source'] = $Instance
  $builder['Integrated Security'] = $true
  $builder['Initial Catalog'] = 'master'
  $builder['Application Name'] = 'restow-sql-restore'
  $connection = New-Object System.Data.SqlClient.SqlConnection $builder.ConnectionString
  $connection.FireInfoMessageEventOnUserErrors = $false
  $script:CheckDbErrors = 0
  $connection.add_InfoMessage({
    param($source, $info)
    foreach ($item in $info.Errors) { if ($item.Class -gt 10) { $script:CheckDbErrors++ } }
    Write-Host $info.Message
  })
  $connection.Open()

  # 3. Never over an existing database (checked again in the batch of the RESTORE).
  $command = New-RestowCommand $connection 'DbExists'
  Add-RestowParameter $command '@new' $NewName
  if (-not ($command.ExecuteScalar() -is [System.DBNull])) {
    throw ('A database named ' + $NewName + ' exists on ' + $Instance + '. Choose another name with -NewName.')
  }

  $command = New-RestowCommand $connection 'Defaults'
  $reader = $command.ExecuteReader()
  try {
    [void]$reader.Read()
    if (-not $DataPath) { $DataPath = [string]$reader.GetValue(0) }
    if (-not $LogPath) { $LogPath = [string]$reader.GetValue(1) }
  } finally { $reader.Close() }
  if (-not $DataPath -or -not $LogPath) { throw 'The instance names no default data or log folder; pass -DataPath and -LogPath.' }

  $command = New-RestowCommand $connection 'FileListOnly'
  Add-RestowParameter $command '@path' $bak
  $files = New-Object System.Collections.Generic.List[object]
  $reader = $command.ExecuteReader()
  try {
    while ($reader.Read()) {
      $files.Add([pscustomobject]@{
        LogicalName = [string]$reader['LogicalName']
        Type        = [string]$reader['Type']
        FileId      = [long]$reader['FileId']
      })
    }
  } finally { $reader.Close() }
  if ($files.Count -eq 0) { throw 'RESTORE FILELISTONLY named no file.' }
  if ($files.Count -ne @($Data.backup.fileList).Count) {
    Write-Warning 'The backup file names another number of files than recorded; the fetched file decides.'
  }

  # 4. Restore under the new name, every file moved into the target folders.
  $base = (Get-RestowSafeName $NewName) + '_' + [guid]::NewGuid().ToString('N').Substring(0, 8)
  $command = New-RestowCommand $connection 'Restore'
  $command.CommandText = $command.CommandText.Replace('{{MOVES}}', (New-RestowMoveClause $files.Count))
  Add-RestowParameter $command '@new' $NewName
  Add-RestowParameter $command '@path' $bak
  for ($i = 0; $i -lt $files.Count; $i++) {
    $file = $files[$i]
    switch ($file.Type) {
      'L' { $target = Join-Path $LogPath ($base + '_' + $file.FileId + '.ldf') }
      'S' { $target = Join-Path $DataPath ($base + '_fs' + $file.FileId) }
      'F' { $target = Join-Path $DataPath ($base + '_ft' + $file.FileId) }
      default {
        if ($file.FileId -eq 1) { $extension = '.mdf' } else { $extension = '.ndf' }
        $target = Join-Path $DataPath ($base + '_' + $file.FileId + $extension)
      }
    }
    Add-RestowParameter $command ('@l' + $i) $file.LogicalName
    Add-RestowParameter $command ('@p' + $i) $target
    Write-Host ('  ' + $file.LogicalName + ' -> ' + $target)
  }
  [void]$command.ExecuteNonQuery()
  Write-Host ('Restored as ' + $NewName + '.')

  # 5. Optionally check the copy.
  if ($CheckDb) {
    $connection.FireInfoMessageEventOnUserErrors = $true
    $command = New-RestowCommand $connection 'CheckDb'
    Add-RestowParameter $command '@db' $NewName
    $script:CheckDbErrors = 0
    [void]$command.ExecuteNonQuery()
    $connection.FireInfoMessageEventOnUserErrors = $false
    if ($script:CheckDbErrors -gt 0) {
      throw ('DBCC CHECKDB reported ' + $script:CheckDbErrors + ' error(s) in ' + $NewName + '; they are listed above.')
    }
    Write-Host ('DBCC CHECKDB found no error in ' + $NewName + '.')
  }
} finally {
  if ($null -ne $connection) { $connection.Close() }
  # Only the folder this script created goes, never the folder given as -StagingDir.
  if ($KeepStaging) {
    Write-Host ('The fetched backup stays in ' + $staging + '.')
  } else {
    Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
  }
}
`;

/** The script for one backup, with a UTF-8 byte order mark. */
export function renderSqlRestoreScript(input: RestoreScriptInput): string {
  const data = restoreScriptData(input);
  return `\uFEFF${SCRIPT.replace("{{DATA}}", () => data)}`;
}
