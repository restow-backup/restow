//go:build unix

package main

import (
	"fmt"
	"os"
)

// isPrivileged: the agent runs as root.
func isPrivileged() bool { return os.Geteuid() == 0 }

func notPrivilegedMessage(cmd string) string {
	return fmt.Sprintf("restow-agent %s must run as root (it reads all files and stores root-only secrets). Try: sudo restow-agent %s", cmd, cmd)
}

// adminHint is how an administrator runs an agent command on this system.
func adminHint(cmd string) string { return "sudo restow-agent " + cmd }

const (
	credentialProtection = "mode 0600, readable by root only"
	scriptRequirement    = "executable scripts (owner root, not writable by others)"
	superuser            = "root"
)
