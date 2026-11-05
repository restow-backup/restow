package sqlserver

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"
	"time"

	"github.com/restow-backup/restow/agent/internal/api"
)

// VerifyOutcome is how a sql_verify run ended. The report holds facts
// only: the server decides whether a backup is proven good, proven bad or
// the check is incomplete (packages/core/src/endpoints/sql/judge.ts).
type VerifyOutcome struct {
	Status  string
	Report  *api.SQLVerifyReport
	Errors  []api.RunError
	Stopped bool
}

// mediaErrors are the RESTORE errors that are caused by the backup file
// itself (the server's judge counts them as proof the backup is bad).
var mediaErrors = map[int]bool{3183: true, 3189: true, 3241: true, 3242: true, 3243: true}

// systemDatabases are verified like user databases (C22).
var systemDatabases = map[string]bool{"master": true, "model": true, "msdb": true}

// checkCatalogError is the CHECKDB error that carries a failed system
// catalog check ("Check Catalog Msg 3851 ...").
const checkCatalogError = 8992

// checkdbTotals are the closing lines of CHECKDB that count the errors
// listed on their own rows: per table (8990), not associated with any
// single object (8991, where the catalog errors are counted) and per
// database (8989, which JudgeCheckdb already leaves out).
var checkdbTotals = map[int]bool{8989: true, 8990: true, 8991: true}

// masterCatalogOnly reports whether a CHECKDB of a copy of master found
// nothing but catalog errors (and the lines that count them). A copy of
// master under a check name is no master: its catalog holds rows of
// server-level objects that only master may hold, and CHECKDB reports each
// as error 8992 (the CI showed this on SQL Server 2019 and 2022 Express,
// C22). Such a result proves neither a good nor a bad backup. Any other
// error stays evidence of damage.
func masterCatalogOnly(name string, errs []api.SQLCheckdbError) bool {
	if !strings.EqualFold(name, "master") {
		return false
	}
	catalog := 0
	for _, e := range errs {
		switch {
		case e.Number == checkCatalogError:
			catalog++
		case checkdbTotals[e.Number]:
		default:
			return false
		}
	}
	return catalog > 0
}

// errorNumbers lists the distinct numbers of CHECKDB errors in their order,
// for the run log.
func errorNumbers(errs []api.SQLCheckdbError) string {
	seen := map[int]bool{}
	var out []string
	for _, e := range errs {
		if !seen[e.Number] {
			seen[e.Number] = true
			out = append(out, fmt.Sprint(e.Number))
		}
	}
	return strings.Join(out, ", ")
}

