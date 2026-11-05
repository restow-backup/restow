package baremetal

import (
	"bytes"
	"go/parser"
	"go/token"
	"math"
	"strconv"
	"strings"
	"testing"
)

// Unit tests of the planner parts: sizing, mapping, drivers, Secure Boot,
// mkfs, the input parsers and the import rule.

func codes(fs []Finding) []string {
	var out []string
	for _, f := range fs {
		out = append(out, f.Code)
	}
	return out
}

func hasFinding(fs []Finding, code string) bool {
	for _, f := range fs {
		if f.Code == code {
			return true
		}
	}
	return false
}

func samePlan(t *testing.T, name string, edit func(m *Manifest, tg *Target, f *Facts, c *Choices)) *RestorePlan {
	t.Helper()
	m := loadManifest(t, name)
	f := readFacts(t, name)
	tg, c, err := SyntheticTarget(m, TargetSame, f)
	if err != nil {
		t.Fatal(err)
	}
	if edit != nil {
		edit(m, tg, f, &c)
	}
	p, _ := Plan(m, tg, f, c)
	return p
}

func TestMulDiv(t *testing.T) {
	cases := []struct{ n, num, den, down, up int64 }{
		{10, 3, 4, 7, 8},
		{77 << 30, 255995150336, 510271979520, 41478267910, 41478267911},
		{1, 1, 1, 1, 1},
		{0, 5, 3, 0, 0},
	}
	for _, c := range cases {
		if got := mulDiv(c.n, c.num, c.den); got != c.down {
			t.Errorf("mulDiv(%d,%d,%d) = %d, want %d", c.n, c.num, c.den, got, c.down)
		}
		if got := mulDivUp(c.n, c.num, c.den); got != c.up {
			t.Errorf("mulDivUp(%d,%d,%d) = %d, want %d", c.n, c.num, c.den, got, c.up)
		}
	}
	if got := mulDiv(math.MaxInt64, math.MaxInt64, 1); got != maxSafeInteger {
		t.Errorf("overflow: %d", got)
	}
}

func TestFilesystemMinimum(t *testing.T) {
	m := loadManifest(t, "debian12-uefi-luks-lvm")
	f := readFacts(t, "debian12-uefi-luks-lvm")
	x := newLayoutModel(m, f, "skip")
	root := x.fs["f2"] // ext4 /, restore 10 GiB, journal 128 MiB, 5 % reserved
	want := mulDivUp(mulDivUp(10*gib, 110, 100)+128*mib, 100, 93)
	if got := x.fsMinimum(root); got != want {
		t.Errorf("ext4 minimum %d, want %d", got, want)
	}
	// ESP and /boot keep their size.
	if got := x.fsMinimum(x.fs["f0"]); got != 536870912 {
		t.Errorf("ESP %d", got)
	}
	if got := x.fsMinimum(x.fs["f1"]); got != x.fs["f1"].SizeBytes {
		t.Errorf("/boot %d", got)
	}
	// XFS floor and btrfs per device.
	xm := loadManifest(t, "btrfs-raid1-multi")
	xx := newLayoutModel(xm, readFacts(t, "btrfs-raid1-multi"), "skip")
	b := xx.fs["f2"]
	per := xx.fsMinimum(b)
	if per != max(mulDivUp(xx.restore["f2"], 110, 100)*2/2+gib, btrfsFloorPerDv) {
		t.Errorf("btrfs raid1 per device %d (restore %d)", per, xx.restore["f2"])
	}
	tiny := Filesystem{ID: "f9", Type: "xfs", XFS: &XFSInfo{LogBytes: 10 * mib}}
	if got := x.fsMinimum(&tiny); got != xfsFloor {
		t.Errorf("xfs floor %d", got)
	}
}

func TestMinimumDiskSizes(t *testing.T) {
	m := loadManifest(t, "debian12-uefi-luks-lvm")
	f := readFacts(t, "debian12-uefi-luks-lvm")
	ms, fs := MinimumDiskSizes(m, f)
	if len(fs) != 0 {
		t.Errorf("findings %v", codes(fs))
	}
	x := newLayoutModel(m, f, "skip")
	vg := x.vgs["srv01-vg"]
	p3 := alignUp(x.vgMinimum(vg)+pvOverhead+x.pvSlack(&m.Linux.LVM.PVs[0])+luks2Header, mib)
	want := mib + 512*mib + alignUp(1023410176, mib) + p3 + mib
	if ms.Disks[0].MinBytes != want {
		t.Errorf("disk minimum %d, want %d", ms.Disks[0].MinBytes, want)
	}
	if len(ms.LVs) != 3 || ms.LVs[1].LV != "swap_1" || ms.LVs[1].MinBytes != 8*gib {
		t.Errorf("LVs %+v", ms.LVs)
	}
	// Without facts the space in use is the estimate.
	_, fs = MinimumDiskSizes(m, nil)
	if !hasFinding(fs, WarnRestoreSizeEstimated) {
		t.Errorf("no estimate warning: %v", codes(fs))
	}
}

func TestMDMemberMinimum(t *testing.T) {
	cases := []struct {
		level    string
		n        int64
		layout   *string
		num, den int64
	}{
		{"raid1", 2, nil, 1, 1}, {"raid0", 3, nil, 3, 1}, {"raid5", 4, nil, 3, 1},
		{"raid6", 5, nil, 3, 1}, {"raid10", 4, strPtr("near=2"), 4, 2}, {"raid10", 6, strPtr("f3"), 6, 3},
	}
	for _, c := range cases {
		md := &MDArray{Level: c.level, RaidDevices: c.n, Layout: c.layout}
		if num, den := mdFactor(md); num != c.num || den != c.den {
			t.Errorf("%s/%d: %d/%d, want %d/%d", c.level, c.n, num, den, c.num, c.den)
		}
	}
	if mdNeeded(&MDArray{Level: "raid5", RaidDevices: 3}) != 2 || mdNeeded(&MDArray{Level: "raid0", RaidDevices: 2}) != 2 ||
		mdNeeded(&MDArray{Level: "raid6", RaidDevices: 6}) != 4 || mdNeeded(&MDArray{Level: "raid1", RaidDevices: 3}) != 1 {
		t.Error("mdNeeded")
	}
}

