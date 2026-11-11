package baremetal

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Tests of the planner for inputs that must not end in a plan that looks
// fine and fails (or writes to the wrong place) after the disks were
// erased: bind mounts, swap files, MBR disk signatures, partition tables
// that cannot exist, old signatures on partitions, disks that share an
// identity and the mapping of a resumed recovery.

func stepsOf(p *RestorePlan, kind string) []Step {
	var out []Step
	for _, s := range p.Steps {
		if s.Kind == kind {
			out = append(out, s)
		}
	}
	return out
}

func TestMountIsBind(t *testing.T) {
	cases := []struct {
		typ    string
		root   string
		subvol *string
		want   bool
	}{
		{"ext4", "", nil, false},
		{"ext4", "/", nil, false},
		{"ext4", "/srv/data", nil, true},
		{"xfs", "/var/lib/restow-agent", nil, true},
		{"btrfs", "/@home", strPtr("/@home"), false},
		{"btrfs", "/@home", strPtr("@home"), false},
		{"btrfs", "/@home/alice", strPtr("/@home"), true},
		{"btrfs", "/data", strPtr("/"), true},
		{"btrfs", "", strPtr("/@"), false},
		// btrfs without a recorded subvolume: the root may be one.
		{"btrfs", "/@", nil, false},
	}
	for _, c := range cases {
		mo := Mount{Type: c.typ, Root: c.root, Subvol: c.subvol}
		if got := mo.IsBind(); got != c.want {
			t.Errorf("%s root %q subvol %v: bind %v, want %v", c.typ, c.root, deref(c.subvol), got, c.want)
		}
	}
}

// TestBindMountIsNoMountOfTheFileSystem: /srv/data of the root file system
// is bound to /var/www/data. The plan mounts the root file system once;
// what the snapshot holds below the bind target counts for the file
// system that holds the folder; the mount point is created.
func TestBindMountIsNoMountOfTheFileSystem(t *testing.T) {
	const bind = "/var/www/data"
	check := func(name string, p *RestorePlan) {
		t.Helper()
		if !p.OK {
			t.Fatalf("%s: problems %v", name, codes(p.Problems))
		}
		mounts := 0
		for _, s := range stepsOf(p, "mount") {
			target := s.Args[len(s.Args)-1]
			if strings.Contains(target, bind) {
				t.Errorf("%s: the file system is mounted at the bind target: %v", name, s.Args)
			}
			if s.Args[len(s.Args)-2] == "/dev/md/1" {
				mounts++
			}
		}
		if mounts != 1 {
			t.Errorf("%s: /dev/md/1 is mounted %d times", name, mounts)
		}
		mk := stepsOf(p, "mkdirs")
		if len(mk) != 1 || !hasString(mk[0].Args, bind+":0755") {
			t.Errorf("%s: the mount point of the bind mount is not created: %v", name, mk)
		}
	}
	// The manifest of the fixture records the root of the mount.
	m := loadManifest(t, "bios-mbr-mdadm-raid1")
	var rec *Mount
	for i := range m.Linux.Mounts {
		if m.Linux.Mounts[i].Target == bind {
			rec = &m.Linux.Mounts[i]
		}
	}
	if rec == nil || rec.Root != "/srv/data" || !rec.IsBind() || deref(rec.FS) != "f1" {
		t.Fatalf("the capture did not record the bind mount: %+v", rec)
	}
	check("root recorded", samePlan(t, "bios-mbr-mdadm-raid1", nil))
	// A manifest without the root: the bind option of fstab decides.
	check("fstab", samePlan(t, "bios-mbr-mdadm-raid1", func(m *Manifest, tg *Target, f *Facts, c *Choices) {
		for i := range m.Linux.Mounts {
			m.Linux.Mounts[i].Root = ""
		}
	}))
	// Neither: the old behaviour, to show what the two sources prevent.
	old := samePlan(t, "bios-mbr-mdadm-raid1", func(m *Manifest, tg *Target, f *Facts, c *Choices) {
		for i := range m.Linux.Mounts {
			m.Linux.Mounts[i].Root = ""
		}
		var keep []FstabEntry
		for _, e := range m.Linux.Fstab {
			if e.Target != bind {
				keep = append(keep, e)
			}
		}
		m.Linux.Fstab = keep
	})
	twice := 0
	for _, s := range stepsOf(old, "mount") {
		if s.Args[len(s.Args)-2] == "/dev/md/1" {
			twice++
		}
	}
	if twice != 2 {
		t.Errorf("without root and fstab the mount is taken as it stands: %d mounts", twice)
	}
	// The restore size below the bind target belongs to the file system
	// that holds the folder (here the root), not to none.
	m = loadManifest(t, "bios-mbr-mdadm-raid1")
	f := readFacts(t, "bios-mbr-mdadm-raid1")
	before := newLayoutModel(m, f, "skip").restore["f1"]
	f.RestoreSizes[bind] = RestoreSize{Bytes: 5 * gib, Files: 10, Inodes: 12}
	x := newLayoutModel(m, f, "skip")
	if got := x.restore["f1"]; got != before+5*gib {
		t.Errorf("restore size of the holder: %d, want %d", got, before+5*gib)
	}
	if len(x.mounts["f1"]) != 1 || x.mounts["f1"][0] != "/" || len(x.binds["f1"]) != 1 {
		t.Errorf("mounts %v, binds %v", x.mounts["f1"], x.binds["f1"])
	}
	// A btrfs subvolume is no bind mount.
	bm := loadManifest(t, "swapfile-btrfs")
	bx := newLayoutModel(bm, nil, "skip")
	if len(bx.mounts["f1"]) != 2 || len(bx.binds) != 0 {
		t.Errorf("btrfs subvolume mounts %v, binds %v", bx.mounts["f1"], bx.binds)
	}
}

