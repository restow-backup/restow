package restic

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"runtime"
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

	// The options below are those of the bare-metal restore (recover,
	// docs/BAREMETAL.md 10.12); their zero values keep the agent's restore.

	// Sparse writes runs of zeros as holes (--sparse).
	Sparse bool
	// NoLock reads the repository without a lock (--no-lock; the recovery
	// route is read-only). It leaves out --retry-lock, which restic refuses
	// together with --no-lock.
	NoLock bool
	// NoCache uses no local cache (--no-cache).
	NoCache bool
	// Overwrite is never (the default), if-changed or always.
	Overwrite string
	// Excludes are snapshot paths left out (--exclude).
	Excludes []string
	// ExcludeXattrs are extended attribute patterns not restored
	// (--exclude-xattr).
	ExcludeXattrs []string
	// OwnershipByName restores owners by name instead of by number
	// (--ownership-by-name).
	OwnershipByName bool
	// Subfolder restores only this folder of the snapshot (<id>:<path>).
	Subfolder string
	// NoVerify leaves out --verify (by default every restored file is read
	// back and compared).
	NoVerify bool
}

// RestoreArgs is the argument vector of a restore (after the binary).
func RestoreArgs(o RestoreOptions) ([]string, error) {
	if o.SnapshotID == "" || o.Target == "" {
		return nil, errors.New("restore: snapshot id and target are required")
	}
	overwrite := o.Overwrite
	if overwrite == "" {
		overwrite = "never"
	}
	if overwrite != "never" && overwrite != "if-changed" && overwrite != "always" {
		return nil, fmt.Errorf("restore: invalid overwrite mode %q", o.Overwrite)
	}
	args := []string{"restore", "--json"}
	if o.NoLock {
		args = append(args, "--no-lock")
	}
	if o.NoCache {
		args = append(args, "--no-cache")
	}
	args = append(args, "--target", o.Target)
	if o.Sparse {
		args = append(args, "--sparse")
	}
	args = append(args, "--overwrite", overwrite)
	if !o.NoVerify {
		args = append(args, "--verify")
	}
	if !o.NoLock {
		args = append(args, "--retry-lock", "15m")
	}
	if o.OwnershipByName {
		args = append(args, "--ownership-by-name")
	}
	total := 0
	for _, inc := range o.Includes {
		if !strings.HasPrefix(inc, "/") || strings.ContainsRune(inc, 0) {
			return nil, fmt.Errorf("restore: invalid snapshot path %q (must start with /)", inc)
		}
		opt, pat := includeFor(inc, runtime.GOOS == "windows")
		total += len(pat)
		args = append(args, opt, pat)
	}
	for _, ex := range o.Excludes {
		if !strings.HasPrefix(ex, "/") || strings.ContainsRune(ex, 0) {
			return nil, fmt.Errorf("restore: invalid exclude %q (must start with /)", ex)
		}
		total += len(ex)
		args = append(args, "--exclude", ex)
	}
	for _, x := range o.ExcludeXattrs {
		if x == "" || strings.ContainsRune(x, 0) {
			return nil, fmt.Errorf("restore: invalid xattr pattern %q", x)
		}
		args = append(args, "--exclude-xattr", x)
	}
	if total > maxIncludeArgBytes {
		return nil, fmt.Errorf("restore: the selection is too large (%d bytes of paths); restore a parent folder or fewer items", total)
	}
	snap := o.SnapshotID
	if o.Subfolder != "" {
		if !strings.HasPrefix(o.Subfolder, "/") || strings.ContainsRune(o.Subfolder, 0) {
			return nil, fmt.Errorf("restore: invalid subfolder %q", o.Subfolder)
		}
		snap += ":" + o.Subfolder
	}
	return append(args, snap), nil
}

// RestoreResult is the outcome of a successful restore.
type RestoreResult struct {
	Summary RestoreSummary
	Errors  []ItemError
}

// Restore runs `restic restore ... --overwrite never --verify` (or with
// the options of RestoreOptions).
func (r *Runner) Restore(ctx context.Context, o RestoreOptions) (*RestoreResult, error) {
	args, err := RestoreArgs(o)
	if err != nil {
		return nil, err
	}

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
