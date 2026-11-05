package recovery

import (
	"context"
	"errors"
	"strings"
	"testing"
)

// The stack of the golden plan as DeviceSet finds it above nvme0n1: the
// LUKS volume of the plan and the LVs on it.
var (
	goldenStack = []string{"/dev/dm-0", "/dev/dm-1", "/dev/dm-2", "/dev/mapper/nvme0n1p3_crypt", "/dev/mapper/vg0-root", "/dev/mapper/vg0-swap"}
	goldenDM    = []DMMapping{
		{Node: "dm-0", Name: "nvme0n1p3_crypt", UUID: "CRYPT-LUKS2-c3000000000040008000000000000001-nvme0n1p3_crypt", Slaves: []string{"nvme0n1p3"}},
		{Node: "dm-1", Name: "vg0-root", UUID: "LVM-aaaa", Slaves: []string{"dm-0"}},
		{Node: "dm-2", Name: "vg0-swap", UUID: "LVM-bbbb", Slaves: []string{"dm-0"}},
	}
	// oldCrypt is a LUKS1 volume of a disk the operator keeps, opened in
	// the shell: its table carries the volume key in hex.
	oldCrypt = DMMapping{Node: "dm-7", Name: "old_crypt", UUID: "CRYPT-LUKS1-1234-old_crypt", Slaves: []string{"sdb2"}}
)

func TestForeignKeyMappings(t *testing.T) {
	all := append(append([]DMMapping{}, goldenDM...),
		oldCrypt,
		DMMapping{Node: "dm-8", Name: "plain", UUID: "CRYPT-PLAIN-plain", Slaves: []string{"sdc"}},
		DMMapping{Node: "dm-9", Name: "raw", Slaves: []string{"sdc1"}},                               // dmsetup create without a UUID
		DMMapping{Node: "dm-10", Name: "integ", UUID: "CRYPT-INTEGRITY-x", Slaves: []string{"sdc2"}}, // keyed hash
		DMMapping{Node: "dm-11", Name: "oldvg-home", UUID: "LVM-cccc", Slaves: []string{"dm-7"}},     // keyless
		DMMapping{Node: "dm-12", Name: "mpatha", UUID: "mpath-3600", Slaves: []string{"sdd", "sde"}},
		DMMapping{Node: "dm-13", Name: "mpatha1", UUID: "part1-mpath-3600", Slaves: []string{"dm-12"}},
		DMMapping{Node: "dm-14", Name: "isw_raid", UUID: "DMRAID-isw", Slaves: []string{"sdf"}},
		DMMapping{Node: "dm-15", Name: "data_crypt", UUID: "CRYPT-LUKS1-5678-data_crypt", Slaves: []string{"sdg1"}},
		DMMapping{Node: "dm-16", Name: "fake", UUID: "LVMX-not-lvm", Slaves: []string{"sdh"}},
	)
	// data_crypt is an adopted volume the run opened (crypttab of the
	// target): the target's own.
	got := foreignKeyMappings(all, goldenStack, map[string]bool{"data_crypt": true})
	var nodes []string
	for _, m := range got {
		nodes = append(nodes, m.Node)
	}
	if strings.Join(nodes, " ") != "dm-10 dm-16 dm-7 dm-8 dm-9" {
		t.Errorf("foreign: %v", nodes)
	}
	if f := foreignKeyMappings(goldenDM, goldenStack, nil); len(f) != 0 {
		t.Errorf("the plan's own stack is foreign: %v", f)
	}
	// A node outside the stack with the name of a stack member (a second
	// mapping cannot have that name; the name in /dev/mapper decides).
	if f := foreignKeyMappings([]DMMapping{{Node: "dm-20", Name: "nvme0n1p3_crypt", UUID: "CRYPT-LUKS1-x"}}, goldenStack, nil); len(f) != 0 {
		t.Errorf("mapper name of the stack: %v", f)
	}
	names, closes := describeMappings([]DMMapping{oldCrypt, {Node: "dm-9", Name: "raw", Slaves: []string{"sdc1"}}, {Node: "dm-3"}})
	if names != "/dev/mapper/old_crypt (dm-7 on sdb2), /dev/mapper/raw (dm-9 on sdc1), /dev/mapper/dm-3 (dm-3)" {
		t.Errorf("names %q", names)
	}
	if closes != "cryptsetup close old_crypt; dmsetup remove raw; dmsetup remove dm-3" {
		t.Errorf("closes %q", closes)
	}
	var pe *problemError
	if err := foreignMappingError("grub-mkconfig", []DMMapping{oldCrypt}); !errors.As(err, &pe) || pe.code != ProblemForeignMappingOpen ||
		pe.params["close"] != "cryptsetup close old_crypt" || !strings.Contains(err.Error(), "grub-mkconfig keeps CAP_SYS_ADMIN") {
		t.Errorf("error %v", err)
	}
	if !HasText(LangDE, "code."+ProblemForeignMappingOpen) || !HasText(LangEN, "dm.foreign.shell") || !HasText(LangDE, "dm.foreign.resume") {
		t.Error("texts")
	}
}

func TestPlanUsesDMAdmin(t *testing.T) {
	if !planUsesDMAdmin(readPlan(t, "debian12-uefi-luks-lvm.same")) {
		t.Error("LUKS and LVM with grub-mkconfig")
	}
	if planUsesDMAdmin(readPlan(t, "bios-mbr-mdadm-raid1.same")) {
		t.Error("md without device-mapper")
	}
}

