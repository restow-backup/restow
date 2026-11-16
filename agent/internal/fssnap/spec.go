package fssnap

import (
	"encoding/json"
	"path"
	"sort"
	"strconv"
)

// Kinds of a helper spec.
const (
	// SpecTree builds the snapshot tree, chroots into it and runs restic
	// (or measures).
	SpecTree = "tree"
	// SpecPlain mounts btrfs top levels and runs a btrfs command.
	SpecPlain = "plain"
)

// Spec is what the helper (`restow-agent snapshot-exec`) sets up in its
// private mount namespace. It is written as JSON, mode 0600, into the
// agent's TmpDir; it is internal to the agent.
type Spec struct {
	Kind   string  `json:"kind"`
	Root   string  `json:"root,omitempty"`
	Mounts []Mount `json:"mounts"`
	// BtrfsTops are the btrfs top levels the spec mounts (information).
	BtrfsTops []BtrfsTopRef `json:"btrfsTops,omitempty"`
	// Mkdirs are created after mounting (plain: the run folder).
	Mkdirs []string `json:"mkdirs,omitempty"`
	Binds  Binds    `json:"binds"`
}

// Mount is one mount of a spec, in order.
type Mount struct {
	Target    string `json:"target"`
	Source    string `json:"source"`
	FSType    string `json:"fstype,omitempty"`
	Options   string `json:"options,omitempty"`
	Bind      bool   `json:"bind"`
	Recursive bool   `json:"recursive"`
}

// BtrfsTopRef names a mounted btrfs top level.
type BtrfsTopRef struct {
	UUID   string `json:"uuid"`
	Device string `json:"device"`
}

// Binds are the writable folders and the restic binary in the tree.
type Binds struct {
	Cache  string `json:"cache,omitempty"`
	Tmp    string `json:"tmp,omitempty"`
	Restic string `json:"restic,omitempty"`
}

// Encode returns the spec as JSON.
func (s Spec) Encode() ([]byte, error) { return json.MarshalIndent(s, "", "  ") }

// DecodeSpec reads a spec.
func DecodeSpec(b []byte) (Spec, error) {
	var s Spec
	err := json.Unmarshal(b, &s)
	return s, err
}

// TreeOptions are the agent's paths the tree needs.
type TreeOptions struct {
	ResticBin string
	CacheDir  string
	TmpDir    string
	RunID     string
}

// snapOptions are the mount options of a snapshot by file system type:
// no journal replay on ext3/4, XFS without log recovery and with nouuid
// (original and snapshot share the UUID).
func snapOptions(fstype string) string {
	switch fstype {
	case "ext3", "ext4":
		return "ro,noload"
	case "xfs":
		return "ro,nouuid,norecovery"
	}
	return "ro"
}

// noautoOptions are the options of a noauto fstab entry the helper mounts.
func noautoOptions(fstype string) string {
	switch fstype {
	case "ext3", "ext4":
		return "ro,noload"
	case "xfs":
		return "ro,norecovery"
	}
	return "ro"
}

