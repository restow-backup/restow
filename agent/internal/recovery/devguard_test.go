package recovery

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/restow-backup/restow/agent/internal/baremetal"
)

// twoDisks is a machine with a system disk and a data disk.
func twoDisks() HardwareInput {
	return HardwareInput{Firmware: baremetal.TargetFirmware{Mode: "uefi"}, Blocks: []BlockInfo{
		{KName: "sda", SizeBytes: 512 << 30, Logical: 512, Physical: 512, Model: "SYS", Serial: "SYS-1", WWN: "0x5000000000000001", ByPath: "pci-0000:00:1f.2-ata-1"},
		{KName: "sdb", SizeBytes: 4 << 40, Logical: 512, Physical: 4096, Model: "DATA", Serial: "DATA-1", WWN: "0x5000000000000002", ByPath: "pci-0000:00:1f.2-ata-2",
			Signatures: []baremetal.TargetSignature{{Kind: "fs", UUID: "11111111-2222-4333-8444-555555555555", Type: strPtrT("ext4")}}},
	}}
}

func planMapping(action, target, reason string) *baremetal.RestorePlan {
	return &baremetal.RestorePlan{OK: true, Mapping: []baremetal.DiskAssignment{{Source: "d0", Action: action, Target: &target, Reason: &reason}}}
}

func rescanOf(hw HardwareInput) func(context.Context) (HardwareInput, error) {
	return func(context.Context) (HardwareInput, error) { return hw, nil }
}

type fakeHold struct {
	path   string
	err    error
	closed *int
}

func (h *fakeHold) Check() error { return h.err }
func (h *fakeHold) Close() error { *h.closed++; return nil }

// TestBuildTargetSharedIdentity: an identity that two devices report
// names neither; each gets its by-path name, or none.
func TestBuildTargetSharedIdentity(t *testing.T) {
	in := HardwareInput{Blocks: []BlockInfo{
		{KName: "sda", SizeBytes: 1 << 40, Logical: 512, Physical: 512, Serial: "0123456789ABCDEF", ByPath: "pci-0000:00:14.0-usb-0:1:1.0-scsi-0:0:0:0"},
		{KName: "sdb", SizeBytes: 1 << 40, Logical: 512, Physical: 512, Serial: "0123456789ABCDEF", ByPath: "pci-0000:00:14.0-usb-0:2:1.0-scsi-0:0:0:0"},
		{KName: "sdc", SizeBytes: 1 << 40, Logical: 512, Physical: 512, Serial: "UNIQUE"},
		{KName: "sdd", SizeBytes: 1 << 40, Logical: 512, Physical: 512, Serial: "CLONE"},
		{KName: "sde", SizeBytes: 1 << 40, Logical: 512, Physical: 512, Serial: "CLONE"},
		// Not disks of their own: they report the identity of their device.
		{KName: "nvme0n1", SizeBytes: 1 << 40, Logical: 512, Physical: 512, Serial: "NV", NSID: 1},
		{KName: "nvme0c0n1", SizeBytes: 1 << 40, Logical: 512, Physical: 512, Serial: "NV", NSID: 1},
		{KName: "loop0", SizeBytes: 1 << 30, Serial: "UNIQUE"},
	}}
	shared := SharedIdentities(in)
	if len(shared) != 2 || strings.Join(shared["serial.0123456789ABCDEF"], ",") != "/dev/sda,/dev/sdb" || strings.Join(shared["serial.CLONE"], ",") != "/dev/sdd,/dev/sde" {
		t.Fatalf("shared %v", shared)
	}
	tg, notes := BuildTarget(in)
	got := diskList(tg.Disks)
	want := "/dev/nvme0n1=serial.NV-1 /dev/sda=path.pci-0000:00:14.0-usb-0:1:1.0-scsi-0:0:0:0 /dev/sdb=path.pci-0000:00:14.0-usb-0:2:1.0-scsi-0:0:0:0 /dev/sdc=serial.UNIQUE /dev/sdd= /dev/sde="
	if got != want {
		t.Errorf("disks %q\nwant  %q", got, want)
	}
	seen := map[string]int{}
	for _, d := range tg.Disks {
		if id := deref(d.Identity); id != "" {
			seen[id]++
			if !ValidIdentity(id) {
				t.Errorf("%s is no identity the answers accept", id)
			}
		}
	}
	for id, n := range seen {
		if n != 1 {
			t.Errorf("identity %s names %d disks", id, n)
		}
	}
	n := 0
	for _, note := range notes {
		if note.Reason == NoteIdentityShared {
			n++
		}
	}
	if n != 4 {
		t.Errorf("notes %+v", notes)
	}
}

