# Restow agent: native SQL Server backup (docs/BAREMETAL-WINDOWS.md 5.1).
#
# This script is embedded in the signed agent (internal/sqlserver/embed.go)
# and started by it with Windows PowerShell 5.1:
#   powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <this file>
# It reads one JSON request from stdin, connects to one instance over Shared
# Memory with integrated authentication, runs the fixed T-SQL texts the agent
# sends in request.statements (and nothing else), and writes JSON lines to
# stdout: progress, sqlmessage, then one result or one error line.
# Exit codes: 0 = a result was written, 2 = an error was written, anything
# else = the script crashed.
#
# Rules that a test checks (sqlps_test.go):
#   - CommandText is set in exactly one place, from the -Text of Invoke-Step;
#   - every -Text is a statement of the request, except the restore text,
#     whose MOVE clauses come from New-RestowMoveClause (placeholders only);
#   - names and paths go in only as SqlParameter;
#   - no Invoke-Expression, no script blocks built from text.

# The language mode first: in Constrained Language Mode New-Object for
# SqlClient is not allowed, and the agent has to say why.
if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') {
    Write-Output ('{"type":"error","problem":{"code":"sql_powershell_constrained","step":"language_mode","number":0,"message":"Windows PowerShell runs in ' + [string]$ExecutionContext.SessionState.LanguageMode + ' (WDAC, AppLocker or __PSLockdownPolicy); the SQL Server client cannot be loaded."}}')
    exit 2
}

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$script:Utf8 = New-Object System.Text.UTF8Encoding($false)
$script:Out = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), $script:Utf8)
$script:Out.AutoFlush = $true
$script:Invariant = [System.Globalization.CultureInfo]::InvariantCulture
$script:Step = 'request'
$script:Conn = $null
$script:Timeout = 3600
$script:Collected = New-Object System.Collections.Generic.List[object]
$script:MessageLines = 0
$MaxMessageLines = 200
$MaxMessageChars = 1000

function Write-Line([hashtable]$Object) {
    $script:Out.WriteLine((ConvertTo-Json -InputObject $Object -Compress -Depth 8))
}

function Limit-Text([string]$Text) {
    if ($null -eq $Text) { return '' }
    $t = $Text -replace '[\x00-\x1f]', ' '
    if ($t.Length -gt $MaxMessageChars) { $t = $t.Substring(0, $MaxMessageChars) }
    return $t
}

function New-Problem([string]$Code, [string]$Step, [int]$Number, [string]$Message) {
    return @{ code = $Code; step = $Step; number = $Number; message = (Limit-Text $Message) }
}

function Exit-Problem([hashtable]$Problem) {
    Write-Line @{ type = 'error'; problem = $Problem }
    if ($null -ne $script:Conn) { try { $script:Conn.Close() } catch { } }
    exit 2
}

function Exit-Result([hashtable]$Data) {
    Write-Line @{ type = 'result'; data = $Data }
    if ($null -ne $script:Conn) { try { $script:Conn.Close() } catch { } }
    exit 0
}

trap {
    $msg = [string]$_.Exception.Message
    Write-Line @{ type = 'error'; problem = (New-Problem 'sql_script_failed' $script:Step 0 ('The SQL Server script stopped: ' + $msg)) }
    exit 3
}

# ---- values ----------------------------------------------------------------

function Get-Col([hashtable]$Row, [string]$Name) {
    if ($null -eq $Row -or -not $Row.ContainsKey($Name)) { return $null }
    return $Row[$Name]
}
# Get-Param reads an optional field of the request (Set-StrictMode refuses
# a missing property).
function Get-Param($Object, [string]$Name) {
    if ($null -eq $Object) { return $null }
    $prop = $Object.PSObject.Properties[$Name]
    if ($null -eq $prop) { return $null }
    return $prop.Value
}
function To-Str($Value) { if ($null -eq $Value) { return '' }; return [string]$Value }
function To-Long($Value) { if ($null -eq $Value) { return [long]0 }; return [long]$Value }
function To-Int($Value) { if ($null -eq $Value) { return 0 }; return [int]$Value }
function To-Bool($Value) { if ($null -eq $Value) { return $false }; return [bool]$Value }
function To-Lsn($Value) {
    if ($null -eq $Value) { return '' }
    return ([decimal]$Value).ToString('0', $script:Invariant)
}
function To-Guid($Value) { if ($null -eq $Value) { return '' }; return ([string]$Value).ToLowerInvariant() }
function To-LocalTime($Value) {
    if ($null -eq $Value) { return '' }
    return ([datetime]$Value).ToString('yyyy-MM-ddTHH:mm:ss', $script:Invariant)
}

