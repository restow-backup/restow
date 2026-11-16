package fssnap

import (
	"fmt"
	"sort"
	"strings"
)

// Limits of the plan (docs/BAREMETAL.md, 6.2).
const (
	GiB              = int64(1) << 30
	minCOW           = 1 * GiB
	maxCOW           = 32 * GiB
	minVGFree        = 1 * GiB
	vgShare          = 0.90
	thinStartPercent = 80.0
	btrfsMinFreePct  = 5.0
	btrfsMinFree     = 2 * GiB
)

// COWBytes is the copy-on-write size of a thick snapshot: 10 percent of the
// LV, at least 1 GiB, at most 32 GiB.
func COWBytes(lvSize int64) int64 {
	c := lvSize / 10
	if c < minCOW {
		c = minCOW
	}
	if c > maxCOW {
		c = maxCOW
	}
	return c
}

// MakePlan decides per source how it is read (pure; 6.1, 6.2). mode is the
// machine's fsSnapshot ("auto" or "off").
func MakePlan(f Facts, mode string) Plan {
	p := Plan{Requested: mode == "auto"}
	p.Notes = append(p.Notes, f.Notes...)
	for _, s := range f.Sources {
		ps := PlannedSource{Source: s, Method: MethodLive}
		switch {
		case !p.Requested:
			ps.LiveReason = ReasonOff
		case s.Noauto:
			// Mounted read-only by the helper: nothing writes it.
			ps.LiveReason = noautoReason(s)
		case s.NoSnapshot:
			// Another tool's read-only snapshot: bound live as it is.
		case s.FSType == "btrfs":
			ps.Method = MethodBtrfs
			if fs, ok := f.Btrfs[s.BtrfsUUID]; ok && fs.SizeBytes > 0 {
				if pct := float64(fs.FreeBytes) * 100 / float64(fs.SizeBytes); pct < btrfsMinFreePct || fs.FreeBytes < btrfsMinFree {
					ps.PreFail = fmt.Sprintf("the btrfs file system has only %s free (a snapshot needs 5 percent and 2 GiB)", humanBytes(fs.FreeBytes))
				}
			}
		case s.FSType == "vfat":
			ps.LiveReason = ReasonVFAT
		case s.LUKSOnLV:
			ps.LiveReason = ReasonLUKSOnLV
		case s.Kind == "lv" && !snapshotFS[s.FSType]:
			ps.LiveReason = ReasonUnsupportedFS
		case s.Kind == "lv" && s.Thin:
			pool := f.Pools[s.VG+"/"+s.Pool]
			if pool.DataPercent < thinStartPercent && pool.MetaPercent < thinStartPercent {
				ps.Method = MethodLVM
			} else {
				ps.LiveReason = ReasonThinPoolBusy
				p.Notes = append(p.Notes, fmt.Sprintf("%s is read without a snapshot: the thin pool %s/%s is %.0f percent full (data) and %.0f percent (metadata); a snapshot needs both below 80 percent.",
					s.Path, s.VG, s.Pool, pool.DataPercent, pool.MetaPercent))
			}
		case s.Kind == "lv":
			ps.Method = MethodLVM // thick, sized below
		case s.Kind == "partition" || s.Kind == "disk":
			ps.LiveReason = ReasonPartition
		case s.Kind == "md":
			ps.LiveReason = ReasonMD
		default:
			ps.LiveReason = ReasonUnsupportedFS
		}
		p.Sources = append(p.Sources, ps)
	}
	if p.Requested && f.Unavailable != "" {
		// The LVM tools are missing: no LVM snapshot can be taken at all.
		for i := range p.Sources {
			if p.Sources[i].Method == MethodLVM {
				p.Unavailable = f.Unavailable
				p.Sources[i].Method = MethodLive
			}
		}
	}
	if p.Requested {
		allocateCOW(&p, f)
	}
	methods := map[Method]bool{}
	for _, s := range p.Sources {
		if s.Method != MethodLive {
			methods[s.Method] = true
		}
	}
	switch {
	case len(methods) > 1:
		p.Method = "mixed"
	case methods[MethodLVM]:
		p.Method = string(MethodLVM)
	case methods[MethodBtrfs]:
		p.Method = string(MethodBtrfs)
	}
	return p
}

