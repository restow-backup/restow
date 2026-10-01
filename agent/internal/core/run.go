package core

import (
	"context"
	"errors"
	"fmt"
	"os"
	"time"

	"github.com/restow-backup/restow/agent/internal/api"
	"github.com/restow-backup/restow/agent/internal/buildinfo"
	"github.com/restow-backup/restow/agent/internal/restic"
	"github.com/restow-backup/restow/agent/internal/runlog"
	"github.com/restow-backup/restow/agent/internal/status"
	"github.com/restow-backup/restow/agent/internal/update"
)

func pidOf() int { return os.Getpid() }

// runContext carries everything one run needs.
type runContext struct {
	ctx     context.Context
	a       *Agent
	kind    string
	trigger string
	runID   api.Flex
	taskID  api.Flex
	started time.Time
	rl      *runlog.Log
	runner  *restic.Runner
	cfg     *api.Config
}

// runOutcome is what a run reports when it ends.
type runOutcome struct {
	Status     string
	SnapshotID string
	Stats      *api.Stats
	Sample     []api.SampleFile
	Errors     []api.RunError
	// Unlisted counts errors restic reported beyond those in Errors (restic
	// package: at most 100 per run are kept); the report says how many.
	Unlisted int
	// Interrupted marks a run cut short by a shutdown or a lost connection.
	// A backup that was interrupted is resumed instead of counted as failed.
	Interrupted bool
	// Summary is a one-line description for the local status.
	Summary string
	// RestoreTest is what a restore test (verify_sample) observed.
	RestoreTest *api.RestoreTest
}

func (o *runOutcome) fail(code, format string, args ...any) {
	o.Status = api.StatusFailed
	o.Errors = append(o.Errors, api.RunError{Message: fmt.Sprintf(format, args...), Code: code})
}

// beginRun registers the run with the server and prepares logging. A nil
// context with an error means the server could not be told (no run exists).
func (a *Agent) beginRun(ctx context.Context, kind string, j job, cfg *api.Config) (*runContext, error) {
	sctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	started := a.now().UTC()
	runID, err := a.d.Server.StartRun(sctx, api.StartRunRequest{Kind: kind, TaskID: j.taskID(), StartedAt: started})
	if err != nil {
		return nil, err
	}
	a.setReachable(true)
	rl := runlog.New(a.log.With("run", runID.String(), "kind", kind))
	runner := *a.d.Restic
	runner.Log = func(line string) { rl.Raw("restic", line) }
	for _, d := range []string{runner.CacheDir, runner.TmpDir} {
		if d != "" {
			_ = os.MkdirAll(d, 0o700)
		}
	}
	rc := &runContext{ctx: ctx, a: a, kind: kind, trigger: j.trigger, runID: runID, taskID: j.taskID(),
		started: started, rl: rl, runner: &runner, cfg: cfg}
	_ = a.d.Status.Update(func(s *status.Status) {
		s.Current = &status.RunInfo{Kind: kind, RunID: runID.String(), TaskID: j.taskID().String(), StartedAt: started}
		s.Service = "running"
		if kind == api.RunBackup {
			s.LastAttemptAt = started
			s.Interrupted = false
		}
	})
	rl.Infof("Run started (%s, trigger: %s). Agent %s, restic %s.", kind, j.trigger, buildinfo.Version, orUnknown(a.resticVer))
	return rc, nil
}

func orUnknown(s string) string {
	if s == "" {
		return "version unknown"
	}
	return s
}

// endRun reports the outcome and records it locally.
func (a *Agent) endRun(rc *runContext, out runOutcome) {
	finished := a.now().UTC()
	if out.Status == "" {
		out.Status = api.StatusFailed
	}
	// A failed backup while the server cannot be reached is an interruption
	// that resumes when the connection is back, not a failure to alert on.
	if out.Status == api.StatusFailed && !out.Interrupted && rc.kind == api.RunBackup && rc.ctx.Err() == nil {
		if !a.probeServer(rc.ctx) {
			out.Interrupted = true
			rc.rl.Warnf("The Restow instance is not reachable. The backup will resume when the connection is back.")
		}
	}
	rc.rl.Infof("Run finished: %s.", out.Status)

	fin := api.FinishRequest{
		Status: out.Status, FinishedAt: finished, SnapshotID: out.SnapshotID, Stats: out.Stats,
		Sample: out.Sample, Errors: capErrors(out.Errors, out.Unlisted), LogTail: rc.rl.Tail(), RestoreTest: out.RestoreTest,
	}
	timeout := 4 * time.Minute
	base := rc.ctx
	if rc.ctx.Err() != nil {
		// Shutting down: still tell the server, but do not hold up the stop.
		base = context.WithoutCancel(rc.ctx)
		timeout = 15 * time.Second
	}
	fctx, cancel := context.WithTimeout(base, timeout)
	err := a.d.Server.FinishRun(fctx, rc.runID, fin)
	cancel()
	if err != nil {
		a.noteServerError("reporting the end of a run", err)
		if perr := a.out.put(rc.runID, fin); perr != nil {
			a.log.Error("could not store the run report for later delivery", "error", perr)
		} else {
			a.log.Warn("the run report is stored and will be delivered when the server is reachable", "run", rc.runID.String())
		}
	}

	msg := out.Summary
	if msg == "" && len(out.Errors) > 0 {
		msg = out.Errors[0].Message
	}
	_ = a.d.Status.Update(func(s *status.Status) {
		s.Current = nil
		s.Service = "idle"
		sum := &status.RunSummary{Kind: rc.kind, Status: out.Status, StartedAt: rc.started, FinishedAt: finished,
			SnapshotID: out.SnapshotID, Message: msg}
		s.LastRun = sum
		if rc.kind != api.RunBackup {
			return
		}
		s.LastBackup = sum
		switch {
		case out.Interrupted:
			s.Interrupted = true
		case out.Status == api.StatusFailed:
			s.ConsecutiveFailures++
		default:
			s.ConsecutiveFailures = 0
			s.LastSuccessAt = finished
		}
	})
}

