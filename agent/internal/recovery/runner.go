package recovery

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/restow-backup/restow/agent/internal/cmdrun"
	"github.com/restow-backup/restow/agent/internal/redact"
	"github.com/restow-backup/restow/agent/internal/restic"
)

// Exec runs a program of the ISO for a plan step or an operation.
type Exec interface {
	Run(ctx context.Context, spec RunSpec) (RunResult, error)
}

// RunSpec is one call. Stdin is never logged; StdinSecret marks it as a
// passphrase or key.
type RunSpec struct {
	Argv        []string
	Stdin       []byte
	StdinSecret bool
	// Timeout of the call (0: 30 minutes).
	Timeout time.Duration
	// NoKill: the call is never killed (state changes: lvm, mdadm,
	// cryptsetup, mkfs, sfdisk); at the time limit it gets SIGTERM.
	NoKill bool
}

// RunResult is the output of a call (stdout).
type RunResult struct {
	Output []byte
}

// DefaultStepTimeout bounds a step that is not a restore.
const DefaultStepTimeout = 30 * time.Minute

// InputRunner is a cmdrun runner with input and the no-kill path
// (cmdrun.ExecRunner, cmdrun.FakeRunner).
type InputRunner interface {
	cmdrun.InputRunner
	RunInputNoKill(ctx context.Context, stdin []byte, timeout time.Duration, maxOut int, name string, args ...string) ([]byte, error)
}

// CmdExec runs calls through a cmdrun runner and logs each command line
// and its output, redacted (stdin never).
type CmdExec struct {
	Runner InputRunner
	Log    func(string)
}

// Run implements Exec.
func (c CmdExec) Run(ctx context.Context, s RunSpec) (RunResult, error) {
	if len(s.Argv) == 0 {
		return RunResult{}, errors.New("empty command")
	}
	timeout := s.Timeout
	if timeout == 0 {
		timeout = DefaultStepTimeout
	}
	c.log("$ " + strings.Join(s.Argv, " "))
	var out []byte
	var err error
	stdin := s.Stdin
	if stdin == nil {
		stdin = []byte{}
	}
	if s.NoKill {
		out, err = c.Runner.RunInputNoKill(ctx, stdin, timeout, 0, s.Argv[0], s.Argv[1:]...)
	} else {
		out, err = c.Runner.RunInput(ctx, stdin, timeout, 0, s.Argv[0], s.Argv[1:]...)
	}
	n := 0
	for _, l := range bytes.Split(bytes.TrimRight(out, "\n"), []byte("\n")) {
		if len(l) == 0 {
			continue
		}
		if n++; n > 200 {
			c.log("  ... (output cut)")
			break
		}
		c.log("  " + string(l))
	}
	if err != nil {
		c.log("  error: " + err.Error())
	}
	return RunResult{Output: out}, err
}

func (c CmdExec) log(s string) {
	if c.Log != nil {
		c.Log(redact.Redact(s))
	}
}

// ResticRestorer runs the restore steps.
type ResticRestorer interface {
	Restore(ctx context.Context, args []string, onProgress func(restic.Progress)) (*RestoreOutcome, error)
}

// RestoreOutcome is how a restore ended: the files that could not be
// restored (at most a hundred, and their count) and restic's summary.
type RestoreOutcome struct {
	ExitCode   int
	Items      []restic.ItemError
	ItemCount  int
	Summary    restic.RestoreSummary
	FatalError string
}

// ResticExec runs restore steps with a restic.Runner.
type ResticExec struct {
	Runner *restic.Runner
}

// Restore runs `restic <args>` (args without the binary).
func (r ResticExec) Restore(ctx context.Context, args []string, onProgress func(restic.Progress)) (*RestoreOutcome, error) {
	if len(args) == 0 || args[0] != "restore" {
		return nil, fmt.Errorf("not a restore: %q", args)
	}
	out := &RestoreOutcome{}
	res, err := r.Runner.Command(ctx, restic.CommandOptions{Name: "restore", Args: args, OnStdoutLine: func(line []byte) {
		if p, ok := restic.ParseRestoreStatus(line); ok && onProgress != nil {
			onProgress(p)
		}
		if s, ok := restic.ParseRestoreSummary(line); ok {
			out.Summary = s
		}
	}})
	if err != nil {
		return nil, err
	}
	out.ExitCode, out.Items, out.ItemCount = res.ExitCode, res.Items, res.ItemCount
	if e := res.Err(); e != nil {
		out.FatalError = e.Error()
	}
	return out, nil
}
