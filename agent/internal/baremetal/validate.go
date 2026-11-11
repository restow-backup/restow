package baremetal

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"
)

var (
	reDiskID  = regexp.MustCompile(`^d\d{1,3}$`)
	reMDID    = regexp.MustCompile(`^m\d{1,3}$`)
	reLUKSID  = regexp.MustCompile(`^c\d{1,3}$`)
	rePlainID = regexp.MustCompile(`^p\d{1,3}$`)
	reFSID    = regexp.MustCompile(`^f\d{1,4}$`)
	reLVMName = regexp.MustCompile(`^[A-Za-z0-9+_.-]{1,127}$`)
	reHex64   = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

// List limits (contract C1).
const (
	maxDisks          = 64
	maxPartitions     = 256
	maxSubvolumes     = 4096
	maxLVs            = 1024
	maxLoaders        = 256
	maxNetwork        = 64
	maxMD             = 64
	maxLUKS           = 256
	maxPlainCrypt     = 64
	maxPVs            = 256
	maxVGs            = 64
	maxFilesystems    = 1024
	maxMounts         = 4096
	maxFstab          = 1024
	maxSwap           = 64
	maxKernels        = 64
	maxDKMS           = 512
	maxMokFiles       = 16
	maxConfigs        = 64
	maxNetConfigs     = 256
	maxDeviceNameRefs = 512
	maxEFIEntries     = 128
	maxDB             = 64
	maxMOK            = 64
	maxSbatLines      = 64
	maxUnsupported    = 512
	maxRaw            = 512
	maxSources        = 4096
	maxExcludes       = 1000
)

func oneOf(v string, allowed ...string) bool {
	for _, a := range allowed {
		if v == a {
			return true
		}
	}
	return false
}

type validator struct{ errs []error }

func (v *validator) failf(format string, args ...any) {
	if len(v.errs) < 20 {
		v.errs = append(v.errs, fmt.Errorf(format, args...))
	}
}

func (v *validator) enum(path, val string, allowed ...string) {
	if !oneOf(val, allowed...) {
		v.failf("%s: %q is not one of %v", path, val, allowed)
	}
}

func (v *validator) enumPtr(path string, val *string, allowed ...string) {
	if val != nil {
		v.enum(path, *val, allowed...)
	}
}

func (v *validator) limit(path string, n, max int) {
	if n > max {
		v.failf("%s: %d entries, at most %d allowed", path, n, max)
	}
}

func (v *validator) match(path string, re *regexp.Regexp, val string) {
	if !re.MatchString(val) {
		v.failf("%s: %q does not match %s", path, val, re)
	}
}

func (v *validator) nonNeg(path string, n int64) {
	if n < 0 || n > maxSafeInteger {
		v.failf("%s: %d is out of range", path, n)
	}
}

func (v *validator) nonNegPtr(path string, n *int64) {
	if n != nil {
		v.nonNeg(path, *n)
	}
}

// Validate checks a manifest against the schema of its platform: header,
// required values, enumerations, identifier patterns, that every BlockRef
// resolves and the device graph has no cycle, list and string limits, and
// that every string passes checkString.
func (m *Manifest) Validate() error {
	v := &validator{}
	if m.Format != Format {
		v.failf("format: %q, want %q", m.Format, Format)
	}
	if m.SchemaVersion != SchemaVersion {
		v.failf("schemaVersion: %d, want %d", m.SchemaVersion, SchemaVersion)
	}
	if t, err := time.Parse(time.RFC3339, m.CapturedAt); err != nil || t.UTC().Format("2006-01-02T15:04:05Z") != m.CapturedAt {
		v.failf("capturedAt: %q is not RFC 3339 UTC with whole seconds", m.CapturedAt)
	}
	switch {
	case m.Linux != nil && m.Darwin != nil:
		v.failf("manifest: both linux and darwin parts are set")
	case m.Platform == PlatformLinux && m.Linux != nil:
		v.linux(m.Linux)
	case m.Platform == PlatformDarwin && m.Darwin != nil:
		v.darwin(m.Darwin)
	default:
		v.failf("platform: %q does not match the manifest's content", m.Platform)
	}
	if len(v.errs) == 0 {
		// Every string, also inside loosely typed parts, and the lengths.
		tree, err := toTree(m)
		if err != nil {
			v.failf("%v", err)
		} else {
			v.strings("", tree)
		}
	}
	return errors.Join(v.errs...)
}

// strings walks the encoded tree and checks every string and key.
func (v *validator) strings(path string, node any) {
	switch t := node.(type) {
	case string:
		max := maxStringBytes
		switch {
		case path == "os.cmdline":
			max = maxCmdlineBytes
		case len(path) > len("firmware.sbatLevel") && path[:len("firmware.sbatLevel[")] == "firmware.sbatLevel[":
			max = maxSbatBytes
		}
		if len(t) > max {
			v.failf("%s: %d bytes, at most %d allowed", path, len(t), max)
		}
		if err := checkString(t); err != nil {
			v.failf("%s: %v", path, err)
		}
	case []any:
		for i, e := range t {
			v.strings(fmt.Sprintf("%s[%d]", path, i), e)
		}
	case map[string]any:
		for k, e := range t {
			if len(k) > maxStringBytes {
				v.failf("%s: key of %d bytes", path, len(k))
			}
			if err := checkString(k); err != nil {
				v.failf("%s: key: %v", path, err)
			}
			v.strings(join(path, k), e)
		}
	}
}

func (v *validator) common(b Backup, agent AgentInfo, unsupported []Unsupported, verdict string, raw []RawRef) {
	v.limit("backup.sources", len(b.Sources), maxSources)
	v.limit("backup.excludes", len(b.Excludes), maxExcludes)
	v.limit("backup.fsSnapshots", len(b.FSSnapshots), maxSources)
	v.limit("backup.liveReasons", len(b.LiveReasons), maxSources)
	for k, val := range b.FSSnapshots {
		v.enum("backup.fsSnapshots."+k, val, FSSnapLVM, FSSnapBtrfs, FSSnapLive)
	}
	for k, val := range b.LiveReasons {
		v.enum("backup.liveReasons."+k, val, LiveReasons...)
	}
	v.enum("agent.hooks", agent.Hooks, "off", "scripts", "any")
	v.limit("unsupported", len(unsupported), maxUnsupported)
	for i, u := range unsupported {
		v.enum(fmt.Sprintf("unsupported[%d].severity", i), u.Severity, SeverityUnsupported, SeverityWarning)
		if u.Code == "" {
			v.failf("unsupported[%d].code: empty", i)
		}
	}
	v.enum("verdict", verdict, VerdictSupported, VerdictSupportedWithWarnings, VerdictUnsupported)
	v.limit("raw", len(raw), maxRaw)
	for i, r := range raw {
		if r.Name == "" {
			v.failf("raw[%d].name: empty", i)
		}
		v.match(fmt.Sprintf("raw[%d].sha256", i), reHex64, r.SHA256)
	}
}

// LiveReasons are the values of Backup.LiveReasons.
var LiveReasons = []string{"off", "partition", "md", "vfat", "luks_on_lv", "vg_no_space", "thin_pool_busy", "unsupported_fs", "no_helper"}

func (v *validator) darwin(d *DarwinLayout) {
	v.common(d.Backup, d.Agent, d.Unsupported, d.Verdict, d.Raw)
}

// graph holds the nodes a BlockRef can name and their dependencies.
type graph struct {
	nodes map[string]bool
	deps  map[string][]string
}

func (v *validator) linux(l *LinuxLayout) {
	v.common(l.Backup, l.Agent, l.Unsupported, l.Verdict, l.Raw)
	o := l.OS
	if o.ID == "" {
		v.failf("os.id: empty")
	}
	v.enumPtr("os.selinux", o.SELinux, "enforcing", "permissive", "disabled")
	v.enum("os.init", o.Init, "systemd", "other")

	f := l.Firmware
	v.enum("firmware.mode", f.Mode, "uefi", "bios")
	v.limit("firmware.entries", len(f.Entries), maxEFIEntries)
	v.limit("firmware.bootOrder", len(f.BootOrder), maxEFIEntries)
	v.limit("firmware.sbatLevel", len(f.SbatLevel), maxSbatLines)
	v.limit("firmware.db", len(f.DB), maxDB)
	v.limit("firmware.mok", len(f.MOK), maxMOK)
	for i, e := range f.Entries {
		v.nonNeg(fmt.Sprintf("firmware.entries[%d].num", i), e.Num)
	}
	for i, c := range f.DB {
		v.match(fmt.Sprintf("firmware.db[%d].sha256", i), reHex64, c.SHA256)
	}
	for i, c := range f.MOK {
		v.match(fmt.Sprintf("firmware.mok[%d].sha256", i), reHex64, c.SHA256)
	}
	if f.DBXSha256 != nil {
		v.match("firmware.dbxSha256", reHex64, *f.DBXSha256)
	}

	v.limit("loaders", len(l.Loaders), maxLoaders)
	for i, ld := range l.Loaders {
		v.match(fmt.Sprintf("loaders[%d].authenticodeSha256", i), reHex64, ld.AuthenticodeSha256)
		v.nonNeg(fmt.Sprintf("loaders[%d].bytes", i), ld.Bytes)
	}

	g := &graph{nodes: map[string]bool{}, deps: map[string][]string{}}
	// Disks and partitions.
	v.limit("disks", len(l.Disks), maxDisks)
	diskIDs := map[string]bool{}
	for i, d := range l.Disks {
		p := fmt.Sprintf("disks[%d]", i)
		v.match(p+".id", reDiskID, d.ID)
		if diskIDs[d.ID] {
			v.failf("%s.id: %q is not unique", p, d.ID)
		}
		diskIDs[d.ID] = true
		g.nodes[DiskRef(d.ID).key()] = true
		v.nonNeg(p+".sizeBytes", d.SizeBytes)
		v.nonNeg(p+".logicalSectorSize", d.LogicalSectorSize)
		v.nonNeg(p+".physicalSectorSize", d.PhysicalSectorSize)
		v.nonNegPtr(p+".nsid", d.NSID)
		v.enum(p+".bootCode", d.BootCode, "grub", "none", "other")
		if t := d.Table; t != nil {
			v.enum(p+".table.type", t.Type, "gpt", "dos")
			v.limit(p+".table.partitions", len(t.Partitions), maxPartitions)
			nums := map[int64]bool{}
			grow := 0
			for j, part := range t.Partitions {
				pp := fmt.Sprintf("%s.table.partitions[%d]", p, j)
				if part.Number < 1 {
					v.failf("%s.number: %d", pp, part.Number)
				}
				if nums[part.Number] {
					v.failf("%s.number: %d is not unique", pp, part.Number)
				}
				nums[part.Number] = true
				v.nonNeg(pp+".startBytes", part.StartBytes)
				v.nonNeg(pp+".sizeBytes", part.SizeBytes)
				if part.Grow != nil {
					if !*part.Grow {
						v.failf("%s.grow: only true or absent", pp)
					}
					grow++
				}
				k := PartRef(d.ID, part.Number).key()
				g.nodes[k] = true
				g.deps[k] = append(g.deps[k], DiskRef(d.ID).key())
			}
			if grow > 1 {
				v.failf("%s.table: more than one partition marked grow", p)
			}
		}
	}

	// LVM nodes come first so references from LUKS and md resolve.
	v.limit("lvm.pvs", len(l.LVM.PVs), maxPVs)
	v.limit("lvm.vgs", len(l.LVM.VGs), maxVGs)
	lvs := 0
	vgNames := map[string]bool{}
	for i, vg := range l.LVM.VGs {
		p := fmt.Sprintf("lvm.vgs[%d]", i)
		v.match(p+".name", reLVMName, vg.Name)
		if vgNames[vg.Name] {
			v.failf("%s.name: %q is not unique", p, vg.Name)
		}
		vgNames[vg.Name] = true
		v.nonNeg(p+".extentBytes", vg.ExtentBytes)
		v.nonNeg(p+".sizeBytes", vg.SizeBytes)
		v.nonNeg(p+".freeBytes", vg.FreeBytes)
		lvs += len(vg.LVs)
		names := map[string]bool{}
		grow := 0
		for j, lv := range vg.LVs {
			pp := fmt.Sprintf("%s.lvs[%d]", p, j)
			v.match(pp+".name", reLVMName, lv.Name)
			if names[lv.Name] {
				v.failf("%s.name: %q is not unique", pp, lv.Name)
			}
			names[lv.Name] = true
			v.nonNeg(pp+".sizeBytes", lv.SizeBytes)
			for _, n := range []*int64{lv.Stripes, lv.StripeBytes, lv.VirtualBytes, lv.ChunkBytes, lv.MetadataBytes} {
				v.nonNegPtr(pp, n)
			}
			if lv.Grow != nil {
				if !*lv.Grow {
					v.failf("%s.grow: only true or absent", pp)
				}
				grow++
			}
			g.nodes[LVRef(vg.Name, lv.Name).key()] = true
		}
		if grow > 1 {
			v.failf("%s: more than one LV marked grow", p)
		}
	}
	v.limit("lvm.vgs[].lvs", lvs, maxLVs)

	v.limit("md", len(l.MD), maxMD)
	for i, md := range l.MD {
		p := fmt.Sprintf("md[%d]", i)
		v.match(p+".id", reMDID, md.ID)
		if g.nodes[MDRef(md.ID).key()] {
			v.failf("%s.id: %q is not unique", p, md.ID)
		}
		g.nodes[MDRef(md.ID).key()] = true
		v.enum(p+".bitmap", md.Bitmap, "internal", "none", "external")
		v.nonNeg(p+".raidDevices", md.RaidDevices)
		v.nonNeg(p+".sizeBytes", md.SizeBytes)
		v.nonNegPtr(p+".chunkBytes", md.ChunkBytes)
		for _, mem := range md.Members {
			v.nonNegPtr(p+".members.role", mem.Role)
		}
	}
	v.limit("luks", len(l.LUKS), maxLUKS)
	for i, c := range l.LUKS {
		p := fmt.Sprintf("luks[%d]", i)
		v.match(p+".id", reLUKSID, c.ID)
		if g.nodes[LUKSRef(c.ID).key()] {
			v.failf("%s.id: %q is not unique", p, c.ID)
		}
		g.nodes[LUKSRef(c.ID).key()] = true
		if c.Version != 1 && c.Version != 2 {
			v.failf("%s.version: %d", p, c.Version)
		}
		v.nonNeg(p+".keyBits", c.KeyBits)
		v.nonNeg(p+".sectorSize", c.SectorSize)
		v.nonNeg(p+".keyslots", c.Keyslots)
		for _, n := range []*int64{c.PBKDF.Iterations, c.PBKDF.MemoryKiB, c.PBKDF.Time, c.PBKDF.Parallel} {
			v.nonNegPtr(p+".pbkdf", n)
		}
	}
	v.limit("plainCrypt", len(l.PlainCrypt), maxPlainCrypt)
	for i, c := range l.PlainCrypt {
		p := fmt.Sprintf("plainCrypt[%d]", i)
		v.match(p+".id", rePlainID, c.ID)
		if g.nodes[PlainRef(c.ID).key()] {
			v.failf("%s.id: %q is not unique", p, c.ID)
		}
		g.nodes[PlainRef(c.ID).key()] = true
		v.enum(p+".purpose", c.Purpose, "swap", "tmp", "plain")
		v.nonNeg(p+".keyBits", c.KeyBits)
	}

	// References and the dependency edges.
	ref := func(path string, from string, r BlockRef) {
		if err := r.shapeError(); err != nil {
			v.failf("%s: %v", path, err)
			return
		}
		if !g.nodes[r.key()] {
			v.failf("%s: %s does not resolve", path, r)
			return
		}
		if from != "" {
			g.deps[from] = append(g.deps[from], r.key())
		}
	}
	for i, md := range l.MD {
		from := MDRef(md.ID).key()
		for j, mem := range md.Members {
			ref(fmt.Sprintf("md[%d].members[%d].device", i, j), from, mem.Device)
		}
		for j, s := range md.Spares {
			ref(fmt.Sprintf("md[%d].spares[%d]", i, j), from, s)
		}
	}
	for i, c := range l.LUKS {
		ref(fmt.Sprintf("luks[%d].device", i), LUKSRef(c.ID).key(), c.Device)
	}
	for i, c := range l.PlainCrypt {
		ref(fmt.Sprintf("plainCrypt[%d].device", i), PlainRef(c.ID).key(), c.Device)
	}
	pvsOf := map[string][]BlockRef{}
	for i, pv := range l.LVM.PVs {
		ref(fmt.Sprintf("lvm.pvs[%d].device", i), "", pv.Device)
		v.nonNeg(fmt.Sprintf("lvm.pvs[%d].sizeBytes", i), pv.SizeBytes)
		if pv.VG != nil {
			if !vgNames[*pv.VG] {
				v.failf("lvm.pvs[%d].vg: %q does not resolve", i, *pv.VG)
			}
			pvsOf[*pv.VG] = append(pvsOf[*pv.VG], pv.Device)
		}
	}
	for _, vg := range l.LVM.VGs {
		for _, lv := range vg.LVs {
			k := LVRef(vg.Name, lv.Name).key()
			for _, d := range pvsOf[vg.Name] {
				if g.nodes[d.key()] {
					g.deps[k] = append(g.deps[k], d.key())
				}
			}
		}
	}

	v.limit("filesystems", len(l.Filesystems), maxFilesystems)
	fsIDs := map[string]bool{}
	subvols := 0
	for i, fs := range l.Filesystems {
		p := fmt.Sprintf("filesystems[%d]", i)
		v.match(p+".id", reFSID, fs.ID)
		if fsIDs[fs.ID] {
			v.failf("%s.id: %q is not unique", p, fs.ID)
		}
		fsIDs[fs.ID] = true
		if len(fs.Devices) == 0 {
			v.failf("%s.devices: at least one device", p)
		}
		for j, d := range fs.Devices {
			ref(fmt.Sprintf("%s.devices[%d]", p, j), "", d)
		}
		if fs.Type == "" {
			v.failf("%s.type: empty", p)
		}
		v.nonNeg(p+".sizeBytes", fs.SizeBytes)
		v.nonNeg(p+".usedBytes", fs.UsedBytes)
		v.nonNegPtr(p+".inodesUsed", fs.InodesUsed)
		if b := fs.Btrfs; b != nil {
			v.enumPtr(p+".btrfs.csum", b.Csum, "crc32c", "xxhash", "sha256", "blake2")
			subvols += len(b.Subvolumes)
			for j, s := range b.Subvolumes {
				v.enum(fmt.Sprintf("%s.btrfs.subvolumes[%d].kind", p, j), s.Kind,
					SubvolNormal, SubvolSnapper, SubvolTimeshift, SubvolDocker, SubvolMachines, SubvolRestow)
			}
		}
	}
	v.limit("filesystems[].btrfs.subvolumes", subvols, maxSubvolumes)

	v.limit("swap", len(l.Swap), maxSwap)
	for i, s := range l.Swap {
		p := fmt.Sprintf("swap[%d]", i)
		v.enum(p+".kind", s.Kind, "partition", "file", "plain")
		if s.Device != nil {
			ref(p+".device", "", *s.Device)
		}
		if s.FS != nil && !fsIDs[*s.FS] {
			v.failf("%s.fs: %q does not resolve", p, *s.FS)
		}
		if !rePriority.MatchString(s.Priority) {
			v.failf("%s.priority: %q is not a decimal integer", p, s.Priority)
		}
		v.nonNegPtr(p+".resumeOffset", s.ResumeOffset)
	}
	v.limit("mounts", len(l.Mounts), maxMounts)
	for i, mnt := range l.Mounts {
		if mnt.FS != nil && !fsIDs[*mnt.FS] {
			v.failf("mounts[%d].fs: %q does not resolve", i, *mnt.FS)
		}
		v.nonNegPtr(fmt.Sprintf("mounts[%d].subvolId", i), mnt.SubvolID)
		if mnt.Root != "" && !strings.HasPrefix(mnt.Root, "/") {
			v.failf("mounts[%d].root: %q is not an absolute path", i, mnt.Root)
		}
	}
	v.limit("fstab", len(l.Fstab), maxFstab)
	for i, e := range l.Fstab {
		p := fmt.Sprintf("fstab[%d]", i)
		v.enum(p+".origin", e.Origin, "fstab", "unit")
		if r := e.Resolved; r != nil {
			n := 0
			if r.FS != nil {
				n++
				if !fsIDs[*r.FS] {
					v.failf("%s.resolved.fs: %q does not resolve", p, *r.FS)
				}
			}
			if r.Swap != nil {
				n++
				if *r.Swap < 0 || *r.Swap >= int64(len(l.Swap)) {
					v.failf("%s.resolved.swap: %d does not resolve", p, *r.Swap)
				}
			}
			if r.Block != nil {
				n++
				ref(p+".resolved.block", "", *r.Block)
			}
			if n != 1 {
				v.failf("%s.resolved: exactly one of fs, swap and block", p)
			}
		}
	}

	b := l.Bootloader
	v.enum("bootloader.kind", b.Kind, "grub", "systemd-boot", "none", "other")
	for i, e := range b.ESPs {
		if !fsIDs[e] {
			v.failf("bootloader.esps[%d]: %q does not resolve", i, e)
		}
	}
	if b.XBootLdr != nil && !fsIDs[*b.XBootLdr] {
		v.failf("bootloader.xbootldr: %q does not resolve", *b.XBootLdr)
	}
	for i, d := range b.BIOSDisks {
		if !diskIDs[d] {
			v.failf("bootloader.biosDisks[%d]: %q does not resolve", i, d)
		}
	}
	v.enumPtr("initramfs.generator", l.Initramfs.Generator, "initramfs-tools", "dracut", "mkinitcpio", "other")

	v.limit("kernels", len(l.Kernels), maxKernels)
	for i, k := range l.Kernels {
		v.nonNeg(fmt.Sprintf("kernels[%d].imageBytes", i), k.ImageBytes)
		v.nonNegPtr(fmt.Sprintf("kernels[%d].initramfsBytes", i), k.InitramfsBytes)
	}
	v.limit("dkms", len(l.DKMS), maxDKMS)
	for i, d := range l.DKMS {
		v.enum(fmt.Sprintf("dkms[%d].kind", i), d.Kind, "net", "storage", "other")
	}
	v.limit("mokFiles", len(l.MokFiles), maxMokFiles)
	v.limit("configs", len(l.Configs), maxConfigs)
	for i, c := range append(append([]FileHash{}, l.MokFiles...), l.Configs...) {
		v.match(fmt.Sprintf("files[%d].sha256", i), reHex64, c.SHA256)
	}
	v.limit("network", len(l.Network), maxNetwork)
	v.limit("netConfigs", len(l.NetConfigs), maxNetConfigs)
	v.limit("deviceNameRefs", len(l.DeviceNameRefs), maxDeviceNameRefs)
	for i, d := range l.DeviceNameRefs {
		v.nonNeg(fmt.Sprintf("deviceNameRefs[%d].line", i), d.Line)
	}

	if cyc := g.cycle(); cyc != "" {
		v.failf("block devices: reference cycle through %s", cyc)
	}
}

var rePriority = regexp.MustCompile(`^-?(0|[1-9][0-9]{0,9})$`)

// shapeError checks that a BlockRef has exactly the fields of its kind.
func (r BlockRef) shapeError() error {
	has := func(disk, number, id, vg, lv bool) bool {
		return (r.Disk != "") == disk && (r.Number != 0) == number && (r.ID != "") == id &&
			(r.VG != "") == vg && (r.LV != "") == lv
	}
	ok := false
	switch r.Kind {
	case RefDisk:
		ok = has(true, false, false, false, false) && reDiskID.MatchString(r.Disk)
	case RefPartition:
		ok = has(true, true, false, false, false) && reDiskID.MatchString(r.Disk) && r.Number > 0
	case RefMD:
		ok = has(false, false, true, false, false) && reMDID.MatchString(r.ID)
	case RefLUKS:
		ok = has(false, false, true, false, false) && reLUKSID.MatchString(r.ID)
	case RefPlain:
		ok = has(false, false, true, false, false) && rePlainID.MatchString(r.ID)
	case RefLV:
		ok = has(false, false, false, true, true) && reLVMName.MatchString(r.VG) && reLVMName.MatchString(r.LV)
	}
	if !ok {
		return fmt.Errorf("invalid block reference %s", r)
	}
	return nil
}

func (r BlockRef) String() string {
	switch r.Kind {
	case RefDisk:
		return "disk " + r.Disk
	case RefPartition:
		return fmt.Sprintf("partition %s/%d", r.Disk, r.Number)
	case RefLV:
		return "lv " + r.VG + "/" + r.LV
	}
	return r.Kind + " " + r.ID
}

// cycle returns a node on a cycle of the dependency graph, or "".
func (g *graph) cycle() string {
	const (
		white = iota
		grey
		black
	)
	color := map[string]int{}
	var found string
	var visit func(n string) bool
	visit = func(n string) bool {
		color[n] = grey
		for _, d := range g.deps[n] {
			switch color[d] {
			case grey:
				found = d
				return true
			case white:
				if visit(d) {
					return true
				}
			}
		}
		color[n] = black
		return false
	}
	for n := range g.nodes {
		if color[n] == white && visit(n) {
			return found
		}
	}
	return ""
}

func sha256Hex(b []byte) string {
	s := sha256.Sum256(b)
	return hex.EncodeToString(s[:])
}
