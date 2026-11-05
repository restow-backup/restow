# CI of the native SQL Server backup and of the multi-volume finding on a
# hosted Windows runner (docs/BAREMETAL-WINDOWS.md 8.2, W1 and W2a; workflow
# .github/workflows/sql-server.yml). Runs as Administrator from the agent
# folder:
#
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/test-sql-windows.ps1 -Mode multivolume
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/test-sql-windows.ps1 -Mode sql -SqlVersion 2022 [-Strict]
#
# -Mode multivolume (W1): two VHDX volumes Q: and L:, a backup over both
#   with the agent's restic runner and --use-fs-snapshot, Win32_ShadowCopy
#   polled meanwhile; the gate is two snapshot sets with two times
#   (internal/restic/multivolume_windows_test.go).
# -Mode sql (W2a): SQL Server Express (only for this test; its licence is the
#   maintainer's question, see the design) is downloaded from Microsoft,
#   its Authenticode signature checked and installed silently as SQLEXPRESS
#   and RESTOWB. Databases get their data on Q: and their log on L:. Express
#   has no backup compression, so "backup compression default" is switched
#   on only on an edition that has it; the NO_COMPRESSION gate itself runs in
#   the job tsql-linux on the Developer edition. The probe internal/
#   sqlserver/sqlci runs as the service RestowSqlCi with an unrestricted
#   service SID, exactly as the agent reaches SQL Server:
#     1. without a login: sql_login_missing;
#     2. with the small rights (dbcreator, db_backupoperator, db_owner): a full;
#     3. with sysadmin: a full under load (a concurrent insert loop), the
#        multi-volume finding of W1 with the files of that database (data on
#        Q:, log on L:) under the same load, Compressed = 0, the check from
#        the repository (green), a damaged copy (DBCC WRITEPAGE on a scratch
#        database: red), a restore under a new name with CHECKDB;
#     4. the restore script for another machine, rendered by
#        scripts/ci/render-sql-restore-script.mts, run against RESTOWB with
#        its default staging folder (no -StagingDir, no permission set by
#        hand), and once with -StagingDir naming a folder with a file of
#        someone else in it, which must stay;
#     5. the flows once more as the runner (go test -tags sqlintegration).
# A failed download of Microsoft's installer makes the run incomplete, not
# red (exit 0 with a note in the step summary), unless -Strict. Nothing from
# Microsoft is uploaded as an artifact or kept in a cache.
param(
    [ValidateSet('multivolume', 'sql')][string]$Mode = 'sql',
    [ValidateSet('2019', '2022')][string]$SqlVersion = '2022',
    [switch]$Strict,
    [string]$WorkDir,
    [string]$Restic = $env:RESTIC_BINARY,
    [string]$Evidence
)
Set-StrictMode -Version 2
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$agentDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$repoRoot = (Resolve-Path (Join-Path $agentDir '..')).Path
if (-not $WorkDir) {
    $base = $env:RUNNER_TEMP
    if (-not $base) { $base = $env:TEMP }
    $WorkDir = Join-Path $base 'restow-sql-ci'
}
if (-not $Evidence) { $Evidence = Join-Path $WorkDir ("evidence-$Mode.json") }
New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null

$failures = New-Object System.Collections.Generic.List[string]
$steps = New-Object System.Collections.Generic.List[object]
function Fail([string]$Text) { $failures.Add($Text); $steps.Add(@{ step = $Text; ok = $false }); Write-Host "FAIL: $Text" -ForegroundColor Red }
function Ok([string]$Text) { $steps.Add(@{ step = $Text; ok = $true }); Write-Host "ok: $Text" }

# Get-Field reads an optional field of a result: the agent leaves empty
# fields out (omitempty), and Set-StrictMode refuses a missing property. It
# returns nothing for a missing field; wrap a list in @().
function Get-Field($Object, [string]$Path) {
    $cur = $Object
    foreach ($name in $Path.Split('.')) {
        if ($null -eq $cur) { return }
        $prop = $cur.PSObject.Properties[$name]
        if ($null -eq $prop) { return }
        $cur = $prop.Value
    }
    if ($null -eq $cur) { return }
    return $cur
}