// TestDiskGuardArm: before the first step the machine must be the one
// that was confirmed, device by device; only then the mapped disks are
// held and the disks to erase get the write probe.
func TestDiskGuardArm(t *testing.T) {
	confirmed, _ := BuildTarget(twoDisks())
	type calls struct {
		holds, probes []string
		closed        int
	}
	arm := func(now HardwareInput, plan *baremetal.RestorePlan, probe bool) (*calls, *DiskGuard, error) {
		c := &calls{}
		g := &DiskGuard{
			Hold: func(path string, size int64) (DeviceHold, error) {
				c.holds = append(c.holds, fmt.Sprintf("%s:%d", path, size))
				return &fakeHold{path: path, closed: &c.closed}, nil
			},
			ProbeWrite: func(path string, size int64) error { c.probes = append(c.probes, path); return nil },
		}
		return c, g, g.Arm(context.Background(), rescanOf(now), confirmed, plan, probe)
	}
	erase := planMapping(baremetal.ActionErase, "t0", "identity")

	c, g, err := arm(twoDisks(), erase, true)
	if err != nil {
		t.Fatalf("unchanged machine: %v", err)
	}
	if strings.Join(c.holds, ",") != fmt.Sprintf("/dev/sda:%d", int64(512<<30)) || strings.Join(c.probes, ",") != "/dev/sda" {
		t.Errorf("holds %v, probes %v", c.holds, c.probes)
	}
	if d := g.Disks(); len(d) != 1 || d[0].Identity != "wwn.5000000000000001" || !d[0].Erased {
		t.Errorf("guarded %+v", d)
	}
	g.Close()
	if c.closed != 1 {
		t.Errorf("closed %d holds", c.closed)
	}

	// An adopted disk and the disks of a resumed run are held, not written.
	for _, plan := range []*baremetal.RestorePlan{planMapping(baremetal.ActionAdopt, "t1", "signatures"), planMapping(baremetal.ActionErase, "t0", "resume")} {
		c, _, err = arm(twoDisks(), plan, true)
		if err != nil || len(c.holds) != 1 || len(c.probes) != 0 {
			t.Errorf("%s/%s: err %v, holds %v, probes %v", plan.Mapping[0].Action, *plan.Mapping[0].Reason, err, c.holds, c.probes)
		}
	}
	if c, _, err = arm(twoDisks(), erase, false); err != nil || len(c.probes) != 0 {
		t.Errorf("without the probe: err %v, probes %v", err, c.probes)
	}

	changes := map[string]func(hw *HardwareInput){
		"/dev/sda was wwn.5000000000000001 and is wwn.5000000000000009": func(hw *HardwareInput) { hw.Blocks[0].WWN = "0x5000000000000009" },
		// The names swapped: each path now gives the other disk.
		"/dev/sdb was wwn.5000000000000002 and is wwn.5000000000000001": func(hw *HardwareInput) {
			hw.Blocks[0].KName, hw.Blocks[1].KName = "sdb", "sda"
		},
		"/dev/sda had 549755813888 bytes":         func(hw *HardwareInput) { hw.Blocks[0].SizeBytes -= 4096 },
		"/dev/sdb (wwn.5000000000000002) is gone": func(hw *HardwareInput) { hw.Blocks = hw.Blocks[:1] },
		"/dev/sdc (serial.NEW) is new": func(hw *HardwareInput) {
			hw.Blocks = append(hw.Blocks, BlockInfo{KName: "sdc", SizeBytes: 1 << 40, Logical: 512, Physical: 512, Serial: "NEW"})
		},
		"the content of /dev/sda changed": func(hw *HardwareInput) {
			hw.Blocks[0].Signatures = []baremetal.TargetSignature{{Kind: "fs", UUID: "aaaaaaaa-2222-4333-8444-555555555555"}}
		},
		// A second disk with the serial and WWN of the target: the identity
		// no longer names one disk.
		"/dev/sda was wwn.5000000000000001 and is path.pci-0000:00:1f.2-ata-1": func(hw *HardwareInput) {
			twin := hw.Blocks[0]
			twin.KName, twin.ByPath = "sdc", "pci-0000:00:1f.2-ata-3"
			hw.Blocks = append(hw.Blocks, twin)
		},
	}
	for want, edit := range changes {
		hw := twoDisks()
		hw.Blocks = append([]BlockInfo(nil), hw.Blocks...)
		edit(&hw)
		c, _, err := arm(hw, erase, true)
		if !errors.Is(err, ErrDisksChanged) || !strings.Contains(err.Error(), want) {
			t.Errorf("want %q: err %v", want, err)
		}
		if len(c.holds) != 0 || len(c.probes) != 0 {
			t.Errorf("%q: a changed machine was held or written: %v %v", want, c.holds, c.probes)
		}
	}

	// The write probe fails (a locked self-encrypting drive): the code of
	// the planner, and nothing stays held.
	c = &calls{}
	g = &DiskGuard{
		Hold:       func(path string, size int64) (DeviceHold, error) { return &fakeHold{closed: &c.closed}, nil },
		ProbeWrite: func(string, int64) error { return errors.New("input/output error") },
	}
	err = g.Arm(context.Background(), rescanOf(twoDisks()), confirmed, erase, true)
	if ProblemCode(err) != baremetal.ProblemSEDLocked || c.closed != 1 {
		t.Errorf("probe failure: %v (code %q), closed %d", err, ProblemCode(err), c.closed)
	}
	// A device node that is not the confirmed disk cannot be held.
	g = &DiskGuard{Hold: func(path string, size int64) (DeviceHold, error) { return nil, errors.New("has 1 bytes") }}
	if err := g.Arm(context.Background(), rescanOf(twoDisks()), confirmed, erase, true); !errors.Is(err, ErrDisksChanged) {
		t.Errorf("hold failure: %v", err)
	}
}

