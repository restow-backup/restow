package sqlserver

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"
	"time"

	"github.com/restow-backup/restow/agent/internal/api"
)

// RestoreOutcome is how a sql_restore run ended.
type RestoreOutcome struct {
	Status  string
	Report  *api.SQLRestoreReport
	Errors  []api.RunError
	Stopped bool
}

// Restore restores one backup under a new name on an instance of this
// machine (docs/BAREMETAL-WINDOWS.md 5.1.4, W2a): the backup is fetched
// from the repository and its SHA-256 checked, FILELISTONLY of the fetched
// file names the files, the MOVE targets go to the target instance's default
// folders, RESTORE runs with CHECKSUM, then CHECKDB when asked for. The
// existing database is never touched: a name that exists is refused.
func (e *Env) Restore(ctx context.Context, p api.SQLRestoreParams, target api.SQLInstanceFact, runID string) RestoreOutcome {
	rep := &api.SQLRestoreReport{BackupID: p.BackupID, Instance: target.Name, NewName: p.NewName, Moves: []api.SQLMove{}}
	out := RestoreOutcome{Status: statusFailed, Report: rep}
	started := e.now()
	defer func() { rep.DurationMs = e.now().Sub(started).Milliseconds() }()
	fail := func(code, format string, args ...any) RestoreOutcome {
		msg := BoundMessage(fmt.Sprintf(format, args...))
		rep.Code, rep.Message = code, msg
		out.Errors = append(out.Errors, api.RunError{Code: code, Message: msg})
		e.Log.Errorf("%s", msg)
		return out
	}
	if err := ValidNewName(p.NewName); err != nil {
		return fail(api.SQLScriptFailed, "The restore was not started: %v.", err)
	}
	if err := checkFetchParams(p.SnapshotID, p.PathInSnapshot, p.SHA256, p.FileList); err != nil || p.Database == "" {
		return fail(api.SQLScriptFailed, "The restore was not started: the task is not valid (%v).", err)
	}
	if !ValidInstanceName(target.Name) {
		return fail(api.SQLInstanceUnreachable, "The SQL Server instance %q is not on this machine.", target.Name)
	}
	if target.Clustered {
		return fail(api.SQLFCIUnsupported, "SQL Server instance %s is a failover cluster instance; restores there are not supported yet.", target.Name)
	}
	ii := ReadInstance(ctx, e.Runner, target)
	if ctx.Err() != nil {
		out.Stopped = true
		return out
	}
	if ii.Problem != nil {
		return fail(ii.Problem.Code, "SQL Server instance %s: %s", target.Name, ii.Problem.Message)
	}
	for _, db := range ii.Result.Databases {
		if strings.EqualFold(db.Name, p.NewName) {
			return fail(api.SQLRestoreNameTaken, "A database named %s exists already on instance %s; choose another name. The existing database was not touched.", p.NewName, target.Name)
		}
	}
	e.clearRestoreRoot()
	dir := filepath.Join(e.RestoreRoot, safeRunID(runID))
	defer func() {
		if err := e.FS.RemoveAll(dir); err != nil {
			e.Log.Warnf("The fetched backup could not be deleted from %s: %v.", dir, err)
		}
	}()
	if why := e.spaceCheck(NeedOf(p.Bytes, p.FileList), ii.Result.DefaultDataPath, logDirOf(ii.Result), p.Database); why != "" {
		return fail(api.SQLRestoreNoSpace, "The restore was not started: %s.", why)
	}
	sid := serviceSID(target.Name)
	f := e.fetch(ctx, p.SnapshotID, p.PathInSnapshot, p.SHA256, p.Bytes, dir, []string{sid}, p.Database)
	rep.Fetched, rep.SHA256Match = f.Fetched, f.Match
	if ctx.Err() != nil {
		out.Stopped = true
		return out
	}
	if f.Problem != nil {
		return fail(f.Problem.Code, "%s", f.Problem.Message)
	}
	step := StepTimeout(p.Bytes)
	flReq, _ := NewRequest(OpFileList, target.Name, step, FileListParams{Path: f.Local, CheckName: p.NewName})
	fl := e.Runner.Run(ctx, flReq, nil)
	if ctx.Err() != nil {
		out.Stopped = true
		return out
	}
	if !fl.OK() {
		return fail(codeOr(fl, api.SQLRestoreFailed), "SQL Server cannot read the backup of %s: %s", p.Database, fl.Problem.Message)
	}
	var list FileListResult
	if err := fl.Decode(&list); err != nil {
		return fail(api.SQLScriptFailed, "The file list of the backup could not be read: %v.", err)
	}
	if list.NameTaken {
		return fail(api.SQLRestoreNameTaken, "A database named %s exists already on instance %s; choose another name. The existing database was not touched.", p.NewName, target.Name)
	}
	moves, err := MoveTargets(p.NewName, MoveSuffix(p.NewName, runID), list.FileList, list.DefaultDataPath, list.DefaultLogPath)
	if err != nil {
		return fail(api.SQLRestoreFailed, "The restore was not started: %v.", err)
	}
	maxBytes := int64(p.MaxGiB) * GiB
	physical := maxBytes > 0 && p.Bytes > maxBytes
	rReq, _ := NewRequest(OpRestore, target.Name, step, RestoreParams{NewName: p.NewName, Path: f.Local, Moves: moves, Checkdb: p.Checkdb, PhysicalOnly: physical})
	e.Log.Infof("Restoring %s as %s on instance %s.", p.Database, p.NewName, target.Name)
	r := e.Runner.Run(ctx, rReq, func(l Line) {
		e.progress(Progress{Database: p.NewName, Step: l.Step, Percent: l.Percent})
	})
	if !r.OK() && (r.Problem == nil || r.Problem.Code != api.SQLRestoreNameTaken) {
		// The script gave no result (its time limit, a crash, a stop): the
		// RESTORE it started may have left the new name in RESTORING, with
		// its files on the target's volumes. Nothing else would remove it.
		left := e.cleanupRestore(ctx, target.Name, p.NewName, moves)
		if ctx.Err() != nil {
			out.Stopped = true
			if left != "" {
				out.Errors = append(out.Errors, api.RunError{Code: api.SQLRestoreFailed, Message: BoundMessage(left)})
			}
			return out
		}
		msg := "The SQL Server script gave no result."
		if r.Problem != nil {
			msg = r.Problem.Message
		}
		return fail(codeOr(r, api.SQLRestoreFailed), "The restore of %s as %s failed: %s%s", p.Database, p.NewName, msg, prefixSpace(left))
	}
	if ctx.Err() != nil {
		out.Stopped = true
		return out
	}
	if !r.OK() {
		return fail(codeOr(r, api.SQLRestoreFailed), "The restore of %s as %s failed: %s", p.Database, p.NewName, r.Problem.Message)
	}
	var rr RestoreResult
	if err := r.Decode(&rr); err != nil {
		return fail(api.SQLScriptFailed, "The result of the restore could not be read: %v.%s", err, prefixSpace(e.cleanupRestore(ctx, target.Name, p.NewName, moves)))
	}
	if !rr.Restore.OK {
		first := ""
		for _, x := range rr.Restore.Errors {
			if first == "" && x.Number != 3013 {
				first = fmt.Sprintf("%s (%d)", x.Message, x.Number)
			}
		}
		cleaned := ""
		switch {
		case rr.CleanedUp:
			cleaned = " The half-restored database was dropped again."
		case rr.Leftover != "":
			cleaned = " " + leftoverText(target.Name, p.NewName, rr.Leftover, moves)
		}
		return fail(api.SQLRestoreFailed, "The restore of %s as %s failed: %s.%s", p.Database, p.NewName, first, cleaned)
	}
	rep.Restored = true
	rep.Moves = moves
	out.Status = statusSucceeded
	if rr.Checkdb != nil {
		c, prob := JudgeCheckdb(*rr.Checkdb, rr.CheckdbRaised, rr.CheckdbProblem)
		rep.Checkdb = &c
		switch {
		case !c.Ran:
			out.Status = statusPartial
			code, why := api.SQLScriptFailed, ""
			if prob != nil {
				code, why = prob.Code, ": "+prob.Message
			}
			msg := BoundMessage(fmt.Sprintf("%s was restored as %s, but DBCC CHECKDB did not run to its end%s.", p.Database, p.NewName, why))
			out.Errors = append(out.Errors, api.RunError{Code: code, Message: msg})
			e.Log.Warnf("%s", msg)
		case len(c.Errors) > 0:
			out.Status = statusPartial
			msg := BoundMessage(fmt.Sprintf("%s was restored as %s; DBCC CHECKDB reported %d error(s), first: %s (%d).", p.Database, p.NewName, len(c.Errors), c.Errors[0].Message, c.Errors[0].Number))
			out.Errors = append(out.Errors, api.RunError{Message: msg})
			e.Log.Errorf("%s", msg)
		default:
			e.Log.Infof("%s was restored as %s and checked with DBCC CHECKDB without errors.", p.Database, p.NewName)
		}
	} else {
		e.Log.Infof("%s was restored as %s.", p.Database, p.NewName)
	}
	return out
}

