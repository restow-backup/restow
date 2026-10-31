//go:build windows && windowsintegration

package hooks

import (
	"context"
	"errors"
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
