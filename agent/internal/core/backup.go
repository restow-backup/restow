package core

import (
	"context"
	"errors"
	"fmt"
	"runtime"
	"strings"
	"time"

	"github.com/restow-backup/restow/agent/internal/api"
	"github.com/restow-backup/restow/agent/internal/hooks"
	"github.com/restow-backup/restow/agent/internal/lock"
	"github.com/restow-backup/restow/agent/internal/paths"
	"github.com/restow-backup/restow/agent/internal/restic"
)

// ErrBusy is returned by BackupNow when another run holds the run lock.
var ErrBusy = lock.ErrLocked

// ErrNoJob is returned when the machine is in no backup job (schedule none):
// it has nothing to back up until an administrator adds it to a job.
var ErrNoJob = errors.New("this machine is in no backup job; add it to a backup job in the Restow UI (Backup jobs) to back it up")

// ErrStartsPaused is returned when the Restow instance pauses new runs while
// it is updated: no run was started, nothing failed. The backup can start
// once the pause is over.
var ErrStartsPaused = errors.New("the Restow instance pauses new backups while it is updated")

// snapshotTag marks snapshots created by the agent.
const snapshotTag = "restow-agent"

// BackupNow runs one backup in the foreground (used by `restow-agent
// backup-now`). It fails with ErrBusy when the service or another process is
// running a backup right now. The returned outcome is nil when no run could be
// started.
func (a *Agent) BackupNow(ctx context.Context) (*Outcome, error) {
	lk, err := lock.TryAcquire(a.d.Layout.LockFile())
	if err != nil {
		return nil, err
	}
	defer lk.Release()
	if v, verr := a.d.Restic.Version(ctx); verr == nil {
		a.resticVer = v
	} else {
		return nil, fmt.Errorf("restic is not usable: %w (re-run the install script to repair the installation)", verr)
	}
	out, err := a.runBackup(ctx, job{kind: jobBackup, trigger: triggerCLI})
	if err != nil {
		return nil, err
	}
	return &Outcome{Status: out.Status, SnapshotID: out.SnapshotID, Errors: out.Errors}, nil
}

// Outcome is the public summary of a foreground run.
type Outcome struct {
	Status     string
	SnapshotID string
	Errors     []api.RunError
}

func (a *Agent) runBackup(ctx context.Context, j job) (runOutcome, error) {
	cfg := a.currentConfig()
	if fresh, err := a.fetchConfig(ctx); err == nil {
		a.setReachable(true)
		a.applyConfig(fresh, "before backup")
		cfg = fresh
	} else if cfg == nil || j.trigger == triggerSchedule {
		// A scheduled start waits for the server (it is not counted as an
		// attempt); the schedule starts it again once the server answers.
		if ctx.Err() == nil {
			a.noteServerError("fetching the configuration", err)
		}
		return runOutcome{}, err
	}
	if cfg.StartsPaused {
		// The server pauses new runs for an update (docs/UPDATING.md). Nothing
		// starts and nothing counts as failed: the schedule starts the backup
		// when the pause is over, a task waits for it.
		switch j.trigger {
		case triggerTask:
			a.log.Info("a backup request waits: the Restow instance pauses new backups while it is updated", "task", j.taskID().String())
			time.AfterFunc(a.o.PauseRecheck, func() { a.enqueue(j); a.signalWake() })
		case triggerSchedule:
			a.log.Info("a scheduled backup waits: the Restow instance pauses new backups while it is updated")
		}
		return runOutcome{}, ErrStartsPaused
	}
	if cfg.Schedule.Kind == api.ScheduleNone {
		// Nothing to back up: no run is started (a scheduled start never gets here,
		// a request from the server is not sent for such a machine).
		a.log.Info("not backing up: this machine is in no backup job", "trigger", j.trigger)
		return runOutcome{}, ErrNoJob
	}
	sqlOn := a.sqlActive(cfg)
	if sqlOn && len(cfg.Paths) == 0 {
		// Only the native SQL Server backup: no file run is started.
		a.log.Info("the backup job has no paths; only the native SQL Server backup runs")
		return runOutcome{Status: a.runSQLBackups(ctx, j, cfg, true), Summary: "SQL Server backup"}, nil
	}
	rc, err := a.beginRun(ctx, api.RunBackup, j, cfg)
	if err != nil {
		a.startFailed(j, "backup", err)
		return runOutcome{}, err
	}
	out := a.doBackup(rc)
	a.endRun(rc, out)
	// Then one sql run per instance, also after a failed file run; not
	// after a stop (the job's context ended).
	if sqlOn && ctx.Err() == nil {
		a.runSQLBackups(ctx, j, cfg, false)
	}
	return out, nil
}

