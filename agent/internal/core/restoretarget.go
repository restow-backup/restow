package core

// Restore target rules for Windows that need no system call
// (docs/WINDOWS-AGENT.md, section 18.1, steps 1 and 4); util_windows.go adds
// the volume, trust and creation steps. Without a build tag, so the rules are
// tested on every system.

import (
	"strings"

	"github.com/restow-backup/restow/agent/internal/paths"
)

// windowsTargetForm checks the form of a Windows restore target: a canonical
// local drive path below a drive root (paths.SplitDrivePath), not the root
// itself. It returns the drive and the components.
func windowsTargetForm(target string) (string, []string, error) {
	drive, parts, err := paths.SplitDrivePath(target)
	if err != nil {
		return "", nil, targetFail("invalid_task", "the restore target %s; use a local folder such as D:\\Restore", err)
	}
	if len(parts) == 0 {
		return "", nil, targetFail("invalid_task", "refusing to restore into the drive root %q", target)
	}
	return drive, parts, nil
}

// windowsTargetBlocked reports whether a resolved target lies in or below a
// folder a restore must never write to: the Windows folder, the program
// folders, the agent's own data folder, or any System Volume Information
// (SYSTEM restores original owners and permissions, which would make
// user-writable trees inside administrator folders).
func windowsTargetBlocked(resolved string, blocked []string) bool {
	for _, b := range blocked {
		if b != "" && paths.WinPathEqualOrBelow(resolved, b) {
			return true
		}
	}
	for _, part := range strings.Split(resolved, `\`) {
		if strings.EqualFold(part, "System Volume Information") {
			return true
		}
	}
	return false
}