// TestSwapFileCountsForTheFileSystem: the swap file is not in the backup
// and is created after the restore, so the minimum of its file system
// (and of the volume and disk below) holds it; a minimal target then has
// the room.
func TestSwapFileCountsForTheFileSystem(t *testing.T) {
	const swap = 16 * gib
	minimum := func(withSwap bool) (fsMin, diskMin int64) {
		m := loadManifest(t, "bios-mbr-mdadm-raid1")
		if withSwap {
			m.Linux.Swap = append(m.Linux.Swap, Swap{Kind: "file", Path: strPtr("/swap.img"), FS: strPtr("f1"), SizeBytes: swap, Priority: "-2"})
		}
		ms, _ := MinimumDiskSizes(m, readFacts(t, "bios-mbr-mdadm-raid1"))
		for _, fm := range ms.Filesystems {
			if fm.FS == "f1" {
				fsMin = fm.MinBytes
			}
		}
		return fsMin, ms.Disks[0].MinBytes
	}
	fs0, d0 := minimum(false)
	fs1, d1 := minimum(true)
	if fs1 < fs0+swap || d1 < d0+swap {
		t.Errorf("minimum with a 16 GiB swap file: fs %d -> %d, disk %d -> %d", fs0, fs1, d0, d1)
	}
	// On the minimal target the file system is large enough for the
	// restore and the swap file the plan creates.
	m := loadManifest(t, "ubuntu2404-default")
	f := readFacts(t, "ubuntu2404-default")
	var file *Swap
	for i := range m.Linux.Swap {
		if m.Linux.Swap[i].Kind == "file" {
			file = &m.Linux.Swap[i]
		}
	}
	if file == nil || file.FS == nil {
		t.Fatal("ubuntu2404-default has no swap file")
	}
	tg, c, err := SyntheticTarget(m, TargetMinimal, f)
	if err != nil {
		t.Fatal(err)
	}
	p, _ := Plan(m, tg, f, c)
	if !p.OK || len(stepsOf(p, "swapfile")) != 1 {
		t.Fatalf("minimal plan: %v, swapfile steps %d", codes(p.Problems), len(stepsOf(p, "swapfile")))
	}
	x := newLayoutModel(m, f, "skip")
	fs := x.fs[*file.FS]
	var planned int64
	for _, pp := range p.Disks[0].Partitions {
		if x.fsOn[PartRef("d0", pp.Number).key()] == fs {
			planned = pp.SizeBytes
		}
	}
	if need := mulDivUp(x.restore[fs.ID], 110, 100) + file.SizeBytes; planned < need {
		t.Errorf("the partition of %s has %d bytes on the minimal target; the restore and the swap file need %d", fs.ID, planned, need)
	}
	// Without facts the space in use already counts the swap file once.
	xe := newLayoutModel(m, nil, "skip")
	if got, want := xe.restore[fs.ID], fs.UsedBytes-file.SizeBytes-mib; got != want {
		t.Errorf("estimate without the swap file: %d, want %d", got, want)
	}
}

