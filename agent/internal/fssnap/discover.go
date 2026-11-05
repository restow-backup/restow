package fssnap

import (
	"context"
	"fmt"
	"path"
	"sort"
	"strconv"
	"strings"

	"github.com/restow-backup/restow/agent/internal/baremetal"
	"github.com/restow-backup/restow/agent/internal/cmdrun"
	"github.com/restow-backup/restow/agent/internal/sysparse"
)

// lvsArgs and vgsArgs read the LVM state the plan needs.
var (
	lvsArgs = []string{"--reportformat", "json", "--units", "b", "--nosuffix", "-o",
		"vg_name,lv_name,lv_attr,lv_size,pool_lv,data_percent,metadata_percent,lv_kernel_major,lv_kernel_minor"}
	vgsArgs = []string{"--reportformat", "json", "--units", "b", "--nosuffix", "-o", "vg_name,vg_size,vg_free,vg_extent_size"}
)

// snapshotFS are the file systems an LVM snapshot can be mounted from
// (ext2/3/4 and XFS; btrfs is snapshotted by btrfs itself).
var snapshotFS = map[string]bool{"ext2": true, "ext3": true, "ext4": true, "xfs": true}

// Discover maps each source to the file system that holds it, from
// mountinfo and sysfs, the LVM report and the btrfs subvolume lists. The
// root file system is always discovered (the snapshot tree is built on it).
// With wholeMachine, sources that are noauto fstab entries of local
// devices and not mounted become helper mounts (read-only, 6.3). Without
// wholeMachine, restic runs without -x: every mount and btrfs subvolume
// below a source is added as a Nested source, so the snapshot tree holds
// it (its snapshot, or a read-only bind of the live path).
func Discover(ctx context.Context, r cmdrun.Runner, h baremetal.Host, sources []string, wholeMachine bool) (Facts, error) {
	f := Facts{VGs: map[string]VG{}, LVs: map[string]LV{}, Pools: map[string]LV{}, Btrfs: map[string]BtrfsFS{}}
	b, err := h.ReadFile("/proc/self/mountinfo", 0)
	if err != nil {
		return f, err
	}
	mi, err := sysparse.ParseMountinfo(b)
	if err != nil {
		return f, err
	}
	var mounts []sysparse.MountInfo
	for _, m := range mi {
		if !baremetal.PseudoFSTypes[m.FSType] && m.FSType != "autofs" {
			mounts = append(mounts, m)
		}
	}
	noauto := map[string]sysparse.FstabLine{}
	if wholeMachine {
		if fb, err := h.ReadFile("/etc/fstab", 0); err == nil {
			for _, e := range sysparse.ParseFstab(fb) {
				if sysparse.HasOption(e.Options, "noauto") && (snapshotFS[e.Type] || e.Type == "vfat") && localSpec(e.Source) {
					noauto[path.Clean(e.Target)] = e
				}
			}
		}
	}
	d := &discovery{r: r, h: h, ctx: ctx, f: &f, subvols: map[string][]sysparse.BtrfsSubvol{}}
	f.Root = d.source("/", mounts, nil)
	for _, s := range sources {
		p := path.Clean(s)
		if e, ok := noauto[p]; ok && !isMountTarget(mounts, p) {
			f.Sources = append(f.Sources, Source{Path: p, MountTarget: p, FSType: e.Type, Device: specDevice(e.Source),
				Kind: "noauto", Noauto: true, Options: e.Options})
			continue
		}
		f.Sources = append(f.Sources, d.source(p, mounts, nil))
	}
	if !wholeMachine {
		d.addNested(mi, mounts)
	}
	// LVM report only when an LV is involved.
	needLVM := false
	for _, s := range append([]Source{f.Root}, f.Sources...) {
		if s.Kind == "lv" || s.LUKSOnLV {
			needLVM = true
		}
	}
	if needLVM {
		if err := d.lvm(); err != nil {
			f.Unavailable = err.Error()
		}
		for i := range f.Sources {
			d.completeLV(&f.Sources[i])
		}
		d.completeLV(&f.Root)
	}
	return f, nil
}

