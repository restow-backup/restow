package core

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/restow-backup/restow/agent/internal/api"
	"github.com/restow-backup/restow/agent/internal/baremetal"
	"github.com/restow-backup/restow/agent/internal/fssnap"
	"github.com/restow-backup/restow/agent/internal/restic"
	"github.com/restow-backup/restow/agent/internal/sysinfo"
)

// baremetalTag marks the snapshots of whole-machine backups.
const baremetalTag = "restow-baremetal"

// fsBackend is the Linux machinery of whole-machine backups and file
// system snapshots (docs/BAREMETAL.md 5 and 6): the layout capture, the
// snapshot discovery, creation and removal, and the namespace helper.
// snapshot_linux.go has the real one; elsewhere there is none; tests
// replace newFSBackendFn.
type fsBackend interface {
	TriggerAutomounts(ctx context.Context) []string
	Capture(ctx context.Context, hostname, hooks string) (*baremetal.Manifest, baremetal.RawSet, error)
	// Mountinfo is /proc/self/mountinfo (the fallback sources).
	Mountinfo() []byte
	Discover(ctx context.Context, sources []string, whole bool) (fssnap.Facts, error)
	Probe(ctx context.Context) error
	Create(ctx context.Context, plan fssnap.Plan, runID string) ([]fssnap.Created, fssnap.Outcome)
	Remove(ctx context.Context, created []fssnap.Created, runID string) []fssnap.Failure
	Watch(ctx context.Context, created []fssnap.Created, cancel context.CancelCauseFunc) *fssnap.Pressure
	WriteSpec(spec fssnap.Spec) (string, func(), error)
	Measure(ctx context.Context, spec fssnap.Spec, req fssnap.MeasureRequest) (fssnap.MeasureResponse, error)
	// HelperCommand is how restic starts through the snapshot helper: the
	// helper's command line for the spec file, and whether the helper must
	// start in a mount namespace of its own. The real helper always must
	// (it mounts the snapshot tree, and nothing of that may reach the
	// machine); a new mount namespace needs CAP_SYS_ADMIN, which is why
	// Probe refuses the helper unless the agent runs as root.
	HelperCommand(specFile string) (argv []string, mountNS bool)
	CleanupStale(ctx context.Context, activeRun string) fssnap.StaleReport
}

// newFSBackendFn is newFSBackend (snapshot_linux.go, snapshot_other.go,
// snapshot_windows.go); tests replace it.
var newFSBackendFn = newFSBackend

// fsRun is the state of the snapshots of one backup.
type fsRun struct {
	b         fsBackend
	whole     bool
	plan      fssnap.Plan
	facts     fssnap.Facts
	created   []fssnap.Created
	outcome   fssnap.Outcome
	treeOpts  fssnap.TreeOptions
	runID     string
	helperOK  bool
	spec      *fssnap.Spec
	cleanup   func()
	layout    []byte
	degraded  bool
	pressure  *fssnap.Pressure
	removed   bool
	unavailMs string
}

// wholeMachineApplies reports whether this backup backs up the whole
// machine: the job says so, this system can (Linux, not a container).
func (a *Agent) wholeMachineApplies(cfg *api.Config) bool {
	if !cfg.WholeMachine || newFSBackendFn(a) == nil {
		return false
	}
	return a.d.Machine().Virtualization != sysinfo.VirtContainer
}