// TestDosDiskSignatureConflict: blkid prints the disk signature of an MBR
// without 0x, sfdisk (the manifest) with it; a kept disk that carries the
// signature of a source disk is an identity conflict either way.
func TestDosDiskSignatureConflict(t *testing.T) {
	if normUUID("0xA1B2C3D0") != normUUID("a1b2c3d0") {
		t.Fatal("normUUID keeps the 0x of a disk signature")
	}
	for _, sig := range []string{"a1b2c3d0", "0xa1b2c3d0", "A1B2C3D0"} {
		p := samePlan(t, "bios-mbr-mdadm-raid1", func(m *Manifest, tg *Target, f *Facts, c *Choices) {
			if m.Linux.Disks[0].Table.ID != "0xa1b2c3d0" {
				t.Fatalf("fixture: table id %q", m.Linux.Disks[0].Table.ID)
			}
			tg.Others = append(tg.Others, TargetDisk{ID: "o0", Path: "/dev/sdz", SizeBytes: 1 << 40, LogicalSectorSize: 512, PhysicalSectorSize: 512,
				Signatures: []TargetSignature{{Kind: "disk_guid", UUID: sig}}})
		})
		if p.OK || !hasFinding(p.Problems, ProblemIdentityConflict) {
			t.Errorf("signature %q on a kept disk: ok %v, problems %v", sig, p.OK, codes(p.Problems))
		}
	}
	// A target disk with the signature of a source disk is adopted, never
	// mapped for erasing by itself.
	p := samePlan(t, "bios-mbr-mdadm-raid1", func(m *Manifest, tg *Target, f *Facts, c *Choices) {
		tg.Disks[0].Signatures = []TargetSignature{{Kind: "disk_guid", UUID: "a1b2c3d0"}}
	})
	if a := p.Mapping[0]; a.Action != ActionAdopt || deref(a.Reason) != "signatures" {
		t.Errorf("a target with the MBR signature of d0: %+v", a)
	}
	// Only the table of the backup is on it (a recovery that stopped after
	// sfdisk): the adoption is incomplete, the plan cannot run, and only
	// the explicit choice of the disk as a target erases it.
	if p.OK || !hasFinding(p.Problems, ProblemAdoptIncomplete) || len(stepsOf(p, "wipe")) != 1 {
		t.Errorf("a disk with the table only: ok %v, problems %v, wipes %d (the other disk)", p.OK, codes(p.Problems), len(stepsOf(p, "wipe")))
	}
	p = samePlan(t, "bios-mbr-mdadm-raid1", func(m *Manifest, tg *Target, f *Facts, c *Choices) {
		tg.Disks[0].Signatures = []TargetSignature{{Kind: "disk_guid", UUID: "a1b2c3d0"}}
		c.DiskMapping = map[string]string{"d0": "t0", "d1": "t1"}
	})
	if !p.OK || p.Mapping[0].Action != ActionErase || len(stepsOf(p, "wipe")) != 2 {
		t.Errorf("the disk chosen as a target: ok %v, problems %v, mapping %+v", p.OK, codes(p.Problems), p.Mapping[0])
	}
}