// runtimeDirs are bound into the tree by TreeMounts itself; mounts below
// them are never nested sources.
var runtimeDirs = []string{"/proc", "/sys", "/dev", "/run"}

func inRuntimeDir(p string) bool {
	for _, d := range runtimeDirs {
		if p == d || strings.HasPrefix(p, d+"/") {
			return true
		}
	}
	return false
}

// addNested adds what lies below the sources of a backup without
// wholeMachine: every mount (all types but autofs, outside /proc, /sys,
// /dev and /run) whose parent mount is in the tree, and every btrfs
// subvolume below a btrfs source that no other mount covers. A mount
// whose parent is not in the tree (below an indirect automount point) has
// no folder to be mounted on there; it gets a note.
func (d *discovery) addNested(all, mounts []sysparse.MountInfo) {
	n := len(d.f.Sources)
	have := map[string]bool{}
	for _, s := range d.f.Sources {
		have[s.Path] = true
	}
	add := func(s Source) {
		if have[s.Path] {
			return
		}
		have[s.Path] = true
		s.Nested = true
		d.f.Sources = append(d.f.Sources, s)
	}
	byID := map[int]sysparse.MountInfo{}
	for _, m := range all {
		byID[m.ID] = m
	}
	// The mounts in the tree: the root and those holding a source.
	inTree := map[int]bool{}
	if m := holder(mounts, "/"); m != nil {
		inTree[m.ID] = true
	}
	for _, s := range d.f.Sources[:n] {
		if m := holder(mounts, s.Path); m != nil {
			inTree[m.ID] = true
		}
	}
	below := func(p string) bool {
		for _, s := range d.f.Sources[:n] {
			if !s.Noauto && p != s.Path && under(p, s.Path) {
				return true
			}
		}
		return false
	}
	cand := make([]sysparse.MountInfo, 0, len(all))
	for _, m := range all {
		if m.FSType != "autofs" && !inRuntimeDir(m.Target) && below(m.Target) {
			cand = append(cand, m)
		}
	}
	// Parents first.
	sort.SliceStable(cand, func(i, j int) bool { return depth(cand[i].Target) < depth(cand[j].Target) })
	for _, m := range cand {
		parent, ok := byID[m.ParentID]
		if ok && parent.FSType == "autofs" && parent.Target == m.Target {
			// A direct automount: the mount sits on the automount point,
			// whose folder is in the parent of that.
			parent, ok = byID[parent.ParentID]
		}
		if !ok || !inTree[parent.ID] {
			if !have[m.Target] {
				have[m.Target] = true
				d.f.Notes = append(d.f.Notes, fmt.Sprintf("%s is mounted below %s, which is not in the snapshot tree; it is not backed up in this run.", m.Target, path.Dir(m.Target)))
			}
			continue
		}
		inTree[m.ID] = true
		if h := holder(all, m.Target); h == nil || h.ID != m.ID {
			// Stacked mounts: the last one is what is visible.
			continue
		}
		if baremetal.PseudoFSTypes[m.FSType] {
			add(Source{Path: m.Target, MountTarget: m.Target, FSType: m.FSType, Device: m.Source, Kind: "other"})
			continue
		}
		ns := d.source(m.Target, mounts, nil)
		if ns.Kind == "disk" && strings.HasPrefix(m.MajMin, "0:") {
			ns.Kind = "other" // no block device: a network or FUSE file system
		}
		if ns.FSType == "btrfs" {
			switch baremetal.SubvolKind(ns.SubvolPath) {
			case baremetal.SubvolSnapper, baremetal.SubvolTimeshift:
				ns.NoSnapshot = true
			}
		}
		add(ns)
	}
	for i := 0; i < len(d.f.Sources); i++ {
		// A source read live brings its subvolumes along in its bind.
		if s := d.f.Sources[i]; s.FSType == "btrfs" && !s.Noauto && !s.NoSnapshot {
			d.nestedSubvols(s, mounts, add)
		}
	}
}

