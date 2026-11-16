package core

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/restow-backup/restow/agent/internal/api"
	"github.com/restow-backup/restow/agent/internal/restic"
	"github.com/restow-backup/restow/agent/internal/sqlserver"
	"github.com/restow-backup/restow/agent/internal/status"
)

// The native SQL Server backup in the engine (W2a, docs/BAREMETAL-WINDOWS.md
// 5.1): one sql run per instance after the file run of a slot, the tasks
// sql_verify and sql_restore, and the SQL inventory of the heartbeat.

// SQLSupport is what the engine needs for SQL Server: the script runner and
// the file system. Deps.SQL returns it; on systems without SQL Server
// support it returns sqlserver.ErrUnsupported.
type SQLSupport struct {
	Runner sqlserver.ScriptRunner
	FS     sqlserver.FS
}

// sqlInventoryInterval is how often the inventory is collected while the
// native backup is on (C18). Without it the agent never connects on its own:
// every attempt without a login would write a failed login into the
// instance's error log and security audit.
const sqlInventoryInterval = 6 * time.Hour

// Capabilities are what this agent can do beyond the base protocol (sent at
// enrollment and in each heartbeat).
func Capabilities(sqlSupported bool) []string {
	if sqlSupported {
		return []string{api.CapabilitySQLNative}
	}
	return nil
}

// sqlSupport returns the SQL Server support of this machine, nil when there
// is none (looked up once).
func (a *Agent) sqlSupport() *SQLSupport {
	a.sqlOnce.Do(func() {
		if a.d.SQL == nil {
			return
		}
		s, err := a.d.SQL()
		if err != nil {
			if !errors.Is(err, sqlserver.ErrUnsupported) {
				a.log.Warn("the native SQL Server backup is not available", "error", err)
			}
			return
		}
		a.sql = s
	})
	return a.sql
}

// sqlEnabled reports whether the job switches the native backup on.
func sqlEnabled(cfg *api.Config) bool { return cfg != nil && cfg.SQL != nil && cfg.SQL.Enabled }

// sqlActive: the job switches it on and this machine can do it; on other
// systems the setting is logged once and ignored.
func (a *Agent) sqlActive(cfg *api.Config) bool {
	if !sqlEnabled(cfg) {
		return false
	}
	if a.sqlSupport() == nil {
		a.logRateLimited("sql-ignored", 365*24*time.Hour, slog.LevelInfo,
			"the backup job switches the native SQL Server backup on; this agent ignores it on this system (Windows only)")
		return false
	}
	return true
}

// currentMachine is the latest look at the machine (any goroutine).
func (a *Agent) currentMachine() *machineSnapshot {
	a.mu.Lock()
	m := a.machineSnap
	a.mu.Unlock()
	if m != nil {
		return m
	}
	fresh := a.d.Machine()
	return &machineSnapshot{windows: fresh.Windows}
}

// sqlInstances are the instances of this machine the job selects.
func (a *Agent) sqlInstances(cfg *api.SQLConfig) []api.SQLInstanceFact {
	m := a.currentMachine()
	if m.windows == nil {
		return nil
	}
	var out []api.SQLInstanceFact
	for _, f := range m.windows.SQLInstances {
		if cfg == nil || cfg.Instances.Includes(f.Name) {
			out = append(out, f)
		}
	}
	return out
}

func (a *Agent) allSQLInstances() []api.SQLInstanceFact { return a.sqlInstances(nil) }

func (a *Agent) sqlInstance(name string) (api.SQLInstanceFact, bool) {
	for _, f := range a.allSQLInstances() {
		if strings.EqualFold(f.Name, name) {
			return f, true
		}
	}
	return api.SQLInstanceFact{}, false
}

// sqlEnv is the environment of the flows for one run.
func (a *Agent) sqlEnv(rc *runContext, s *SQLSupport, reporter *progressReporter) *sqlserver.Env {
	e := &sqlserver.Env{
		Runner: s.Runner, FS: s.FS, Restic: rc.runner, Log: rc.rl, Now: a.now, Host: a.d.State.Hostname,
		StagingRoot: a.d.Layout.SQLStagingDir(), RestoreRoot: a.d.Layout.SQLRestoreStagingDir(),
		JournalPath: a.d.Layout.SQLVerifyJournal(), Blocked: sqlBlockedFolders(),
	}
	if c := rc.cfg; c != nil && c.SQL != nil && c.SQL.StagingDir != "" {
		e.StagingRoot, e.CustomStaging = c.SQL.StagingDir, true
	}
	if reporter != nil {
		e.Progress = func(p sqlserver.Progress) {
			reporter.Update(restic.Progress{BytesDone: p.BytesDone, TotalBytes: p.TotalBytes, Percent: float64(p.Percent) / 100,
				CurrentPath: strings.TrimSpace(p.Database + " " + p.Step)})
		}
	}
	return e
}