// TestDiskGuardCheck: before every step the mapped disks must still be
// the confirmed ones; what happens to other devices does not stop a
// restore that runs for hours.
func TestDiskGuardCheck(t *testing.T) {
	confirmed, _ := BuildTarget(twoDisks())
	now := twoDisks()
	closed := 0
	hold := &fakeHold{closed: &closed}
	g := &DiskGuard{Scan: func(context.Context) (HardwareInput, error) { return now, nil },
		Hold: func(string, int64) (DeviceHold, error) { return hold, nil }}
	if err := g.Arm(context.Background(), rescanOf(twoDisks()), confirmed, planMapping(baremetal.ActionErase, "t0", "identity"), false); err != nil {
		t.Fatal(err)
	}
	if err := g.Check(context.Background()); err != nil {
		t.Fatalf("unchanged: %v", err)
	}
	// A stick is plugged in, the data disk is pulled: not mapped.
	now = twoDisks()
	now.Blocks = []BlockInfo{now.Blocks[0], {KName: "sdc", SizeBytes: 1 << 34, Logical: 512, Physical: 512, Serial: "STICK", Removable: true}}
	if err := g.Check(context.Background()); err != nil {
		t.Errorf("other devices changed: %v", err)
	}
	for want, edit := range map[string]func(hw *HardwareInput){
		"/dev/sda was wwn.5000000000000001 and is wwn.5000000000000002": func(hw *HardwareInput) {
			hw.Blocks[0].KName, hw.Blocks[1].KName = "sdb", "sda"
		},
		"/dev/sda had 549755813888 bytes and has 549755813376": func(hw *HardwareInput) { hw.Blocks[0].SizeBytes -= 512 },
		// A reader without a medium has no size and is no disk any more.
		"/dev/sda (wwn.5000000000000001) is gone; ":  func(hw *HardwareInput) { hw.Blocks[0].SizeBytes = 0 },
		"/dev/sda (wwn.5000000000000001) is gone":    func(hw *HardwareInput) { hw.Blocks = hw.Blocks[1:] },
		"/dev/sda was wwn.5000000000000001 and is n": func(hw *HardwareInput) { hw.Blocks[0].WWN, hw.Blocks[0].Serial, hw.Blocks[0].ByPath = "", "", "" },
	} {
		hw := twoDisks()
		edit(&hw)
		now = hw
		if err := g.Check(context.Background()); !errors.Is(err, ErrDisksChanged) || !strings.Contains(err.Error()+"; ", want) || ProblemCode(err) != ProblemDisksChanged {
			t.Errorf("want %q with the code %s: %v (%s)", want, ProblemDisksChanged, err, ProblemCode(err))
		}
	}
	// The held descriptor reports another device behind the path.
	now = twoDisks()
	hold.err = errors.New("/dev/sda no longer names the confirmed disk")
	if err := g.Check(context.Background()); !errors.Is(err, ErrDisksChanged) {
		t.Errorf("hold: %v", err)
	}
	var none *DiskGuard
	if none.Check(context.Background()) != nil {
		t.Error("no guard")
	}
	// A difference that is gone at the second look (udev was rewriting
	// what lsblk reads) does not stop the run; one that stays does.
	hold.err = nil
	blip := twoDisks()
	blip.Blocks[0].WWN, blip.Blocks[0].Serial = "", ""
	scans := 0
	g.Settle = 10 * time.Millisecond
	g.Scan = func(context.Context) (HardwareInput, error) {
		if scans++; scans == 1 {
			return blip, nil
		}
		return twoDisks(), nil
	}
	if err := g.Check(context.Background()); err != nil || scans != 2 {
		t.Errorf("a difference in one scan only: %v after %d scans", err, scans)
	}
	scans = 0
	g.Scan = func(context.Context) (HardwareInput, error) { scans++; return blip, nil }
	if err := g.Check(context.Background()); !errors.Is(err, ErrDisksChanged) || scans != 2 {
		t.Errorf("a difference that stays: %v after %d scans", err, scans)
	}
}