func (a *Agent) doBackup(rc *runContext) runOutcome {
	out := a.doFileBackup(rc)
	// The fixed warnings of a Windows machine with a database role (W1).
	if m := a.currentMachine(); m.windows != nil {
		out.Notices = append(out.Notices, AppFileNotices(m.windows, rc.cfg.SQL, a.sqlActive(rc.cfg))...)
	}
	return out
}

func (a *Agent) doFileBackup(rc *runContext) runOutcome {
	out := runOutcome{Status: api.StatusFailed}
	rl, cfg := rc.rl, rc.cfg

	ownPaths, foreign := ownFormSources(cfg.Paths, runtime.GOOS == "windows")
	if len(foreign) > 0 {
		rl.Infof("Paths for other operating systems are skipped on this machine: %s.", strings.Join(foreign, ", "))
	}
	split := splitSources(ownPaths)
	sources := split.existing
	for _, m := range split.missing {
		rl.Warnf("Path %s does not exist on this machine and is skipped.", m)
	}
	for _, r := range split.resolved {
		rl.Infof("Path %s is a %s; backing up %s.", r.Configured, r.Kind, r.Resolved)
	}
	// A source that exists but cannot be backed up as configured is an error
	// of the run, never a silent skip: the run ends partial at best.
	for _, e := range split.problems {
		rl.Errorf("%s", e.Message)
	}
	out.Errors = append(out.Errors, split.problems...)
	if len(sources) == 0 {
		if len(split.problems) > 0 {
			return out
		}
		if len(cfg.Paths) == 0 {
			out.fail("no_paths", "No backup paths are configured for this endpoint. Set them in the Restow UI (Endpoints, Settings).")
		} else if len(ownPaths) == 0 {
			out.fail("no_paths", "None of the configured backup paths is a path of this operating system: %s. Add folders for this machine to its backup job.", strings.Join(foreign, ", "))
		} else {
			out.fail("no_paths", "None of the configured backup paths exists on this machine: %s.", strings.Join(cfg.Paths, ", "))
		}
		rl.Errorf("%s", out.Errors[0].Message)
		return out
	}
	rl.Infof("Backing up: %s", strings.Join(sources, ", "))

	hookEnv := func(kind hooks.Kind, statusText string) []string {
		env := []string{"RESTOW_ENDPOINT_ID=" + a.d.State.EndpointID, "RESTOW_RUN_ID=" + rc.runID.String(), "RESTOW_HOOK=" + string(kind)}
		if statusText != "" {
			env = append(env, "RESTOW_BACKUP_STATUS="+statusText)
		}
		return env
	}

	// Hooks run only as far as this machine allows (state.json, set by root on
	// the machine). A refused hook is reported and the backup runs without it.
	mode, hooksDir := a.hooksPolicy()
	resolveHook := func(kind hooks.Kind, configured string) []string {
		if strings.TrimSpace(configured) == "" {
			return nil
		}
		argv, err := hooks.Resolve(mode, hooksDir, configured)
		if err != nil {
			rl.Warnf("The %s-backup hook is configured on the server but was not run: %v", kind, err)
			out.Errors = append(out.Errors, api.RunError{Code: "hooks_not_allowed",
				Message: fmt.Sprintf("The %s-backup hook was not run: %v. The backup ran without it; data the hook prepares (for example a database dump) may be missing or inconsistent.", kind, err)})
			return nil
		}
		return argv
	}
	preArgv := resolveHook(hooks.Pre, cfg.Hooks.Pre)
	postArgv := resolveHook(hooks.Post, cfg.Hooks.Post)
	refused := len(out.Errors) > 0

	// Pre hook (for example a database dump). Without it succeeding the data
	// may be inconsistent, so the backup does not start.
	proceed := true
	if preArgv != nil {
		rl.Infof("Running the pre-backup hook (timeout %s).", hooks.PreTimeout)
		res, err := hooks.Run(rc.ctx, hooks.Options{Kind: hooks.Pre, Argv: preArgv, Timeout: hooks.PreTimeout,
			Env: hookEnv(hooks.Pre, ""), Output: func(l string) { rl.Raw("pre-hook", l) }})
		switch {
		case err == nil:
			rl.Infof("Pre-backup hook finished in %s.", res.Duration.Round(time.Millisecond))
		case rc.ctx.Err() != nil:
			proceed = false
			rc.stoppedOutcome(&out)
		default:
			proceed = false
			rl.Errorf("%v", err)
			out.Errors = append(out.Errors, api.RunError{Code: "pre_hook_failed",
				Message: "The pre-backup hook failed (" + err.Error() + "). The backup was not started because the data may be inconsistent."})
		}
	}

	if proceed {
		out = a.backupStep(rc, out, sources, split.resolved)
		// A hook that was not allowed or a source that could not be read makes a
		// good backup partial: it is not what was configured.
		if refused && out.Status == api.StatusSucceeded {
			out.Status = api.StatusPartial
		}
	}

	// Post hook: always runs when configured, so cleanup happens even after a failure.
	if postArgv != nil {
		hctx := rc.ctx
		if hctx.Err() != nil {
			var cancel context.CancelFunc
			hctx, cancel = context.WithTimeout(context.WithoutCancel(hctx), 2*time.Minute)
			defer cancel()
		}
		rl.Infof("Running the post-backup hook (timeout %s).", hooks.PostTimeout)
		res, err := hooks.Run(hctx, hooks.Options{Kind: hooks.Post, Argv: postArgv, Timeout: hooks.PostTimeout,
			Env: hookEnv(hooks.Post, out.Status), Output: func(l string) { rl.Raw("post-hook", l) }})
		if err != nil {
			rl.Errorf("%v", err)
			out.Errors = append(out.Errors, api.RunError{Code: "post_hook_failed", Message: "The post-backup hook failed: " + err.Error()})
			if out.Status == api.StatusSucceeded {
				out.Status = api.StatusPartial
			}
		} else {
			rl.Infof("Post-backup hook finished in %s.", res.Duration.Round(time.Millisecond))
		}
	}
	return out
}