func TestThinPoolMinimum(t *testing.T) {
	m := loadManifest(t, "lvm-thin")
	f := readFacts(t, "lvm-thin")
	x := newLayoutModel(m, f, "skip")
	vg := x.vgs["vg0"]
	pool := x.lvs["vg0/pool"]
	data := mulDivUp(x.restore["f1"], 115, 100) + mulDivUp(x.restore["f2"], 115, 100)
	want := alignUp(max(data+max(data/100, *pool.MetadataBytes), thinPoolFloor), vg.ExtentBytes)
	if got := x.lvMinimum(vg, pool); got != want {
		t.Errorf("thin pool %d, want %d", got, want)
	}
	// Raw thin LVs count only when created (they stay empty).
	pm := loadManifest(t, "pve-raw-lvs")
	if a, b := newLayoutModel(pm, nil, "skip").vgMinimum(&pm.Linux.LVM.VGs[0]), newLayoutModel(pm, nil, "create").vgMinimum(&pm.Linux.LVM.VGs[0]); a != b {
		// thin raw LVs live in the pool: the VG minimum does not change.
		t.Errorf("raw thin LVs changed the VG minimum: %d %d", a, b)
	}
}

func TestPlacement(t *testing.T) {
	larger := samePlan(t, "debian12-uefi-luks-lvm", func(m *Manifest, tg *Target, f *Facts, c *Choices) { tg.Disks[0].SizeBytes = 1000204886016 })
	p3 := larger.Disks[0].Partitions[2]
	if !p3.Grown || p3.StartBytes+p3.SizeBytes != alignDown(1000204886016-mib, mib) {
		t.Errorf("grow partition %+v", p3)
	}
	home := larger.Disks[0].LVs[2]
	if home.LV != "home" || !home.Grown {
		t.Errorf("grow LV %+v", home)
	}
	same := samePlan(t, "debian12-uefi-luks-lvm", nil)
	for i, p := range same.Disks[0].Partitions {
		src := loadManifest(t, "debian12-uefi-luks-lvm").Linux.Disks[0].Table.Partitions[i]
		if p.StartBytes != src.StartBytes || p.SizeBytes != src.SizeBytes || p.Grown || p.Shrunk || p.Realigned {
			t.Errorf("same: partition %+v differs from %+v", p, src)
		}
	}
	// One sector less still fits here (the source left space at the end);
	// 4 MiB less shrinks the grow partition.
	smaller := samePlan(t, "debian12-uefi-luks-lvm", func(m *Manifest, tg *Target, f *Facts, c *Choices) { tg.Disks[0].SizeBytes -= 512 })
	if !smaller.OK || smaller.Disks[0].Partitions[2].Shrunk {
		t.Errorf("one sector smaller: %v %+v", codes(smaller.Problems), smaller.Disks[0].Partitions[2])
	}
	smaller = samePlan(t, "debian12-uefi-luks-lvm", func(m *Manifest, tg *Target, f *Facts, c *Choices) { tg.Disks[0].SizeBytes -= 4 * mib })
	if !smaller.OK || !smaller.Disks[0].Partitions[2].Shrunk {
		t.Errorf("one sector smaller: %v %+v", codes(smaller.Problems), smaller.Disks[0].Partitions[2])
	}
	// 4Kn: sizes in 4096-byte sectors, the ESP of the 480 GB system grows.
	kn := samePlan(t, "plan-480gb", func(m *Manifest, tg *Target, f *Facts, c *Choices) {
		tg.Disks[0].LogicalSectorSize, tg.Disks[0].PhysicalSectorSize = 4096, 4096
	})
	esp := kn.Disks[0].Partitions[0]
	if esp.SizeBytes != espMin4Kn || esp.SizeLBA != espMin4Kn/4096 || !hasFinding(kn.Warnings, WarnESPGrown4Kn) {
		t.Errorf("4Kn ESP %+v %v", esp, codes(kn.Warnings))
	}
	// Sector 63: realigned, the PARTUUID stays in the script.
	s63 := samePlan(t, "plan-mbr-start63", nil)
	if p := s63.Disks[0].Partitions[0]; !p.Realigned || p.StartBytes != mib {
		t.Errorf("start 63: %+v", p)
	}
	if !strings.Contains(*s63.Steps[6].Stdin, "label-id: 0xa1b2c3d0") {
		t.Errorf("sfdisk script: %q", *s63.Steps[6].Stdin)
	}
	// MBR limit.
	mbr := samePlan(t, "bios-mbr-mdadm-raid1", func(m *Manifest, tg *Target, f *Facts, c *Choices) {
		for i := range tg.Disks {
			tg.Disks[i].SizeBytes = 3000592982016
		}
	})
	if !hasFinding(mbr.Warnings, WarnMBR2TiBLimit) {
		t.Errorf("mbr: %v", codes(mbr.Warnings))
	}
	// Grow partition not last on a larger disk.
	gm := loadManifest(t, "plan-480gb")
	tbl := gm.Linux.Disks[0].Table
	tbl.Partitions[0].Grow, tbl.Partitions[1].Grow = boolPtr(true), nil
	tg, c, _ := SyntheticTarget(gm, TargetSame, nil)
	tg.Disks[0].SizeBytes = 1000204886016
	p, _ := Plan(gm, tg, nil, c)
	if !hasFinding(p.Warnings, WarnGrowNotLast) || p.Disks[0].Partitions[0].Grown {
		t.Errorf("grow not last: %v %+v", codes(p.Warnings), p.Disks[0].Partitions[0])
	}
}

