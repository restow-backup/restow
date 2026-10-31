// Package winsvc is the main program of the agent as a Windows service
// (`restow-agent run --service`, docs/WINDOWS-AGENT.md, section 9.2): it
// connects to the service control manager, reports the service states and
// turns a stop or a shutdown into a cancelled context. On other systems Run
// reports that there is no service control manager.
package winsvc

import "context"

// Exit is how the service ends.
type Exit struct {
	// Code is the Win32 exit code (0 for a normal end).
	Code uint32
	// Specific is the service-specific exit code, used when Code is
	// ERROR_SERVICE_SPECIFIC_ERROR (1066).
	Specific uint32
}

// Main is the work of the service. It must return soon after ctx ends.
type Main func(ctx context.Context) Exit

// ErrNotService is returned by Run when the process was not started by the
// service control manager.
type ErrNotService struct{ Err error }

func (e *ErrNotService) Error() string {
	return "this command only runs as the Windows service RestowAgent (started by the service control manager); " +
		"use `restow-agent service start`, or `restow-agent run` without --service for a run in this window: " + e.Err.Error()
}

func (e *ErrNotService) Unwrap() error { return e.Err }
