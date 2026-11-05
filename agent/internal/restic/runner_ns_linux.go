//go:build linux

package restic

import (
	"os/exec"
	"syscall"
)

// newMountNS starts the command in a new mount namespace; the Go runtime
// makes / private in the child, so nothing it mounts reaches the host.
func newMountNS(cmd *exec.Cmd) error {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.Unshareflags |= syscall.CLONE_NEWNS
	// restic in the snapshot tree dies with the agent, so the snapshots it
	// holds open can be removed when the agent starts again (6.5).
	cmd.SysProcAttr.Pdeathsig = syscall.SIGKILL
	return nil
}