# ---- statements ------------------------------------------------------------

# New-RestowMoveClause builds the MOVE clauses of a restore from an integer
# loop: placeholders only (MOVE @l0 TO @p0, ...). It is the only text the
# script assembles for CommandText.
function New-RestowMoveClause([int]$Count) {
    $parts = New-Object System.Collections.Generic.List[string]
    for ($i = 0; $i -lt $Count; $i++) {
        $parts.Add('MOVE @l' + $i + ' TO @p' + $i)
    }
    return [string]::Join(', ', $parts.ToArray())
}

function Get-SqlException($Exception) {
    $e = $Exception
    while ($null -ne $e) {
        if ($e -is [System.Data.SqlClient.SqlException]) { return $e }
        $e = $e.InnerException
    }
    return $null
}

# Invoke-Step runs one fixed statement with its parameters. It returns
# @{ ok; rows; errors; timedOut }: the errors are those SQL Server raised
# (InfoMessage with class 11 or more, FireInfoMessageEventOnUserErrors, and
# a thrown SqlException), the rows those of every result set.
function Invoke-Step {
    param([string]$Step, [string]$Text, [hashtable]$Params, [switch]$Rows)
    $script:Step = $Step
    $script:Collected.Clear()
    $rowList = New-Object System.Collections.Generic.List[object]
    $errors = New-Object System.Collections.Generic.List[object]
    $timedOut = $false
    $cmd = $script:Conn.CreateCommand()
    try {
        $cmd.CommandText = $Text
        $cmd.CommandTimeout = $script:Timeout
        if ($null -ne $Params) {
            foreach ($key in $Params.Keys) {
                $p = $cmd.Parameters.Add([string]$key, [System.Data.SqlDbType]::NVarChar, 4000)
                $p.Value = [string]$Params[$key]
            }
        }
        try {
            if ($Rows) {
                $reader = $cmd.ExecuteReader()
                try {
                    do {
                        while ($reader.Read()) {
                            $row = @{}
                            for ($i = 0; $i -lt $reader.FieldCount; $i++) {
                                $v = $reader.GetValue($i)
                                if ($v -is [System.DBNull]) { $v = $null }
                                $row[$reader.GetName($i)] = $v
                            }
                            $rowList.Add($row)
                        }
                    } while ($reader.NextResult())
                } finally {
                    $reader.Close()
                }
            } else {
                [void]$cmd.ExecuteNonQuery()
            }
        } catch {
            $sqlEx = Get-SqlException $_.Exception
            if ($null -eq $sqlEx) { throw }
            foreach ($err in $sqlEx.Errors) {
                if ($err.Number -eq -2) { $timedOut = $true }
                $errors.Add(@{ number = [int]$err.Number; severity = [int]$err.Class; state = [int]$err.State; message = (Limit-Text $err.Message) })
            }
        }
    } finally {
        $cmd.Dispose()
    }
    foreach ($m in $script:Collected) {
        if ($m.severity -ge 11) {
            $dup = $false
            foreach ($e in $errors) { if ($e.number -eq $m.number -and $e.message -eq $m.message) { $dup = $true } }
            if (-not $dup) { $errors.Add($m) }
        }
    }
    return @{ ok = ($errors.Count -eq 0); rows = $rowList; errors = $errors; timedOut = $timedOut }
}

# The problem of a failed step: the first specific error (3013 and 3014 only
# say that the statement ended), all messages joined.
function Get-StepProblem([hashtable]$Result, [string]$Code, [string]$Step) {
    $number = 0
    $texts = New-Object System.Collections.Generic.List[string]
    foreach ($e in $Result.errors) {
        if ($number -eq 0 -and $e.number -ne 3013) { $number = [int]$e.number }
        $texts.Add([string]$e.message + ' (' + [string]$e.number + ')')
    }
    if ($number -eq 0 -and $Result.errors.Count -gt 0) { $number = [int]$Result.errors[0].number }
    $text = [string]::Join(' ', $texts.ToArray())
    if ($text -eq '') { $text = 'The step ' + $Step + ' returned no result.' }
    return New-Problem $Code $Step $number $text
}