func (a *Agent) backupStep(rc *runContext, out runOutcome, sources []string, resolved []sourceNote) runOutcome {
	rl, cfg := rc.rl, rc.cfg
	// A previous run that was cut short may have left a lock; restic removes
	// only provably stale ones.
	if st := a.d.Status.Snapshot(); st.Interrupted || st.ConsecutiveFailures > 0 {
		uctx, cancel := context.WithTimeout(rc.ctx, time.Minute)
		if err := rc.runner.Unlock(uctx); err != nil && rc.ctx.Err() == nil {
			rl.Warnf("Removing stale repository locks failed (continuing): %v", err)
		}
		cancel()
	}

	limit := 0
	if cfg.BandwidthKbps != nil && *cfg.BandwidthKbps > 0 {
		limit = kbpsToKiB(*cfg.BandwidthKbps)
		rl.Infof("Upload limited to %d KiB/s (configured %d kbit/s).", limit, *cfg.BandwidthKbps)
	}
	// Files above the size limit are skipped silently by restic; the log says that the limit is on.
	var sizeLimit int64
	if cfg.ExcludeLargerThanBytes > 0 {
		sizeLimit = cfg.ExcludeLargerThanBytes
		rl.Infof("Files larger than %s are not backed up (size limit of the backup job).", formatBytes(uint64(sizeLimit)))
	}
	excludes := append([]string(nil), cfg.Excludes...)
	// Never back up the agent's own working files or earlier restores.
	excludes = append(excludes, a.d.Layout.CacheDir(), a.d.Layout.TmpDir(), "Restow-Restore-*")
	// While the native SQL Server backup covers them, the database files
	// (and a staging folder of the job) stay out of the file backup.
	excludes = append(excludes, a.sqlFileExcludes(rc.ctx, cfg, rl)...)

	opts := restic.BackupOptions{
		Paths: sources, Excludes: excludes, Host: a.d.State.Hostname, Tags: []string{snapshotTag},
		LimitUploadKiB: limit, ExcludeLargerThanBytes: sizeLimit,
	}
	platformBackupOptions(&opts, a.d.Layout)
	if opts.ExcludeCloudFiles {
		rl.Infof("Online-only cloud files (OneDrive and similar) are not backed up and not downloaded (--exclude-cloud-files).")
	}

	// The file system snapshot and its policy (docs/WINDOWS-AGENT.md, 17).
	plan := planSnapshotFn(cfg, sources)
	failPolicy := snapshotFailPolicy(cfg)
	for _, n := range plan.notes {
		rl.Infof("%s", n)
	}
	if plan.unavailable != "" {
		if failPolicy {
			e := snapshotUnavailableError(plan.unavailable, false)
			rl.Errorf("%s", e.Message)
			out.Errors = append(out.Errors, e)
			out.Consistency = consistencyOf(plan, restic.SnapshotOutcome{}, true)
			return out
		}
		e := snapshotUnavailableError(plan.unavailable, true)
		rl.Warnf("%s", e.Message)
		out.Errors = append(out.Errors, e)
	}
	if plan.requested {
		opts.UseFSSnapshot = true
		opts.VSSTimeout = vssTimeout
		opts.VSSExcludeVolumes = plan.vssExclude
		rl.Infof("Backing up from a shadow copy (Volume Shadow Copy); if it fails, the backup %s.",
			map[bool]string{true: "stops (policy)", false: "continues from the live file system and ends partial (policy)"}[failPolicy])
	}

	reporter := newProgressReporter(a.d.Server, rc.runID, a.o.ProgressInterval, func(err error) {
		a.log.Debug("progress report not delivered", "error", err)
	})
	reporter.Start(rc.ctx)
	rctx, rcancel, timedOut := rc.resticContext()
	defer rcancel()
	// Under the policy fail the agent stops restic at the first volume whose
	// snapshot failed, with its own cause (else it would read as interrupted).
	sctx, scancel := context.WithCancelCause(rctx)
	defer scancel(nil)
	if plan.requested && failPolicy {
		opts.OnSnapshotFailed = func(v restic.VolumeFailure) { scancel(errSnapshotFailed) }
	}
	opts.OnProgress = func(p restic.Progress) {
		reporter.Update(p)
		a.log.Debug("backup progress", "files", p.FilesDone, "bytes", formatBytes(p.BytesDone), "percent", int(p.Percent*100))
	}
	res, err := rc.runner.Backup(sctx, opts)
	snapUnavailable := plan.unavailable != ""

	// The snapshot cannot be used at all (restic's own VSS setup failed):
	// under continue the backup runs again without it (both runs count
	// against the maximum run time). Only that evidence leads to a backup
	// without a shadow copy; an unknown early failure is an ordinary failure
	// (docs/WINDOWS-AGENT.md, 17.3).
	var re *restic.Error
	if err != nil && plan.requested && rc.ctx.Err() == nil && !timedOut() && errors.As(err, &re) && re.Snapshot != restic.SnapshotFaultNone {
		reason := re.Message
		if reason == "" {
			reason = "no error message"
		}
		switch {
		case !re.SnapshotUnavailable():
			rl.Infof("restic ended before reading anything; should this repeat with the shadow copy, its cause may be the Volume Shadow Copy service (%s).", snapshotLogHint)
		case failPolicy:
			reporter.Stop()
			e := vssSetupFailedError(reason, false)
			rl.Errorf("%s See %s.", e.Message, snapshotLogHint)
			out.Errors = append(out.Errors, e)
			out.Consistency = consistencyOf(plan, restic.SnapshotOutcome{}, true)
			return out
		default:
			rl.Warnf("restic could not initialise the Volume Shadow Copy service (%s); backing up again without it. See %s.", reason, snapshotLogHint)
			opts.UseFSSnapshot, opts.OnSnapshotFailed = false, nil
			res, err = rc.runner.Backup(sctx, opts)
			if err == nil {
				// Only a backup that was made without the shadow copy says so.
				snapUnavailable = true
				out.Errors = append(out.Errors, vssSetupFailedError(reason, true))
			} else {
				rl.Warnf("The backup without the shadow copy failed as well; its error below is the cause of this run.")
			}
		}
	}
	reporter.Stop()

	var snap restic.SnapshotOutcome
	if res != nil {
		snap = res.Snapshot
	} else if errors.As(err, &re) && re.SnapshotOutcome != nil {
		snap = *re.SnapshotOutcome
	}
	logSnapshotOutcome(rl, snap, plan)

	if err != nil || context.Cause(sctx) == errSnapshotFailed {
		// restic may have saved its snapshot before the stop took effect: it is
		// in the repository whatever this run says, so it is reported with
		// the run (keptSnapshot); unreported, the server would flag it as a
		// snapshot no backup made.
		kept := ""
		if res != nil && res.SnapshotID != "" {
			kept = res.SnapshotID
		}
		switch {
		case rc.ctx.Err() != nil:
			rc.stoppedOutcome(&out)
			if kept != "" && out.Cancelled {
				out.Errors[len(out.Errors)-1].Message = fmt.Sprintf("The backup was cancelled in Restow after restic had saved snapshot %s; it stays in the repository. The next scheduled run starts as usual.", shortID(kept))
			}
			rl.Warnf("The backup was interrupted; it resumes when the agent starts again.")
			a.keptSnapshot(rl, &out, res, snap, "", plan, false)
		case timedOut():
			msg := fmt.Sprintf("The backup did not finish within %s and was stopped. Check the network connection and the size of the backup set.", maxRunTime)
			if kept != "" {
				msg = fmt.Sprintf("The backup did not finish within %s and was stopped after restic had saved snapshot %s; it stays in the repository. Check the network connection and the size of the backup set.", maxRunTime, shortID(kept))
			}
			out.Errors = append(out.Errors, api.RunError{Code: "timeout", Message: msg})
			rl.Errorf("%s", msg)
			a.keptSnapshot(rl, &out, res, snap, "", plan, false)
		case context.Cause(sctx) == errSnapshotFailed:
			// Stopped under the policy fail. Should restic have saved its
			// snapshot first, it is reported with the failed run and said
			// to hold the volumes read live.
			out.Status = api.StatusFailed
			failed, machineWide := snapshotFailedErrors(snap, plan, true)
			if kept != "" {
				for i := range failed {
					failed[i].Message += fmt.Sprintf(" restic had already saved snapshot %s before it stopped, with these files read from the live file system: it stays in the repository and is reported with this failed run, but it is no backup the policy accepts.", shortID(kept))
				}
			}
			out.Errors = append(out.Errors, failed...)
			out.Errors = append(out.Errors, snapshotCleanupErrors(snap)...)
			out.Consistency = consistencyOf(plan, snap, machineWide)
			rl.Errorf("The backup was stopped because a shadow copy failed (policy for a failed file system snapshot: stop the backup).")
			a.keptSnapshot(rl, &out, res, snap, "the policy for a failed file system snapshot does not accept it as a backup", plan, true)
		case errors.As(err, &re):
			msg := re.Error()
			if hint := re.Hint(); hint != "" {
				msg += ". " + hint
			}
			rl.Errorf("%s", msg)
			out.Errors = append(out.Errors, api.RunError{Message: msg, Code: fmt.Sprintf("restic_exit_%d", re.ExitCode)})
		default:
			rl.Errorf("%v", err)
			out.Errors = append(out.Errors, api.RunError{Message: err.Error(), Code: "restic_error"})
		}
		return out
	}
	for _, w := range res.Warnings {
		rl.Warnf("%s", w)
	}
	snapErrors, machineWide := snapshotFailedErrors(snap, plan, false)
	snapErrors = append(snapErrors, snapshotCleanupErrors(snap)...)
	out.Consistency = consistencyOf(plan, snap, snapUnavailable || machineWide)
	s := res.Summary
	out.SnapshotID = res.SnapshotID
	out.Stats = &api.Stats{
		FilesNew: s.FilesNew, FilesChanged: s.FilesChanged, FilesUnmodified: s.FilesUnmodified, DataAdded: s.DataAdded,
		DataAddedPacked: s.DataAddedPacked, TotalFilesProcessed: s.TotalFilesProcessed, TotalBytesProcessed: s.TotalBytesProcessed,
	}
	out.Errors = append(out.Errors, snapErrors...)
	for _, e := range res.Errors {
		out.Errors = append(out.Errors, api.RunError{Path: e.Path, Message: e.Message, Code: e.During})
	}
	out.Unlisted = res.ErrorCount - len(res.Errors)
	// Safety net: a snapshot without a single file although a source reached
	// through a link or mount point holds files is no backup of it (restic
	// did not follow it). A plain folder the exclusions empty is no error.
	var emptySources []api.RunError
	if s.TotalFilesProcessed == 0 {
		emptySources = linkedSourcesWithFiles(resolved, sources)
		for _, e := range emptySources {
			rl.Errorf("%s", e.Message)
		}
		out.Errors = append(out.Errors, emptySources...)
	}
	if runtime.GOOS == "darwin" {
		for _, e := range res.Errors {
			if strings.Contains(e.Message, "operation not permitted") {
				rl.Warnf("macOS blocked access to protected files. Grant Full Disk Access to %s (System Settings > Privacy & Security > Full Disk Access), then the next backup includes them.", paths.InstalledAgentBinary())
				break
			}
		}
	}
	rl.Infof("Snapshot %s saved: %d new, %d changed, %d unchanged files; %s processed, %s added to the repository.",
		shortID(res.SnapshotID), s.FilesNew, s.FilesChanged, s.FilesUnmodified,
		formatBytes(s.TotalBytesProcessed), formatBytes(s.DataAdded))
	switch {
	case res.Partial:
		out.Status = api.StatusPartial
		rl.Warnf("Some files could not be read (%d errors); the snapshot is incomplete. Details are listed in the errors of this run.", res.ErrorCount)
	case len(emptySources) > 0:
		out.Status = api.StatusPartial
	case snapUnavailable || len(snap.FailedVolumes) > 0:
		// Backed up, but not (all) from a snapshot: what the policy continue means.
		// Volumes VSS cannot do by design (excluded from the start, not
		// supported by the provider) are no failure, also when they are all
		// the backup has: the consistency names them, the status stays.
		out.Status = api.StatusPartial
		rl.Warnf("The backup was made without a shadow copy of every volume; files that changed during it may be inconsistent.")
	default:
		out.Status = api.StatusSucceeded
	}
	out.Summary = fmt.Sprintf("snapshot %s, %d new, %d changed files", shortID(res.SnapshotID), s.FilesNew, s.FilesChanged)

	if rc.ctx.Err() == nil {
		out.Sample = a.collectSample(rc, res.SnapshotID)
	}
	if rc.ctx.Err() == nil {
		out.Activity = a.collectActivity(rc, res.SnapshotID, sources)
	}
	return out
}

