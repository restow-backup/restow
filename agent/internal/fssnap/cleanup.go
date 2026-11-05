package fssnap

import (
	"context"
	"fmt"
	"path"
	"sort"
	"strings"
	"time"

	"github.com/restow-backup/restow/agent/internal/baremetal"
	"github.com/restow-backup/restow/agent/internal/cmdrun"
	"github.com/restow-backup/restow/agent/internal/sysparse"
)

// CleanupTimeout bounds removing snapshots after a run (also after a
// cancellation: like the post hook, cleanup gets its own time).
const CleanupTimeout = 2 * time.Minute

// Remove deletes the snapshots of a run (6.5) with its own time limit
// (also after a cancellation). lvremove is never killed and has its own,
// longer limit per call (runLVM).
func Remove(ctx context.Context, r cmdrun.Runner, h Helper, created []Created, runID string) []Failure {
	cctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), CleanupTimeout)
	defer cancel()
	var fails []Failure
	tops := map[string]string{}
	for _, c := range created {
		switch c.Method {
		case MethodLVM:
			argv := LVRemove(c.VG, c.LV)
			if _, err := runLVM(ctx, r, argv); err != nil {
				fails = append(fails, Failure{Path: c.VG + "/" + c.LV, Message: err.Error()})
			}
		case MethodBtrfs:
			if h == nil {
				continue
			}
			spec := plainSpec(map[string]string{c.BtrfsUUID: c.Device})
			if _, err := h.Run(cctx, spec, BtrfsDelete(c.BtrfsUUID, c.SnapPath)); err != nil {
				msg := err.Error()
				p := c.SnapPath
				if len(c.Sources) > 0 {
					p = c.Sources[0]
				}
				fails = append(fails, Failure{Path: p, Message: msg})
				continue
			}
			tops[c.BtrfsUUID] = c.Device
		}
	}
	// The run folders are empty now.
	uuids := make([]string, 0, len(tops))
	for u := range tops {
		uuids = append(uuids, u)
	}
	sort.Strings(uuids)
	for _, u := range uuids {
		spec := plainSpec(map[string]string{u: tops[u]})
		_, _ = h.Run(cctx, spec, []string{"rmdir", BtrfsRunDir(u, runID)})
	}
	return fails
}

type lvsOwned struct {
	VG, LV, Time string
	Tags         []string
}

// Owned reports whether an LV is one of the agent's snapshots: both the
// tag and the name suffix (the only marks; nothing else is removed).
func Owned(lv string, tags []string) bool {
	if !strings.HasSuffix(lv, SnapshotSuffix) || len(lv) == len(SnapshotSuffix) {
		return false
	}
	for _, t := range tags {
		if t == SnapshotTag {
			return true
		}
	}
	return false
}

// StaleReport says what CleanupStale removed.
type StaleReport struct {
	Removed  int
	Since    string
	Failures []Failure
}

// String is the run log line ("2 leftover snapshots from 2026-11-03 removed").
func (s StaleReport) String() string {
	if s.Removed == 0 && len(s.Failures) == 0 {
		return ""
	}
	var b strings.Builder
	if s.Removed > 0 {
		noun := "snapshots"
		if s.Removed == 1 {
			noun = "snapshot"
		}
		fmt.Fprintf(&b, "%d leftover %s", s.Removed, noun)
		if s.Since != "" {
			fmt.Fprintf(&b, " from %s", s.Since)
		}
		b.WriteString(" removed.")
	}
	for _, f := range s.Failures {
		if b.Len() > 0 {
			b.WriteString(" ")
		}
		fmt.Fprintf(&b, "Removing the leftover snapshot %s failed: %s.", f.Path, f.Message)
	}
	return b.String()
}

// CleanupStale removes snapshots left by an earlier run that did not get to
// clean up (crash, power loss, kill -9): LVs with the tag and the suffix,
// and btrfs subvolumes below .restow-snapshots/ (except activeRun's).
func CleanupStale(ctx context.Context, r cmdrun.Runner, h Helper, host baremetal.Host, activeRun string) StaleReport {
	cctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), CleanupTimeout)
	defer cancel()
	var rep StaleReport
	if out, err := r.Run(cctx, LVSOwned()[0], LVSOwned()[1:]...); err == nil {
		if lvs, err := sysparse.ParseLVMFullReport(out); err == nil {
			for _, row := range lvs.LVs {
				if !Owned(row["lv_name"], splitComma(row["lv_tags"])) {
					continue
				}
				argv := LVRemove(row["vg_name"], row["lv_name"])
				if _, err := runLVM(ctx, r, argv); err != nil {
					rep.Failures = append(rep.Failures, Failure{Path: row["vg_name"] + "/" + row["lv_name"], Message: err.Error()})
					continue
				}
				rep.Removed++
				if t := strings.Fields(row["lv_time"]); len(t) > 0 && (rep.Since == "" || t[0] < rep.Since) {
					rep.Since = t[0]
				}
			}
		}
	}
	if h == nil || host == nil {
		return rep
	}
	b, err := host.ReadFile("/proc/self/mountinfo", 0)
	if err != nil {
		return rep
	}
	mi, _ := sysparse.ParseMountinfo(b)
	seen := map[string]bool{}
	for _, m := range mi {
		if m.FSType != "btrfs" {
			continue
		}
		uuid := btrfsUUIDOf(host, m.Source)
		if uuid == "" {
			uuid = strings.ReplaceAll(strings.TrimPrefix(m.Source, "/dev/"), "/", "_")
		}
		if seen[uuid] {
			continue
		}
		seen[uuid] = true
		argv := BtrfsList(m.Target)
		out, err := r.Run(cctx, argv[0], argv[1:]...)
		if err != nil {
			continue
		}
		list, _ := sysparse.ParseBtrfsSubvolumeList(out)
		runs := map[string]bool{}
		// Delete the deepest first (a snapshot of a subvolume with nested
		// subvolumes holds them as empty folders, not subvolumes).
		sort.Slice(list, func(i, j int) bool { return len(list[i].Path) > len(list[j].Path) })
		for _, sv := range list {
			run, ok := OwnedSubvol(sv.Path)
			if !ok || run == activeRun {
				continue
			}
			spec := plainSpec(map[string]string{uuid: m.Source})
			if _, err := h.Run(cctx, spec, BtrfsDelete(uuid, sv.Path)); err != nil {
				rep.Failures = append(rep.Failures, Failure{Path: sv.Path, Message: err.Error()})
				continue
			}
			rep.Removed++
			runs[run] = true
		}
		for _, run := range sortedSet(runs) {
			spec := plainSpec(map[string]string{uuid: m.Source})
			_, _ = h.Run(cctx, spec, []string{"rmdir", BtrfsRunDir(uuid, run)})
		}
	}
	return rep
}

// OwnedSubvol reports whether a subvolume path (relative to the top level)
// is one of the agent's snapshots, and of which run: exactly
// .restow-snapshots/<run>/<id>.
func OwnedSubvol(p string) (string, bool) {
	parts := strings.Split(path.Clean(p), "/")
	if len(parts) != 3 || parts[0] != SnapDirName || parts[1] == "" || parts[1] == ".." || parts[2] == "" {
		return "", false
	}
	for _, c := range parts[2] {
		if c < '0' || c > '9' {
			return "", false
		}
	}
	return parts[1], true
}

func splitComma(s string) []string {
	var out []string
	for _, t := range strings.Split(s, ",") {
		if t = strings.TrimSpace(t); t != "" {
			out = append(out, t)
		}
	}
	return out
}

func sortedSet(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
