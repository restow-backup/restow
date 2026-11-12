package recovery

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/restow-backup/restow/agent/internal/baremetal"
)

// TestProbeBootStep: the step of a probe gives the restored system the
// serial console on every kernel command line it has (GRUB defaults,
// /etc/kernel/cmdline, BLS entries in /boot and on the ESP), keeps the old
// files beside the new ones, and installs restow-probe.service with a
// drop-in of multi-user.target; the files are recorded for SELinux.
func TestProbeBootStep(t *testing.T) {
	h := newHarness(t, "debian12-uefi-luks-lvm.same", "debian12-uefi-luks-lvm")
	h.x.rootfs = h.root
	h.x.Probe = true
	h.root.put("/etc/default/grub", "GRUB_CMDLINE_LINUX_DEFAULT=\"quiet splash\"\nGRUB_CMDLINE_LINUX=\"\"\n")
	h.root.put("/etc/kernel/cmdline", "root=UUID=1 ro quiet\n")
	h.root.put("/boot/loader/entries/a.conf", "title A\noptions root=UUID=1 rhgb quiet\n")
	h.root.put("/boot/efi/loader/entries/b.conf", "title B\noptions root=UUID=1\n")
	h.root.put("/boot/loader/entries/readme.txt", "options quiet\n")
	if err := h.x.step(context.Background(), &baremetal.Step{Kind: "probe_boot", Args: []string{"probe-boot"}}); err != nil {
		t.Fatal(err)
	}
	read := func(p string) string {
		b, err := h.root.ReadFile(p, 1<<20)
		if err != nil {
			t.Fatalf("%s: %v", p, err)
		}
		return string(b)
	}
	for p, want := range map[string]string{
		"/etc/default/grub":                                         `GRUB_CMDLINE_LINUX="console=tty0 console=ttyS0,115200"`,
		"/etc/kernel/cmdline":                                       "root=UUID=1 ro console=tty0 console=ttyS0,115200",
		"/boot/loader/entries/a.conf":                               "options root=UUID=1 console=tty0 console=ttyS0,115200",
		"/boot/efi/loader/entries/b.conf":                           "options root=UUID=1 console=tty0 console=ttyS0,115200",
		"/etc/systemd/system/restow-probe.service":                  "RESTOW-PROBE-OK",
		"/etc/systemd/system/multi-user.target.d/restow-probe.conf": "Wants=restow-probe.service",
	} {
		if got := read(p); !strings.Contains(got, want) {
			t.Errorf("%s lacks %q:\n%s", p, want, got)
		}
	}
	if got := read("/etc/default/grub"); strings.Contains(got, "quiet") {
		t.Errorf("quiet left in GRUB defaults:\n%s", got)
	}
	if got := read("/boot/loader/entries/readme.txt"); got != "options quiet\n" {
		t.Errorf("a file that is no entry was changed: %q", got)
	}
	if len(h.x.created) < 6 {
		t.Errorf("created files not recorded: %v", h.x.created)
	}
	backups := 0
	for _, f := range h.x.report.Fixups {
		if f.Rule == "probe" && f.Backup != "" {
			backups++
		}
	}
	if backups != 4 {
		t.Errorf("backups of changed files: %d (%+v)", backups, h.x.report.Fixups)
	}
	// grubenv (RHEL 8) gets the console as well.
	h.x.Manifest.Linux.OS.Cmdline = "BOOT_IMAGE=/vmlinuz root=UUID=1 quiet"
	if got := h.x.kernelopts(); got != "root=UUID=1 console=tty0 console=ttyS0,115200" {
		t.Errorf("kernelopts %q", got)
	}
	h.x.Probe = false
	if got := h.x.kernelopts(); got != "root=UUID=1 quiet" {
		t.Errorf("kernelopts outside a probe %q", got)
	}
}

// TestProbeReleaseWaitsForTheNetwork: after the release recover writes the
// line the lab waits for, then waits until no interface but lo has a link
// (at most a minute), before the first program of the restored system.
func TestProbeReleaseWaitsForTheNetwork(t *testing.T) {
	sys := t.TempDir()
	for name, carrier := range map[string]string{"lo": "1", "ens3": "1", "ens4": "0"} {
		if err := os.MkdirAll(filepath.Join(sys, name), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(sys, name, "carrier"), []byte(carrier+"\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if up := linksUp(sys); strings.Join(up, ",") != "ens3" {
		t.Fatalf("links up: %v", up)
	}
	go func() {
		time.Sleep(50 * time.Millisecond)
		_ = os.WriteFile(filepath.Join(sys, "ens3", "carrier"), []byte("0\n"), 0o644)
	}()
	start := time.Now()
	if up := waitNoLink(context.Background(), sys, 5*time.Second, 10*time.Millisecond); len(up) > 0 {
		t.Errorf("still up: %v", up)
	}
	if time.Since(start) < 40*time.Millisecond {
		t.Error("did not wait for the link to go")
	}
	_ = os.WriteFile(filepath.Join(sys, "ens3", "carrier"), []byte("1\n"), 0o644)
	if up := waitNoLink(context.Background(), sys, 30*time.Millisecond, 10*time.Millisecond); strings.Join(up, ",") != "ens3" {
		t.Errorf("after the wait: %v", up)
	}

	ui, out := newTestUI("")
	r := &Recover{UI: ui, Log: &LogBuffer{}, SysClassNet: sys}
	_ = os.WriteFile(filepath.Join(sys, "ens3", "carrier"), []byte("0\n"), 0o644)
	r.probeReleased(context.Background())
	if !strings.Contains(out.String(), ProbeReleasedLine) {
		t.Errorf("console lacks the release line:\n%s", out.String())
	}
	h := newHarness(t, "debian12-uefi-luks-lvm.same", "debian12-uefi-luks-lvm")
	called := 0
	h.x.OnRelease = func(context.Context) { called++ }
	h.x.release(context.Background())
	if called != 1 {
		t.Errorf("OnRelease ran %d times", called)
	}
}
