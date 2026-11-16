package main

import (
	"testing"

	"github.com/restow-backup/restow/agent/internal/svc"
	"github.com/restow-backup/restow/agent/internal/winsvc"
)

// The service never ends with a Win32 exit code: Windows would explain a 1 as
// "Incorrect function" (K117). Every failure is a service-specific code
// (winsvc turns it into ERROR_SERVICE_SPECIFIC_ERROR), and only the restart
// after an update uses 3.
func TestServiceExit(t *testing.T) {
	for _, tc := range []struct {
		code    int
		restart bool
		want    winsvc.Exit
	}{
		{exitOK, false, winsvc.Exit{}},
		{exitOK, true, winsvc.Exit{Specific: svc.RestartExitCode}},
		{exitError, false, winsvc.Exit{Specific: serviceExitError}},
		{exitUsage, false, winsvc.Exit{Specific: serviceExitConfig}},
		{exitPartial, false, winsvc.Exit{Specific: serviceExitError}},
	} {
		got := serviceExit(tc.code, tc.restart)
		if got != tc.want {
			t.Errorf("code %d restart %v: %+v, want %+v", tc.code, tc.restart, got, tc.want)
		}
		if got.Code != 0 {
			t.Errorf("code %d: a Win32 exit code %d", tc.code, got.Code)
		}
	}
	// Application codes (bit 29) have no Windows message; 3 stays the restart.
	for _, c := range []uint32{serviceExitError, serviceExitConfig} {
		if c&0x20000000 == 0 || c == svc.RestartExitCode {
			t.Errorf("code %#x", c)
		}
	}
}