// sqlKeepalive marks the last progress as new every few minutes, so a long
// step without progress messages (CHECKDB, RESTORE of a large file) still
// tells the server the run is alive (it closes runs that are silent for 6
// hours).
func sqlKeepalive(ctx context.Context, r *progressReporter, every time.Duration) func() {
	kctx, cancel := context.WithCancel(ctx)
	go func() {
		t := time.NewTicker(every)
		defer t.Stop()
		for {
			select {
			case <-kctx.Done():
				return
			case <-t.C:
				r.mu.Lock()
				r.dirty = true
				r.mu.Unlock()
			}
		}
	}()
	return cancel
}

const sqlKeepaliveInterval = 4 * time.Minute

// startSQLRun opens a run of a SQL kind with progress reporting.
func (a *Agent) startSQLRun(rc *runContext) (*progressReporter, func()) {
	reporter := newProgressReporter(a.d.Server, rc.runID, a.o.ProgressInterval, func(err error) {
		a.log.Debug("progress report not delivered", "error", err)
	})
	reporter.Start(rc.ctx)
	stopKeepalive := sqlKeepalive(rc.ctx, reporter, sqlKeepaliveInterval)
	return reporter, func() { stopKeepalive(); reporter.Stop() }
}

// ---- backup ---------------------------------------------------------------

// runSQLBackups runs one sql run per selected instance after the file run
// of a slot (also after a failed one). sqlOnly: the job has no paths, so
// these runs are the slot's backup and count for the schedule.
func (a *Agent) runSQLBackups(ctx context.Context, j job, cfg *api.Config, sqlOnly bool) string {
	s := a.sqlSupport()
	if s == nil || !sqlEnabled(cfg) {
		return ""
	}
	instances := a.sqlInstances(cfg.SQL)
	if len(instances) == 0 {
		a.log.Warn("the native SQL Server backup is on, but this machine has no selected SQL Server instance")
		if sqlOnly {
			a.recordSQLSlot(false)
		}
		return api.StatusFailed
	}
	if sqlOnly {
		_ = a.d.Status.Update(func(st *status.Status) { st.LastAttemptAt = a.now().UTC(); st.Interrupted = false })
	}
	// A sql run never carries the task of the slot (backup_now).
	sj := job{kind: jobBackup, trigger: j.trigger}
	ok := true
	worst := api.StatusSucceeded
	for _, inst := range instances {
		if ctx.Err() != nil {
			ok = false
			break
		}
		rc, err := a.beginRun(ctx, api.RunSQL, sj, cfg)
		if err != nil {
			a.noteServerError("starting a SQL Server backup run", err)
			ok = false
			continue
		}
		reporter, stop := a.startSQLRun(rc)
		rctx, rcancel, timedOut := rc.resticContext()
		res := a.sqlEnv(rc, s, reporter).BackupInstance(rctx, cfg.SQL, inst)
		rcancel()
		stop()
		if res.Inventory != nil {
			a.storeSQLInventory(*res.Inventory)
		}
		out := runOutcome{Status: res.Status, SnapshotID: res.SnapshotID, Stats: res.Stats, Errors: res.Errors,
			SQL: res.Report, Notices: res.Notices}
		if res.Stopped {
			out.Errors = append([]api.RunError(nil), res.Errors...)
			sqlStopped(rc, &out, timedOut())
			if res.SnapshotID == "" {
				out.SQL = nil
			}
		}
		out.Summary = fmt.Sprintf("SQL Server %s: %s", inst.Name, out.Status)
		switch out.Status {
		case api.StatusFailed:
			ok, worst = false, api.StatusFailed
		case api.StatusPartial:
			if worst == api.StatusSucceeded {
				worst = api.StatusPartial
			}
		}
		a.endRun(rc, out)
	}
	if sqlOnly {
		a.recordSQLSlot(ok && ctx.Err() == nil)
	}
	if !ok {
		return api.StatusFailed
	}
	return worst
}

// sqlStopped fills the outcome of a SQL Server run whose context ended:
// the maximum run time, a stop in the Restow UI, or a shutdown.
func sqlStopped(rc *runContext, out *runOutcome, timedOut bool) {
	if timedOut {
		out.fail("timeout", "The %s did not finish within %s and was stopped. SQL Server ends the running statement; a check copy left behind is dropped before the next check.", runNoun(rc.kind), maxRunTime)
		return
	}
	rc.stoppedOutcome(out)
}

