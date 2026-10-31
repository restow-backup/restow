//go:build windows

package hooks

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/restow-backup/restow/agent/internal/procctl"
	"github.com/restow-backup/restow/agent/internal/procenv"
	"github.com/restow-backup/restow/agent/internal/winapi"
)

// powerShellExe is Windows PowerShell 5.1 from the system folder.
func powerShellExe() (string, error) {
	sys, err := winapi.SystemDirectory()
	if err != nil {
		return "", err
	}
	return filepath.Join(sys, "WindowsPowerShell", "v1.0", "powershell.exe"), nil
}

// Run executes the hook and waits for it (docs/WINDOWS-AGENT.md, section
// 12.2). The hook runs without a window in its own process group and its own
// Job Object. A timeout or a cancelled run ends the whole job at once (no
// grace period: CTRL_BREAK does not reach a process without a console of the
// agent, and PowerShell does not react to it reliably). After a normal end the
// job is released, so background processes the hook started live on, as on
// Unix. A non-zero exit or a timeout is reported as *Error.
func Run(ctx context.Context, o Options) (Result, error) {
	argv := o.Argv
	if len(argv) == 0 {
		if strings.TrimSpace(o.Command) == "" {
			return Result{}, nil
		}
		ps, err := powerShellExe()
		if err != nil {
			return Result{}, fmt.Errorf("cannot start %s hook: %w", o.Kind, err)
		}
		argv = PowerShellArgv(ps, o.Command)
	}
	timeout := o.Timeout
	if timeout <= 0 {
		timeout = PreTimeout
	}
	hctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Env = append(procenv.Base(), o.Env...)
	if sys, err := winapi.SystemDirectory(); err == nil {
		cmd.Dir = sys
	}
	cmd.Stdin = nil
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: syscall.CREATE_NEW_PROCESS_GROUP | winapi.CreateNoWindow}

	pr, pw, err := os.Pipe()
	if err != nil {
		return Result{}, err
	}
	cmd.Stdout, cmd.Stderr = pw, pw

	start := time.Now()
	if err := cmd.Start(); err != nil {
		_ = pr.Close()
		_ = pw.Close()
		return Result{}, fmt.Errorf("cannot start %s hook: %w", o.Kind, err)
	}
	_ = pw.Close()
	job, attachErr := procctl.Attach(cmd.Process)

	var policyBlocked atomic.Bool
	readDone := make(chan struct{})
	go func() {
		defer close(readDone)
		readLines(pr, func(line string) {
			if ExecutionPolicyBlocked(line) {
				policyBlocked.Store(true)
			}
			if o.Output != nil {
				o.Output(line)
			}
		})
	}()

	waitDone := make(chan error, 1)
	go func() { waitDone <- cmd.Wait() }()

	var waitErr error
	timedOut := false
	select {
	case waitErr = <-waitDone:
		if job != nil {
			job.Release()
		}
	case <-hctx.Done():
		timedOut = errors.Is(hctx.Err(), context.DeadlineExceeded)
		if job != nil {
			_ = job.Terminate()
		} else {
			_ = cmd.Process.Kill()
		}
		waitErr = <-waitDone
		if job != nil {
			job.Close()
		}
	}
	select {
	case <-readDone:
	case <-time.After(2 * time.Second):
		_ = pr.Close()
		<-readDone
	}
	_ = pr.Close()

	res := Result{Duration: time.Since(start), TimedOut: timedOut}
	if cmd.ProcessState != nil {
		res.ExitCode = cmd.ProcessState.ExitCode()
	}
	if attachErr != nil {
		return res, fmt.Errorf("%s hook: %w", o.Kind, attachErr)
	}
	if timedOut {
		return res, &Error{Kind: o.Kind, TimedOut: true, Timeout: timeout, ExitCode: res.ExitCode}
	}
	if ctx.Err() != nil {
		return res, ctx.Err()
	}
	if waitErr != nil {
		e := &Error{Kind: o.Kind, ExitCode: res.ExitCode}
		if policyBlocked.Load() {
			e.Hint = executionPolicyHint
		}
		return res, e
	}
	return res, nil
}