func noautoReason(s Source) string {
	switch {
	case s.FSType == "vfat":
		return ReasonVFAT
	case strings.Contains(s.Device, "/mapper/"):
		return ReasonUnsupportedFS
	}
	return ReasonPartition
}

// allocateCOW sizes the thick snapshots: one per LV, priority "/" first,
// then by the depth of the mount point; all of a VG together at most 90
// percent of its free space; a VG with less than 1 GiB free has no
// method. What does not fit is read live (vg_no_space) with a note.
func allocateCOW(p *Plan, f Facts) {
	type want struct {
		key, vg string
		cow     int64
		depth   int
		root    bool
	}
	wants := map[string]*want{}
	for _, s := range p.Sources {
		if s.Method != MethodLVM || s.Thin {
			continue
		}
		key := s.VG + "/" + s.LV
		w, ok := wants[key]
		if !ok {
			w = &want{key: key, vg: s.VG, cow: COWBytes(f.LVs[key].SizeBytes), depth: 1 << 30}
			wants[key] = w
		}
		if s.MountTarget == "/" {
			w.root = true
		}
		if d := depth(s.MountTarget); d < w.depth {
			w.depth = d
		}
	}
	list := make([]*want, 0, len(wants))
	for _, w := range wants {
		list = append(list, w)
	}
	sort.Slice(list, func(i, j int) bool {
		a, b := list[i], list[j]
		if a.root != b.root {
			return a.root
		}
		if a.depth != b.depth {
			return a.depth < b.depth
		}
		return a.key < b.key
	})
	budget := map[string]int64{}
	for name, vg := range f.VGs {
		if vg.FreeBytes >= minVGFree {
			budget[name] = int64(float64(vg.FreeBytes) * vgShare)
		}
	}
	granted := map[string]int64{}
	for _, w := range list {
		if b := budget[w.vg]; b >= w.cow {
			budget[w.vg] = b - w.cow
			granted[w.key] = w.cow
		}
	}
	noted := map[string]bool{}
	for i := range p.Sources {
		s := &p.Sources[i]
		if s.Method != MethodLVM || s.Thin {
			continue
		}
		key := s.VG + "/" + s.LV
		if cow, ok := granted[key]; ok {
			s.CowBytes = cow
			continue
		}
		s.Method, s.LiveReason = MethodLive, ReasonVGNoSpace
		vg := f.VGs[s.VG]
		if vg.FreeBytes >= minVGFree && !noted[key] {
			noted[key] = true
			p.Notes = append(p.Notes, fmt.Sprintf("%s is read without a snapshot: the free space of volume group %s (%s) is used by the snapshots of other file systems.",
				s.Path, s.VG, humanBytes(vg.FreeBytes)))
		}
	}
}

func depth(p string) int {
	if p == "/" || p == "" {
		return 0
	}
	return strings.Count(strings.TrimSuffix(p, "/"), "/")
}

func humanBytes(n int64) string {
	switch {
	case n >= GiB:
		return fmt.Sprintf("%.1f GiB", float64(n)/float64(GiB))
	case n >= 1<<20:
		return fmt.Sprintf("%.1f MiB", float64(n)/float64(1<<20))
	}
	return fmt.Sprintf("%d bytes", n)
}

// FSSnapshots and LiveReasons are the planned methods per source path for
// the manifest (backup.fsSnapshots and backup.liveReasons, R5/R6).
func (p Plan) FSSnapshots() (map[string]string, map[string]string) {
	m, r := map[string]string{}, map[string]string{}
	for _, s := range p.Sources {
		m[s.Path] = string(s.Method)
		if s.Method == MethodLive && s.LiveReason != "" {
			r[s.Path] = s.LiveReason
		}
	}
	return m, r
}

// Wanted reports whether the plan takes any snapshot.
func (p Plan) Wanted() bool { return p.Method != "" }
