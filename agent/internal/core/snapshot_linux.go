//go:build linux

package core

import (
	"context"
	"os"
	"time"

	"github.com/restow-backup/restow/agent/internal/api"
	"github.com/restow-backup/restow/agent/internal/baremetal"
	"github.com/restow-backup/restow/agent/internal/buildinfo"
	"github.com/restow-backup/restow/agent/internal/cmdrun"
	"github.com/restow-backup/restow/agent/internal/fssnap"
	"github.com/restow-backup/restow/agent/internal/paths"
	"github.com/restow-backup/restow/agent/internal/restic"
)

// planSnapshot: Linux has no shadow copy; LVM and btrfs snapshots are
// planned in fsPrepare (fsSnapshot, docs/BAREMETAL.md 6).
func planSnapshot(cfg *api.Config, _ []string) snapshotPlan {
	var p snapshotPlan
	if cfg.UseVSS {
		p.notes = append(p.notes, "Volume Shadow Copy (useVss) is a Windows feature and has no effect on this system.")
	}
	return p
}

// platformBackupOptions adds what the system needs to every backup:
// nothing on Linux.
func platformBackupOptions(*restic.BackupOptions, paths.Layout) {}

// linuxFS is the real fsBackend: the system tools, the root file system
// and the namespace helper (this binary, `snapshot-exec`).
type linuxFS struct {
	a      *Agent
	r      cmdrun.Runner
	host   baremetal.Host
	helper fssnap.ExecHelper
}

func newFSBackend(a *Agent) fsBackend {
	exe, err := os.Executable()
	if err != nil {
		exe = paths.InstalledAgentBinary()
	}
	tmp := a.d.Layout.TmpDir()
	return &linuxFS{a: a, r: cmdrun.ExecRunner{}, host: baremetal.LocalHost(), helper: fssnap.ExecHelper{AgentBin: exe, TmpDir: tmp}}
}

func (l *linuxFS) TriggerAutomounts(ctx context.Context) []string {
	return baremetal.TriggerAutomounts(ctx, l.host, baremetal.LocalStat)
}

func (l *linuxFS) Capture(ctx context.Context, hostname, hooks string) (*baremetal.Manifest, baremetal.RawSet, error) {
	vgDir, err := os.MkdirTemp(l.a.d.Layout.TmpDir(), "vgcfg-")
	if err == nil {
		_ = os.Chmod(vgDir, 0o700)
		defer os.RemoveAll(vgDir)
	} else {
		vgDir = ""
	}
	return baremetal.CaptureLocal(ctx, baremetal.Options{Runner: l.r, Host: l.host, Hostname: hostname, AgentVersion: buildinfo.Version,
		Hooks: hooks, Now: time.Now, VGBackupDir: vgDir})
}

func (l *linuxFS) Mountinfo() []byte {
	b, _ := l.host.ReadFile("/proc/self/mountinfo", 0)
	return b
}

func (l *linuxFS) Discover(ctx context.Context, sources []string, whole bool) (fssnap.Facts, error) {
	return fssnap.Discover(ctx, l.r, l.host, sources, whole)
}

func (l *linuxFS) Probe(ctx context.Context) error { return l.helper.Probe(ctx) }

func (l *linuxFS) Create(ctx context.Context, plan fssnap.Plan, runID string) ([]fssnap.Created, fssnap.Outcome) {
	return fssnap.Create(ctx, l.r, l.helper, plan, runID)
}

func (l *linuxFS) Remove(ctx context.Context, created []fssnap.Created, runID string) []fssnap.Failure {
	return fssnap.Remove(ctx, l.r, l.helper, created, runID)
}

func (l *linuxFS) Watch(ctx context.Context, created []fssnap.Created, cancel context.CancelCauseFunc) *fssnap.Pressure {
	return fssnap.Watch(ctx, l.r, created, fssnap.MonitorInterval, cancel)
}

func (l *linuxFS) WriteSpec(spec fssnap.Spec) (string, func(), error) {
	return l.helper.WriteSpec(spec)
}

func (l *linuxFS) Measure(ctx context.Context, spec fssnap.Spec, req fssnap.MeasureRequest) (fssnap.MeasureResponse, error) {
	return l.helper.Measure(ctx, spec, req)
}

// HelperCommand: restic runs through `restow-agent snapshot-exec`, always
// in a mount namespace of its own.
func (l *linuxFS) HelperCommand(specFile string) ([]string, bool) {
	return fssnap.HelperArgv(l.helper.AgentBin, specFile, []string{}), true
}

// CleanupStale runs only as root: it needs the tools and the namespace.
func (l *linuxFS) CleanupStale(ctx context.Context, activeRun string) fssnap.StaleReport {
	if os.Geteuid() != 0 {
		return fssnap.StaleReport{}
	}
	var h fssnap.Helper = l.helper
	if l.helper.Probe(ctx) != nil {
		h = nil
	}
	return fssnap.CleanupStale(ctx, l.r, h, l.host, activeRun)
}
