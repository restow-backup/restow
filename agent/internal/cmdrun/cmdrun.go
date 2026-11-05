// Package cmdrun runs the system tools the bare-metal capture and the file
// system snapshots need (lsblk, sfdisk, lvm, btrfs, cryptsetup, ...): no
// shell, a binary from a fixed list of root-owned directories, a time limit
// per call, a cap on the output, and the allowlisted environment with
// LC_ALL=C so the output is parseable. Commands that would print key
// material are refused on every path (Forbidden), also by the fake used in
// tests.
package cmdrun

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/restow-backup/restow/agent/internal/procenv"
)

// Runner runs one command and returns its standard output. A command that
// exits non-zero returns its output so far and an *ExitError.
type Runner interface {
	Run(ctx context.Context, name string, args ...string) ([]byte, error)
}

// Defaults of ExecRunner.
const (
	DefaultTimeout   = 30 * time.Second
	DefaultMaxOutput = 4 << 20
	// StateChangeTimeout is the limit of a command that changes state
	// (RunNoKill): lvcreate and lvremove suspend the origin and flush its
	// file system, which takes long under heavy I/O.
	StateChangeTimeout = 10 * time.Minute
)

// NoKillRunner is a Runner that can run a command that must never be
// killed: at its time limit it gets SIGTERM and is then waited for, it
// never gets SIGKILL, and the caller's cancellation does not reach it.
// lvcreate, lvchange and lvremove run this way: SIGKILL during their
// suspend/resume window can leave the origin LV (often /) suspended and
// the machine frozen (lvm2 blocks only catchable signals in its critical
// sections).
type NoKillRunner interface {
	RunNoKill(ctx context.Context, timeout time.Duration, name string, args ...string) ([]byte, error)
}

// RunNoKill runs a state-changing command through r without the caller's
// cancellation: with RunNoKill when r has it, otherwise (test doubles)
// with Run and a context that is not cancelled.
func RunNoKill(ctx context.Context, r Runner, timeout time.Duration, name string, args ...string) ([]byte, error) {
	ctx = context.WithoutCancel(ctx)
	if nk, ok := r.(NoKillRunner); ok {
		return nk.RunNoKill(ctx, timeout, name, args...)
	}
	return r.Run(ctx, name, args...)
}

// ToolDirs are the directories tools are taken from; PATH is not searched.
var ToolDirs = []string{"/usr/sbin", "/sbin", "/usr/bin", "/bin"}

// ErrForbidden is returned for a command that could print key material.
var ErrForbidden = errors.New("command refused: it could print key material")

// ErrOutputTooLarge is returned when a command prints more than the cap.
var ErrOutputTooLarge = errors.New("command output exceeds the limit")

// ErrNotFound is returned when a tool is not installed in ToolDirs.
var ErrNotFound = exec.ErrNotFound

// forbiddenArgs may never appear in a command line (docs/BAREMETAL.md, 4.1
// and 6.6): they print the volume key or the header with its keyslots.
var forbiddenArgs = []string{"--dump-volume-key", "--dump-master-key", "luksHeaderBackup", "--showkeys"}

// Forbidden returns ErrForbidden when argv (name and arguments) contains an
// argument that could print key material.
func Forbidden(argv []string) error {
	for _, a := range argv {
		for _, f := range forbiddenArgs {
			if a == f || strings.HasPrefix(a, f+"=") {
				return fmt.Errorf("%w: %s", ErrForbidden, f)
			}
		}
	}
	return nil
}

// ExitError is a command that ran and exited non-zero.
type ExitError struct {
	Argv   []string
	Code   int
	Stderr string
}

func (e *ExitError) Error() string {
	msg := strings.TrimSpace(e.Stderr)
	if len(msg) > 512 {
		msg = msg[:512] + "..."
	}
	if msg == "" {
		return fmt.Sprintf("%s exited with code %d", strings.Join(e.Argv, " "), e.Code)
	}
	return fmt.Sprintf("%s exited with code %d: %s", strings.Join(e.Argv, " "), e.Code, msg)
}

// ExecRunner runs real commands.
type ExecRunner struct {
	// Timeout per call; 0 selects DefaultTimeout.
	Timeout time.Duration
	// MaxOutput caps stdout; 0 selects DefaultMaxOutput.
	MaxOutput int
	// Dirs replaces ToolDirs (tests).
	Dirs []string
}

// Resolve finds a tool in the root-owned directories.
func (r ExecRunner) Resolve(name string) (string, error) {
	if strings.ContainsRune(name, '/') {
		return "", fmt.Errorf("%s: tool names must not contain a path", name)
	}
	dirs := r.Dirs
	if dirs == nil {
		dirs = ToolDirs
	}
	for _, d := range dirs {
		p := filepath.Join(d, name)
		if st, err := os.Stat(p); err == nil && st.Mode().IsRegular() && st.Mode()&0o111 != 0 {
			return p, nil
		}
	}
	return "", fmt.Errorf("%s: %w", name, ErrNotFound)
}

