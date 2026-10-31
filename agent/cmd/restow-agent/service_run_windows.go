//go:build windows

package main

import (
	"context"
	"fmt"
	"io"

	"github.com/restow-backup/restow/agent/internal/procctl"
	"github.com/restow-backup/restow/agent/internal/svc"
	"github.com/restow-backup/restow/agent/internal/winsvc"
)

var (
	// serviceConsole: the service could give itself a console, so restic can
	// be asked to stop with CTRL_BREAK (docs/WINDOWS-AGENT.md, section 9.2).
	serviceConsole = true
	// inWindowsService: this process runs as the service.
	inWindowsService = false
)

// runService runs the agent as the Windows service RestowAgent. Stopping
// comes only from the service control manager; a self-update ends the
// service with the service-specific code 3, so the failure action starts the
// new binary.
func runService(debug bool, stderr io.Writer) int {
	inWindowsService = true
	serviceConsole = procctl.EnsureConsole()
	err := winsvc.Run(svc.WindowsServiceName, func(ctx context.Context) winsvc.Exit {
		code, restart := runAgent(ctx, debug, true)
		switch {
		case restart:
			return winsvc.Exit{Specific: svc.RestartExitCode}
		case code != exitOK:
			return winsvc.Exit{Code: 1}
		}
		return winsvc.Exit{}
	})
	if err != nil {
		fmt.Fprintln(stderr, err)
		return exitError
	}
	return exitOK
}