// keptSnapshot reports the snapshot restic saved before a backup was stopped
// (interrupted, timed out, stopped under the snapshot policy fail) with the
// failed run: its id, its figures and, when the stop was the snapshot
// policy's, its consistency is already set. Nothing is reported when restic
// saved none. why says why it does not count, "" when only the run did not
// end as planned.
func (a *Agent) keptSnapshot(rl runLogger, out *runOutcome, res *restic.BackupResult, snap restic.SnapshotOutcome, why string, plan snapshotPlan, consistencySet bool) {
	if res == nil || res.SnapshotID == "" {
		return
	}
	s := res.Summary
	out.SnapshotID = res.SnapshotID
	out.Stats = &api.Stats{
		FilesNew: s.FilesNew, FilesChanged: s.FilesChanged, FilesUnmodified: s.FilesUnmodified, DataAdded: s.DataAdded,
		DataAddedPacked: s.DataAddedPacked, TotalFilesProcessed: s.TotalFilesProcessed, TotalBytesProcessed: s.TotalBytesProcessed,
	}
	if !consistencySet && plan.requested {
		out.Consistency = consistencyOf(plan, snap, false)
	}
	if why != "" {
		rl.Warnf("restic had already saved snapshot %s before it was stopped; it stays in the repository and is reported with this failed run: %s.", shortID(res.SnapshotID), why)
		return
	}
	rl.Warnf("restic had already saved snapshot %s before it was stopped; it stays in the repository and is reported with this run.", shortID(res.SnapshotID))
}
