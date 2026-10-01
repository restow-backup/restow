package restic

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// Progress is a snapshot of a running backup or restore.
type Progress struct {
	FilesDone   uint64
	BytesDone   uint64
	TotalFiles  uint64
	TotalBytes  uint64
	Percent     float64
	CurrentPath string
}

// ItemError is a problem restic reported for one file.
type ItemError struct {
	Path    string
	Message string
	During  string
}

// BackupOptions describes one backup.
type BackupOptions struct {
	// Paths are the sources; they must exist (the caller filters).
	Paths    []string
	Excludes []string
	// Host is stored in the snapshot; keep it stable across renames.
	Host string
	Tags []string
	// LimitUploadKiB limits the upload rate (KiB/s); 0 = unlimited.
	LimitUploadKiB int
	OnProgress     func(Progress)
}

// BackupResult is the outcome of a backup that produced a snapshot.
type BackupResult struct {
	SnapshotID string
	Summary    BackupSummary
	// Errors are the files restic could not read, as it reported them, at
	// most maxKeptItemErrors in its order; ErrorCount counts all of them.
	Errors     []ItemError
	ErrorCount int
	// Partial is true when restic finished with exit code 3: the snapshot
	// exists but some files could not be read.
	Partial bool
	// Warnings are problems with the options themselves (skipped patterns).
	Warnings []string
}

// Backup runs `restic backup`. A returned *BackupResult with a nil error means
// a snapshot was created; a nil result comes with an error (a *Error for
// restic failures, context errors when cancelled).
func (r *Runner) Backup(ctx context.Context, o BackupOptions) (*BackupResult, error) {
	if len(o.Paths) == 0 {
		return nil, errors.New("backup: no paths to back up")
	}
	dir, cleanup, err := r.privateTempDir("backup-")
	if err != nil {
		return nil, err
	}
	defer cleanup()

	res := &BackupResult{}
	filesFrom := filepath.Join(dir, "paths.raw")
	var raw bytes.Buffer
	for _, p := range o.Paths {
		if p == "" || strings.ContainsRune(p, 0) {
			return nil, fmt.Errorf("backup: invalid path %q", p)
		}
		raw.WriteString(p)
		raw.WriteByte(0)
	}
	if err := os.WriteFile(filesFrom, raw.Bytes(), 0o600); err != nil {
		return nil, err
	}

	args := []string{"backup", "--json", "--files-from-raw", filesFrom, "--exclude-caches", "--retry-lock", "15m"}
	if o.Host != "" {
		args = append(args, "--host", o.Host)
	}
	for _, t := range o.Tags {
		args = append(args, "--tag", t)
	}
	var excludeLines []string
	for _, e := range o.Excludes {
		if line, ok := excludeFileLine(e); ok {
			excludeLines = append(excludeLines, line)
		} else if strings.TrimSpace(e) != "" {
			res.Warnings = append(res.Warnings, fmt.Sprintf("exclude pattern %q cannot be used and was skipped", e))
		}
	}
	if len(excludeLines) > 0 {
		exFile := filepath.Join(dir, "excludes.txt")
		if err := os.WriteFile(exFile, []byte(strings.Join(excludeLines, "\n")+"\n"), 0o600); err != nil {
			return nil, err
		}
		args = append(args, "--exclude-file", exFile)
	}
	if o.LimitUploadKiB > 0 {
		args = append(args, "--limit-upload", strconv.Itoa(o.LimitUploadKiB))
	}

	var summary *BackupSummary
	items := &itemErrors{r: r}
	xr, err := r.exec(ctx, execSpec{Command: "backup", Args: args, OnStderrError: items.add, OnStdoutLine: func(line []byte) {
		switch peekType(line) {
		case msgStatus:
			if o.OnProgress == nil {
				return
			}
			var st backupStatus
			if json.Unmarshal(line, &st) != nil {
				return
			}
			p := Progress{FilesDone: st.FilesDone, BytesDone: st.BytesDone, TotalFiles: st.TotalFiles,
				TotalBytes: st.TotalBytes, Percent: st.PercentDone}
			if len(st.CurrentFiles) > 0 {
				p.CurrentPath = st.CurrentFiles[0]
			}
			o.OnProgress(p)
		case msgSummary:
			var s BackupSummary
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
	res.Errors, res.ErrorCount = items.kept, items.count
	switch xr.ExitCode {
	case 0, ExitIncomplete:
		if summary == nil || summary.SnapshotID == "" {
			return nil, fmt.Errorf("restic backup finished (exit code %d) without reporting a snapshot id", xr.ExitCode)
		}
		res.Summary, res.SnapshotID = *summary, summary.SnapshotID
		res.Partial = xr.ExitCode == ExitIncomplete
		return res, nil
	default:
		e := failure("backup", xr)
		e.Items, e.ItemCount = items.kept, items.count
		return nil, e
	}
}
