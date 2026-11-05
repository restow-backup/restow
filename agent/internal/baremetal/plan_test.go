package baremetal

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"
)

// Golden files of the planner (docs/BAREMETAL.md 21.1, contract C-M2-9):
// testdata/facts/<manifest>.json, testdata/targets/<scenario>.json,
// testdata/choices/<scenario>.json and testdata/plans/<manifest>.<scenario>.json.
// `go test -run 'TestManifests|TestPlan' -update` rewrites them (the
// synthetic plan-*.json manifests come from TestManifests).

const (
	factsDir   = "testdata/facts"
	targetsDir = "testdata/targets"
	choicesDir = "testdata/choices"
	plansDir   = "testdata/plans"
)

// loadManifest reads a manifest of the shared test data.
func loadManifest(t testing.TB, name string) *Manifest {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(manifestDir, name+".json"))
	if err != nil {
		t.Fatal(err)
	}
	m, err := Decode(b)
	if err != nil {
		t.Fatalf("%s: %v", name, err)
	}
	return m
}

// linuxManifests are the valid Linux manifests of the shared test data.
func linuxManifests(t testing.TB) []string {
	t.Helper()
	files, _ := filepath.Glob(filepath.Join(manifestDir, "*.json"))
	var out []string
	for _, p := range files {
		name := strings.TrimSuffix(filepath.Base(p), ".json")
		if strings.HasPrefix(name, "invalid-") {
			continue
		}
		b, _ := os.ReadFile(p)
		if bytes.Contains(b, []byte(`"platform":"linux"`)) {
			out = append(out, name)
		}
	}
	sort.Strings(out)
	return out
}

// ---------------------------------------------------------------------------
// Synthetic manifests for the planner (written by TestManifests -update)
// ---------------------------------------------------------------------------

func capturedManifest(name string) *Manifest {
	b, err := os.ReadFile(filepath.Join(captureDir, name, "expected.json"))
	if err != nil {
		panic(err)
	}
	m, err := Decode(bytes.TrimSpace(b))
	if err != nil {
		panic(err)
	}
	return m
}