// recordSQLSlot records the end of a slot that had only SQL runs, as endRun
// does for a file run.
func (a *Agent) recordSQLSlot(ok bool) {
	now := a.now().UTC()
	_ = a.d.Status.Update(func(s *status.Status) {
		if ok {
			s.ConsecutiveFailures = 0
			s.LastSuccessAt = now
		} else {
			s.ConsecutiveFailures++
		}
	})
}

// ---- inventory ------------------------------------------------------------

// storeSQLInventory puts a fresh instance into the cache and sends the
// inventory with the next heartbeat.
func (a *Agent) storeSQLInventory(ii sqlserver.InstanceInventory) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.sqlInv == nil {
		a.sqlInv = &sqlserver.Inventory{}
	}
	a.sqlInv.Replace(ii)
	a.sqlInv.CollectedAt = a.now().UTC()
	a.sqlInvPending = true
	a.sqlInvGen++
}

// sqlInventoryCache is the cached inventory (nil before the first one).
func (a *Agent) sqlInventoryCache() *sqlserver.Inventory {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.sqlInv
}

// maybeSQLInventory starts the inventory every sqlInventoryInterval while
// the job switches the native backup on, or at once when forced (the
// sql_inventory task). It runs on its own goroutine, one at a time, and asks
// for an early heartbeat when it is done. Only called from the loop.
func (a *Agent) maybeSQLInventory(ctx context.Context, force bool) {
	cfg := a.currentConfig()
	if a.sqlSupport() == nil || (!force && !a.sqlActive(cfg)) {
		return
	}
	a.mu.Lock()
	due := force || a.sqlInvAt.IsZero() || a.now().Sub(a.sqlInvAt) >= sqlInventoryInterval
	if !due || a.sqlInvRunning {
		if force && a.sqlInvRunning {
			a.sqlInvAgain = true
		}
		a.mu.Unlock()
		return
	}
	a.sqlInvRunning, a.sqlInvAt = true, a.now()
	a.mu.Unlock()
	instances := a.allSQLInstances()
	s := a.sqlSupport()
	go func() {
		inv := sqlserver.CollectInventory(ctx, s.Runner, instances, a.now())
		a.mu.Lock()
		again := a.sqlInvAgain
		a.sqlInvRunning, a.sqlInvAgain = false, false
		if ctx.Err() == nil {
			a.sqlInv, a.sqlInvPending = inv, true
			a.sqlInvGen++
			a.heartbeatSoon = true
		}
		a.mu.Unlock()
		for _, ii := range inv.Instances {
			if ii.Problem != nil {
				a.logRateLimited("sql-inventory:"+ii.Fact.Name+":"+ii.Problem.Code, 6*time.Hour, slog.LevelWarn,
					"SQL Server instance "+ii.Fact.Name+" could not be read: "+ii.Problem.Message, "code", ii.Problem.Code)
			}
		}
		if again {
			a.mu.Lock()
			a.sqlInvForce = true
			a.mu.Unlock()
		}
		a.signalWake()
	}()
}

// sqlInventoryForHeartbeat is the inventory to send now (nil when nothing
// new is waiting) and a function that marks it as delivered.
func (a *Agent) sqlInventoryForHeartbeat() (*api.SQLInventory, func()) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if !a.sqlInvPending || a.sqlInv == nil {
		return nil, func() {}
	}
	gen := a.sqlInvGen
	return a.sqlInv.Wire(), func() {
		a.mu.Lock()
		if a.sqlInvGen == gen {
			a.sqlInvPending = false
		}
		a.mu.Unlock()
	}
}

// sqlFileExcludes are the database files the file run leaves out while the
// native backup covers them, plus a custom staging folder; nil when it is
// off. Without a cached inventory it is collected first.
func (a *Agent) sqlFileExcludes(ctx context.Context, cfg *api.Config, rl interface{ Infof(string, ...any) }) []string {
	if !a.sqlActive(cfg) {
		return nil
	}
	inv := a.sqlInventoryCache()
	if inv == nil {
		s := a.sqlSupport()
		inv = sqlserver.CollectInventory(ctx, s.Runner, a.sqlInstances(cfg.SQL), a.now())
		a.mu.Lock()
		if a.sqlInv == nil {
			a.sqlInv, a.sqlInvPending, a.sqlInvAt = inv, true, a.now()
			a.sqlInvGen++
		}
		a.mu.Unlock()
	}
	ex := sqlserver.FileBackupExcludes(inv, cfg.SQL)
	if d := cfg.SQL.StagingDir; d != "" {
		ex = append(ex, d)
	}
	if len(ex) > 0 {
		rl.Infof("The native SQL Server backup is on: %d database files (and its staging folder) are left out of the file backup.", len(ex))
	}
	return ex
}