// Verify checks the backups a sql_verify task names (docs/BAREMETAL-
// WINDOWS.md 5.1.7): leftovers of an earlier check are dropped (only names
// from the journal), then for each database the backup is fetched from the
// repository, its SHA-256 compared, restored under a check name with the
// MOVE targets from FILELISTONLY of the fetched file, cut off the Service
// Broker, checked with DBCC CHECKDB and dropped again.
func (e *Env) Verify(ctx context.Context, p api.SQLVerifyParams, fact api.SQLInstanceFact, runID string) VerifyOutcome {
	out := VerifyOutcome{Status: statusFailed, Report: &api.SQLVerifyReport{Instance: fact.Name, Databases: []api.SQLVerifyResult{}}}
	if len(p.Databases) > api.MaxSQLDatabases {
		p.Databases = p.Databases[:api.MaxSQLDatabases]
	}
	results := make([]api.SQLVerifyResult, len(p.Databases))
	for i, d := range p.Databases {
		results[i] = api.SQLVerifyResult{DatabaseID: d.DatabaseID, BackupID: d.BackupID, Name: d.Name, Method: api.SQLMethodRestoreCheckdb}
	}
	incompleteAll := func(prob *Problem) VerifyOutcome {
		for i := range results {
			results[i].Code, results[i].Message = prob.Code, prob.Message
		}
		out.Report.Databases = results
		out.Errors = append(out.Errors, runError(prob))
		e.Log.Errorf("%s", prob.Message)
		return out
	}
	if !ValidInstanceName(fact.Name) {
		return incompleteAll(&Problem{Code: api.SQLInstanceUnreachable, Step: StepRequest, Message: fmt.Sprintf("The SQL Server instance name %q is not valid.", fact.Name)})
	}
	if fact.Clustered {
		return incompleteAll(&Problem{Code: api.SQLFCIUnsupported, Step: StepRequest, Message: fmt.Sprintf("SQL Server instance %s is a failover cluster instance; checks are not supported there yet.", fact.Name)})
	}
	e.cleanupLeftovers(ctx, fact.Name)
	e.clearRestoreRoot()
	ii := ReadInstance(ctx, e.Runner, fact)
	if ctx.Err() != nil {
		out.Stopped = true
		return out
	}
	if ii.Problem != nil {
		return incompleteAll(&Problem{Code: ii.Problem.Code, Step: ii.Problem.Step, Number: ii.Problem.Number,
			Message: BoundMessage(fmt.Sprintf("SQL Server instance %s: %s", fact.Name, ii.Problem.Message))})
	}
	sid := serviceSID(fact.Name)
	runDir := filepath.Join(e.RestoreRoot, safeRunID(runID))
	defer func() {
		if err := e.FS.RemoveAll(runDir); err != nil {
			e.Log.Warnf("The restore staging folder %s could not be deleted: %v.", runDir, err)
		}
	}()
	maxBytes := int64(p.MaxGiB) * GiB
	green := 0
	for i, d := range p.Databases {
		if ctx.Err() != nil {
			out.Stopped = true
			break
		}
		physical := p.PhysicalOnly || (maxBytes > 0 && d.UsedBytes > maxBytes)
		started := e.now()
		e.verifyOne(ctx, &results[i], d, ii.Result, fact, sid, physical, filepath.Join(runDir, fmt.Sprint(i)))
		results[i].DurationMs = e.now().Sub(started).Milliseconds()
		r := results[i]
		switch {
		case r.Restore != nil && r.Restore.OK && r.Checkdb != nil && r.Checkdb.Ran && len(r.Checkdb.Errors) == 0 && r.SHA256Match:
			green++
			kind := ""
			if r.Checkdb.PhysicalOnly {
				kind = " (PHYSICAL_ONLY)"
			}
			e.Log.Infof("%s: restored from the repository and checked with DBCC CHECKDB%s without errors.", d.Name, kind)
		case r.Checkdb != nil && len(r.Checkdb.Errors) > 0:
			msg := BoundMessage(fmt.Sprintf("%s: DBCC CHECKDB reported %d error(s) (numbers %s) in the backup restored from the repository; first: %s (%d).",
				d.Name, len(r.Checkdb.Errors), errorNumbers(r.Checkdb.Errors), r.Checkdb.Errors[0].Message, r.Checkdb.Errors[0].Number))
			e.Log.Errorf("%s", msg)
			out.Errors = append(out.Errors, api.RunError{Message: msg})
		case r.Code != "":
			out.Errors = append(out.Errors, api.RunError{Code: r.Code, Message: r.Message})
		}
	}
	out.Report.Databases = results
	switch {
	case out.Stopped:
	case green == len(results):
		out.Status = statusSucceeded
	case green > 0:
		out.Status = statusPartial
	}
	return out
}