// planExamples are the synthetic manifests of the planner scenarios.
func planExamples() map[string]*Manifest {
	out := map[string]*Manifest{}

	// A 480 GB SATA SSD with a 100 MiB ESP (480 to 500 GB and back, 4Kn).
	m := capturedManifest("ubuntu2404-default")
	d := &m.Linux.Disks[0]
	d.SizeBytes = 480103981056
	d.KName = "sda"
	d.Transport = strPtr("sata")
	d.Model = strPtr("SSD 480GB")
	d.Serial, d.EUI64, d.NSID = strPtr("PLAN480"), nil, nil
	d.WWN = strPtr("0x5002538e40a1b2c3")
	d.DriverChain = []string{"sd", "ahci"}
	d.DriverModaliases = []string{"pci:v00008086d0000A352sv00001028sd0000085Abc01sc06i01"}
	parts := d.Table.Partitions
	parts[0].SizeBytes = 100 * mib
	parts[1].StartBytes = parts[0].StartBytes + parts[0].SizeBytes
	parts[1].SizeBytes = alignDown(d.SizeBytes-mib-parts[1].StartBytes, mib)
	d.Table.LastLBA = intPtr(d.SizeBytes/512 - 34)
	for i := range m.Linux.Filesystems {
		fs := &m.Linux.Filesystems[i]
		if fs.Type == "vfat" {
			fs.SizeBytes = 100 * mib
		} else {
			fs.SizeBytes = parts[1].SizeBytes - parts[1].SizeBytes/20
		}
	}
	for i := range m.Linux.Mounts {
		m.Linux.Mounts[i].Source = strings.ReplaceAll(strings.ReplaceAll(m.Linux.Mounts[i].Source, "nvme0n1p", "sda"), "nvme0n1", "sda")
	}
	m.Linux.DeviceNameRefs = []DeviceNameRef{}
	m.Linux.Raw = []RawRef{}
	out["plan-480gb"] = m

	// MBR with partitions starting at sector 63 (old installations).
	m = capturedManifest("bios-mbr-mdadm-raid1")
	for i := range m.Linux.Disks {
		p := &m.Linux.Disks[i].Table.Partitions[0]
		end := p.StartBytes + p.SizeBytes
		p.StartBytes = 63 * 512
		p.SizeBytes = end - p.StartBytes
		m.Linux.Disks[i].Table.FirstLBA = intPtr(63)
	}
	m.Linux.Raw = []RawRef{}
	out["plan-mbr-start63"] = m

	// A VG over two disks (mixed block sizes on the target).
	mixed := func(xfsBlock int64) *Manifest {
		m := capturedManifest("alma9-xfs-lvm-devices")
		l := m.Linux
		d0 := l.Disks[0]
		d1 := d0
		d1.ID, d1.KName, d1.MajMin = "d1", "sdb", "8:16"
		d1.Serial = strPtr("PLANMIXED1")
		d1.WWN = strPtr("0x5002538e40a1b2d4")
		d1.SizeBytes = 256060514304
		tbl := *d0.Table
		tbl.ID = "D1D1D1D1-0000-4000-8000-000000000001"
		tbl.Partitions = []Partition{{Number: 1, StartBytes: mib, SizeBytes: 256000000000, Type: "E6D6D379-F507-44C2-A23C-238F2A3DF928",
			UUID: strPtr("d1d1d1d1-0000-4000-8000-000000000011"), Attrs: ""}}
		d1.Table = &tbl
		d1.DriverChain = append([]string{}, d0.DriverChain...)
		d1.DriverModaliases = append([]string{}, d0.DriverModaliases...)
		l.Disks = append(l.Disks, d1)
		vg := &l.LVM.VGs[0]
		pv := PV{Device: PartRef("d1", 1), UUID: "pvmixed-0001", SizeBytes: alignDown(256000000000-mib, vg.ExtentBytes), VG: strPtr(vg.Name)}
		l.LVM.PVs = append(l.LVM.PVs, pv)
		vg.SizeBytes += pv.SizeBytes
		vg.FreeBytes += pv.SizeBytes
		if xfsBlock > 0 {
			for i := range l.Filesystems {
				if fs := &l.Filesystems[i]; fs.Type == "xfs" && len(fs.Devices) > 0 && fs.Devices[0].Kind == RefLV && fs.Devices[0].LV == "home" {
					fs.XFS.BlockSize = xfsBlock
				}
			}
		}
		l.Raw = []RawRef{}
		return m
	}
	out["plan-mixed-vg"] = mixed(0)
	out["plan-mixed-vg-xfs1k"] = mixed(1024)

	// LVM RAID LVs over three PVs: root raid1 (two images), home raid5
	// (three images, 64 KiB stripes), swap linear.
	m = mixed(0)
	{
		l := m.Linux
		d2 := l.Disks[1]
		d2.ID, d2.KName, d2.MajMin = "d2", "sdc", "8:32"
		d2.Serial = strPtr("PLANRAID2")
		d2.WWN = strPtr("0x5002538e40a1b2e5")
		tbl := *l.Disks[1].Table
		tbl.ID = "D2D2D2D2-0000-4000-8000-000000000002"
		tbl.Partitions = []Partition{{Number: 1, StartBytes: mib, SizeBytes: 256000000000, Type: "E6D6D379-F507-44C2-A23C-238F2A3DF928",
			UUID: strPtr("d2d2d2d2-0000-4000-8000-000000000021"), Attrs: ""}}
		d2.Table = &tbl
		d2.DriverChain = append([]string{}, l.Disks[1].DriverChain...)
		d2.DriverModaliases = append([]string{}, l.Disks[1].DriverModaliases...)
		l.Disks = append(l.Disks, d2)
		vg := &l.LVM.VGs[0]
		pv := PV{Device: PartRef("d2", 1), UUID: "pvraid-0002", SizeBytes: alignDown(256000000000-mib, vg.ExtentBytes), VG: strPtr(vg.Name)}
		l.LVM.PVs = append(l.LVM.PVs, pv)
		vg.SizeBytes += pv.SizeBytes
		ext := vg.ExtentBytes
		var used int64
		for i := range vg.LVs {
			lv := &vg.LVs[i]
			switch lv.Name {
			case "root":
				lv.Type, lv.Stripes, lv.UUID = "raid1", intPtr(2), "lvar-raid1"
			case "home":
				lv.Type, lv.Stripes, lv.StripeBytes, lv.UUID = "raid5", intPtr(3), intPtr(64*1024), "lvah-raid5"
				lv.SizeBytes = alignDown(lv.SizeBytes, 2*ext)
			}
			used += lvFootprint(lv, lv.SizeBytes, ext)
		}
		vg.FreeBytes = vg.SizeBytes - used
		for i := range l.Filesystems {
			if fs := &l.Filesystems[i]; len(fs.Devices) > 0 && fs.Devices[0].Kind == RefLV && fs.Devices[0].LV == "home" {
				fs.SizeBytes = vg.LVs[2].SizeBytes
			}
		}
		l.Raw = []RawRef{}
	}
	out["plan-lvm-raid"] = m
	for name, m := range out {
		v, u := Assess(m)
		m.Linux.Verdict, m.Linux.Unsupported = v, u
		_ = name
	}
	return out
}