// ---- tasks ----------------------------------------------------------------

// sqlTaskParams reads the parameters of a SQL task.
func sqlTaskParams(j job, into any) error {
	if j.task == nil || len(j.task.Params) == 0 {
		return errors.New("the task has no parameters")
	}
	return json.Unmarshal(j.task.Params, into)
}

// sqlTaskWaits holds a SQL task back while the server pauses new runs (as
// a backup request waits).
func (a *Agent) sqlTaskWaits(ctx context.Context, j job) (*api.Config, bool) {
	cfg := a.currentConfig()
	if fresh, err := a.fetchConfig(ctx); err == nil {
		a.applyConfig(fresh, "before a SQL Server task")
		cfg = fresh
	}
	if cfg != nil && cfg.StartsPaused {
		a.log.Info("a SQL Server task waits: the Restow instance pauses new runs while it is updated", "task", j.taskID().String())
		time.AfterFunc(a.o.PauseRecheck, func() { a.enqueue(j); a.signalWake() })
		return cfg, true
	}
	return cfg, false
}

func (a *Agent) runSQLVerify(ctx context.Context, j job) {
	cfg, wait := a.sqlTaskWaits(ctx, j)
	if wait {
		return
	}
	var p api.SQLVerifyParams
	perr := sqlTaskParams(j, &p)
	rc, err := a.beginRun(ctx, api.RunSQLVerify, j, cfg)
	if err != nil {
		a.startFailed(j, "SQL Server check", err)
		return
	}
	out := runOutcome{Status: api.StatusFailed}
	s := a.sqlSupport()
	fact, found := a.sqlInstance(p.Instance)
	switch {
	case perr != nil:
		out.fail("invalid_task", "Invalid parameters of the SQL Server check: %v", perr)
	case s == nil:
		out.fail(api.SQLScriptFailed, "This agent cannot check SQL Server backups on this system.")
	case !found:
		out.fail(api.SQLInstanceUnreachable, "SQL Server instance %s is not on this machine.", p.Instance)
	default:
		reporter, stop := a.startSQLRun(rc)
		rctx, rcancel, timedOut := rc.resticContext()
		res := a.sqlEnv(rc, s, reporter).Verify(rctx, p, fact, rc.runID.String())
		rcancel()
		stop()
		out = runOutcome{Status: res.Status, Errors: res.Errors, SQLVerify: res.Report}
		if res.Stopped {
			sqlStopped(rc, &out, timedOut())
		}
	}
	if len(out.Errors) > 0 && out.SQLVerify == nil {
		rc.rl.Errorf("%s", out.Errors[0].Message)
	}
	out.Summary = "SQL Server check: " + out.Status
	a.endRun(rc, out)
}

func (a *Agent) runSQLRestore(ctx context.Context, j job) {
	cfg, wait := a.sqlTaskWaits(ctx, j)
	if wait {
		return
	}
	var p api.SQLRestoreParams
	perr := sqlTaskParams(j, &p)
	rc, err := a.beginRun(ctx, api.RunSQLRestore, j, cfg)
	if err != nil {
		a.startFailed(j, "SQL Server restore", err)
		return
	}
	out := runOutcome{Status: api.StatusFailed}
	s := a.sqlSupport()
	target := p.TargetInstance
	if target == "" {
		target = p.Instance
	}
	fact, found := a.sqlInstance(target)
	switch {
	case perr != nil:
		out.fail("invalid_task", "Invalid parameters of the SQL Server restore: %v", perr)
	case s == nil:
		out.fail(api.SQLScriptFailed, "This agent cannot restore SQL Server backups on this system.")
	case !found:
		out.fail(api.SQLInstanceUnreachable, "SQL Server instance %s is not on this machine.", target)
	default:
		reporter, stop := a.startSQLRun(rc)
		rctx, rcancel, timedOut := rc.resticContext()
		res := a.sqlEnv(rc, s, reporter).Restore(rctx, p, fact, rc.runID.String())
		rcancel()
		stop()
		out = runOutcome{Status: res.Status, Errors: res.Errors, SQLRestore: res.Report}
		if res.Stopped {
			sqlStopped(rc, &out, timedOut())
		}
	}
	if len(out.Errors) > 0 && out.SQLRestore == nil {
		rc.rl.Errorf("%s", out.Errors[0].Message)
	}
	out.Summary = "SQL Server restore: " + out.Status
	a.endRun(rc, out)
}