type countingGuard struct {
	n      int
	failAt int
}

func (g *countingGuard) Check(context.Context) error {
	g.n++
	if g.n == g.failAt {
		return changed([]string{"/dev/nvme0n1 was serial.A and is serial.B"})
	}
	return nil
}

// TestExecuteGuardBeforeEveryStep: the executor asks the guard before
// every step and runs none after it refused: not the blkzero that would
// follow, no partitioning, no mkfs.
func TestExecuteGuardBeforeEveryStep(t *testing.T) {
	h := newHarness(t, "debian12-uefi-luks-lvm.same", "debian12-uefi-luks-lvm")
	g := &countingGuard{}
	h.x.Guard = g
	if _, err := h.x.Run(context.Background()); err != nil {
		t.Fatal(err)
	}
	if g.n != len(h.x.Plan.Steps) {
		t.Errorf("the guard was asked %d times for %d steps", g.n, len(h.x.Plan.Steps))
	}
	// The disk changes after the signatures were wiped: step 4 (blkzero)
	// and everything after it never run.
	h = newHarness(t, "debian12-uefi-luks-lvm.same", "debian12-uefi-luks-lvm")
	if k := h.x.Plan.Steps[3].Kind; k != "zero_range" {
		t.Fatalf("fixture: step 4 is %s", k)
	}
	h.x.Guard = &countingGuard{failAt: 4}
	rep, err := h.x.Run(context.Background())
	var se *StepError
	if !errors.As(err, &se) || !errors.Is(err, ErrDisksChanged) || se.N != 4 || rep.FailedStep != 4 || rep.Completed != 3 {
		t.Fatalf("err %v, report %+v", err, rep)
	}
	lines := h.exec.lines()
	for _, never := range []string{"op blkzero", "sfdisk", "luksFormat", "mkfs.", "restic restore", "mount "} {
		if strings.Contains(lines, never) {
			t.Errorf("%s ran after the guard refused:\n%s", never, lines)
		}
	}
	// Refused before the very first step: nothing ran at all.
	h = newHarness(t, "debian12-uefi-luks-lvm.same", "debian12-uefi-luks-lvm")
	h.x.Guard = &countingGuard{failAt: 1}
	if _, err := h.x.Run(context.Background()); !errors.Is(err, ErrDisksChanged) || strings.TrimSpace(h.exec.lines()) != "" {
		t.Errorf("err %v, calls:\n%s", err, h.exec.lines())
	}
}

