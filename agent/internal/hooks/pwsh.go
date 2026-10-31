package hooks

// The PowerShell wrapper of hooks on Windows (docs/WINDOWS-AGENT.md, section
// 12.2). Plain functions without a build tag, so the exact text is tested on
// every system; the exit codes themselves are checked on Windows.

import (
	"encoding/base64"
	"strings"
	"unicode/utf16"
)

// powerShellPreamble and powerShellExit surround every hook command. A
// command that ends in a comment cannot swallow the exit line, because each
// part stands on its own line. powershell.exe -Command would turn any native
// exit code into 0 or 1 and pass over non-terminating errors; with the
// wrapper a failing cmdlet stops the hook (exit 1), a native program's code is
// kept (cmd /c exit 7 gives 7) and an own `exit 5` gives 5.
const (
	powerShellPreamble = "[Console]::OutputEncoding = [Text.Encoding]::UTF8\n$ErrorActionPreference = 'Stop'\n"
	powerShellExit     = "\nexit $(if ($?) { 0 } elseif ($LASTEXITCODE) { $LASTEXITCODE } else { 1 })\n"
)

// WrapPowerShell returns the script a hook command runs as.
func WrapPowerShell(command string) string {
	return powerShellPreamble + command + powerShellExit
}

// EncodePowerShell encodes a script for -EncodedCommand: base64 of UTF-16LE.
// This sidesteps every quoting rule of the Windows command line.
func EncodePowerShell(script string) string {
	u := utf16.Encode([]rune(script))
	b := make([]byte, 2*len(u))
	for i, c := range u {
		b[2*i] = byte(c)
		b[2*i+1] = byte(c >> 8)
	}
	return base64.StdEncoding.EncodeToString(b)
}

// PowerShellArgv is the command line of a hook command under Windows
// PowerShell 5.1 (powershell.exe from the system folder, never from PATH).
func PowerShellArgv(powershellExe, command string) []string {
	return []string{powershellExe, "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
		"-EncodedCommand", EncodePowerShell(WrapPowerShell(command))}
}

// PowerShellScriptCommand is the command that runs a .ps1 file by its path
// inside the wrapper (the call operator with a single-quoted literal, not
// -File, so the same exit code rules apply).
func PowerShellScriptCommand(path string) string {
	return "& '" + strings.ReplaceAll(path, "'", "''") + "'"
}

// WindowsScriptKind returns how a script in the hooks folder runs on Windows:
// "ps1" or "exe", or "" for anything else (.cmd and .bat are not run in 0.5.0;
// a .ps1 can call them).
func WindowsScriptKind(name string) string {
	lower := strings.ToLower(name)
	switch {
	case strings.HasSuffix(lower, ".ps1"):
		return "ps1"
	case strings.HasSuffix(lower, ".exe"):
		return "exe"
	}
	return ""
}

// executionPolicyMarkers are the texts PowerShell prints when a group policy
// (MachinePolicy or UserPolicy, which -ExecutionPolicy Bypass cannot override)
// forbids running scripts: the error id and the English and German messages.
var executionPolicyMarkers = []string{
	"PSSecurityException", "UnauthorizedAccess", "running scripts is disabled on this system",
	"is not digitally signed", "die Ausführung von Skripts auf diesem System deaktiviert",
	"Ausführung von Skripts", "nicht digital signiert",
}

// ExecutionPolicyBlocked reports whether a line of hook output says that the
// PowerShell execution policy refused a script.
func ExecutionPolicyBlocked(line string) bool {
	for _, m := range executionPolicyMarkers {
		if strings.Contains(line, m) {
			return true
		}
	}
	return false
}

// executionPolicyHint is added to a failed hook whose output showed the
// refusal. The agent never works around a group policy.
const executionPolicyHint = "PowerShell refused to run the script because of the execution policy set by a group policy " +
	"(AllSigned or Restricted); sign the script or ask the administrator of the policy"