// fsPrepare runs before restic (5.6): the layout capture and manifest of a
// whole-machine backup, the snapshot plan, the snapshots themselves and the
// helper spec. It changes the sources and the restic options. stop means
// the backup ends here (the policy fail), with out set.
func (a *Agent) fsPrepare(rc *runContext, out *runOutcome, sources *[]string, opts *restic.BackupOptions, failPolicy bool) (*fsRun, bool) {
	rl, cfg := rc.rl, rc.cfg
	b := newFSBackendFn(a)
	whole := cfg.WholeMachine
	if b == nil {
		if whole {
			rl.Infof("Whole machine (bare metal) is available for Linux in this version; this machine backs up its configured folders.")
		}
		return nil, false
	}
	if whole && a.d.Machine().Virtualization == sysinfo.VirtContainer {
		rl.Infof("This machine is a container: a whole-machine backup is not possible here; it backs up its configured folders.")
		whole = false
	}
	// Snapshots an earlier run left behind (crash, power loss) go before
	// every backup, whether or not this one takes snapshots (6.5).
	if rep := b.CleanupStale(rc.ctx, rc.runID.String()); rep.String() != "" {
		rl.Infof("%s", rep.String())
	}
	mode := cfg.FSSnapshot
	if mode != api.FSSnapshotAuto {
		mode = api.FSSnapshotOff
	}
	if !whole && mode != api.FSSnapshotAuto {
		return nil, false
	}
	fr := &fsRun{b: b, whole: whole, runID: rc.runID.String(),
		treeOpts: fssnap.TreeOptions{ResticBin: rc.runner.Bin, CacheDir: rc.runner.CacheDir, TmpDir: rc.runner.TmpDir, RunID: rc.runID.String()}}

	var m *baremetal.Manifest
	var raw baremetal.RawSet
	if whole {
		if failed := b.TriggerAutomounts(rc.ctx); len(failed) > 0 {
			rl.Warnf("These automount points did not answer and may be missing from the backup: %s.", strings.Join(failed, ", "))
		}
		cctx, cancel := context.WithTimeout(rc.ctx, baremetal.DefaultCaptureTimeout)
		var err error
		m, raw, err = b.Capture(cctx, a.d.State.Hostname, a.hooksMode())
		cancel()
		if err != nil {
			*sources = mountinfoSources(b.Mountinfo())
			e := api.RunError{Code: "layout_capture_failed", Message: "The disk layout of this machine could not be captured (" + err.Error() +
				"). The mounted file systems were backed up without it; this snapshot cannot restore the whole machine."}
			rl.Warnf("%s", e.Message)
			out.Errors = append(out.Errors, e)
			fr.degraded = true
			m = nil
		} else {
			srcs, notes := wholeMachineSources(m)
			for _, n := range notes {
				rl.Infof("%s", n)
			}
			*sources = srcs
			opts.Excludes = append(opts.Excludes, wholeMachineExcludes(m)...)
			rl.Infof("Disk layout captured (%s).", strings.ReplaceAll(m.Linux.Verdict, "_", " "))
		}
		opts.OneFileSystem, opts.GroupBy = true, "host"
		opts.Tags = append(opts.Tags, baremetalTag)
		rl.Infof("Backing up the whole machine: %s", strings.Join(*sources, ", "))
	}

	facts, err := b.Discover(rc.ctx, *sources, whole)
	if err != nil {
		facts = fssnap.Facts{Unavailable: "the file systems could not be examined: " + err.Error()}
		for _, s := range *sources {
			facts.Sources = append(facts.Sources, fssnap.Source{Path: s})
		}
	}
	fr.facts = facts
	plan := fssnap.MakePlan(facts, mode)
	if plan.Requested && plan.Unavailable == "" && facts.Unavailable != "" && err != nil {
		plan.Unavailable = facts.Unavailable
	}
	if whole || plan.Wanted() {
		if perr := b.Probe(rc.ctx); perr == nil {
			fr.helperOK = true
		} else {
			rl.Warnf("The snapshot helper cannot run (%v); the backup reads the live file systems without a private mount namespace.", perr)
			if whole {
				kept := (*sources)[:0:0]
				for _, s := range facts.Sources {
					if s.Noauto {
						rl.Warnf("%s is not mounted (noauto in /etc/fstab) and is not backed up: the helper that mounts it read-only cannot run.", s.Path)
						continue
					}
					kept = append(kept, s.Path)
				}
				*sources = kept
			}
			if plan.Wanted() {
				plan.Unavailable = perr.Error()
			}
			for i := range plan.Sources {
				if plan.Sources[i].Method != fssnap.MethodLive || plan.Sources[i].LiveReason == "" {
					plan.Sources[i].Method, plan.Sources[i].LiveReason = fssnap.MethodLive, fssnap.ReasonNoHelper
				}
			}
		}
	}
	fr.plan = plan
	for _, n := range plan.Notes {
		rl.Infof("%s", n)
	}

	if whole && m != nil {
		fsm, lr := plan.FSSnapshots()
		ex := append([]string(nil), opts.Excludes...)
		if len(ex) > 1000 {
			ex = ex[:1000]
		}
		m.Linux.Backup = baremetal.Backup{Sources: append([]string(nil), (*sources)...), Excludes: ex, FSSnapshots: fsm, LiveReasons: lr}
		m.Linux.Verdict, m.Linux.Unsupported = baremetal.Assess(m)
		enc, eerr := m.Encode()
		switch {
		case errors.Is(eerr, baremetal.ErrTooLarge):
			e := api.RunError{Code: "layout_too_large", Message: fmt.Sprintf("The disk layout manifest is %d bytes, more than the 512 KiB the Restow instance accepts; it is in the snapshot but was not sent.", len(enc))}
			rl.Warnf("%s", e.Message)
			out.Errors = append(out.Errors, e)
			fr.degraded = true
		case eerr != nil:
			e := api.RunError{Code: "layout_capture_failed", Message: "The disk layout manifest is not valid (" + eerr.Error() + "); this snapshot cannot restore the whole machine."}
			rl.Warnf("%s", e.Message)
			out.Errors = append(out.Errors, e)
			fr.degraded = true
			enc = nil
		default:
			fr.layout = enc
		}
		if enc != nil {
			if werr := baremetal.WriteBaremetalDir(a.d.Layout.BaremetalDir(), enc, raw); werr != nil {
				e := api.RunError{Code: "layout_capture_failed", Message: "The disk layout could not be written to " + a.d.Layout.BaremetalDir() + " (" + werr.Error() + "); this snapshot cannot restore the whole machine."}
				rl.Warnf("%s", e.Message)
				out.Errors = append(out.Errors, e)
				fr.degraded = true
				fr.layout = nil
			}
		}
	}

	stopUnavailable := func(reason string) bool {
		if failPolicy {
			e := fsSnapshotUnavailableError(plan.Method, reason, false)
			rl.Errorf("%s See %s.", e.Message, snapshotLogHintFor(plan.Method))
			out.Errors = append(out.Errors, e)
			out.Consistency = consistencyOfFS(fr.plan, fssnap.Outcome{Unavailable: reason})
			fr.removeAll(rc)
			return true
		}
		e := fsSnapshotUnavailableError(plan.Method, reason, true)
		rl.Warnf("%s See %s.", e.Message, snapshotLogHintFor(plan.Method))
		out.Errors = append(out.Errors, e)
		fr.unavailMs = reason
		fr.degraded = true
		return false
	}
	if plan.Requested && plan.Unavailable != "" {
		if stopUnavailable(plan.Unavailable) {
			return fr, true
		}
		for _, s := range plan.Sources {
			fr.outcome.Live = append(fr.outcome.Live, s.Path)
		}
		fr.outcome.Unavailable = plan.Unavailable
	} else if plan.Wanted() {
		fr.created, fr.outcome = b.Create(rc.ctx, plan, fr.runID)
		for _, n := range fr.outcome.Notes {
			rl.Infof("%s", n)
		}
		for _, p := range fr.outcome.Snapshotted {
			rl.Infof("%s is read from a %s.", p, snapshotNoun(methodOfSource(plan, p)))
		}
		for _, f := range fr.outcome.Failed {
			rl.Warnf("The %s of %s failed (%s); see %s.", snapshotNoun(methodOfSource(plan, f.Path)), f.Path, f.Message, snapshotLogHintFor(methodOfSource(plan, f.Path)))
		}
		if fr.outcome.Unavailable != "" {
			if stopUnavailable(fr.outcome.Unavailable) {
				return fr, true
			}
		}
		if len(fr.outcome.Failed) > 0 {
			if failPolicy {
				out.Errors = append(out.Errors, fsSnapshotFailedErrors(plan, fr.outcome.Failed, true)...)
				out.Consistency = consistencyOfFS(plan, fr.outcome)
				rl.Errorf("The backup was stopped because a file system snapshot failed (policy for a failed file system snapshot: stop the backup).")
				fr.removeAll(rc)
				return fr, true
			}
			fr.degraded = true
		}
	} else {
		for _, s := range plan.Sources {
			fr.outcome.Live = append(fr.outcome.Live, s.Path)
		}
	}
	for _, s := range plan.Sources {
		if s.Method == fssnap.MethodLive && s.LiveReason != "" && s.LiveReason != fssnap.ReasonOff {
			rl.Infof("%s is read from the live file system (%s).", s.Path, strings.ReplaceAll(s.LiveReason, "_", " "))
		}
	}
	if fr.helperOK && (whole || len(fr.created) > 0) {
		if err := fr.useSpec(fssnap.TreeSpec(plan, facts, fr.created, fr.treeOpts), opts, rc); err != nil {
			rl.Warnf("The snapshot tree could not be prepared (%v); the backup reads the live file systems.", err)
			fr.removeAll(rc)
			fr.outcome.Failed = append(fr.outcome.Failed, failuresOf(fr.outcome.Snapshotted, err.Error())...)
			fr.outcome.Snapshotted = nil
		}
	}
	return fr, false
}

