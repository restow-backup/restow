package core

import (
	"fmt"
	"path"
	"sort"
	"strings"

	"github.com/restow-backup/restow/agent/internal/baremetal"
	"github.com/restow-backup/restow/agent/internal/sysparse"
)

// bootPaths are the mount points a system needs to start.
var bootPaths = map[string]bool{"/": true, "/boot": true, "/boot/efi": true, "/efi": true}

// wholeMachineSources lists the sources of a whole-machine backup from the
// manifest (docs/BAREMETAL.md 5.2): every mounted file system of a
// supported type on a local device, each mount point once (a bind mount
// of the same file system and subvolume only at its first mount point);
// every local fstab entry, also noauto and automount ones; every btrfs
// subvolume below a mounted path except Snapper, Timeshift and the
// agent's own snapshots (the openSUSE root, a Snapper snapshot mounted as
// /, is a source, and so is its /.snapshots/<N>/info.xml); removable media
// only when they are in fstab or in the boot path. The list is sorted.
func wholeMachineSources(m *baremetal.Manifest) ([]string, []string) {
	l := m.Linux
	if l == nil {
		return nil, nil
	}
	set := map[string]bool{}
	var notes []string
	fsByID := map[string]*baremetal.Filesystem{}
	for i := range l.Filesystems {
		fsByID[l.Filesystems[i].ID] = &l.Filesystems[i]
	}
	inFstab := map[string]bool{}
	for _, e := range l.Fstab {
		inFstab[path.Clean(e.Target)] = true
	}
	removable := removableFS(l)
	subvolKind := func(fs *baremetal.Filesystem, id int64) string {
		if fs.Btrfs == nil {
			return ""
		}
		for _, s := range fs.Btrfs.Subvolumes {
			if s.ID == id {
				return s.Kind
			}
		}
		return ""
	}
	seenMount := map[string]bool{}
	for _, mo := range l.Mounts {
		if mo.FS == nil || mo.Autofs {
			continue
		}
		fs := fsByID[*mo.FS]
		if fs == nil || !baremetal.SupportedFSTypes[fs.Type] {
			continue
		}
		target := path.Clean(mo.Target)
		if removable[fs.ID] && !inFstab[target] && !bootPaths[target] {
			notes = append(notes, fmt.Sprintf("%s is on a removable disk that is not in /etc/fstab; it is not backed up with the whole machine.", target))
			continue
		}
		key := fs.ID
		if mo.SubvolID != nil {
			key = fmt.Sprintf("%s/%d", fs.ID, *mo.SubvolID)
			switch subvolKind(fs, *mo.SubvolID) {
			case baremetal.SubvolSnapper, baremetal.SubvolTimeshift, baremetal.SubvolRestow:
				if target != "/" {
					continue
				}
			}
		}
		if seenMount[key] {
			continue
		}
		seenMount[key] = true
		set[target] = true
	}
	for _, e := range l.Fstab {
		if e.Resolved == nil || e.Resolved.FS == nil || e.Type == "swap" || !strings.HasPrefix(e.Target, "/") {
			continue
		}
		fs := fsByID[*e.Resolved.FS]
		if fs == nil || !baremetal.SupportedFSTypes[fs.Type] || sysparse.HasOption(e.Options, "bind") {
			continue
		}
		if v, ok := sysparse.OptionValue(e.Options, "subvol"); ok && fs.Btrfs != nil {
			if k := subvolKindByPath(fs, v); k == baremetal.SubvolSnapper || k == baremetal.SubvolTimeshift {
				continue
			}
		}
		set[path.Clean(e.Target)] = true
	}
	// btrfs subvolumes below mounted paths.
	for _, mo := range l.Mounts {
		if mo.FS == nil || mo.Subvol == nil {
			continue
		}
		fs := fsByID[*mo.FS]
		if fs == nil || fs.Btrfs == nil {
			continue
		}
		root := strings.Trim(*mo.Subvol, "/")
		for _, sv := range fs.Btrfs.Subvolumes {
			switch sv.Kind {
			case baremetal.SubvolSnapper, baremetal.SubvolTimeshift, baremetal.SubvolRestow:
				continue
			}
			rest, ok := strings.CutPrefix(sv.Path, root+"/")
			if root == "" {
				rest, ok = sv.Path, true
			}
			if !ok || rest == "" {
				continue
			}
			if hasSnapshotAncestor(fs, sv.Path) {
				continue
			}
			set[path.Join(mo.Target, rest)] = true
		}
		// openSUSE: / is @/.snapshots/<N>/snapshot; its info.xml lies next to it.
		if path.Clean(mo.Target) == "/" && strings.HasSuffix(root, "/snapshot") && strings.Contains(root, ".snapshots/") {
			parent := path.Dir(root)
			n := path.Base(parent)
			set[path.Join("/.snapshots", n, "info.xml")] = true
		}
	}
	out := make([]string, 0, len(set))
	for p := range set {
		out = append(out, p)
	}
	sort.Strings(out)
	return out, notes
}

func subvolKindByPath(fs *baremetal.Filesystem, p string) string {
	p = strings.Trim(p, "/")
	for _, s := range fs.Btrfs.Subvolumes {
		if s.Path == p {
			return s.Kind
		}
	}
	return baremetal.SubvolNormal
}

