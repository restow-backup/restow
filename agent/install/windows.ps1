# Restow agent installer for Windows (preview; Windows 10 1607 / Server 2016 and newer, x64).
#
# Run it as shown in the Restow UI (Endpoints > New server / New client), in a
# PowerShell started as administrator (right-click > Run as administrator):
#
#   [Net.ServicePointManager]::SecurityProtocol = 'Tls12'; iex (irm -UseBasicParsing 'https://<your instance>/install/windows.ps1')
#
# and paste the one-time enrollment token when it asks (the input is hidden).
# The token never appears on a command line or in the PowerShell history. For
# unattended installs (RMM tools running as SYSTEM) put the token into a file
# and pin the release key:
#
#   $env:RESTOW_TOKEN_FILE = 'C:\Windows\System32\config\systemprofile\restow-enrollment.token'
#   $env:RESTOW_RELEASE_KEY_FINGERPRINT = 'SHA256:...'
#
# Instead of iex you can download this file, compare its SHA-256 with the
# value in the Restow UI and run it with (it enables TLS 1.2 itself):
#   powershell -NoProfile -ExecutionPolicy Bypass -File windows.ps1
#
# What it does: downloads the agent and restic from your Restow instance into
# a folder only SYSTEM and Administrators can access, checks the maintainer's
# Ed25519 signature over the release's SHA256SUMS (with its own check written
# in PowerShell, no other tool needed) and the SHA-256 of every file before
# anything is executed, installs them to C:\Program Files\Restow\bin, installs
# the Windows service RestowAgent (LocalSystem) and enrolls this computer.
# Running it again repairs or upgrades the installation.
#
# Options (as parameters of the script block, or as environment variables):
#   -Hooks off|scripts|any         RESTOW_HOOKS      hooks from the Restow server (default off)
#   -Uninstall                     RESTOW_UNINSTALL=1 remove the agent again
#   -Proxy http://proxy:3128       RESTOW_PROXY      fixed proxy for the service (no credentials)
#   -ReleaseKeyFingerprint SHA256:...  RESTOW_RELEASE_KEY_FINGERPRINT  pin of the release key
#
#   & ([scriptblock]::Create((irm -UseBasicParsing 'https://<your instance>/install/windows.ps1'))) -Uninstall
#
# restow-agent.exe and this script carry no Authenticode signature (Restow 0.5.0
# preview); see the Restow agent documentation for Defender and Smart App Control.
#
# The instance URL, the agent version and the release signing key below are
# filled in by your Restow instance when it serves this file. This file is
# plain ASCII on purpose.
[CmdletBinding()]
param(
    [string]$Hooks = '',
    [switch]$Uninstall,
    [string]$Proxy = '',
    [string]$ReleaseKeyFingerprint = ''
)