// TestImpossiblePartitionTables: a table sfdisk would refuse is a problem
// of the plan, with no step at all.
func TestImpossiblePartitionTables(t *testing.T) {
	type edit func(m *Manifest)
	gpt := func(fn func(ps []Partition, d *Disk)) (string, edit) {
		return "debian12-uefi-luks-lvm", func(m *Manifest) { d := &m.Linux.Disks[0]; fn(d.Table.Partitions, d) }
	}
	dos := func(fn func(d *Disk)) (string, edit) {
		return "bios-mbr-mdadm-raid1", func(m *Manifest) { fn(&m.Linux.Disks[0]) }
	}
	cases := []struct {
		name string
		want string
		man  string
		edit edit
	}{}
	add := func(name, want string, man string, e edit) {
		cases = append(cases, struct {
			name string
			want string
			man  string
			edit edit
		}{name, want, man, e})
	}
	man, e := gpt(func(ps []Partition, d *Disk) { ps[1].StartBytes = ps[0].StartBytes })
	add("overlap", "overlap", man, e)
	man, e = gpt(func(ps []Partition, d *Disk) { ps[len(ps)-1].SizeBytes += 100 * gib })
	add("behind the end", "behind the end of the disk", man, e)
	man, e = gpt(func(ps []Partition, d *Disk) { ps[1].StartBytes += 100 })
	add("off the sector", "sector boundary", man, e)
	man, e = gpt(func(ps []Partition, d *Disk) { ps[1].SizeBytes = 0 })
	add("no size", "has no size", man, e)
	man, e = gpt(func(ps []Partition, d *Disk) { ps[0].StartBytes = 0 })
	add("first sector", "first sector", man, e)
	man, e = gpt(func(ps []Partition, d *Disk) { ps[2].Number = 129 })
	add("gpt entry 129", "128 entries", man, e)
	man, e = dos(func(d *Disk) { d.Table.Partitions[2].Number = 5 })
	add("logical without extended", "no extended partition", man, e)
	man, e = dos(func(d *Disk) {
		d.Table.Partitions[1].Type, d.Table.Partitions[2].Type = "5", "f"
	})
	add("two extended", "more than one extended", man, e)
	man, e = dos(func(d *Disk) {
		ext := d.Table.Partitions[2]
		d.Table.Partitions[2].Type = "5"
		d.Table.Partitions = append(d.Table.Partitions, Partition{Number: 5, StartBytes: ext.StartBytes - 8*mib, SizeBytes: 4 * mib, Type: "83"})
	})
	add("logical outside", "not inside the extended partition", man, e)
	man, e = dos(func(d *Disk) {
		ext := d.Table.Partitions[2]
		d.Table.Partitions[2].Type = "5"
		d.Table.Partitions = append(d.Table.Partitions, Partition{Number: 6, StartBytes: ext.StartBytes + mib, SizeBytes: 4 * mib, Type: "83"})
	})
	add("logical numbering", "numbered from 5", man, e)
	man, e = dos(func(d *Disk) {
		ext := d.Table.Partitions[2]
		d.Table.Partitions[2].Type = "5"
		d.Table.Partitions = append(d.Table.Partitions,
			Partition{Number: 5, StartBytes: ext.StartBytes + mib, SizeBytes: 8 * mib, Type: "83"},
			Partition{Number: 6, StartBytes: ext.StartBytes + 4*mib, SizeBytes: 8 * mib, Type: "83"})
	})
	add("logicals overlap", "partitions 5 and 6 overlap", man, e)
	man, e = dos(func(d *Disk) {
		d.SizeBytes = 8 << 40
		p := &d.Table.Partitions[2]
		p.StartBytes = (int64(1) << 32) * 512
	})
	add("beyond 2^32 sectors", "2^32 sectors", man, e)
	for _, c := range cases {
		p := samePlan(t, c.man, func(m *Manifest, tg *Target, f *Facts, ch *Choices) {
			c.edit(m)
			// Swap areas on a renumbered partition follow it, as a damaged
			// manifest that still validates would.
			if err := m.Validate(); err != nil {
				for i := range m.Linux.Swap {
					if d := m.Linux.Swap[i].Device; d != nil && d.Kind == RefPartition && d.Number == 3 {
						d.Number = 5
					}
				}
			}
		})
		msg := ""
		for _, f := range p.Problems {
			if f.Code == ProblemLayoutUnsupported {
				msg = f.Message
			}
		}
		if p.OK || !strings.Contains(msg, c.want) {
			t.Errorf("%s: ok %v, problems %v, message %q (want %q)", c.name, p.OK, codes(p.Problems), msg, c.want)
		}
		if len(p.Steps) != 0 {
			t.Errorf("%s: %d steps for a table that cannot exist", c.name, len(p.Steps))
		}
	}
	// A valid extended partition with logical partitions passes.
	ok := samePlan(t, "bios-mbr-mdadm-raid1", func(m *Manifest, tg *Target, f *Facts, c *Choices) {
		for di := range m.Linux.Disks {
			d := &m.Linux.Disks[di]
			ext := d.Table.Partitions[2]
			d.Table.Partitions[2].Type = "5"
			d.Table.Partitions = append(d.Table.Partitions, Partition{Number: 5, StartBytes: ext.StartBytes + mib, SizeBytes: ext.SizeBytes - 2*mib, Type: "82"})
			m.Linux.Swap[di].Device = &BlockRef{Kind: RefPartition, Disk: d.ID, Number: 5}
		}
	})
	if hasFinding(ok.Problems, ProblemLayoutUnsupported) {
		t.Errorf("a valid extended partition: %v", ok.Problems)
	}
	// Every table the fixtures recorded can exist.
	files, _ := filepath.Glob(filepath.Join(manifestDir, "*.json"))
	if len(files) < 20 {
		t.Fatalf("%d manifests", len(files))
	}
	for _, p := range files {
		b, err := os.ReadFile(p)
		if err != nil {
			t.Fatal(err)
		}
		m, err := Decode(b)
		if err != nil || m.Linux == nil {
			continue
		}
		for i := range m.Linux.Disks {
			if d := &m.Linux.Disks[i]; d.Table != nil {
				if why := tableProblem(d); why != "" {
					t.Errorf("%s %s: %s", filepath.Base(p), d.ID, why)
				}
			}
		}
	}
}