// ---------------------------------------------------------------------------
// Facts (C-M2-2) generated from a manifest
// ---------------------------------------------------------------------------

var standardAliases = []string{
	"alias pci:v*d*sv*sd*bc01sc08i02* nvme",
	"alias pci:v*d*sv*sd*bc01sc06i01* ahci",
	"alias virtio:d00000002v* virtio_blk",
	"alias virtio:d00000008v* virtio_scsi",
	"alias virtio:d00000001v* virtio_net",
	"alias pci:v00001AF4d*sv*sd*bc*sc*i* virtio_pci",
	"alias pci:v00001000d00000097sv*sd*bc*sc*i* mpt3sas",
	"alias pci:v00009005d0000028Fsv*sd*bc*sc*i* smartpqi",
	"alias pci:v00008086d00001533sv*sd*bc*sc*i* igb",
	"alias pci:v00008086d000015B8sv*sd*bc*sc*i* e1000e",
	"alias pci:v000010ECd00008168sv*sd*bc*sc*i* r8169",
	"alias scsi:t-0x00* sd_mod",
}

// factsFor builds the facts of a manifest: the module lists of its
// default and fallback kernel (Fedora with ahci built in) and restore
// sizes from the space in use (btrfs with compression: twice that).
func factsFor(m *Manifest) *Facts {
	l := m.Linux
	f := &Facts{Format: FactsFormat, Kernels: []KernelFacts{}, RestoreSizes: map[string]RestoreSize{}, MokFiles: []MokFileFact{}}
	var kernels []Kernel
	for _, k := range l.Kernels {
		if k.Default {
			kernels = append([]Kernel{k}, kernels...)
		} else if len(kernels) < 2 {
			kernels = append(kernels, k)
		}
	}
	if len(kernels) > 2 {
		kernels = kernels[:2]
	}
	for i, k := range kernels {
		aliases := append([]string{"# Aliases extracted from modules themselves."}, standardAliases...)
		builtin := []string{"kernel/drivers/scsi/scsi_mod.ko", "kernel/drivers/block/loop.ko"}
		modinfo := []string{"scsi_mod.file=drivers/scsi/scsi_mod", "loop.alias=devname:loop-control"}
		if strings.Contains(k.Version, ".fc") {
			kept := aliases[:0:0]
			for _, a := range aliases {
				if !strings.HasSuffix(a, " ahci") {
					kept = append(kept, a)
				}
			}
			aliases = kept
			builtin = append(builtin, "kernel/drivers/ata/ahci.ko", "kernel/drivers/ata/libahci.ko")
			modinfo = append(modinfo, "ahci.alias=pci:v*d*sv*sd*bc01sc06i01*", "ahci.file=drivers/ata/ahci")
		}
		f.Kernels = append(f.Kernels, KernelFacts{Version: k.Version, Default: i == 0, ModulesAlias: strings.Join(aliases, "\n") + "\n",
			ModulesBuiltin: strings.Join(builtin, "\n") + "\n", ModulesBuiltinModinfo: strings.Join(modinfo, "\n") + "\n"})
	}
	x := newLayoutModel(m, nil, "skip")
	for _, fs := range l.Filesystems {
		targets := x.mounts[fs.ID]
		if len(targets) == 0 {
			continue
		}
		used := fs.UsedBytes
		for _, mo := range l.Mounts {
			if mo.FS != nil && *mo.FS == fs.ID && strings.Contains(mo.Options, "compress") {
				used *= 2
				break
			}
		}
		inodes := int64(1000)
		if fs.InodesUsed != nil {
			inodes = *fs.InodesUsed
		}
		n := int64(len(targets))
		for i, t := range targets {
			share := used / n
			if i == 0 {
				share += used % n
			}
			f.RestoreSizes[t] = RestoreSize{Bytes: share, Files: inodes * 9 / 10 / n, Inodes: inodes / n}
		}
	}
	for _, mf := range l.MokFiles {
		sum := mf.SHA256
		f.MokFiles = append(f.MokFiles, MokFileFact{Path: mf.Path, Present: true, SHA256: &sum})
	}
	return f
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

type planScenario struct {
	manifest string
	name     string
	// target is a keyword or a function that builds the target file.
	keyword string
	target  func(t testing.TB, m *Manifest) *Target
	choices *Choices
	noFacts bool
	facts   func(f *Facts)
	// resume is PlanOptions.Resume.
	resume string
}

func sameTarget(t testing.TB, m *Manifest) *Target {
	t.Helper()
	tg, _, err := SyntheticTarget(m, TargetSame, nil)
	if err != nil {
		t.Fatal(err)
	}
	tg.Kind = "hardware"
	return tg
}

func resized(size int64) func(testing.TB, *Manifest) *Target {
	return func(t testing.TB, m *Manifest) *Target {
		tg := sameTarget(t, m)
		for i := range tg.Disks {
			tg.Disks[i].SizeBytes = size
			tg.Disks[i].Serial = strPtr(fmt.Sprintf("NEW%d", i))
			tg.Disks[i].WWN, tg.Disks[i].EUI64, tg.Disks[i].NGUID = nil, nil, nil
			tg.Disks[i].Identity = diskIdentity(nil, nil, nil, tg.Disks[i].Serial, tg.Disks[i].NSID)
		}
		return tg
	}
}

func sectors(size, lbs int64) func(testing.TB, *Manifest) *Target {
	return func(t testing.TB, m *Manifest) *Target {
		tg := resized(size)(t, m)
		for i := range tg.Disks {
			if size == 0 {
				tg.Disks[i].SizeBytes = m.Linux.Disks[i].SizeBytes
			}
			tg.Disks[i].LogicalSectorSize, tg.Disks[i].PhysicalSectorSize = lbs, max(lbs, 4096)
		}
		return tg
	}
}

func firmware(mode string) func(testing.TB, *Manifest) *Target {
	return func(t testing.TB, m *Manifest) *Target {
		tg := sameTarget(t, m)
		tg.Firmware.Mode = mode
		if mode == "bios" {
			tg.Firmware.SecureBoot, tg.Firmware.SetupMode = nil, nil
			tg.Firmware.DB, tg.Firmware.SbatLevel, tg.Firmware.MokList = []CertRef{}, []string{}, []MokRef{}
		}
		return tg
	}
}

const (
	sha2023 = "a1117f516a32cefcba3f2d1ace10a87972fd6bbe8fe0d0b996e09e65d802a503"
	shaPCA  = "dbb14a8ee716836045327b288efe274d7c24f9d24964ac6041db36973cd4115c"
)

func secureBoot(edit func(fw *TargetFirmware, m *Manifest)) func(testing.TB, *Manifest) *Target {
	return func(t testing.TB, m *Manifest) *Target {
		tg := sameTarget(t, m)
		tg.Firmware.SecureBoot = boolPtr(true)
		tg.Firmware.DBX = &TargetDBX{Hashes: []string{}, Certs: []string{}}
		edit(&tg.Firmware, m)
		return tg
	}
}

func planScenarios() []planScenario {
	auto := &Choices{Shrink: "auto"}
	return []planScenario{
		{manifest: "debian12-uefi-luks-lvm", name: "resume-clean", keyword: TargetSame, resume: ResumeClean},
		{manifest: "debian12-uefi-luks-lvm", name: "resume-unclean", keyword: TargetSame, resume: ResumeUnclean},
		{manifest: "bios-mbr-mdadm-raid1", name: "resume-clean", keyword: TargetSame, resume: ResumeClean},
		{manifest: "bios-mbr-mdadm-raid1", name: "resume-unclean", keyword: TargetSame, resume: ResumeUnclean},
		{manifest: "debian12-uefi-luks-lvm", name: "larger-1tb", target: resized(1000204886016)},
		{manifest: "debian12-uefi-luks-lvm", name: "smaller-256gb", target: resized(256060514304)},
		{manifest: "debian12-uefi-luks-lvm", name: "smaller-128gb", target: resized(128035676160)},
		{manifest: "debian12-uefi-luks-lvm", name: "smaller-128gb-auto", target: resized(128035676160), choices: auto},
		{manifest: "debian12-uefi-luks-lvm", name: "one-sector-smaller", target: resized(512110190592 - 512)},
		{manifest: "debian12-uefi-luks-lvm", name: "too-small", target: resized(64023257088)},
		{manifest: "debian12-uefi-luks-lvm", name: "no-facts", keyword: TargetSame, noFacts: true},
		{manifest: "plan-480gb", name: "to-500gb", target: resized(500107862016)},
		{manifest: "docker-btrfs-many", name: "to-480gb", target: resized(480103981056)},
		{manifest: "lvm-thin", name: "to-480gb", target: resized(480103981056)},
		{manifest: "ubuntu2204-bios-mdadm", name: "one-disk-less", target: func(t testing.TB, m *Manifest) *Target {
			tg := sameTarget(t, m)
			tg.Disks = tg.Disks[:1]
			return tg
		}, choices: &Choices{DiskMapping: map[string]string{"d0": "t0", "d1": "missing"}}},
		{manifest: "ubuntu2204-bios-mdadm", name: "one-disk-less-unmapped", target: func(t testing.TB, m *Manifest) *Target {
			tg := sameTarget(t, m)
			tg.Disks = tg.Disks[:1]
			return tg
		}},
		{manifest: "debian12-uefi-luks-lvm", name: "bios-target", target: firmware("bios")},
		{manifest: "ubuntu2204-bios-mdadm", name: "uefi-target", target: firmware("uefi")},
		{manifest: "ubuntu2204-bios-mdadm", name: "bios-4kn", target: sectors(0, 4096)},
		{manifest: "debian12-uefi-luks-lvm", name: "to-4kn", target: sectors(512110190592, 4096)},
		{manifest: "plan-480gb", name: "to-4kn-500gb", target: sectors(500107862016, 4096)},
		{manifest: "nvme-4kn", name: "to-512", target: sectors(1000204886016, 512)},
		{manifest: "plan-mixed-vg", name: "mixed-4kn", target: func(t testing.TB, m *Manifest) *Target {
			tg := sameTarget(t, m)
			tg.Disks[1].LogicalSectorSize, tg.Disks[1].PhysicalSectorSize = 4096, 4096
			return tg
		}},
		{manifest: "plan-mixed-vg-xfs1k", name: "mixed-4kn", target: func(t testing.TB, m *Manifest) *Target {
			tg := sameTarget(t, m)
			tg.Disks[1].LogicalSectorSize, tg.Disks[1].PhysicalSectorSize = 4096, 4096
			return tg
		}},
		{manifest: "bios-mbr-mdadm-raid1", name: "mbr-3tb", target: resized(3000592982016)},
		{manifest: "raid5-spare", name: "adopt-data", target: adoptTarget(true)},
		{manifest: "raid5-spare", name: "adopt-incomplete", target: adoptTarget(false)},
		{manifest: "debian12-uefi-luks-lvm", name: "identity-conflict", target: func(t testing.TB, m *Manifest) *Target {
			tg := resized(1000204886016)(t, m)
			old := sameTarget(t, m).Disks[0]
			old.ID, old.Path = "o0", "/dev/sdz"
			old.Signatures = []TargetSignature{{Kind: "fs", UUID: deref(m.Linux.Filesystems[2].UUID), Type: strPtr("ext4")},
				{Kind: "part_uuid", UUID: deref(m.Linux.Disks[0].Table.Partitions[0].UUID), PartNumber: intPtr(1)}}
			tg.Others = append(tg.Others, old)
			return tg
		}},
		{manifest: "pve-raw-lvs", name: "minimal-raw-create", keyword: TargetMinimal, choices: &Choices{RawLVs: "create", Shrink: "auto"}},
		{manifest: "debian12-uefi-luks-lvm", name: "sb-no-third-party-ca", target: secureBoot(func(fw *TargetFirmware, m *Manifest) {
			fw.DB = []CertRef{{Subject: "CN=Microsoft Windows Production PCA 2011,O=Microsoft Corporation,C=US", SHA256: shaPCA}}
		})},
		{manifest: "debian12-uefi-luks-lvm", name: "sb-ca2023-only", target: secureBoot(func(fw *TargetFirmware, m *Manifest) {
			fw.DB = []CertRef{{Subject: "CN=Microsoft UEFI CA 2023,O=Microsoft Corporation,C=US", SHA256: sha2023},
				{Subject: "CN=Windows UEFI CA 2023,O=Microsoft Corporation,C=US", SHA256: shaPCA}}
		})},
		{manifest: "debian12-uefi-luks-lvm", name: "sb-shim-in-dbx", target: secureBoot(func(fw *TargetFirmware, m *Manifest) {
			for _, ld := range m.Linux.Loaders {
				if strings.HasSuffix(ld.Path, "shimx64.efi") {
					fw.DBX.Hashes = append(fw.DBX.Hashes, ld.AuthenticodeSha256)
				}
			}
		})},
		{manifest: "debian12-uefi-luks-lvm", name: "sb-sbat-shim5", target: secureBoot(func(fw *TargetFirmware, m *Manifest) {
			fw.SbatLevel = []string{"sbat,1,2025021800", "shim,5", "grub,3"}
		})},
		{manifest: "debian12-uefi-luks-lvm", name: "sb-off", target: secureBoot(func(fw *TargetFirmware, m *Manifest) {
			fw.DB = []CertRef{{Subject: "CN=Microsoft Windows Production PCA 2011,O=Microsoft Corporation,C=US", SHA256: shaPCA}}
		}), choices: &Choices{SecureBootOff: true}},
		{manifest: "debian12-uefi-luks-lvm", name: "other-controller-no-ahci", keyword: TargetOtherController, facts: func(f *Facts) {
			f.Kernels[0].ModulesAlias = strings.ReplaceAll(f.Kernels[0].ModulesAlias, "alias pci:v*d*sv*sd*bc01sc06i01* ahci\n", "")
		}},
		{manifest: "alma9-xfs-lvm-devices", name: "broadcom-9600", target: func(t testing.TB, m *Manifest) *Target {
			tg := resized(960197124096)(t, m)
			tg.Disks[0].Transport = strPtr("sas")
			tg.Disks[0].DriverChain = []string{"sd", "mpi3mr"}
			tg.Disks[0].DriverModaliases = []string{"pci:v00001000d000000A5sv00001000sd00004620bc01sc04i00"}
			tg.NICs = []TargetNIC{{Name: "ens1f0", MAC: strPtr("b4:96:91:00:00:01"), Driver: strPtr("ice"), Modalias: strPtr("pci:v00008086d0000159Bsv00008086sd00000003bc02sc00i00")}}
			return tg
		}},
	}
}

// adoptTarget is raid5-spare on a new system disk with the data disks
// still present (complete: all signatures of the data RAID).
func adoptTarget(complete bool) func(testing.TB, *Manifest) *Target {
	return func(t testing.TB, m *Manifest) *Target {
		tg := sameTarget(t, m)
		tg.Disks[0].Serial, tg.Disks[0].EUI64 = strPtr("NEWSYS"), nil
		tg.Disks[0].Identity = diskIdentity(nil, nil, nil, tg.Disks[0].Serial, tg.Disks[0].NSID)
		l := m.Linux
		md := l.MD[0]
		for i := 1; i < len(tg.Disks); i++ {
			d := l.Disks[i]
			sigs := []TargetSignature{{Kind: "disk_guid", UUID: d.Table.ID},
				{Kind: "part_uuid", UUID: deref(d.Table.Partitions[0].UUID), PartNumber: intPtr(1)},
				{Kind: "md", UUID: md.UUID, PartNumber: intPtr(1)}}
			if i == 1 && complete {
				sigs = append(sigs, TargetSignature{Kind: "pv", UUID: l.LVM.PVs[0].UUID},
					TargetSignature{Kind: "fs", UUID: deref(l.Filesystems[2].UUID), Type: strPtr("xfs")})
			}
			tg.Disks[i].Signatures = sigs
		}
		if !complete {
			tg.Disks = tg.Disks[:3]
		}
		return tg
	}
}

// scenarioFacts are the facts of a manifest changed for one scenario.
func scenarioFacts(t testing.TB, sc planScenario) *Facts {
	f := factsFor(loadManifest(t, sc.manifest))
	sc.facts(f)
	return f
}

func writeJSONFile(t testing.TB, p string, v any) []byte {
	t.Helper()
	b, err := encodeSorted(v)
	if err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := json.Indent(&out, b, "", "  "); err != nil {
		t.Fatal(err)
	}
	out.WriteByte('\n')
	if *update {
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, out.Bytes(), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return out.Bytes()
}

// golden compares (or with -update writes) a JSON file.
func golden(t *testing.T, p string, v any) {
	t.Helper()
	want := writeJSONFile(t, p, v)
	got, err := os.ReadFile(p)
	if err != nil {
		t.Fatalf("%s: %v (run with -update)", p, err)
	}
	if !bytes.Equal(got, want) {
		t.Errorf("%s differs (run with -update and review the diff)", p)
	}
}

func readFacts(t testing.TB, name string) *Facts {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(factsDir, name+".json"))
	if err != nil {
		t.Fatalf("%s: %v (run with -update)", name, err)
	}
	f, err := ParseFacts(b)
	if err != nil {
		t.Fatalf("facts %s: %v", name, err)
	}
	return f
}

// planFor runs one scenario.
func planFor(t testing.TB, sc planScenario) (*RestorePlan, *Target) {
	t.Helper()
	m := loadManifest(t, sc.manifest)
	var f *Facts
	if sc.facts != nil {
		f = readFacts(t, sc.manifest+"."+sc.name)
	} else if !sc.noFacts {
		f = readFacts(t, sc.manifest)
	}
	var tg *Target
	var c Choices
	if sc.keyword != "" {
		var err error
		tg, c, err = SyntheticTarget(m, sc.keyword, f)
		if err != nil {
			t.Fatal(err)
		}
	} else {
		b, err := os.ReadFile(filepath.Join(targetsDir, sc.manifest+"."+sc.name+".json"))
		if err != nil {
			t.Fatalf("%v (run with -update)", err)
		}
		if tg, err = ParseTarget(b); err != nil {
			t.Fatalf("target: %v", err)
		}
	}
	if sc.choices != nil {
		c = *sc.choices
	}
	p, _ := PlanWith(m, tg, f, c, PlanOptions{Resume: sc.resume})
	return p, tg
}

func TestPlanGolden(t *testing.T) {
	if *update {
		for _, name := range linuxManifests(t) {
			writeJSONFile(t, filepath.Join(factsDir, name+".json"), factsFor(loadManifest(t, name)))
		}
		for _, sc := range planScenarios() {
			if sc.target != nil {
				writeJSONFile(t, filepath.Join(targetsDir, sc.manifest+"."+sc.name+".json"), sc.target(t, loadManifest(t, sc.manifest)))
			}
			if sc.choices != nil {
				writeJSONFile(t, filepath.Join(choicesDir, sc.manifest+"."+sc.name+".json"), sc.choices)
			}
			if sc.facts != nil {
				writeJSONFile(t, filepath.Join(factsDir, sc.manifest+"."+sc.name+".json"), scenarioFacts(t, sc))
			}
		}
		old, _ := filepath.Glob(filepath.Join(plansDir, "*.json"))
		for _, p := range old {
			_ = os.Remove(p)
		}
	}
	var scenarios []planScenario
	for _, name := range linuxManifests(t) {
		golden(t, filepath.Join(factsDir, name+".json"), factsFor(loadManifest(t, name)))
		for _, kw := range []string{TargetSame, TargetMinimal, TargetOtherController} {
			scenarios = append(scenarios, planScenario{manifest: name, name: kw, keyword: kw})
		}
	}
	for _, sc := range planScenarios() {
		if sc.target != nil {
			golden(t, filepath.Join(targetsDir, sc.manifest+"."+sc.name+".json"), sc.target(t, loadManifest(t, sc.manifest)))
		}
		if sc.choices != nil {
			golden(t, filepath.Join(choicesDir, sc.manifest+"."+sc.name+".json"), sc.choices)
		}
		if sc.facts != nil {
			golden(t, filepath.Join(factsDir, sc.manifest+"."+sc.name+".json"), scenarioFacts(t, sc))
		}
		scenarios = append(scenarios, sc)
	}
	for _, sc := range scenarios {
		t.Run(sc.manifest+"."+sc.name, func(t *testing.T) {
			p, _ := planFor(t, sc)
			checkPlanInvariants(t, p)
			golden(t, filepath.Join(plansDir, sc.manifest+"."+sc.name+".json"), p)
		})
	}
}

// checkPlanInvariants are the rules of C-M2-5 every plan keeps.
func checkPlanInvariants(t *testing.T, p *RestorePlan) {
	t.Helper()
	if p.OK != (len(p.Problems) == 0) {
		t.Errorf("ok %v with %d problems", p.OK, len(p.Problems))
	}
	for _, f := range p.Problems {
		if f.Severity != FindingProblem || !codeIsProblem(f.Code) {
			t.Errorf("problem %s: severity %s", f.Code, f.Severity)
		}
	}
	for _, f := range p.Warnings {
		if _, known := planMessages[f.Code]; f.Severity != FindingWarning || codeIsProblem(f.Code) || !known {
			t.Errorf("warning %s: severity %s", f.Code, f.Severity)
		}
	}
	for i, s := range p.Steps {
		if s.N != int64(i+1) {
			t.Errorf("step %d numbered %d", i+1, s.N)
		}
		for _, a := range s.Args {
			if err := checkString(a); err != nil {
				t.Errorf("step %d: argument %q: %v", s.N, a, err)
			}
		}
		if s.StdinSecret != nil && !oneOf(*s.StdinSecret, "passphrase", "old_passphrase", "keyfile") {
			t.Errorf("step %d: stdinSecret %q", s.N, *s.StdinSecret)
		}
	}
	b, err := EncodePlan(p)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(b, []byte("secret")) && !bytes.Contains(b, []byte(`"stdinSecret"`)) {
		t.Errorf("plan mentions a secret")
	}
}

// TestPlanSelfConsistent: every manifest that is not unsupported plans
// without problems on the same hardware and on disks of its minimum size.
func TestPlanSelfConsistent(t *testing.T) {
	for _, name := range linuxManifests(t) {
		m := loadManifest(t, name)
		if m.Linux.Verdict == VerdictUnsupported || strings.HasPrefix(name, "plan-mixed-vg-xfs1k") {
			continue
		}
		f := readFacts(t, name)
		for _, kw := range []string{TargetSame, TargetMinimal} {
			tg, c, err := SyntheticTarget(m, kw, f)
			if err != nil {
				t.Fatal(err)
			}
			p, _ := Plan(m, tg, f, c)
			for _, pr := range p.Problems {
				t.Errorf("%s %s: %s %s", name, kw, pr.Code, pr.Message)
			}
		}
	}
}

func TestPlanUnsupported(t *testing.T) {
	for _, name := range []string{"ubuntu-zfs", "container"} {
		m := loadManifest(t, name)
		tg, c, _ := SyntheticTarget(m, TargetSame, nil)
		p, _ := Plan(m, tg, nil, c)
		if p.OK || p.Problems[0].Code != ProblemLayoutUnsupported || len(p.Steps) != 0 {
			t.Errorf("%s: %+v", name, p.Problems)
		}
	}
}

// TestPlanDeterministic: the same input gives the same bytes.
func TestPlanDeterministic(t *testing.T) {
	m := loadManifest(t, "raid5-spare")
	f := readFacts(t, "raid5-spare")
	var first []byte
	for i := 0; i < 5; i++ {
		tg, c, _ := SyntheticTarget(m, TargetMinimal, f)
		p, _ := Plan(m, tg, f, c)
		b, err := EncodePlan(p)
		if err != nil {
			t.Fatal(err)
		}
		if first == nil {
			first = b
		} else if !bytes.Equal(first, b) {
			t.Fatal("plans differ")
		}
	}
}

// TestPlanDockerManySpeed is the guard of 21.1: the plan of a btrfs with
// hundreds of subvolumes takes less than 2 s.
func TestPlanDockerManySpeed(t *testing.T) {
	m := loadManifest(t, "docker-btrfs-many")
	f := readFacts(t, "docker-btrfs-many")
	start := time.Now()
	for _, kw := range []string{TargetSame, TargetMinimal, TargetOtherController} {
		tg, c, _ := SyntheticTarget(m, kw, f)
		p, _ := Plan(m, tg, f, c)
		if _, err := EncodePlan(p); err != nil {
			t.Fatal(err)
		}
	}
	if d := time.Since(start); d > 2*time.Second {
		t.Fatalf("three plans took %v", d)
	}
}

// TestPlanCodesFile keeps testdata/plan-codes.json (read by the server)
// equal to the code lists.
func TestPlanCodesFile(t *testing.T) {
	golden(t, "testdata/plan-codes.json", map[string][]string{"problems": PlanProblemCodes, "warnings": PlanWarningCodes})
	for code := range planMessages {
		if strings.ContainsAny(code, " .") || code != strings.ToLower(code) {
			t.Errorf("code %q", code)
		}
	}
	if len(PlanProblemCodes) != len(problemCodes) {
		t.Errorf("problem codes without a message")
	}
}

// FuzzPlan: Decode then Plan never panics.
func FuzzPlan(f *testing.F) {
	files, _ := filepath.Glob(filepath.Join(manifestDir, "*.json"))
	for _, p := range files {
		if b, err := os.ReadFile(p); err == nil {
			f.Add(b)
		}
	}
	f.Fuzz(func(t *testing.T, b []byte) {
		m, err := Decode(b)
		if err != nil || m.Linux == nil {
			return
		}
		for _, kw := range []string{TargetSame, TargetMinimal, TargetOtherController} {
			tg, c, err := SyntheticTarget(m, kw, nil)
			if err != nil {
				t.Fatal(err)
			}
			p, _ := Plan(m, tg, nil, c)
			if _, err := EncodePlan(p); err != nil {
				t.Fatal(err)
			}
		}
	})
}

// TestPlanCrossNoPanic plans every manifest against every target file and
// against disks of zero, tiny and huge sizes: it must never panic.
func TestPlanCrossNoPanic(t *testing.T) {
	targets, _ := filepath.Glob(filepath.Join(targetsDir, "*.json"))
	var tgs []*Target
	for _, p := range targets {
		b, _ := os.ReadFile(p)
		tg, err := ParseTarget(b)
		if err != nil {
			t.Fatalf("%s: %v", p, err)
		}
		tgs = append(tgs, tg)
	}
	for _, name := range linuxManifests(t) {
		m := loadManifest(t, name)
		same, _, _ := SyntheticTarget(m, TargetSame, nil)
		for _, size := range []int64{0, 512, mib, 1 << 50} {
			tg, _, _ := SyntheticTarget(m, TargetSame, nil)
			for i := range tg.Disks {
				tg.Disks[i].SizeBytes = size
			}
			tgs = append(tgs, tg)
		}
		for _, tg := range append(tgs, same) {
			for _, c := range []Choices{{}, {Shrink: "auto", RawLVs: "create", SecureBootOff: true}, {DiskMapping: map[string]string{"d0": "missing"}}} {
				p, _ := Plan(m, tg, nil, c)
				if _, err := EncodePlan(p); err != nil {
					t.Fatalf("%s: %v", name, err)
				}
			}
		}
		tgs = tgs[:len(targets)]
	}
}
