package baremetal

import (
	"math/bits"
	"sort"
	"strconv"
	"strings"
)

// Sizes (docs/BAREMETAL.md 10.9). All arithmetic is in bytes; values are
// converted to logical blocks of the target only when the sfdisk script is
// written.

const (
	mib = int64(1) << 20
	gib = int64(1) << 30

	espMin4Kn       = 260 * mib
	fat32Floor      = 32 * mib
	extFloor        = 32 * mib
	xfsFloor        = 300 * mib
	btrfsFloorPerDv = 128 * mib
	btrfsMetaPerDev = gib
	luks2Header     = 16 * mib
	luks1Header     = 4 * mib
	pvOverhead      = mib
	thinPoolFloor   = 64 * mib
)

// Well-known partition types.
const (
	gptESP      = "c12a7328-f81f-11d2-ba4b-00a0c93ec93b"
	gptBIOSBoot = "21686148-6449-6e6f-744e-656564454649"
	gptSwap     = "0657fd6d-a4ab-43c4-84e5-0933c84b4f4f"
)

// MinimumSizes is the minimum per disk, file system, LV and thin pool.
type MinimumSizes struct {
	Disks       []DiskMinimum `json:"disks"`
	Filesystems []FSMinimum   `json:"filesystems"`
	LVs         []LVMinimum   `json:"lvs"`
	ThinPools   []LVMinimum   `json:"thinPools"`
}

// DiskMinimum is the smallest target disk for a source disk.
type DiskMinimum struct {
	Disk      string `json:"disk"`
	KName     string `json:"kname"`
	SizeBytes int64  `json:"sizeBytes"`
	MinBytes  int64  `json:"minBytes"`
}

// FSMinimum is the smallest size of a file system and what a restore
// writes into it.
type FSMinimum struct {
	FS           string  `json:"fs"`
	Mount        *string `json:"mount"`
	Type         string  `json:"type"`
	RestoreBytes int64   `json:"restoreBytes"`
	MinBytes     int64   `json:"minBytes"`
}

// LVMinimum is the smallest size of an LV or thin pool.
type LVMinimum struct {
	VG       string `json:"vg"`
	LV       string `json:"lv"`
	MinBytes int64  `json:"minBytes"`
}

func alignUp(n, a int64) int64 {
	if a <= 0 {
		return n
	}
	if r := n % a; r != 0 {
		return n + a - r
	}
	return n
}

func alignDown(n, a int64) int64 {
	if a <= 0 {
		return n
	}
	return n - n%a
}

// mulDivUp returns ceil(n*num/den) for non-negative values, computed in
// 128 bits (sizes times sizes overflow 64 bits); a result beyond 2^53 is
// capped there.
func mulDivUp(n, num, den int64) int64 { return mulDivRound(n, num, den, true) }

// mulDiv returns floor(n*num/den).
func mulDiv(n, num, den int64) int64 { return mulDivRound(n, num, den, false) }

func mulDivRound(n, num, den int64, up bool) int64 {
	if den <= 0 || n <= 0 || num <= 0 {
		if den <= 0 {
			return n
		}
		return 0
	}
	hi, lo := bits.Mul64(uint64(n), uint64(num))
	if hi >= uint64(den) {
		return maxSafeInteger
	}
	q, r := bits.Div64(hi, lo, uint64(den))
	if up && r != 0 {
		q++
	}
	if q > maxSafeInteger {
		return maxSafeInteger
	}
	return int64(q)
}

// contentKind is what sits on a block device.
type contentKind int

const (
	contentNone contentKind = iota
	contentFS
	contentBtrfs
	contentSwap
	contentLUKS
	contentPlain
	contentPV
	contentMD
)

// layoutModel indexes a Linux layout for the planner.
type layoutModel struct {
	m       *Manifest
	l       *LinuxLayout
	f       *Facts
	rawLVs  string
	disks   map[string]*Disk
	parts   map[string]*Partition
	partOf  map[string]string // partition key -> disk id
	md      map[string]*MDArray
	luks    map[string]*LUKSVolume
	plain   map[string]*PlainCrypt
	vgs     map[string]*VolumeGroup
	lvs     map[string]*LogicalVolume // vg/lv
	pvs     map[string]*PV            // device key -> PV
	vgPVs   map[string][]*PV
	fs      map[string]*Filesystem
	fsOn    map[string]*Filesystem // device key -> file system
	swapOn  map[string]*Swap
	mdOn    map[string]*MDArray
	luksOn  map[string]*LUKSVolume
	plainOn map[string]*PlainCrypt
	esps    map[string]bool
	mounts  map[string][]string // fs id -> mount targets (mounts, then fstab), without bind mounts
	binds   map[string][]string // fs id -> bind mount targets whose folder the file system holds
	swapIn  map[string]int64    // fs id -> bytes of the swap files recover creates on it
	restore map[string]int64    // fs id -> restore bytes
	inodes  map[string]int64    // fs id -> inodes from the facts
	est     map[string]bool     // fs id -> restore size estimated

	minMemo  map[string]int64
	findings []Finding
}