// TestEraseWipesPartitionsFirst: before the table of a disk goes, recover
// wipes the signatures on the partitions it has now (the operation lists
// them), and sfdisk wipes the areas of the new partitions.
func TestEraseWipesPartitionsFirst(t *testing.T) {
	for _, name := range []string{"debian12-uefi-luks-lvm", "bios-mbr-mdadm-raid1", "btrfs-raid1-multi"} {
		p := samePlan(t, name, nil)
		wipes := 0
		for i, s := range p.Steps {
			switch s.Kind {
			case "wipe":
				wipes++
				prev := p.Steps[i-1]
				if prev.Kind != "wipe_partitions" || len(prev.Args) != 2 || prev.Args[0] != "wipe-partitions" || prev.Args[1] != s.Args[len(s.Args)-1] {
					t.Errorf("%s: before %v comes %v", name, s.Args, prev.Args)
				}
				if p.Steps[i-2].Kind != "release_holders" || p.Steps[i+1].Kind != "zero_range" {
					t.Errorf("%s: order around the wipe of %s", name, deref(s.Target))
				}
			case "partition":
				if !strings.Contains(strings.Join(s.Args, " "), "--wipe-partitions always") {
					t.Errorf("%s: sfdisk without --wipe-partitions always: %v", name, s.Args)
				}
			}
		}
		if wipes == 0 {
			t.Errorf("%s: no wipe step", name)
		}
	}
}

// twoTargets is the target of debian12-uefi-luks-lvm with a second disk.
func twoTargets(t *testing.T, edit func(m *Manifest, tg *Target)) (*Manifest, *Target, *Facts) {
	t.Helper()
	m := loadManifest(t, "debian12-uefi-luks-lvm")
	f := readFacts(t, "debian12-uefi-luks-lvm")
	tg, _, err := SyntheticTarget(m, TargetSame, f)
	if err != nil {
		t.Fatal(err)
	}
	extra := tg.Disks[0]
	extra.ID, extra.Path = "t1", "/dev/nvme1n1"
	extra.Signatures = []TargetSignature{}
	tg.Disks = append(tg.Disks, extra)
	if edit != nil {
		edit(m, tg)
	}
	return m, tg, f
}

// TestSharedIdentityIsNotMappedAutomatically: two free target disks report
// the identity of the source disk (the same serial behind two bridges).
// The identity names neither; the operator chooses.
func TestSharedIdentityIsNotMappedAutomatically(t *testing.T) {
	m, tg, f := twoTargets(t, nil)
	if !sameIdentity(&m.Linux.Disks[0], &tg.Disks[0]) || !sameIdentity(&m.Linux.Disks[0], &tg.Disks[1]) {
		t.Fatal("fixture: both targets must report the identity of d0")
	}
	p, _ := Plan(m, tg, f, Choices{})
	if p.OK || len(p.Mapping) != 0 {
		t.Fatalf("mapped by an identity two disks share: ok %v, mapping %+v", p.OK, p.Mapping)
	}
	found := false
	for _, pr := range p.Problems {
		if pr.Code == ProblemMappingInvalid && pr.Params["reason"] == "choice_required" {
			found = true
		}
	}
	if !found {
		t.Errorf("problems %v", p.Problems)
	}
	if len(stepsOf(p, "wipe")) != 0 {
		t.Error("a wipe step without a mapping")
	}
	// One target with the identity: mapped as before.
	m, tg, f = twoTargets(t, func(m *Manifest, tg *Target) {
		tg.Disks[1].Serial, tg.Disks[1].WWN, tg.Disks[1].EUI64, tg.Disks[1].NGUID = strPtr("OTHER"), nil, nil, nil
		tg.Disks[1].SizeBytes += gib
	})
	p, _ = Plan(m, tg, f, Choices{})
	if len(p.Mapping) != 1 || deref(p.Mapping[0].Target) != "t0" || deref(p.Mapping[0].Reason) != "identity" {
		t.Errorf("one disk with the identity: %+v %v", p.Mapping, p.Problems)
	}
}

