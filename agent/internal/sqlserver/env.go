package sqlserver

import (
	"context"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/restow-backup/restow/agent/internal/api"
	"github.com/restow-backup/restow/agent/internal/restic"
)

// Restic is what the flows need of restic; *restic.Runner implements it.
type Restic interface {
	Backup(ctx context.Context, o restic.BackupOptions) (*restic.BackupResult, error)
	Restore(ctx context.Context, o restic.RestoreOptions) (*restic.RestoreResult, error)
}

// Logger is the run log (*runlog.Log implements it).
type Logger interface {
	Infof(format string, args ...any)
	Warnf(format string, args ...any)
	Errorf(format string, args ...any)
}

// Progress is what a flow tells about a long step.
type Progress struct {
	Database string
	Step     string
	Percent  int
	// BytesDone and TotalBytes are restic's while it backs up or fetches.
	BytesDone, TotalBytes uint64
}

// Env is the machine as the flows see it.
type Env struct {
	Runner ScriptRunner
	FS     FS
	Restic Restic
	Log    Logger
	Now    func() time.Time
	// Host is the host of the SQL snapshots (the agent's hostname).
	Host string
	// StagingRoot holds one folder per instance (data\staging\sql, or the
	// job's stagingDir). CustomStaging: it is the job's folder and is checked
	// with ValidateStagingDir; Blocked are the system folders for that check.
	StagingRoot   string
	CustomStaging bool
	Blocked       []string
	// RestoreRoot holds the backups fetched for a restore or a check, one
	// folder per run (data\staging\sql-restore).
	RestoreRoot string
	// JournalPath is the journal of check copies.
	JournalPath string
	// Progress may be nil.
	Progress func(Progress)
}

func (e *Env) now() time.Time {
	if e.Now == nil {
		return time.Now()
	}
	return e.Now()
}

func (e *Env) progress(p Progress) {
	if e.Progress != nil {
		e.Progress(p)
	}
}

func (e *Env) journal() Journal { return Journal{FS: e.FS, Path: e.JournalPath} }

// Status of a flow, the run statuses of the contract.
const (
	statusSucceeded = api.StatusSucceeded
	statusPartial   = api.StatusPartial
	statusFailed    = api.StatusFailed
)

