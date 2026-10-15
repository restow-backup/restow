package restic

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
)

// msgChange is the message_type of one entry of `restic diff --json`.
const msgChange = "change"

// DiffChange is one entry of `restic diff --json`: a path and how it changed.
// Modifier is "+" (added), "-" (removed), or a combination of "T" (type),
// "M" (content) and "U" (metadata only) for a path in both snapshots.
// Directories end in "/".
type DiffChange struct {
	Path     string `json:"path"`
	Modifier string `json:"modifier"`
}

// ParseDiffChange reads one `change` line of `restic diff --json`.
func ParseDiffChange(line []byte) (DiffChange, bool) {
	if peekType(line) != msgChange {
		return DiffChange{}, false
	}
	var c DiffChange
	if json.Unmarshal(line, &c) != nil || c.Path == "" || c.Modifier == "" {
		return DiffChange{}, false
	}
	return c, true
}

// DiffArgs is the command line of a diff between two snapshots. It reads
// metadata (the trees) only and takes no lock.
func DiffArgs(from, to string) []string {
	return []string{"diff", "--json", "--no-lock", from, to}
}

// Diff runs `restic diff` between two snapshots and calls fn for every
// change, in restic's order. Nothing of the files' content is read.
func (r *Runner) Diff(ctx context.Context, from, to string, fn func(DiffChange)) error {
	if strings.TrimSpace(from) == "" || strings.TrimSpace(to) == "" {
		return errors.New("diff: two snapshots are needed")
	}
	xr, err := r.exec(ctx, execSpec{Command: "diff", Args: DiffArgs(from, to),
		OnStdoutLine: func(line []byte) {
			if c, ok := ParseDiffChange(line); ok {
				fn(c)
			}
		}})
	if err != nil {
		return err
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if xr.ExitCode != 0 {
		return failure("diff", xr)
	}
	return nil
}
