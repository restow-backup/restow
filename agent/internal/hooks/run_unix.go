//go:build unix

package hooks

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"time"

	"github.com/restow-backup/restow/agent/internal/procenv"
)

// termGrace is how long a hook gets between SIGTERM and SIGKILL.
const termGrace = 10 * time.Second

// Run executes the hook and waits for it. A non-zero exit or a timeout is
// reported as *Error; the Result is always filled in.
func Run(ctx context.Context, o Options) (Result, error) {
	argv := o.Argv
	if len(argv) == 0 {
		if strings.TrimSpace(o.Command) == "" {
			return Result{}, nil
		}
		argv = []string{"/bin/sh", "-c", o.Command}
	}
	timeout := o.Timeout
	if timeout <= 0 {
		timeout = PreTimeout
	}
	hctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Env = append(procenv.Base(), o.Env...)
	cmd.Dir = "/"
	cmd.Stdin = nil
	// Own process group so a timeout can stop the whole tree, not only the shell.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}

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
	_ = pw.Close() // the child holds its own copy

	readDone := make(chan struct{})
	go func() {
		defer close(readDone)
		readLines(pr, o.Output)
	}()

	waitDone := make(chan error, 1)
	go func() { waitDone <- cmd.Wait() }()

	var waitErr error
	timedOut := false
	select {
	case waitErr = <-waitDone:
	case <-hctx.Done():
		timedOut = errors.Is(hctx.Err(), context.DeadlineExceeded)
		pgid := cmd.Process.Pid
		_ = syscall.Kill(-pgid, syscall.SIGTERM)
		select {
		case waitErr = <-waitDone:
		case <-time.After(termGrace):
			_ = syscall.Kill(-pgid, syscall.SIGKILL)
			waitErr = <-waitDone
		}
		// Anything the hook left behind in its group.
		_ = syscall.Kill(-pgid, syscall.SIGKILL)
	}
	// The reader ends when every writer of the pipe is gone; a background
	// process started by the hook can hold it, so do not wait forever.
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
	if timedOut {
		return res, &Error{Kind: o.Kind, TimedOut: true, Timeout: timeout, ExitCode: res.ExitCode}
	}
	if ctx.Err() != nil {
		return res, ctx.Err()
	}
	if waitErr != nil {
		return res, &Error{Kind: o.Kind, ExitCode: res.ExitCode}
	}
	return res, nil
}