// TestExecuteWipePartitions: the signatures on the partitions the disk
// has now are wiped before its table; a partition that cannot be wiped
// stops the run before the table goes.
func TestExecuteWipePartitions(t *testing.T) {
	h := newHarness(t, "debian12-uefi-luks-lvm.same", "debian12-uefi-luks-lvm")
	if _, err := h.x.Run(context.Background()); err != nil {
		t.Fatal(err)
	}
	lines := h.exec.lines()
	want := "op release /dev/nvme0n1\nwipefs -a /dev/nvme0n1p1\nwipefs -a /dev/nvme0n1p2\nwipefs -a /dev/nvme0n1\nop blkzero /dev/nvme0n1 16777216 16777216\nsfdisk --no-reread --wipe always --wipe-partitions always /dev/nvme0n1 "
	if !strings.HasPrefix(lines, want) {
		t.Errorf("the first calls:\n%s", lines[:min(len(lines), 400)])
	}
	h = newHarness(t, "debian12-uefi-luks-lvm.same", "debian12-uefi-luks-lvm")
	h.exec.fail = func(a []string) error {
		if a[0] == "wipefs" && a[len(a)-1] == "/dev/nvme0n1p2" {
			return errors.New("wipefs: /dev/nvme0n1p2: probing initialization failed: Device or resource busy")
		}
		return nil
	}
	rep, err := h.x.Run(context.Background())
	if err == nil || rep.FailedKind != "wipe_partitions" {
		t.Fatalf("err %v, failed at %q", err, rep.FailedKind)
	}
	if strings.Contains(h.exec.lines(), "wipefs -a /dev/nvme0n1\n") || strings.Contains(h.exec.lines(), "sfdisk") {
		t.Errorf("the table went although a partition kept its signatures:\n%s", h.exec.lines())
	}
	// The operation takes one device and nothing else.
	h = newHarness(t, "debian12-uefi-luks-lvm.same", "debian12-uefi-luks-lvm")
	if err := h.x.wipePartitions(context.Background(), []string{"nvme0n1"}); err == nil {
		t.Error("a name that is no device path")
	}
	if !Operations["wipe-partitions"] {
		t.Error("wipe-partitions is not among the operations")
	}
}

// TestMarkerDisks: the marker records what the run did with each source
// disk, and a resumed run keeps the record of the run that started.
func TestMarkerDisks(t *testing.T) {
	h := newHarness(t, "debian12-uefi-luks-lvm.same", "debian12-uefi-luks-lvm")
	var written []Marker
	h.x.OpenRootfs = func() (Rootfs, error) { return &markerSpy{memRootfs: h.root, seen: &written}, nil }
	if _, err := h.x.Run(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(written) == 0 || len(written[0].Disks) != 1 || written[0].Disks[0] != (MarkerDisk{Source: "d0", Action: baremetal.ActionErase}) {
		t.Fatalf("first marker %+v", written)
	}
	h = newHarness(t, "debian12-uefi-luks-lvm.resume-clean", "debian12-uefi-luks-lvm")
	first := Marker{SnapshotID: h.x.Snapshot, LayoutSHA256: h.x.LayoutSHA256, PlanSHA256: "first", CleanStop: true,
		Disks: []MarkerDisk{{Source: "d0", Action: baremetal.ActionErase}, {Source: "d1", Action: baremetal.ActionAdopt}}}
	if err := WriteMarker(h.root, first); err != nil {
		t.Fatal(err)
	}
	written = nil
	h.x.OpenRootfs = func() (Rootfs, error) { return &markerSpy{memRootfs: h.root, seen: &written}, nil }
	h.x.ResumeCheck = func(r Rootfs) (*baremetal.RestorePlan, error) {
		mk, err := ResumeMarker(r, h.x.Snapshot, h.x.LayoutSHA256)
		if err == nil {
			h.x.OriginalPlanSHA256, h.x.MarkerDisks = mk.PlanSHA256, mk.Disks
		}
		return nil, err
	}
	if _, err := h.x.Run(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(written) == 0 || len(written[0].Disks) != 2 || written[0].Disks[1].Action != baremetal.ActionAdopt {
		t.Errorf("the marker of the resumed run lost the mapping of the first: %+v", written)
	}
}