var (
	snapshotIDRe = regexp.MustCompile(`^[0-9a-f]{8,64}$`)
	sha256Re     = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

// checkFetchParams checks what a task says about a backup before anything
// is fetched.
func checkFetchParams(snapshotID, pathInSnapshot, sha string, files []api.SQLFile) error {
	switch {
	case !snapshotIDRe.MatchString(snapshotID):
		return fmt.Errorf("invalid snapshot id %q", snapshotID)
	case !strings.HasPrefix(pathInSnapshot, "/") || strings.ContainsRune(pathInSnapshot, 0) ||
		strings.Contains(pathInSnapshot, "/../") || !strings.HasSuffix(strings.ToLower(pathInSnapshot), ".bak"):
		return fmt.Errorf("invalid path in the snapshot %q", pathInSnapshot)
	case !sha256Re.MatchString(sha):
		return fmt.Errorf("invalid SHA-256 %q", sha)
	case len(files) > api.MaxSQLFileList:
		return fmt.Errorf("the file list has %d entries, more than %d", len(files), api.MaxSQLFileList)
	}
	return nil
}

// fetched is a backup file restic brought back from the repository.
type fetched struct {
	Local   string
	Fetched bool
	Match   bool
	Size    int64
	Problem *Problem
}

// fetch restores one backup file from the repository into target, checks
// its SHA-256 and gives the SQL Server service SIDs Read on it.
func (e *Env) fetch(ctx context.Context, snapshotID, pathInSnapshot, sha string, size int64, target string, readSIDs []string, db string) fetched {
	var f fetched
	if err := e.FS.MkdirWithSIDs(target, nil); err != nil {
		f.Problem = &Problem{Code: api.SQLStagingUnusable, Step: StepFetch, Message: BoundMessage(fmt.Sprintf("The restore staging folder %s could not be created: %v.", target, err))}
		return f
	}
	e.Log.Infof("Fetching the backup of %s from snapshot %s.", db, short(snapshotID))
	_, err := e.Restic.Restore(ctx, restic.RestoreOptions{SnapshotID: snapshotID, Target: target, Includes: []string{pathInSnapshot},
		OnProgress: func(p restic.Progress) {
			e.progress(Progress{Database: db, Step: StepFetch, BytesDone: p.BytesDone, TotalBytes: p.TotalBytes, Percent: int(p.Percent * 100)})
		}})
	if err != nil {
		f.Problem = &Problem{Code: api.SQLRestoreFailed, Step: StepFetch, Message: BoundMessage(fmt.Sprintf("The backup of %s could not be fetched from the repository: %v.", db, err))}
		return f
	}
	f.Local = RestoredPath(target, pathInSnapshot)
	sum, n, err := e.FS.SHA256File(ctx, f.Local)
	if err != nil {
		f.Problem = &Problem{Code: api.SQLRestoreFailed, Step: StepFetch, Message: BoundMessage(fmt.Sprintf("restic restored no backup file of %s from snapshot %s: %v.", db, short(snapshotID), err))}
		return f
	}
	f.Fetched, f.Size = true, n
	f.Match = sum == sha && (size <= 0 || n == size)
	if !f.Match {
		f.Problem = &Problem{Code: api.SQLBackupMismatch, Step: StepFetch, Message: BoundMessage(fmt.Sprintf(
			"The backup of %s from the repository is not the file that was backed up: SHA-256 %s and %d bytes instead of %s and %d bytes.",
			db, short(sum), n, short(sha), size))}
		return f
	}
	if err := e.FS.SetReadSIDs(target, readSIDs); err != nil {
		f.Problem = &Problem{Code: api.SQLStagingUnusable, Step: StepFetch, Message: BoundMessage(fmt.Sprintf("SQL Server could not be given read access to the fetched backup of %s: %v.", db, err))}
	}
	return f
}

// spaceCheck compares what a restore needs with the free space of the
// volumes of the restore staging, data and log folders (a volume that holds
// several of them needs their sum), and keeps a reserve on each: ReserveBytes,
// and LiveVolumeReserve on a volume that takes data or log files, which are
// usually the volumes of the live databases. It returns "" when everything
// fits with the reserve.
func (e *Env) spaceCheck(need SpaceNeed, dataDir, logDir string, db string) string {
	type part struct {
		path  string
		bytes int64
		what  string
		live  bool
	}
	parts := []part{{e.RestoreRoot, need.Bak, "the backup file", false}, {dataDir, need.Data, "its data files", true}, {logDir, need.Log, "its log", true}}
	sums := map[string]int64{}
	whats := map[string][]string{}
	reserve := map[string]uint64{}
	var order []string
	for _, p := range parts {
		if p.bytes <= 0 {
			continue
		}
		root := p.path
		var total uint64
		if v, err := e.FS.Volume(p.path); err == nil && v.Root != "" {
			root, total = v.Root, v.TotalBytes
		}
		if _, ok := sums[root]; !ok {
			order = append(order, root)
			reserve[root] = uint64(ReserveBytes)
		}
		if p.live {
			reserve[root] = max(reserve[root], LiveVolumeReserve(total))
		}
		sums[root] += p.bytes
		whats[root] = append(whats[root], fmt.Sprintf("%s for %s", GiBText(p.bytes), p.what))
	}
	for _, root := range order {
		free, err := e.FS.FreeBytes(root)
		if err != nil {
			return fmt.Sprintf("the free space on %s could not be read: %v", root, err)
		}
		if uint64(sums[root])+reserve[root] > free {
			return fmt.Sprintf("restoring %s needs %s on %s and leaves at least %s free there for what is already on it; %s has %s free",
				db, strings.Join(whats[root], " and "), root, GiBText(int64(reserve[root])), root, GiBText(int64(free)))
		}
	}
	return ""
}

// clearRestoreRoot removes backups fetched by an earlier restore or check
// that did not end (a crash, a stop): only one SQL Server job runs at a
// time, so nothing below the folder is in use.
func (e *Env) clearRestoreRoot() {
	if e.RestoreRoot == "" {
		return
	}
	if err := e.FS.RemoveAll(e.RestoreRoot); err != nil {
		e.Log.Warnf("The restore staging folder %s could not be cleared: %v.", e.RestoreRoot, err)
	}
}

func short(id string) string {
	if len(id) > 8 {
		return id[:8]
	}
	return id
}

// runError is a problem as an error of the run.
func runError(p *Problem) api.RunError {
	return api.RunError{Code: p.Code, Message: p.Message}
}

// serviceSID is the SID of an instance's service, "" when it cannot be
// computed (then no SID gets access and SQL Server cannot write: the run
// says so).
func serviceSID(instance string) string {
	sid, err := ServiceSID(ServiceNameFor(instance))
	if err != nil {
		return ""
	}
	return sid
}