func newLayoutModel(m *Manifest, f *Facts, rawLVs string) *layoutModel {
	l := m.Linux
	x := &layoutModel{m: m, l: l, f: f, rawLVs: rawLVs,
		disks: map[string]*Disk{}, parts: map[string]*Partition{}, partOf: map[string]string{},
		md: map[string]*MDArray{}, luks: map[string]*LUKSVolume{}, plain: map[string]*PlainCrypt{},
		vgs: map[string]*VolumeGroup{}, lvs: map[string]*LogicalVolume{}, pvs: map[string]*PV{}, vgPVs: map[string][]*PV{},
		fs: map[string]*Filesystem{}, fsOn: map[string]*Filesystem{}, swapOn: map[string]*Swap{},
		mdOn: map[string]*MDArray{}, luksOn: map[string]*LUKSVolume{}, plainOn: map[string]*PlainCrypt{},
		esps: map[string]bool{}, mounts: map[string][]string{}, binds: map[string][]string{}, swapIn: map[string]int64{},
		restore: map[string]int64{}, inodes: map[string]int64{},
		est: map[string]bool{}, minMemo: map[string]int64{}}
	for i := range l.Disks {
		d := &l.Disks[i]
		x.disks[d.ID] = d
		if d.Table != nil {
			for j := range d.Table.Partitions {
				p := &d.Table.Partitions[j]
				k := PartRef(d.ID, p.Number).key()
				x.parts[k] = p
				x.partOf[k] = d.ID
			}
		}
	}
	for i := range l.MD {
		md := &l.MD[i]
		x.md[md.ID] = md
		for _, mem := range md.Members {
			x.mdOn[mem.Device.key()] = md
		}
		for _, s := range md.Spares {
			x.mdOn[s.key()] = md
		}
	}
	for i := range l.LUKS {
		c := &l.LUKS[i]
		x.luks[c.ID] = c
		x.luksOn[c.Device.key()] = c
	}
	for i := range l.PlainCrypt {
		c := &l.PlainCrypt[i]
		x.plain[c.ID] = c
		x.plainOn[c.Device.key()] = c
	}
	for i := range l.LVM.VGs {
		vg := &l.LVM.VGs[i]
		x.vgs[vg.Name] = vg
		for j := range vg.LVs {
			x.lvs[vg.Name+"/"+vg.LVs[j].Name] = &vg.LVs[j]
		}
	}
	for i := range l.LVM.PVs {
		pv := &l.LVM.PVs[i]
		x.pvs[pv.Device.key()] = pv
		if pv.VG != nil {
			x.vgPVs[*pv.VG] = append(x.vgPVs[*pv.VG], pv)
		}
	}
	for i := range l.Filesystems {
		fs := &l.Filesystems[i]
		x.fs[fs.ID] = fs
		for _, d := range fs.Devices {
			x.fsOn[d.key()] = fs
		}
	}
	for i := range l.Swap {
		s := &l.Swap[i]
		if s.Device != nil && s.Kind != "file" {
			x.swapOn[s.Device.key()] = s
		}
	}
	for _, e := range l.Bootloader.ESPs {
		x.esps[e] = true
	}
	// A bind mount shows a folder of a file system a second time (mount
	// --bind /srv/data /var/www/data). It is no mount of the file system:
	// mounted there, the whole file system would lie at the target and the
	// restore would write the files of that path into its root. The mount
	// says so itself (Mount.Root); for a manifest without it the bind
	// option of the fstab line decides.
	fstabBind := map[string]bool{}
	for _, e := range l.Fstab {
		if hasOption(e.Options, "bind") || hasOption(e.Options, "rbind") {
			fstabBind[e.Target] = true
		}
	}
	seen := map[string]bool{}
	var bindTargets []string
	for i := range l.Mounts {
		mo := &l.Mounts[i]
		if mo.FS == nil || mo.Autofs || mo.Type == "autofs" || seen[mo.Target] {
			continue
		}
		if mo.IsBind() || fstabBind[mo.Target] {
			bindTargets = append(bindTargets, mo.Target)
			continue
		}
		seen[mo.Target] = true
		x.mounts[*mo.FS] = append(x.mounts[*mo.FS], mo.Target)
	}
	for _, e := range l.Fstab {
		if e.Resolved != nil && e.Resolved.FS != nil && strings.HasPrefix(e.Target, "/") && !seen[e.Target] {
			seen[e.Target] = true
			x.mounts[*e.Resolved.FS] = append(x.mounts[*e.Resolved.FS], e.Target)
		}
	}
	// What the snapshot holds below a bind target is restored into the
	// file system that holds the folder there.
	for _, t := range uniqueSorted(bindTargets) {
		if seen[t] {
			continue
		}
		if id := x.fsHolding(t); id != "" {
			x.binds[id] = append(x.binds[id], t)
		}
	}
	// Swap files are not in the backup; recover creates them after the
	// restore (the swapfile step), so their file system needs the room.
	for i := range l.Swap {
		s := &l.Swap[i]
		if s.Kind != "file" || s.Path == nil || s.SizeBytes <= 0 {
			continue
		}
		id := x.fsHolding(*s.Path)
		if id == "" && s.FS != nil {
			id = *s.FS
		}
		if id != "" {
			// One MiB for the header page and the rounding of the extents.
			x.swapIn[id] += s.SizeBytes + mib
		}
	}
	x.restoreSizes()
	return x
}

// fsHolding is the file system whose mount holds path p after the restore
// (the longest mount target that is p or above it), or "".
func (x *layoutModel) fsHolding(p string) string {
	best, bestLen := "", -1
	for id, targets := range x.mounts {
		for _, t := range targets {
			if under(p, t) && (len(t) > bestLen || len(t) == bestLen && id < best) {
				best, bestLen = id, len(t)
			}
		}
	}
	return best
}