function Get-ErrorArray([hashtable]$Result) {
    $list = New-Object System.Collections.Generic.List[object]
    foreach ($e in $Result.errors) {
        $list.Add(@{ number = [int]$e.number; severity = [int]$e.severity; state = [int]$e.state; message = [string]$e.message })
    }
    return , $list.ToArray()
}

# ---- connection ------------------------------------------------------------

function Open-Connection([string]$DataSource) {
    $script:Step = 'connect'
    $b = New-Object System.Data.SqlClient.SqlConnectionStringBuilder
    $b['Data Source'] = $DataSource
    $b['Integrated Security'] = $true
    $b['Initial Catalog'] = 'master'
    $b['Pooling'] = $false
    $b['Connect Timeout'] = 30
    $b['Application Name'] = 'Restow agent'
    $conn = New-Object System.Data.SqlClient.SqlConnection($b.ConnectionString)
    $conn.FireInfoMessageEventOnUserErrors = $true
    $handler = [System.Data.SqlClient.SqlInfoMessageEventHandler] {
        param($sender, $e)
        foreach ($err in $e.Errors) {
            $number = [int]$err.Number
            if ($number -eq 3211 -and [string]$err.Message -match '^\s*(\d+)') {
                Write-Line @{ type = 'progress'; step = $script:Step; percent = [int]$Matches[1] }
                continue
            }
            $m = @{ number = $number; severity = [int]$err.Class; state = [int]$err.State; message = (Limit-Text $err.Message) }
            $script:Collected.Add($m)
            if ($script:MessageLines -lt $MaxMessageLines) {
                $script:MessageLines++
                Write-Line @{ type = 'sqlmessage'; step = $script:Step; number = $number; class = [int]$err.Class; state = [int]$err.State; message = $m.message }
            }
        }
    }
    $conn.add_InfoMessage($handler)
    try {
        $conn.Open()
    } catch {
        $sqlEx = Get-SqlException $_.Exception
        if ($null -eq $sqlEx) {
            Exit-Problem (New-Problem 'sql_instance_unreachable' 'connect' 0 ([string]$_.Exception.Message))
        }
        $number = [int]$sqlEx.Number
        $code = 'sql_instance_unreachable'
        if ($number -eq 18456 -or $number -eq 18452) { $code = 'sql_login_missing' }
        elseif ($number -eq 4060 -or $number -eq 916) { $code = 'sql_permission_missing' }
        Exit-Problem (New-Problem $code 'connect' $number ([string]$sqlEx.Message))
    }
    $script:Conn = $conn
}

# ---- operations ------------------------------------------------------------

function Get-Defaults {
    $d = Invoke-Step -Step 'inventory' -Text $req.statements.InstanceDefaults -Rows
    if (-not $d.ok -or $d.rows.Count -eq 0) { Exit-Problem (Get-StepProblem $d 'sql_script_failed' 'inventory') }
    $row = $d.rows[0]
    return @{
        dataPath = (To-Str (Get-Col $row 'dataPath'))
        logPath  = (To-Str (Get-Col $row 'logPath'))
        tz       = (To-Int (Get-Col $row 'tzOffsetMinutes'))
    }
}

function Get-FileList([string]$Path) {
    $f = Invoke-Step -Step 'filelistonly' -Text $req.statements.FileListOnly -Params @{ '@path' = $Path } -Rows
    if (-not $f.ok) { return @{ ok = $false; result = $f; files = @() } }
    $files = New-Object System.Collections.Generic.List[object]
    foreach ($row in $f.rows) {
        $files.Add(@{
            logicalName  = (To-Str (Get-Col $row 'LogicalName'))
            type         = (To-Str (Get-Col $row 'Type')).Trim()
            fileGroup    = (To-Str (Get-Col $row 'FileGroupName'))
            fileId       = (To-Long (Get-Col $row 'FileID'))
            sizeBytes    = (To-Long (Get-Col $row 'Size'))
            physicalName = (To-Str (Get-Col $row 'PhysicalName'))
        })
    }
    return @{ ok = $true; result = $f; files = $files.ToArray() }
}

