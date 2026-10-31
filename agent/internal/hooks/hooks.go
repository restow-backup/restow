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
	"fmt"
	"io"
	"time"
)

// Default timeouts. The server configuration has no timeout field; these are
// generous enough for database dumps and short enough not to block backups
// forever.
const (
	PreTimeout  = 60 * time.Minute
	PostTimeout = 30 * time.Minute
)

// maxLine bounds one captured output line.
const maxLine = 16 * 1024

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
	// Hint explains a known cause (Windows: the execution policy).
	Hint string
}

func (e *Error) Error() string {
	if e.TimedOut {
		return fmt.Sprintf("%s hook did not finish within %s and was stopped", e.Kind, e.Timeout)
	}
	if e.Hint != "" {
		return fmt.Sprintf("%s hook failed with exit code %d: %s", e.Kind, e.ExitCode, e.Hint)
	}
	return fmt.Sprintf("%s hook failed with exit code %d", e.Kind, e.ExitCode)
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
