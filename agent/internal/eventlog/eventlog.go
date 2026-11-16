// Package eventlog writes security-relevant events of the agent to the
// Windows event log (Application log, source "Restow"; docs/WINDOWS-AGENT.md,
// section 9.5): outside the agent's own files, as journald is on Linux. On
// Linux and macOS the functions do nothing; journald and the unified log
// already have the log lines.
package eventlog

// Source is the event source the installer registers.
const Source = "Restow"

// Fixed event ids (the text is English, like the log).
const (
	IDEnrolled          = 1000
	IDHookModeChanged   = 1001
	IDTrustRefused      = 1002
	IDStateRepaired     = 1003
	IDUpdateInstalled   = 1004
	IDUpdateRejected    = 1005
	IDRestoreTarget     = 1006
	IDUninstalled       = 1007
	IDServiceConfigured = 1008
)

// Info writes an informational event.
func Info(id uint32, message string) { report(levelInfo, id, message) }

// Warning writes a warning.
func Warning(id uint32, message string) { report(levelWarning, id, message) }

// Error writes an error.
func Error(id uint32, message string) { report(levelError, id, message) }

const (
	levelInfo = iota
	levelWarning
	levelError
)
