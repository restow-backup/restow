package hooks

import (
	"encoding/base64"
	"strings"
	"testing"
	"unicode/utf16"
)

func decodePS(t *testing.T, enc string) string {
	t.Helper()
	b, err := base64.StdEncoding.DecodeString(enc)
	if err != nil || len(b)%2 != 0 {
		t.Fatalf("%v %d", err, len(b))
	}
	u := make([]uint16, len(b)/2)
	for i := range u {
		u[i] = uint16(b[2*i]) | uint16(b[2*i+1])<<8
	}
	return string(utf16.Decode(u))
}

func TestPowerShellWrapper(t *testing.T) {
	for _, cmd := range []string{
		`Stop-Service X; Copy-Item C:\fehlt C:\x`,
		"sqlcmd -Q \"BACKUP DATABASE [db] TO DISK='D:\\b.bak'\" # Kommentar am Ende",
		"exit 5",
		"Write-Output 'Grüße €'",
	} {
		argv := PowerShellArgv(`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`, cmd)
		if argv[len(argv)-2] != "-EncodedCommand" || !strings.Contains(strings.Join(argv, " "), "-ExecutionPolicy Bypass") {
			t.Fatalf("%q", argv)
		}
		script := decodePS(t, argv[len(argv)-1])
		lines := strings.Split(script, "\n")
		if lines[0] != "[Console]::OutputEncoding = [Text.Encoding]::UTF8" || lines[1] != "$ErrorActionPreference = 'Stop'" {
			t.Fatalf("preamble: %q", lines[:2])
		}
		if lines[2] != cmd {
			t.Fatalf("command line %q, want %q", lines[2], cmd)
		}
		// The exit line stands alone after the command, so a trailing comment cannot hide it.
		if lines[3] != "exit $(if ($?) { 0 } elseif ($LASTEXITCODE) { $LASTEXITCODE } else { 1 })" {
			t.Fatalf("exit line %q", lines[3])
		}
	}
}

func TestPowerShellScriptCommand(t *testing.T) {
	if got := PowerShellScriptCommand(`C:\ProgramData\Restow\state\hooks.d\o'brien.ps1`); got != `& 'C:\ProgramData\Restow\state\hooks.d\o''brien.ps1'` {
		t.Fatal(got)
	}
}

func TestWindowsScriptKind(t *testing.T) {
	for name, want := range map[string]string{"dump.ps1": "ps1", "DUMP.PS1": "ps1", "tool.exe": "exe", "x.cmd": "", "x.bat": "", "x": "", "x.ps1.txt": ""} {
		if got := WindowsScriptKind(name); got != want {
			t.Errorf("%s: %q", name, got)
		}
	}
}

func TestExecutionPolicyBlocked(t *testing.T) {
	if !ExecutionPolicyBlocked(`File C:\x.ps1 cannot be loaded because running scripts is disabled on this system.`) ||
		!ExecutionPolicyBlocked("+ FullyQualifiedErrorId : UnauthorizedAccess") ||
		!ExecutionPolicyBlocked("Die Datei kann nicht geladen werden, da die Ausführung von Skripts auf diesem System deaktiviert ist.") {
		t.Fatal("not recognised")
	}
	if ExecutionPolicyBlocked("dump finished") {
		t.Fatal("false positive")
	}
	e := &Error{Kind: Pre, ExitCode: 1, Hint: executionPolicyHint}
	if !strings.Contains(e.Error(), "execution policy") {
		t.Fatal(e.Error())
	}
}
