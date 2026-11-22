package baremetal

import (
	"strings"
	"testing"
)

// UEFI to BIOS on a hybrid GPT disk (docs/BAREMETAL-ONESHOT.md 14, decision
// 22.6): a cloud image with an ESP and a BIOS boot partition starts on a
// BIOS machine with GRUB for BIOS, when the snapshot has its modules.
func TestUEFIToBIOSOnAHybridDisk(t *testing.T) {
	hybrid := func() *Manifest {
		m := loadManifest(t, "debian12-uefi-luks-lvm")
		d := &m.Linux.Disks[0]
		d.Table.Partitions = append(d.Table.Partitions, Partition{Number: 4, StartBytes: 512108789760, SizeBytes: 1 << 20,
			Type: strings.ToUpper(gptBIOSBoot), UUID: strPtr("8d3f2b1c-0000-4000-8000-000000000004")})
		return m
	}
	plan := func(m *Manifest, grub *bool) *RestorePlan {
		tg := firmware("bios")(t, m)
		f := factsFor(m)
		f.GrubBIOS = grub
		_, c, _ := SyntheticTarget(m, TargetSame, nil)
		p, _ := Plan(m, tg, f, c)
		return p
	}
	has := func(fs []Finding, code string) bool {
		for _, f := range fs {
			if f.Code == code {
				return true
			}
		}
		return false
	}
	yes, no := true, false
	p := plan(hybrid(), &yes)
	if has(p.Problems, ProblemFirmwareModeMismatch) || !has(p.Warnings, WarnFirmwareModeSwitched) {
		t.Fatalf("problems %+v\nwarnings %+v", p.Problems, p.Warnings)
	}
	var bios, nvram bool
	for _, s := range p.Steps {
		if s.Kind == "bootloader_bios" && strings.Contains(strings.Join(s.Args, " "), "--target=i386-pc") {
			bios = true
		}
		nvram = nvram || s.Kind == "nvram" || s.Kind == "fallback_path"
	}
	if !bios || nvram {
		t.Errorf("GRUB for BIOS %v, UEFI steps %v", bios, nvram)
	}
	// Without GRUB's BIOS modules, or not looked at, or without a BIOS boot partition: the mismatch stays.
	for name, p := range map[string]*RestorePlan{
		"no modules":        plan(hybrid(), &no),
		"not looked at":     plan(hybrid(), nil),
		"no BIOS partition": plan(loadManifest(t, "debian12-uefi-luks-lvm"), &yes),
	} {
		if !has(p.Problems, ProblemFirmwareModeMismatch) || has(p.Warnings, WarnFirmwareModeSwitched) {
			t.Errorf("%s: problems %+v", name, p.Problems)
		}
	}
}
