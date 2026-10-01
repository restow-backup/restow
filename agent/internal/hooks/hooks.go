//go:build unix

// Package hooks runs the pre and post backup commands configured on the
// server (for example a database dump before the backup), but only as far as
// the machine's own hook policy allows (policy.go): off by default, named
// root-owned scripts, or any shell command (/bin/sh -c). Hooks run as the
// agent's user (root) with a reduced environment, a hard timeout, and their
// output goes to the run log.
package hooks

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"time"

	"github.com/restow-backup/restow/agent/internal/procenv"
)

// Default timeouts. The server configuration has no timeout field; these are
// generous enough for database dumps and short enough not to block backups
// forever.
const (
	PreTimeout  = 60 * time.Minute
	PostTimeout = 30 * time.Minute
)

const (
	// termGrace is how long a hook gets between SIGTERM and SIGKILL.
	termGrace = 10 * time.Second
	// maxLine bounds one captured output line.
	maxLine = 16 * 1024
)

// Kind is "pre" or "post".
type Kind string

const (
	Pre  Kind = "pre"
	Post Kind = "post"
)

// Options describes one hook run.
type Options struct {
	Kind Kind
	// Argv is the command line (from Resolve). Without it, Command runs
	// through /bin/sh -c.
	Argv    []string
	Command string
	Timeout time.Duration
	// Env is appended to the reduced base environment (RESTOW_* variables).
	Env []string
	// Output receives each line of stdout and stderr.
	Output func(line string)
}

// Result is the outcome of a hook.
type Result struct {
	ExitCode int
	TimedOut bool
	Duration time.Duration
}

// Error describes a failed hook.
type Error struct {
	Kind     Kind
	ExitCode int
	TimedOut bool
	Timeout  time.Duration
}

func (e *Error) Error() string {
	if e.TimedOut {
		return fmt.Sprintf("%s hook did not finish within %s and was stopped", e.Kind, e.Timeout)
	}
	return fmt.Sprintf("%s hook failed with exit code %d", e.Kind, e.ExitCode)
}

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

func readLines(r io.Reader, out func(string)) {
	if out == nil {
		_, _ = io.Copy(io.Discard, r)
		return
	}
	br := bufio.NewReaderSize(r, 32*1024)
	var acc []byte
	for {
		chunk, err := br.ReadSlice('\n')
		if len(acc)+len(chunk) <= maxLine {
			acc = append(acc, chunk...)
		}
		if err == bufio.ErrBufferFull {
			continue
		}
		if err == nil || (err == io.EOF && len(acc) > 0) {
			if line := string(bytes.TrimRight(acc, "\r\n")); line != "" {
				out(line)
			}
			acc = acc[:0]
		}
		if err != nil {
			return
		}
	}
}