// nestedSubvols adds the btrfs subvolumes below s that are not mounted
// elsewhere: a snapshot of s holds them as empty folders. The read-only
// snapshots of snapper and Timeshift are bound live (everything below
// them comes with the bind); the agent's own snapshots are left out.
func (d *discovery) nestedSubvols(s Source, mounts []sysparse.MountInfo, add func(Source)) {
	m := holder(mounts, s.Path)
	if m == nil || m.FSType != "btrfs" {
		return
	}
	mountRoot := strings.TrimPrefix(m.Root, "/")
	list := append([]sysparse.BtrfsSubvol(nil), d.subvols[s.BtrfsUUID]...)
	sort.SliceStable(list, func(i, j int) bool { return len(list[i].Path) < len(list[j].Path) })
	var bound []string
	for _, sv := range list {
		rel, ok := relUnder(sv.Path, mountRoot)
		if !ok || rel == "" {
			continue
		}
		real := path.Join(m.Target, rel)
		if real == s.Path || !under(real, s.Path) {
			continue
		}
		if h := holder(mounts, real); h == nil || h.ID != m.ID {
			continue // another mount covers it (a nested mount of its own)
		}
		covered := false
		for _, b := range bound {
			covered = covered || under(real, b)
		}
		if covered {
			continue
		}
		ns := Source{Path: real, MountTarget: m.Target, FSType: "btrfs", Device: m.Source, Kind: "btrfs", BtrfsUUID: s.BtrfsUUID,
			SubvolPath: sv.Path, SubvolID: sv.ID, SubvolTarget: real}
		switch baremetal.SubvolKind(sv.Path) {
		case baremetal.SubvolRestow:
			continue
		case baremetal.SubvolSnapper, baremetal.SubvolTimeshift:
			ns.NoSnapshot = true
			bound = append(bound, real)
		}
		add(ns)
	}
}

type discovery struct {
	ctx     context.Context
	r       cmdrun.Runner
	h       baremetal.Host
	f       *Facts
	subvols map[string][]sysparse.BtrfsSubvol
}

func isMountTarget(mounts []sysparse.MountInfo, p string) bool {
	for _, m := range mounts {
		if m.Target == p {
			return true
		}
	}
	return false
}

func localSpec(s string) bool {
	for _, p := range []string{"UUID=", "LABEL=", "PARTUUID=", "PARTLABEL=", "/dev/"} {
		if strings.HasPrefix(s, p) {
			return true
		}
	}
	return false
}

// specDevice turns an fstab source into a device path.
func specDevice(s string) string {
	for k, dir := range map[string]string{"UUID=": "by-uuid", "LABEL=": "by-label", "PARTUUID=": "by-partuuid", "PARTLABEL=": "by-partlabel"} {
		if v, ok := strings.CutPrefix(s, k); ok {
			return "/dev/disk/" + dir + "/" + strings.Trim(v, `"`)
		}
	}
	return s
}

func under(p, dir string) bool {
	return dir == "/" || p == dir || strings.HasPrefix(p, dir+"/")
}

// holder returns the mount that holds p (longest target; the last of
// stacked mounts).
func holder(mounts []sysparse.MountInfo, p string) *sysparse.MountInfo {
	var best *sysparse.MountInfo
	for i := range mounts {
		m := &mounts[i]
		if under(p, m.Target) && (best == nil || len(m.Target) >= len(best.Target)) {
			best = m
		}
	}
	return best
}

func (d *discovery) source(p string, mounts []sysparse.MountInfo, _ any) Source {
	s := Source{Path: p, Kind: "other"}
	m := holder(mounts, p)
	if m == nil {
		return s
	}
	s.MountTarget, s.FSType, s.Device = m.Target, m.FSType, m.Source
	if m.FSType == "btrfs" {
		s.Kind = "btrfs"
		d.btrfs(&s, *m)
		return s
	}
	d.kind(&s, m.MajMin)
	return s
}

