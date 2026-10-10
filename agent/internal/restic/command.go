package restic

import (
	"context"
	"encoding/json"
	"errors"
	"io"
)

// This file exposes restic's command line to callers that build their own
// arguments (restow-share, docs/FILESHARES.md 4.4 and 4.7): the backup and
// restore of a file share use flags the endpoint agent does not (--parent,
// --read-concurrency, --exclude-xattr, --delete, snapshot:subfolder). The
// rules stay the same: arguments never carry a secret (the repository and its
// credentials travel in the environment, see Env), and the per-item errors
// restic reports are collected the same way as for Backup and Restore.

// CommandOptions describes one restic invocation.
type CommandOptions struct {
	// Name is the restic subcommand for error messages (backup, restore, dump).
	Name string
	// Args is the complete argument vector after the binary.
	Args []string
	// OnStdoutLine receives every stdout line (restic's --json output).
	// Ignored when Stdout is set.
	OnStdoutLine func(line []byte)
	// Stdout receives stdout unchanged (restic dump).
	Stdout io.Writer
}

// CommandResult is what an invocation ended with.
type CommandResult struct {
	ExitCode int
	// Items are the per-item errors restic reported (at most a hundred, in
	// its order); ItemCount counts all of them.
	Items     []ItemError
	ItemCount int

	res *execResult
	cmd string
}

// Err is the *Error of a failed invocation (any exit code but 0 and 3);
// nil when the invocation succeeded.
func (c *CommandResult) Err() *Error {
	if c.ExitCode == 0 || c.ExitCode == ExitIncomplete {
		return nil
	}
	e := failure(c.cmd, c.res)
	e.Items, e.ItemCount = c.Items, c.ItemCount
	return e
}

// Command runs restic with o.Args. A non-nil error means restic could not be
// started or the context ended; restic's own failures are in the result
// (see CommandResult.Err). Item errors on stdout or stderr are collected.
func (r *Runner) Command(ctx context.Context, o CommandOptions) (*CommandResult, error) {
	if len(o.Args) == 0 {
		return nil, errors.New("restic: no arguments")
	}
	items := &itemErrors{r: r}
	spec := execSpec{Command: o.Name, Args: o.Args, OnStderrError: items.add, RawStdout: o.Stdout}
	if o.Stdout == nil {
		spec.OnStdoutLine = func(line []byte) {
			if peekType(line) == msgError {
				items.add(line)
				return
			}
			if o.OnStdoutLine != nil {
				o.OnStdoutLine(line)
			}
		}
	}
	xr, err := r.exec(ctx, spec)
	if err != nil {
		return nil, err
	}
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	return &CommandResult{ExitCode: xr.ExitCode, Items: items.kept, ItemCount: items.count, res: xr, cmd: o.Name}, nil
}

// MessageType is the message_type of one line of restic's --json output, or
// "" for a line that is not such a message.
func MessageType(line []byte) string { return peekType(line) }

// ParseBackupStatus reads a backup `status` line.
func ParseBackupStatus(line []byte) (Progress, bool) {
	var st backupStatus
	if peekType(line) != msgStatus || json.Unmarshal(line, &st) != nil {
		return Progress{}, false
	}
	p := Progress{FilesDone: st.FilesDone, BytesDone: st.BytesDone, TotalFiles: st.TotalFiles,
		TotalBytes: st.TotalBytes, Percent: st.PercentDone}
	if len(st.CurrentFiles) > 0 {
		p.CurrentPath = st.CurrentFiles[0]
	}
	return p, true
}

// ParseRestoreStatus reads a restore `status` line.
func ParseRestoreStatus(line []byte) (Progress, bool) {
	var st restoreStatus
	if peekType(line) != msgStatus || json.Unmarshal(line, &st) != nil {
		return Progress{}, false
	}
	return Progress{FilesDone: st.FilesRestored, BytesDone: st.BytesRestored,
		TotalFiles: st.TotalFiles, TotalBytes: st.TotalBytes, Percent: st.PercentDone}, true
}

// ParseBackupSummary reads a backup `summary` line.
func ParseBackupSummary(line []byte) (BackupSummary, bool) {
	var s BackupSummary
	if peekType(line) != msgSummary || json.Unmarshal(line, &s) != nil {
		return BackupSummary{}, false
	}
	return s, true
}

// ParseRestoreSummary reads a restore `summary` line.
func ParseRestoreSummary(line []byte) (RestoreSummary, bool) {
	var s RestoreSummary
	if peekType(line) != msgSummary || json.Unmarshal(line, &s) != nil {
		return RestoreSummary{}, false
	}
	return s, true
}

// ExcludeFileLine prepares one pattern for --exclude-file / --iexclude-file
// (whitespace trimmed, `$` doubled); ok is false for a pattern that cannot be
// represented (empty, a comment, a line break or NUL in it).
func ExcludeFileLine(pattern string) (string, bool) { return excludeFileLine(pattern) }