// TreeMounts lays out the snapshot tree (6.3), ordered so that every mount
// lands inside the ones before it: a tmpfs, the root file system (its
// snapshot or a read-only bind of /, always, R12), then by depth each
// source's snapshot or a read-only non-recursive bind of the live path
// (also the mounts and subvolumes below a source that Discover added as
// Nested sources), the noauto entries read-only, /proc, /sys, /dev and /run read-only, the
// cache and temporary folders writable, and the restic binary.
func TreeMounts(plan Plan, f Facts, created []Created, o TreeOptions) []Mount {
	root := SnapTreeDir
	at := func(p string) string { return path.Join(root, p) }
	byLV := map[string]Created{}
	bySub := map[string]Created{}
	for _, c := range created {
		switch c.Method {
		case MethodLVM:
			byLV[c.VG+"/"+c.Origin] = c
		case MethodBtrfs:
			bySub[c.BtrfsUUID+"/"+itoa(c.SubvolID)] = c
		}
	}
	snapMount := func(s Source, target string) (Mount, bool) {
		switch {
		case s.FSType == "btrfs":
			if c, ok := bySub[s.BtrfsUUID+"/"+itoa(s.SubvolID)]; ok {
				return Mount{Target: at(target), Source: c.Device, FSType: "btrfs", Options: "ro,subvol=" + c.SnapPath}, true
			}
		case s.Kind == "lv":
			if c, ok := byLV[s.VG+"/"+s.LV]; ok {
				return Mount{Target: at(target), Source: "/dev/" + c.VG + "/" + c.LV, FSType: s.FSType, Options: snapOptions(s.FSType)}, true
			}
		}
		return Mount{}, false
	}
	var out []Mount
	out = append(out, Mount{Target: root, Source: "tmpfs", FSType: "tmpfs", Options: "mode=0755"})
	rootSrc := f.Root
	if m, ok := snapMount(rootSrc, "/"); ok {
		out = append(out, m)
	} else {
		out = append(out, Mount{Target: root, Source: "/", Bind: true, Options: "ro"})
	}
	var rest []Mount
	seen := map[string]bool{"/": true}
	for _, ps := range plan.Sources {
		s := ps.Source
		target := s.MountTarget
		if s.FSType == "btrfs" && s.SubvolTarget != "" {
			target = s.SubvolTarget
		}
		if target == "" || seen[target] {
			continue
		}
		// A source on the root file system (or the root subvolume) is in
		// the root mount already.
		if s.Noauto {
			seen[target] = true
			rest = append(rest, Mount{Target: at(target), Source: s.Device, FSType: s.FSType, Options: noautoOptions(s.FSType)})
			continue
		}
		if sameFS(s, rootSrc) && target == rootTarget(rootSrc) {
			continue
		}
		seen[target] = true
		if m, ok := snapMount(s, target); ok {
			rest = append(rest, m)
			continue
		}
		rest = append(rest, Mount{Target: at(target), Source: target, Bind: true, Options: "ro"})
	}
	// A btrfs subvolume below the mount point of its file system needs that
	// mount in the tree first (its folder is not on the root file system):
	// a read-only bind of the live mount, only for the folders on the way.
	for _, ps := range plan.Sources {
		s := ps.Source
		if s.FSType != "btrfs" || s.Noauto || s.MountTarget == "" || s.SubvolTarget == "" || s.SubvolTarget == s.MountTarget || seen[s.MountTarget] {
			continue
		}
		seen[s.MountTarget] = true
		rest = append(rest, Mount{Target: at(s.MountTarget), Source: s.MountTarget, Bind: true, Options: "ro"})
	}
	for _, p := range runtimeDirs {
		rest = append(rest, Mount{Target: at(p), Source: p, Bind: true, Options: "ro"})
	}
	for _, p := range []string{o.CacheDir, o.TmpDir} {
		if p != "" {
			rest = append(rest, Mount{Target: at(p), Source: p, Bind: true, Options: "rw"})
		}
	}
	if o.ResticBin != "" {
		rest = append(rest, Mount{Target: at(o.ResticBin), Source: o.ResticBin, Bind: true, Options: "ro"})
	}
	sort.SliceStable(rest, func(i, j int) bool { return depth(rest[i].Target) < depth(rest[j].Target) })
	return append(out, rest...)
}

func sameFS(a, b Source) bool {
	if a.FSType == "btrfs" && b.FSType == "btrfs" {
		return a.BtrfsUUID == b.BtrfsUUID && a.SubvolID == b.SubvolID
	}
	return a.MountTarget == b.MountTarget
}

func rootTarget(s Source) string {
	if s.FSType == "btrfs" && s.SubvolTarget != "" {
		return s.SubvolTarget
	}
	return s.MountTarget
}

// TreeSpec is the spec of the tree.
func TreeSpec(plan Plan, f Facts, created []Created, o TreeOptions) Spec {
	return Spec{Kind: SpecTree, Root: SnapTreeDir, Mounts: TreeMounts(plan, f, created, o),
		Binds: Binds{Cache: o.CacheDir, Tmp: o.TmpDir, Restic: o.ResticBin}}
}

// LiveSpec is the tree without any snapshot: every source and the root
// as read-only binds, used for whole-machine backups with fsSnapshot off
// or after a failure (R13: the helper always runs for noauto mounts).
func LiveSpec(f Facts, o TreeOptions) Spec {
	plan := Plan{}
	for _, s := range f.Sources {
		plan.Sources = append(plan.Sources, PlannedSource{Source: s, Method: MethodLive})
	}
	return TreeSpec(plan, f, nil, o)
}

func itoa(n int64) string { return strconv.FormatInt(n, 10) }

func sortStrings(s []string) { sort.Strings(s) }
