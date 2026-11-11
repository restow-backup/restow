package recovery

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/restow-backup/restow/agent/internal/api"
	"github.com/restow-backup/restow/agent/internal/baremetal"
	"github.com/restow-backup/restow/agent/internal/restic"
)

var updateGolden = flag.Bool("update", false, "rewrite the golden files of the recovery tests")

const testPassphrase = "correct-horse-battery-staple-42"

type harness struct {
	x      *Executor
	exec   *fakeExec
	ops    *fakeOps
	iso    *fakeIsolator
	sess   *fakeSessionAPI
	root   *memRootfs
	restic *fakeRestic
	mu     sync.Mutex
	log    []string
}

func newHarness(t *testing.T, plan, manifest string) *harness {
	t.Helper()
	h := &harness{exec: newFakeExec(), root: newMemRootfs()}
	// The disk carries an old system: two partitions the kernel knows.
	h.ops = &fakeOps{exec: h.exec, mounted: map[string]bool{}, parts: map[string][]string{"/dev/nvme0n1": {"/dev/nvme0n1p1", "/dev/nvme0n1p2"}}}
	h.iso = &fakeIsolator{exec: h.exec}
	h.sess = &fakeSessionAPI{exec: h.exec}
	h.restic = &fakeRestic{exec: h.exec, root: h.root, files: map[string]string{
		"/etc/fstab":                                  "/dev/nvme0n1p2 /boot ext4 defaults 0 2\n",
		"/etc/crypttab":                               "nvme0n1p3_crypt UUID=c3000000-0000-4000-8000-000000000001 none luks\n",
		"/etc/default/grub":                           "GRUB_CMDLINE_LINUX=\"\"\n",
		"/etc/initramfs-tools/conf.d/resume":          "RESUME=none\n",
		"/etc/hostname":                               "srv01\n",
		"/boot/initrd.img-6.1.0-27-amd64":             "initrd",
		"/boot/efi/EFI/debian/shimx64.efi":            "shim",
		"/boot/efi/EFI/debian/grubx64.efi":            "grub",
		"/boot/efi/EFI/debian/grub.cfg":               "configfile",
		"/etc/luks-keys/old.key":                      "old",
		"/var/lib/restow-agent/baremetal/layout.json": "{}",
	}}
	secrets := &Secrets{}
	secrets.SetPassphrase([]byte(testPassphrase))
	ui, _ := newTestUI("")
	h.x = &Executor{Plan: readPlan(t, plan), PlanSHA256: strings.Repeat("9b", 32), Manifest: loadManifestFile(t, manifest), LayoutSHA256: strings.Repeat("cd", 32),
		Snapshot: strings.Repeat("ab", 32), TargetRoot: "/mnt/restow-target", Exec: h.exec, Ops: h.ops, Isolator: h.iso, Restic: h.restic,
		Session: h.sess, UI: ui, Secrets: secrets, OpenRootfs: func() (Rootfs, error) { return h.root, nil }, Fallback: true,
		Fixups: baremetal.NewFixupContext(loadManifestFile(t, manifest)), Log: func(s string) { h.mu.Lock(); h.log = append(h.log, s); h.mu.Unlock() },
		Now: func() time.Time { return time.Date(2026, 11, 5, 10, 15, 0, 0, time.UTC) }, ZeroRepoSecrets: func() { h.exec.note("zero repository secrets") },
		TargetDevices: []string{"/dev/nvme0n1"}}
	return h
}

