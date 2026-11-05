package sqlserver

import (
	"context"
	"fmt"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/restow-backup/restow/agent/internal/api"
	"github.com/restow-backup/restow/agent/internal/restic"
)

// BackupOutcome is how the sql run of one instance ended.
type BackupOutcome struct {
	Status     string
	SnapshotID string
	Stats      *api.Stats
	Report     *api.SQLRunReport
	Errors     []api.RunError
	Notices    []api.Notice
	// Inventory is the fresh inventory of the instance (nil when it was not
	// read); the agent puts it into its cache.
	Inventory *InstanceInventory
	// Stopped: the context ended (the caller reports cancelled or
	// interrupted).
	Stopped bool
}

// SnapshotTags are the tags of the SQL snapshot of an instance.
func SnapshotTags(instance string) []string {
	return []string{api.SQLSnapshotTag, api.SQLSnapshotInstanceTag + instance}
}

// BackupInstance runs the native backup of one instance (docs/BAREMETAL-
// WINDOWS.md 5.1.3): staging cleared, inventory, selection, space plan, one
// COPY_ONLY full per database with HEADERONLY, FILELISTONLY and SHA-256, one
// restic snapshot of the instance folder, and the staging files deleted
// after that snapshot, and on every other way out as well (a failed or
// partial BACKUP, a stop, a failed snapshot): the next run writes them anew,
// so keeping them would only fill the staging volume.
func (e *Env) BackupInstance(ctx context.Context, cfg *api.SQLConfig, fact api.SQLInstanceFact) BackupOutcome {
	out := BackupOutcome{Status: statusFailed, Report: &api.SQLRunReport{Instance: fact.Name, Databases: []api.SQLDatabaseResult{}}}
	fail := func(code, format string, args ...any) BackupOutcome {
		msg := BoundMessage(fmt.Sprintf(format, args...))
		e.Log.Errorf("%s", msg)
		out.Errors = append(out.Errors, api.RunError{Code: code, Message: msg})
		return out
	}
	switch {
	case cfg == nil:
		return fail(api.SQLModeUnsupported, "The backup job has no settings for SQL Server.")
	case cfg.Mode != api.SQLModeAlongside:
		return fail(api.SQLModeUnsupported, "The SQL Server mode %q of the backup job is not supported by this agent; nothing was backed up. Update the agent or choose \"alongside\".", cfg.Mode)
	case cfg.Instances.Invalid != "" || cfg.Databases.Invalid != "":
		return fail(api.SQLModeUnsupported, "The SQL Server selection of the backup job is not understood by this agent; nothing was backed up.")
	case !ValidInstanceName(fact.Name):
		return fail(api.SQLInstanceUnreachable, "The SQL Server instance name %q is not valid.", fact.Name)
	case fact.Clustered:
		return fail(api.SQLFCIUnsupported, "SQL Server instance %s is a failover cluster instance; the native backup does not support it yet.", fact.Name)
	}
	sid := serviceSID(fact.Name)
	root := e.StagingRoot
	if e.CustomStaging {
		vol, err := e.FS.Volume(root)
		if err == nil {
			err = ValidateStagingDir(root, vol, e.Blocked)
		}
		if err == nil {
			// The folder becomes the agent's, or is refused: a folder of
			// someone else is never re-permitted or emptied.
			root, err = e.FS.PrepareStagingRoot(root)
		}
		if err != nil {
			return fail(api.SQLStagingUnusable, "The staging folder of the backup job cannot be used: %v. Nothing was backed up.", err)
		}
	}
	instDir := InstanceFolder(root, fact.Name)
	if err := e.FS.RemoveAll(instDir); err != nil {
		return fail(api.SQLStagingUnusable, "The staging folder %s could not be cleared: %v.", instDir, err)
	}
	defer func() {
		if err := e.FS.RemoveAll(instDir); err != nil {
			e.Log.Warnf("The staging folder %s could not be cleared: %v. The next run clears it.", instDir, err)
		}
	}()
	if err := e.FS.MkdirWithSIDs(root, nil); err != nil {
		return fail(api.SQLStagingUnusable, "The staging folder %s could not be created: %v.", root, err)
	}
	if err := e.FS.MkdirWithSIDs(instDir, []string{sid}); err != nil {
		return fail(api.SQLStagingUnusable, "The staging folder %s could not be created with write access for the SQL Server service (%s): %v.", instDir, ServiceNameFor(fact.Name), err)
	}

	ii := ReadInstance(ctx, e.Runner, fact)
	out.Inventory = &ii
	if ctx.Err() != nil {
		out.Stopped = true
		return out
	}
	if ii.Problem != nil {
		return fail(ii.Problem.Code, "SQL Server instance %s: %s", fact.Name, ii.Problem.Message)
	}
	inv := ii.Result
	if inv.Clustered {
		return fail(api.SQLFCIUnsupported, "SQL Server instance %s is a failover cluster instance; the native backup does not support it yet.", fact.Name)
	}
	if inv.BackupCompressionDefault {
		e.Log.Infof("The instance compresses backups by default; the agent's backups are written with NO_COMPRESSION, so they deduplicate.")
	}
	sel := SelectDatabases(cfg, fact.Name, inv.Databases)
	if n := len(sel.Backup) + len(sel.Skipped); n > api.MaxSQLDatabases {
		// The report of a run holds at most MaxSQLDatabases databases.
		keep := max(api.MaxSQLDatabases-len(sel.Skipped), 0)
		msg := BoundMessage(fmt.Sprintf("Instance %s has %d databases to back up; one run backs up at most %d, so %d were not backed up.", fact.Name, n, api.MaxSQLDatabases, n-api.MaxSQLDatabases))
		e.Log.Errorf("%s", msg)
		out.Errors = append(out.Errors, api.RunError{Code: api.SQLBackupFailed, Message: msg})
		if keep < len(sel.Backup) {
			sel.Backup = sel.Backup[:keep]
		}
		if len(sel.Skipped) > api.MaxSQLDatabases {
			sel.Skipped = sel.Skipped[:api.MaxSQLDatabases]
		}
	}
	for _, n := range sel.CopyOnlySecondary {
		e.Log.Infof("%s is on a secondary replica of an availability group; it is backed up COPY_ONLY like every database.", n)
	}
	free, err := e.FS.FreeBytes(instDir)
	if err != nil {
		return fail(api.SQLStagingUnusable, "The free space of the staging folder %s could not be read: %v.", instDir, err)
	}
	where := instDir
	if v, err := e.FS.Volume(instDir); err == nil && v.Root != "" {
		where = v.Root
	}
	plan := PlanSpace(free, where, sel.Backup)
	e.Log.Infof("SQL Server instance %s: %d databases selected, %d fit into the staging folder (%s free).", fact.Name, len(sel.Backup), len(plan.Fit), GiBText(int64(free)))
	for _, r := range append(append([]api.SQLDatabaseResult{}, sel.Skipped...), plan.TooSmall...) {
		e.Log.Warnf("%s", r.Message)
		out.Report.Databases = append(out.Report.Databases, r)
		out.Errors = append(out.Errors, api.RunError{Code: r.Code, Message: r.Message})
	}

	type written struct {
		idx  int
		path string
	}
	var files []written
	for _, db := range plan.Fit {
		if ctx.Err() != nil {
			out.Stopped = true
			return out
		}
		res := e.backupDatabase(ctx, fact, root, sid, db)
		if ctx.Err() != nil {
			out.Stopped = true
			return out
		}
		if res.Outcome == api.SQLBackedUp {
			files = append(files, written{idx: len(out.Report.Databases), path: res.localPath})
		} else {
			out.Errors = append(out.Errors, api.RunError{Code: res.Code, Message: res.Message})
		}
		out.Report.Databases = append(out.Report.Databases, res.SQLDatabaseResult)
	}

	if len(files) > 0 {
		e.Log.Infof("Backing up the staging folder %s with restic.", instDir)
		res, err := e.Restic.Backup(ctx, restic.BackupOptions{
			Paths: []string{instDir}, Host: e.Host, Tags: SnapshotTags(fact.Name), CaseInsensitive: true,
			OnProgress: func(p restic.Progress) {
				e.progress(Progress{Step: StepSnapshot, BytesDone: p.BytesDone, TotalBytes: p.TotalBytes, Percent: int(p.Percent * 100)})
			},
		})
		if res != nil && res.SnapshotID != "" {
			out.SnapshotID = res.SnapshotID
			s := res.Summary
			out.Stats = &api.Stats{FilesNew: s.FilesNew, FilesChanged: s.FilesChanged, FilesUnmodified: s.FilesUnmodified,
				DataAdded: s.DataAdded, DataAddedPacked: s.DataAddedPacked, TotalFilesProcessed: s.TotalFilesProcessed, TotalBytesProcessed: s.TotalBytesProcessed}
		}
		switch {
		case ctx.Err() != nil:
			out.Stopped = true
			return out
		case err != nil:
			msg := BoundMessage(fmt.Sprintf("The snapshot of the SQL Server backups failed: %v. The backup files were deleted from %s; the next run writes them again.", err, instDir))
			e.Log.Errorf("%s", msg)
			out.Errors = append(out.Errors, api.RunError{Code: api.SQLSnapshotFailed, Message: msg})
			for _, f := range files {
				d := &out.Report.Databases[f.idx]
				d.Outcome, d.Backup, d.Code, d.Message = api.SQLFailed, nil, api.SQLSnapshotFailed, msg
			}
			files = nil
		default:
			unread := map[string]string{}
			for _, ie := range res.Errors {
				unread[strings.ToLower(filepath.Clean(ie.Path))] = ie.Message
			}
			kept := files[:0]
			for _, f := range files {
				if m, bad := unread[strings.ToLower(filepath.Clean(f.path))]; bad || (res.Partial && len(res.Errors) == 0) {
					d := &out.Report.Databases[f.idx]
					msg := BoundMessage(fmt.Sprintf("%s: restic could not read the backup file: %s", d.Name, m))
					d.Outcome, d.Backup, d.Code, d.Message = api.SQLFailed, nil, api.SQLSnapshotFailed, msg
					out.Errors = append(out.Errors, api.RunError{Code: api.SQLSnapshotFailed, Message: msg})
					continue
				}
				kept = append(kept, f)
			}
			files = kept
			e.Log.Infof("Snapshot %s saved with %d SQL Server backups.", short(res.SnapshotID), len(files))
			// Only now are the backup files in the repository; the deferred
			// cleanup deletes them.
		}
	}

	out.Notices = InstanceNotices(fact, inv, e.now())
	backedUp := 0
	for _, d := range out.Report.Databases {
		if d.Outcome == api.SQLBackedUp {
			backedUp++
		}
	}
	switch {
	case len(out.Report.Databases) == 0:
		e.Log.Infof("No database of instance %s is selected for the native backup.", fact.Name)
		out.Status = statusSucceeded
	case backedUp == len(out.Report.Databases) && len(out.Errors) == 0:
		out.Status = statusSucceeded
	case backedUp > 0:
		out.Status = statusPartial
	default:
		out.Status = statusFailed
	}
	return out
}