// TestResumeMappingFollowsTheSignatures: the first run needed a choice (two
// free disks, the operator took t1). The resumed plan maps d0 to the disk
// that carries its identities, with no choice and no heuristics; without a
// carrier the disk counts as missing, and a second carrier is a conflict.
func TestResumeMappingFollowsTheSignatures(t *testing.T) {
	blank := func(m *Manifest, tg *Target) {
		for i := range tg.Disks {
			d := &tg.Disks[i]
			d.Model, d.Serial, d.WWN, d.EUI64, d.NGUID, d.Identity = nil, nil, nil, nil, nil, nil
		}
	}
	m, tg, f := twoTargets(t, blank)
	first, _ := Plan(m, tg, f, Choices{})
	if first.OK || !hasFinding(first.Problems, ProblemMappingInvalid) {
		t.Fatalf("first run without a choice: %v", codes(first.Problems))
	}
	first, _ = Plan(m, tg, f, Choices{DiskMapping: map[string]string{"d0": "t1"}})
	if !first.OK || deref(first.Mapping[0].Target) != "t1" {
		t.Fatalf("first run with the choice: %v %+v", codes(first.Problems), first.Mapping)
	}
	// After the first run t1 carries the identities of d0.
	tg.Disks[1].Signatures = firstRunSignatures(m, &m.Linux.Disks[0])
	for _, mode := range []string{ResumeClean, ResumeUnclean} {
		p, _ := PlanWith(m, tg, f, Choices{}, PlanOptions{Resume: mode})
		if !p.OK {
			t.Fatalf("resume %s: %v", mode, p.Problems)
		}
		a := p.Mapping[0]
		if deref(a.Target) != "t1" || a.Action != ActionErase || deref(a.Reason) != "resume" {
			t.Errorf("resume %s: mapping %+v", mode, a)
		}
		for _, s := range p.Steps {
			switch s.Kind {
			case "wipe", "wipe_partitions", "zero_range", "partition", "luks_format", "pv_create", "vg_create", "lv_create", "mkfs", "mkswap", "md_create":
				t.Errorf("resume %s: step %s %v", mode, s.Kind, s.Args)
			}
			if s.Kind == "luks_open" && !strings.Contains(strings.Join(s.Args, " "), "/dev/nvme1n1p3") {
				t.Errorf("resume %s: opens %v, not the volume on t1", mode, s.Args)
			}
		}
	}
	// The same on the smaller, earlier disk: size and order decide nothing.
	m, tg, f = twoTargets(t, blank)
	tg.Disks[0].Signatures = firstRunSignatures(m, &m.Linux.Disks[0])
	tg.Disks[1].SizeBytes *= 2
	p, _ := PlanWith(m, tg, f, Choices{}, PlanOptions{Resume: ResumeClean})
	if !p.OK || deref(p.Mapping[0].Target) != "t0" {
		t.Errorf("resume on t0: %v %+v", codes(p.Problems), p.Mapping)
	}
	// No disk carries the identities: nothing to continue.
	m, tg, f = twoTargets(t, blank)
	p, _ = PlanWith(m, tg, f, Choices{}, PlanOptions{Resume: ResumeClean})
	if p.OK || p.Mapping[0].Action != ActionMissing || len(stepsOf(p, "restore")) == 0 && p.OK {
		t.Errorf("resume without a carrier: ok %v, mapping %+v", p.OK, p.Mapping)
	}
	// Two disks carry them (the old disk next to the new one): the plan
	// stops with an identity conflict.
	m, tg, f = twoTargets(t, blank)
	tg.Disks[0].Signatures = firstRunSignatures(m, &m.Linux.Disks[0])
	tg.Disks[1].Signatures = firstRunSignatures(m, &m.Linux.Disks[0])
	p, _ = PlanWith(m, tg, f, Choices{}, PlanOptions{Resume: ResumeClean})
	if p.OK || !hasFinding(p.Problems, ProblemIdentityConflict) {
		t.Errorf("resume with two carriers: ok %v, problems %v", p.OK, codes(p.Problems))
	}
	// The mapping of the first run, given again (recover reads it from the
	// marker): adopt keeps its mount points out of the restore.
	am := loadManifest(t, "raid5-spare")
	atg := adoptTarget(true)(t, am)
	atg.Disks[0].Signatures = firstRunSignatures(am, &am.Linux.Disks[0])
	af := readFacts(t, "raid5-spare")
	firstAdopt, _ := Plan(am, adoptTarget(true)(t, am), af, Choices{})
	if !firstAdopt.OK || len(firstAdopt.Adopted) == 0 {
		t.Fatalf("fixture: the first run adopts the data disks: %v", codes(firstAdopt.Problems))
	}
	choice := map[string]string{}
	for _, a := range firstAdopt.Mapping {
		choice[a.Source] = a.Action
		if a.Action == ActionErase {
			choice[a.Source] = *a.Target
		}
	}
	rp, _ := PlanWith(am, atg, af, Choices{DiskMapping: choice}, PlanOptions{Resume: ResumeClean})
	if !rp.OK {
		t.Fatalf("resume with the mapping of the first run: %v", rp.Problems)
	}
	restore := strings.Join(stepsOf(rp, "restore")[0].Args, " ")
	firstRestore := stepsOf(firstAdopt, "restore")[0].Args
	excludes := 0
	for i, a := range firstRestore {
		if a == "--exclude" {
			excludes++
			if !strings.Contains(restore, "--exclude "+firstRestore[i+1]) {
				t.Errorf("the resumed restore does not leave out %s: %s", firstRestore[i+1], restore)
			}
		}
	}
	if excludes == 0 {
		t.Fatal("fixture: the first run excludes nothing")
	}
	// Without it every disk counts as written by the first run: the data
	// of the adopted array would be restored over.
	np, _ := PlanWith(am, atg, af, Choices{}, PlanOptions{Resume: ResumeClean})
	if strings.Contains(strings.Join(stepsOf(np, "restore")[0].Args, " "), "--exclude") {
		t.Error("fixture: the resume plan without the mapping already excludes")
	}
}

