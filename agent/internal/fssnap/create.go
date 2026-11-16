package fssnap

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"

	"github.com/restow-backup/restow/agent/internal/cmdrun"
	"github.com/restow-backup/restow/agent/internal/sysparse"
)

// unavailableMarkers in a tool's error mean no snapshot can be taken at all
// (no rights, no kernel support), not that this one failed.
var unavailableMarkers = []string{"permission denied", "must be root", "operation not permitted", "snapshot target", "dm_snapshot",
	"thin target", "dm-snapshot", "unknown target type", "not supported by kernel"}

func unavailableErr(err error) bool {
	if cmdrun.IsNotFound(err) || errors.Is(err, ErrNoHelper) {
		return true
	}
	msg := strings.ToLower(err.Error())
	for _, m := range unavailableMarkers {
		if strings.Contains(msg, m) {
			return true
		}
	}
	return false
}

// Create takes the planned snapshots (6.2): thick and thin LVM snapshots
// with lvcreate, btrfs read-only snapshots per subvolume through the
// helper. A snapshot that fails with space available is a Failure (its
// sources are read live); a missing tool, missing rights or missing kernel
// support makes the whole plan unavailable, and the snapshots taken so far
// are removed again.
func Create(ctx context.Context, r cmdrun.Runner, h Helper, plan Plan, runID string) ([]Created, Outcome) {
	var out Outcome
	var created []Created
	if plan.Unavailable != "" {
		out.Unavailable = plan.Unavailable
	}
	// One snapshot per LV and per btrfs subvolume; sources share them.
	type job struct {
		key     string
		src     PlannedSource
		sources []string
	}
	var jobs []*job
	byKey := map[string]*job{}
	for _, ps := range plan.Sources {
		if ps.Method == MethodLive {
			out.Live = append(out.Live, ps.Path)
			continue
		}
		if ps.PreFail != "" {
			out.Failed = append(out.Failed, Failure{Path: ps.Path, Message: ps.PreFail})
			continue
		}
		if out.Unavailable != "" {
			continue
		}
		key := ps.VG + "/" + ps.LV
		if ps.Method == MethodBtrfs {
			key = ps.BtrfsUUID + "/" + fmt.Sprint(ps.SubvolID)
		}
		j, ok := byKey[key]
		if !ok {
			j = &job{key: key, src: ps}
			byKey[key] = j
			jobs = append(jobs, j)
		}
		j.sources = append(j.sources, ps.Path)
	}
	for _, j := range jobs {
		if out.Unavailable != "" || ctx.Err() != nil {
			break
		}
		s := j.src
		var c Created
		var err error
		switch s.Method {
		case MethodLVM:
			var leftover []Failure
			c, leftover, err = createLV(ctx, r, s)
			out.CleanupFailed = append(out.CleanupFailed, leftover...)
		case MethodBtrfs:
			c, err = createBtrfs(ctx, h, s, runID)
		}
		if err != nil {
			if unavailableErr(err) {
				out.Unavailable = err.Error()
				break
			}
			for _, p := range j.sources {
				out.Failed = append(out.Failed, Failure{Path: p, Message: err.Error()})
			}
			continue
		}
		c.Sources = j.sources
		created = append(created, c)
		out.Snapshotted = append(out.Snapshotted, j.sources...)
	}
	if out.Unavailable != "" {
		// Nothing is used: remove what exists, read everything live.
		out.CleanupFailed = append(out.CleanupFailed, Remove(ctx, r, h, created, runID)...)
		created = nil
		out.Snapshotted, out.Failed, out.Live = nil, nil, nil
		for _, ps := range plan.Sources {
			out.Live = append(out.Live, ps.Path)
		}
	}
	sort.Strings(out.Snapshotted)
	sort.Strings(out.Live)
	return created, out
}

// runLVM runs a command that changes LVM state (lvcreate, lvchange,
// lvremove). It is never killed and the run's cancellation does not reach
// it (cmdrun.RunNoKill): SIGKILL while lvm has the origin suspended can
// leave it suspended and freeze the machine. ctx is checked only between
// commands.
func runLVM(ctx context.Context, r cmdrun.Runner, argv []string) ([]byte, error) {
	return cmdrun.RunNoKill(ctx, r, cmdrun.StateChangeTimeout, argv[0], argv[1:]...)
}

func createLV(ctx context.Context, r cmdrun.Runner, s PlannedSource) (Created, []Failure, error) {
	c := Created{Method: MethodLVM, VG: s.VG, LV: SnapLVName(s.LV), Origin: s.LV, Thin: s.Thin, Pool: s.Pool, FSType: s.FSType}
	argv := LVCreateThick(s.VG, s.LV, s.CowBytes)
	if s.Thin {
		argv = LVCreateThin(s.VG, s.LV)
	}
	if _, err := runLVM(ctx, r, argv); err != nil {
		// lvcreate can fail (or hit its time limit) after the LV exists:
		// remove a snapshot it left right away, a thin one would hold pool
		// space until the next run.
		return c, removeLeftover(ctx, r, s.VG, c.LV), fmt.Errorf("lvcreate for %s/%s failed: %w", s.VG, s.LV, err)
	}
	if s.Thin {
		a := LVActivate(s.VG, c.LV)
		if _, err := runLVM(ctx, r, a); err != nil {
			var fails []Failure
			rm := LVRemove(s.VG, c.LV)
			if _, rerr := runLVM(ctx, r, rm); rerr != nil {
				fails = append(fails, Failure{Path: s.VG + "/" + c.LV, Message: rerr.Error()})
			}
			return c, fails, fmt.Errorf("activating the thin snapshot of %s/%s failed: %w", s.VG, s.LV, err)
		}
	}
	return c, nil, nil
}

// removeLeftover removes vg/snap after a failed lvcreate when it exists and
// is the agent's (tag and suffix); a failed removal is returned.
func removeLeftover(ctx context.Context, r cmdrun.Runner, vg, snap string) []Failure {
	q := LVSOne(vg, snap)
	out, err := r.Run(context.WithoutCancel(ctx), q[0], q[1:]...)
	if err != nil {
		// Not there (lvs exits non-zero) or not readable: the stale
		// cleanup of the next run removes what is left.
		return nil
	}
	rep, err := sysparse.ParseLVMFullReport(out)
	if err != nil {
		return nil
	}
	for _, row := range rep.LVs {
		if row["vg_name"] != vg || row["lv_name"] != snap || !Owned(snap, splitComma(row["lv_tags"])) {
			continue
		}
		rm := LVRemove(vg, snap)
		if _, err := runLVM(ctx, r, rm); err != nil {
			return []Failure{{Path: vg + "/" + snap, Message: err.Error()}}
		}
	}
	return nil
}

func createBtrfs(ctx context.Context, h Helper, s PlannedSource, runID string) (Created, error) {
	if h == nil {
		return Created{}, ErrNoHelper
	}
	c := Created{Method: MethodBtrfs, BtrfsUUID: s.BtrfsUUID, Device: s.Device, SnapPath: BtrfsSnapRel(runID, s.SubvolID),
		SubvolID: s.SubvolID, FSType: "btrfs"}
	spec := plainSpec(map[string]string{s.BtrfsUUID: s.Device}, BtrfsRunDir(s.BtrfsUUID, runID))
	argv := BtrfsSnapshot(s.BtrfsUUID, s.SubvolPath, runID, s.SubvolID)
	if _, err := h.Run(ctx, spec, argv); err != nil {
		return c, fmt.Errorf("btrfs snapshot of %s failed: %w", s.Path, err)
	}
	return c, nil
}
