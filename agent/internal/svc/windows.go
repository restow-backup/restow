package svc

// Shared, system-independent parts of the Windows service (scm_windows.go,
// uninstall_windows.go), tested on every system.

import (
	"strings"

	"github.com/restow-backup/restow/agent/internal/paths"
)

// Identifiers of the Windows service.
const (
	WindowsServiceName    = "RestowAgent"
	WindowsServiceDisplay = "Restow Agent"
	windowsDescription    = "Backs up this computer to its Restow instance (restic). Restow agent."
	// RestartExitCode is the service-specific exit code after a self-update:
	// the service control manager restarts a service only after a failure, so
	// the agent ends with ERROR_SERVICE_SPECIFIC_ERROR and this code, and the
	// failure action starts the new binary (docs/WINDOWS-AGENT.md, section 9.3).
	RestartExitCode = 3
)

// windowsPrivileges is the reduced privilege list of the service
// (SERVICE_CONFIG_REQUIRED_PRIVILEGES_INFO): the service control manager
// removes every other privilege from the LocalSystem token, so restic and
// hooks never hold SeDebugPrivilege, SeTcbPrivilege, SeLoadDriverPrivilege or
// SeAssignPrimaryTokenPrivilege. Whether VSS works with exactly this list is
// checked on a real machine (docs/WINDOWS-AGENT.md, section 22.3).
var windowsPrivileges = []string{
	"SeBackupPrivilege", "SeRestorePrivilege", "SeSecurityPrivilege", "SeTakeOwnershipPrivilege",
	"SeCreateSymbolicLinkPrivilege", "SeChangeNotifyPrivilege", "SeImpersonatePrivilege",
	"SeCreateGlobalPrivilege", "SeManageVolumePrivilege",
}

// Failure actions: restart after 5 s, 30 s and 60 s; the counter resets after a day.
var windowsRestartDelaysMS = []uint32{5000, 30000, 60000}

const windowsFailureResetSeconds = 24 * 60 * 60

// windowsPreshutdownMS is how long the agent may take to stop at shutdown.
const windowsPreshutdownMS = 60000

// windowsCommandLine is the program line of the service: the path always in
// quotes (an unquoted path with spaces is the "unquoted service path" hole).
func windowsCommandLine(exe string) string { return `"` + exe + `" run --service` }

// programFromCommandLine returns the program of a service command line: the
// quoted first part, or the first word of an unquoted one.
func programFromCommandLine(cmdline string) string {
	cmdline = strings.TrimSpace(cmdline)
	if strings.HasPrefix(cmdline, `"`) {
		if end := strings.IndexByte(cmdline[1:], '"'); end >= 0 {
			return cmdline[1 : 1+end]
		}
		return strings.Trim(cmdline, `"`)
	}
	if i := strings.IndexByte(cmdline, ' '); i >= 0 {
		return cmdline[:i]
	}
	return cmdline
}

// windowsConfig is what the agent compares to decide whether an installed
// service needs to be brought in line (Refresh).
type windowsConfig struct {
	CommandLine       string
	StartType         uint32
	Delayed           bool
	StartName         string
	Dependencies      []string
	LoadOrderGroup    string
	Restarts          []uint32
	ResetSeconds      uint32
	NonCrashFailures  bool
	Privileges        []string
	SidUnrestricted   bool
	PreshutdownMillis uint32
}

func wantedWindowsConfig(exe string) windowsConfig {
	return windowsConfig{
		CommandLine: windowsCommandLine(exe), StartType: 2, Delayed: true, StartName: "LocalSystem",
		Restarts: windowsRestartDelaysMS, ResetSeconds: windowsFailureResetSeconds, NonCrashFailures: true,
		Privileges: windowsPrivileges, SidUnrestricted: true, PreshutdownMillis: windowsPreshutdownMS,
	}
}

// windowsConfigDiffers reports what differs between an installed and the
// wanted configuration ("" when nothing does). Names compare without regard
// to case, as Windows does.
func windowsConfigDiffers(have, want windowsConfig) string {
	switch {
	case !strings.EqualFold(programFromCommandLine(have.CommandLine), programFromCommandLine(want.CommandLine)) ||
		!strings.HasPrefix(strings.TrimSpace(have.CommandLine), `"`) ||
		!strings.HasSuffix(strings.TrimSpace(have.CommandLine), " run --service"):
		return "program"
	case have.StartType != want.StartType || have.Delayed != want.Delayed:
		return "start type"
	case !strings.EqualFold(have.StartName, want.StartName) && !strings.EqualFold(have.StartName, `NT AUTHORITY\SYSTEM`) &&
		!strings.EqualFold(have.StartName, `.\LocalSystem`):
		return "account"
	case len(have.Dependencies) > 0 || have.LoadOrderGroup != "":
		return "dependencies"
	case !equalUint32(have.Restarts, want.Restarts) || have.ResetSeconds != want.ResetSeconds || have.NonCrashFailures != want.NonCrashFailures:
		return "failure actions"
	case !sameFold(have.Privileges, want.Privileges):
		return "privileges"
	case have.SidUnrestricted != want.SidUnrestricted:
		return "service SID"
	case have.PreshutdownMillis != want.PreshutdownMillis:
		return "shutdown timeout"
	}
	return ""
}

func equalUint32(a, b []uint32) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func sameFold(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	seen := map[string]int{}
	for _, s := range a {
		seen[strings.ToLower(s)]++
	}
	for _, s := range b {
		k := strings.ToLower(s)
		if seen[k] == 0 {
			return false
		}
		seen[k]--
	}
	return true
}

// windowsProtected reports whether dir must never be removed by an uninstall
// (docs/WINDOWS-AGENT.md, section 9.4): drive roots, the Windows folder, the
// program folders, ProgramData and the users' folder, compared without regard
// to case. Anything that is not a plain drive path is refused as well.
func windowsProtected(dir string, systemDirs []string) bool {
	drive, parts, err := paths.SplitDrivePath(dir)
	if err != nil || len(parts) == 0 {
		return true
	}
	clean := paths.JoinDrivePath(drive, parts...)
	for _, p := range systemDirs {
		if p != "" && strings.EqualFold(strings.TrimRight(p, `\`), clean) {
			return true
		}
	}
	// C:\Users and C:\Windows on any drive, whatever the known folders say.
	if len(parts) == 1 && (strings.EqualFold(parts[0], "Users") || strings.EqualFold(parts[0], "Windows")) {
		return true
	}
	return false
}