// restoreSizes fills restore and inodes per file system: the sum over its
// mount targets in the facts; without facts (or without an entry) the
// space in use, with restore_size_estimated.
func (x *layoutModel) restoreSizes() {
	if x.f == nil {
		x.findings = append(x.findings, newFinding(WarnRestoreSizeEstimated, "", "object", "all file systems"))
	}
	for _, fs := range x.l.Filesystems {
		// The space in use counts the swap files, which the restore does
		// not write (fsMinimum adds them).
		used := max(fs.UsedBytes-x.swapIn[fs.ID], 0)
		if x.f == nil {
			x.restore[fs.ID] = used
			x.est[fs.ID] = true
			continue
		}
		var sum, inodes int64
		found := false
		for _, t := range append(append([]string{}, x.mounts[fs.ID]...), x.binds[fs.ID]...) {
			if s, ok := x.f.RestoreSizes[t]; ok {
				found = true
				sum += s.Bytes
				inodes += s.Inodes
			}
		}
		if !found && len(x.mounts[fs.ID]) > 0 && recreatable(fs.Type) {
			x.restore[fs.ID] = used
			x.est[fs.ID] = true
			x.findings = append(x.findings, newFinding(WarnRestoreSizeEstimated, fs.ID, "object", fs.ID))
			continue
		}
		x.restore[fs.ID] = sum
		x.inodes[fs.ID] = inodes
	}
}

// primaryMount is the first mount target of a file system, or "".
func (x *layoutModel) primaryMount(fsID string) string {
	if t := x.mounts[fsID]; len(t) > 0 {
		return t[0]
	}
	return ""
}

func recreatable(fstype string) bool {
	switch fstype {
	case "ext2", "ext3", "ext4", "xfs", "btrfs", "vfat", "swap":
		return true
	}
	return false
}

// fsKeepsSize: ESPs, /boot and file systems the planner does not recreate
// keep their size.
func (x *layoutModel) fsKeepsSize(fs *Filesystem) bool {
	if x.esps[fs.ID] || fs.Type == "vfat" || !recreatable(fs.Type) {
		return true
	}
	for _, t := range x.mounts[fs.ID] {
		if t == "/boot" {
			return true
		}
	}
	return false
}

// btrfsCopies returns the data copies of a btrfs profile on n devices as a
// fraction num/den.
func btrfsCopies(profile string, n int64) (int64, int64) {
	switch strings.ToLower(profile) {
	case "dup", "raid1", "raid10":
		return 2, 1
	case "raid1c3":
		return 3, 1
	case "raid1c4":
		return 4, 1
	case "raid5":
		if n > 1 {
			return n, n - 1
		}
	case "raid6":
		if n > 2 {
			return n, n - 2
		}
	}
	return 1, 1
}

// fsMinimum is the smallest size of a file system (per device for btrfs).
func (x *layoutModel) fsMinimum(fs *Filesystem) int64 {
	if x.fsKeepsSize(fs) {
		size := fs.SizeBytes
		if fs.Type == "vfat" && size < fat32Floor && (fs.VFAT == nil || fs.VFAT.FatBits == 32) {
			size = fat32Floor
		}
		return size
	}
	base := mulDivUp(x.restore[fs.ID], 110, 100) + x.swapIn[fs.ID]
	switch fs.Type {
	case "ext2", "ext3", "ext4":
		var journal, reserved int64
		if fs.Ext != nil {
			if fs.Ext.JournalBytes != nil {
				journal = *fs.Ext.JournalBytes
			}
			reserved = fs.Ext.ReservedPercent
		}
		if reserved > 50 {
			reserved = 50
		}
		return max(mulDivUp(base+journal, 100, 100-2-reserved), extFloor)
	case "xfs":
		var log int64
		if fs.XFS != nil {
			log = fs.XFS.LogBytes
		}
		return max(mulDivUp(base+log, 100, 99), xfsFloor)
	case "btrfs":
		n := int64(len(fs.Devices))
		if n < 1 {
			n = 1
		}
		num, den := int64(1), int64(1)
		if fs.Btrfs != nil {
			num, den = btrfsCopies(fs.Btrfs.DataProfile, n)
		}
		per := mulDivUp(base, num, den*n) + btrfsMetaPerDev
		return max(per, btrfsFloorPerDv)
	}
	return fs.SizeBytes
}

// sizeOf is the recorded size of a block device.
func (x *layoutModel) sizeOf(key string, r BlockRef) int64 {
	switch r.Kind {
	case RefDisk:
		if d := x.disks[r.Disk]; d != nil {
			return d.SizeBytes
		}
	case RefPartition:
		if p := x.parts[key]; p != nil {
			return p.SizeBytes
		}
	case RefMD:
		if md := x.md[r.ID]; md != nil {
			return md.SizeBytes
		}
	case RefLUKS:
		if c := x.luks[r.ID]; c != nil {
			return x.sizeOf(c.Device.key(), c.Device) - luksHeaderBytes(c)
		}
	case RefPlain:
		if c := x.plain[r.ID]; c != nil {
			return x.sizeOf(c.Device.key(), c.Device)
		}
	case RefLV:
		if lv := x.lvs[r.VG+"/"+r.LV]; lv != nil {
			if lv.VirtualBytes != nil && lv.Type == "thin" {
				return *lv.VirtualBytes
			}
			return lv.SizeBytes
		}
	}
	return 0
}

func luksHeaderBytes(c *LUKSVolume) int64 {
	if c.Version == 1 {
		return luks1Header
	}
	return luks2Header
}

// mdOverhead is the space md metadata takes on each member.
func mdOverhead(md *MDArray) int64 {
	switch md.Metadata {
	case "0.90", "0.9", "1.0", "1":
		return mib
	}
	return 128 * mib
}