# Get-DbResult is the entry of one database in a report (sql or sqlVerify).
function Get-DbResult($Result, [string]$Section, [string]$Name) {
    foreach ($d in @(Get-Field $Result ($Section + '.databases'))) {
        if ((Get-Field $d 'name') -eq $Name) { return $d }
    }
}

function Show-Errors($Result) { return (ConvertTo-Json -InputObject @(Get-Field $Result 'errors') -Compress -Depth 6) }

function Write-Summary([string]$Text) {
    Write-Host $Text
    if ($env:GITHUB_STEP_SUMMARY) { Add-Content -Path $env:GITHUB_STEP_SUMMARY -Value $Text }
}

function Save-Evidence([hashtable]$Extra) {
    $doc = @{ mode = $Mode; sqlVersion = $SqlVersion; steps = $steps.ToArray(); failures = $failures.ToArray() }
    foreach ($k in $Extra.Keys) { $doc[$k] = $Extra[$k] }
    [System.IO.File]::WriteAllText($Evidence, (ConvertTo-Json -InputObject $doc -Depth 12))
}

function Exit-Incomplete([string]$Why) {
    Write-Summary "SQL Server CI ($Mode, $SqlVersion): incomplete, $Why"
    Save-Evidence @{ result = 'incomplete'; reason = $Why }
    if ($Strict) { exit 1 }
    exit 0
}

function Finish {
    param([hashtable]$Extra = @{})
    if ($failures.Count -gt 0) {
        Save-Evidence ($Extra + @{ result = 'red' })
        Write-Summary "SQL Server CI ($Mode, $SqlVersion): $($failures.Count) failure(s): $($failures -join '; ')"
        exit 1
    }
    Save-Evidence ($Extra + @{ result = 'green' })
    Write-Summary "SQL Server CI ($Mode, $SqlVersion): all steps passed"
    exit 0
}

# ---- volumes ----------------------------------------------------------------