// kind reads /sys/dev/block/<maj:min> to tell an LV, a partition, an md
// array or a LUKS mapping (and what it sits on).
func (d *discovery) kind(s *Source, mm string) {
	base := "/sys/dev/block/" + mm
	if name, ok := readTrim(d.h, base+"/dm/name"); ok {
		uuid, _ := readTrim(d.h, base+"/dm/uuid")
		switch {
		case strings.HasPrefix(uuid, "LVM-"):
			s.Kind = "lv"
			s.VG, s.LV, _ = splitDMName(name)
		case strings.HasPrefix(uuid, "CRYPT-"):
			s.Kind = "crypt"
			slaves, _ := d.h.ReadDir(base + "/slaves")
			for _, sl := range slaves {
				su, _ := readTrim(d.h, "/sys/block/"+sl.Name()+"/dm/uuid")
				switch {
				case strings.HasPrefix(su, "LVM-"):
					s.LUKSOnLV = true
				case d.exists("/sys/block/" + sl.Name() + "/md"):
					s.Kind = "md"
				case d.exists("/sys/class/block/" + sl.Name() + "/partition"):
					s.Kind = "partition"
				default:
					s.Kind = "partition"
				}
			}
		default:
			s.Kind = "dm"
		}
		return
	}
	switch {
	case d.exists(base + "/partition"):
		s.Kind = "partition"
	case d.exists(base + "/md"):
		s.Kind = "md"
	default:
		s.Kind = "disk"
	}
}

func (d *discovery) exists(p string) bool {
	if _, err := d.h.Stat(p); err == nil {
		return true
	}
	_, err := d.h.Readlink(p)
	return err == nil
}

func readTrim(h baremetal.Host, p string) (string, bool) {
	b, err := h.ReadFile(p, 64<<10)
	if err != nil {
		return "", false
	}
	return strings.TrimSpace(string(b)), true
}

// btrfs finds the file system UUID (from /sys/fs/btrfs), its usage and
// the subvolume that holds the source path.
func (d *discovery) btrfs(s *Source, m sysparse.MountInfo) {
	s.BtrfsUUID = btrfsUUIDOf(d.h, m.Source)
	if s.BtrfsUUID == "" {
		s.BtrfsUUID = strings.ReplaceAll(strings.TrimPrefix(m.Source, "/dev/"), "/", "_")
	}
	fs, ok := d.f.Btrfs[s.BtrfsUUID]
	if !ok {
		fs = BtrfsFS{UUID: s.BtrfsUUID, Device: m.Source, Mount: m.Target}
		if out, err := d.r.Run(d.ctx, "btrfs", "filesystem", "usage", "--raw", m.Target); err == nil {
			if u, err := sysparse.ParseBtrfsUsageRaw(out); err == nil {
				fs.SizeBytes, fs.FreeBytes = u.DeviceSize, u.FreeEstimated
			}
		}
		d.f.Btrfs[s.BtrfsUUID] = fs
	}
	mountRoot := strings.TrimPrefix(m.Root, "/")
	id, _ := m.Option("subvolid")
	s.SubvolID, _ = strconv.ParseInt(id, 10, 64)
	s.SubvolPath, s.SubvolTarget = mountRoot, m.Target
	list, ok := d.subvols[s.BtrfsUUID]
	if !ok {
		if out, err := d.r.Run(d.ctx, "btrfs", "subvolume", "list", "-a", m.Target); err == nil {
			list, _ = sysparse.ParseBtrfsSubvolumeList(out)
		}
		d.subvols[s.BtrfsUUID] = list
	}
	best := ""
	for _, sv := range list {
		rel, ok := relUnder(sv.Path, mountRoot)
		if !ok {
			continue
		}
		real := path.Join(m.Target, rel)
		if under(s.Path, real) && len(real) > len(best) {
			best = real
			s.SubvolPath, s.SubvolID, s.SubvolTarget = sv.Path, sv.ID, real
		}
	}
}