function Test-Database([string]$Name) {
    $x = Invoke-Step -Step 'exists' -Text $req.statements.DbExists -Params @{ '@db' = $Name } -Rows
    if (-not $x.ok -or $x.rows.Count -eq 0) { Exit-Problem (Get-StepProblem $x 'sql_script_failed' 'exists') }
    return (To-Bool (Get-Col $x.rows[0] 'present'))
}

function Invoke-Checkdb([string]$Name, [bool]$PhysicalOnly) {
    $started = [DateTime]::UtcNow
    if ($PhysicalOnly) {
        $c = Invoke-Step -Step 'checkdb' -Text $req.statements.CheckDBPhysicalOnly -Params @{ '@db' = $Name } -Rows
    } else {
        $c = Invoke-Step -Step 'checkdb' -Text $req.statements.CheckDB -Params @{ '@db' = $Name } -Rows
    }
    $ms = [long]([DateTime]::UtcNow - $started).TotalMilliseconds
    $found = New-Object System.Collections.Generic.List[object]
    foreach ($row in $c.rows) {
        $level = To-Int (Get-Col $row 'Level')
        if ($level -lt 11) { continue }
        if ($found.Count -ge 100) { break }
        $e = @{
            number  = (To-Int (Get-Col $row 'Error'))
            level   = $level
            state   = (To-Int (Get-Col $row 'State'))
            message = (Limit-Text (To-Str (Get-Col $row 'MessageText')))
        }
        $repair = To-Str (Get-Col $row 'RepairLevel')
        if ($repair -ne '') { $e.repairLevel = $repair }
        $oid = To-Long (Get-Col $row 'ObjectId')
        if ($oid -ne 0) { $e.objectId = $oid }
        $iid = To-Long (Get-Col $row 'IndexId')
        if ($iid -ne 0) { $e.indexId = $iid }
        $found.Add($e)
    }
    $raised = Get-ErrorArray $c
    if ($c.timedOut) {
        return @{ checkdb = @{ ran = $false; physicalOnly = $PhysicalOnly; errors = @(); durationMs = $ms }; raised = $raised; timedOut = $true; problem = (Get-StepProblem $c 'sql_verify_timeout' 'checkdb') }
    }
    # The script does not judge: the rows and the raised errors (CHECKDB
    # could not run, it stopped, or it reported damage as messages) go to the
    # agent, whose JudgeCheckdb (checkdb.go) decides what they prove.
    if (-not $c.ok -and $found.Count -eq 0) {
        return @{ checkdb = @{ ran = $false; physicalOnly = $PhysicalOnly; errors = @(); durationMs = $ms }; raised = $raised; timedOut = $false; problem = (Get-StepProblem $c 'sql_script_failed' 'checkdb') }
    }
    return @{ checkdb = @{ ran = $true; physicalOnly = $PhysicalOnly; errors = $found.ToArray(); durationMs = $ms }; raised = $raised; timedOut = $false; problem = $null }
}

# Test-ErrorNumber reports whether a step raised one of the numbers.
function Test-ErrorNumber([hashtable]$Result, [int[]]$Numbers) {
    foreach ($e in $Result.errors) { if ($Numbers -contains [int]$e.number) { return $true } }
    return $false
}

function Get-MoveParams($Moves) {
    $prm = @{}
    $i = 0
    foreach ($m in $Moves) {
        $prm['@l' + $i] = [string]$m.logicalName
        $prm['@p' + $i] = [string]$m.physicalName
        $i++
    }
    return @{ params = $prm; count = $i }
}

