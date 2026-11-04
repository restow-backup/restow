# Tests of the Windows installer agent/install/windows.ps1 (docs/WINDOWS-AGENT.md,
# sections 14.3 and 22.1). Runs in the CI job agent-windows from the agent folder:
#
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/test-install-windows.ps1
#
# 1. The installer parses and is plain ASCII.
# 2. Its Ed25519 check agrees with Go's crypto/ed25519 on the RFC 8032 vectors,
#    the committed vectors (install/testdata/ed25519-vectors.txt) and freshly
#    generated ones (go run ./scripts/sigdiff; the differential test).
# 3. Its SSHSIG check accepts the good fixture and a signature made by
#    ssh-keygen (internal/release/testdata) and refuses every bad fixture.
# 3b. -Proxy reaches the agent's own commands (enroll, status) and the
#    session's environment is restored afterwards.
# 3c. The installer enables TLS 1.2 itself (the -File form starts without it).
# 3d. The restart of a 32-bit host: stderr of the 64-bit child is no error of
#    the parent, the session's environment is restored, and a token file
#    written by a 32-bit program to System32 is found below SysWOW64.
# 4. A full installation below a prefix (RESTOW_INSTALL_ROOT, no service)
#    against the fake instance, a second run (repair), a pinned key that does
#    not match, a tampered release (nothing installed), -Proxy with
#    credentials, and -Uninstall.
# 4b. The same into the real C:\Program Files\Restow (no service): the folders
#    and binaries are owned by Administrators whatever owner the runner gives
#    what an administrator creates.
#
# Options: -Vectors <n> generated vectors for step 2 (default 300; PowerShell
# needs around a second per vector), -SkipInstall for steps 1 to 3 only.
param(
    [int]$Vectors = 300,
    [switch]$SkipInstall
)
Set-StrictMode -Version 2
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$agentDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$installer = Join-Path $agentDir 'install\windows.ps1'
$failures = New-Object System.Collections.Generic.List[string]
function Fail([string]$Text) { $failures.Add($Text); Write-Host "FAIL: $Text" -ForegroundColor Red }
function Ok([string]$Text) { Write-Host "ok: $Text" }

function ConvertFrom-Hex([string]$Hex) {
    if ($Hex -eq '-') { return , ([byte[]]@()) }
    $out = New-Object byte[] ($Hex.Length / 2)
    for ($i = 0; $i -lt $out.Length; $i++) { $out[$i] = [Convert]::ToByte($Hex.Substring(2 * $i, 2), 16) }
    return , $out
}

# ---- 1. parse and ASCII -------------------------------------------------------
$tokens = $null; $errors = $null
$null = [System.Management.Automation.Language.Parser]::ParseFile($installer, [ref]$tokens, [ref]$errors)
if ($errors.Count -gt 0) { Fail ("windows.ps1 does not parse: " + ($errors | ForEach-Object { $_.ToString() }) -join '; ') } else { Ok 'windows.ps1 parses' }
$raw = [System.IO.File]::ReadAllBytes($installer)
if (@($raw | Where-Object { $_ -gt 127 }).Count -gt 0) { Fail 'windows.ps1 contains non-ASCII bytes' } else { Ok 'windows.ps1 is ASCII' }

# Load the functions without running the installer.
$env:RESTOW_INSTALLER_NO_MAIN = '1'
. $installer
Remove-Item Env:RESTOW_INSTALLER_NO_MAIN

