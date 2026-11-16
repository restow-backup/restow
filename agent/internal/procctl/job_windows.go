//go:build windows

package procctl

import (
	"fmt"
	"os"
	"sync"
	"syscall"

	"github.com/restow-backup/restow/agent/internal/winapi"
)

// Job is a Job Object holding one child process (and what it starts).
type Job struct {
	mu     sync.Mutex
	handle syscall.Handle
}

// Attach creates a job with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE and assigns the
// started process to it. When that fails the process is terminated, so no
// child runs outside a job; the caller still waits for it.
func Attach(p *os.Process) (*Job, error) {
	job, err := winapi.CreateJobObject()
	if err != nil {
		_ = p.Kill()
		return nil, fmt.Errorf("cannot create a job object: %w", err)
	}
	j := &Job{handle: job}
	if err := j.setKillOnClose(true); err != nil {
		j.Close()
		_ = p.Kill()
		return nil, fmt.Errorf("cannot configure the job object: %w", err)
	}
	ph, err := syscall.OpenProcess(winapi.ProcessSetQuota|winapi.ProcessTerminate, false, uint32(p.Pid))
	if err != nil {
		j.Close()
		_ = p.Kill()
		return nil, fmt.Errorf("cannot open the child process: %w", err)
	}
	defer syscall.CloseHandle(ph)
	if err := winapi.AssignProcessToJobObject(job, ph); err != nil {
		_ = syscall.TerminateProcess(ph, 1)
		j.Close()
		return nil, fmt.Errorf("cannot put the child process into a job object: %w", err)
	}
	return j, nil
}

func (j *Job) setKillOnClose(on bool) error {
	var info winapi.JobObjectExtendedLimitInformation
	if on {
		info.BasicLimitInformation.LimitFlags = winapi.JobObjectLimitKillOnJobClose
	}
	return winapi.SetJobLimits(j.handle, &info)
}

// Terminate ends every process in the job.
func (j *Job) Terminate() error {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.handle == 0 {
		return nil
	}
	return winapi.TerminateJobObject(j.handle, 1)
}

// Release lets the processes still in the job live on (a hook's background
// process, as on Unix) and closes the job.
func (j *Job) Release() {
	j.mu.Lock()
	h := j.handle
	j.mu.Unlock()
	if h != 0 {
		_ = j.setKillOnClose(false)
	}
	j.Close()
}

// Close closes the job handle; with KILL_ON_JOB_CLOSE still set, Windows ends
// every process left in it.
func (j *Job) Close() {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.handle != 0 {
		_ = syscall.CloseHandle(j.handle)
		j.handle = 0
	}
}

// CtrlBreak sends CTRL_BREAK to the process group of pid (a child started
// with CREATE_NEW_PROCESS_GROUP on the agent's console). A Go program such as
// restic sees it as os.Interrupt.
func CtrlBreak(pid int) error {
	return winapi.GenerateConsoleCtrlEvent(winapi.CtrlBreakEvent, uint32(pid))
}

// EnsureConsole gives the process a console if it has none (a service starts
// without one; the console of session 0 is invisible). It reports whether a
// console is there afterwards; without one restic can only be stopped hard.
func EnsureConsole() bool {
	if err := winapi.AllocConsole(); err != nil && !winapi.IsErrno(err, winapi.ErrorAccessDenied) {
		return false
	}
	n, err := winapi.ConsoleProcessCount()
	return err == nil && n >= 1
}