$RestowInstanceUrl = '__RESTOW_URL__'
$RestowAgentVersion = '__RESTOW_VERSION__'
# Public key the agent releases are signed with (empty: this instance ships no
# release key; then only development builds can be installed).
$RestowReleaseKey = '__RESTOW_RELEASE_KEY__'
$RestowSigNamespace = 'restow-agent-release'
$RestowServiceName = 'RestowAgent'
$RestowTrustedSids = @('S-1-5-18', 'S-1-5-32-544', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
# State of one run. A hashtable, so the functions share it however the script
# is started (iex, a script block with parameters, -File, dot-sourced by the tests).
# Every key is there from the start: under Set-StrictMode a key that is missing
# throws (PropertyNotFoundStrict) instead of reading as $null.
$RestowState = @{
    AgentExe = $null; BinDir = $null; DataRoot = $null; InstallDir = $null; InstallRoot = $null
    EffectiveProxy = $null; SkipService = $null
    EdP = $null; EdL = $null; EdD = $null; EdD2 = $null; EdSqrtM1 = $null; EdExpSqrt = $null
    EdPm2 = $null; EdB = $null
}

# ---- Ed25519 (RFC 8032), the same acceptance rules as Go's crypto/ed25519 -----
#
# Valid exactly when: 64-byte signature with the top three bits of the last
# byte clear, S < L, the public key decodes, and the encoding of
# [S]B - [k]A with k = SHA-512(R || A || M) mod L equals R byte for byte.
# agent/scripts/sigdiff/ref.go is this code once more in Go; its tests and the
# differential test (agent/scripts/test-install-windows.ps1) compare both with
# crypto/ed25519.

function Initialize-Ed25519 {
    try { $null = [System.Numerics.BigInteger]::One } catch { Add-Type -AssemblyName System.Numerics }
    $BI = [System.Numerics.BigInteger]
    $p = $BI::Subtract($BI::Pow(2, 255), 19)
    $RestowState.EdP = $p
    $RestowState.EdL = $BI::Parse('7237005577332262213973186563042994240857116359379907606001950938285454250989')
    $inv121666 = $BI::ModPow(121666, $BI::Subtract($p, 2), $p)
    $RestowState.EdD = $BI::Remainder($BI::Multiply($BI::Subtract($p, 121665), $inv121666), $p)
    $RestowState.EdD2 = $BI::Remainder($BI::Multiply($RestowState.EdD, 2), $p)
    $RestowState.EdSqrtM1 = $BI::ModPow(2, $BI::Divide($BI::Subtract($p, 1), 4), $p)
    $RestowState.EdExpSqrt = $BI::Divide($BI::Add($p, 3), 8)
    $RestowState.EdPm2 = $BI::Subtract($p, 2)
    # B: y = 4/5, x even.
    $by = $BI::Remainder($BI::Multiply(4, $BI::ModPow(5, $RestowState.EdPm2, $p)), $p)
    $base = Get-EdPointFromY -Y $by -Sign 0
    $RestowState.EdB = $base
}

function ConvertTo-EdInt([byte[]]$LittleEndian) {
    # BigInteger reads little-endian two's complement; a trailing zero keeps it positive.
    $buf = New-Object byte[] ($LittleEndian.Length + 1)
    [Array]::Copy($LittleEndian, $buf, $LittleEndian.Length)
    return [System.Numerics.BigInteger]::new($buf)
}

function Get-EdPointFromY($Y, [int]$Sign) {
    $BI = [System.Numerics.BigInteger]; $p = $RestowState.EdP
    $y2 = $BI::Remainder($BI::Multiply($Y, $Y), $p)
    $u = $BI::Remainder($BI::Add($BI::Subtract($y2, 1), $p), $p)
    $v = $BI::Remainder($BI::Add($BI::Multiply($RestowState.EdD, $y2), 1), $p)
    $uv = $BI::Remainder($BI::Multiply($u, $BI::ModPow($v, $RestowState.EdPm2, $p)), $p)
    $x = $BI::ModPow($uv, $RestowState.EdExpSqrt, $p)
    $vx2 = $BI::Remainder($BI::Multiply($v, $BI::Remainder($BI::Multiply($x, $x), $p)), $p)
    $negU = $BI::Remainder($BI::Subtract($p, $u), $p)
    if ($vx2.Equals($u)) {
    } elseif ($vx2.Equals($negU)) {
        $x = $BI::Remainder($BI::Multiply($x, $RestowState.EdSqrtM1), $p)
    } else {
        return $null
    }
    $odd = 0
    if (-not $x.IsEven) { $odd = 1 }
    if ($odd -ne $Sign) { $x = $BI::Remainder($BI::Subtract($p, $x), $p) }
    return , @($x, $Y, [System.Numerics.BigInteger]::One, $BI::Remainder($BI::Multiply($x, $Y), $p))
}

function ConvertFrom-EdPointBytes([byte[]]$Bytes) {
    if ($Bytes.Length -ne 32) { return $null }
    $c = [byte[]]$Bytes.Clone()
    $sign = [int]($c[31] -shr 7)
    $c[31] = [byte]($c[31] -band 0x7f)
    # Non-canonical y (>= p) is reduced, as filippo.io/edwards25519 does.
    $y = [System.Numerics.BigInteger]::Remainder((ConvertTo-EdInt $c), $RestowState.EdP)
    $pt = Get-EdPointFromY -Y $y -Sign $sign
    if ($null -eq $pt) { return $null }
    return , $pt
}

function Add-EdPoint($A, $B) {
    # add-2008-hwcd-3 for a = -1; unified, so it also doubles. Every
    # difference gets p added first, so no value is ever negative.
    $BI = [System.Numerics.BigInteger]; $p = $RestowState.EdP
    $a1 = $BI::Remainder($BI::Multiply($BI::Add($BI::Subtract($A[1], $A[0]), $p), $BI::Add($BI::Subtract($B[1], $B[0]), $p)), $p)
    $b1 = $BI::Remainder($BI::Multiply($BI::Add($A[1], $A[0]), $BI::Add($B[1], $B[0])), $p)
    $c1 = $BI::Remainder($BI::Multiply($BI::Remainder($BI::Multiply($A[3], $RestowState.EdD2), $p), $B[3]), $p)
    $d1 = $BI::Remainder($BI::Multiply($BI::Multiply($A[2], 2), $B[2]), $p)
    $e = $BI::Add($BI::Subtract($b1, $a1), $p)
    $f = $BI::Add($BI::Subtract($d1, $c1), $p)
    $g = $BI::Add($d1, $c1)
    $h = $BI::Add($b1, $a1)
    return , @(
        $BI::Remainder($BI::Multiply($e, $f), $p),
        $BI::Remainder($BI::Multiply($g, $h), $p),
        $BI::Remainder($BI::Multiply($f, $g), $p),
        $BI::Remainder($BI::Multiply($e, $h), $p))
}

function ConvertTo-EdPointBytes($Pt) {
    $BI = [System.Numerics.BigInteger]; $p = $RestowState.EdP
    $zi = $BI::ModPow($Pt[2], $RestowState.EdPm2, $p)
    $x = $BI::Remainder($BI::Multiply($Pt[0], $zi), $p)
    $y = $BI::Remainder($BI::Multiply($Pt[1], $zi), $p)
    $yb = $y.ToByteArray()
    $out = New-Object byte[] 32
    [Array]::Copy($yb, $out, [Math]::Min(32, $yb.Length))
    if (-not $x.IsEven) { $out[31] = [byte]($out[31] -bor 0x80) }
    return , $out
}

function Get-ScalarBit([byte[]]$Le, [int]$Index) {
    $byteIndex = $Index -shr 3
    if ($byteIndex -ge $Le.Length) { return 0 }
    return ([int]$Le[$byteIndex] -shr ($Index -band 7)) -band 1
}

function Test-Ed25519Signature([byte[]]$PublicKey, [byte[]]$Message, [byte[]]$Signature) {
    if ($null -eq $RestowState.EdP) { Initialize-Ed25519 }
    if ($null -eq $PublicKey -or $null -eq $Signature) { return $false }
    if ($null -eq $Message) { $Message = [byte[]]@() }
    if ($PublicKey.Length -ne 32 -or $Signature.Length -ne 64) { return $false }
    if (($Signature[63] -band 0xE0) -ne 0) { return $false }
    $A = ConvertFrom-EdPointBytes $PublicKey
    if ($null -eq $A) { return $false }
    $R = New-Object byte[] 32
    $Sb = New-Object byte[] 32
    [Array]::Copy($Signature, 0, $R, 0, 32)
    [Array]::Copy($Signature, 32, $Sb, 0, 32)
    $S = ConvertTo-EdInt $Sb
    if ($S.CompareTo($RestowState.EdL) -ge 0) { return $false }
    $hashInput = New-Object byte[] (64 + $Message.Length)
    [Array]::Copy($R, 0, $hashInput, 0, 32)
    [Array]::Copy($PublicKey, 0, $hashInput, 32, 32)
    if ($Message.Length -gt 0) { [Array]::Copy($Message, 0, $hashInput, 64, $Message.Length) }
    $sha = [System.Security.Cryptography.SHA512]::Create()
    try { $h = $sha.ComputeHash($hashInput) } finally { $sha.Dispose() }
    $k = [System.Numerics.BigInteger]::Remainder((ConvertTo-EdInt $h), $RestowState.EdL)
    $kb = $k.ToByteArray()
    $BI = [System.Numerics.BigInteger]
    $negA = @($BI::Remainder($BI::Subtract($RestowState.EdP, $A[0]), $RestowState.EdP), $A[1], $A[2],
        $BI::Remainder($BI::Subtract($RestowState.EdP, $A[3]), $RestowState.EdP))
    # Joint double-and-add over S and k (Straus), high bit first.
    $Q = @($BI::Zero, $BI::One, $BI::One, $BI::Zero)
    for ($i = 255; $i -ge 0; $i--) {
        $Q = Add-EdPoint $Q $Q
        if ((Get-ScalarBit $Sb $i) -eq 1) { $Q = Add-EdPoint $Q $RestowState.EdB }
        if ((Get-ScalarBit $kb $i) -eq 1) { $Q = Add-EdPoint $Q $negA }
    }
    $enc = ConvertTo-EdPointBytes $Q
    for ($i = 0; $i -lt 32; $i++) {
        if ($enc[$i] -ne $R[$i]) { return $false }
    }
    return $true
}

# ---- SSH signature (SSHSIG, PROTOCOL.sshsig), as agent/internal/release/sshsig.go ----

function Read-SshUInt32($Reader) {
    if ($Reader.Pos + 4 -gt $Reader.Bytes.Length) { throw 'truncated' }
    $b = $Reader.Bytes; $i = $Reader.Pos
    $v = ([long]$b[$i] * 16777216) + ([long]$b[$i + 1] * 65536) + ([long]$b[$i + 2] * 256) + [long]$b[$i + 3]
    $Reader.Pos = $i + 4
    return $v
}

function Read-SshString($Reader) {
    $n = Read-SshUInt32 $Reader
    if ($n -gt ($Reader.Bytes.Length - $Reader.Pos)) { throw 'truncated' }
    # Plain ints, so Array.Copy has one overload to pick (Pos may have become a long).
    $len = [int]$n; $pos = [int]$Reader.Pos
    $out = New-Object byte[] $len
    if ($len -gt 0) { [Array]::Copy($Reader.Bytes, $pos, $out, 0, $len) }
    $Reader.Pos = $Reader.Pos + $n
    return , $out
}

function New-SshReader([byte[]]$Bytes) { return @{ Bytes = $Bytes; Pos = 0 } }

function Test-BytesEqual([byte[]]$A, [byte[]]$B) {
    if ($null -eq $A -or $null -eq $B -or $A.Length -ne $B.Length) { return $false }
    for ($i = 0; $i -lt $A.Length; $i++) { if ($A[$i] -ne $B[$i]) { return $false } }
    return $true
}

function ConvertTo-AsciiBytes([string]$Text) { return , [System.Text.Encoding]::ASCII.GetBytes($Text) }

function ConvertTo-SshString([byte[]]$Bytes) {
    $n = $Bytes.Length
    $out = New-Object byte[] (4 + $n)
    $out[0] = [byte](($n -shr 24) -band 0xff); $out[1] = [byte](($n -shr 16) -band 0xff)
    $out[2] = [byte](($n -shr 8) -band 0xff); $out[3] = [byte]($n -band 0xff)
    if ($n -gt 0) { [Array]::Copy($Bytes, 0, $out, 4, $n) }
    return , $out
}

# Get-ReleaseKeyBlob returns the SSH wire form of an ssh-ed25519 key line, or throws.
function Get-ReleaseKeyBlob([string]$KeyLine) {
    $fields = @($KeyLine.Trim() -split '\s+')
    if ($fields.Count -lt 2 -or $fields[0] -cne 'ssh-ed25519') { throw 'the release key is not an ssh-ed25519 key' }
    $blob = [Convert]::FromBase64String($fields[1])
    $r = New-SshReader $blob
    $type = Read-SshString $r
    $key = Read-SshString $r
    if ($r.Pos -ne $blob.Length -or [System.Text.Encoding]::ASCII.GetString($type) -cne 'ssh-ed25519' -or $key.Length -ne 32) {
        throw 'the release key is not an Ed25519 key in SSH format'
    }
    return , $blob
}

# Get-ReleaseKeyFingerprint is the SHA256 fingerprint as `ssh-keygen -l` prints it.
function Get-ReleaseKeyFingerprint([string]$KeyLine) {
    $blob = Get-ReleaseKeyBlob $KeyLine
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { $h = $sha.ComputeHash($blob) } finally { $sha.Dispose() }
    return 'SHA256:' + [Convert]::ToBase64String($h).TrimEnd('=')
}

# Test-ReleaseSignature checks an armored SSHSIG signature over Message
# against the release key: this key, namespace restow-agent-release, SHA-512,
# Ed25519 with exactly 64 bytes, no trailing bytes. It returns exactly one
# [bool]; every malformed input is $false.
function Test-ReleaseSignature([byte[]]$Message, [string]$SignatureText, [string]$KeyLine) {
    try {
        $keyBlob = Get-ReleaseKeyBlob $KeyLine
        $text = ($SignatureText -replace "`r", '').Trim()
        $begin = '-----BEGIN SSH SIGNATURE-----'
        $end = '-----END SSH SIGNATURE-----'
        if ($SignatureText.Length -gt 16384 -or -not $text.StartsWith($begin) -or -not $text.EndsWith($end)) { return $false }
        $body = $text.Substring($begin.Length, $text.Length - $begin.Length - $end.Length) -replace '\s', ''
        $blob = [Convert]::FromBase64String($body)
        $magic = ConvertTo-AsciiBytes 'SSHSIG'
        if ($blob.Length -lt 6) { return $false }
        for ($i = 0; $i -lt 6; $i++) { if ($blob[$i] -ne $magic[$i]) { return $false } }
        $r = New-SshReader $blob
        $r.Pos = 6
        $version = Read-SshUInt32 $r
        $pub = Read-SshString $r
        $ns = Read-SshString $r
        $reserved = Read-SshString $r
        $hashAlg = Read-SshString $r
        $sigBlob = Read-SshString $r
        if ($r.Pos -ne $blob.Length) { return $false }
        if ($version -ne 1) { return $false }
        if (-not (Test-BytesEqual $pub $keyBlob)) { return $false }
        if ([System.Text.Encoding]::ASCII.GetString($ns) -cne $RestowSigNamespace) { return $false }
        if ([System.Text.Encoding]::ASCII.GetString($hashAlg) -cne 'sha512') { return $false }
        $sr = New-SshReader $sigBlob
        $sigType = Read-SshString $sr
        $raw = Read-SshString $sr
        if ($sr.Pos -ne $sigBlob.Length -or [System.Text.Encoding]::ASCII.GetString($sigType) -cne 'ssh-ed25519' -or $raw.Length -ne 64) { return $false }
        $sha = [System.Security.Cryptography.SHA512]::Create()
        try { $digest = $sha.ComputeHash($Message) } finally { $sha.Dispose() }
        $signed = [byte[]]((ConvertTo-AsciiBytes 'SSHSIG') +
            (ConvertTo-SshString (ConvertTo-AsciiBytes $RestowSigNamespace)) +
            (ConvertTo-SshString $reserved) +
            (ConvertTo-SshString (ConvertTo-AsciiBytes 'sha512')) +
            (ConvertTo-SshString $digest))
        $keyR = New-SshReader $keyBlob
        $null = Read-SshString $keyR
        $rawKey = Read-SshString $keyR
        $ok = Test-Ed25519Signature -PublicKey $rawKey -Message $signed -Signature $raw
        return ($ok -ceq $true)
    } catch {
        return $false
    }
}

# ---- installer -------------------------------------------------------------------

function Write-Step([string]$Text) { Write-Host "==> $Text" }
function Write-Note([string]$Text) { Write-Host "    $Text" }
function Write-Warn([string]$Text) { Write-Host "warning: $Text" -ForegroundColor Yellow }
function Stop-Installer([string]$Text) { throw "Restow installer: $Text" }

function Get-SidString($Identity) {
    try { return $Identity.Translate([System.Security.Principal.SecurityIdentifier]).Value } catch { return [string]$Identity }
}

function Get-TrustedSidList {
    $list = @($RestowTrustedSids)
    if ($RestowState.InstallRoot) {
        # A test installation below a prefix also trusts its own user.
        $list += [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    }
    return $list
}

# Test-FolderTrust: an existing folder must not be a reparse point and must be
# owned by SYSTEM, Administrators or TrustedInstaller; with -Strict nobody
# else may write, append, change attributes, delete, change permissions or
# take ownership (docs/WINDOWS-AGENT.md, section 6). It throws, it does not repair.
function Test-FolderTrust([string]$Path, [switch]$Strict) {
    if (-not (Test-Path -LiteralPath $Path)) { return }
    $item = Get-Item -LiteralPath $Path -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        Stop-Installer "$Path is a link, junction or mount point. Nothing was installed. Remove it and run the installer again."
    }
    $acl = Get-Acl -LiteralPath $Path
    $owner = Get-SidString $acl.GetOwner([System.Security.Principal.SecurityIdentifier])
    $trusted = Get-TrustedSidList
    if ($trusted -notcontains $owner) {
        Stop-Installer "$Path is owned by $owner, not by SYSTEM or Administrators; someone else may have prepared it. Nothing was installed. Remove the folder as an administrator and run the installer again."
    }
    if (-not $Strict) { return }
    # Write data, append, write EA, write attributes, delete child, delete, write DAC, write owner, generic write, generic all.
    $forbidden = 0x2 -bor 0x4 -bor 0x10 -bor 0x100 -bor 0x40 -bor 0x10000 -bor 0x40000 -bor 0x80000
    foreach ($rule in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
        if ($rule.AccessControlType -ne 'Allow') { continue }
        if (($rule.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0) { continue }
        $sid = $rule.IdentityReference.Value
        if ($trusted -contains $sid) { continue }
        $mask = [long]$rule.FileSystemRights
        if ($mask -lt 0) { $mask += 4294967296 }
        if ((($mask -band 0x40000000) -ne 0) -or (($mask -band 0x10000000) -ne 0) -or (($mask -band $forbidden) -ne 0)) {
            Stop-Installer "$Path lets $sid change it (rights 0x$('{0:x}' -f $mask)). Nothing was installed. Restore the standard permissions of the folder and run the installer again."
        }
    }
}

function Test-Elevated {
    $principal = New-Object System.Security.Principal.WindowsPrincipal([System.Security.Principal.WindowsIdentity]::GetCurrent())
    return $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
}

# Test-CanOwnAsAdministrators: whether this run can make BUILTIN\Administrators
# the owner of what it creates (an elevated administrator can; a test
# installation below a prefix without elevation cannot and trusts its own user).
function Test-CanOwnAsAdministrators { return ((-not $RestowState.InstallRoot) -or (Test-Elevated)) }

function New-PrivateFolder([string]$Path) {
    $sec = New-Object System.Security.AccessControl.DirectorySecurity
    $sec.SetAccessRuleProtection($true, $false)
    if (Test-CanOwnAsAdministrators) { $sec.SetOwner((New-Object System.Security.Principal.SecurityIdentifier 'S-1-5-32-544')) }
    $sids = @('S-1-5-18', 'S-1-5-32-544')
    if ($RestowState.InstallRoot) { $sids += [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value }
    foreach ($s in $sids) {
        $rule = New-Object System.Security.AccessControl.FileSystemAccessRule((New-Object System.Security.Principal.SecurityIdentifier $s),
            'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
        $sec.AddAccessRule($rule)
    }
    if ($PSVersionTable.PSVersion.Major -ge 6) {
        $null = [System.IO.FileSystemAclExtensions]::CreateDirectory($sec, $Path)
    } else {
        $null = [System.IO.Directory]::CreateDirectory($Path, $sec)
    }
}

# Enable-Tls12 switches TLS 1.2 on for this PowerShell. Windows PowerShell 5.1
# runs on the .NET Framework, which offers only SSL 3 and TLS 1.0 unless
# SchUseStrongCrypto is set (Server 2016, Windows 10 1607 and many other builds).
# The iex command line sets it in the administrator's own session, but the
# -File form and the 64-bit relaunch start a new PowerShell without it, and
# every download from a TLS-1.2-only instance would fail. -bor keeps what is
# already on (TLS 1.3); SystemDefault (0) leaves the choice to Windows, which
# offers TLS 1.2 on every supported version, and stays as it is.
function Enable-Tls12 {
    try {
        $current = [Net.ServicePointManager]::SecurityProtocol
        if ([int]$current -ne 0) {
            [Net.ServicePointManager]::SecurityProtocol = $current -bor [Net.SecurityProtocolType]::Tls12
        }
    } catch { }
}

# Get-DownloadHint explains a download that failed while setting up TLS.
function Get-DownloadHint([string]$Message, [string]$Url) {
    if ($Message -match 'underlying connection was closed|SSL/TLS|secure channel|Authentication failed because the remote party') {
        return " TLS could not be set up with $Url. The Restow instance needs TLS 1.2: on Windows Server 2016 and older Windows 10, switch on strong cryptography for the .NET Framework (SchUseStrongCrypto, see the Restow agent documentation) or run the install command shown in the Restow UI, which enables TLS 1.2 first."
    }
    return " Check that this computer can reach $Url over HTTPS."
}

function Invoke-Download([string]$Url, [string]$OutFile) {
    $params = @{ Uri = $Url; OutFile = $OutFile; UseBasicParsing = $true; TimeoutSec = 900 }
    if ($RestowState.EffectiveProxy) { $params.Proxy = $RestowState.EffectiveProxy }
    Invoke-WebRequest @params
}

function Get-FileSha256([string]$Path) { return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }

function Get-SumsEntry([string[]]$Lines, [string]$Name) {
    foreach ($line in $Lines) {
        $f = @($line.Trim() -split '\s+')
        if ($f.Count -eq 2 -and ($f[1] -ceq $Name -or $f[1] -ceq ('*' + $Name))) { return $f[0].ToLowerInvariant() }
    }
    return ''
}

function Test-DevVersion([string]$Version) { return ($Version -like '*-dev' -or $Version -like '*-dev.*') }

# Smart App Control (Windows 11): the value VerifiedAndReputablePolicyState of
# HKLM\SYSTEM\CurrentControlSet\Control\CI\Policy is 0 (off), 1 (on) or 2
# (evaluation). Get-SmartAppControlState returns it, or -1 when the key or the
# value is not there (Windows 10, Windows Server). The key is a parameter, so
# the tests read a key of their own.
function Get-SmartAppControlState([string]$Key) {
    try {
        $item = Get-ItemProperty -Path $Key -Name VerifiedAndReputablePolicyState -ErrorAction Stop
        return [int]$item.VerifiedAndReputablePolicyState
    } catch [System.Management.Automation.ItemNotFoundException] {
        return -1
    } catch [System.Management.Automation.PSArgumentException] {
        return -1
    }
}

# Get-SmartAppControlVerdict says what the installer does for a state: Stop
# (on: it blocks the unsigned agent now) or Warn (evaluation: Windows may switch
# it on later by itself); both are '' otherwise.
function Get-SmartAppControlVerdict([int]$State) {
    $off = 'To switch it off: Windows Security > App & browser control > Smart App Control settings > Off. Switching it off is permanent: Smart App Control can only be switched on again by resetting or reinstalling Windows.'
    if ($State -eq 1) {
        return @{ Stop = "Smart App Control is on. It blocks programs without a code signature, and restow-agent.exe and restic.exe have none in this preview. Nothing was installed. $off See the Restow agent documentation (Known limits)."; Warn = '' }
    }
    if ($State -eq 2) {
        return @{ Stop = ''; Warn = "Smart App Control is in evaluation mode. Windows may switch it on later by itself; it then blocks restow-agent.exe and restic.exe (no code signature in this preview) and every agent update: the service no longer starts, backups stop, and the Restow UI only shows this computer as offline. $off See the Restow agent documentation (Known limits)." }
    }
    return @{ Stop = ''; Warn = '' }
}

# Get-SqlInstanceNames lists the SQL Server instances of this computer (the
# value names of Instance Names\SQL); an empty list without SQL Server.
function Get-SqlInstanceNames([string]$Key = 'HKLM:\SOFTWARE\Microsoft\Microsoft SQL Server\Instance Names\SQL') {
    try {
        $item = Get-Item -Path $Key -ErrorAction Stop
        return , @($item.GetValueNames() | Where-Object { $_ -ne '' } | Sort-Object)
    } catch {
        return , @()
    }
}

# Get-SqlLoginHint is what the installer says on a computer with SQL Server:
# the agent signs in as its service SID, and SQL Server gives neither SYSTEM
# nor the Administrators the rights a native backup needs.
function Get-SqlLoginHint([string[]]$Instances) {
    if ($Instances.Count -eq 0) { return @() }
    return @(
        ('SQL Server: ' + ($Instances -join ', ') + '. For the native SQL Server backup, a database administrator runs on each instance:'),
        '  CREATE LOGIN [NT SERVICE\RestowAgent] FROM WINDOWS;',
        '  ALTER SERVER ROLE [sysadmin] ADD MEMBER [NT SERVICE\RestowAgent];',
        'The Restow UI shows these lines, and a variant with smaller rights, on the SQL Server tab of this computer.'
    )
}

function Get-SystemArchitecture {
    $arch = $env:PROCESSOR_ARCHITEW6432
    if (-not $arch) { $arch = $env:PROCESSOR_ARCHITECTURE }
    try {
        $os = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
        if ($os -eq 'Arm64') { return 'ARM64' }
    } catch { }
    return [string]$arch
}

# Get-Wow64Counterpart returns the SysWOW64 path of a path below System32, or ''.
function Get-Wow64Counterpart([string]$File, [string]$WindowsDir) {
    $sys32 = (Join-Path $WindowsDir 'System32').TrimEnd('\') + '\'
    if (-not $File.StartsWith($sys32, [StringComparison]::OrdinalIgnoreCase)) { return '' }
    return (Join-Path (Join-Path $WindowsDir 'SysWOW64') $File.Substring($sys32.Length))
}

# Get-RelaunchTokenFile returns the RESTOW_TOKEN_FILE for the 64-bit PowerShell
# that a 32-bit host starts. A 32-bit program that writes C:\Windows\System32\...
# really writes C:\Windows\SysWOW64\... (WOW64 file system redirection, and
# config\systemprofile is not exempt), where the 64-bit child would not look. So
# a path below System32 that exists as this 32-bit PowerShell sees it becomes
# its SysWOW64 path, which names the same file in both views; one that is not
# there for the 32-bit view (written through Sysnative) stays. A path through
# Sysnative, which only a 32-bit program has, becomes the System32 path.
function Get-RelaunchTokenFile([string]$File, [string]$WindowsDir) {
    if (-not $File) { return $File }
    $sysnative = (Join-Path $WindowsDir 'Sysnative').TrimEnd('\') + '\'
    if ($File.StartsWith($sysnative, [StringComparison]::OrdinalIgnoreCase)) {
        return (Join-Path (Join-Path $WindowsDir 'System32') $File.Substring($sysnative.Length))
    }
    $wow = Get-Wow64Counterpart $File $WindowsDir
    if ($wow -and (Test-Path -LiteralPath $File -PathType Leaf)) { return $wow }
    return $File
}

# Get-TokenFileProblem says why RESTOW_TOKEN_FILE cannot be read, or ''. A file
# missing below System32 that exists below SysWOW64 was written by a 32-bit
# program; the message names that file.
function Get-TokenFileProblem([string]$File, [string]$WindowsDir) {
    if (Test-Path -LiteralPath $File -PathType Leaf) { return '' }
    $text = "RESTOW_TOKEN_FILE $File does not exist"
    $wow = Get-Wow64Counterpart $File $WindowsDir
    if ($wow -and (Test-Path -LiteralPath $wow -PathType Leaf)) {
        $text += ", but $wow does: a 32-bit program that writes to System32 writes to SysWOW64 (WOW64 file system redirection). " +
            "Set RESTOW_TOKEN_FILE to $wow, or let the 32-bit program write the file through $(Join-Path $WindowsDir 'Sysnative')"
    }
    return $text
}

# Test-NonInteractiveHost tells whether this PowerShell was started with
# -NonInteractive (any abbreviation PowerShell accepts, from -noni on).
function Test-NonInteractiveHost {
    foreach ($arg in [Environment]::GetCommandLineArgs()) {
        if ($arg -match '^[-/]noni') { return $true }
    }
    return $false
}

function Read-EnrollmentToken {
    if ($env:RESTOW_TOKEN_FILE) {
        $file = $env:RESTOW_TOKEN_FILE
        $problem = Get-TokenFileProblem $file $env:windir
        if ($problem) { Stop-Installer $problem }
        $acl = Get-Acl -LiteralPath $file
        $trusted = Get-TrustedSidList
        foreach ($rule in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
            if ($rule.AccessControlType -eq 'Allow' -and $trusted -notcontains $rule.IdentityReference.Value -and
                ([long]$rule.FileSystemRights -band 0x1) -ne 0) {
                Write-Warn "$file can be read by $($rule.IdentityReference.Value); keep token files readable by SYSTEM and Administrators only"
                break
            }
        }
        return ((Get-Content -LiteralPath $file -TotalCount 1) -replace '\s', '')
    }
    if ($env:RESTOW_TOKEN) { return ($env:RESTOW_TOKEN -replace '\s', '') }
    # Ask only where someone can answer: not in a service session, and not in a host
    # started with -NonInteractive (a script or a deployment tool), where Read-Host
    # would fail or wait for input that never comes.
    if ([Environment]::UserInteractive -and -not (Test-NonInteractiveHost)) {
        $secure = Read-Host -AsSecureString 'Paste the enrollment token from the Restow UI (input is hidden)'
        $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
        try { return ([Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) -replace '\s', '') }
        finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
    }
    return ''
}

# Invoke-Relaunch starts the installer again in 64-bit PowerShell with the
# environment variables in $Environment and returns its exit code; the
# variables of this session are restored afterwards (the iex form runs in the
# administrator's own session). Only the exit code counts: under 'Stop' a line
# the child writes to stderr (a warning of the agent that the child passes on)
# became a terminating NativeCommandError in this parent under Windows
# PowerShell 5.1, which ended the child's pipeline in the middle of the
# installation, for example after the enrollment and before the service start.
function Invoke-Relaunch([string]$PowerShell, [string[]]$Arguments, [hashtable]$Environment) {
    $ErrorActionPreference = 'Continue'
    $saved = @{}
    foreach ($k in $Environment.Keys) {
        $saved[$k] = [Environment]::GetEnvironmentVariable($k, 'Process')
        [Environment]::SetEnvironmentVariable($k, $Environment[$k], 'Process')
    }
    try {
        & $PowerShell @Arguments | Out-Host
        return $LASTEXITCODE
    } finally {
        foreach ($k in $saved.Keys) { [Environment]::SetEnvironmentVariable($k, $saved[$k], 'Process') }
    }
}

function Invoke-Agent([string[]]$Arguments) {
    # Output goes to the console, not into the return value; messages on
    # stderr are no PowerShell errors (Windows PowerShell 5.1 would turn them
    # into terminating errors under 'Stop' in some hosts).
    $ErrorActionPreference = 'Continue'
    # The agent reads its proxy from the environment only (Go's
    # ProxyFromEnvironment; the service gets it as its Environment value), so
    # -Proxy reaches enroll and status the same way, for this one command.
    $saved = @{}
    if ($RestowState.EffectiveProxy) {
        $proxyEnv = @{ HTTPS_PROXY = $RestowState.EffectiveProxy; HTTP_PROXY = $RestowState.EffectiveProxy; NO_PROXY = 'localhost,127.0.0.1,::1' }
        foreach ($k in $proxyEnv.Keys) {
            $saved[$k] = [Environment]::GetEnvironmentVariable($k, 'Process')
            [Environment]::SetEnvironmentVariable($k, $proxyEnv[$k], 'Process')
        }
    }
    try {
        & $RestowState.AgentExe @Arguments | Out-Host
        return $LASTEXITCODE
    } finally {
        foreach ($k in $saved.Keys) { [Environment]::SetEnvironmentVariable($k, $saved[$k], 'Process') }
    }
}

# Get-EnrollmentCredentials asks the installed agent whether this computer is
# enrolled with credentials it can read (restow-agent status --json):
# State is readable, unreadable (Error says why) or missing. A state file that
# exists does not prove an enrollment: one that can no longer be decrypted or
# read leaves the service waiting. Should status not run or not answer, the
# state file decides as before.
function Get-EnrollmentCredentials([string]$StateFile) {
    $ErrorActionPreference = 'Continue'
    $result = @{ State = 'missing'; Error = '' }
    if (Test-Path -LiteralPath $StateFile) { $result.State = 'readable' }
    try {
        $text = (& $RestowState.AgentExe status --json 2>$null | Out-String)
        if ($LASTEXITCODE -eq 0 -and $text.Trim()) {
            $rep = $text | ConvertFrom-Json
            $names = @($rep.PSObject.Properties | ForEach-Object { $_.Name })
            if ($names -contains 'credentials' -and @('readable', 'unreadable', 'missing') -contains [string]$rep.credentials) {
                $result.State = [string]$rep.credentials
                if ($names -contains 'credentialsError') { $result.Error = [string]$rep.credentialsError }
            }
        }
    } catch { }
    return $result
}

# Get-SystemProxy returns the proxy Windows uses for $Url (Internet Options,
# WPAD or a PAC file), or '' when it goes there directly. Invoke-WebRequest
# uses it for the downloads; the agent only reads -Proxy (HTTPS_PROXY), so the
# installer names it and never takes it over unasked.
function Get-SystemProxy([string]$Url) {
    try {
        $uri = New-Object System.Uri $Url
        $p = [System.Net.WebRequest]::GetSystemWebProxy().GetProxy($uri)
        if ($p -and $p.AbsoluteUri -ne $uri.AbsoluteUri) { return $p.AbsoluteUri.TrimEnd('/') }
    } catch { }
    return ''
}

# Get-EnrollFailureText explains a failed `restow-agent enroll` by its exit
# code: 4 the instance refused the token (only then a new token helps), 5 the
# instance could not be reached, else the agent's own message says why and
# whether the token is used up.
function Get-EnrollFailureText([int]$Code, [string]$Url, [string]$UsedProxy, [string]$SystemProxy) {
    switch ($Code) {
        4 { return 'the agent is installed but not enrolled: the Restow instance did not accept the token. Create a new token in the Restow UI (the old one may have expired or been used) and run the install command again.' }
        5 {
            $text = "the agent is installed but not enrolled: it could not reach $Url (see its message above). Check the network, the firewall and the time of this computer."
            if ($UsedProxy) {
                $text += " Check that the proxy $UsedProxy lets this computer reach $Url."
            } elseif ($SystemProxy) {
                $text += " Windows sends web traffic of this computer through the proxy $SystemProxy (the installer's downloads used it), but the agent does not read that setting: run the installer again with -Proxy $SystemProxy."
            } else {
                $text += ' If this computer reaches the internet through a proxy, run the installer again with -Proxy http://<proxy>:<port>.'
            }
            return $text
        }
    }
    return "the agent is installed but not enrolled (restow-agent enroll ended with exit code $Code). Its message above says why and whether the token was used; fix the cause and run the install command again."
}

# Set-InstalledSecurity makes BUILTIN\Administrators the owner of a folder the
# installer created or a file it moved into place, then gives it the
# permissions of its folder.
# The owner: where an administrator owns what it creates (UAC off, the built-in
# Administrator, the policy "Default owner for objects created by members of
# the Administrators group: Object creator", the GitHub Windows runner), a new
# folder or downloaded file belongs to that account, and Test-FolderTrust and
# the agent's own trust check refuse the installation as "owned by" someone
# else. The permissions: a move on the same volume keeps the security
# descriptor, so without the reset the binaries would keep the staging
# folder's SYSTEM-and-Administrators-only DACL, and `restow-agent status`
# would not start for other users (the self-update's files inherit the bin
# folder's permissions; both must end up the same). The owner comes first:
# the reset turns the CREATOR OWNER entry of Program Files into an entry for
# the owner, which must then be Administrators and not the account.
function Set-InstalledSecurity([string]$Path) {
    $ErrorActionPreference = 'Continue'
    $icacls = Join-Path ([Environment]::SystemDirectory) 'icacls.exe'
    if (Test-CanOwnAsAdministrators) {
        $null = & $icacls $Path /setowner '*S-1-5-32-544' /Q 2>&1
        if ($LASTEXITCODE -ne 0) { Stop-Installer "cannot make Administrators the owner of $Path (icacls exit code $LASTEXITCODE)" }
    }
    $null = & $icacls $Path /reset /Q 2>&1
    if ($LASTEXITCODE -ne 0) { Stop-Installer "cannot reset the permissions of $Path (icacls exit code $LASTEXITCODE)" }
}

# Get-ServiceProcessId returns the process id of the running service, or 0.
function Get-ServiceProcessId {
    if ($RestowState.SkipService) { return 0 }
    try {
        $cim = Get-CimInstance -ClassName Win32_Service -Filter "Name='$($RestowServiceName)'" -ErrorAction Stop
        if ($cim -and $cim.ProcessId) { return [int]$cim.ProcessId }
    } catch { }
    return 0
}

# Wait-AgentExit waits up to $Seconds until the service process $ProcessId
# (0: none) and every process started from $Exe have ended, and returns
# whether they did. While a backup ends (restic has up to 45 s) or a post hook
# runs, the agent's files cannot be deleted.
function Wait-AgentExit([int]$ProcessId, [string]$Exe, [int]$Seconds) {
    $deadline = (Get-Date).AddSeconds($Seconds)
    while ($true) {
        $left = @()
        if ($ProcessId -gt 0 -and (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)) { $left += $ProcessId }
        if ($Exe) {
            $left += @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path -eq $Exe } | ForEach-Object { $_.Id })
        }
        if ($left.Count -eq 0) { return $true }
        if ((Get-Date) -gt $deadline) { return $false }
        Start-Sleep -Milliseconds 500
    }
}

# Remove-FolderWithRetry removes a folder; a file that is still in use for a
# moment (the agent has just ended, an antivirus scan) gets a few more tries.
function Remove-FolderWithRetry([string]$Path, [int]$Seconds) {
    $deadline = (Get-Date).AddSeconds($Seconds)
    while ($true) {
        try {
            Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction Stop
            return
        } catch {
            if ((Get-Date) -gt $deadline) {
                Stop-Installer "cannot remove $Path ($($_.Exception.Message)). A program still uses a file in it; close it or restart Windows, then run the uninstall again."
            }
            Start-Sleep -Seconds 1
        }
    }
}

function Remove-RestowInstallation {
    Write-Step 'Removing the Restow agent'
    $agent = $RestowState.AgentExe
    $stillRunning = 'the Restow agent is still running (a backup or a hook may still be ending); nothing more was removed. Wait until it has ended, or stop the service RestowAgent, and run the uninstall again.'
    # Taken before the service is stopped: afterwards the service has no process id.
    $servicePid = Get-ServiceProcessId
    $usable = $false
    if (Test-Path -LiteralPath $agent -PathType Leaf) {
        try { Test-FolderTrust $RestowState.BinDir -Strict; $usable = $true } catch { Write-Warn $_.Exception.Message }
    }
    if ($usable) {
        # The agent stops the service and removes nothing while it still runs.
        $code = Invoke-Agent @('uninstall', '--yes', '--keep-binaries')
        if ($code -ne 0) {
            if (-not (Wait-AgentExit $servicePid $agent 120)) { Stop-Installer $stillRunning }
            $code = Invoke-Agent @('uninstall', '--yes', '--keep-binaries')
            if ($code -ne 0) { Write-Warn "restow-agent uninstall ended with exit code $code" }
        }
    } else {
        # The binary is missing or not trustworthy: remove by hand, never run it.
        if (-not $RestowState.SkipService) {
            $svc = Get-Service -Name $RestowServiceName -ErrorAction SilentlyContinue
            if ($svc) {
                # Stop-Service would wait without an end; the service gets 120 s.
                try { $svc.Stop() } catch { }
                try { $svc.WaitForStatus([System.ServiceProcess.ServiceControllerStatus]::Stopped, [TimeSpan]::FromSeconds(120)) } catch { }
                if (-not (Wait-AgentExit $servicePid '' 15)) { Stop-Installer $stillRunning }
                $cim = Get-CimInstance -ClassName Win32_Service -Filter "Name='$($RestowServiceName)'" -ErrorAction SilentlyContinue
                if ($cim) { $null = Invoke-CimMethod -InputObject $cim -MethodName Delete }
            }
        }
        if (Test-Path -LiteralPath $RestowState.DataRoot) {
            Test-FolderTrust $RestowState.DataRoot
            Remove-FolderWithRetry $RestowState.DataRoot 15
        }
    }
    if (Test-Path -LiteralPath $RestowState.InstallDir) {
        if (-not (Wait-AgentExit $servicePid $agent 60)) { Stop-Installer $stillRunning }
        Test-FolderTrust $RestowState.InstallDir
        Remove-FolderWithRetry $RestowState.InstallDir 15
        Write-Note "removed $($RestowState.InstallDir)"
    }
    Write-Host ''
    Write-Host 'The agent was removed from this computer. Backups stay on your Restow instance.'
    Write-Host 'Revoke this endpoint in the Restow UI (Endpoints) to finish the removal there.'
}

function Invoke-RestowInstaller([string]$HooksOption, [bool]$UninstallOption, [string]$ProxyOption, [string]$PinOption) {
    Set-StrictMode -Version 2
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'
    Enable-Tls12

    # Options from the environment (the iex form has no parameters).
    $hooks = $HooksOption
    if (-not $hooks -and $env:RESTOW_HOOKS) { $hooks = $env:RESTOW_HOOKS }
    $doUninstall = $UninstallOption -or ($env:RESTOW_UNINSTALL -eq '1')
    $proxy = $ProxyOption
    if (-not $proxy -and $env:RESTOW_PROXY) { $proxy = $env:RESTOW_PROXY }
    $pin = $PinOption
    if (-not $pin -and $env:RESTOW_RELEASE_KEY_FINGERPRINT) { $pin = $env:RESTOW_RELEASE_KEY_FINGERPRINT }
    if ($hooks -and @('off', 'scripts', 'any') -notcontains $hooks) { Stop-Installer '-Hooks must be off, scripts or any' }

    # Test knobs (development and CI only), as in linux.sh.
    $RestowState.InstallRoot = [string]$env:RESTOW_INSTALL_ROOT
    $RestowState.SkipService = [bool]$env:RESTOW_SKIP_SERVICE
    $allowHttp = [bool]$env:RESTOW_ALLOW_INSECURE_HTTP
    $allowUnsignedDev = [bool]$env:RESTOW_ALLOW_UNSIGNED_DEV
    $trustedSumsSha = ([string]$env:RESTOW_SHA256SUMS_SHA256).ToLowerInvariant()

    $url = $RestowInstanceUrl
    if ($url -like '*__RESTOW_*') {
        $url = [string]$env:RESTOW_URL
        if (-not $url) { Stop-Installer 'this file has not been prepared by your Restow instance. Download it from https://<your instance>/install/windows.ps1' }
    }
    $version = $RestowAgentVersion
    if ($version -like '*__RESTOW_*') { $version = [string]$env:RESTOW_VERSION }
    $key = $RestowReleaseKey
    if ($key -like '*__RESTOW_*') { $key = [string]$env:RESTOW_RELEASE_KEY }
    $url = $url.TrimEnd('/')

    # ---- 1. preconditions ------------------------------------------------------
    if ([Environment]::Is64BitOperatingSystem -and -not [Environment]::Is64BitProcess) {
        if ($env:RESTOW_INSTALLER_RELAUNCHED -eq '1') { Stop-Installer 'cannot start the 64-bit PowerShell' }
        # A 32-bit host (Intune and many RMM tools): start again in 64-bit
        # PowerShell; the options travel in the environment of the child.
        $childEnv = @{ RESTOW_INSTALLER_RELAUNCHED = '1' }
        if ($hooks) { $childEnv['RESTOW_HOOKS'] = $hooks }
        if ($doUninstall) { $childEnv['RESTOW_UNINSTALL'] = '1' }
        if ($proxy) { $childEnv['RESTOW_PROXY'] = $proxy }
        if ($pin) { $childEnv['RESTOW_RELEASE_KEY_FINGERPRINT'] = $pin }
        if ($env:RESTOW_TOKEN_FILE) { $childEnv['RESTOW_TOKEN_FILE'] = Get-RelaunchTokenFile $env:RESTOW_TOKEN_FILE $env:windir }
        $ps64 = Join-Path $env:windir 'Sysnative\WindowsPowerShell\v1.0\powershell.exe'
        if (-not (Test-Path -LiteralPath $ps64 -PathType Leaf)) { Stop-Installer "cannot start the 64-bit PowerShell ($ps64 does not exist)" }
        Write-Step 'Starting again in 64-bit PowerShell'
        if ($PSCommandPath) {
            $psArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath)
        } else {
            $cmd = "[Net.ServicePointManager]::SecurityProtocol = 'Tls12'; iex (irm -UseBasicParsing '$url/install/windows.ps1')"
            $psArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', $cmd)
        }
        # A non-interactive start stays one in the 64-bit PowerShell.
        if (Test-NonInteractiveHost) { $psArgs = @('-NonInteractive') + $psArgs }
        $code = Invoke-Relaunch $ps64 $psArgs $childEnv
        if ($code -ne 0) { Stop-Installer "the 64-bit installer ended with exit code $code" }
        return
    }
    if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') {
        Stop-Installer 'PowerShell runs in Constrained Language Mode (AppLocker or WDAC). Install the agent by hand as described in the Restow agent documentation.'
    }
    if ((-not $RestowState.InstallRoot) -and -not (Test-Elevated)) {
        Stop-Installer 'this installer must run in a PowerShell started as administrator (right-click > Run as administrator).'
    }
    if ([Environment]::OSVersion.Version.Build -lt 14393) {
        Stop-Installer 'the Restow agent needs Windows 10 1607 or Windows Server 2016 or newer.'
    }
    $arch = Get-SystemArchitecture
    if ($arch -eq 'ARM64') { Stop-Installer 'Windows on ARM is not supported in this version of Restow (no x64 restic with shadow copies there). Nothing was installed.' }
    if ($arch -ne 'AMD64') { Stop-Installer "unsupported processor architecture $arch (supported: x64)." }
    if ($proxy) {
        if ($proxy -match '^[a-zA-Z][a-zA-Z0-9+.-]*://[^/]*@') { Stop-Installer '-Proxy must not contain a user name or password (the service settings are readable by all users). Allow this computer on the proxy by its address instead.' }
        if ($proxy -notmatch '^https?://[^/\s]+/?$') { Stop-Installer '-Proxy must look like http://proxy.example.com:3128' }
        $RestowState.EffectiveProxy = $proxy
    } else {
        $RestowState.EffectiveProxy = ''
    }

    $programFiles = $env:ProgramW6432
    if (-not $programFiles) { $programFiles = [Environment]::GetFolderPath('ProgramFiles') }
    $programData = [Environment]::GetFolderPath('CommonApplicationData')
    if ($RestowState.InstallRoot) {
        $programFiles = Join-Path $RestowState.InstallRoot 'Program Files'
        $programData = Join-Path $RestowState.InstallRoot 'ProgramData'
        $null = New-Item -ItemType Directory -Force -Path $programFiles, $programData
    }
    $RestowState.InstallDir = Join-Path $programFiles 'Restow'
    $RestowState.BinDir = Join-Path $RestowState.InstallDir 'bin'
    $RestowState.AgentExe = Join-Path $RestowState.BinDir 'restow-agent.exe'
    $RestowState.DataRoot = Join-Path $programData 'Restow'
    $stateFile = Join-Path $RestowState.DataRoot 'state\state.json'
    if ($env:RESTOW_AGENT_DIR) { $stateFile = Join-Path $env:RESTOW_AGENT_DIR 'state\state.json' }

    if ($doUninstall) {
        Remove-RestowInstallation
        return
    }

    if ($url -notlike 'https://*') {
        if (-not ($allowHttp -and $url -like 'http://*')) { Stop-Installer "the instance URL must start with https:// ($url)" }
    }
    if (-not $version -or $version -notmatch '^[0-9A-Za-z.+-]+$') { Stop-Installer 'unknown or invalid agent version' }
    if ($key -and $key -notlike 'ssh-ed25519 *') { Stop-Installer 'the release signing key of this instance is not an ssh-ed25519 key' }

    $sacWarning = ''
    if (-not $RestowState.InstallRoot) {
        $sac = Get-SmartAppControlVerdict (Get-SmartAppControlState 'HKLM:\SYSTEM\CurrentControlSet\Control\CI\Policy')
        if ($sac.Stop) { Stop-Installer $sac.Stop }
        $sacWarning = $sac.Warn
    }

    # A token file that cannot be read stops the installer before anything is
    # installed (it is only needed when this computer is not enrolled yet).
    if ($env:RESTOW_TOKEN_FILE -and -not (Test-Path -LiteralPath $stateFile)) {
        $problem = Get-TokenFileProblem $env:RESTOW_TOKEN_FILE $env:windir
        if ($problem) { Stop-Installer "$problem. Nothing was installed." }
    }

    # ---- 3. folders: refuse what someone else may have prepared ------------------
    Test-FolderTrust $RestowState.DataRoot
    Test-FolderTrust $RestowState.InstallDir

    Write-Host "Restow agent installer for Windows (x64, preview)"
    Write-Host "Instance: $url"
    Write-Host "Version:  $version"
    Write-Host ''
    if ($sacWarning) { Write-Warn $sacWarning; Write-Host '' }

    if (-not (Test-Path -LiteralPath $RestowState.InstallDir)) {
        $null = New-Item -ItemType Directory -Path $RestowState.InstallDir
        Set-InstalledSecurity $RestowState.InstallDir
    }
    Test-FolderTrust $RestowState.InstallDir -Strict
    $stage = Join-Path $RestowState.InstallDir ('.stage-' + [Guid]::NewGuid().ToString('N').Substring(0, 16))
    New-PrivateFolder $stage
    try {
        # ---- 2. checksums and signature, before anything else -------------------
        $base = "$url/install/agent/$version"
        Write-Step 'Verifying the release signature'
        $sumsFile = Join-Path $stage 'SHA256SUMS'
        $sigFile = Join-Path $stage 'SHA256SUMS.sig'
        try { Invoke-Download "$base/SHA256SUMS" $sumsFile } catch { Stop-Installer ("cannot download $base/SHA256SUMS ($($_.Exception.Message))." + (Get-DownloadHint $_.Exception.Message $url)) }
        $haveSig = $true
        try { Invoke-Download "$base/SHA256SUMS.sig" $sigFile } catch { $haveSig = $false }
        $sumsBytes = [System.IO.File]::ReadAllBytes($sumsFile)
        if ($trustedSumsSha) {
            if ((Get-FileSha256 $sumsFile) -ne $trustedSumsSha) { Stop-Installer 'SHA256SUMS does not match RESTOW_SHA256SUMS_SHA256. Nothing was installed.' }
            Write-Note 'SHA256SUMS: matches the SHA-256 you verified (RESTOW_SHA256SUMS_SHA256)'
        } elseif (-not $key) {
            if (-not ((Test-DevVersion $version) -and $allowUnsignedDev)) { Stop-Installer 'this Restow instance has no release signing key, so the agent cannot be verified. Nothing was installed.' }
            Write-Warn "development build ${version}: the release signature is NOT checked (RESTOW_ALLOW_UNSIGNED_DEV)"
        } elseif (-not $haveSig) {
            if (-not ((Test-DevVersion $version) -and $allowUnsignedDev)) { Stop-Installer "agent $version on this instance is not signed (no SHA256SUMS.sig). Nothing was installed." }
            Write-Warn "development build $version is not signed; the signature is NOT checked (RESTOW_ALLOW_UNSIGNED_DEV)"
        } else {
            $fingerprint = Get-ReleaseKeyFingerprint $key
            if ($pin -and $pin -cne $fingerprint) {
                Stop-Installer "the release key of this instance is $fingerprint, not the pinned $pin. Nothing was installed."
            }
            $sigText = [System.IO.File]::ReadAllText($sigFile)
            $verdict = $false
            try { $verdict = Test-ReleaseSignature -Message $sumsBytes -SignatureText $sigText -KeyLine $key } catch { $verdict = $false }
            if (-not ($verdict -ceq $true)) { Stop-Installer 'the release signature does not match. The files may have been changed. Nothing was installed.' }
            Write-Note "signature: OK (release key $fingerprint)"
        }
        if ($pin -and -not $key) { Stop-Installer 'a release key fingerprint is pinned, but this instance has no release key. Nothing was installed.' }
        $sumsLines = [System.IO.File]::ReadAllLines($sumsFile)

        # ---- 4. download and check every file ------------------------------------
        Write-Step 'Downloading the agent and restic from your Restow instance'
        $target = 'windows-amd64'
        $files = @('restow-agent.exe', 'restic.exe')
        if (Get-SumsEntry $sumsLines "$target/THIRD_PARTY_NOTICES.txt") { $files += 'THIRD_PARTY_NOTICES.txt' }
        $expected = @{}
        foreach ($name in $files) {
            $want = Get-SumsEntry $sumsLines "$target/$name"
            if (-not $want) { Stop-Installer "SHA256SUMS has no entry for $target/$name. Nothing was installed." }
            $expected[$name] = $want
            $out = Join-Path $stage $name
            try { Invoke-Download "$base/$target/$name" $out } catch { Stop-Installer ("cannot download $base/$target/$name ($($_.Exception.Message))." + (Get-DownloadHint $_.Exception.Message $url)) }
            $have = Get-FileSha256 $out
            if ($have -ne $want) { Stop-Installer "checksum mismatch for $name (expected $want, got $have). Nothing was installed." }
            Write-Note "${name}: OK"
        }
        $reported = (& (Join-Path $stage 'restow-agent.exe') version --short | Out-String).Trim()
        if ($reported -ne $version) { Stop-Installer "the downloaded agent reports version '$reported', expected '$version'. Nothing was installed." }

        # ---- 5. install ------------------------------------------------------------
        $existing = Test-Path -LiteralPath $RestowState.AgentExe
        if ($existing) { Write-Step 'Existing installation found: repairing/upgrading' } else { Write-Step 'Installing' }
        if (-not $RestowState.SkipService) {
            $svc = Get-Service -Name $RestowServiceName -ErrorAction SilentlyContinue
            if ($svc -and $svc.Status -ne 'Stopped') { Stop-Service -Name $RestowServiceName -Force }
        }
        if (-not (Test-Path -LiteralPath $RestowState.BinDir)) {
            $null = New-Item -ItemType Directory -Path $RestowState.BinDir
            Set-InstalledSecurity $RestowState.BinDir
        }
        Test-FolderTrust $RestowState.BinDir -Strict
        foreach ($name in @('restic.exe', 'restow-agent.exe')) {
            $dest = Join-Path $RestowState.BinDir $name
            if (Test-Path -LiteralPath $dest) {
                # A running .exe cannot be overwritten but renamed.
                $aside = "$dest.prev"
                if ($name -eq 'restic.exe') { $aside = "$dest.old-" + [Guid]::NewGuid().ToString('N').Substring(0, 16) }
                if (Test-Path -LiteralPath $aside) { Remove-Item -LiteralPath $aside -Force -ErrorAction SilentlyContinue }
                Move-Item -LiteralPath $dest -Destination $aside -Force
                if ($name -eq 'restic.exe') { Remove-Item -LiteralPath $aside -Force -ErrorAction SilentlyContinue }
            }
            Move-Item -LiteralPath (Join-Path $stage $name) -Destination $dest
            Set-InstalledSecurity $dest
            Write-Note $dest
        }
        if ($files -contains 'THIRD_PARTY_NOTICES.txt') {
            $notices = Join-Path $RestowState.InstallDir 'THIRD_PARTY_NOTICES.txt'
            Move-Item -LiteralPath (Join-Path $stage 'THIRD_PARTY_NOTICES.txt') -Destination $notices -Force
            Set-InstalledSecurity $notices
        }
        # The files at their final place, once more, right before anything runs them.
        foreach ($name in @('restow-agent.exe', 'restic.exe')) {
            if ((Get-FileSha256 (Join-Path $RestowState.BinDir $name)) -ne $expected[$name]) { Stop-Installer "$name changed after the download. The installation is not trustworthy; run the installer again." }
        }
        if ($RestowState.InstallRoot) { $env:RESTOW_RESTIC_PATH = Join-Path $RestowState.BinDir 'restic.exe' }

        # ---- 6. event source ---------------------------------------------------------
        if (-not $RestowState.InstallRoot) {
            try {
                if (-not [System.Diagnostics.EventLog]::SourceExists('Restow')) { [System.Diagnostics.EventLog]::CreateEventSource('Restow', 'Application') }
            } catch { Write-Warn "cannot register the event source Restow ($($_.Exception.Message)); events are still written" }
        }

        # ---- 7. service and enrollment ---------------------------------------------------
        if (-not $RestowState.SkipService) {
            Write-Step 'Installing the Windows service RestowAgent'
            if ((Invoke-Agent @('service', 'install')) -ne 0) { Stop-Installer 'the service could not be installed (see above)' }
            $svcKey = "HKLM:\SYSTEM\CurrentControlSet\Services\$($RestowServiceName)"
            if ($proxy) {
                $null = New-ItemProperty -Path $svcKey -Name Environment -PropertyType MultiString -Force -Value @("HTTPS_PROXY=$proxy", "HTTP_PROXY=$proxy", 'NO_PROXY=localhost,127.0.0.1,::1')
                Write-Note "proxy for the service: $proxy"
            }
        }
        $credentials = Get-EnrollmentCredentials $stateFile
        if ($credentials.State -eq 'readable') {
            Write-Step 'This computer is already enrolled; keeping the existing enrollment'
            if ($hooks) {
                $code = Invoke-Agent @('hooks', $hooks)
                if ($code -ne 0) { Stop-Installer "the hook policy could not be set to $hooks (restow-agent hooks ended with exit code $code; see its message above)." }
                Write-Note "hooks from the Restow server: $hooks"
            }
        } else {
            $enrollArgs = @('enroll')
            if ($credentials.State -eq 'unreadable') {
                $why = $credentials.Error
                if (-not $why) { $why = 'no reason given' }
                Write-Warn "the existing enrollment in $stateFile cannot be read ($why); this computer has to be enrolled again with a new token"
                $enrollArgs += '--force'
            }
            $token = Read-EnrollmentToken
            if (-not $token) {
                if ($credentials.State -eq 'unreadable') {
                    Stop-Installer "the existing enrollment of this computer cannot be read ($why), and no enrollment token was given. Create a new token in the Restow UI (Endpoints) and run the install command again with it; the agent then enrolls again (restow-agent enroll --force)."
                }
                Stop-Installer 'this computer is not enrolled and no enrollment token was given. Create a server or client in the Restow UI (Endpoints) and run the command shown there.'
            }
            Write-Step 'Enrolling this computer'
            if ($allowHttp) { $enrollArgs += '--allow-insecure-http' }
            if ($hooks) { $enrollArgs += "--hooks=$hooks" }
            # The token goes to the agent through the environment of this one command.
            $env:RESTOW_TOKEN = $token
            $env:RESTOW_URL = $url
            try { $code = Invoke-Agent $enrollArgs } finally { Remove-Item Env:RESTOW_TOKEN -ErrorAction SilentlyContinue; $token = '' }
            if ($code -ne 0) {
                $systemProxy = ''
                if ($code -eq 5 -and -not $RestowState.EffectiveProxy) { $systemProxy = Get-SystemProxy $url }
                Stop-Installer (Get-EnrollFailureText $code $url $RestowState.EffectiveProxy $systemProxy)
            }
            if ($env:RESTOW_TOKEN_FILE) {
                # The token is used up; do not leave it lying around.
                Remove-Item -LiteralPath $env:RESTOW_TOKEN_FILE -Force -ErrorAction SilentlyContinue
            }
        }

        if (-not $RestowState.SkipService) {
            Write-Step 'Starting the service'
            if ((Invoke-Agent @('service', 'restart')) -ne 0) { Stop-Installer 'the service did not start (see C:\ProgramData\Restow\logs\agent.log)' }
        }
    } finally {
        # ---- 8. clean up -----------------------------------------------------------------
        if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue }
    }

    Write-Host ''
    Write-Host "Done. The Restow agent $version is installed and enrolled."
    Write-Host ''
    $null = Invoke-Agent @('status')
    Write-Host ''
    Write-Host 'Next: the first backup runs at the time set in the Restow UI (you can start one there with "Back up now").'
    Write-Host "Hooks:   & '$($RestowState.AgentExe)' hooks --help   (in a PowerShell started as administrator)"
    Write-Host 'Logs:    C:\ProgramData\Restow\logs\agent.log   and the Application event log, source Restow'
    Write-Host "Remove:  & ([scriptblock]::Create((irm -UseBasicParsing '$url/install/windows.ps1'))) -Uninstall"
    $sqlHint = @(Get-SqlLoginHint @(Get-SqlInstanceNames))
    if ($sqlHint.Count -gt 0) {
        Write-Host ''
        foreach ($line in $sqlHint) { Write-Host $line }
    }
    if ($sacWarning) {
        Write-Host ''
        Write-Warn $sacWarning
    }
}

# The tests load the functions without running the installer.
if ($env:RESTOW_INSTALLER_NO_MAIN -ne '1') {
    Invoke-RestowInstaller -HooksOption $Hooks -UninstallOption ([bool]$Uninstall) -ProxyOption $Proxy -PinOption $ReleaseKeyFingerprint
}