# ---- 2. Ed25519 against crypto/ed25519 ------------------------------------------
function Test-VectorFile([string[]]$Lines, [string]$Label) {
    $n = 0; $bad = 0
    $sw = [Diagnostics.Stopwatch]::StartNew()
    foreach ($line in $Lines) {
        $f = @($line.Trim() -split ' ')
        if ($f.Count -ne 4) { continue }
        $want = $f[3] -eq '1'
        $got = Test-Ed25519Signature -PublicKey (ConvertFrom-Hex $f[0]) -Message (ConvertFrom-Hex $f[1]) -Signature (ConvertFrom-Hex $f[2])
        if (-not ($got -is [bool])) { Fail "$Label line $($n + 1): the check returned $got, not a [bool]" }
        elseif ($got -ne $want) { $bad++; Fail "$Label line $($n + 1): PowerShell says $got, Go says $want ($line)" }
        $n++
    }
    Ok ("{0}: {1} vectors, {2} disagreements, {3:N1} s per vector" -f $Label, $n, $bad, ($sw.Elapsed.TotalSeconds / [Math]::Max(1, $n)))
}
Test-VectorFile ([System.IO.File]::ReadAllLines((Join-Path $agentDir 'install\testdata\ed25519-vectors.txt'))) 'committed vectors'
if ($Vectors -gt 0) {
    Push-Location $agentDir
    try { $generated = & go run ./scripts/sigdiff -n $Vectors } finally { Pop-Location }
    if ($LASTEXITCODE -ne 0) { Fail 'go run ./scripts/sigdiff failed' } else { Test-VectorFile $generated "differential ($Vectors new)" }
}

# ---- 3. SSHSIG ---------------------------------------------------------------------
$fx = Join-Path $agentDir 'install\testdata\sshsig'
$keyLine = (Get-Content (Join-Path $fx 'key.pub') -TotalCount 1)
$msg = [System.IO.File]::ReadAllBytes((Join-Path $fx 'message.txt'))
foreach ($file in Get-ChildItem -Path $fx -Filter '*.sig') {
    $text = [System.IO.File]::ReadAllText($file.FullName)
    $got = Test-ReleaseSignature -Message $msg -SignatureText $text -KeyLine $keyLine
    $want = $file.Name -eq 'good.sig'
    if (-not ($got -is [bool])) { Fail "$($file.Name): not a [bool]" }
    elseif ($got -ne $want) { Fail "$($file.Name): $got, want $want" }
}
Ok 'SSHSIG fixtures'
$rel = Join-Path $agentDir 'internal\release\testdata'
$realKey = Get-Content (Join-Path $rel 'test-key.pub') -TotalCount 1
$realSums = [System.IO.File]::ReadAllBytes((Join-Path $rel 'SHA256SUMS'))
$realSig = [System.IO.File]::ReadAllText((Join-Path $rel 'SHA256SUMS.sig'))
if ((Test-ReleaseSignature -Message $realSums -SignatureText $realSig -KeyLine $realKey) -ne $true) { Fail 'a signature made by ssh-keygen does not verify' } else { Ok 'signature made by ssh-keygen verifies' }
$tampered = [byte[]]($realSums + [byte]10)
if ((Test-ReleaseSignature -Message $tampered -SignatureText $realSig -KeyLine $realKey) -ne $false) { Fail 'a changed SHA256SUMS verifies' }
$releaseKey = (Get-Content (Join-Path $agentDir 'release-signing.pub') | Where-Object { $_ -and -not $_.StartsWith('#') } | Select-Object -First 1)
if ($releaseKey) {
    if ((Test-ReleaseSignature -Message $realSums -SignatureText $realSig -KeyLine $releaseKey) -ne $false) { Fail 'a signature of another key verifies against the release key' }
    Ok ("release key fingerprint " + (Get-ReleaseKeyFingerprint $releaseKey))
}

# ---- 3b. -Proxy reaches the agent's own commands (enroll, status) ----------------
# A stand-in for the agent: this PowerShell, which exits 0 only when it sees the
# proxy in its environment.
$check = "if (`$env:HTTPS_PROXY -ne 'http://proxy.test:3128' -or `$env:HTTP_PROXY -ne 'http://proxy.test:3128' -or `$env:NO_PROXY -ne 'localhost,127.0.0.1,::1') { exit 3 }; exit 0"
$probe = @('-NoProfile', '-NonInteractive', '-EncodedCommand', [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($check)))
$before = @{ HTTPS_PROXY = $env:HTTPS_PROXY; HTTP_PROXY = $env:HTTP_PROXY; NO_PROXY = $env:NO_PROXY }
$env:HTTPS_PROXY = 'http://before.test:1'
try {
    $RestowState.AgentExe = (Get-Process -Id $PID).Path
    $RestowState.EffectiveProxy = 'http://proxy.test:3128'
    $code = Invoke-Agent $probe
    if ($code -ne 0) { Fail "-Proxy did not reach the agent's environment (exit code $code)" } else { Ok '-Proxy reaches the agent''s own commands' }
    if ($env:HTTPS_PROXY -ne 'http://before.test:1' -or $env:HTTP_PROXY -ne $before.HTTP_PROXY -or $env:NO_PROXY -ne $before.NO_PROXY) {
        Fail 'the proxy environment of the session was not restored after the agent command'
    } else { Ok 'proxy environment of the session restored' }
    $RestowState.EffectiveProxy = ''
    $code = Invoke-Agent $probe
    if ($code -ne 3) { Fail "without -Proxy the agent command saw a proxy (exit code $code)" } else { Ok 'without -Proxy the environment stays as it was' }
} finally {
    foreach ($k in $before.Keys) { [Environment]::SetEnvironmentVariable($k, $before[$k], 'Process') }
    $RestowState.AgentExe = $null
    $RestowState.EffectiveProxy = ''
}