type databaseBackup struct {
	api.SQLDatabaseResult
	localPath string
}

// backupDatabase writes and describes the full of one database.
func (e *Env) backupDatabase(ctx context.Context, fact api.SQLInstanceFact, root, sid string, db InventoryDB) databaseBackup {
	r := databaseBackup{SQLDatabaseResult: api.SQLDatabaseResult{Name: db.Name, FamilyGUID: db.FamilyGUID,
		DatabaseGUID: db.DatabaseGUID, RecoveryModel: db.RecoveryModel, Outcome: api.SQLFailed}}
	failed := func(code, format string, args ...any) databaseBackup {
		r.Code, r.Message = code, BoundMessage(fmt.Sprintf(format, args...))
		e.Log.Errorf("%s", r.Message)
		return r
	}
	path := BackupPath(root, fact.Name, db.Name, e.now())
	if err := e.FS.MkdirWithSIDs(filepath.Dir(path), []string{sid}); err != nil {
		return failed(api.SQLStagingUnusable, "%s was not backed up: its staging folder could not be created: %v.", db.Name, err)
	}
	req, err := NewRequest(OpBackup, fact.Name, StepTimeout(db.UsedBytes), BackupParams{Database: db.Name, Path: path})
	if err != nil {
		return failed(api.SQLScriptFailed, "%s was not backed up: %v.", db.Name, err)
	}
	started := e.now()
	e.Log.Infof("Backing up %s (COPY_ONLY full).", db.Name)
	res := e.Runner.Run(ctx, req, func(l Line) {
		e.progress(Progress{Database: db.Name, Step: StepBackup, Percent: l.Percent})
	})
	if !res.OK() {
		p := res.Problem
		code := p.Code
		if code == "" || (code == api.SQLScriptFailed && res.TimedOut) {
			code = api.SQLBackupFailed
		}
		return failed(code, "%s was not backed up: %s", db.Name, p.Message)
	}
	var br BackupResult
	if err := res.Decode(&br); err != nil {
		return failed(api.SQLScriptFailed, "%s: the result of the backup could not be read: %v.", db.Name, err)
	}
	sum, size, err := e.FS.SHA256File(ctx, path)
	if err != nil {
		return failed(api.SQLBackupFailed, "%s: the backup file %s could not be read: %v.", db.Name, path, err)
	}
	facts, err := BackupFacts(br, db, SnapshotPathOf(path), sum, size)
	if err != nil {
		return failed(api.SQLBackupFailed, "%s: %v.", db.Name, err)
	}
	if facts.Compressed {
		e.Log.Warnf("%s: SQL Server wrote a compressed backup although NO_COMPRESSION was asked for; it deduplicates badly.", db.Name)
	}
	e.Log.Infof("%s backed up in %s: %s, LSN %s to %s.", db.Name, e.now().Sub(started).Round(time.Second), GiBText(size), facts.FirstLSN, facts.LastLSN)
	r.Outcome, r.Backup, r.localPath = api.SQLBackedUp, &facts, path
	return r
}