function Op-Inventory {
    $i = Invoke-Step -Step 'inventory' -Text $req.statements.InventoryInstance -Rows
    if (-not $i.ok -or $i.rows.Count -eq 0) { Exit-Problem (Get-StepProblem $i 'sql_script_failed' 'inventory') }
    $inst = $i.rows[0]
    $defaults = Get-Defaults
    $l = Invoke-Step -Step 'login' -Text $req.statements.LoginCheck -Rows
    if (-not $l.ok -or $l.rows.Count -eq 0) { Exit-Problem (Get-StepProblem $l 'sql_permission_missing' 'login') }
    $login = $l.rows[0]
    $d = Invoke-Step -Step 'inventory' -Text $req.statements.InventoryDatabases -Rows
    if (-not $d.ok) { Exit-Problem (Get-StepProblem $d 'sql_permission_missing' 'inventory') }

    $warnings = New-Object System.Collections.Generic.List[object]
    $files = @{}
    $sizes = @{}
    $f = Invoke-Step -Step 'inventory' -Text $req.statements.InventoryFiles -Rows
    if ($f.ok) {
        foreach ($row in $f.rows) {
            $id = To-Int (Get-Col $row 'databaseId')
            if (-not $files.ContainsKey($id)) { $files[$id] = New-Object System.Collections.Generic.List[object]; $sizes[$id] = [long]0 }
            $files[$id].Add(@{ type = (To-Str (Get-Col $row 'type')); physicalName = (To-Str (Get-Col $row 'physicalName')) })
            $sizes[$id] = $sizes[$id] + (To-Long (Get-Col $row 'sizeBytes'))
        }
    } else { $warnings.Add((Get-StepProblem $f 'sql_permission_missing' 'inventory')) }
    $logUsed = @{}
    $u = Invoke-Step -Step 'inventory' -Text $req.statements.InventoryLogUsage -Rows
    if ($u.ok) {
        foreach ($row in $u.rows) { $logUsed[(To-Str (Get-Col $row 'name'))] = (To-Long (Get-Col $row 'logUsedBytes')) }
    } else { $warnings.Add((Get-StepProblem $u 'sql_permission_missing' 'inventory')) }
    $roles = @{}
    $r = Invoke-Step -Step 'inventory' -Text $req.statements.InventoryReplicaRoles -Rows
    if ($r.ok) {
        foreach ($row in $r.rows) { $roles[(To-Int (Get-Col $row 'databaseId'))] = (To-Str (Get-Col $row 'role')) }
    } else { $warnings.Add((Get-StepProblem $r 'sql_permission_missing' 'inventory')) }
    $lastFull = @{}
    $lastLog = @{}
    $h = Invoke-Step -Step 'inventory' -Text $req.statements.InventoryBackupHistory -Rows
    if ($h.ok) {
        foreach ($row in $h.rows) {
            $n = To-Str (Get-Col $row 'name')
            if ((To-Str (Get-Col $row 'type')) -eq 'D') { $lastFull[$n] = (To-Str (Get-Col $row 'lastAt')) } else { $lastLog[$n] = (To-Str (Get-Col $row 'lastAt')) }
        }
    } else { $warnings.Add((Get-StepProblem $h 'sql_permission_missing' 'inventory')) }

    $dbs = New-Object System.Collections.Generic.List[object]
    foreach ($row in $d.rows) {
        $id = To-Int (Get-Col $row 'databaseId')
        $name = To-Str (Get-Col $row 'name')
        $state = To-Str (Get-Col $row 'state')
        $snapshot = To-Bool (Get-Col $row 'isSnapshot')
        $used = [long]-1
        if ($state -eq 'ONLINE' -and -not $snapshot -and $name -ne 'tempdb') {
            $p = Invoke-Step -Step 'inventory' -Text $req.statements.UsedPages -Params @{ '@db' = $name } -Rows
            if ($p.ok -and $p.rows.Count -gt 0) { $used = To-Long (Get-Col $p.rows[0] 'usedBytes') }
        }
        $fileArr = @()
        if ($files.ContainsKey($id)) { $fileArr = $files[$id].ToArray() }
        $size = [long]0
        if ($sizes.ContainsKey($id)) { $size = $sizes[$id] }
        $lu = [long]-1
        if ($logUsed.ContainsKey($name)) { $lu = $logUsed[$name] }
        $role = ''
        if ($roles.ContainsKey($id)) { $role = $roles[$id] }
        $lf = ''
        if ($lastFull.ContainsKey($name)) { $lf = $lastFull[$name] }
        $ll = ''
        if ($lastLog.ContainsKey($name)) { $ll = $lastLog[$name] }
        $dbs.Add(@{
            name = $name; databaseId = $id; system = (To-Bool (Get-Col $row 'isSystem'))
            familyGuid = (To-Guid (Get-Col $row 'familyGuid')); databaseGuid = (To-Guid (Get-Col $row 'databaseGuid'))
            state = $state; recoveryModel = (To-Str (Get-Col $row 'recoveryModel'))
            readOnly = (To-Bool (Get-Col $row 'readOnly')); encrypted = (To-Bool (Get-Col $row 'encrypted'))
            snapshot = $snapshot; sizeBytes = $size; usedBytes = $used; logUsedBytes = $lu
            canBackup = (To-Bool (Get-Col $row 'canBackup')); replicaRole = $role
            lastFullBackup = $lf; lastLogBackup = $ll; files = $fileArr
        })
    }
    Exit-Result @{
        languageMode = [string]$ExecutionContext.SessionState.LanguageMode
        version = (To-Str (Get-Col $inst 'version')); edition = (To-Str (Get-Col $inst 'edition'))
        engineEdition = (To-Int (Get-Col $inst 'engineEdition'))
        clustered = (To-Bool (Get-Col $inst 'clustered')); hadr = (To-Bool (Get-Col $inst 'hadr'))
        backupCompressionDefault = (To-Bool (Get-Col $inst 'compressionDefault'))
        defaultDataPath = $defaults.dataPath; defaultLogPath = $defaults.logPath; tzOffsetMinutes = $defaults.tz
        login = @{ name = (To-Str (Get-Col $login 'loginName')); sysadmin = (To-Bool (Get-Col $login 'sysadmin')); canCreateDatabase = (To-Bool (Get-Col $login 'canCreateDatabase')) }
        databases = $dbs.ToArray()
        warnings = $warnings.ToArray()
    }
}