// mdFactor is the data capacity of an array per member as a fraction
// num/den of the member size: raid1 1, raid0 n, raid5 n-1, raid6 n-2,
// raid10 n/copies.
func mdFactor(md *MDArray) (int64, int64) {
	n := md.RaidDevices
	if n < 1 {
		n = 1
	}
	switch strings.TrimPrefix(strings.ToLower(md.Level), "raid") {
	case "0", "linear":
		return n, 1
	case "4", "5":
		if n > 1 {
			return n - 1, 1
		}
	case "6":
		if n > 2 {
			return n - 2, 1
		}
	case "10":
		return n, raid10Copies(md)
	}
	return 1, 1
}

// raid10Copies reads the copies from a layout such as "near=2" or "n2".
func raid10Copies(md *MDArray) int64 {
	l := strings.ToLower(deref(md.Layout))
	for _, sep := range []string{"=", ""} {
		for _, p := range []string{"near", "far", "offset", "n", "f", "o"} {
			if v, ok := strings.CutPrefix(l, p+sep); ok && len(v) == 1 && v[0] >= '2' && v[0] <= '9' {
				return int64(v[0] - '0')
			}
		}
	}
	return 2
}

// vgLVMinimum is the minimum of one LV of a VG (0 when it is not created),
// rounded up to the extent size.
func (x *layoutModel) lvMinimum(vg *VolumeGroup, lv *LogicalVolume) int64 {
	k := "lvmin|" + vg.Name + "/" + lv.Name
	if v, ok := x.minMemo[k]; ok {
		return v
	}
	var n int64
	switch {
	case !x.lvCreated(vg, lv):
		n = 0
	case lv.Type == "thin-pool":
		var data int64
		for i := range vg.LVs {
			t := &vg.LVs[i]
			if t.Type == "thin" && deref(t.Pool) == lv.Name && x.lvCreated(vg, t) && !t.Raw {
				if fs := x.fsOn[LVRef(vg.Name, t.Name).key()]; fs != nil {
					data += mulDivUp(x.restore[fs.ID], 115, 100)
				}
			}
		}
		meta := data / 100
		if lv.MetadataBytes != nil && *lv.MetadataBytes > meta {
			meta = *lv.MetadataBytes
		}
		n = max(data+meta, thinPoolFloor)
	case lv.Raw:
		n = lv.SizeBytes
	default:
		ref := LVRef(vg.Name, lv.Name)
		n = x.nodeMinimum(ref.key(), ref)
	}
	align := max(vg.ExtentBytes, 1)
	if g, ok := lvmRaidOf(lv); ok {
		// LVM rounds a RAID LV to whole extents per data stripe.
		align *= g.data
	}
	n = alignUp(n, align)
	x.minMemo[k] = n
	return n
}

// lvCreated: snapshots are not recreated, raw LVs only with rawLvs create.
func (x *layoutModel) lvCreated(vg *VolumeGroup, lv *LogicalVolume) bool {
	if lv.Origin != nil || lv.Type == "snapshot" {
		return false
	}
	if lv.Raw {
		return x.rawLVs == "create"
	}
	return true
}

// lvPhysical: LVs that take space in the VG (thin LVs live in their pool).
func lvPhysical(lv *LogicalVolume) bool { return lv.Type != "thin" }

// vgMinimum is the sum of the space the LVs that take space need at their
// minimum (a RAID LV: all its images, lvmraid.go).
func (x *layoutModel) vgMinimum(vg *VolumeGroup) int64 {
	var sum int64
	ext := max(vg.ExtentBytes, 1)
	for i := range vg.LVs {
		lv := &vg.LVs[i]
		if lvPhysical(lv) && x.lvCreated(vg, lv) {
			sum += lvFootprint(lv, x.lvMinimum(vg, lv), ext)
		}
	}
	return sum
}

// pvShare is the part of the VG's minimum a PV must hold: proportional to
// its recorded size, and at least the RAID images placed on it. This is an
// approximation: LVM may place linear LVs unevenly, so the plan verifies
// the total of the VG and the placement of the RAID images again after
// placing.
func (x *layoutModel) pvShare(pv *PV) int64 {
	vg := x.vgs[deref(pv.VG)]
	if vg == nil {
		return 0
	}
	ext := max(vg.ExtentBytes, 1)
	need := x.vgMinimum(vg)
	var total int64
	pvs := x.vgPVs[vg.Name]
	for _, p := range pvs {
		total += p.SizeBytes
	}
	if len(pvs) == 1 || total <= 0 {
		return alignUp(need, ext)
	}
	share := alignUp(mulDivUp(need, pv.SizeBytes, total), ext)
	if x.vgHasRaid(vg) {
		load := x.raidMinimumLoad(vg)
		for i, p := range pvs {
			if p == pv && i < len(load) {
				share = max(share, alignUp(load[i], ext))
			}
		}
	}
	return share
}

// pvSlack is the space the source PV had beyond the estimate (device
// less 1 MiB, in whole extents): metadata areas larger than 1 MiB.
func (x *layoutModel) pvSlack(pv *PV) int64 {
	vg := x.vgs[deref(pv.VG)]
	ext := int64(1)
	if vg != nil {
		ext = max(vg.ExtentBytes, 1)
	}
	src := alignDown(x.sizeOf(pv.Device.key(), pv.Device)-pvOverhead, ext)
	return max(src-pv.SizeBytes, 0)
}

// fixedNode: the device keeps its recorded size (ESP, /boot, swap, BIOS
// boot, plain dm-crypt, partitions of unknown or not recreated content).
func (x *layoutModel) fixedNode(key string, r BlockRef) bool {
	if r.Kind == RefPartition {
		if p := x.parts[key]; p != nil {
			t := strings.ToLower(p.Type)
			if t == gptBIOSBoot || t == gptESP || t == "ef" {
				return true
			}
		}
	}
	switch kind, _ := x.contentOf(key); kind {
	case contentFS:
		return x.fsKeepsSize(x.fsOn[key])
	case contentBtrfs:
		return false
	case contentSwap, contentPlain, contentNone:
		return true
	case contentLUKS:
		c := x.luksOn[key]
		r := LUKSRef(c.ID)
		return x.fixedNode(r.key(), r)
	case contentMD:
		md := x.mdOn[key]
		r := MDRef(md.ID)
		return x.fixedNode(r.key(), r)
	case contentPV:
		return false
	}
	return true
}