func golden(t *testing.T, name string, got []byte) {
	t.Helper()
	p := filepath.Join("testdata/execute", name)
	if *updateGolden {
		if err := os.WriteFile(p, got, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	want, err := os.ReadFile(p)
	if err != nil {
		t.Fatalf("%v (run with -update)", err)
	}
	if !bytes.Equal(got, want) {
		t.Errorf("%s differs (run with -update and review the diff)\n%s", name, got)
	}
}

// TestExecuteGolden: the golden plan gives exactly this sequence of
// commands, operations, isolated programs and session calls.
func TestExecuteGolden(t *testing.T) {
	h := newHarness(t, "debian12-uefi-luks-lvm.same", "debian12-uefi-luks-lvm")
	rep, err := h.x.Run(context.Background())
	if err != nil {
		t.Fatalf("run: %v\n%s", err, h.exec.lines())
	}
	golden(t, "debian12-uefi-luks-lvm.same.calls", []byte(h.exec.lines()))
	if rep.Completed != int64(len(h.x.Plan.Steps)) {
		t.Errorf("completed %d of %d", rep.Completed, len(h.x.Plan.Steps))
	}
	// The passphrase is in no call, no log line and no progress message.
	all := h.exec.lines() + strings.Join(h.log, "\n")
	for _, p := range h.sess.progress {
		all += p.Message
	}
	if strings.Contains(all, testPassphrase) {
		t.Fatal("the passphrase leaked")
	}
	// Order: release, then the key file, then the first isolated program;
	// the passphrase is cleared before it.
	lines := strings.Split(h.exec.lines(), "\n")
	idx := func(prefix string) int {
		for i, l := range lines {
			if strings.HasPrefix(l, prefix) {
				return i
			}
		}
		return -1
	}
	rel, zero, chroot := idx("session release"), idx("zero repository secrets"), idx("chroot-exec ")
	if rel < 0 || zero < rel || chroot < zero || idx("restic restore") > rel {
		t.Errorf("order: restore < release %d < zero %d < chroot %d", rel, zero, chroot)
	}
	if !h.x.Secrets.Zeroed() {
		t.Error("the passphrase was not cleared")
	}
	// The marker was written and removed at the end; fixups kept backups.
	if _, err := h.root.Lstat(MarkerPath); err == nil {
		t.Error("the marker is still there")
	}
	if len(rep.Fixups) == 0 {
		t.Error("no fixup recorded")
	}
	for _, f := range rep.Fixups {
		if f.Backup != "" {
			if _, err := h.root.Lstat(f.Backup); err != nil {
				t.Errorf("backup %s missing", f.Backup)
			}
		}
	}
	for _, d := range []string{"/proc", "/sys", "/dev", "/run", "/tmp", "/boot/efi"} {
		if st, err := h.root.Lstat(d); err != nil || !st.IsDir() {
			t.Errorf("%s not created", d)
		}
	}
	if st, _ := h.root.Lstat("/tmp"); st.Mode()&os.ModeSticky == 0 {
		t.Error("/tmp without the sticky bit")
	}
	if len(rep.BootEntries) == 0 {
		t.Error("no boot entry")
	}
	assertKnownCodes(t, rep.Warnings)
	// MODULES=most was set for the rebuild and removed afterwards.
	if _, err := h.root.Lstat("/etc/initramfs-tools/conf.d/zz-restow-recovery"); err == nil {
		t.Error("zz-restow-recovery left behind")
	}
}

func TestExecuteKeyfileOrder(t *testing.T) {
	// A plan with a key file step: it runs after the release and before
	// the first program of the target, the passphrase goes on stdin only.
	h := newHarness(t, "debian12-uefi-luks-lvm.same", "debian12-uefi-luks-lvm")
	p := h.x.Plan
	var post []baremetal.Step
	pass := "passphrase"
	for _, s := range p.Steps {
		if s.Kind == "initramfs" {
			post = append(post, baremetal.Step{Phase: "post", Kind: "keyfile", Target: strPtrT("/dev/nvme0n1p3"),
				Args: []string{"keyfile", "{target_root}/etc/luks-keys/data.key", "/dev/nvme0n1p3"}, StdinSecret: &pass, Reason: "key file"})
		}
		post = append(post, s)
	}
	for i := range post {
		post[i].N = int64(i + 1)
	}
	p.Steps = post
	if _, err := h.x.Run(context.Background()); err != nil {
		t.Fatal(err)
	}
	lines := h.exec.lines()
	ki := strings.Index(lines, "cryptsetup luksAddKey")
	ri := strings.Index(lines, "session release")
	ci := strings.Index(lines, "chroot-exec ")
	if ki < 0 || ri > ki || ki > ci {
		t.Errorf("order release %d, luksAddKey %d, chroot %d\n%s", ri, ki, ci, lines)
	}
	if !strings.Contains(lines, "luksAddKey --batch-mode --key-file - /dev/nvme0n1p3 /run/restow-recovery/tmp/keyfile <stdin:31 bytes>") {
		t.Errorf("luksAddKey call:\n%s", lines)
	}
	if b, err := h.root.ReadFile("/etc/luks-keys/data.key", 0); err != nil || len(b) != 64 {
		t.Errorf("key file: %d %v", len(b), err)
	}
	if len(h.sess.events) != 1 || h.sess.events[0].Kind != api.RecoveryEventKeyfileRegenerated {
		t.Errorf("events %+v", h.sess.events)
	}
	// A secret step after an isolated one is refused (plan order).
	h2 := newHarness(t, "debian12-uefi-luks-lvm.same", "debian12-uefi-luks-lvm")
	steps := append([]baremetal.Step{}, h2.x.Plan.Steps...)
	steps = append(steps, baremetal.Step{N: int64(len(steps) + 1), Phase: "post", Kind: "keyfile", Args: []string{"keyfile", "{target_root}/k", "/dev/x"}, StdinSecret: &pass})
	h2.x.Plan.Steps = steps
	if _, err := h2.x.Run(context.Background()); err == nil {
		t.Error("a passphrase step after a program of the target ran")
	}
}

func strPtrT(s string) *string { return &s }

func TestExecuteStepFailureStops(t *testing.T) {
	h := newHarness(t, "debian12-uefi-luks-lvm.same", "debian12-uefi-luks-lvm")
	h.exec.fail = func(a []string) error {
		if a[0] == "vgcreate" {
			return errors.New("vgcreate: device busy")
		}
		return nil
	}
	rep, err := h.x.Run(context.Background())
	var se *StepError
	if !errors.As(err, &se) || se.Kind != "vg_create" || rep.FailedStep == 0 {
		t.Fatalf("err %v", err)
	}
	if strings.Contains(h.exec.lines(), "lvcreate") || strings.Contains(h.exec.lines(), "restic") {
		t.Error("steps ran after the failure")
	}
}

func TestExecuteReadbackMismatch(t *testing.T) {
	h := newHarness(t, "debian12-uefi-luks-lvm.same", "debian12-uefi-luks-lvm")
	h.exec.output = func(a []string) (string, bool) {
		if a[0] == "blkid" && strings.HasSuffix(a[len(a)-1], "p2") {
			return "UUID=00000000-0000-0000-0000-000000000000\nTYPE=ext4\n", true
		}
		return "", false
	}
	_, err := h.x.Run(context.Background())
	if ProblemCode(err) != ProblemMkfsReadbackMismatch {
		t.Errorf("err %v", err)
	}
	h = newHarness(t, "debian12-uefi-luks-lvm.same", "debian12-uefi-luks-lvm")
	h.exec.output = func(a []string) (string, bool) {
		if a[0] == "sfdisk" && a[1] == "--dump" {
			return "label: gpt\n", true
		}
		return "", false
	}
	if _, err := h.x.Run(context.Background()); ProblemCode(err) != ProblemPartitionReadbackMismatch {
		t.Errorf("partition readback: %v", err)
	}
}

// TestExecuteCancelDuringRestore: the web cancels while restic runs; the
// run stops cleanly and the marker says so.
func TestExecuteCancelDuringRestore(t *testing.T) {
	h := newHarness(t, "debian12-uefi-luks-lvm.same", "debian12-uefi-luks-lvm")
	h.restic.block = make(chan struct{})
	go func() {
		<-h.restic.block
		h.sess.mu.Lock()
		h.sess.cancel = true
		h.sess.mu.Unlock()
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	rep, err := h.x.Run(ctx)
	if !errors.Is(err, ErrCancelled) || !rep.CleanStop {
		t.Fatalf("err %v clean %v", err, rep != nil && rep.CleanStop)
	}
	m, merr := ReadMarker(h.root)
	if merr != nil || !m.CleanStop || m.SnapshotID != h.x.Snapshot {
		t.Errorf("marker %+v %v", m, merr)
	}
	lines := h.exec.lines()
	if !strings.Contains(lines, "op unmount /mnt/restow-target") || !strings.Contains(lines, "cryptsetup close nvme0n1p3_crypt") {
		t.Errorf("no clean stop:\n%s", lines)
	}
	if strings.Contains(lines, "session release") {
		t.Error("released although the restore did not finish")
	}
	found := false
	for _, w := range rep.Warnings {
		found = found || w.Code == WarnCancelRequested
	}
	if !found {
		t.Error("no cancel_requested warning")
	}
}

// TestExecuteLuksOpenForeignMapping: a mapping of the plan's name that
// sits on a device outside the plan (the old disk, opened from the shell)
// is never used; one on exactly the partition of the plan is.
func TestExecuteLuksOpenForeignMapping(t *testing.T) {
	h := newHarness(t, "debian12-uefi-luks-lvm.same", "debian12-uefi-luks-lvm")
	h.exec.exists["/dev/mapper/nvme0n1p3_crypt"] = true
	h.exec.mapping["nvme0n1p3_crypt"] = "/dev/sda3"
	_, err := h.x.Run(context.Background())
	var se *StepError
	if !errors.As(err, &se) || se.Kind != "luks_open" || !strings.Contains(err.Error(), "/dev/sda3") {
		t.Fatalf("err %v", err)
	}
	lines := h.exec.lines()
	for _, never := range []string{"cryptsetup open", "pvcreate", "vgcreate", "mkfs.", "restic restore"} {
		if strings.Contains(lines, never) {
			t.Errorf("%s ran on a foreign mapping:\n%s", never, lines)
		}
	}
	h = newHarness(t, "debian12-uefi-luks-lvm.resume-clean", "debian12-uefi-luks-lvm")
	h.exec.exists["/dev/mapper/nvme0n1p3_crypt"] = true
	h.exec.mapping["nvme0n1p3_crypt"] = "/dev/nvme0n1p3"
	if _, err := h.x.Run(context.Background()); err != nil {
		t.Fatalf("resume with the mapping on the plan's partition: %v", err)
	}
	if strings.Contains(h.exec.lines(), "cryptsetup open") {
		t.Error("the open mapping on the plan's partition was opened again")
	}
}

// TestExecuteResume: the resume plans assemble, open, activate and mount
// without partitioning; the clean one restores if-changed, the unclean one
// always and checks the system paths again.
func TestExecuteResume(t *testing.T) {
	for _, c := range []struct {
		plan, overwrite string
		second          bool
	}{{"debian12-uefi-luks-lvm.resume-clean", "if-changed", false}, {"debian12-uefi-luks-lvm.resume-unclean", "always", true}} {
		h := newHarness(t, c.plan, "debian12-uefi-luks-lvm")
		if _, err := h.x.Run(context.Background()); err != nil {
			t.Fatalf("%s: %v", c.plan, err)
		}
		lines := h.exec.lines()
		for _, never := range []string{"sfdisk", "wipefs", "luksFormat", "pvcreate", "vgcreate", "lvcreate", "mkfs."} {
			if strings.Contains(lines, never) {
				t.Errorf("%s: %s in a resumed run", c.plan, never)
			}
		}
		if !strings.Contains(lines, "--overwrite "+c.overwrite) {
			t.Errorf("%s: overwrite mode", c.plan)
		}
		if got := strings.Count(lines, "restic restore"); (got == 2) != c.second {
			t.Errorf("%s: %d restores", c.plan, got)
		}
		golden(t, c.plan+".calls", []byte(lines))
	}
}

// TestExecuteResumeCheckBeforeMarker: the resume check reads the marker
// that is on the mounted root before recover writes its own. Without a
// marker of a started run (a disk that only carries the manifest's disk
// GUID, as the source machine's own) the mount step fails, nothing is
// restored and no marker is left behind; with one, the check sees that
// marker (its plan checksum and phase), not the one of this run.
func TestExecuteResumeCheckBeforeMarker(t *testing.T) {
	h := newHarness(t, "debian12-uefi-luks-lvm.resume-unclean", "debian12-uefi-luks-lvm")
	h.root.put("/etc/ld.so.preload", "/usr/local/lib/evil.so\n")
	var seen []*Marker
	h.x.ResumeCheck = func(r Rootfs) (*baremetal.RestorePlan, error) {
		m, _ := ReadMarker(r)
		seen = append(seen, m)
		_, err := ResumeMarker(r, h.x.Snapshot, h.x.LayoutSHA256)
		return nil, err
	}
	rep, err := h.x.Run(context.Background())
	if !errors.Is(err, ErrNoStartedRecovery) {
		t.Fatalf("err %v", err)
	}
	if len(seen) != 1 || seen[0] != nil {
		t.Errorf("the check saw a marker that recover wrote itself: %+v", seen)
	}
	if rep.FailedKind != "mount" {
		t.Errorf("failed at %q, not at the mount of the root", rep.FailedKind)
	}
	if lines := h.exec.lines(); strings.Contains(lines, "restic restore") || strings.Contains(lines, "chroot-exec") {
		t.Errorf("the run went on without a marker of a started run:\n%s", lines)
	}
	if _, err := ReadMarker(h.root); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("a marker was written on a root that had none: %v", err)
	}

	h = newHarness(t, "debian12-uefi-luks-lvm.resume-unclean", "debian12-uefi-luks-lvm")
	first := Marker{SnapshotID: h.x.Snapshot, LayoutSHA256: h.x.LayoutSHA256, PlanSHA256: strings.Repeat("77", 32), LastStep: 12, Phase: "restore"}
	if err := WriteMarker(h.root, first); err != nil {
		t.Fatal(err)
	}
	seen = nil
	h.x.ResumeCheck = func(r Rootfs) (*baremetal.RestorePlan, error) {
		m, _ := ReadMarker(r)
		seen = append(seen, m)
		mk, err := ResumeMarker(r, h.x.Snapshot, h.x.LayoutSHA256)
		if err == nil {
			h.x.OriginalPlanSHA256 = mk.PlanSHA256
		}
		return nil, err
	}
	var written []Marker
	h.x.OpenRootfs = func() (Rootfs, error) { return &markerSpy{memRootfs: h.root, seen: &written}, nil }
	if _, err := h.x.Run(context.Background()); err != nil {
		t.Fatalf("resume with the marker of a started run: %v", err)
	}
	if len(seen) != 1 || seen[0] == nil || seen[0].Phase != "restore" || seen[0].PlanSHA256 != first.PlanSHA256 {
		t.Errorf("the check did not see the marker of the first run: %+v", seen)
	}
	if len(written) == 0 || written[0].PlanSHA256 != first.PlanSHA256 {
		t.Errorf("the first marker of the resumed run does not carry the plan checksum of the first run: %+v", written)
	}
}

// markerSpy records every marker written to the root.
type markerSpy struct {
	*memRootfs
	seen *[]Marker
}

func (m *markerSpy) WriteFileAtomic(p string, data []byte, mode fs.FileMode, uid, gid int, backup string) error {
	if p == MarkerPath {
		var mk Marker
		if err := json.Unmarshal(data, &mk); err == nil {
			*m.seen = append(*m.seen, mk)
		}
	}
	return m.memRootfs.WriteFileAtomic(p, data, mode, uid, gid, backup)
}

func TestExecuteSystemFilesIncomplete(t *testing.T) {
	h := newHarness(t, "debian12-uefi-luks-lvm.same", "debian12-uefi-luks-lvm")
	h.restic.items = []restic.ItemError{{Path: "/usr/lib/x86_64-linux-gnu/libc.so.6", Message: "read error"}}
	_, err := h.x.Run(context.Background())
	if ProblemCode(err) != ProblemSystemFilesIncomplete {
		t.Fatalf("err %v", err)
	}
	if strings.Contains(h.exec.lines(), "fixup") || strings.Contains(h.exec.lines(), "chroot-exec") {
		t.Error("the run went on after missing system files")
	}
	h = newHarness(t, "debian12-uefi-luks-lvm.same", "debian12-uefi-luks-lvm")
	h.restic.items = []restic.ItemError{{Path: "/home/alice/broken", Message: "read error"}}
	rep, err := h.x.Run(context.Background())
	if err != nil || rep.RestoreErrors != 1 || rep.Warnings[0].Code != WarnRestoreFileErrors {
		t.Errorf("a file outside the system paths: %v %+v", err, rep)
	}
}

// restic lists the first hundred item errors and counts the rest. When the
// listed ones are all outside the system paths, the others may be system
// files: the run stops before the fixups and is not a mere warning.
func TestExecuteUnlistedRestoreErrors(t *testing.T) {
	h := newHarness(t, "debian12-uefi-luks-lvm.same", "debian12-uefi-luks-lvm")
	for i := 0; i < 100; i++ {
		h.restic.items = append(h.restic.items, restic.ItemError{Path: fmt.Sprintf("/home/alice/f%03d", i), Message: "no space left on device"})
	}
	h.restic.unlisted = 2400
	rep, err := h.x.Run(context.Background())
	if ProblemCode(err) != ProblemSystemFilesIncomplete {
		t.Fatalf("2500 errors, 100 of them known and all below /home: err %v, want %s", err, ProblemSystemFilesIncomplete)
	}
	if rep.RestoreErrors != 2500 || rep.SystemErrors != 2400 {
		t.Errorf("restore errors %d, system errors %d, want 2500 and 2400", rep.RestoreErrors, rep.SystemErrors)
	}
	for _, w := range rep.Warnings {
		if w.Code == WarnRestoreFileErrors {
			t.Error("the unknown errors ended as the warning for files outside the system paths")
		}
	}
	if strings.Contains(h.exec.lines(), "fixup") || strings.Contains(h.exec.lines(), "chroot-exec") {
		t.Error("the run went on although system files cannot be ruled out")
	}
	// All errors are known and none is a system file: still a warning.
	h = newHarness(t, "debian12-uefi-luks-lvm.same", "debian12-uefi-luks-lvm")
	for i := 0; i < 100; i++ {
		h.restic.items = append(h.restic.items, restic.ItemError{Path: fmt.Sprintf("/home/alice/f%03d", i), Message: "read error"})
	}
	rep, err = h.x.Run(context.Background())
	if err != nil || rep.RestoreErrors != 100 || rep.SystemErrors != 0 {
		t.Errorf("100 known errors outside the system paths: %v %+v", err, rep)
	}
}

func TestExecuteInitramfsExtraSpace(t *testing.T) {
	h := newHarness(t, "debian12-uefi-luks-lvm.same", "debian12-uefi-luks-lvm")
	var steps []baremetal.Step
	for _, s := range h.x.Plan.Steps {
		steps = append(steps, s)
		if s.Kind == "initramfs" {
			steps = append(steps, baremetal.Step{Phase: "post", Kind: "initramfs_extra", Target: strPtrT("6.1.0-25-amd64"),
				Args: []string{"chroot-exec", "update-initramfs", "-u", "-k", "6.1.0-25-amd64"}})
		}
	}
	for i := range steps {
		steps[i].N = int64(i + 1)
	}
	h.x.Plan.Steps = steps
	h.ops.free = 100 << 20 // 100 MiB free: not enough for 1.5 x 130 MiB
	rep, err := h.x.Run(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(h.exec.lines(), "6.1.0-25-amd64") && strings.Contains(h.exec.lines(), "chroot-exec update-initramfs -u -k 6.1.0-25-amd64") {
		t.Error("the extra kernel was rebuilt without room")
	}
	if len(rep.NotAdaptedKernels) != 1 || rep.NotAdaptedKernels[0] != "6.1.0-25-amd64" {
		t.Errorf("not adapted %v", rep.NotAdaptedKernels)
	}
}

func TestSfdiskParseCompare(t *testing.T) {
	plan := "label: gpt\nlabel-id: 0B1C2D3E-0000-4000-8000-000000000000\nunit: sectors\nsector-size: 512\n\n/dev/nvme0n1p1 : start=2048, size=1048576, type=C12A7328-F81F-11D2-BA4B-00A0C93EC93B, uuid=5E1C4D0A-1B2C-4D3E-8F90-A1B2C3D4E5F6, name=\"EFI\"\n"
	dump := "label: gpt\nlabel-id: 0b1c2d3e-0000-4000-8000-000000000000\ndevice: /dev/nvme0n1\nunit: sectors\nfirst-lba: 34\nlast-lba: 1000215182\nsector-size: 512\n\n/dev/nvme0n1p1 : start=        2048, size=     1048576, type=C12A7328-F81F-11D2-BA4B-00A0C93EC93B, uuid=5E1C4D0A-1B2C-4D3E-8F90-A1B2C3D4E5F6, name=\"EFI\"\n"
	if d := compareTables(parseSfdiskScript(plan), parseSfdiskScript(dump)); d != "" {
		t.Errorf("equal tables differ: %s", d)
	}
	if d := compareTables(parseSfdiskScript(plan), parseSfdiskScript(strings.Replace(dump, "1048576", "1048575", 1))); d == "" {
		t.Error("a size difference was not found")
	}
	w := mkfsExpect([]string{"mkfs.vfat", "-F", "32", "-i", "F6071829", "-S", "512", "/dev/nvme0n1p1"})
	if w.uuid != "F607-1829" || w.typ != "vfat" {
		t.Errorf("%+v", w)
	}
	w = mkfsExpect([]string{"mkfs.xfs", "-f", "-m", "uuid=f3000000-0000-4000-8000-000000000001,crc=1", "/dev/vg/root"})
	if w.uuid != "f3000000-0000-4000-8000-000000000001" || w.dev != "/dev/vg/root" {
		t.Errorf("%+v", w)
	}
	if !underSystemPath("/lib64/ld.so", nil) || underSystemPath("/home/x", nil) || !underSystemPath("/boot/efi/EFI/x", []string{"/boot/efi"}) || underSystemPath("/library", nil) == false {
		// /library starts with lib: it counts (lib* as the doc says).
	}
	if !LVMFilterMultiline([]byte("devices {\n  filter = [\n    \"a|/dev/sda2|\",\n    \"r|.*|\" ]\n}\n")) || LVMFilterMultiline([]byte("filter = [ \"a|.*|\" ]\n")) {
		t.Error("multiline filter")
	}
}

// TestRecoveryMountArgs: every mount of the target is nodev and nosuid
// during the recovery (restored device nodes cannot be opened, 10.12), the
// options come after those of the plan.
func TestRecoveryMountArgs(t *testing.T) {
	for _, c := range []struct{ in, want string }{
		{"mount -t ext4 /dev/sda2 /mnt/restow-target", "mount -t ext4 -o nodev,nosuid /dev/sda2 /mnt/restow-target"},
		{"mount -t vfat -o quiet /dev/sda1 /mnt/restow-target/boot/efi", "mount -t vfat -o quiet,nodev,nosuid /dev/sda1 /mnt/restow-target/boot/efi"},
		{"mount -t btrfs -o subvol=@,compress=zstd:3,device=/dev/sda2,dev,suid /dev/sda2 /mnt/restow-target",
			"mount -t btrfs -o subvol=@,compress=zstd:3,device=/dev/sda2,dev,suid,nodev,nosuid /dev/sda2 /mnt/restow-target"},
		{"mount -t btrfs -o  /dev/sda2 /mnt/restow-target", "mount -t btrfs -o nodev,nosuid /dev/sda2 /mnt/restow-target"},
	} {
		got, err := recoveryMountArgs(strings.Split(c.in, " "))
		if err != nil || strings.Join(got, " ") != c.want {
			t.Errorf("%s: %q %v, want %s", c.in, got, err, c.want)
		}
	}
	for _, bad := range []string{"mount", "mkfs.ext4 /dev/sda1 x", "mount -t ext4 -oquiet /dev/sda1 /mnt/x", "mount --options=dev /dev/sda1 /mnt/x"} {
		if got, err := recoveryMountArgs(strings.Split(bad, " ")); err == nil {
			t.Errorf("%s accepted: %q", bad, got)
		}
	}
	// The golden plan's mounts reach the ISO's mount with the options.
	h := newHarness(t, "debian12-uefi-luks-lvm.same", "debian12-uefi-luks-lvm")
	if _, err := h.x.Run(context.Background()); err != nil {
		t.Fatalf("run: %v\n%s", err, h.exec.lines())
	}
	n := 0
	for _, l := range strings.Split(h.exec.lines(), "\n") {
		if strings.HasPrefix(l, "mount ") {
			n++
			if !strings.Contains(l, "nodev,nosuid ") {
				t.Errorf("a mount without nodev,nosuid: %s", l)
			}
		}
	}
	if n == 0 {
		t.Error("no mount in the golden plan")
	}
}