func TestShrinkConfirmation(t *testing.T) {
	small := func(c *Choices, size int64) *RestorePlan {
		return samePlan(t, "debian12-uefi-luks-lvm", func(m *Manifest, tg *Target, f *Facts, cc *Choices) {
			tg.Disks[0].SizeBytes = size
			*cc = *c
		})
	}
	p := small(&Choices{}, 128035676160)
	if !hasFinding(p.Problems, ProblemShrinkNeedsConfirmation) {
		t.Fatalf("no confirmation: %v", codes(p.Problems))
	}
	prop := p.Problems[0].Params["proposal"].([]any)
	if len(prop) != 1 || prop[0].(map[string]any)["lv"] != "root" {
		t.Errorf("proposal %v", prop)
	}
	if p := small(&Choices{Shrink: "auto"}, 128035676160); !p.OK || !hasFinding(p.Warnings, WarnLVShrunk) {
		t.Errorf("auto: %v", codes(p.Problems))
	}
	if p := small(&Choices{Shrink: "auto"}, 64023257088); !hasFinding(p.Problems, ProblemTargetTooSmall) {
		t.Errorf("too small: %v", codes(p.Problems))
	} else if f := p.Problems[0]; f.Params["needBytes"].(int64) <= f.Params["haveBytes"].(int64) {
		t.Errorf("params %v", f.Params)
	}
}

func TestMapping(t *testing.T) {
	// Removable and SAN disks are not mapped automatically.
	p := samePlan(t, "ubuntu2404-default", func(m *Manifest, tg *Target, f *Facts, c *Choices) {
		tg.Disks[0].Removable = true
		tg.Disks[0].Serial, tg.Disks[0].EUI64 = strPtr("X"), nil
	})
	if !hasFinding(p.Problems, ProblemTargetMissing) {
		t.Errorf("removable: %v", codes(p.Problems))
	}
	p = samePlan(t, "ubuntu2404-default", func(m *Manifest, tg *Target, f *Facts, c *Choices) {
		tg.Disks[0].Transport = strPtr("iscsi")
		tg.Disks[0].Serial, tg.Disks[0].EUI64 = strPtr("X"), nil
		c.AllowDevices = []string{"t0"}
	})
	if !p.OK {
		t.Errorf("allowed SAN: %v", codes(p.Problems))
	}
	// Size descending against minimum descending.
	p = samePlan(t, "nvme-two-ns", func(m *Manifest, tg *Target, f *Facts, c *Choices) {
		tg.Disks[0], tg.Disks[1] = tg.Disks[1], tg.Disks[0]
		for i := range tg.Disks {
			tg.Disks[i].EUI64, tg.Disks[i].Serial = nil, strPtr("N"+strconv.Itoa(i))
			tg.Disks[i].SizeBytes += 1 << 30
		}
	})
	bigger := "d0"
	if p.MinimumSizes.Disks[1].MinBytes > p.MinimumSizes.Disks[0].MinBytes {
		bigger = "d1"
	}
	for _, a := range p.Mapping {
		// After the swap t0 is the 1 TB disk.
		if (a.Source == bigger) != (deref(a.Target) == "t0") || deref(a.Reason) != "size" {
			t.Errorf("size order: %s -> %s (%s), the larger minimum is %s", a.Source, deref(a.Target), deref(a.Reason), bigger)
		}
	}
	// Multipath, locked, unusable.
	p = samePlan(t, "nvme-two-ns", func(m *Manifest, tg *Target, f *Facts, c *Choices) {
		tg.Disks[0].WWN, tg.Disks[1].WWN = strPtr("0x5000"), strPtr("0x5000")
	})
	if !hasFinding(p.Problems, ProblemMultipathDetected) {
		t.Errorf("multipath: %v", codes(p.Problems))
	}
	p = samePlan(t, "ubuntu2404-default", func(m *Manifest, tg *Target, f *Facts, c *Choices) {
		tg.Disks[0].IOError = true
		c.DiskMapping = map[string]string{"d0": "t0"}
	})
	if !hasFinding(p.Problems, ProblemSEDLocked) {
		t.Errorf("locked: %v", codes(p.Problems))
	}
	p = samePlan(t, "ubuntu2404-default", func(m *Manifest, tg *Target, f *Facts, c *Choices) {
		tg.Disks[0].ReadOnly = true
		c.DiskMapping = map[string]string{"d0": "t0"}
	})
	if !hasFinding(p.Problems, ProblemTargetUnusable) {
		t.Errorf("read-only: %v", codes(p.Problems))
	}
	p = samePlan(t, "ubuntu2404-default", func(m *Manifest, tg *Target, f *Facts, c *Choices) {
		c.DiskMapping = map[string]string{"d0": "t7", "d9": "t0"}
	})
	if n := strings.Count(strings.Join(codes(p.Problems), " "), ProblemMappingInvalid); n != 2 {
		t.Errorf("invalid mapping: %v", codes(p.Problems))
	}
	// A target with signatures of the manifest is never erased automatically.
	p = samePlan(t, "ubuntu2404-default", func(m *Manifest, tg *Target, f *Facts, c *Choices) {
		tg.Disks[0].Signatures = []TargetSignature{{Kind: "part_uuid", UUID: deref(m.Linux.Disks[0].Table.Partitions[1].UUID)}}
	})
	if p.Mapping[0].Action != ActionAdopt || !hasFinding(p.Problems, ProblemAdoptIncomplete) {
		t.Errorf("signatures: %+v %v", p.Mapping, codes(p.Problems))
	}
}

