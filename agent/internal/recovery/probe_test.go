package recovery

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/restow-backup/restow/agent/internal/api"
	"github.com/restow-backup/restow/agent/internal/baremetal"
	"github.com/restow-backup/restow/agent/internal/redact"
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

// probeFinishOf reads the last finish block of a console as the lab does:
// the length and SHA-256 of its BEGIN line must match the decoded JSON.
func probeFinishOf(t *testing.T, console string) (*api.RecoveryFinish, []byte) {
	t.Helper()
	lines := strings.Split(console, "\n")
	begin := -1
	for i, l := range lines {
		if strings.HasPrefix(l, ProbeFinishBegin+" ") {
			begin = i
		}
	}
	if begin < 0 {
		return nil, nil
	}
	head := strings.Fields(lines[begin])
	if len(head) != 3 {
		t.Fatalf("BEGIN line %q", lines[begin])
	}
	var enc strings.Builder
	end := false
	for _, l := range lines[begin+1:] {
		if l == ProbeFinishEnd {
			end = true
			break
		}
		if len(l) > ProbeFinishLineLen {
			t.Errorf("a line of %d characters in the block", len(l))
		}
		enc.WriteString(l)
	}
	if !end {
		t.Fatal("no END line after the last BEGIN line")
	}
	payload, err := base64.StdEncoding.DecodeString(enc.String())
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(payload)
	if n, _ := strconv.Atoi(head[1]); n != len(payload) || head[2] != hex.EncodeToString(sum[:]) {
		t.Fatalf("BEGIN %s %s, payload %d bytes %x", head[1], head[2], len(payload), sum)
	}
	var f api.RecoveryFinish
	if err := json.Unmarshal(payload, &f); err != nil {
		t.Fatal(err)
	}
	return &f, payload
}

// TestProbeFinishBlock: the finish of a released probe goes over the
// console as the lab reads it: BEGIN with length and SHA-256, base64 in
// lines of at most 76 characters, END; the JSON is the body Session.Finish
// sends (redacted, a verification object, the warnings within the limits),
// bounded by what the lab takes.
func TestProbeFinishBlock(t *testing.T) {
	secret := "probe-finish-secret-0123456789"
	redact.Add(secret)
	f := api.RecoveryFinish{Status: api.RecoveryFailed, Verification: json.RawMessage(`{"format":"restow-verify-v1","note":"` + secret + `"}`),
		Warnings: []api.RecoveryWarning{{Code: "step_failed", Message: "grub-install failed: " + secret + "\tagain"}}, DurationSeconds: 42}
	lines, err := ProbeFinishBlock(f)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(lines[0], ProbeFinishBegin+" ") || lines[len(lines)-1] != ProbeFinishEnd {
		t.Fatalf("frame %q ... %q", lines[0], lines[len(lines)-1])
	}
	got, payload := probeFinishOf(t, "noise\n"+strings.Join(lines, "\n")+"\nRESTOW-RECOVER-RESULT failed\n")
	if got == nil {
		t.Fatal("no block")
	}
	want, _ := json.Marshal(finishBody(f, api.RecoveryMaxFinishBody))
	if string(payload) != string(want) {
		t.Errorf("relayed body\n%s\nwant the one Finish sends\n%s", payload, want)
	}
	if strings.Contains(string(payload), secret) || strings.Contains(string(payload), "\\t") {
		t.Errorf("not redacted or with a control character: %s", payload)
	}
	if got.Status != api.RecoveryFailed || got.DurationSeconds != 42 || len(got.Warnings) != 1 || got.Warnings[0].Code != "step_failed" {
		t.Errorf("finish %+v", got)
	}

	// No verification: an empty object, as Finish sends it.
	lines, _ = ProbeFinishBlock(api.RecoveryFinish{Status: api.RecoverySucceeded})
	if got, _ := probeFinishOf(t, strings.Join(lines, "\n")); got == nil || string(got.Verification) != "{}" || got.Warnings == nil {
		t.Errorf("without a report: %+v", got)
	}

	// Many long warnings: the block spans many lines, every one within 76
	// characters, and the body stays within what the lab takes.
	many := api.RecoveryFinish{Status: api.RecoveryFailed}
	for i := 0; i < 250; i++ {
		many.Warnings = append(many.Warnings, api.RecoveryWarning{Code: "restore_size_estimated", Message: fmt.Sprintf("%03d %s", i, strings.Repeat("x", 990))})
	}
	lines, _ = ProbeFinishBlock(many)
	if len(lines) < 100 {
		t.Errorf("%d lines", len(lines))
	}
	for _, l := range lines {
		if len(l) > ProbeFinishLineLen && !strings.HasPrefix(l, ProbeFinishBegin) {
			t.Fatalf("line of %d characters", len(l))
		}
	}
	got, payload = probeFinishOf(t, strings.Join(lines, "\n"))
	if len(payload) > ProbeFinishMaxBody || got == nil || len(got.Warnings) == 0 || len(got.Warnings) >= api.RecoveryMaxFinishWarning {
		t.Errorf("%d bytes, %d warnings", len(payload), len(got.Warnings))
	}
	if got.Warnings[0].Message[:3] != "000" {
		t.Errorf("warnings are dropped from the end: first %q", got.Warnings[0].Message[:10])
	}
}