// Run runs name with args. At the time limit or on cancellation the
// command is killed (read-only commands).
func (r ExecRunner) Run(ctx context.Context, name string, args ...string) ([]byte, error) {
	return r.run(ctx, r.Timeout, false, name, args...)
}

// RunNoKill runs a state-changing command: the caller's cancellation does
// not reach it, at the time limit (0 selects StateChangeTimeout) it gets
// SIGTERM and is waited for until it exits; it is never killed.
func (r ExecRunner) RunNoKill(ctx context.Context, timeout time.Duration, name string, args ...string) ([]byte, error) {
	if timeout == 0 {
		timeout = StateChangeTimeout
	}
	return r.run(ctx, timeout, true, name, args...)
}

func (r ExecRunner) run(ctx context.Context, timeout time.Duration, noKill bool, name string, args ...string) ([]byte, error) {
	argv := append([]string{name}, args...)
	if err := Forbidden(argv); err != nil {
		return nil, err
	}
	bin, err := r.Resolve(name)
	if err != nil {
		return nil, err
	}
	if timeout == 0 {
		timeout = DefaultTimeout
	}
	max := r.MaxOutput
	if max == 0 {
		max = DefaultMaxOutput
	}
	out := &capped{max: max}
	var stderr bytes.Buffer
	if noKill {
		return runNoKill(timeout, bin, argv, out, &stderr)
	}
	cctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := exec.CommandContext(cctx, bin, args...)
	cmd.Env = procenv.Set(procenv.Base(), "LC_ALL", "C")
	cmd.Stdin = nil
	cmd.Stdout = out
	cmd.Stderr = &limitedWriter{w: &stderr, n: 64 << 10}
	cmd.WaitDelay = 5 * time.Second
	err = cmd.Run()
	if out.over {
		return out.buf.Bytes(), fmt.Errorf("%s: %w (%d bytes)", name, ErrOutputTooLarge, max)
	}
	if err != nil {
		if cctx.Err() != nil && ctx.Err() == nil {
			return out.buf.Bytes(), fmt.Errorf("%s did not finish within %s", name, timeout)
		}
		return out.buf.Bytes(), exitErr(argv, err, &stderr)
	}
	return out.buf.Bytes(), nil
}

// runNoKill runs without a context, so exec never kills the command: at
// the time limit a timer sends SIGTERM and Wait goes on until it exits.
// WaitDelay then bounds only the wait for the output pipes after the exit
// (a daemon lvm starts, such as dmeventd, could hold them open).
func runNoKill(timeout time.Duration, bin string, argv []string, out *capped, stderr *bytes.Buffer) ([]byte, error) {
	cmd := exec.Command(bin, argv[1:]...)
	cmd.Env = procenv.Set(procenv.Base(), "LC_ALL", "C")
	cmd.Stdin = nil
	cmd.Stdout = out
	cmd.Stderr = &limitedWriter{w: stderr, n: 64 << 10}
	cmd.WaitDelay = 5 * time.Second
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	var timedOut atomic.Bool
	timer := time.AfterFunc(timeout, func() {
		timedOut.Store(true)
		_ = cmd.Process.Signal(syscall.SIGTERM)
	})
	err := cmd.Wait()
	timer.Stop()
	name := argv[0]
	if out.over {
		return out.buf.Bytes(), fmt.Errorf("%s: %w (%d bytes)", name, ErrOutputTooLarge, out.max)
	}
	if err != nil {
		if timedOut.Load() {
			return out.buf.Bytes(), fmt.Errorf("%s did not finish within %s and was stopped with SIGTERM", name, timeout)
		}
		return out.buf.Bytes(), exitErr(argv, err, stderr)
	}
	return out.buf.Bytes(), nil
}

func exitErr(argv []string, err error, stderr *bytes.Buffer) error {
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		return &ExitError{Argv: argv, Code: ee.ExitCode(), Stderr: stderr.String()}
	}
	return err
}

type capped struct {
	buf  bytes.Buffer
	max  int
	over bool
}

func (c *capped) Write(p []byte) (int, error) {
	if c.over {
		return len(p), nil
	}
	if c.buf.Len()+len(p) > c.max {
		c.over = true
		return len(p), nil
	}
	return c.buf.Write(p)
}

type limitedWriter struct {
	w io.Writer
	n int
}

func (l *limitedWriter) Write(p []byte) (int, error) {
	if l.n <= 0 {
		return len(p), nil
	}
	q := p
	if len(q) > l.n {
		q = q[:l.n]
	}
	l.n -= len(q)
	_, err := l.w.Write(q)
	return len(p), err
}

// IsNotFound reports whether err means the tool is not installed.
func IsNotFound(err error) bool {
	return errors.Is(err, exec.ErrNotFound) || errors.Is(err, os.ErrNotExist)
}

// ExitCode returns the exit code of err, or -1.
func ExitCode(err error) int {
	var ee *ExitError
	if errors.As(err, &ee) {
		return ee.Code
	}
	return -1
}