// verifyOne checks the backup of one database into r.
func (e *Env) verifyOne(ctx context.Context, r *api.SQLVerifyResult, d api.SQLVerifyDatabase, inst *InventoryResult, fact api.SQLInstanceFact, sid string, physical bool, target string) {
	incomplete := func(code, format string, args ...any) {
		r.Code, r.Message = code, BoundMessage(fmt.Sprintf(format, args...))
		e.Log.Warnf("%s", r.Message)
	}
	defer func() {
		if err := e.FS.RemoveAll(target); err != nil {
			e.Log.Warnf("The fetched backup of %s could not be deleted from %s: %v.", d.Name, target, err)
		}
	}()
	if err := checkFetchParams(d.SnapshotID, d.PathInSnapshot, d.SHA256, d.FileList); err != nil || d.Name == "" {
		incomplete(api.SQLScriptFailed, "%s was not checked: the task is not valid (%v).", d.Name, err)
		return
	}
	need := NeedOf(d.Bytes, d.FileList)
	if why := e.spaceCheck(need, inst.DefaultDataPath, logDirOf(inst), d.Name); why != "" {
		incomplete(api.SQLVerifyNoSpace, "%s was not checked: %s. The check is incomplete, not failed.", d.Name, why)
		return
	}
	f := e.fetch(ctx, d.SnapshotID, d.PathInSnapshot, d.SHA256, d.Bytes, target, []string{sid}, d.Name)
	r.Fetched, r.SHA256Match = f.Fetched, f.Match
	if f.Problem != nil {
		if ctx.Err() == nil {
			incomplete(f.Problem.Code, "%s", f.Problem.Message)
		}
		return
	}
	step := StepTimeout(max(d.UsedBytes, d.Bytes))
	name := VerifyName(d.Name, e.now())
	flReq, _ := NewRequest(OpFileList, fact.Name, step, FileListParams{Path: f.Local, CheckName: name})
	fl := e.Runner.Run(ctx, flReq, nil)
	if !fl.OK() {
		if ctx.Err() != nil {
			return
		}
		if fl.Problem != nil && mediaErrors[fl.Problem.Number] {
			// RESTORE HEADERONLY or FILELISTONLY fails on the file itself.
			r.Restore = &api.SQLRestoreStep{OK: false, Errors: []api.SQLError{{Number: fl.Problem.Number, Severity: 16, State: 1, Message: fl.Problem.Message}}}
			incomplete(api.SQLRestoreFailed, "%s: SQL Server cannot read the backup from the repository: %s", d.Name, fl.Problem.Message)
			return
		}
		incomplete(codeOr(fl, api.SQLScriptFailed), "%s was not checked: %s", d.Name, fl.Problem.Message)
		return
	}
	var list FileListResult
	if err := fl.Decode(&list); err != nil {
		incomplete(api.SQLScriptFailed, "%s was not checked: the file list could not be read: %v.", d.Name, err)
		return
	}
	r.BackupLSN = list.LastLSN
	if list.NameTaken {
		incomplete(api.SQLRestoreNameTaken, "%s was not checked: a database named %s exists already.", d.Name, name)
		return
	}
	moves, err := MoveTargets(name, MoveSuffix(name, target), list.FileList, list.DefaultDataPath, list.DefaultLogPath)
	if err != nil {
		incomplete(api.SQLScriptFailed, "%s was not checked: %v.", d.Name, err)
		return
	}
	// The name goes into the journal before the RESTORE: a copy left by a
	// crash from here on is dropped before the next check.
	if err := e.journal().Add(fact.Name, name, e.now()); err != nil {
		incomplete(api.SQLScriptFailed, "%s was not checked: the journal of check copies could not be written: %v.", d.Name, err)
		return
	}
	r.VerifyName = name
	vReq, _ := NewRequest(OpVerify, fact.Name, step, VerifyParams{VerifyName: name, Path: f.Local, Moves: moves, PhysicalOnly: physical})
	e.Log.Infof("Restoring %s as %s and checking it with DBCC CHECKDB%s.", d.Name, name, map[bool]string{true: " (PHYSICAL_ONLY)", false: ""}[physical])
	v := e.Runner.Run(ctx, vReq, func(l Line) {
		e.progress(Progress{Database: d.Name, Step: l.Step, Percent: l.Percent})
	})
	if !v.OK() {
		if ctx.Err() != nil {
			return
		}
		code := codeOr(v, api.SQLScriptFailed)
		if v.TimedOut {
			code = api.SQLVerifyTimeout
		}
		incomplete(code, "%s was not checked to the end: %s", d.Name, v.Problem.Message)
		e.dropNow(ctx, fact.Name, name)
		return
	}
	var vr VerifyResult
	if err := v.Decode(&vr); err != nil {
		incomplete(api.SQLScriptFailed, "%s: the result of the check could not be read: %v.", d.Name, err)
		e.dropNow(ctx, fact.Name, name)
		return
	}
	if len(vr.Restore.Errors) > api.MaxSQLRestoreErrors {
		vr.Restore.Errors = vr.Restore.Errors[:api.MaxSQLRestoreErrors]
	}
	r.Restore = &api.SQLRestoreStep{OK: vr.Restore.OK, Errors: nonNilErrors(vr.Restore.Errors)}
	if vr.Checkdb != nil {
		c, prob := JudgeCheckdb(*vr.Checkdb, vr.CheckdbRaised, vr.CheckdbProblem)
		vr.Checkdb, vr.CheckdbProblem = &c, prob
		r.Checkdb = &c
	}
	r.Dropped = vr.Dropped
	if vr.Dropped {
		if err := e.journal().Remove(fact.Name, name); err != nil {
			e.Log.Warnf("The journal of check copies could not be updated: %v.", err)
		}
	} else if vr.DropError != nil {
		e.Log.Warnf("The check copy %s could not be dropped (%s); it is dropped before the next check.", name, vr.DropError.Message)
	}
	switch {
	case !vr.Restore.OK:
		first := ""
		red := false
		for _, x := range vr.Restore.Errors {
			if mediaErrors[x.Number] {
				red = true
			}
			if first == "" && x.Number != 3013 {
				first = fmt.Sprintf("%s (%d)", x.Message, x.Number)
			}
		}
		if !red && systemDatabases[strings.ToLower(d.Name)] {
			incomplete(api.SQLVerifySystemDB, "%s: the system database could not be restored under a check name (%s); its backup is not checked.", d.Name, first)
			return
		}
		incomplete(api.SQLRestoreFailed, "%s: RESTORE of the backup failed: %s", d.Name, first)
	case vr.Checkdb != nil && vr.Checkdb.Ran && masterCatalogOnly(d.Name, vr.Checkdb.Errors):
		// Not evidence (C22): the check is incomplete, never red.
		n, numbers := len(vr.Checkdb.Errors), errorNumbers(vr.Checkdb.Errors)
		r.Checkdb = &api.SQLCheckdbResult{Ran: false, PhysicalOnly: vr.Checkdb.PhysicalOnly, Errors: []api.SQLCheckdbError{}, DurationMs: vr.Checkdb.DurationMs}
		incomplete(api.SQLVerifySystemDB, "%s: DBCC CHECKDB of the copy under a check name reported only catalog errors (%d rows, numbers %s), as it does for every copy of master under another name; its backup is not checked.", d.Name, n, numbers)
	case vr.Checkdb == nil && !vr.NewBroker:
		msg := "ALTER DATABASE SET NEW_BROKER failed"
		if vr.NewBrokerProblem != nil {
			msg += ": " + vr.NewBrokerProblem.Message
		}
		incomplete(api.SQLScriptFailed, "%s was not checked with DBCC CHECKDB: %s.", d.Name, msg)
	case vr.Checkdb != nil && !vr.Checkdb.Ran:
		code, msg := api.SQLScriptFailed, "DBCC CHECKDB did not run to its end"
		if vr.CheckdbProblem != nil {
			code, msg = vr.CheckdbProblem.Code, msg+": "+vr.CheckdbProblem.Message
		}
		incomplete(code, "%s: %s.", d.Name, msg)
	}
}