func TestMissingDisks(t *testing.T) {
	// RAID5 without one member runs degraded; raid0 does not.
	m := loadManifest(t, "raid5-spare")
	tg, c, _ := SyntheticTarget(m, TargetSame, nil)
	c.DiskMapping = map[string]string{"d0": "t0", "d1": "t1", "d2": "t2", "d3": "missing", "d4": "t4"}
	p, _ := Plan(m, tg, nil, c)
	if !p.OK || !hasFinding(p.Warnings, WarnMDDegradedFirstBoot) {
		t.Errorf("raid5 minus one: %v %v", codes(p.Problems), codes(p.Warnings))
	}
	c.DiskMapping = map[string]string{"d0": "t0", "d1": "t1", "d2": "missing", "d3": "missing", "d4": "t4"}
	p, _ = Plan(m, tg, nil, c)
	if !hasFinding(p.Problems, ProblemMDTooFewMembers) {
		t.Errorf("raid5 minus two: %v", codes(p.Problems))
	}
	// A disk with a file system cannot be missing.
	m = loadManifest(t, "nvme-two-ns")
	tg, c, _ = SyntheticTarget(m, TargetSame, nil)
	c.DiskMapping = map[string]string{"d0": "t0", "d1": "missing"}
	p, _ = Plan(m, tg, nil, c)
	if !hasFinding(p.Problems, ProblemTargetMissing) {
		t.Errorf("data disk missing: %v", codes(p.Problems))
	}
	// btrfs RAID1 needs all devices.
	m = loadManifest(t, "btrfs-raid1-multi")
	tg, c, _ = SyntheticTarget(m, TargetSame, nil)
	c.DiskMapping = map[string]string{"d0": "t0", "d1": "t1", "d2": "missing"}
	p, _ = Plan(m, tg, nil, c)
	if !hasFinding(p.Problems, ProblemBtrfsRaidMissingDevice) {
		t.Errorf("btrfs: %v", codes(p.Problems))
	}
	// An LVM raid LV needs all its PVs.
	m = loadManifest(t, "plan-mixed-vg")
	m.Linux.LVM.VGs[0].LVs[0].Type = "raid1"
	tg, c, _ = SyntheticTarget(m, TargetSame, nil)
	c.DiskMapping = map[string]string{"d0": "t0", "d1": "missing"}
	p, _ = Plan(m, tg, nil, c)
	if !hasFinding(p.Problems, ProblemLVMRaidMissingPV) {
		t.Errorf("lvm raid: %v", codes(p.Problems))
	}
}

func TestIdentityConflict(t *testing.T) {
	p := samePlan(t, "debian12-uefi-luks-lvm", func(m *Manifest, tg *Target, f *Facts, c *Choices) {
		tg.Others = []TargetDisk{{ID: "o0", Path: "/dev/sdz", SizeBytes: 1, LogicalSectorSize: 512, PhysicalSectorSize: 512,
			Signatures: []TargetSignature{{Kind: "luks", UUID: strings.ToUpper(m.Linux.LUKS[0].UUID)}}}}
	})
	if !hasFinding(p.Problems, ProblemIdentityConflict) || deref(p.Problems[0].Ref) != "o0" {
		t.Errorf("conflict: %v", codes(p.Problems))
	}
	if normUUID("a1b2c3d4:e5f60718:293a4b5c:6d7e8f90") != normUUID("A1B2C3D4-E5F6-0718-293A-4B5C6D7E8F90") {
		t.Error("md UUID notations")
	}
}

func TestDrivers(t *testing.T) {
	alias := ParseModulesAlias("# comment\nalias pci:v*d*sv*sd*bc01sc08i02* nvme\nalias pci:v00001000d000000A5sv*sd*bc*sc*i* mpi3mr\nalias usb:v1234* usb-storage\nnonsense\n")
	if len(alias) != 3 || alias[2].module != "usb_storage" {
		t.Fatalf("aliases %+v", alias)
	}
	k := newKernelIndex(KernelFacts{Version: "6.1", ModulesAlias: "alias pci:v*d*sv*sd*bc01sc08i02* nvme\n",
		ModulesBuiltin: "kernel/drivers/ata/ahci.ko\n", ModulesBuiltinModinfo: "ahci.alias=pci:v*d*sv*sd*bc01sc06i01*\nahci.file=x\n"},
		[]DKMSModule{{Module: "r8125", Kernel: "6.1", Kind: "net"}})
	if mod, builtin, ok := k.match(modaliasAHCI, nil); !ok || !builtin || mod != "ahci" {
		t.Errorf("builtin ahci: %s %v %v", mod, builtin, ok)
	}
	if mod, _, ok := k.match(modaliasNVMe, nil); !ok || mod != "nvme" {
		t.Errorf("nvme: %s", mod)
	}
	if mod, _, ok := k.match("pci:v000010ECd00008125sv*", []string{"r8125"}); !ok || mod != "r8125" {
		t.Errorf("dkms: %s %v", mod, ok)
	}
	if _, _, ok := k.match("pci:v00001000d000000A5sv00001000sd00004620bc01sc04i00", []string{"mpi3mr"}); ok {
		t.Error("mpi3mr found")
	}
	if !isBridge("pci:v00008086d0000A33Csv00008086sd00007270bc06sc04i00") || isBridge(modaliasNVMe) {
		t.Error("bridge")
	}
	// Default kernel missing a driver: problem; fallback: warning; other controller: warning.
	m := loadManifest(t, "debian12-uefi-luks-lvm")
	f := readFacts(t, "debian12-uefi-luks-lvm")
	f.Kernels = append(f.Kernels, KernelFacts{Version: "6.1.0-26-amd64", ModulesAlias: "alias pci:v*d*sv*sd*bc01sc06i01* ahci\n"})
	tg, _, _ := SyntheticTarget(m, TargetSame, f)
	_, fs := CheckDrivers(m, f, tg, []string{"t0"}, false)
	if !hasFinding(fs, WarnFallbackKernelDriverMissing) || hasFinding(fs, ProblemStorageDriverMissing) {
		t.Errorf("fallback: %v", codes(fs))
	}
	f.Kernels[0].ModulesAlias = "alias pci:v*d*sv*sd*bc01sc06i01* ahci\n"
	if _, fs := CheckDrivers(m, f, tg, []string{"t0"}, false); !hasFinding(fs, ProblemStorageDriverMissing) || !hasFinding(fs, WarnNICDriverMissing) {
		t.Errorf("default: %v", codes(fs))
	}
	if _, fs := CheckDrivers(m, f, tg, []string{"t0"}, true); !hasFinding(fs, WarnOtherControllerDriverMissing) || hasFinding(fs, ProblemStorageDriverMissing) {
		t.Errorf("other controller: %v", codes(fs))
	}
	if _, fs := CheckDrivers(m, nil, tg, []string{"t0"}, false); !hasFinding(fs, WarnDriverFactsMissing) {
		t.Errorf("no facts: %v", codes(fs))
	}
}