// TestExecuteForeignMappingPreflight: a LUKS1 volume of a kept disk open
// in the shell stops the run before anything is erased.
func TestExecuteForeignMappingPreflight(t *testing.T) {
	h := newHarness(t, "debian12-uefi-luks-lvm.same", "debian12-uefi-luks-lvm")
	h.ops.stack = goldenStack
	h.ops.setDM(oldCrypt)
	rep, err := h.x.Run(context.Background())
	var se *StepError
	if !errors.As(err, &se) || se.Problem != ProblemForeignMappingOpen || se.Kind != "preflight" || rep.FailedStep != 0 ||
		!strings.Contains(err.Error(), "cryptsetup close old_crypt") {
		t.Fatalf("err %v", err)
	}
	if lines := h.exec.lines(); strings.TrimSpace(lines) != "" {
		t.Errorf("something ran:\n%s", lines)
	}
	// Mappings on the target disk (released by the plan) and keyless LVs
	// of a kept disk do not stop it.
	h = newHarness(t, "debian12-uefi-luks-lvm.same", "debian12-uefi-luks-lvm")
	h.ops.stack = goldenStack
	h.ops.setDM(append(append([]DMMapping{}, goldenDM...), DMMapping{Node: "dm-11", Name: "oldvg-home", UUID: "LVM-cccc", Slaves: []string{"sdb3"}})...)
	if _, err := h.x.Run(context.Background()); err != nil {
		t.Fatalf("run: %v", err)
	}
	var grub *IsolateSpec
	for i, r := range h.iso.runs {
		if r.Argv[0] == "grub-mkconfig" {
			grub = &h.iso.runs[i]
		}
	}
	if grub == nil || !grub.CapSysAdmin {
		t.Fatalf("grub-mkconfig did not run with CAP_SYS_ADMIN: %+v", grub)
	}
}

// TestExecuteForeignMappingBeforeStep: a volume opened from another
// console during the run stops the grub step before it starts; one opened
// while grub ran fails the step and says the key may be known.
func TestExecuteForeignMappingBeforeStep(t *testing.T) {
	h := newHarness(t, "debian12-uefi-luks-lvm.same", "debian12-uefi-luks-lvm")
	h.ops.stack = goldenStack
	h.ops.setDM(goldenDM...)
	h.iso.reply = func(spec IsolateSpec) string {
		if spec.Argv[0] == "update-initramfs" {
			h.ops.setDM(append(append([]DMMapping{}, goldenDM...), oldCrypt)...)
		}
		return ""
	}
	rep, err := h.x.Run(context.Background())
	var se *StepError
	if !errors.As(err, &se) || se.Problem != ProblemForeignMappingOpen || se.Kind != "grub_config" || rep.Problem != ProblemForeignMappingOpen {
		t.Fatalf("err %v", err)
	}
	for _, r := range h.iso.runs {
		if r.Argv[0] == "grub-mkconfig" {
			t.Fatal("grub-mkconfig ran with a foreign LUKS1 volume open")
		}
	}
	if !strings.Contains(err.Error(), "/dev/mapper/old_crypt (dm-7 on sdb2)") || strings.Contains(err.Error(), "while") {
		t.Errorf("message %v", err)
	}

	h = newHarness(t, "debian12-uefi-luks-lvm.same", "debian12-uefi-luks-lvm")
	h.ops.stack = goldenStack
	h.ops.setDM(goldenDM...)
	h.iso.reply = func(spec IsolateSpec) string {
		if spec.Argv[0] == "grub-mkconfig" {
			h.ops.setDM(append(append([]DMMapping{}, goldenDM...), oldCrypt)...)
		}
		return ""
	}
	_, err = h.x.Run(context.Background())
	if !errors.As(err, &se) || se.Problem != ProblemForeignMappingOpen || se.Kind != "grub_config" ||
		!strings.Contains(err.Error(), "while grub-mkconfig ran") || !strings.Contains(err.Error(), "cryptsetup reencrypt") {
		t.Fatalf("err %v", err)
	}
}

// TestExecuteForeignMappingNoSysAdmin: a step without CAP_SYS_ADMIN (the
// initramfs, or grub on a stack without device-mapper) does not look at
// other mappings; it cannot send device-mapper commands at all.
func TestExecuteForeignMappingNoSysAdmin(t *testing.T) {
	h := newHarness(t, "debian12-uefi-luks-lvm.same", "debian12-uefi-luks-lvm")
	h.ops.stack = goldenStack
	h.ops.setDM(goldenDM...)
	h.iso.reply = func(spec IsolateSpec) string {
		if spec.Argv[0] == "update-initramfs" {
			if spec.CapSysAdmin {
				t.Error("update-initramfs with CAP_SYS_ADMIN")
			}
		}
		return ""
	}
	if _, err := h.x.Run(context.Background()); err != nil {
		t.Fatal(err)
	}
	x := &Executor{Ops: h.ops, Plan: h.x.Plan, Isolator: h.iso, TargetRoot: "/mnt/restow-target"}
	h.ops.stack = nil
	h.ops.setDM(oldCrypt)
	if err := x.isolated(context.Background(), &h.x.Plan.Steps[len(h.x.Plan.Steps)-1], []string{"grub-mkconfig", "-o", "/boot/grub/grub.cfg"}); err != nil {
		t.Errorf("grub on a plain stack: %v", err)
	}
}