// hasSnapshotAncestor: the subvolume lies inside a Snapper or Timeshift
// subvolume (their nested content is never a source).
func hasSnapshotAncestor(fs *baremetal.Filesystem, p string) bool {
	for _, s := range fs.Btrfs.Subvolumes {
		if s.Kind != baremetal.SubvolSnapper && s.Kind != baremetal.SubvolTimeshift && s.Kind != baremetal.SubvolRestow {
			continue
		}
		if strings.HasPrefix(p, s.Path+"/") {
			return true
		}
	}
	return false
}

// removableFS marks the file systems on removable disks (RM=1, USB, MMC).
func removableFS(l *baremetal.LinuxLayout) map[string]bool {
	rem := map[string]bool{}
	for _, d := range l.Disks {
		t := ""
		if d.Transport != nil {
			t = *d.Transport
		}
		if d.Removable || t == "usb" || t == "mmc" {
			rem[d.ID] = true
		}
	}
	out := map[string]bool{}
	for _, fs := range l.Filesystems {
		for _, d := range fs.Devices {
			for _, disk := range disksOf(l, d, 0) {
				if rem[disk] {
					out[fs.ID] = true
				}
			}
		}
	}
	return out
}

// disksOf follows a block reference down to the disks.
func disksOf(l *baremetal.LinuxLayout, r baremetal.BlockRef, depth int) []string {
	if depth > 16 {
		return nil
	}
	switch r.Kind {
	case baremetal.RefDisk, baremetal.RefPartition:
		return []string{r.Disk}
	case baremetal.RefMD:
		var out []string
		for _, md := range l.MD {
			if md.ID == r.ID {
				for _, m := range md.Members {
					out = append(out, disksOf(l, m.Device, depth+1)...)
				}
			}
		}
		return out
	case baremetal.RefLUKS:
		for _, c := range l.LUKS {
			if c.ID == r.ID {
				return disksOf(l, c.Device, depth+1)
			}
		}
	case baremetal.RefPlain:
		for _, c := range l.PlainCrypt {
			if c.ID == r.ID {
				return disksOf(l, c.Device, depth+1)
			}
		}
	case baremetal.RefLV:
		var out []string
		for _, pv := range l.LVM.PVs {
			if pv.VG != nil && *pv.VG == r.VG {
				out = append(out, disksOf(l, pv.Device, depth+1)...)
			}
		}
		return out
	}
	return nil
}

// wholeMachineExcludes are excluded on top of the job's (5.3): swap files
// (recreated by a restore) and the Snapper and Timeshift subvolumes below
// mounted paths (their content would be multiplied).
func wholeMachineExcludes(m *baremetal.Manifest) []string {
	l := m.Linux
	if l == nil {
		return nil
	}
	set := map[string]bool{}
	for _, s := range l.Swap {
		if s.Kind == "file" && s.Path != nil {
			set[*s.Path] = true
		}
	}
	fsByID := map[string]*baremetal.Filesystem{}
	for i := range l.Filesystems {
		fsByID[l.Filesystems[i].ID] = &l.Filesystems[i]
	}
	for _, mo := range l.Mounts {
		if mo.FS == nil || mo.Subvol == nil {
			continue
		}
		fs := fsByID[*mo.FS]
		if fs == nil || fs.Btrfs == nil {
			continue
		}
		root := strings.Trim(*mo.Subvol, "/")
		for _, sv := range fs.Btrfs.Subvolumes {
			if sv.Kind != baremetal.SubvolSnapper && sv.Kind != baremetal.SubvolTimeshift {
				continue
			}
			if sv.Path == root {
				continue // the mounted root itself (openSUSE)
			}
			rest, ok := strings.CutPrefix(sv.Path, root+"/")
			if root == "" {
				rest, ok = sv.Path, true
			}
			if ok && rest != "" && !hasSnapshotAncestor(fs, sv.Path) {
				set[path.Join(mo.Target, rest)] = true
			}
		}
		if id := mo.SubvolID; id != nil && path.Clean(mo.Target) != "/" {
			for _, sv := range fs.Btrfs.Subvolumes {
				if sv.ID == *id && (sv.Kind == baremetal.SubvolSnapper || sv.Kind == baremetal.SubvolTimeshift) {
					set[path.Clean(mo.Target)] = true
				}
			}
		}
	}
	out := make([]string, 0, len(set))
	for p := range set {
		out = append(out, p)
	}
	sort.Strings(out)
	return out
}

// mountinfoSources is the fallback when the capture failed: the mount
// points of local file systems of supported types (5.6 step 1).
func mountinfoSources(mountinfo []byte) []string {
	mi, err := sysparse.ParseMountinfo(mountinfo)
	if err != nil {
		return []string{"/"}
	}
	set := map[string]bool{"/": true}
	seen := map[string]bool{}
	for _, m := range mi {
		if !baremetal.SupportedFSTypes[m.FSType] || !strings.HasPrefix(m.Source, "/dev/") {
			continue
		}
		key := m.MajMin + "|" + m.Root
		if m.FSType == "btrfs" {
			key = m.Source + "|" + m.Root
		}
		if seen[key] {
			continue
		}
		seen[key] = true
		set[m.Target] = true
	}
	out := make([]string, 0, len(set))
	for p := range set {
		out = append(out, p)
	}
	sort.Strings(out)
	return out
}