// cleanupLeftovers drops the check copies the journal still lists for an
// instance (a crash or a stop during an earlier check), and only those.
func (e *Env) cleanupLeftovers(ctx context.Context, instance string) {
	names, err := e.journal().Leftovers(instance)
	if err != nil {
		e.Log.Warnf("The journal of check copies could not be read: %v. Check copies left by an earlier check are not dropped.", err)
		return
	}
	if len(names) == 0 {
		return
	}
	e.Log.Infof("Dropping %d check copies left by an earlier check: %s.", len(names), strings.Join(names, ", "))
	e.dropNow(ctx, instance, names...)
}

// dropNow drops check copies of the journal and takes the dropped ones out.
func (e *Env) dropNow(ctx context.Context, instance string, names ...string) {
	var safe []string
	for _, n := range names {
		if IsVerifyName(n) {
			safe = append(safe, n)
		}
	}
	if len(safe) == 0 || ctx.Err() != nil {
		return
	}
	req, _ := NewRequest(OpDrop, instance, 30*time.Minute, DropParams{Names: safe})
	res := e.Runner.Run(ctx, req, nil)
	var dr DropResult
	if !res.OK() || res.Decode(&dr) != nil {
		msg := "no result"
		if res.Problem != nil {
			msg = res.Problem.Message
		}
		e.Log.Warnf("Check copies could not be dropped (%s); the next check tries again.", msg)
		return
	}
	for _, f := range dr.Failed {
		e.Log.Warnf("The check copy %s could not be dropped: %s.", f.Name, f.Problem.Message)
	}
	if len(dr.Dropped) > 0 {
		if err := e.journal().Remove(instance, dr.Dropped...); err != nil {
			e.Log.Warnf("The journal of check copies could not be updated: %v.", err)
		}
	}
}

func codeOr(r Result, fallback string) string {
	if r.Problem != nil && r.Problem.Code != "" {
		return r.Problem.Code
	}
	return fallback
}

func nonNilErrors(e []api.SQLError) []api.SQLError {
	if e == nil {
		return []api.SQLError{}
	}
	return e
}

func logDirOf(inst *InventoryResult) string {
	if inst.DefaultLogPath != "" {
		return inst.DefaultLogPath
	}
	return inst.DefaultDataPath
}

// safeRunID keeps a run id usable as a folder name.
func safeRunID(id string) string {
	if id == "" {
		return "run"
	}
	return SafeName(id, 64)
}