func TestSecureBootChain(t *testing.T) {
	m := loadManifest(t, "debian12-uefi-luks-lvm")
	base := func() *Target {
		tg, _, _ := SyntheticTarget(m, TargetSame, nil)
		tg.Firmware.DBX = &TargetDBX{Hashes: []string{}, Certs: []string{}}
		return tg
	}
	tg := base()
	cc, fs := CheckChain(m, tg, nil, Choices{})
	if !cc.Checked || len(fs) != 0 {
		t.Errorf("same firmware: %v", codes(fs))
	}
	tg.Firmware.DBX = nil
	if _, fs := CheckChain(m, tg, nil, Choices{}); !hasFinding(fs, WarnSecureBootDBXUnknown) {
		t.Errorf("dbx unknown: %v", codes(fs))
	}
	tg = base()
	tg.Firmware.DBX.Certs = []string{m.Linux.Firmware.DB[0].SHA256}
	if _, fs := CheckChain(m, tg, nil, Choices{}); !hasFinding(fs, ProblemSecureBootRevoked) {
		t.Errorf("revoked CA: %v", codes(fs))
	}
	tg = base()
	tg.Firmware.SbatLevel = []string{"sbat,1,2025", "grub,5"}
	cc, fs = CheckChain(m, tg, nil, Choices{})
	if !hasFinding(fs, ProblemSecureBootSbatRevoked) {
		t.Errorf("sbat: %v", codes(fs))
	}
	for _, l := range cc.Loaders {
		if strings.HasSuffix(l.Path, "grubx64.efi") && (l.Verdict != "sbat_revoked" || deref(l.Detail) != "grub,4") {
			t.Errorf("grub verdict %+v", l)
		}
	}
	// Turned off: one warning instead of the problems.
	tg.Firmware.DB = nil
	if _, fs := CheckChain(m, tg, nil, Choices{SecureBootOff: true}); len(fs) != 1 || fs[0].Code != WarnSecureBootDisabledByChoice {
		t.Errorf("off: %v", codes(fs))
	}
	// Secure Boot off on the target: nothing to check.
	tg = base()
	tg.Firmware.SecureBoot = boolPtr(false)
	if cc, fs := CheckChain(m, tg, nil, Choices{}); cc.Checked || len(fs) != 0 {
		t.Error("checked without Secure Boot")
	}
	// systemd-boot without shim, unsigned, on a Secure Boot target.
	am := loadManifest(t, "arch-sdboot-uki")
	atg, _, _ := SyntheticTarget(am, TargetSame, nil)
	atg.Firmware.SecureBoot = boolPtr(true)
	if _, fs := CheckChain(am, atg, nil, Choices{}); !hasFinding(fs, WarnSecureBootUnsignedChain) || hasFinding(fs, ProblemSecureBootCAMissing) {
		t.Errorf("unsigned: %v", codes(fs))
	}
}

func TestMOK(t *testing.T) {
	m := loadManifest(t, "example-debian12-uefi-luks-lvm")
	l := m.Linux
	mok := l.Firmware.MOK[0]
	l.Kernels[0].Signer = strPtr("DKMS module signing key")
	tg, _, _ := SyntheticTarget(m, TargetSame, nil)
	tg.Firmware.DBX = &TargetDBX{Hashes: []string{}, Certs: []string{}}
	if _, fs := CheckChain(m, tg, nil, Choices{}); hasFinding(fs, ProblemMokKeyMissing) {
		t.Errorf("enrolled: %v", codes(fs))
	}
	tg.Firmware.MokList = nil
	if _, fs := CheckChain(m, tg, nil, Choices{}); !hasFinding(fs, ProblemMokKeyMissing) {
		t.Errorf("kernel key missing: %v", codes(fs))
	}
	f := &Facts{Format: FactsFormat, MokFiles: []MokFileFact{{Path: "/var/lib/dkms/mok.pub", Present: true, SHA256: strPtr(mok.SHA256)}}}
	if _, fs := CheckChain(m, tg, f, Choices{}); !hasFinding(fs, WarnMokEnrollRequired) || hasFinding(fs, ProblemMokKeyMissing) {
		t.Errorf("enroll: %v", codes(fs))
	}
	// A DKMS module that is neither net nor storage: a warning only.
	l.Kernels[0].Signer = nil
	l.DKMS = []DKMSModule{{Module: "vboxdrv", Version: "7", Kernel: l.Kernels[0].Version, Signer: strPtr("DKMS module signing key"), Kind: "other"}}
	if _, fs := CheckChain(m, tg, nil, Choices{}); hasFinding(fs, ProblemMokKeyMissing) || !hasFinding(fs, WarnMokEnrollRequired) {
		t.Errorf("dkms other: %v", codes(fs))
	}
	l.DKMS[0].Kind = "storage"
	if _, fs := CheckChain(m, tg, nil, Choices{}); !hasFinding(fs, ProblemMokKeyMissing) {
		t.Errorf("dkms storage: %v", codes(fs))
	}
}

