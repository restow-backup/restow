package restic

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

// maxIncludeArgBytes bounds the size of --include arguments on the command line.
const maxIncludeArgBytes = 128 * 1024

// RestoreOptions describes one restore.
type RestoreOptions struct {
	SnapshotID string
	// Target is the folder to restore into. The caller guarantees that it is
	// new or empty; restic is additionally told never to overwrite.
	Target string
	// Includes are snapshot paths (forward slashes, starting with /). Empty
	// restores the whole snapshot.
	Includes   []string
	OnProgress func(Progress)
}

// RestoreResult is the outcome of a successful restore.
type RestoreResult struct {
	Summary RestoreSummary
	Errors  []ItemError
}

// Restore runs `restic restore ... --overwrite never --verify`.
func (r *Runner) Restore(ctx context.Context, o RestoreOptions) (*RestoreResult, error) {
	if o.SnapshotID == "" || o.Target == "" {
		return nil, errors.New("restore: snapshot id and target are required")
	}
	args := []string{"restore", "--json", "--target", o.Target, "--overwrite", "never", "--verify", "--retry-lock", "15m"}
	total := 0
	for _, inc := range o.Includes {
		if !strings.HasPrefix(inc, "/") || strings.ContainsRune(inc, 0) {
			return nil, fmt.Errorf("restore: invalid snapshot path %q (must start with /)", inc)
		}
		pat := EscapeIncludePath(inc)
		total += len(pat)
		args = append(args, "--include", pat)
	}
	if total > maxIncludeArgBytes {
		return nil, fmt.Errorf("restore: the selection is too large (%d bytes of paths); restore a parent folder or fewer items", total)
	}
	args = append(args, o.SnapshotID)

	res := &RestoreResult{}
	var summary *RestoreSummary
	items := &itemErrors{r: r}
	xr, err := r.exec(ctx, execSpec{Command: "restore", Args: args, OnStderrError: items.add, OnStdoutLine: func(line []byte) {
		switch peekType(line) {
		case msgStatus:
			if o.OnProgress == nil {
				return
			}
			var st restoreStatus
			if json.Unmarshal(line, &st) != nil {
				return
			}
			o.OnProgress(Progress{FilesDone: st.FilesRestored, BytesDone: st.BytesRestored,
				TotalFiles: st.TotalFiles, TotalBytes: st.TotalBytes, Percent: st.PercentDone})
		case msgSummary:
			var s RestoreSummary
			if json.Unmarshal(line, &s) == nil {
				summary = &s
			}
		case msgError:
			items.add(line)
		case msgVerboseStatus:
		case "":
			if s := strings.TrimSpace(string(line)); s != "" {
				r.log(s)
			}
		}
	}})
	if err != nil {
		return nil, err
	}
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	res.Errors = items.kept
	if xr.ExitCode != 0 {
		e := failure("restore", xr)
		e.Items, e.ItemCount = items.kept, items.count
		if len(items.kept) > 0 && (e.Message == "" || strings.Contains(e.Message, "error")) {
			e.Message = fmt.Sprintf("%d file(s) could not be restored, first: %s: %s",
				items.count, items.kept[0].Path, items.kept[0].Message)
		}
		return nil, e
	}
	if summary != nil {
		res.Summary = *summary
	}
	return res, nil
}
