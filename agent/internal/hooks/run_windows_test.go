//go:build windows && windowsintegration

package hooks

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestPowerShellExitCodes(t *testing.T) {
	for cmd, want := range map[string]int{
		"Write-Output ok":                    0,
		"Write-Output ok # trailing comment": 0,
		"exit 5":                             5,
		"cmd /c exit 7":                      7,
		"Write-Error 'broken'":               1,
		"Get-Item C:\\does-not-exist-restow": 1,
		"throw 'broken'":                     1,
		"does-not-exist-restow.exe":          1,
		// A native program's stderr is no failure under Windows PowerShell
		// 5.1 (K110): only its exit code counts.
		`cmd /c "echo warn 1>&2 & exit 0"`:                           0,
		`cmd /c "echo warn 1>&2 & exit 4"`:                           4,
		`cmd /c "echo warn 1>&2"; exit 3`:                            3,
		`cmd /c "echo warn 1>&2" 2>&1`:                               0,
		`cmd /c "echo warn 1>&2"; Write-Output after`:                0,
		`cmd /c "echo warn 1>&2"; Get-Item C:\does-not-exist-restow`: 1,
		`$x = cmd /c "echo warn 1>&2 & echo out" 2>&1; $x`:           0,
		// Statement-terminating errors (a .NET method exception, a failed
		// conversion, a division by zero) reach the trap without
		// $ErrorActionPreference = 'Stop': a dump that throws is no success
		// because a later statement succeeded.
		`[IO.File]::ReadAllText('C:\does-not-exist-restow'); Write-Output after`:                                                                                                          1,
		`Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory('C:\does-not-exist-restow', "$env:TEMP\restow-x.zip"); Write-Output done`: 1,
		`[int]'not a number'; Write-Output after`:                                      1,
		`$zero = 0; 1 / $zero; Write-Output after`:                                     1,
		`& { [IO.File]::ReadAllText('C:\does-not-exist-restow') }; Write-Output after`: 1,
	} {
		res, err := Run(context.Background(), Options{Kind: Pre, Command: cmd, Timeout: time.Minute})
		if res.ExitCode != want {
			t.Errorf("%q: exit %d (%v), want %d", cmd, res.ExitCode, err, want)
		}
		if (want == 0) != (err == nil) {
			t.Errorf("%q: err %v", cmd, err)
		}
	}
}

// The trap of the wrapper prints the error that stopped the hook, so the run
// log says why the pre hook failed.
func TestPowerShellTrapPrintsTheError(t *testing.T) {
	var lines []string
	res, err := Run(context.Background(), Options{Kind: Pre, Command: "Write-Output before; Get-Item C:\\does-not-exist-restow; Write-Output after",
		Timeout: time.Minute, Output: func(l string) { lines = append(lines, l) }})
	if res.ExitCode != 1 || err == nil {
		t.Fatalf("exit %d, err %v", res.ExitCode, err)
	}
	out := strings.Join(lines, "\n")
	if !strings.Contains(out, "before") || strings.Contains(out, "after") || !strings.Contains(out, "does-not-exist-restow") {
		t.Fatalf("output %q", out)
	}
}

func TestHookTimeoutEndsTheTree(t *testing.T) {
	start := time.Now()
	_, err := Run(context.Background(), Options{Kind: Pre, Command: "cmd /c start /b ping -n 60 127.0.0.1; Start-Sleep 60", Timeout: 3 * time.Second})
	var he *Error
	if !errors.As(err, &he) || !he.TimedOut {
		t.Fatalf("err %v", err)
	}
	if time.Since(start) > 20*time.Second {
		t.Fatalf("the hook was not stopped in time: %s", time.Since(start))
	}
}