func TestMkfsArgs(t *testing.T) {
	m := loadManifest(t, "debian12-uefi-luks-lvm")
	boot := m.Linux.Filesystems[1]
	boot.Ext.BlockSize = 1024
	boot.Label = strPtr("-boot")
	args, fs := MkfsArgs(boot, []string{"/dev/sda2"}, 4096, 1<<30, 65536)
	got := strings.Join(args, " ")
	if !strings.Contains(got, "-b 4096") || !hasFinding(fs, WarnExtBlockSizeRaised) || strings.Contains(got, "needs_recovery") {
		t.Errorf("ext: %s %v", got, codes(fs))
	}
	for i, a := range args {
		if a == "-L" && args[i+1] != "-boot" {
			t.Errorf("label not a separate argument: %q", args)
		}
	}
	boot.Ext.Features = append(boot.Ext.Features, "stunt_mode")
	if _, fs := MkfsArgs(boot, []string{"/dev/sda2"}, 512, 1<<30, 0); !hasFinding(fs, ProblemMkfsFeatureUnknown) {
		t.Errorf("unknown feature accepted")
	}
	xfs := Filesystem{ID: "f9", Type: "xfs", UUID: strPtr("u"), XFS: &XFSInfo{BlockSize: 4096, SectorSize: 512, Features: []string{"crc", "finobt", "sparse", "ftype", "nrext64"}, LogBytes: 64 * mib}}
	args, _ = MkfsArgs(xfs, []string{"/dev/x"}, 4096, 1<<40, 0)
	got = strings.Join(args, " ")
	for _, want := range []string{"-m uuid=u,crc=1,finobt=1,rmapbt=0,reflink=0,bigtime=0,inobtcount=0", "-i size=512,sparse=1,nrext64=1", "-n ftype=1", "-s size=4096", "-l size=65536k"} {
		if !strings.Contains(got, want) {
			t.Errorf("xfs: %q lacks %q", got, want)
		}
	}
	xfs.XFS.BlockSize = 1024
	if _, fs := MkfsArgs(xfs, []string{"/dev/x"}, 4096, 1<<40, 0); !hasFinding(fs, ProblemSectorSizeIncompatible) {
		t.Errorf("xfs 1k on 4Kn: %v", codes(fs))
	}
	bt := Filesystem{ID: "f8", Type: "btrfs", UUID: strPtr("b"), Btrfs: &BtrfsInfo{NodeSize: 16384, SectorSize: 4096, DataProfile: "raid1", MetadataProfile: "raid1",
		Features: []string{"mixed_backref", "extended_iref", "skinny_metadata", "free_space_tree", "free_space_tree_valid", "compress_zstd"}}}
	args, fs = MkfsArgs(bt, []string{"/dev/a", "/dev/b"}, 512, 1<<40, 0)
	got = strings.Join(args, " ")
	if !strings.Contains(got, "--csum crc32c") || !hasFinding(fs, WarnBtrfsCsumAssumed) || !strings.Contains(got, "-O extref,free-space-tree,skinny-metadata,^no-holes") ||
		!strings.HasSuffix(got, "-d raid1 -m raid1 /dev/a /dev/b") {
		t.Errorf("btrfs: %s %v", got, codes(fs))
	}
	bt.Btrfs.Csum = strPtr("xxhash")
	bt.Btrfs.Features = append(bt.Btrfs.Features, "verity_magic")
	args, fs = MkfsArgs(bt, []string{"/dev/a"}, 512, 1<<40, 0)
	if !strings.Contains(strings.Join(args, " "), "--csum xxhash") || !hasFinding(fs, ProblemMkfsFeatureUnknown) {
		t.Errorf("btrfs xxhash: %v", codes(fs))
	}
	esp := m.Linux.Filesystems[0]
	args, fs = MkfsArgs(esp, []string{"/dev/a1"}, 4096, 260*mib, 0)
	if got := strings.Join(args, " "); !strings.Contains(got, "-S 4096 -s 1") || !hasFinding(fs, WarnVFATSectorSizeChanged) {
		t.Errorf("vfat 4Kn: %s", got)
	}
	args, _ = MkfsArgs(Filesystem{ID: "swap", Type: "swap", UUID: strPtr("s")}, []string{"/dev/s"}, 0, 0, 0)
	if strings.Join(args, " ") != "mkswap -U s /dev/s" {
		t.Errorf("swap: %q", args)
	}
	if _, fs := MkfsArgs(Filesystem{ID: "f7", Type: "ntfs"}, nil, 512, 0, 0); !hasFinding(fs, ProblemMkfsUnsupportedType) {
		t.Error("ntfs")
	}
	if n := extInodes(&ExtInfo{InodeCount: 1000, BlockSize: 4096}, 1<<30, 2<<30, 100); n != 2000 {
		t.Errorf("inodes scaled: %d", n)
	}
	if n := extInodes(&ExtInfo{InodeCount: 1000, BlockSize: 4096}, 1<<30, 1<<29, 900); n != 1080 {
		t.Errorf("inodes used: %d", n)
	}
}

func TestPlanSteps(t *testing.T) {
	p := samePlan(t, "debian12-uefi-luks-lvm", nil)
	var kinds []string
	for _, s := range p.Steps {
		kinds = append(kinds, s.Kind)
		if s.Kind == "luks_format" && deref(s.StdinSecret) != "passphrase" {
			t.Error("luks_format without passphrase on stdin")
		}
	}
	want := "release_holders wipe zero_range partition luks_format luks_open luks_refresh pv_create vg_create lv_create lv_create lv_create mkfs mkfs mkfs mkfs mkswap mount mount mount mount restore mkdirs"
	if !strings.HasPrefix(strings.Join(kinds, " "), want) {
		t.Errorf("steps %v", kinds)
	}
	// --snapshot fills the token.
	m := loadManifest(t, "debian12-uefi-luks-lvm")
	tg, c, _ := SyntheticTarget(m, TargetSame, nil)
	p, _ = PlanWith(m, tg, nil, c, PlanOptions{Snapshot: "abcdef01"})
	b, _ := EncodePlan(p)
	if bytes.Contains(b, []byte("{snapshot}")) || !bytes.Contains(b, []byte(`"abcdef01"`)) {
		t.Error("snapshot token")
	}
	// A partition name with quotes gets its own step.
	m.Linux.Disks[0].Table.Partitions[0].Name = strPtr(`EFI "x" \ y`)
	p, _ = Plan(m, tg, nil, c)
	found := false
	for _, s := range p.Steps {
		if s.Kind == "partition" && strings.Contains(*s.Stdin, `"x"`) {
			t.Errorf("name in the script: %q", *s.Stdin)
		}
		if s.Kind == "part_label" && s.Args[len(s.Args)-1] == `EFI "x" \ y` {
			found = true
		}
	}
	if !found {
		t.Error("no part_label step")
	}
}