// relUnder returns the part of p below root (both relative to the btrfs
// top level).
func relUnder(p, root string) (string, bool) {
	if root == "" {
		return p, true
	}
	if p == root {
		return "", true
	}
	if rest, ok := strings.CutPrefix(p, root+"/"); ok {
		return rest, true
	}
	return "", false
}

// btrfsUUIDOf finds the btrfs file system of a device in /sys/fs/btrfs.
func btrfsUUIDOf(h baremetal.Host, dev string) string {
	name := path.Base(dev)
	if strings.HasPrefix(dev, "/dev/mapper/") {
		// /sys/fs/btrfs lists dm devices as dm-N.
		blocks, _ := h.ReadDir("/sys/block")
		for _, b := range blocks {
			if n, ok := readTrim(h, "/sys/block/"+b.Name()+"/dm/name"); ok && n == name {
				name = b.Name()
				break
			}
		}
	}
	fss, _ := h.ReadDir("/sys/fs/btrfs")
	var ids []string
	for _, e := range fss {
		ids = append(ids, e.Name())
	}
	sort.Strings(ids)
	for _, id := range ids {
		if _, err := h.Lstat("/sys/fs/btrfs/" + id + "/devices/" + name); err == nil {
			return id
		}
		if _, err := h.Readlink("/sys/fs/btrfs/" + id + "/devices/" + name); err == nil {
			return id
		}
	}
	return ""
}

// lvm reads lvs and vgs.
func (d *discovery) lvm() error {
	out, err := d.r.Run(d.ctx, "lvs", lvsArgs...)
	if err != nil {
		if cmdrun.IsNotFound(err) {
			return fmt.Errorf("the LVM tools (lvm2) are not installed")
		}
		return fmt.Errorf("lvs failed: %v", err)
	}
	rep, err := sysparse.ParseLVMFullReport(out)
	if err != nil {
		return err
	}
	for _, row := range rep.LVs {
		attr := row["lv_attr"]
		lv := LV{VG: row["vg_name"], Name: row["lv_name"], SizeBytes: row.Int("lv_size"), Pool: row["pool_lv"]}
		lv.DataPercent, _ = row.Float("data_percent")
		lv.MetaPercent, _ = row.Float("metadata_percent")
		lv.Major, _ = strconv.Atoi(row["lv_kernel_major"])
		lv.Minor, _ = strconv.Atoi(row["lv_kernel_minor"])
		key := lv.VG + "/" + lv.Name
		switch {
		case len(attr) > 0 && attr[0] == 't':
			d.f.Pools[key] = lv
		case len(attr) > 0 && attr[0] == 'V':
			lv.Thin = true
			d.f.LVs[key] = lv
		default:
			d.f.LVs[key] = lv
		}
	}
	out, err = d.r.Run(d.ctx, "vgs", vgsArgs...)
	if err != nil {
		return fmt.Errorf("vgs failed: %v", err)
	}
	rep, err = sysparse.ParseLVMFullReport(out)
	if err != nil {
		return err
	}
	for _, row := range rep.VGs {
		d.f.VGs[row["vg_name"]] = VG{Name: row["vg_name"], SizeBytes: row.Int("vg_size"), FreeBytes: row.Int("vg_free"), Extent: row.Int("vg_extent_size")}
	}
	return nil
}

func (d *discovery) completeLV(s *Source) {
	if s.Kind != "lv" {
		return
	}
	if lv, ok := d.f.LVs[s.VG+"/"+s.LV]; ok {
		s.Thin, s.Pool = lv.Thin, lv.Pool
	}
}

// splitDMName splits an LV's device mapper name (dashes doubled).
func splitDMName(name string) (string, string, bool) {
	for i := 0; i < len(name); i++ {
		if name[i] != '-' {
			continue
		}
		if i+1 < len(name) && name[i+1] == '-' {
			i++
			continue
		}
		return strings.ReplaceAll(name[:i], "--", "-"), strings.ReplaceAll(name[i+1:], "--", "-"), true
	}
	return "", "", false
}