// TestShrinkFindingNamesDisksAndProposal: a volume group that fits its
// smaller target only when more LVs shrink than the one that may grow. The
// finding names the volume group, the disk of the backup it lies on and
// the target disk (not the volume group in the place of both), and carries
// the proposal; its message reads as a sentence about disks.
func TestShrinkFindingNamesDisksAndProposal(t *testing.T) {
	m := loadManifest(t, "debian12-uefi-luks-lvm")
	f := readFacts(t, "debian12-uefi-luks-lvm")
	raw, err := os.ReadFile(filepath.Join("testdata", "targets", "debian12-uefi-luks-lvm.smaller-128gb.json"))
	if err != nil {
		t.Fatal(err)
	}
	tg, err := ParseTarget(raw)
	if err != nil {
		t.Fatal(err)
	}
	p, _ := Plan(m, tg, f, Choices{})
	var got *Finding
	for i := range p.Problems {
		if p.Problems[i].Code == ProblemShrinkNeedsConfirmation {
			got = &p.Problems[i]
		}
	}
	if got == nil {
		t.Fatalf("no %s: %+v", ProblemShrinkNeedsConfirmation, p.Problems)
	}
	if got.Params["vg"] != "srv01-vg" || got.Params["disk"] != "d0" || got.Params["target"] != tg.Disks[0].ID {
		t.Errorf("params %v, want the volume group srv01-vg, the disk d0 and the target %s", got.Params, tg.Disks[0].ID)
	}
	items, _ := got.Params["proposal"].([]any)
	if len(items) == 0 {
		t.Fatalf("no proposal: %v", got.Params)
	}
	first, _ := items[0].(map[string]any)
	from, _ := first["fromBytes"].(int64)
	to, _ := first["toBytes"].(int64)
	if first["lv"] != "root" || to <= 0 || to >= from {
		t.Errorf("proposal %v", items)
	}
	if strings.Contains(got.Message, "vg srv01-vg") || !strings.Contains(got.Message, "Disk d0 fits on "+tg.Disks[0].ID) {
		t.Errorf("message %q", got.Message)
	}
	for _, text := range planMessages {
		for _, never := range []string{"Windows", "Microsoft", "—", "–"} {
			if strings.Contains(text, never) {
				t.Errorf("a planner message names %q: %s", never, text)
			}
		}
	}
}