func failuresOf(paths []string, msg string) []fssnap.Failure {
	var out []fssnap.Failure
	for _, p := range paths {
		out = append(out, fssnap.Failure{Path: p, Message: msg})
	}
	return out
}

// useSpec writes the helper spec and runs restic through the helper.
func (fr *fsRun) useSpec(spec fssnap.Spec, opts *restic.BackupOptions, rc *runContext) error {
	if fr.cleanup != nil {
		fr.cleanup()
		fr.cleanup = nil
	}
	file, cleanup, err := fr.b.WriteSpec(spec)
	if err != nil {
		opts.Exec, opts.ExecNewMountNS = nil, false
		rc.measure = nil
		return err
	}
	fr.spec, fr.cleanup = &spec, cleanup
	opts.Exec, opts.ExecNewMountNS = fr.b.HelperCommand(file)
	rc.measure = func(ctx context.Context, req fssnap.MeasureRequest) (fssnap.MeasureResponse, error) {
		return fr.b.Measure(ctx, spec, req)
	}
	return nil
}

// watch runs the monitor while restic runs (6.2).
func (fr *fsRun) watch(ctx context.Context, cancel context.CancelCauseFunc) func() {
	lvm := false
	for _, c := range fr.created {
		lvm = lvm || c.Method == fssnap.MethodLVM
	}
	if !lvm {
		return func() {}
	}
	wctx, stop := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() {
		defer close(done)
		if p := fr.b.Watch(wctx, fr.created, cancel); p != nil {
			fr.pressure = p
		}
	}()
	return func() { stop(); <-done }
}