func TestParseInputs(t *testing.T) {
	good := `{"format":"restow-plan-facts-v1","kernels":[{"version":"6.1","default":true,"modulesAlias":"alias a b\n","modulesBuiltin":"","modulesBuiltinModinfo":""}],"restoreSizes":{"/":{"bytes":1,"files":1,"inodes":1}},"mokFiles":[]}`
	if _, err := ParseFacts([]byte(good)); err != nil {
		t.Fatal(err)
	}
	for name, bad := range map[string]string{
		"format":    strings.Replace(good, "facts-v1", "facts-v9", 1),
		"missing":   strings.Replace(good, `"mokFiles":[]`, `"x":[]`, 1),
		"control":   strings.Replace(good, `alias a b`, "alias a \\u001b", 1),
		"negative":  strings.Replace(good, `"bytes":1`, `"bytes":-1`, 1),
		"float":     strings.Replace(good, `"bytes":1`, `"bytes":1.5`, 1),
		"kernelkey": strings.Replace(good, `"modulesBuiltin":"",`, ``, 1),
		"badkey":    strings.Replace(good, `"/":`, `"/\u0007":`, 1),
	} {
		if _, err := ParseFacts([]byte(bad)); err == nil {
			t.Errorf("facts %s accepted", name)
		}
	}
	if _, err := ParseFacts(make([]byte, MaxFactsBytes+1)); err != ErrInputTooLarge {
		t.Errorf("cap: %v", err)
	}
	m := loadManifest(t, "debian12-uefi-luks-lvm")
	tg, _, _ := SyntheticTarget(m, TargetSame, nil)
	b, _ := encodeSorted(tg)
	if _, err := ParseTarget(b); err != nil {
		t.Fatal(err)
	}
	for name, bad := range map[string]string{
		"path":   strings.Replace(string(b), `"/dev/nvme0n1"`, `"/etc/passwd"`, 1),
		"sector": strings.Replace(string(b), `"logicalSectorSize":512`, `"logicalSectorSize":513`, 1),
		"mode":   strings.Replace(string(b), `"mode":"uefi"`, `"mode":"coreboot"`, 1),
		"format": strings.Replace(string(b), TargetFormat, "x", 1),
		"string": strings.Replace(string(b), `"t0"`, `"t0\u001b"`, 1),
	} {
		if _, err := ParseTarget([]byte(bad)); err == nil {
			t.Errorf("target %s accepted", name)
		}
	}
	if _, err := ParseChoices([]byte(`{"shrink":"all"}`)); err == nil {
		t.Error("choices shrink")
	}
	if c, err := ParseChoices([]byte(`{"diskMapping":{"d0":"t0"},"rawLvs":"create","future":1}`)); err != nil || c.RawLVs != "create" {
		t.Errorf("choices: %v", err)
	}
}

// TestPlannerImports: the planner files import nothing that runs programs
// or touches the file system (docs/BAREMETAL.md 12.2: the server runs the
// planner on data from a backup).
func TestPlannerImports(t *testing.T) {
	files := []string{"plan.go", "plan_codes.go", "facts.go", "target.go", "sizing.go", "mapping.go", "drivers.go", "secureboot.go", "mkfs.go", "fixups.go",
		"manifest.go", "canonical.go", "validate.go", "sanitize.go", "fingerprint.go", "assess.go", "pe.go"}
	forbidden := map[string]bool{"os": true, "os/exec": true, "syscall": true, "net": true, "net/http": true, "io/fs": true, "path/filepath": true,
		"github.com/restow-backup/restow/agent/internal/cmdrun": true, "unsafe": true, "plugin": true}
	fset := token.NewFileSet()
	for _, name := range files {
		f, err := parser.ParseFile(fset, name, nil, parser.ImportsOnly)
		if err != nil {
			t.Fatal(err)
		}
		for _, imp := range f.Imports {
			p, _ := strconv.Unquote(imp.Path.Value)
			if forbidden[p] {
				t.Errorf("%s imports %s", name, p)
			}
		}
	}
}

// lvCreateArgs are the lvcreate steps of a plan by LV name.
func lvCreateArgs(p *RestorePlan) map[string]string {
	out := map[string]string{}
	for _, s := range p.Steps {
		if s.Kind == "lv_create" {
			target := deref(s.Target)
			out[target[strings.LastIndexByte(target, '/')+1:]] = strings.Join(s.Args, " ")
		}
	}
	return out
}