function Op-Backup {
    $p = $req.params
    $b = Invoke-Step -Step 'backup' -Text $req.statements.BackupFullCopyOnly -Params @{ '@db' = [string]$p.database; '@path' = [string]$p.path }
    if (-not $b.ok) { Exit-Problem (Get-StepProblem $b 'sql_backup_failed' 'backup') }
    $h = Invoke-Step -Step 'headeronly' -Text $req.statements.HeaderOnly -Params @{ '@path' = [string]$p.path } -Rows
    if (-not $h.ok -or $h.rows.Count -eq 0) { Exit-Problem (Get-StepProblem $h 'sql_backup_failed' 'headeronly') }
    $row = $h.rows[0]
    $fl = Get-FileList ([string]$p.path)
    if (-not $fl.ok) { Exit-Problem (Get-StepProblem $fl.result 'sql_backup_failed' 'filelistonly') }
    $defaults = Get-Defaults
    Exit-Result @{
        header = @{
            backupType = (To-Int (Get-Col $row 'BackupType')); databaseName = (To-Str (Get-Col $row 'DatabaseName'))
            familyGuid = (To-Guid (Get-Col $row 'FamilyGUID'))
            compressed = (To-Bool (Get-Col $row 'Compressed')); copyOnly = (To-Bool (Get-Col $row 'IsCopyOnly'))
            hasChecksums = (To-Bool (Get-Col $row 'HasBackupChecksums'))
            firstLsn = (To-Lsn (Get-Col $row 'FirstLSN')); lastLsn = (To-Lsn (Get-Col $row 'LastLSN'))
            checkpointLsn = (To-Lsn (Get-Col $row 'CheckpointLSN')); databaseBackupLsn = (To-Lsn (Get-Col $row 'DatabaseBackupLSN'))
            firstRecoveryForkGuid = (To-Guid (Get-Col $row 'FirstRecoveryForkID')); lastRecoveryForkGuid = (To-Guid (Get-Col $row 'RecoveryForkID'))
            beginsLogChain = (To-Bool (Get-Col $row 'BeginsLogChain')); hasBulkLoggedData = (To-Bool (Get-Col $row 'HasBulkLoggedData'))
            backupStart = (To-LocalTime (Get-Col $row 'BackupStartDate')); backupFinish = (To-LocalTime (Get-Col $row 'BackupFinishDate'))
            tzOffsetMinutes = $defaults.tz
        }
        fileList = $fl.files
    }
}

