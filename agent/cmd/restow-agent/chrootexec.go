//go:build linux

package main

import (
	"io"

	"github.com/restow-backup/restow/agent/internal/recovery"
)

// cmdChrootExec is the hidden helper that runs a program of the restored
// system in isolation (docs/BAREMETAL.md 10.14); recover starts it.
func cmdChrootExec(args []string, stderr io.Writer) int {
	return recovery.ChrootExecCommand(args, stderr)
}