# ---- 3c. TLS 1.2 also for -File and the 64-bit relaunch -----------------------------
# A new Windows PowerShell 5.1 starts with SSL 3 and TLS 1.0 where SchUseStrongCrypto
# is not set; only the iex command line enabled TLS 1.2, in the caller's session.
$savedProtocol = [Net.ServicePointManager]::SecurityProtocol
try {
    try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Ssl3 -bor [Net.SecurityProtocolType]::Tls }
    catch { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls }
    $legacy = [Net.ServicePointManager]::SecurityProtocol
    # An invalid -Hooks stops the installer right after its first steps.
    $stopped = ''
    try { Invoke-RestowInstaller -HooksOption 'bogus' -UninstallOption $false -ProxyOption '' -PinOption '' } catch { $stopped = $_.Exception.Message }
    $after = [Net.ServicePointManager]::SecurityProtocol
    if ($stopped -notmatch '-Hooks must be') { Fail "the installer did not stop at the invalid -Hooks: $stopped" }
    if (($after -band [Net.SecurityProtocolType]::Tls12) -eq 0) { Fail "the installer did not enable TLS 1.2 (protocols: $after)" }
    elseif (($after -band $legacy) -ne $legacy) { Fail "enabling TLS 1.2 dropped protocols that were on ($legacy -> $after)" }
    else { Ok "the installer enables TLS 1.2 itself ($legacy -> $after)" }
    $systemDefault = $true
    try { [Net.ServicePointManager]::SecurityProtocol = 0 } catch { $systemDefault = $false }
    if ($systemDefault) {
        Enable-Tls12
        if ([int][Net.ServicePointManager]::SecurityProtocol -ne 0) { Fail 'Enable-Tls12 replaced SystemDefault (the choice of Windows)' } else { Ok 'SystemDefault stays the choice of Windows' }
    }
    if ((Get-DownloadHint 'The underlying connection was closed: An unexpected error occurred on a send.' 'https://x') -notmatch 'TLS 1.2') { Fail 'a TLS failure is not explained' }
    elseif ((Get-DownloadHint 'Unable to connect to the remote server' 'https://x') -match 'TLS') { Fail 'a connection failure is blamed on TLS' }
    else { Ok 'download failures name TLS 1.2 only when TLS failed' }
} finally {
    [Net.ServicePointManager]::SecurityProtocol = $savedProtocol
}

# ---- 3d. the restart of a 32-bit host in 64-bit PowerShell ---------------------------
# Invoke-Relaunch judges only the exit code: a line on stderr of the child is no
# error of the parent, even under 'Stop' (set above), and the session keeps its
# own environment. cmd.exe stands in for the 64-bit PowerShell.
$cmdExe = Join-Path ([Environment]::SystemDirectory) 'cmd.exe'
$env:RESTOW_RELAUNCH_TEST = 'before'
try {
    $code = $null; $thrown = ''
    try { $code = Invoke-Relaunch $cmdExe @('/c', 'echo WARNING: the backup repository is not usable yet 1>&2 & if %RESTOW_RELAUNCH_TEST%==child (exit 0) else (exit 9)') @{ RESTOW_RELAUNCH_TEST = 'child' } }
    catch { $thrown = $_.Exception.Message }
    if ($thrown) { Fail "a stderr line of the 64-bit child ended the parent: $thrown" }
    elseif ($code -ne 0) { Fail "the 64-bit child did not get its environment or its exit code was lost (exit code $code)" }
    elseif ($env:RESTOW_RELAUNCH_TEST -ne 'before') { Fail "the session's environment was not restored after the restart ($env:RESTOW_RELAUNCH_TEST)" }
    else { Ok 'restart in 64-bit PowerShell: stderr is no error, environment restored' }
    $code = Invoke-Relaunch $cmdExe @('/c', 'echo failed 1>&2 & exit 4') @{}
    if ($code -ne 4) { Fail "the exit code of the 64-bit child was lost (got $code, want 4)" } else { Ok 'restart in 64-bit PowerShell keeps the exit code' }
} finally {
    Remove-Item Env:RESTOW_RELAUNCH_TEST -ErrorAction SilentlyContinue
}