function New-TestVolume([string]$Letter, [int]$SizeMB) {
    if (Test-Path ($Letter + ':\')) { return }
    $vhd = Join-Path $WorkDir ("vol-$Letter.vhdx")
    $script = @"
create vdisk file="$vhd" maximum=$SizeMB type=expandable
select vdisk file="$vhd"
attach vdisk
convert gpt
create partition primary
format fs=ntfs quick label=Restow$Letter
assign letter=$Letter
"@
    $file = Join-Path $WorkDir ("diskpart-$Letter.txt")
    [System.IO.File]::WriteAllText($file, $script)
    & diskpart.exe /s $file | Out-Host
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path ($Letter + ':\'))) { throw "diskpart could not create the volume $Letter`:" }
}

New-TestVolume 'Q' 6144
New-TestVolume 'L' 3072
Ok 'VHDX volumes Q: and L:'

if (-not $Restic -or -not (Test-Path $Restic)) { throw 'Pass -Restic or set RESTIC_BINARY to restic.exe.' }

Push-Location $agentDir
try {
    if ($Mode -eq 'multivolume') {
        $env:RESTOW_TEST_VOLUMES = 'Q:\,L:\'
        $env:RESTOW_TEST_EVIDENCE = Join-Path $WorkDir 'multivolume.json'
        $env:RESTIC_BINARY = $Restic
        & go test -count=1 -v -tags 'windowsintegration,vssci' -run TestMultiVolumeShadowCopySets ./internal/restic/ | Out-Host
        $mv = $null
        if (Test-Path $env:RESTOW_TEST_EVIDENCE) { $mv = Get-Content -Raw $env:RESTOW_TEST_EVIDENCE | ConvertFrom-Json }
        if ($LASTEXITCODE -eq 0) { Ok 'two volumes, two shadow copy sets with two times' } else { Fail 'the multi-volume finding did not reproduce (see the test output)' }
        if ($null -ne $mv) { Write-Summary ("Multi-volume finding (plain files): " + (Get-Field $mv 'finding') + " " + (ConvertTo-Json -InputObject (Get-Field $mv 'setByVolume') -Compress)) }
        Finish @{ multivolume = $mv }
    }

    # ---- SQL Server Express (download, signature, silent install) -------------
    $bootstrap = @{
        '2019' = 'https://go.microsoft.com/fwlink/?linkid=866658'
        '2022' = 'https://go.microsoft.com/fwlink/p/?linkid=2216019&clcid=0x409&culture=en-us&country=us'
    }[$SqlVersion]
    function Test-MicrosoftSignature([string]$Path) {
        $sig = Get-AuthenticodeSignature -FilePath $Path
        return ($sig.Status -eq 'Valid' -and $null -ne $sig.SignerCertificate -and $sig.SignerCertificate.Subject -match 'O=Microsoft Corporation')
    }
    function Test-Instance([string]$Name) {
        $key = 'HKLM:\SOFTWARE\Microsoft\Microsoft SQL Server\Instance Names\SQL'
        if (-not (Test-Path $key)) { return $false }
        return $null -ne (Get-ItemProperty -Path $key -Name $Name -ErrorAction SilentlyContinue)
    }
    $media = Join-Path $WorkDir 'media'
    if (-not ((Test-Instance 'SQLEXPRESS') -and (Test-Instance 'RESTOWB'))) {
        New-Item -ItemType Directory -Force -Path $media | Out-Null
        $ssei = Join-Path $media 'SSEI-Expr.exe'
        try {
            [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
            Invoke-WebRequest -Uri $bootstrap -OutFile $ssei -UseBasicParsing
        } catch { Exit-Incomplete ("the SQL Server Express bootstrapper could not be downloaded: " + $_.Exception.Message) }
        if (-not (Test-MicrosoftSignature $ssei)) { Exit-Incomplete 'the bootstrapper has no valid Microsoft signature' }
        $p = Start-Process -FilePath $ssei -ArgumentList @('/ACTION=Download', "/MEDIAPATH=$media", '/MEDIATYPE=Core', '/QUIET') -Wait -PassThru
        $package = Get-ChildItem -Path $media -Filter 'SQLEXPR*.exe' | Select-Object -First 1
        if ($p.ExitCode -ne 0 -or $null -eq $package) { Exit-Incomplete ("the media download ended with exit code " + $p.ExitCode) }
        if (-not (Test-MicrosoftSignature $package.FullName)) { Exit-Incomplete 'the Express package has no valid Microsoft signature' }
        $setupDir = Join-Path $media 'setup'
        $p = Start-Process -FilePath $package.FullName -ArgumentList @('/q', "/x:$setupDir") -Wait -PassThru
        $setup = Join-Path $setupDir 'setup.exe'
        if ($p.ExitCode -ne 0 -or -not (Test-Path $setup) -or -not (Test-MicrosoftSignature $setup)) { Exit-Incomplete 'the Express package could not be extracted' }
        foreach ($inst in @('SQLEXPRESS', 'RESTOWB')) {
            if (Test-Instance $inst) { continue }
            $setupArgs = @('/Q', '/ACTION=Install', '/FEATURES=SQLEngine', "/INSTANCENAME=$inst", '/SQLSYSADMINACCOUNTS=BUILTIN\Administrators',
                '/IACCEPTSQLSERVERLICENSETERMS', '/UPDATEENABLED=0', '/TCPENABLED=0', '/NPENABLED=0')
            $p = Start-Process -FilePath $setup -ArgumentList $setupArgs -Wait -PassThru
            if ($p.ExitCode -ne 0 -and $p.ExitCode -ne 3010) { throw "setup of $inst ended with exit code $($p.ExitCode)" }
        }
        # Nothing from Microsoft stays behind for an artifact or a cache.
        Remove-Item -Recurse -Force $media -ErrorAction SilentlyContinue
    }
    if ((Test-Instance 'SQLEXPRESS') -and (Test-Instance 'RESTOWB')) { Ok "SQL Server $SqlVersion Express installed as SQLEXPRESS and RESTOWB" } else { throw 'the instances are missing after the setup' }

    # ---- test setup T-SQL (as the runner, an administrator) -------------------
    function Invoke-AdminSql([string]$Instance, [string]$Query, [switch]$Rows) {
        $conn = New-Object System.Data.SqlClient.SqlConnection("Data Source=lpc:.\$Instance;Integrated Security=true;Initial Catalog=master;Pooling=false")
        $conn.Open()
        try {
            $cmd = $conn.CreateCommand()
            $cmd.CommandText = $Query
            $cmd.CommandTimeout = 600
            if ($Rows) {
                $table = New-Object System.Data.DataTable
                $table.Load($cmd.ExecuteReader())
                return , $table
            }
            [void]$cmd.ExecuteNonQuery()
        } finally { $conn.Close() }
    }
    foreach ($inst in @('SQLEXPRESS', 'RESTOWB')) {
        $svc = 'MSSQL$' + $inst
        if ((Get-Service $svc).Status -ne 'Running') { Start-Service $svc }
    }
    New-Item -ItemType Directory -Force -Path 'Q:\Data', 'L:\Log' | Out-Null
    # SQL Server writes its files under its own service SID.
    & icacls.exe 'Q:\Data' /grant 'NT SERVICE\MSSQL$SQLEXPRESS:(OI)(CI)M' | Out-Null
    & icacls.exe 'L:\Log' /grant 'NT SERVICE\MSSQL$SQLEXPRESS:(OI)(CI)M' | Out-Null
    # Express (EngineEdition 4) has no backup compression and no option
    # "backup compression default"; sp_configure of it fails there (15123).
    $edition = Invoke-AdminSql 'SQLEXPRESS' "SELECT CAST(SERVERPROPERTY('EngineEdition') AS int) AS e, CAST(SERVERPROPERTY('Edition') AS nvarchar(128)) AS n" -Rows
    $compresses = [int]$edition.Rows[0].e -ne 4
    if ($compresses) {
        Invoke-AdminSql 'SQLEXPRESS' "EXEC sp_configure 'show advanced options', 1; RECONFIGURE; EXEC sp_configure 'backup compression default', 1; RECONFIGURE;"
    }
    Invoke-AdminSql 'SQLEXPRESS' @"
IF DB_ID('RestowCi') IS NULL CREATE DATABASE RestowCi ON (NAME = RestowCi, FILENAME = 'Q:\Data\RestowCi.mdf', SIZE = 64MB) LOG ON (NAME = RestowCi_log, FILENAME = 'L:\Log\RestowCi_log.ldf', SIZE = 32MB);
ALTER DATABASE RestowCi SET RECOVERY FULL;
IF DB_ID('Scratch') IS NULL CREATE DATABASE Scratch ON (NAME = Scratch, FILENAME = 'Q:\Data\Scratch.mdf') LOG ON (NAME = Scratch_log, FILENAME = 'L:\Log\Scratch_log.ldf');
"@
    Invoke-AdminSql 'SQLEXPRESS' @"
USE RestowCi;
IF OBJECT_ID('dbo.Orders') IS NULL CREATE TABLE dbo.Orders (Id int IDENTITY PRIMARY KEY, Filler char(800) NOT NULL DEFAULT 'x', At datetime2 NOT NULL DEFAULT SYSUTCDATETIME());
INSERT INTO dbo.Orders DEFAULT VALUES;
WHILE (SELECT COUNT(*) FROM dbo.Orders) < 20000 INSERT INTO dbo.Orders (Filler) SELECT TOP (2000) 'y' FROM sys.all_objects a CROSS JOIN sys.all_objects b;
USE Scratch;
IF OBJECT_ID('dbo.T') IS NULL CREATE TABLE dbo.T (Id int PRIMARY KEY, V char(500) NOT NULL);
IF NOT EXISTS (SELECT 1 FROM dbo.T) INSERT INTO dbo.T SELECT TOP (500) ROW_NUMBER() OVER (ORDER BY (SELECT 1)), 'z' FROM sys.all_objects;
"@
    if ($compresses) {
        $comp = Invoke-AdminSql 'SQLEXPRESS' "SELECT CAST(value_in_use AS int) AS v FROM sys.configurations WHERE name = 'backup compression default'" -Rows
        if ($comp.Rows.Count -eq 1 -and $comp.Rows[0].v -eq 1) { Ok 'backup compression default is on' } else { Fail 'backup compression default could not be switched on' }
    } else {
        Ok ([string]$edition.Rows[0].n + ' has no backup compression; the NO_COMPRESSION gate runs in tsql-linux (Developer)')
    }

    # ---- the probe as the service RestowSqlCi ---------------------------------
    $probe = Join-Path $WorkDir 'sqlci.exe'
    & go build -tags sqlci -o $probe ./internal/sqlserver/sqlci
    if ($LASTEXITCODE -ne 0) { throw 'the probe does not build' }
    $repo = Join-Path $WorkDir 'repo'
    $pwFile = Join-Path $WorkDir 'repo.pw'
    [System.IO.File]::WriteAllText($pwFile, 'restow-ci-only-' + [guid]::NewGuid().ToString('N'))
    if (-not (Test-Path (Join-Path $repo 'config'))) {
        $env:RESTIC_PASSWORD_FILE = $pwFile
        & $Restic init --repo $repo | Out-Host
        Remove-Item Env:\RESTIC_PASSWORD_FILE
    }
    $probeWork = Join-Path $WorkDir 'probe'
    New-Item -ItemType Directory -Force -Path $probeWork | Out-Null
    & sc.exe query RestowSqlCi | Out-Null
    if ($LASTEXITCODE -ne 0) {
        & sc.exe create RestowSqlCi binPath= "`"$probe`" -service -in `"$WorkDir\job.json`" -out `"$WorkDir\result.json`"" start= demand obj= LocalSystem | Out-Host
    }
    & sc.exe sidtype RestowSqlCi unrestricted | Out-Host

    function Invoke-Probe([hashtable]$Job) {
        $Job.workDir = $probeWork; $Job.resticBinary = $Restic; $Job.repository = $repo; $Job.passwordFile = $pwFile
        $Job.hostname = 'sql-ci'; $Job.endpointId = 'ci'
        $out = Join-Path $WorkDir 'result.json'
        Remove-Item -Force $out, "$out.error" -ErrorAction SilentlyContinue
        [System.IO.File]::WriteAllText((Join-Path $WorkDir 'job.json'), (ConvertTo-Json -InputObject $Job -Depth 6))
        Start-Service RestowSqlCi
        $deadline = (Get-Date).AddMinutes(60)
        while ((Get-Service RestowSqlCi).Status -ne 'Stopped' -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 2 }
        if (Test-Path "$out.error") { throw ('the probe failed: ' + (Get-Content -Raw "$out.error")) }
        if (-not (Test-Path $out)) { throw "the probe wrote no result for $($Job.op)" }
        $text = Get-Content -Raw $out
        Copy-Item $out (Join-Path $WorkDir ("result-" + $Job.op + "-" + (Get-Date -Format 'HHmmss') + ".json"))
        return ($text | ConvertFrom-Json)
    }

    # 1. Without a login.
    Invoke-AdminSql 'SQLEXPRESS' "IF SUSER_ID('NT SERVICE\RestowSqlCi') IS NOT NULL DROP LOGIN [NT SERVICE\RestowSqlCi];"
    $r = Invoke-Probe @{ op = 'inventory'; instance = 'SQLEXPRESS' }
    $first = @(Get-Field $r 'errors') | Select-Object -First 1
    if ((Get-Field $r 'status') -eq 'failed' -and (Get-Field $first 'code') -eq 'sql_login_missing') { Ok 'without a login: sql_login_missing' } else { Fail ("without a login: " + (Show-Errors $r)) }

    # 2. The small rights.
    Invoke-AdminSql 'SQLEXPRESS' @"
CREATE LOGIN [NT SERVICE\RestowSqlCi] FROM WINDOWS;
ALTER SERVER ROLE dbcreator ADD MEMBER [NT SERVICE\RestowSqlCi];
USE RestowCi; CREATE USER [NT SERVICE\RestowSqlCi] FOR LOGIN [NT SERVICE\RestowSqlCi];
ALTER ROLE db_backupoperator ADD MEMBER [NT SERVICE\RestowSqlCi]; ALTER ROLE db_owner ADD MEMBER [NT SERVICE\RestowSqlCi];
"@
    $r = Invoke-Probe @{ op = 'backup'; instance = 'SQLEXPRESS'; databases = @('RestowCi') }
    $b = Get-Field (Get-DbResult $r 'sql' 'RestowCi') 'backup'
    if ((Get-Field $r 'status') -eq 'succeeded' -and $null -ne $b -and (Get-Field $b 'copyOnly')) { Ok 'small rights: COPY_ONLY full' } else { Fail ("small rights: " + (Show-Errors $r)) }

    # 3. sysadmin; a full under load.
    Invoke-AdminSql 'SQLEXPRESS' "ALTER SERVER ROLE sysadmin ADD MEMBER [NT SERVICE\RestowSqlCi];"
    $load = Start-Job -ScriptBlock {
        $conn = New-Object System.Data.SqlClient.SqlConnection('Data Source=lpc:.\SQLEXPRESS;Integrated Security=true;Initial Catalog=RestowCi;Pooling=false')
        $conn.Open()
        $cmd = $conn.CreateCommand()
        $cmd.CommandText = 'INSERT INTO dbo.Orders (Filler) VALUES (''load'')'
        $end = (Get-Date).AddMinutes(10)
        $n = 0
        while ((Get-Date) -lt $end -and -not (Test-Path (Join-Path $using:WorkDir 'stop-load'))) { [void]$cmd.ExecuteNonQuery(); $n++ }
        $conn.Close()
        $n
    }
    Start-Sleep -Seconds 3
    $full = Invoke-Probe @{ op = 'backup'; instance = 'SQLEXPRESS'; databases = @('RestowCi', 'master', 'msdb') }
    # W1 as 8.2 asks for it: the agent's restic runner backs up the folders
    # of the RestowCi files (data on Q:, log on L:) with --use-fs-snapshot
    # while the load still writes; two shadow copy sets with two times.
    $env:RESTOW_TEST_VOLUMES = 'Q:\,L:\'
    $env:RESTOW_TEST_SOURCES = 'Q:\Data,L:\Log'
    $env:RESTOW_TEST_EVIDENCE = Join-Path $WorkDir 'multivolume-sql.json'
    $env:RESTIC_BINARY = $Restic
    & go test -count=1 -v -tags 'windowsintegration,vssci' -run TestMultiVolumeShadowCopySets ./internal/restic/ | Out-Host
    $mvOk = $LASTEXITCODE -eq 0
    Remove-Item Env:\RESTOW_TEST_SOURCES
    $mvSql = $null
    if (Test-Path $env:RESTOW_TEST_EVIDENCE) { $mvSql = Get-Content -Raw $env:RESTOW_TEST_EVIDENCE | ConvertFrom-Json }
    if ($mvOk) { Ok 'W1 under load: the data (Q:) and log (L:) of RestowCi in two shadow copy sets with two times' } else { Fail 'W1 under load: the multi-volume finding did not reproduce with the RestowCi files (see the test output)' }
    if ($null -ne $mvSql) { Write-Summary ("Multi-volume finding (RestowCi under load): " + (Get-Field $mvSql 'finding') + " " + (ConvertTo-Json -InputObject (Get-Field $mvSql 'setByVolume') -Compress)) }
    New-Item -ItemType File -Force -Path (Join-Path $WorkDir 'stop-load') | Out-Null
    $inserted = Receive-Job -Job $load -Wait
    Remove-Item -Force (Join-Path $WorkDir 'stop-load')
    $fullJson = Join-Path $WorkDir 'backup.json'
    [System.IO.File]::WriteAllText($fullJson, (ConvertTo-Json -InputObject $full -Depth 12))
    $b = Get-Field (Get-DbResult $full 'sql' 'RestowCi') 'backup'
    if ((Get-Field $full 'status') -eq 'succeeded' -and $null -ne $b) { Ok "full under load ($inserted inserts meanwhile)" } else { Fail ("full under load: " + (Show-Errors $full)) }
    if ($null -ne $b -and -not (Get-Field $b 'compressed')) {
        if ($compresses) { Ok 'Compressed = 0 with the compression default on' } else { Ok 'Compressed = 0 (Express never compresses)' }
    } else { Fail 'the backup is compressed' }
    $hist = Invoke-AdminSql 'SQLEXPRESS' "SELECT TOP (1) CAST(is_copy_only AS int) AS c FROM msdb.dbo.backupset WHERE database_name = 'RestowCi' ORDER BY backup_set_id DESC" -Rows
    if ($hist.Rows[0].c -eq 1) { Ok 'msdb records the backup as copy-only (no chain of the customer touched)' } else { Fail 'msdb records a backup that is not copy-only' }
    if (@(Get-ChildItem -Recurse -Path (Join-Path $probeWork 'staging\sql') -Filter *.bak -ErrorAction SilentlyContinue).Count -eq 0) { Ok 'the staging files are gone after the snapshot' } else { Fail 'staging files left after the snapshot' }

    $v = Invoke-Probe @{ op = 'verify'; instance = 'SQLEXPRESS'; from = $fullJson }
    $vdbs = @(Get-Field $v 'sqlVerify.databases')
    $notGreen = @($vdbs | Where-Object { -not ((Get-Field $_ 'sha256Match') -and (Get-Field $_ 'restore.ok') -and (Get-Field $_ 'checkdb.ran') -and @(Get-Field $_ 'checkdb.errors').Count -eq 0) })
    $green = (Get-Field $v 'status') -eq 'succeeded' -and $vdbs.Count -gt 0 -and $notGreen.Count -eq 0
    $sys = @($vdbs | Where-Object { (Get-Field $_ 'code') -eq 'sql_verify_system_db' } | ForEach-Object { Get-Field $_ 'name' })
    if ($green) { Ok 'check from the repository: green (RestowCi, master, msdb)' } elseif ($sys.Count -gt 0) { Fail ("system databases cannot be checked under a new name: " + ($sys -join ', ') + " (C22: note it in the design)") } else { Fail ("check from the repository: " + (Show-Errors $v)) }

    # A damaged copy is red: a page of Scratch is changed through the buffer
    # pool (its checksum stays valid, so the backup goes through), CHECKDB of
    # the copy restored from the repository finds it.
    $page = Invoke-AdminSql 'SQLEXPRESS' @"
SELECT TOP (1) allocated_page_page_id AS p FROM sys.dm_db_database_page_allocations(DB_ID('Scratch'), OBJECT_ID('Scratch.dbo.T'), NULL, NULL, 'DETAILED')
WHERE page_type_desc = 'DATA_PAGE' ORDER BY allocated_page_page_id;
"@ -Rows
    $pageId = [int]$page.Rows[0].p
    Invoke-AdminSql 'SQLEXPRESS' "ALTER DATABASE Scratch SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DBCC WRITEPAGE ('Scratch', 1, $pageId, 96, 4, 0x00000000, 0); ALTER DATABASE Scratch SET MULTI_USER;"
    $bad = Invoke-Probe @{ op = 'backup'; instance = 'SQLEXPRESS'; databases = @('Scratch') }
    $badJson = Join-Path $WorkDir 'backup-scratch.json'
    [System.IO.File]::WriteAllText($badJson, (ConvertTo-Json -InputObject $bad -Depth 12))
    $vr = Invoke-Probe @{ op = 'verify'; instance = 'SQLEXPRESS'; from = $badJson }
    $s = Get-DbResult $vr 'sqlVerify' 'Scratch'
    $found = @(Get-Field $s 'checkdb.errors')
    if ($null -ne $s -and (Get-Field $s 'checkdb.ran') -and $found.Count -gt 0) { Ok ("a damaged copy is red: CHECKDB " + (Get-Field $found[0] 'number')) } else { Fail ("a damaged copy was not found: " + (ConvertTo-Json $vr -Depth 6 -Compress)) }

    # Restore under a new name, then CHECKDB.
    $rs = Invoke-Probe @{ op = 'restore'; instance = 'SQLEXPRESS'; from = $fullJson; database = 'RestowCi'; newName = 'RestowCi_restored'; checkdb = $true }
    if ((Get-Field $rs 'status') -eq 'succeeded' -and (Get-Field $rs 'sqlRestore.restored') -and (Get-Field $rs 'sqlRestore.checkdb.ran') -and @(Get-Field $rs 'sqlRestore.checkdb.errors').Count -eq 0) { Ok 'restore under a new name with CHECKDB' } else { Fail ("restore under a new name: " + (Show-Errors $rs)) }
    $rows = Invoke-AdminSql 'SQLEXPRESS' "SELECT COUNT(*) AS n FROM RestowCi_restored.dbo.Orders" -Rows
    if ($rows.Rows[0].n -ge 20000) { Ok "the restored copy holds $($rows.Rows[0].n) rows" } else { Fail 'the restored copy holds too few rows' }
    $left = Invoke-AdminSql 'SQLEXPRESS' "SELECT COUNT(*) AS n FROM sys.databases WHERE name LIKE '%[_][_]restow[_]verify[_]%'" -Rows
    if ($left.Rows[0].n -eq 0) { Ok 'no check copy left' } else { Fail 'a check copy was left on the instance' }

    # 4. The restore script for another machine, against RESTOWB.
    $si = Invoke-Probe @{ op = 'restore-script-input'; instance = 'SQLEXPRESS'; from = $fullJson; database = 'RestowCi' }
    $siJson = Join-Path $WorkDir 'restore-script-input.json'
    [System.IO.File]::WriteAllText($siJson, (ConvertTo-Json -InputObject $si -Depth 12))
    $rendered = Join-Path $WorkDir 'restore.ps1'
    Push-Location $repoRoot
    & node --experimental-strip-types scripts/ci/render-sql-restore-script.mts --in $siJson --out $rendered
    Pop-Location
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path $rendered)) { Fail 'the restore script was not rendered' } else {
        # As an administrator would run it: no -StagingDir, no permission set
        # by hand. The script gives the SQL Server service of RESTOWB read
        # access to its own staging folder below TEMP.
        $tempBefore = @(Get-ChildItem -Path $env:TEMP -Directory -Filter 'restow-sql-restore-*' -ErrorAction SilentlyContinue).Count
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $rendered -Repository $repo -PasswordFile $pwFile -Restic $Restic `
            -Instance '.\RESTOWB' -NewName 'RestowCi_other' -CheckDb | Out-Host
        $ok = $LASTEXITCODE -eq 0
        $rows = $null
        try { $rows = Invoke-AdminSql 'RESTOWB' "SELECT COUNT(*) AS n FROM RestowCi_other.dbo.Orders" -Rows } catch { $ok = $false }
        if ($ok -and $rows.Rows[0].n -ge 20000) { Ok 'the rendered restore script restored RestowCi on RESTOWB (default staging folder)' } else { Fail 'the rendered restore script did not restore on RESTOWB with its default staging folder' }
        $tempAfter = @(Get-ChildItem -Path $env:TEMP -Directory -Filter 'restow-sql-restore-*' -ErrorAction SilentlyContinue).Count
        if ($tempAfter -le $tempBefore) { Ok 'the restore script removed its staging folder' } else { Fail 'the restore script left its staging folder below TEMP' }

        # -StagingDir names a folder that holds a file of someone else: the
        # script works in a new folder below it and deletes only that.
        $theirs = Join-Path $WorkDir 'their-folder'
        New-Item -ItemType Directory -Force -Path $theirs | Out-Null
        [System.IO.File]::WriteAllText((Join-Path $theirs 'keep.txt'), 'not the restore script''s')
        & icacls.exe $theirs /grant 'NT SERVICE\MSSQL$RESTOWB:(OI)(CI)RX' | Out-Null
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $rendered -Repository $repo -PasswordFile $pwFile -Restic $Restic `
            -Instance '.\RESTOWB' -NewName 'RestowCi_other2' -StagingDir $theirs | Out-Host
        $ok = $LASTEXITCODE -eq 0
        $kept = Test-Path -LiteralPath (Join-Path $theirs 'keep.txt')
        $leftDirs = @(Get-ChildItem -Path $theirs -Directory -ErrorAction SilentlyContinue).Count
        if ($ok -and $kept -and $leftDirs -eq 0) { Ok 'with -StagingDir the script deleted only its own folder' } else { Fail ("with -StagingDir: exit ok $ok, the other file kept $kept, folders left $leftDirs") }
    }

    # 5. The flows once more as the runner (sysadmin through Administrators).
    $env:RESTOW_TEST_SQL_INSTANCE = 'SQLEXPRESS'
    $env:RESTIC_BINARY = $Restic
    & go test -count=1 -v -tags 'windowsintegration,sqlintegration' -run TestIntegration ./internal/sqlserver/ | Out-Host
    if ($LASTEXITCODE -eq 0) { Ok 'go test -tags sqlintegration' } else { Fail 'go test -tags sqlintegration' }

    & sc.exe delete RestowSqlCi | Out-Null
    Finish @{ backup = $full; verify = $v; damaged = $vr; restore = $rs }
} finally {
    Pop-Location
}
