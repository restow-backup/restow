//go:build windows

package restic

import (
	"os/exec"
	"syscall"

	"github.com/restow-backup/restow/agent/internal/procctl"
)

// configureProcess starts restic in its own process group on the agent's
// console (no CREATE_NO_WINDOW: a separate hidden console would not receive
// the event), so a cancelled context can send CTRL_BREAK to restic alone.
// restic stops cleanly (repository lock, shadow copy) and exits with 130;
// after CancelGrace it is killed.
func configureProcess(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: syscall.CREATE_NEW_PROCESS_GROUP}
	cmd.Cancel = func() error { return procctl.CtrlBreak(cmd.Process.Pid) }
}

// afterStart puts restic into a Job Object. The returned function closes the
// job after restic ended, which ends anything restic left behind (and restic
// itself, should the agent die first).
func afterStart(cmd *exec.Cmd) (func(), error) {
	job, err := procctl.Attach(cmd.Process)
	if err != nil {
		return func() {}, err
	}
	return job.Close, nil
}