// InstanceNotices are the fixed warnings of an instance: FULL databases
// whose log nobody backs up (sql_log_growing), TDE databases
// (sql_tde_certificate), an untested release (sql_version_untested).
func InstanceNotices(fact api.SQLInstanceFact, inv *InventoryResult, now time.Time) []api.Notice {
	if inv == nil {
		return nil
	}
	var growing, tde []string
	for _, db := range inv.Databases {
		if strings.EqualFold(db.Name, "tempdb") || db.Snapshot || db.State != "ONLINE" {
			continue
		}
		if (db.RecoveryModel == "FULL" || db.RecoveryModel == "BULK_LOGGED") && !db.ReadOnly {
			last, ok := ParseUTC(db.LastLogBackup)
			if !ok || now.Sub(last) > 24*time.Hour {
				growing = append(growing, db.Name)
			}
		}
		if db.Encrypted {
			tde = append(tde, db.Name)
		}
	}
	var out []api.Notice
	if len(growing) > 0 {
		out = append(out, api.Notice{Code: api.NoticeSQLLogGrowing, Subjects: boundSubjects(growing),
			Message: BoundMessage(fmt.Sprintf("%s uses the FULL recovery model, but no tool has backed up its transaction log in the last 24 hours: the log keeps growing. Back the log up with your existing tool, or switch the database to SIMPLE if you need no point-in-time restore.", strings.Join(boundSubjects(growing), ", ")))})
	}
	if len(tde) > 0 {
		out = append(out, api.Notice{Code: api.NoticeSQLTDECertificate, Subjects: boundSubjects(tde),
			Message: BoundMessage(fmt.Sprintf("%s is encrypted with TDE. Restow does not back up the certificate and its private key; without them the backup cannot be restored on another instance. Back them up yourself and confirm it in Restow.", strings.Join(boundSubjects(tde), ", ")))})
	}
	if v := MajorOf(inv.Version); TestedMajors[v] == "" {
		out = append(out, api.Notice{Code: api.NoticeSQLVersionUntested, Subjects: []string{fact.Name},
			Message: BoundMessage(fmt.Sprintf("SQL Server %s (instance %s) is not a release the native backup was tested with (2016 to 2025).", inv.Version, fact.Name))})
	}
	return out
}

const maxNoticeSubjects = 50

func boundSubjects(s []string) []string {
	s = append([]string(nil), s...)
	sort.Strings(s)
	if len(s) > maxNoticeSubjects {
		s = s[:maxNoticeSubjects]
	}
	return s
}