// contentOf says what sits on a device.
func (x *layoutModel) contentOf(key string) (contentKind, any) {
	if fs := x.fsOn[key]; fs != nil {
		if fs.Type == "btrfs" && len(fs.Devices) > 0 {
			return contentBtrfs, fs
		}
		return contentFS, fs
	}
	if s := x.swapOn[key]; s != nil {
		return contentSwap, s
	}
	if c := x.luksOn[key]; c != nil {
		return contentLUKS, c
	}
	if c := x.plainOn[key]; c != nil {
		return contentPlain, c
	}
	if pv := x.pvs[key]; pv != nil {
		return contentPV, pv
	}
	if md := x.mdOn[key]; md != nil {
		return contentMD, md
	}
	return contentNone, nil
}

// nodeMinimum is the smallest size of a block device that still holds
// what sits on it.
func (x *layoutModel) nodeMinimum(key string, r BlockRef) int64 {
	k := "node|" + key
	if v, ok := x.minMemo[k]; ok {
		return v
	}
	x.minMemo[k] = x.sizeOf(key, r) // guards against cycles (Validate rejects them)
	var n int64
	if x.fixedNode(key, r) {
		n = x.sizeOf(key, r)
		if kind, v := x.contentOf(key); kind == contentFS {
			n = max(n, x.fsMinimum(v.(*Filesystem)))
		}
	} else {
		kind, v := x.contentOf(key)
		switch kind {
		case contentFS, contentBtrfs:
			n = x.fsMinimum(v.(*Filesystem))
		case contentLUKS:
			c := v.(*LUKSVolume)
			cr := LUKSRef(c.ID)
			n = x.nodeMinimum(cr.key(), cr) + luksHeaderBytes(c)
		case contentPV:
			pv := v.(*PV)
			n = x.pvShare(pv) + pvOverhead + x.pvSlack(pv)
		case contentMD:
			md := v.(*MDArray)
			mr := MDRef(md.ID)
			num, den := mdFactor(md)
			n = mulDivUp(x.nodeMinimum(mr.key(), mr), den, num) + mdOverhead(md)
		default:
			n = x.sizeOf(key, r)
		}
	}
	x.minMemo[k] = n
	return n
}

// tableFindings checks that every partition table of the manifest can
// exist (10.10 point 3): the planner copies starts, sizes and numbers into
// an sfdisk script, and a table sfdisk refuses would fail only after the
// disks were wiped. Capture never records such a table; a damaged or
// altered manifest can. Each is a layout_unsupported problem.
func (x *layoutModel) tableFindings() []Finding {
	var out []Finding
	for i := range x.l.Disks {
		d := &x.l.Disks[i]
		if d.Table == nil {
			continue
		}
		if why := tableProblem(d); why != "" {
			out = append(out, newFinding(ProblemLayoutUnsupported, d.ID, "reason", "the partition table of "+d.ID+" cannot exist: "+why))
		}
	}
	return out
}

// tableProblem says why the partition table of d cannot be written, or "".
func tableProblem(d *Disk) string {
	t := d.Table
	sector := t.SectorSize
	if sector <= 0 {
		sector = d.LogicalSectorSize
	}
	if sector <= 0 {
		sector = 512
	}
	dos := t.Type == "dos"
	type span struct {
		n          int64
		start, end int64
	}
	var primary, logical []span
	var ext *span
	for i := range t.Partitions {
		p := &t.Partitions[i]
		name := "partition " + itoa(p.Number)
		switch {
		case p.SizeBytes <= 0:
			return name + " has no size"
		case p.StartBytes < sector:
			return name + " starts in the first sector"
		case p.StartBytes%sector != 0 || p.SizeBytes%sector != 0:
			return name + " is not on a sector boundary (" + itoa(sector) + " bytes)"
		case d.SizeBytes > 0 && p.StartBytes+p.SizeBytes > d.SizeBytes:
			return name + " ends behind the end of the disk"
		case !dos && p.Number > 128:
			return name + " is beyond the 128 entries of a GPT"
		case dos && (p.StartBytes/sector >= 1<<32 || p.SizeBytes/sector >= 1<<32):
			return name + " is beyond the 2^32 sectors an MBR can address"
		}
		sp := span{n: p.Number, start: p.StartBytes, end: p.StartBytes + p.SizeBytes}
		if dos && p.Number >= 5 {
			logical = append(logical, sp)
			continue
		}
		primary = append(primary, sp)
		if isExtended(t, p) {
			if ext != nil {
				return "it has more than one extended partition"
			}
			e := sp
			ext = &e
		}
	}
	overlap := func(list []span) string {
		sort.SliceStable(list, func(i, j int) bool { return list[i].start < list[j].start })
		for i := 1; i < len(list); i++ {
			if list[i].start < list[i-1].end {
				return "partitions " + itoa(list[i-1].n) + " and " + itoa(list[i].n) + " overlap"
			}
		}
		return ""
	}
	if why := overlap(primary); why != "" {
		return why
	}
	if len(logical) == 0 {
		return ""
	}
	if ext == nil {
		return "partition " + itoa(logical[0].n) + " is a logical partition, but the table has no extended partition"
	}
	// The kernel numbers logical partitions 5, 6, ... without gaps.
	nums := map[int64]bool{}
	for _, l := range logical {
		nums[l.n] = true
		if l.start <= ext.start || l.end > ext.end {
			return "the logical partition " + itoa(l.n) + " is not inside the extended partition " + itoa(ext.n)
		}
	}
	for n := int64(5); n < 5+int64(len(logical)); n++ {
		if !nums[n] {
			return "the logical partitions are not numbered from 5 without a gap"
		}
	}
	return overlap(logical)
}

