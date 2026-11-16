package main

import (
	"github.com/restow-backup/restow/agent/internal/svc"
	"github.com/restow-backup/restow/agent/internal/winsvc"
)

// Service-specific exit codes of the Windows service (docs/WINDOWS-AGENT.md,
// section 9.2). The service control manager writes a service-specific code
// into event 7024 as a Windows message ("%%<code>"), so a plain 1 read
// "Incorrect function" and a plain 2 "The system cannot find the file
// specified", as the Win32 exit code 1 did before. Codes with bit 29 set are
// reserved for applications and have no Windows message: the event shows the
// number, which the documentation explains. 3 (the restart after a
// self-update) stays as it is; the failure action restarts the service on any
// of them.
const (
	serviceExitError  = 0x20000001 // 536870913: the agent stopped with an error (agent.log says which)
	serviceExitConfig = 0x20000002 // 536870914: a usage or configuration error
)

// serviceExit maps the result of runAgent to the exit the service reports.
func serviceExit(code int, restart bool) winsvc.Exit {
	switch {
	case restart:
		return winsvc.Exit{Specific: svc.RestartExitCode}
	case code == exitOK:
		return winsvc.Exit{}
	case code == exitUsage:
		return winsvc.Exit{Specific: serviceExitConfig}
	}
	return winsvc.Exit{Specific: serviceExitError}
}
