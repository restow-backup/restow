package fssnap

import (
	"path"
	"strconv"
)

// SnapLVName is the name of the snapshot LV of an LV.
func SnapLVName(lv string) string { return lv + SnapshotSuffix }

// LVCreateThick is `lvcreate -s -L <cow>b -n <lv>_restowsnap --addtag
// restow-agent-snapshot <vg>/<lv>`.
func LVCreateThick(vg, lv string, cow int64) []string {
	return []string{"lvcreate", "-s", "-L", strconv.FormatInt(cow, 10) + "b", "-n", SnapLVName(lv), "--addtag", SnapshotTag, vg + "/" + lv}
}

// LVCreateThin is the thin snapshot (no size: it lives in the pool).
func LVCreateThin(vg, lv string) []string {
	return []string{"lvcreate", "-s", "-n", SnapLVName(lv), "--addtag", SnapshotTag, vg + "/" + lv}
}

// LVActivate activates a thin snapshot (they are created with the
// activation skip flag).
func LVActivate(vg, snap string) []string {
	return []string{"lvchange", "-ay", "-K", vg + "/" + snap}
}

// LVRemove removes a snapshot LV.
func LVRemove(vg, snap string) []string { return []string{"lvremove", "-y", vg + "/" + snap} }

// LVSMonitor reads what the monitor needs.
func LVSMonitor() []string {
	return []string{"lvs", "--reportformat", "json", "-o", "lv_name,vg_name,lv_attr,data_percent,metadata_percent,snap_percent,lv_tags"}
}

// LVSOne reads one LV with its tags (after a failed lvcreate: did it
// leave the snapshot behind?).
func LVSOne(vg, lv string) []string {
	return []string{"lvs", "--reportformat", "json", "-o", "lv_name,vg_name,lv_tags", vg + "/" + lv}
}

// LVSOwned lists LVs with their tags for the stale cleanup.
func LVSOwned() []string {
	return []string{"lvs", "--reportformat", "json", "-o", "lv_name,vg_name,lv_tags,lv_time"}
}

// BtrfsTop is the top level of a btrfs file system inside the helper.
func BtrfsTop(uuid string) string { return path.Join(BtrfsTopDir, uuid) }

// BtrfsRunDir is the folder of one run's snapshots below the top level.
func BtrfsRunDir(uuid, runID string) string { return path.Join(BtrfsTop(uuid), SnapDirName, runID) }

// BtrfsSnapRel is a snapshot's path relative to the top level.
func BtrfsSnapRel(runID string, subvolID int64) string {
	return path.Join(SnapDirName, runID, strconv.FormatInt(subvolID, 10))
}

// BtrfsSnapshot is `btrfs subvolume snapshot -r <top>/<subvol>
// <top>/.restow-snapshots/<run>/<id>`.
func BtrfsSnapshot(uuid, subvolPath, runID string, subvolID int64) []string {
	return []string{"btrfs", "subvolume", "snapshot", "-r", path.Join(BtrfsTop(uuid), subvolPath), path.Join(BtrfsTop(uuid), BtrfsSnapRel(runID, subvolID))}
}

// BtrfsDelete removes a snapshot subvolume.
func BtrfsDelete(uuid, rel string) []string {
	return []string{"btrfs", "subvolume", "delete", path.Join(BtrfsTop(uuid), rel)}
}

// BtrfsList lists all subvolumes of a mounted btrfs.
func BtrfsList(mount string) []string { return []string{"btrfs", "subvolume", "list", "-a", mount} }

// topMount mounts the top level (subvolid=5) of a btrfs inside the helper.
func topMount(uuid, device string) Mount {
	return Mount{Target: BtrfsTop(uuid), Source: device, FSType: "btrfs", Options: "subvolid=5"}
}

// plainSpec is the helper spec for a btrfs command: the top levels mounted
// in a private namespace (R11: nothing is mounted on the host).
func plainSpec(tops map[string]string, mkdirs ...string) Spec {
	s := Spec{Kind: SpecPlain, Mounts: []Mount{{Target: BtrfsTopDir, Source: "tmpfs", FSType: "tmpfs", Options: "mode=0700"}}}
	keys := make([]string, 0, len(tops))
	for k := range tops {
		keys = append(keys, k)
	}
	sortStrings(keys)
	for _, uuid := range keys {
		s.Mounts = append(s.Mounts, topMount(uuid, tops[uuid]))
		s.BtrfsTops = append(s.BtrfsTops, BtrfsTopRef{UUID: uuid, Device: tops[uuid]})
	}
	s.Mkdirs = mkdirs
	return s
}
