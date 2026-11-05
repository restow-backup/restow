// Package fssnap takes file system snapshots for a Linux backup
// (docs/BAREMETAL.md, section 6): LVM snapshots (thick and thin) and btrfs
// read-only snapshots per subvolume, never at the expense of the running
// system (COW limits, thin pool thresholds, monitoring), and the snapshot
// tree that restic reads in a private mount namespace under the real paths
// (6.3). Discovery, planning, the command lines and the tree layout are
// pure and tested on every system; only the namespace helper uses Linux
// system calls.
package fssnap

import "errors"

// Method is how a source is read.
type Method string

// Methods.
const (
	MethodLVM   Method = "lvm"
	MethodBtrfs Method = "btrfs"
	MethodLive  Method = "live"
)

// Live reasons (the manifest's backup.liveReasons, contract C1).
const (
	ReasonOff           = "off"
	ReasonPartition     = "partition"
	ReasonMD            = "md"
	ReasonVFAT          = "vfat"
	ReasonLUKSOnLV      = "luks_on_lv"
	ReasonVGNoSpace     = "vg_no_space"
	ReasonThinPoolBusy  = "thin_pool_busy"
	ReasonUnsupportedFS = "unsupported_fs"
	ReasonNoHelper      = "no_helper"
)

// Names and markers of the agent's snapshots: an LV is removed only with
// both the tag and the suffix, a btrfs subvolume only below SnapDirName.
const (
	SnapshotTag    = "restow-agent-snapshot"
	SnapshotSuffix = "_restowsnap"
	SnapDirName    = ".restow-snapshots"
)

// Paths of the helper (paths.SnapTreeDir, paths.BtrfsTopDir).
const (
	SnapTreeDir = "/run/restow-agent/snaptree"
	BtrfsTopDir = "/run/restow-agent/btrfs"
)

// Errors that stop restic while the snapshot is in danger (6.2).
var (
	ErrThinPoolPressure = errors.New("the thin pool of a snapshot is more than 90 percent full")
	ErrSnapshotOverflow = errors.New("an LVM snapshot is more than 95 percent full or became invalid")
)

// Source is a path to back up and the file system that holds it.
type Source struct {
	// Path is the source path (a mount point, a subvolume path or a folder).
	Path string
	// MountTarget is the mount point of the file system that holds Path.
	MountTarget string
	FSType      string
	// Device is the device node of the file system.
	Device string
	// Kind is what the device is: lv, partition, md, disk, crypt, other.
	Kind   string
	VG, LV string
	Thin   bool
	Pool   string
	// LUKSOnLV: the file system is on a LUKS mapping of an LV (6.6).
	LUKSOnLV bool
	// btrfs: the file system, the subvolume that holds Path (relative to the
	// top level) and its id.
	BtrfsUUID  string
	SubvolPath string
	SubvolID   int64
	// SubvolTarget is where that subvolume appears in the tree (Path for a
	// subvolume source, its mount point for a mounted one).
	SubvolTarget string
	// Noauto: an fstab entry with noauto the helper mounts read-only.
	Noauto  bool
	Options string
	// Nested: a mount or btrfs subvolume below a source of a backup without
	// wholeMachine (restic runs without -x and reads it). It is not a
	// backup path itself; it is in the tree so its content is there.
	Nested bool
	// NoSnapshot: read live, never snapshotted (the read-only snapshots of
	// snapper or Timeshift below a source).
	NoSnapshot bool
}

// VG is a volume group as the snapshot planner sees it.
type VG struct {
	Name                         string
	SizeBytes, FreeBytes, Extent int64
}

// LV is a logical volume.
type LV struct {
	VG, Name     string
	SizeBytes    int64
	Thin         bool
	Pool         string
	DataPercent  float64
	MetaPercent  float64
	Major, Minor int
}

// BtrfsFS is a mounted btrfs file system.
type BtrfsFS struct {
	UUID   string
	Device string
	// Mount is a mount point of it (any subvolume).
	Mount     string
	SizeBytes int64
	FreeBytes int64
}

// Facts are what Discover found.
type Facts struct {
	// Sources in the order given; Root is the root file system, which the
	// tree always contains (R12).
	Sources []Source
	Root    Source
	VGs     map[string]VG
	LVs     map[string]LV // "vg/lv"
	// Pools are the thin pools by "vg/pool".
	Pools map[string]LV
	Btrfs map[string]BtrfsFS // by UUID
	// Unavailable is set when snapshots are wanted but the tools are missing.
	Unavailable string
	Notes       []string
}

// PlannedSource is a source with the planned method.
type PlannedSource struct {
	Source
	Method     Method
	LiveReason string
	// CowBytes is the COW size of a thick LVM snapshot.
	CowBytes int64
	// PreFail is set when a snapshot method exists but cannot be used now
	// (btrfs with too little free space): snapshot_failed.
	PreFail string
}

// Plan is the snapshot plan of one backup.
type Plan struct {
	Sources []PlannedSource
	// Method is lvm, btrfs, mixed or "" (no snapshot planned).
	Method string
	// Requested: fsSnapshot is auto.
	Requested bool
	// Unavailable: snapshots were wanted but none can be taken at all.
	Unavailable string
	Notes       []string
}

// Failure is a snapshot that failed or could not be removed.
type Failure struct {
	Path    string
	Message string
}

// Outcome is what Create (and the run) did.
type Outcome struct {
	// Snapshotted are the source paths read from a snapshot.
	Snapshotted []string
	// Failed are the source paths whose snapshot failed (read live).
	Failed []Failure
	// Live are the source paths read live without a failure (no method).
	Live          []string
	CleanupFailed []Failure
	Notes         []string
	// Unavailable is set when no snapshot could be taken at all (tools
	// missing, no rights, kernel without dm_snapshot).
	Unavailable string
}

// Created is a snapshot that exists and must be removed.
type Created struct {
	Method Method
	// LVM: the snapshot LV and the origin.
	VG, LV, Origin string
	Thin           bool
	Pool           string
	// btrfs: the snapshot's path below the top level, the file system.
	BtrfsUUID, Device, SnapPath string
	SubvolID                    int64
	// Sources are the source paths it serves.
	Sources []string
	FSType  string
}