// isExtended: a DOS extended partition.
func isExtended(t *PartitionTable, p *Partition) bool {
	if t == nil || t.Type != "dos" {
		return false
	}
	switch strings.ToLower(strings.TrimPrefix(p.Type, "0x")) {
	case "5", "05", "f", "0f", "85":
		return true
	}
	return false
}

// partitionMinimum is the minimum of a partition (an extended partition:
// its logical partitions, each with 1 MiB for its EBR and alignment).
func (x *layoutModel) partitionMinimum(d *Disk, p *Partition) int64 {
	if isExtended(d.Table, p) {
		var sum int64
		for i := range d.Table.Partitions {
			q := &d.Table.Partitions[i]
			if q.Number >= 5 {
				sum += mib + alignUp(x.partitionMinimum(d, q), mib)
			}
		}
		return max(sum, mib)
	}
	r := PartRef(d.ID, p.Number)
	return x.nodeMinimum(r.key(), r)
}

// diskMinimum is the smallest disk for d: 1 MiB at the head, every
// partition aligned to 1 MiB, 1 MiB at the tail for the GPT copy; a disk
// without a table needs what sits on it.
func (x *layoutModel) diskMinimum(d *Disk) int64 {
	if d.Table == nil {
		r := DiskRef(d.ID)
		return x.nodeMinimum(r.key(), r)
	}
	n := mib
	for i := range d.Table.Partitions {
		p := &d.Table.Partitions[i]
		if d.Table.Type == "dos" && p.Number >= 5 {
			continue
		}
		n += alignUp(x.partitionMinimum(d, p), mib)
	}
	if d.Table.Type == "gpt" {
		n += mib
	}
	return n
}

// MinimumDiskSizes returns the minimum sizes of a Linux layout: per disk,
// file system, LV and thin pool (10.9). Without facts the restore sizes are
// the space in use (restore_size_estimated).
func MinimumDiskSizes(m *Manifest, f *Facts) (MinimumSizes, []Finding) {
	return minimumSizes(m, f, "skip")
}

func minimumSizes(m *Manifest, f *Facts, rawLVs string) (MinimumSizes, []Finding) {
	out := MinimumSizes{Disks: []DiskMinimum{}, Filesystems: []FSMinimum{}, LVs: []LVMinimum{}, ThinPools: []LVMinimum{}}
	if m == nil || m.Linux == nil {
		return out, nil
	}
	x := newLayoutModel(m, f, rawLVs)
	x.fillMinimums(&out)
	return out, x.findings
}