func TestLVMRaid(t *testing.T) {
	ext := 4 * mib
	lv := func(typ string, images int64) *LogicalVolume {
		return &LogicalVolume{Name: "x", Type: typ, Stripes: &images, StripeBytes: intPtr(64 * 1024)}
	}
	// Footprint: every image, its rmeta extent; usable back from the footprint.
	for _, c := range []struct {
		typ    string
		images int64
		size   int64
		want   int64
		args   string
	}{
		{"raid1", 2, 10 * gib, 2 * (10*gib + ext), "--type raid1 -m 1"},
		{"mirror", 3, 10 * gib, 3 * (10*gib + ext), "--type raid1 -m 2"},
		{"raid0", 2, 10 * gib, 10 * gib, "--type raid0 -i 2 -I 64k"},
		{"raid5", 3, 10 * gib, 3 * (5*gib + ext), "--type raid5 -i 2 -I 64k"},
		{"raid5_ls", 4, 12 * gib, 4 * (4*gib + ext), "--type raid5_ls -i 3 -I 64k"},
		{"raid6", 5, 12 * gib, 5 * (4*gib + ext), "--type raid6 -i 3 -I 64k"},
		{"raid10", 4, 10 * gib, 4 * (5*gib + ext), "--type raid10 -i 2 -m 1 -I 64k"},
	} {
		l := lv(c.typ, c.images)
		if got := lvFootprint(l, c.size, ext); got != c.want {
			t.Errorf("%s footprint %d, want %d", c.typ, got, c.want)
		}
		if got := lvUsable(l, c.want, ext); got != c.size {
			t.Errorf("%s usable %d, want %d", c.typ, got, c.size)
		}
		if got := strings.Join(raidSizeArgs(l), " "); got != c.args {
			t.Errorf("%s args %q, want %q", c.typ, got, c.args)
		}
	}
	// Image counts LVM cannot create, unknown types: no geometry.
	for _, l := range []*LogicalVolume{lv("raid1", 1), lv("raid5", 2), lv("raid6", 4), lv("raid10", 5), lv("raid0", 1), lv("raid7", 4), {Type: "raid1"}} {
		if _, ok := lvmRaidOf(l); ok {
			t.Errorf("%s with %v images has a geometry", l.Type, l.Stripes)
		}
	}

	// The reviewer's case: root raid0 and home raid1 on the two PVs of
	// plan-mixed-vg. The minimum disks hold every image, the plan creates
	// the RAID types on the PVs it chose, and a minimal target plans.
	edit := func(m *Manifest) {
		lvs := m.Linux.LVM.VGs[0].LVs
		lvs[0].Type, lvs[0].Stripes = "raid0", intPtr(2)
		lvs[2].Type, lvs[2].Stripes = "raid1", intPtr(2)
	}
	m := loadManifest(t, "plan-mixed-vg")
	edit(m)
	f := readFacts(t, "plan-mixed-vg")
	x := newLayoutModel(m, f, "skip")
	vg := &m.Linux.LVM.VGs[0]
	root, swap, home := x.lvMinimum(vg, &vg.LVs[0]), x.lvMinimum(vg, &vg.LVs[1]), x.lvMinimum(vg, &vg.LVs[2])
	need := root + swap + 2*(home+ext) // raid0 has no rmeta
	var sum int64
	for _, pv := range x.vgPVs[vg.Name] {
		sum += x.pvShare(pv)
	}
	if sum < need {
		t.Errorf("PV shares %d below the footprint %d", sum, need)
	}
	for _, kw := range []string{TargetSame, TargetMinimal} {
		tg, c, err := SyntheticTarget(m, kw, f)
		if err != nil {
			t.Fatal(err)
		}
		p, _ := Plan(m, tg, f, c)
		if !p.OK {
			t.Errorf("%s: %v", kw, codes(p.Problems))
		}
		args := lvCreateArgs(p)
		if !strings.Contains(args["root"], "--type raid0 -i 2 ") || !strings.Contains(args["home"], "--type raid1 -m 1 ") {
			t.Errorf("%s: lvcreate %v", kw, args)
		}
		for _, name := range []string{"root", "home"} {
			if fields := strings.Fields(args[name]); len(fields) < 2 || !strings.HasPrefix(fields[len(fields)-1], "/dev/") || !strings.HasPrefix(fields[len(fields)-2], "/dev/") {
				t.Errorf("%s: %s without its PVs: %s", kw, name, args[name])
			}
		}
	}
	var diskMin int64
	tg, c, _ := SyntheticTarget(m, TargetMinimal, f)
	p, _ := Plan(m, tg, f, c)
	for _, d := range p.MinimumSizes.Disks {
		diskMin += d.MinBytes
	}
	if diskMin < need {
		t.Errorf("disk minimums %d below the footprint %d", diskMin, need)
	}

	// A RAID LV without its image count is never planned as a linear LV.
	m = loadManifest(t, "plan-mixed-vg")
	m.Linux.LVM.VGs[0].LVs[0].Type = "raid5"
	tg, c, _ = SyntheticTarget(m, TargetSame, f)
	p, _ = Plan(m, tg, f, c)
	if p.OK || !hasFinding(p.Problems, ProblemLayoutUnsupported) || deref(p.Problems[0].Ref) != "almalinux/root" {
		t.Errorf("unknown geometry: %v", codes(p.Problems))
	}
	if _, created := lvCreateArgs(p)["root"]; created {
		t.Error("raid5 LV without its image count created")
	}

	// Images that do not fit on distinct PVs although the total does: the
	// root image takes the room the third home image needs.
	m = loadManifest(t, "plan-lvm-raid")
	x = newLayoutModel(m, readFacts(t, "plan-lvm-raid"), "skip")
	vg = &m.Linux.LVM.VGs[0]
	sizes := map[string]int64{"root": 21 * gib, "swap": 8 * gib, "home": 46 * gib}
	if _, _, ok := x.raidPlacement(vg, sizes, []int64{100 * gib, 25 * gib, 25 * gib}); ok {
		t.Error("raid5 placed on a PV without room")
	}
	assign, load, ok := x.raidPlacement(vg, sizes, []int64{50 * gib, 50 * gib, 50 * gib})
	if !ok || len(assign["root"]) != 2 || len(assign["home"]) != 3 || load[0]+load[1]+load[2] != 2*(21*gib+ext)+3*(23*gib+ext) {
		t.Errorf("placement %v %v %v", assign, load, ok)
	}
}
