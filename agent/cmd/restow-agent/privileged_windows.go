//go:build windows

package main

import (
	"fmt"

	"github.com/restow-backup/restow/agent/internal/paths"
	"github.com/restow-backup/restow/agent/internal/winapi"
)

// isPrivileged: the service (LocalSystem) or an elevated administrator. An
// administrator without elevation (UAC) is not privileged.
func isPrivileged() bool {
	if sid, err := winapi.CurrentUserSID(); err == nil && sid == winapi.SIDLocalSystem {
		return true
	}
	elevated, err := winapi.TokenElevated()
	return err == nil && elevated
}

func notPrivilegedMessage(cmd string) string {
	return fmt.Sprintf("restow-agent %s must run in a PowerShell or Command Prompt started as administrator "+
		"(right-click > Run as administrator): it reads all files and stores secrets only administrators may read. Then: %s",
		cmd, adminHint(cmd))
}

// adminHint is how an administrator runs an agent command on this system.
func adminHint(cmd string) string { return "& '" + paths.InstalledAgentBinary() + "' " + cmd }

const (
	credentialProtection = "secrets encrypted with DPAPI, folder readable by SYSTEM and Administrators only"
	scriptRequirement    = "PowerShell scripts (.ps1) or programs (.exe) that only administrators can change"
	superuser            = "SYSTEM"
)