# A token file written by a 32-bit program to System32 lies in SysWOW64; the
# 64-bit child gets that path, and a missing file names it. A stand-in Windows
# folder plays both views.
$fakeWin = Join-Path ([IO.Path]::GetTempPath()) ('restow-wow64-test-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
try {
    $null = New-Item -ItemType Directory -Force -Path (Join-Path $fakeWin 'System32\config\systemprofile'), (Join-Path $fakeWin 'SysWOW64\config\systemprofile')
    $inSys32 = Join-Path $fakeWin 'System32\config\systemprofile\restow-enrollment.token'
    $inWow = Join-Path $fakeWin 'SysWOW64\config\systemprofile\restow-enrollment.token'
    Set-Content -LiteralPath $inSys32 -Value 'rset_x' -NoNewline
    # The 32-bit view sees the file at the System32 path: the child gets the SysWOW64 path.
    $got = Get-RelaunchTokenFile $inSys32 $fakeWin
    if ($got -ne $inWow) { Fail "a token file the 32-bit host sees below System32 is not handed on as $inWow (got $got)" } else { Ok 'token file below System32 is handed on as its SysWOW64 path' }
    Remove-Item -LiteralPath $inSys32
    # Not there in the 32-bit view (written through Sysnative): unchanged.
    $got = Get-RelaunchTokenFile $inSys32 $fakeWin
    if ($got -ne $inSys32) { Fail "a token file missing in the 32-bit view was rewritten to $got" } else { Ok 'token file missing in the 32-bit view stays as it is' }
    $viaSysnative = Join-Path $fakeWin 'Sysnative\config\systemprofile\restow-enrollment.token'
    $got = Get-RelaunchTokenFile $viaSysnative $fakeWin
    if ($got -ne $inSys32) { Fail "a Sysnative path is not handed on as the System32 path (got $got)" } else { Ok 'Sysnative path is handed on as the System32 path' }
    $elsewhere = Join-Path $fakeWin 'restow-enrollment.token'
    if ((Get-RelaunchTokenFile $elsewhere $fakeWin) -ne $elsewhere) { Fail 'a token file outside System32 was rewritten' }
    # The 64-bit child: missing below System32, there below SysWOW64.
    Set-Content -LiteralPath $inWow -Value 'rset_x' -NoNewline
    $problem = Get-TokenFileProblem $inSys32 $fakeWin
    if ($problem -notmatch [regex]::Escape("but $inWow does") -or $problem -notmatch 'Sysnative') { Fail "a missing token file does not name its SysWOW64 counterpart: $problem" } else { Ok 'missing token file names its SysWOW64 counterpart' }
    Remove-Item -LiteralPath $inWow
    $problem = Get-TokenFileProblem $inSys32 $fakeWin
    if ($problem -notmatch 'does not exist' -or $problem -match 'SysWOW64') { Fail "a missing token file: $problem" } else { Ok 'missing token file without counterpart' }
    Set-Content -LiteralPath $inSys32 -Value 'rset_x' -NoNewline
    if (Get-TokenFileProblem $inSys32 $fakeWin) { Fail 'an existing token file is reported as a problem' }
} finally {
    Remove-Item -LiteralPath $fakeWin -Recurse -Force -ErrorAction SilentlyContinue
}

# ---- 4. full installation against the fake instance ------------------------------
if (-not $SkipInstall) {
    $work = Join-Path ([IO.Path]::GetTempPath()) ('restow-install-test-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
    $dist = Join-Path $work 'dist'
    $target = Join-Path $dist 'windows-amd64'
    $null = New-Item -ItemType Directory -Force -Path $target
    $version = '0.5.0-test.1'
    Push-Location $agentDir
    try {
        & go build -trimpath -ldflags "-X github.com/restow-backup/restow/agent/internal/buildinfo.Version=$version" -o (Join-Path $target 'restow-agent.exe') ./cmd/restow-agent
        if ($LASTEXITCODE -ne 0) { throw 'go build restow-agent.exe failed' }
        # restic.exe is only hashed by the installer (a second agent build with
        # another version stands in); the enrollment's repository check warns about it.
        & go build -trimpath -ldflags "-X github.com/restow-backup/restow/agent/internal/buildinfo.Version=0.0.0-restic-stand-in" -o (Join-Path $target 'restic.exe') ./cmd/restow-agent
        & go build -o (Join-Path $work 'fakeinstance.exe') ./internal/testutil/cmd/fakeinstance
        if ($LASTEXITCODE -ne 0) { throw 'go build failed' }
        Copy-Item (Join-Path $agentDir 'THIRD_PARTY_NOTICES.txt') $target
        $lines = foreach ($n in @('restow-agent.exe', 'restic.exe', 'THIRD_PARTY_NOTICES.txt')) {
            "$((Get-FileHash (Join-Path $target $n) -Algorithm SHA256).Hash.ToLowerInvariant())  windows-amd64/$n"
        }
        [System.IO.File]::WriteAllText((Join-Path $dist 'SHA256SUMS'), (($lines -join "`n") + "`n"))
        $key = (& go run ./scripts/sigdiff -sign (Join-Path $dist 'SHA256SUMS') | Select-Object -First 1)
        [System.IO.File]::WriteAllText((Join-Path $work 'release-key.pub'), $key + "`n")
    } finally { Pop-Location }

    $info = Join-Path $work 'info'
    $fake = Start-Process -FilePath (Join-Path $work 'fakeinstance.exe') -PassThru -NoNewWindow -RedirectStandardOutput (Join-Path $work 'fake.log') `
        -ArgumentList @('-listen', '127.0.0.1:18080', '-dist', $dist, '-install', (Join-Path $agentDir 'install'), '-version', $version,
        '-release-key', (Join-Path $work 'release-key.pub'), '-info', $info)
    try {
        for ($i = 0; $i -lt 100 -and -not (Test-Path $info); $i++) { Start-Sleep -Milliseconds 200 }
        $url = ((Get-Content $info) | Where-Object { $_ -like 'URL=*' }).Substring(4)
        $root = Join-Path $work 'root'
        $null = New-Item -ItemType Directory -Force -Path $root

        function Invoke-Installer([hashtable]$Env, [string[]]$Arguments) {
            # Windows PowerShell 5.1 turns each stderr line of a native command under 2>&1
            # into an error record; with 'Stop' (set above) the first one would end the test
            # before the exit code and the output are read.
            $ErrorActionPreference = 'Continue'
            $script = Join-Path $work 'windows.ps1'
            Invoke-WebRequest -UseBasicParsing -Uri "$url/install/windows.ps1" -OutFile $script
            $old = @{}
            $base = @{ RESTOW_INSTALL_ROOT = $root; RESTOW_SKIP_SERVICE = '1'; RESTOW_ALLOW_INSECURE_HTTP = '1';
                RESTOW_AGENT_DIR = (Join-Path $root 'ProgramData\Restow') }
            foreach ($k in $Env.Keys) { $base[$k] = $Env[$k] }
            foreach ($k in $base.Keys) { $old[$k] = [Environment]::GetEnvironmentVariable($k); [Environment]::SetEnvironmentVariable($k, $base[$k]) }
            try {
                $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $script @Arguments 2>&1 | Out-String
                return @{ Code = $LASTEXITCODE; Out = $out }
            } finally {
                foreach ($k in $old.Keys) { [Environment]::SetEnvironmentVariable($k, $old[$k]) }
            }
        }
        $agentExe = Join-Path $root 'Program Files\Restow\bin\restow-agent.exe'
        $token = (Invoke-WebRequest -UseBasicParsing -Method Post -Uri "$url/test/token").Content

        $served = (Invoke-WebRequest -UseBasicParsing -Uri "$url/install/windows.ps1").Content
        if ($served -notmatch [regex]::Escape("`$RestowInstanceUrl = '$url'") -or $served -match "= '__RESTOW_") { Fail 'the served script still has placeholders' } else { Ok 'served script filled in' }

        # A pinned key that does not match: nothing installed.
        $r = Invoke-Installer @{ RESTOW_TOKEN = $token; RESTOW_RELEASE_KEY_FINGERPRINT = 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' } @()
        if ($r.Code -eq 0 -or (Test-Path $agentExe)) { Fail "a wrong pin installed something: $($r.Out)" } else { Ok 'wrong pin refused, nothing installed' }

        # -Proxy with credentials.
        $r = Invoke-Installer @{ RESTOW_TOKEN = $token } @('-Proxy', 'http://user:secret@proxy:3128')
        if ($r.Code -eq 0 -or (Test-Path $agentExe)) { Fail '-Proxy with credentials was accepted' } else { Ok '-Proxy with credentials refused' }

        # The real installation, with the matching pin.
        $fp = Get-ReleaseKeyFingerprint (Get-Content (Join-Path $work 'release-key.pub') -TotalCount 1)
        $tokenFile = Join-Path $work 'token.txt'
        Set-Content -Path $tokenFile -Value $token -NoNewline
        $r = Invoke-Installer @{ RESTOW_TOKEN_FILE = $tokenFile; RESTOW_RELEASE_KEY_FINGERPRINT = $fp } @()
        if ($r.Code -ne 0) { Fail "installation failed: $($r.Out)" }
        elseif ($r.Out -notmatch [regex]::Escape("signature: OK (release key $fp)")) { Fail "no signature line: $($r.Out)" }
        elseif (-not (Test-Path $agentExe)) { Fail 'restow-agent.exe missing after the installation' }
        elseif (Test-Path $tokenFile) { Fail 'the token file was not deleted after the enrollment' }
        elseif (@(Get-ChildItem (Join-Path $root 'Program Files\Restow') -Force -Filter '.stage-*').Count -gt 0) { Fail 'the staging folder was left behind' }
        else { Ok 'installation with token file and pin' }

        # The installed files have the permissions of their folder, not the
        # staging folder's (a move on the same volume keeps the DACL).
        $binDir = Join-Path $root 'Program Files\Restow\bin'
        # CREATOR OWNER turns into the owner on the file, so it is left out.
        $folderIds = @((Get-Acl $binDir).Access | Where-Object { ($_.InheritanceFlags -band [System.Security.AccessControl.InheritanceFlags]::ObjectInherit) -ne 0 } |
            ForEach-Object { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value } | Where-Object { $_ -ne 'S-1-3-0' } | Sort-Object -Unique)
        foreach ($f in @((Join-Path $binDir 'restow-agent.exe'), (Join-Path $binDir 'restic.exe'), (Join-Path $root 'Program Files\Restow\THIRD_PARTY_NOTICES.txt'))) {
            $acl = Get-Acl $f
            $ids = @($acl.Access | ForEach-Object { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value } | Sort-Object -Unique)
            $missing = @($folderIds | Where-Object { $ids -notcontains $_ })
            if ($acl.AreAccessRulesProtected -or @($acl.Access | Where-Object { -not $_.IsInherited }).Count -gt 0) { Fail "$f keeps its own permissions instead of inheriting them" }
            elseif ($missing.Count -gt 0) { Fail "$f lacks the permissions its folder hands down to [$($missing -join ', ')]" }
            else { Ok "$(Split-Path -Leaf $f) inherits the permissions of its folder" }
        }

        # A second run repairs without a token.
        $r = Invoke-Installer @{} @('-Hooks', 'scripts')
        if ($r.Code -ne 0 -or $r.Out -notmatch 'already enrolled') { Fail "second run: $($r.Out)" } else { Ok 'second run repairs' }

        # A tampered binary on the instance: refused, the installed one stays.
        $before = (Get-FileHash $agentExe).Hash
        Add-Content -Path (Join-Path $target 'restic.exe') -Value 'x'
        $r = Invoke-Installer @{} @()
        if ($r.Code -eq 0 -or $r.Out -notmatch 'checksum mismatch') { Fail "a tampered restic.exe was not refused: $($r.Out)" }
        elseif ((Get-FileHash $agentExe).Hash -ne $before) { Fail 'the installed agent changed although the release was refused' }
        else { Ok 'tampered release refused' }

        # -Uninstall
        $r = Invoke-Installer @{} @('-Uninstall')
        if ($r.Code -ne 0 -or (Test-Path (Join-Path $root 'Program Files\Restow'))) { Fail "uninstall: $($r.Out)" } else { Ok 'uninstall' }

        # ---- 4b. the real folders, without RESTOW_INSTALL_ROOT ----------------------
        # Where an administrator owns what it creates (the GitHub runner, UAC off, the
        # policy "Object creator"), C:\Program Files\Restow, its bin folder and the
        # binaries must still end up owned by Administrators; else the installer and
        # the agent refuse their own installation. No service (RESTOW_SKIP_SERVICE),
        # the state in a development folder.
        $realDir = Join-Path $env:ProgramW6432 'Restow'
        $principal = New-Object System.Security.Principal.WindowsPrincipal([System.Security.Principal.WindowsIdentity]::GetCurrent())
        if (-not $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
            Fail 'the test of the real folders needs an elevated PowerShell (the Windows runner is one)'
        } elseif (Test-Path -LiteralPath $realDir) {
            Fail "$realDir exists already; the test of the real folders needs a machine without the agent"
        } else {
            $probeDir = Join-Path $env:ProgramW6432 ('restow-owner-probe-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
            $null = New-Item -ItemType Directory -Path $probeDir
            $probeOwner = (Get-Acl -LiteralPath $probeDir).GetOwner([System.Security.Principal.SecurityIdentifier]).Value
            Remove-Item -LiteralPath $probeDir -Force
            Write-Host "note: a folder this administrator creates in Program Files is owned by $probeOwner"
            $realState = Join-Path $work 'real-state'
            try {
                $token2 = (Invoke-WebRequest -UseBasicParsing -Method Post -Uri "$url/test/token").Content
                $r = Invoke-Installer @{ RESTOW_INSTALL_ROOT = ''; RESTOW_TOKEN = $token2; RESTOW_AGENT_DIR = $realState } @()
                if ($r.Code -ne 0) { Fail "installation into $realDir failed: $($r.Out)" }
                else {
                    Ok "installation into $realDir"
                    foreach ($p in @($realDir, (Join-Path $realDir 'bin'), (Join-Path $realDir 'bin\restow-agent.exe'), (Join-Path $realDir 'bin\restic.exe'), (Join-Path $realDir 'THIRD_PARTY_NOTICES.txt'))) {
                        $o = (Get-Acl -LiteralPath $p).GetOwner([System.Security.Principal.SecurityIdentifier]).Value
                        if ($o -ne 'S-1-5-32-544') { Fail "$p is owned by $o, not by Administrators" } else { Ok "$p is owned by Administrators" }
                    }
                    $r = Invoke-Installer @{ RESTOW_INSTALL_ROOT = ''; RESTOW_AGENT_DIR = $realState } @()
                    if ($r.Code -ne 0) { Fail "second run into ${realDir}: $($r.Out)" } else { Ok "second run into $realDir" }
                }
                $r = Invoke-Installer @{ RESTOW_INSTALL_ROOT = ''; RESTOW_AGENT_DIR = $realState } @('-Uninstall')
                if ($r.Code -ne 0 -or (Test-Path -LiteralPath $realDir)) { Fail "uninstall of ${realDir}: $($r.Out)" } else { Ok "uninstall of $realDir" }
            } finally {
                if (Test-Path -LiteralPath $realDir) { Remove-Item -LiteralPath $realDir -Recurse -Force -ErrorAction SilentlyContinue }
            }
        }
    } finally {
        if ($fake -and -not $fake.HasExited) { Stop-Process -Id $fake.Id -Force }
        Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
    }
}

if ($failures.Count -gt 0) {
    Write-Host "$($failures.Count) failure(s)" -ForegroundColor Red
    exit 1
}
Write-Host 'all installer tests passed'