// cleanupRestore drops the new name after a restore that gave no result,
// but only while it is in RESTORING (DropRestoring): what a killed RESTORE
// leaves. It runs on a fresh short context when the run's has ended. It
// returns "" when nothing is left, else the sentence that names the
// leftover database and its files.
func (e *Env) cleanupRestore(ctx context.Context, instance, name string, moves []api.SQLMove) string {
	cctx := ctx
	if ctx.Err() != nil {
		var cancel context.CancelFunc
		cctx, cancel = context.WithTimeout(context.Background(), cleanupTimeout)
		defer cancel()
	}
	req, err := NewRequest(OpDropRestoring, instance, cleanupTimeout, DropRestoringParams{Name: name})
	if err != nil {
		return leftoverText(instance, name, "", moves)
	}
	res := e.Runner.Run(cctx, req, nil)
	var dr DropRestoringResult
	if !res.OK() || res.Decode(&dr) != nil {
		why := "no result"
		if res.Problem != nil {
			why = res.Problem.Message
		}
		e.Log.Warnf("The half-restored database %s could not be checked or dropped: %s.", name, why)
		return leftoverText(instance, name, "", moves)
	}
	switch {
	case dr.Dropped:
		e.Log.Infof("The half-restored database %s was dropped again.", name)
		return "The half-restored database was dropped again."
	case dr.State == "":
		return ""
	}
	return leftoverText(instance, name, dr.State, moves)
}

// cleanupTimeout bounds the cleanup after a restore that did not end.
const cleanupTimeout = 2 * time.Minute

// leftoverText names a database a failed restore may have left, with its
// files, so the run says what stays on the target instance.
func leftoverText(instance, name, state string, moves []api.SQLMove) string {
	var files []string
	for _, m := range moves {
		files = append(files, m.PhysicalName)
	}
	st := "in an unknown state"
	if state != "" && state != "UNKNOWN" {
		st = "in state " + state
	}
	return fmt.Sprintf("A database named %s may be left on instance %s (%s), with its files %s; it was not dropped automatically. Check it and drop it if this restore created it.",
		name, instance, st, strings.Join(files, ", "))
}

func prefixSpace(s string) string {
	if s == "" {
		return ""
	}
	return " " + s
}
