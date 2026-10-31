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
# 4. A full installation below a prefix (RESTOW_INSTALL_ROOT, no service)
#    against the fake instance, a second run (repair), a pinned key that does
#    not match, a tampered release (nothing installed), -Proxy with
#    credentials, and -Uninstall.
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
