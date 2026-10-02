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
		a.applyConfig(fresh, "before backup")
		cfg = fresh
	} else if cfg == nil {
		if ctx.Err() == nil {
			a.noteServerError("fetching the configuration", err)
		}
		return runOutcome{}, err
	}
	rc, err := a.beginRun(ctx, api.RunBackup, j, cfg)
	if err != nil {
		a.startFailed(j, "backup", err)
		return runOutcome{}, err
	}
	out := a.doBackup(rc)
	a.endRun(rc, out)
	return out, nil
}

func (a *Agent) doBackup(rc *runContext) runOutcome {
	out := runOutcome{Status: api.StatusFailed}
	rl, cfg := rc.rl, rc.cfg

	sources, missing, resolved := splitSources(cfg.Paths)
	for _, m := range missing {
		rl.Warnf("Path %s does not exist on this machine and is skipped.", m)
	}
	for _, r := range resolved {
		rl.Infof("Path %s is a symbolic link; backing up its target %s.", r.Configured, r.Resolved)
	}
	if len(sources) == 0 {
		if len(cfg.Paths) == 0 {
			out.fail("no_paths", "No backup paths are configured for this endpoint. Set them in the Restow UI (Endpoints, Settings).")
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
			interruptedOutcome(&out)
		default:
			proceed = false
			rl.Errorf("%v", err)
			out.Errors = append(out.Errors, api.RunError{Code: "pre_hook_failed",
				Message: "The pre-backup hook failed (" + err.Error() + "). The backup was not started because the data may be inconsistent."})
		}
	}

	if proceed {
		out = a.backupStep(rc, out, sources)
		// A hook that was not allowed makes a good backup partial: it is not what was configured.
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

func (a *Agent) backupStep(rc *runContext, out runOutcome, sources []string) runOutcome {
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
	if cfg.UseVSS {
		rl.Infof("Volume Shadow Copy (useVss) is a Windows feature and has no effect on this system.")
	}

	excludes := append([]string(nil), cfg.Excludes...)
	// Never back up the agent's own working files or earlier restores.
	excludes = append(excludes, a.d.Layout.CacheDir(), a.d.Layout.TmpDir(), "Restow-Restore-*")

	reporter := newProgressReporter(a.d.Server, rc.runID, a.o.ProgressInterval, func(err error) {
		a.log.Debug("progress report not delivered", "error", err)
	})
	reporter.Start(rc.ctx)
	rctx, rcancel, timedOut := rc.resticContext()
	defer rcancel()
	res, err := rc.runner.Backup(rctx, restic.BackupOptions{
		Paths: sources, Excludes: excludes, Host: a.d.State.Hostname, Tags: []string{snapshotTag},
		LimitUploadKiB: limit, ExcludeLargerThanBytes: sizeLimit,
		OnProgress: func(p restic.Progress) {
			reporter.Update(p)
			a.log.Debug("backup progress", "files", p.FilesDone, "bytes", formatBytes(p.BytesDone), "percent", int(p.Percent*100))
		},
	})
	reporter.Stop()

	if err != nil {
		var re *restic.Error
		switch {
		case rc.ctx.Err() != nil:
			interruptedOutcome(&out)
			rl.Warnf("The backup was interrupted; it resumes when the agent starts again.")
		case timedOut():
			out.Errors = append(out.Errors, api.RunError{Code: "timeout",
				Message: fmt.Sprintf("The backup did not finish within %s and was stopped. Check the network connection and the size of the backup set.", maxRunTime)})
			rl.Errorf("%s", out.Errors[len(out.Errors)-1].Message)
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
	s := res.Summary
	out.SnapshotID = res.SnapshotID
	out.Stats = &api.Stats{
		FilesNew: s.FilesNew, FilesChanged: s.FilesChanged, FilesUnmodified: s.FilesUnmodified, DataAdded: s.DataAdded,
		TotalFilesProcessed: s.TotalFilesProcessed, TotalBytesProcessed: s.TotalBytesProcessed,
	}
	for _, e := range res.Errors {
		out.Errors = append(out.Errors, api.RunError{Path: e.Path, Message: e.Message, Code: e.During})
	}
	out.Unlisted = res.ErrorCount - len(res.Errors)
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
	if res.Partial {
		out.Status = api.StatusPartial
		rl.Warnf("Some files could not be read (%d errors); the snapshot is incomplete. Details are listed in the errors of this run.", res.ErrorCount)
	} else {
		out.Status = api.StatusSucceeded
	}
	out.Summary = fmt.Sprintf("snapshot %s, %d new, %d changed files", shortID(res.SnapshotID), s.FilesNew, s.FilesChanged)

	if rc.ctx.Err() == nil {
		out.Sample = a.collectSample(rc, res.SnapshotID)
	}
	return out
}