// giveUp removes the snapshots after the monitor stopped restic and
// prepares a live rerun (policy continue).
func (fr *fsRun) giveUp(rc *runContext, opts *restic.BackupOptions) {
	p := fr.pressure
	fr.removeAll(rc)
	var fails []fssnap.Failure
	for _, s := range fr.outcome.Snapshotted {
		msg := "read live after the snapshot of " + p.Path + " was given up"
		if s == p.Path {
			msg = p.Msg
		}
		fails = append(fails, fssnap.Failure{Path: s, Message: msg})
	}
	fr.outcome.Failed = append(fr.outcome.Failed, fails...)
	fr.outcome.Snapshotted = nil
	fr.degraded = true
	if fr.whole && fr.helperOK {
		if err := fr.useSpec(fssnap.LiveSpec(fr.facts, fr.treeOpts), opts, rc); err == nil {
			return
		}
	}
	if fr.cleanup != nil {
		fr.cleanup()
		fr.cleanup = nil
	}
	opts.Exec, opts.ExecNewMountNS = nil, false
	rc.measure = nil
}

// removeAll deletes the snapshots now (once).
func (fr *fsRun) removeAll(rc *runContext) {
	if fr.removed || len(fr.created) == 0 {
		fr.created = nil
		return
	}
	fr.removed = true
	fails := fr.b.Remove(rc.ctx, fr.created, fr.runID)
	fr.created = nil
	fr.outcome.CleanupFailed = append(fr.outcome.CleanupFailed, fails...)
}

// finish removes the snapshots and the spec after the backup and adds the
// run errors of the snapshots.
func (fr *fsRun) finish(rc *runContext, out *runOutcome) {
	fr.removeAll(rc)
	if fr.cleanup != nil {
		fr.cleanup()
		fr.cleanup = nil
	}
	for _, f := range fr.outcome.CleanupFailed {
		rc.rl.Warnf("The snapshot %s could not be removed (%s); the agent removes it at the next start.", f.Path, f.Message)
	}
	out.Errors = append(out.Errors, fsSnapshotCleanupErrors(fr.outcome.CleanupFailed)...)
}

// report sets consistency and the snapshot errors of a backup that got as
// far as restic (the layout goes with the snapshot id, in backupStep).
func (fr *fsRun) report(out *runOutcome) {
	out.Consistency = consistencyOfFS(fr.plan, fr.outcome)
	out.Errors = append(out.Errors, fsSnapshotFailedErrors(fr.plan, fr.outcome.Failed, false)...)
}

// cleanupStaleSnapshots removes snapshots an earlier run left behind
// (agent start; docs/BAREMETAL.md 6.5).
func (a *Agent) cleanupStaleSnapshots(ctx context.Context) {
	b := newFSBackendFn(a)
	if b == nil {
		return
	}
	if rep := b.CleanupStale(ctx, ""); rep.String() != "" {
		a.log.Info(rep.String())
	}
}

// hooksMode is the machine's hook mode for the manifest.
func (a *Agent) hooksMode() string {
	mode, _ := a.hooksPolicy()
	switch mode {
	case "scripts", "any":
		return mode
	}
	return "off"
}
