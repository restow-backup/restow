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
	"time"
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
	// ExcludeLargerThanBytes skips files larger than this many bytes
	// (--exclude-larger-than); 0 or less = no limit. restic reads 0 as "skip
	// every file with content", so a zero is never passed on.
	ExcludeLargerThanBytes int64
	OnProgress             func(Progress)

	// UseFSSnapshot: --use-fs-snapshot (Windows VSS). Set only on Windows.
	UseFSSnapshot bool
	// VSSTimeout: -o vss.timeout=<d>; 0 = restic's default (120 s).
	VSSTimeout time.Duration
	// VSSExcludeVolumes: -o vss.exclude-volumes=<a;b>, volumes restic is not
	// to snapshot (removable media, FAT, exFAT).
	VSSExcludeVolumes []string
	// ExcludeCloudFiles: --exclude-cloud-files (online-only OneDrive files).
	ExcludeCloudFiles bool
	// CaseInsensitive: --iexclude-file instead of --exclude-file (Windows
	// paths do not depend on case).
	CaseInsensitive bool
	// OnSnapshotFailed is called for each volume whose snapshot failed, as
	// soon as restic reports it (the caller may stop the backup). Calls
	// never overlap.
	OnSnapshotFailed func(VolumeFailure)
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
	// Snapshot is what happened to the file system snapshot (Requested is
	// false without UseFSSnapshot). Its entries are not counted in Errors.
	Snapshot SnapshotOutcome
}

// backupArgs builds the command line of `restic backup`. filesFrom is the raw
// list of sources and excludeFile the exclude patterns (empty: none); both
// are option files the caller wrote. Nothing secret belongs here: the
// repository and its credentials travel in the environment.
func backupArgs(o BackupOptions, filesFrom, excludeFile string) []string {
	args := []string{"backup", "--json", "--files-from-raw", filesFrom, "--exclude-caches", "--retry-lock", "15m"}
	if o.Host != "" {
		args = append(args, "--host", o.Host)
	}
	for _, t := range o.Tags {
		args = append(args, "--tag", t)
	}
	if excludeFile != "" {
		if o.CaseInsensitive {
			args = append(args, "--iexclude-file", excludeFile)
		} else {
			args = append(args, "--exclude-file", excludeFile)
		}
	}
	if o.LimitUploadKiB > 0 {
		args = append(args, "--limit-upload", strconv.Itoa(o.LimitUploadKiB))
	}
	if o.ExcludeLargerThanBytes > 0 {
		// A plain number of bytes: restic 0.19 reads it without a unit suffix.
		args = append(args, "--exclude-larger-than", strconv.FormatInt(o.ExcludeLargerThanBytes, 10))
	}
	if o.ExcludeCloudFiles {
		args = append(args, "--exclude-cloud-files")
	}
	if o.UseFSSnapshot {
		// Options of the snapshot, not secrets: they may stand on the command line.
		args = append(args, "--use-fs-snapshot")
		if o.VSSTimeout > 0 {
			args = append(args, "-o", "vss.timeout="+o.VSSTimeout.String())
		}
		var vols []string
		for _, v := range o.VSSExcludeVolumes {
			if v = NormalizeVolume(v); v != "" {
				vols = append(vols, v)
			}
		}
		if len(vols) > 0 {
			args = append(args, "-o", "vss.exclude-volumes="+strings.Join(vols, ";"))
		}
	}
	return args
}

// Backup runs `restic backup`. A returned *BackupResult with a nil error means
// a snapshot was created; otherwise the error is a *Error for restic
// failures (its SnapshotOutcome says what happened to the snapshot) or the
// context's error when cancelled, then with a result that carries only
// Snapshot (what restic reported about it before it was stopped).
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
		if o.UseFSSnapshot || o.CaseInsensitive {
			// Windows: one spelling of the drive letter (docs/WINDOWS-AGENT.md, 16.4).
			p = UpperDrive(p)
		}
		raw.WriteString(p)
		raw.WriteByte(0)
	}
	if err := os.WriteFile(filesFrom, raw.Bytes(), 0o600); err != nil {
		return nil, err
	}

	var excludeLines []string
	for _, e := range o.Excludes {
		if line, ok := excludeFileLine(e); ok {
			excludeLines = append(excludeLines, line)
		} else if strings.TrimSpace(e) != "" {
			res.Warnings = append(res.Warnings, fmt.Sprintf("exclude pattern %q cannot be used and was skipped", e))
		}
	}
	exFile := ""
	if len(excludeLines) > 0 {
		exFile = filepath.Join(dir, "excludes.txt")
		if err := os.WriteFile(exFile, []byte(strings.Join(excludeLines, "\n")+"\n"), 0o600); err != nil {
			return nil, err
		}
	}
	args := backupArgs(o, filesFrom, exFile)

	var summary *BackupSummary
	res.Snapshot.Requested = o.UseFSSnapshot
	items := &itemErrors{r: r}
	if o.UseFSSnapshot {
		items.snapshot = func(item, message string) bool {
			kind, ok := res.Snapshot.record(item, message)
			if kind == snapFailed && o.OnSnapshotFailed != nil {
				o.OnSnapshotFailed(res.Snapshot.FailedVolumes[len(res.Snapshot.FailedVolumes)-1])
			}
			return ok
		}
	}
	sawProgress := false
	xr, err := r.exec(ctx, execSpec{Command: "backup", Args: args, OnStderrError: items.add, OnStdoutLine: func(line []byte) {
		switch peekType(line) {
		case msgStatus:
			sawProgress = true
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
		return res, ctx.Err()
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
		if o.UseFSSnapshot {
			e.Snapshot = snapshotFaultOf(xr.ExitCode, sawProgress, xr.Fatal, xr.Stderr)
		}
		e.SnapshotOutcome = &res.Snapshot
		return nil, e
	}
}