function Op-FileList {
    $p = $req.params
    $h = Invoke-Step -Step 'headeronly' -Text $req.statements.HeaderOnly -Params @{ '@path' = [string]$p.path } -Rows
    if (-not $h.ok -or $h.rows.Count -eq 0) { Exit-Problem (Get-StepProblem $h 'sql_restore_failed' 'headeronly') }
    $fl = Get-FileList ([string]$p.path)
    if (-not $fl.ok) { Exit-Problem (Get-StepProblem $fl.result 'sql_restore_failed' 'filelistonly') }
    $defaults = Get-Defaults
    $taken = $false
    $check = To-Str (Get-Param $p 'checkName')
    if ($check -ne '') { $taken = Test-Database $check }
    Exit-Result @{ fileList = $fl.files; lastLsn = (To-Lsn (Get-Col $h.rows[0] 'LastLSN')); defaultDataPath = $defaults.dataPath; defaultLogPath = $defaults.logPath; nameTaken = $taken }
}

function Op-Restore {
    $p = $req.params
    $name = [string]$p.newName
    if (Test-Database $name) { Exit-Problem (New-Problem 'sql_restore_name_taken' 'exists' 0 ('A database named ' + $name + ' exists already.')) }
    $mv = Get-MoveParams $p.moves
    if ($mv.count -eq 0) { Exit-Problem (New-Problem 'sql_script_failed' 'request' 0 'The restore has no MOVE targets.') }
    $prm = $mv.params
    $prm['@new'] = $name
    $prm['@path'] = [string]$p.path
    $restoreText = $req.statements.RestoreNewName.Replace('{{MOVES}}', (New-RestowMoveClause $mv.count))
    $r = Invoke-Step -Step 'restore' -Text $restoreText -Params $prm
    if (-not $r.ok) {
        # 50003: the batch found the name taken before the RESTORE; 1801 and
        # 3154: SQL Server found a database of that name. It is not ours and
        # is never touched.
        if (Test-ErrorNumber $r @(50003, 1801, 3154)) {
            Exit-Problem (New-Problem 'sql_restore_name_taken' 'restore' 0 ('A database named ' + $name + ' exists already; it was not touched.'))
        }
        # A RESTORE that failed halfway leaves the new name in RESTORING;
        # DropRestoring drops it in that state only, never an ONLINE database.
        $cleaned = $false
        $left = ''
        $x = Invoke-Step -Step 'drop' -Text $req.statements.DropRestoring -Params @{ '@db' = $name } -Rows
        if ($x.ok -and $x.rows.Count -gt 0) {
            $cleaned = To-Bool (Get-Col $x.rows[0] 'dropped')
            if (-not $cleaned) { $left = To-Str (Get-Col $x.rows[0] 'state') }
        } else {
            $left = 'UNKNOWN'
        }
        Exit-Result @{ restore = @{ ok = $false; errors = (Get-ErrorArray $r) }; checkdb = $null; cleanedUp = $cleaned; leftover = $left }
    }
    $result = @{ restore = @{ ok = $true; errors = @() }; checkdb = $null; cleanedUp = $false }
    if ([bool]$p.checkdb) {
        $c = Invoke-Checkdb $name ([bool]$p.physicalOnly)
        $result.checkdb = $c.checkdb
        $result.checkdbRaised = $c.raised
        if ($null -ne $c.problem) { $result.checkdbProblem = $c.problem }
    }
    Exit-Result $result
}