func (x *layoutModel) fillMinimums(out *MinimumSizes) {
	for i := range x.l.Disks {
		d := &x.l.Disks[i]
		out.Disks = append(out.Disks, DiskMinimum{Disk: d.ID, KName: d.KName, SizeBytes: d.SizeBytes, MinBytes: x.diskMinimum(d)})
	}
	for i := range x.l.Filesystems {
		fs := &x.l.Filesystems[i]
		var mount *string
		if t := x.primaryMount(fs.ID); t != "" {
			mount = strPtr(t)
		}
		minB := x.fsMinimum(fs)
		if fs.Type == "btrfs" {
			minB *= max(int64(len(fs.Devices)), 1)
		}
		out.Filesystems = append(out.Filesystems, FSMinimum{FS: fs.ID, Mount: mount, Type: fs.Type, RestoreBytes: x.restore[fs.ID], MinBytes: minB})
	}
	for i := range x.l.LVM.VGs {
		vg := &x.l.LVM.VGs[i]
		for j := range vg.LVs {
			lv := &vg.LVs[j]
			if !x.lvCreated(vg, lv) {
				continue
			}
			e := LVMinimum{VG: vg.Name, LV: lv.Name, MinBytes: x.lvMinimum(vg, lv)}
			if lv.Type == "thin-pool" {
				out.ThinPools = append(out.ThinPools, e)
			} else {
				out.LVs = append(out.LVs, e)
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Placement on a target disk
// ---------------------------------------------------------------------------

// PlannedDisk is the layout of one target disk.
type PlannedDisk struct {
	Disk       string             `json:"disk"`
	Target     string             `json:"target"`
	SectorSize int64              `json:"sectorSize"`
	Table      *string            `json:"table"`
	Partitions []PlannedPartition `json:"partitions"`
	LVs        []PlannedLV        `json:"lvs"`
}

// PlannedPartition is one partition in bytes and in target sectors.
type PlannedPartition struct {
	Number     int64 `json:"number"`
	StartLBA   int64 `json:"startLba"`
	SizeLBA    int64 `json:"sizeLba"`
	StartBytes int64 `json:"startBytes"`
	SizeBytes  int64 `json:"sizeBytes"`
	Grown      bool  `json:"grown"`
	Shrunk     bool  `json:"shrunk"`
	Realigned  bool  `json:"realigned"`
}

// PlannedLV is the size of one LV on the target.
type PlannedLV struct {
	VG        string `json:"vg"`
	LV        string `json:"lv"`
	SizeBytes int64  `json:"sizeBytes"`
	Grown     bool   `json:"grown"`
	Shrunk    bool   `json:"shrunk"`
}

type placePart struct {
	p       *Partition
	min     int64
	desired int64
	fixed   bool
	grow    bool
	start   int64
	size    int64
	espGrow bool
}

// placeDisk lays out the partitions of source disk d on a target disk of
// size bytes with logical sector size sector. It returns the plan and the
// findings (problems when it does not fit).
func (x *layoutModel) placeDisk(d *Disk, target TargetDisk, shrinkAuto bool) (PlannedDisk, []Finding) {
	ts := target.LogicalSectorSize
	size := target.SizeBytes
	pd := PlannedDisk{Disk: d.ID, Target: target.ID, SectorSize: ts, Partitions: []PlannedPartition{}, LVs: []PlannedLV{}}
	var out []Finding
	need := x.diskMinimum(d)
	if d.Table == nil {
		if size < need {
			out = append(out, newFinding(ProblemTargetTooSmall, d.ID, "disk", d.ID, "target", target.ID, "needBytes", need, "haveBytes", size))
		}
		return pd, out
	}
	pd.Table = strPtr(d.Table.Type)
	gpt := d.Table.Type == "gpt"
	end := alignDown(size-mib, mib)
	if !gpt {
		limit := int64(1<<32) * ts
		end = min(size, limit)
		end = alignDown(end, ts)
		if size > limit {
			out = append(out, newFinding(WarnMBR2TiBLimit, target.ID, "target", target.ID, "freeBytes", size-limit))
		}
	}
	srcSector := d.Table.SectorSize
	if srcSector <= 0 {
		srcSector = d.LogicalSectorSize
	}
	var parts []*placePart
	for i := range d.Table.Partitions {
		p := &d.Table.Partitions[i]
		if !gpt && p.Number >= 5 {
			continue // logical partitions are placed inside the extended one
		}
		pp := &placePart{p: p, min: x.partitionMinimum(d, p), grow: p.Grow != nil && *p.Grow}
		if isExtended(d.Table, p) {
			pp.fixed = false
		} else {
			r := PartRef(d.ID, p.Number)
			pp.fixed = x.fixedNode(r.key(), r)
		}
		pp.desired = alignUp(p.SizeBytes, ts)
		if pp.fixed {
			pp.min = pp.desired
		}
		if x.isESPPartition(d, p) && ts >= 4096 && pp.desired < espMin4Kn {
			pp.desired, pp.min, pp.espGrow = espMin4Kn, espMin4Kn, true
		}
		pp.min = alignUp(pp.min, ts)
		if !pp.fixed && pp.desired < pp.min {
			pp.desired = pp.min
		}
		parts = append(parts, pp)
	}
	sort.SliceStable(parts, func(i, j int) bool { return parts[i].p.StartBytes < parts[j].p.StartBytes })

	sameGeometry := size == d.SizeBytes && ts == srcSector
	espChanged := false
	for _, pp := range parts {
		espChanged = espChanged || pp.espGrow
	}
	realigned := map[int64]int64{}
	placed := false
	if sameGeometry && !espChanged {
		// Exact copy, except partitions that start before 1 MiB or off a
		// MiB boundary: those move up and keep their end.
		ok := true
		var prevEnd int64 = mib
		for _, pp := range parts {
			pp.start, pp.size = pp.p.StartBytes, pp.p.SizeBytes
			if pp.size < pp.min {
				ok = false
				break
			}
			if pp.start < mib || pp.start%mib != 0 {
				newStart := alignUp(max(pp.start, prevEnd), mib)
				endB := alignDown(pp.p.StartBytes+pp.p.SizeBytes, ts)
				if endB-newStart < pp.min {
					ok = false
					break
				}
				realigned[pp.p.Number] = pp.p.StartBytes
				pp.start, pp.size = newStart, endB-newStart
			}
			prevEnd = pp.start + pp.size
		}
		placed = ok && prevEnd <= alignDown(size, ts)
	}
	if !placed {
		realigned = map[int64]int64{}
		var problems []Finding
		problems, out = x.placeGeneral(d, target, parts, end, ts, shrinkAuto, out)
		if len(problems) > 0 {
			return pd, append(out, problems...)
		}
		for _, pp := range parts {
			if pp.p.StartBytes != pp.start && (pp.p.StartBytes < mib || pp.p.StartBytes%mib != 0) {
				realigned[pp.p.Number] = pp.p.StartBytes
			}
		}
	}
	for _, pp := range parts {
		if from, ok := realigned[pp.p.Number]; ok {
			out = append(out, newFinding(WarnPartitionRealigned, partLabel(d, pp.p), "partition", partLabel(d, pp.p), "fromBytes", from))
		}
		if pp.espGrow {
			out = append(out, newFinding(WarnESPGrown4Kn, partLabel(d, pp.p), "partition", partLabel(d, pp.p), "sizeBytes", pp.size))
		}
		_, isRealigned := realigned[pp.p.Number]
		e := PlannedPartition{Number: pp.p.Number, StartBytes: pp.start, SizeBytes: pp.size,
			StartLBA: pp.start / ts, SizeLBA: pp.size / ts,
			Grown: pp.size > pp.p.SizeBytes && !pp.espGrow && !isRealigned, Shrunk: pp.size < pp.p.SizeBytes && !isRealigned, Realigned: isRealigned}
		if e.Shrunk {
			out = append(out, newFinding(WarnPartitionShrunk, partLabel(d, pp.p), "partition", partLabel(d, pp.p), "fromBytes", pp.p.SizeBytes, "toBytes", pp.size))
		}
		pd.Partitions = append(pd.Partitions, e)
		if isExtended(d.Table, pp.p) {
			pd.Partitions = append(pd.Partitions, x.placeLogical(d, pp, ts)...)
		}
	}
	sort.SliceStable(pd.Partitions, func(i, j int) bool { return pd.Partitions[i].Number < pd.Partitions[j].Number })
	return pd, out
}

// placeLogical lays out the logical partitions inside an extended one:
// each starts 1 MiB after the previous end (room for its EBR); the last
// takes the rest when it is marked grow.
func (x *layoutModel) placeLogical(d *Disk, ext *placePart, ts int64) []PlannedPartition {
	var logical []*Partition
	for i := range d.Table.Partitions {
		if q := &d.Table.Partitions[i]; q.Number >= 5 {
			logical = append(logical, q)
		}
	}
	sort.SliceStable(logical, func(i, j int) bool { return logical[i].StartBytes < logical[j].StartBytes })
	var out []PlannedPartition
	cursor := ext.start
	extEnd := ext.start + ext.size
	for i, q := range logical {
		start := alignUp(cursor+ts, mib)
		sz := alignUp(q.SizeBytes, ts)
		if i == len(logical)-1 && q.Grow != nil && *q.Grow {
			sz = extEnd - start
		}
		if start+sz > extEnd {
			sz = max(extEnd-start, 0)
		}
		out = append(out, PlannedPartition{Number: q.Number, StartBytes: start, SizeBytes: sz, StartLBA: start / ts, SizeLBA: sz / ts,
			Grown: sz > q.SizeBytes, Shrunk: sz < q.SizeBytes})
		cursor = start + sz
	}
	return out
}

// placeGeneral places partitions on a disk of another size or sector
// size: starts on 1 MiB, recorded starts kept where they still fit, the
// grow partition takes the rest when it is the last one; on a smaller disk
// the grow partition shrinks first, then (shrink auto) the others with the
// largest surplus.
func (x *layoutModel) placeGeneral(d *Disk, target TargetDisk, parts []*placePart, end, ts int64, shrinkAuto bool, out []Finding) ([]Finding, []Finding) {
	var growPart *placePart
	for _, pp := range parts {
		pp.size = pp.desired
		if pp.grow {
			growPart = pp
		}
	}
	growLast := growPart != nil && parts[len(parts)-1] == growPart
	if growPart != nil && !growLast && target.SizeBytes > d.SizeBytes {
		out = append(out, newFinding(WarnGrowNotLast, partLabel(d, growPart.p), "partition", partLabel(d, growPart.p), "disk", d.ID))
	}
	layout := func(keepStarts bool) int64 {
		cursor := mib
		for _, pp := range parts {
			start := alignUp(cursor, mib)
			if keepStarts && pp.p.StartBytes >= start && pp.p.StartBytes%mib == 0 {
				start = pp.p.StartBytes
			}
			pp.start = start
			cursor = start + pp.size
		}
		return cursor
	}
	fill := func() int64 {
		// The last grow partition takes the rest up to end.
		if growLast {
			growPart.size = growPart.min
		}
		e := layout(true)
		if e > end {
			e = layout(false)
		}
		if growLast && e <= end {
			growPart.size = alignDown(end-growPart.start, ts)
			if growPart.size < growPart.desired && growPart.size < growPart.min {
				growPart.size = growPart.min
			}
			e = growPart.start + growPart.size
		}
		return e
	}
	e := fill()
	if e <= end {
		return nil, out
	}
	// Smaller disk: shrink the grow partition (not last) first.
	deficit := e - end
	if growPart != nil && !growLast {
		cut := min(deficit, growPart.size-growPart.min)
		growPart.size -= alignUp(cut, ts)
		if growPart.size < growPart.min {
			growPart.size = growPart.min
		}
		e = fill()
		deficit = max(e-end, 0)
	}
	if deficit > 0 {
		// Others, the largest surplus first.
		cands := []*placePart{}
		for _, pp := range parts {
			if !pp.fixed && pp != growPart && pp.size > pp.min {
				cands = append(cands, pp)
			}
		}
		sort.SliceStable(cands, func(i, j int) bool { return cands[i].size-cands[i].min > cands[j].size-cands[j].min })
		var proposal []any
		for _, pp := range cands {
			if deficit <= 0 {
				break
			}
			cut := min(alignUp(deficit, mib), pp.size-pp.min)
			proposal = append(proposal, map[string]any{"partition": pp.p.Number, "fromBytes": pp.size, "toBytes": pp.size - cut})
			pp.size -= cut
			deficit -= cut
		}
		e = fill()
		if e > end {
			need := x.diskMinimum(d)
			return []Finding{newFinding(ProblemTargetTooSmall, d.ID, "disk", d.ID, "target", target.ID, "needBytes", max(need, e+(target.SizeBytes-end)), "haveBytes", target.SizeBytes)}, out
		}
		if !shrinkAuto && len(proposal) > 0 {
			return []Finding{newFinding(ProblemShrinkNeedsConfirmation, d.ID, "disk", d.ID, "target", target.ID, "proposal", proposal)}, out
		}
	}
	return nil, out
}

// isESPPartition: the partition has the ESP type or carries an ESP.
func (x *layoutModel) isESPPartition(d *Disk, p *Partition) bool {
	t := strings.ToLower(p.Type)
	if t == gptESP || t == "ef" {
		return true
	}
	if fs := x.fsOn[PartRef(d.ID, p.Number).key()]; fs != nil && x.esps[fs.ID] {
		return true
	}
	return false
}

func partLabel(d *Disk, p *Partition) string {
	return d.ID + "p" + itoa(p.Number)
}

func itoa(n int64) string { return strconv.FormatInt(n, 10) }
