package baremetal

import (
	"strings"
	"testing"
)

// TestProbePlan: a probe plan restores the system and leaves the file
// systems and folders the server named empty (excluded from the restore,
// the folders created), and lets the restored system report its start
// before the initramfs and the GRUB configuration are written (12.3). The
// plan without the options is the plan of a person: nothing is excluded,
// no probe step.
func TestProbePlan(t *testing.T) {
	m := loadManifest(t, "debian12-uefi-luks-lvm")
	f := readFacts(t, "debian12-uefi-luks-lvm")
	opts := &ProbeOptions{EmptyFilesystems: []string{"/home"}, EmptyDirs: []string{"/var/lib/postgresql"}}
	if err := CheckProbe(m, opts); err != nil {
		t.Fatal(err)
	}
	p, _ := PlanWith(m, sameTarget(t, m), f, Choices{}, PlanOptions{Snapshot: "abcd1234", Probe: opts})
	if !p.OK {
		t.Fatalf("probe plan: %v", codes(p.Problems))
	}
	restore := strings.Join(stepsOf(p, "restore")[0].Args, " ")
	for _, want := range []string{"--exclude /home", "--exclude /var/lib/postgresql"} {
		if !strings.Contains(restore, want) {
			t.Errorf("restore lacks %q: %s", want, restore)
		}
	}
	if mk := strings.Join(stepsOf(p, "mkdirs")[0].Args, " "); !strings.Contains(mk, "/var/lib/postgresql:0755") {
		t.Errorf("the emptied folder is not created: %s", mk)
	}
	order := map[string]int{}
	for i, s := range p.Steps {
		if _, ok := order[s.Kind]; !ok {
			order[s.Kind] = i
		}
	}
	pb, ok := order["probe_boot"]
	if !ok {
		t.Fatal("no probe_boot step")
	}
	for _, later := range []string{"initramfs", "grub_config", "verify"} {
		if i, ok := order[later]; ok && i < pb {
			t.Errorf("%s comes before probe_boot", later)
		}
	}
	plain, _ := PlanWith(m, sameTarget(t, m), f, Choices{}, PlanOptions{Snapshot: "abcd1234"})
	if strings.Contains(strings.Join(stepsOf(plain, "restore")[0].Args, " "), "--exclude") || len(stepsOf(plain, "probe_boot")) > 0 {
		t.Error("a plan without probe options excludes something or has the probe step")
	}
}

// TestCheckProbeRefusesSystemPaths: recover never leaves a system path, a
// parent of one or a package database empty, whatever the answers say.
func TestCheckProbeRefusesSystemPaths(t *testing.T) {
	m := loadManifest(t, "debian12-uefi-luks-lvm")
	for _, o := range []ProbeOptions{
		{EmptyFilesystems: []string{"/"}},
		{EmptyFilesystems: []string{"/boot/efi"}},
		{EmptyFilesystems: []string{"/srv"}}, // no mount point of the backup
		{EmptyDirs: []string{"/usr/lib"}},
		{EmptyDirs: []string{"/var"}},
		{EmptyDirs: []string{"/var/lib"}},
		{EmptyDirs: []string{"/var/lib/dpkg"}},
		{EmptyDirs: []string{"/var/lib/systemd/coredump"}},
		{EmptyDirs: []string{"relative"}},
		{EmptyDirs: []string{"/home/../etc"}},
	} {
		if err := CheckProbe(m, &o); err == nil {
			t.Errorf("accepted %+v", o)
		}
	}
	if got := ProbeSystemMounts(m); strings.Join(got, ",") != "/,/boot,/boot/efi,/usr,/var" {
		t.Errorf("system mounts %v", got)
	}
}

// TestProbeKernelCmdline: the console goes to the serial port, quiet,
// splash and rhgb go (Plymouth would take the passphrase prompt), nothing
// else changes, and twice is the same as once.
func TestProbeKernelCmdline(t *testing.T) {
	got := ProbeKernelCmdline("BOOT_IMAGE=/vmlinuz root=UUID=1 ro quiet splash rhgb console=ttyS0,115200")
	want := "BOOT_IMAGE=/vmlinuz root=UUID=1 ro console=tty0 console=ttyS0,115200"
	if got != want || ProbeKernelCmdline(got) != want {
		t.Errorf("got %q", got)
	}
	grub := string(ProbeGrubDefault([]byte("GRUB_DEFAULT=0\nGRUB_CMDLINE_LINUX_DEFAULT=\"quiet splash\"\nGRUB_CMDLINE_LINUX='rd.lvm.lv=vg/root'\n")))
	for _, want := range []string{`GRUB_CMDLINE_LINUX_DEFAULT=""`, `GRUB_CMDLINE_LINUX='rd.lvm.lv=vg/root console=tty0 console=ttyS0,115200'`, "GRUB_DEFAULT=0"} {
		if !strings.Contains(grub, want) {
			t.Errorf("grub default lacks %q:\n%s", want, grub)
		}
	}
	if added := string(ProbeGrubDefault([]byte("GRUB_DEFAULT=0\n"))); !strings.Contains(added, `GRUB_CMDLINE_LINUX="console=tty0 console=ttyS0,115200"`) {
		t.Errorf("no GRUB_CMDLINE_LINUX added:\n%s", added)
	}
	bls := string(ProbeBLSEntry([]byte("title Fedora\nlinux /vmlinuz\noptions root=UUID=1 ro rhgb quiet\n"), false))
	if !strings.Contains(bls, "options root=UUID=1 ro console=tty0 console=ttyS0,115200") {
		t.Errorf("bls: %s", bls)
	}
	if keep := string(ProbeBLSEntry([]byte("options $kernelopts\n"), false)); keep != "options $kernelopts\n" {
		t.Errorf("an entry of grubenv was changed: %q", keep)
	}
	if line := string(ProbeBLSEntry([]byte("root=UUID=1 quiet\n"), true)); line != "root=UUID=1 console=tty0 console=ttyS0,115200\n" {
		t.Errorf("kernel cmdline file: %q", line)
	}
}

// TestProbeUnit: the unit escapes % and $ for systemd, so the shell sees
// printf "RESTOW-PROBE-OK %s %s\n" and $(...).
func TestProbeUnit(t *testing.T) {
	for _, want := range []string{"%%s %%s", "$$(cat /proc/sys/kernel/random/boot_id)", "$$(uname -r)", "> /dev/ttyS0", "After=multi-user.target", "poweroff"} {
		if !strings.Contains(ProbeUnit, want) {
			t.Errorf("unit lacks %q", want)
		}
	}
	if !strings.Contains(ProbeTargetDropIn, "Wants="+ProbeUnitName) {
		t.Error("the drop-in does not want the unit")
	}
}