function Op-Verify {
    $p = $req.params
    $name = [string]$p.verifyName
    if ($name.IndexOf('__restow_verify_') -lt 0) { Exit-Problem (New-Problem 'sql_script_failed' 'request' 0 'The check copy has no check name.') }
    if (Test-Database $name) { Exit-Problem (New-Problem 'sql_restore_name_taken' 'exists' 0 ('A database named ' + $name + ' exists already.')) }
    $mv = Get-MoveParams $p.moves
    if ($mv.count -eq 0) { Exit-Problem (New-Problem 'sql_script_failed' 'request' 0 'The check has no MOVE targets.') }
    $prm = $mv.params
    $prm['@new'] = $name
    $prm['@path'] = [string]$p.path
    $restoreText = $req.statements.RestoreNewName.Replace('{{MOVES}}', (New-RestowMoveClause $mv.count))
    $r = Invoke-Step -Step 'restore' -Text $restoreText -Params $prm
    if (-not $r.ok -and (Test-ErrorNumber $r @(50003, 1801, 3154))) {
        Exit-Problem (New-Problem 'sql_restore_name_taken' 'restore' 0 ('A database named ' + $name + ' exists already.'))
    }
    $result = @{ restore = @{ ok = $r.ok; errors = (Get-ErrorArray $r) }; checkdb = $null; newBroker = $false; dropped = $false }
    if ($r.ok) {
        $nb = Invoke-Step -Step 'new_broker' -Text $req.statements.NewBroker -Params @{ '@db' = $name }
        $result.newBroker = $nb.ok
        if ($nb.ok) {
            $c = Invoke-Checkdb $name ([bool]$p.physicalOnly)
            $result.checkdb = $c.checkdb
            $result.checkdbRaised = $c.raised
            if ($null -ne $c.problem) { $result.checkdbProblem = $c.problem }
        } else {
            $result.newBrokerProblem = (Get-StepProblem $nb 'sql_script_failed' 'new_broker')
        }
    }
    if (Test-Database $name) {
        $x = Invoke-Step -Step 'drop' -Text $req.statements.DropVerifyCopy -Params @{ '@db' = $name }
        $result.dropped = $x.ok
        if (-not $x.ok) { $result.dropError = (Get-StepProblem $x 'sql_script_failed' 'drop') }
    } else {
        $result.dropped = $true
    }
    Exit-Result $result
}

function Op-Drop {
    $dropped = New-Object System.Collections.Generic.List[string]
    $failed = New-Object System.Collections.Generic.List[object]
    foreach ($n in @(Get-Param $req.params 'names')) {
        $name = [string]$n
        $x = Invoke-Step -Step 'drop' -Text $req.statements.DropVerifyCopy -Params @{ '@db' = $name }
        if ($x.ok) { $dropped.Add($name) } else { $failed.Add(@{ name = $name; problem = (Get-StepProblem $x 'sql_script_failed' 'drop') }) }
    }
    Exit-Result @{ dropped = $dropped.ToArray(); failed = $failed.ToArray() }
}

function Op-DropRestoring {
    $name = To-Str (Get-Param $req.params 'name')
    if ($name -eq '') { Exit-Problem (New-Problem 'sql_script_failed' 'request' 0 'The cleanup has no database name.') }
    $x = Invoke-Step -Step 'drop' -Text $req.statements.DropRestoring -Params @{ '@db' = $name } -Rows
    if (-not $x.ok -or $x.rows.Count -eq 0) { Exit-Problem (Get-StepProblem $x 'sql_script_failed' 'drop') }
    Exit-Result @{ state = (To-Str (Get-Col $x.rows[0] 'state')); dropped = (To-Bool (Get-Col $x.rows[0] 'dropped')) }
}

# ---- main ------------------------------------------------------------------

$stdin = [Console]::OpenStandardInput()
$buffer = New-Object System.IO.MemoryStream
$stdin.CopyTo($buffer)
if ($buffer.Length -gt 4MB) { Exit-Problem (New-Problem 'sql_script_failed' 'request' 0 'The request is too large.') }
$req = ConvertFrom-Json -InputObject ($script:Utf8.GetString($buffer.ToArray()))
if ([int]$req.protocol -ne 1) { Exit-Problem (New-Problem 'sql_script_failed' 'request' 0 ('Unknown protocol ' + [string]$req.protocol + '.')) }
if ([int]$req.stepTimeoutSeconds -gt 0) { $script:Timeout = [int]$req.stepTimeoutSeconds }

Open-Connection ([string]$req.dataSource)
switch ([string]$req.op) {
    'inventory' { Op-Inventory }
    'backup' { Op-Backup }
    'filelist' { Op-FileList }
    'restore' { Op-Restore }
    'verify' { Op-Verify }
    'drop' { Op-Drop }
    'droprestoring' { Op-DropRestoring }
    default { Exit-Problem (New-Problem 'sql_script_failed' 'request' 0 ('Unknown operation ' + [string]$req.op + '.')) }
}
Exit-Problem (New-Problem 'sql_script_failed' 'script' 0 'The operation ended without a result.')