// probeServer checks whether the Restow instance answers at all.
func (a *Agent) probeServer(ctx context.Context) bool {
	pctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	_, err := a.d.Server.Config(pctx)
	if err == nil || api.IsServerReachable(err) {
		a.setReachable(true)
		return true
	}
	a.setReachable(false)
	return false
}

// startFailed handles a run that could not even be registered.
func (a *Agent) startFailed(j job, kind string, err error) {
	a.noteServerError("starting a "+kind+" run", err)
	if j.trigger == triggerTask && j.attempts < 5 && !api.IsAuthError(err) {
		j.attempts++
		delay := time.Duration(j.attempts) * 30 * time.Second
		a.log.Info("the task will be retried", "kind", kind, "in", delay.String(), "attempt", j.attempts)
		time.AfterFunc(delay, func() { a.enqueue(j); a.signalWake() })
	}
}

// maxRunTime bounds a single backup or restore so that a wedged restic (for
// example blocked on a dead network mount) cannot stop all further backups.
var maxRunTime = 72 * time.Hour

// resticContext derives the context for one restic call with the maximum run
// time. timedOut reports, after the call, whether the limit (and not a
// shutdown) ended it.
func (rc *runContext) resticContext() (ctx context.Context, cancel context.CancelFunc, timedOut func() bool) {
	ctx, cancel = context.WithTimeout(rc.ctx, maxRunTime)
	return ctx, cancel, func() bool { return rc.ctx.Err() == nil && errors.Is(ctx.Err(), context.DeadlineExceeded) }
}

// interruptedOutcome fills the outcome for a run stopped by a shutdown.
func interruptedOutcome(out *runOutcome) {
	out.Interrupted = true
	out.fail("interrupted", "The run was interrupted because the agent is stopping. A backup resumes automatically when the agent starts again.")
}

func (a *Agent) tryUpdate(ctx context.Context) error {
	uctx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()
	info, err := a.d.Server.CheckUpdate(uctx)
	if err != nil {
		if api.IsNotFound(err) {
			return nil // instance without update support
		}
		return err
	}
	if info == nil {
		return nil
	}
	res, err := update.Apply(uctx, update.Options{CurrentVersion: buildinfo.Version, Info: *info, Client: a.d.Server,
		BinDir: a.d.BinDir, Key: a.d.UpdateKey})
	switch {
	case errors.Is(err, update.ErrNotNewer):
		return nil
	case errors.Is(err, update.ErrDevBuild):
		a.o.SelfUpdate = false
		a.log.Info("development build: self-update is disabled")
		return nil
	case errors.Is(err, update.ErrNoKey):
		a.o.SelfUpdate = false
		a.log.Error("self-update is disabled: " + err.Error())
		return nil
	case err != nil:
		return err
	}
	a.log.Info("agent updated from a signed release; restarting to run the new version", "from", buildinfo.Version, "to", res.Version,
		"restic_changed", res.ResticChanged)
	a.mu.Lock()
	a.restart = true
	a.mu.Unlock()
	return nil
}

// recoverInterrupted deals with a run that was in progress when the agent
// stopped without a chance to report (crash, power loss, kill -9).
func (a *Agent) recoverInterrupted(ctx context.Context) {
	st := a.d.Status.Snapshot()
	if st.Current == nil {
		return
	}
	cur := *st.Current
	a.log.Warn("the previous run did not finish; the agent or the machine stopped while it was in progress",
		"kind", cur.Kind, "run", cur.RunID, "started", cur.StartedAt.Format(time.RFC3339))
	if cur.RunID != "" {
		fin := api.FinishRequest{
			Status: api.StatusFailed, FinishedAt: a.now().UTC(),
			Errors: []api.RunError{{Code: "interrupted", Message: "The agent or the machine stopped while this run was in progress. " +
				"A backup resumes automatically; restores and restore tests can be started again from the Restow UI."}},
			LogTail: "The run log of this run was lost when the agent stopped.",
		}
		fctx, cancel := context.WithTimeout(ctx, 30*time.Second)
		err := a.d.Server.FinishRun(fctx, api.Flex(cur.RunID), fin)
		cancel()
		if err != nil {
			_ = a.out.put(api.Flex(cur.RunID), fin)
		}
	}
	_ = a.d.Status.Update(func(s *status.Status) {
		s.Current = nil
		if cur.Kind == api.RunBackup {
			s.Interrupted = true
		}
	})
}
