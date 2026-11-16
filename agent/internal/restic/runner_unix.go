//go:build unix

package restic

import (
	"os/exec"
	"syscall"
)

// configureProcess makes a cancelled context send SIGINT; restic then stops
// cleanly and is only killed after CancelGrace.
func configureProcess(cmd *exec.Cmd) {
	cmd.Cancel = func() error { return cmd.Process.Signal(syscall.SIGINT) }
}

// afterStart has nothing to do on Unix.
func afterStart(*exec.Cmd) (func(), error) { return func() {}, nil }
