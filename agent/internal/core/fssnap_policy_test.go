//go:build unix

package core

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/restow-backup/restow/agent/internal/api"
	"github.com/restow-backup/restow/agent/internal/baremetal"
	"github.com/restow-backup/restow/agent/internal/fssnap"
	"github.com/restow-backup/restow/agent/internal/sysinfo"
)

// fakeHelperScript stands in for `restow-agent snapshot-exec --spec F --`:
// it records its arguments and runs the rest (the fake restic). Reading
// from snapshots is slow (so the monitor can stop it), live reading fast.
const fakeHelperScript = `#!/bin/sh
printf '%s\n' "$@" >> "$FAKE_DIR/helper-args.txt"
readlink /proc/self/ns/mnt > "$FAKE_DIR/helper-mntns.txt" 2>/dev/null
spec="$3"
if grep -q restowsnap "$spec" 2>/dev/null && [ -n "$FAKE_SNAP_SLOW" ]; then export FAKE_BACKUP_SLEEP=30; fi
shift 4
exec "$@"
`

// fakeFS is an fsBackend driven by the test.
type fakeFS struct {
	t        *testing.T
	bin      string
	facts    fssnap.Facts
	outcome  fssnap.Outcome
	created  []fssnap.Created
	probeErr error
	pressure *fssnap.Pressure
	manifest *baremetal.Manifest
	capErr   error
	mu       sync.Mutex
	removed  int
	specs    []fssnap.Spec
	measured int
	stale    int
	// mountNS overrides whether the helper starts in its own mount
	// namespace (nil: where the test process may make one).
	mountNS *bool
}

func (f *fakeFS) TriggerAutomounts(context.Context) []string { return nil }
func (f *fakeFS) Capture(context.Context, string, string) (*baremetal.Manifest, baremetal.RawSet, error) {
	if f.capErr != nil {
		return nil, nil, f.capErr
	}
	return f.manifest, baremetal.RawSet{"lsblk.json": []byte("{}")}, nil
}
func (f *fakeFS) Mountinfo() []byte {
	return []byte("22 1 253:1 / / rw - ext4 /dev/mapper/vg-root rw\n30 22 259:2 / /boot rw - ext4 /dev/nvme0n1p2 rw\n")
}
func (f *fakeFS) Discover(_ context.Context, sources []string, _ bool) (fssnap.Facts, error) {
	facts := f.facts
	if len(facts.Sources) == 0 {
		for _, s := range sources {
			facts.Sources = append(facts.Sources, fssnap.Source{Path: s, MountTarget: s, FSType: "ext4", Kind: "partition"})
		}
	}
	return facts, nil
}
func (f *fakeFS) Probe(context.Context) error { return f.probeErr }
func (f *fakeFS) Create(context.Context, fssnap.Plan, string) ([]fssnap.Created, fssnap.Outcome) {
	return f.created, f.outcome
}
func (f *fakeFS) Remove(context.Context, []fssnap.Created, string) []fssnap.Failure {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.removed++
	return nil
}
func (f *fakeFS) Watch(ctx context.Context, _ []fssnap.Created, cancel context.CancelCauseFunc) *fssnap.Pressure {
	if f.pressure == nil {
		<-ctx.Done()
		return nil
	}
	select {
	case <-time.After(300 * time.Millisecond):
		cancel(f.pressure.Err)
		return f.pressure
	case <-ctx.Done():
		return nil
	}
}
func (f *fakeFS) WriteSpec(spec fssnap.Spec) (string, func(), error) {
	f.mu.Lock()
	f.specs = append(f.specs, spec)
	f.mu.Unlock()
	b, _ := spec.Encode()
	file := filepath.Join(f.t.TempDir(), "spec.json")
	if err := os.WriteFile(file, b, 0o600); err != nil {
		return "", nil, err
	}
	return file, func() {}, nil
}
func (f *fakeFS) Measure(context.Context, fssnap.Spec, fssnap.MeasureRequest) (fssnap.MeasureResponse, error) {
	f.mu.Lock()
	f.measured++
	f.mu.Unlock()
	return fssnap.MeasureResponse{Sample: []fssnap.SampleFile{{Path: "/etc/hostname", Size: 6, SHA256: strings.Repeat("a", 64)}}}, nil
}

// HelperCommand: the stand-in helper mounts nothing, so these tests of the
// snapshot policy need no privilege. It gets a mount namespace of its own
// where the test process may make one (as root, as the real helper always
// does: Probe lets it run only then); a normal user cannot, and the
// policy is the same without it. The namespace itself is tested as root
// (TestRootHelperGetsItsOwnMountNamespace here, the real helper in
// internal/fssnap).
func (f *fakeFS) HelperCommand(specFile string) ([]string, bool) {
	ns := mayUnshareMounts()
	if f.mountNS != nil {
		ns = *f.mountNS
	}
	return fssnap.HelperArgv(f.bin, specFile, []string{}), ns
}
func (f *fakeFS) CleanupStale(context.Context, string) fssnap.StaleReport {
	f.mu.Lock()
	f.stale++
	f.mu.Unlock()
	return fssnap.StaleReport{}
}

// withFakeFS installs the backend; the harness's sources are LVM file systems.
func withFakeFS(t *testing.T, h *harness) *fakeFS {
	t.Helper()
	helper := filepath.Join(t.TempDir(), "restow-agent")
	if err := os.WriteFile(helper, []byte(fakeHelperScript), 0o755); err != nil {
		t.Fatal(err)
	}
	f := &fakeFS{t: t, bin: helper}
	old := newFSBackendFn
	newFSBackendFn = func(*Agent) fsBackend { return f }
	t.Cleanup(func() { newFSBackendFn = old })
	h.machine = func() sysinfo.Machine { return sysinfo.Machine{Virtualization: sysinfo.VirtVM} }
	src := fssnap.Source{Path: h.src, MountTarget: h.src, FSType: "ext4", Kind: "lv", VG: "vg0", LV: "data"}
	f.facts = fssnap.Facts{Root: fssnap.Source{Path: "/", MountTarget: "/", FSType: "ext4", Kind: "lv", VG: "vg0", LV: "root"},
		Sources: []fssnap.Source{src}, VGs: map[string]fssnap.VG{"vg0": {Name: "vg0", FreeBytes: 100 * fssnap.GiB}},
		LVs: map[string]fssnap.LV{"vg0/data": {VG: "vg0", Name: "data", SizeBytes: 10 * fssnap.GiB}}}
	f.created = []fssnap.Created{{Method: fssnap.MethodLVM, VG: "vg0", LV: "data_restowsnap", Origin: "data", Sources: []string{h.src}, FSType: "ext4"}}
	f.outcome = fssnap.Outcome{Snapshotted: []string{h.src}}
	return f
}

func fsBackup(t *testing.T, h *harness, fake, policy string) *api.FinishRequest {
	t.Helper()
	h.env("FAKE_BACKUP=" + fake)
	if h.srv.Config.FSSnapshot == "" {
		h.srv.Config.FSSnapshot = api.FSSnapshotAuto
	}
	if policy != "" {
		h.srv.Config.Policy = &api.Policy{SnapshotOnFailure: policy}
	}
	h.srv.QueueTask(task("t-1", api.TaskBackupNow, nil))
	h.start()
	return h.waitRun(1).Finish
}

func readFake(t *testing.T, h *harness, name string) string {
	t.Helper()
	b, _ := os.ReadFile(filepath.Join(h.dir, name))
	return string(b)
}

func TestFSSnapshotUsed(t *testing.T) {
	h := newHarness(t)
	f := withFakeFS(t, h)
	fin := fsBackup(t, h, "ok", "")
	if fin.Status != api.StatusSucceeded || len(fin.Errors) != 0 {
		t.Fatalf("%s %+v", fin.Status, fin.Errors)
	}
	if c := fin.Consistency; c == nil || c.Method != "lvm" || c.State != "used" || len(c.LiveFilesystems) != 0 {
		t.Fatalf("consistency %+v", fin.Consistency)
	}
	if args := readFake(t, h, "helper-args.txt"); !strings.HasPrefix(args, "snapshot-exec\n--spec\n") {
		t.Fatalf("restic did not run through the helper:\n%s", args)
	}
	if f.removed != 1 || len(f.specs) != 1 || f.specs[0].Kind != fssnap.SpecTree {
		t.Fatalf("removed %d, specs %+v", f.removed, f.specs)
	}
	if fin.Layout != nil || strings.Contains(readFake(t, h, "backup-args.txt"), "--one-file-system") {
		t.Fatal("not a whole-machine backup")
	}
}

func TestFSSnapshotFailedContinue(t *testing.T) {
	h := newHarness(t)
	f := withFakeFS(t, h)
	f.created = nil
	f.outcome = fssnap.Outcome{Failed: []fssnap.Failure{{Path: h.src, Message: "lvcreate failed"}}}
	fin := fsBackup(t, h, "ok", "")
	if fin.Status != api.StatusPartial || fin.SnapshotID == "" || codes(fin.Errors) != "snapshot_failed" || fin.Errors[0].Path != h.src {
		t.Fatalf("%s %+v", fin.Status, fin.Errors)
	}
	if c := fin.Consistency; c == nil || c.State != "unavailable" || strings.Join(c.LiveFilesystems, ",") != h.src {
		t.Fatalf("consistency %+v", fin.Consistency)
	}
	if !strings.Contains(fin.LogTail, "lvs, vgs, journalctl -k") {
		t.Fatalf("log:\n%s", fin.LogTail)
	}
}

func TestFSSnapshotFailedStopsUnderFail(t *testing.T) {
	h := newHarness(t)
	f := withFakeFS(t, h)
	f.created = nil
	f.outcome = fssnap.Outcome{Failed: []fssnap.Failure{{Path: h.src, Message: "lvcreate failed"}}}
	fin := fsBackup(t, h, "ok", api.SnapshotOnFailureFail)
	if fin.Status != api.StatusFailed || fin.SnapshotID != "" || codes(fin.Errors) != "snapshot_failed" {
		t.Fatalf("%s %+v", fin.Status, fin.Errors)
	}
	if readFake(t, h, "backup-args.txt") != "" {
		t.Fatal("restic ran although the policy stops the backup")
	}
}

func TestFSSnapshotUnavailable(t *testing.T) {
	for _, policy := range []string{"", api.SnapshotOnFailureFail} {
		t.Run("policy "+policy, func(t *testing.T) {
			h := newHarness(t)
			f := withFakeFS(t, h)
			f.created = nil
			f.outcome = fssnap.Outcome{Unavailable: "the kernel has no dm_snapshot", Live: []string{h.src}}
			fin := fsBackup(t, h, "ok", policy)
			want := api.StatusPartial
			if policy != "" {
				want = api.StatusFailed
			}
			if fin.Status != want || codes(fin.Errors) != "snapshot_unavailable" || !strings.Contains(fin.Errors[0].Message, "LVM snapshot") {
				t.Fatalf("%s %+v", fin.Status, fin.Errors)
			}
			if c := fin.Consistency; c == nil || c.State != "unavailable" {
				t.Fatalf("%+v", fin.Consistency)
			}
		})
	}
}

// A file system without a method (a partition) is no error (R8).
func TestFSSnapshotNoMethod(t *testing.T) {
	h := newHarness(t)
	f := withFakeFS(t, h)
	f.facts.Sources[0].Kind = "partition"
	f.created, f.outcome = nil, fssnap.Outcome{}
	fin := fsBackup(t, h, "ok", api.SnapshotOnFailureFail)
	if fin.Status != api.StatusSucceeded || len(fin.Errors) != 0 {
		t.Fatalf("%s %+v", fin.Status, fin.Errors)
	}
	if c := fin.Consistency; c == nil || c.State != "unavailable" || strings.Join(c.LiveFilesystems, ",") != h.src {
		t.Fatalf("%+v", fin.Consistency)
	}
	if readFake(t, h, "helper-args.txt") != "" {
		t.Fatal("the helper ran without a snapshot")
	}
}

// The monitor stops restic when a snapshot overflows; under continue the
// backup runs again from the live file systems.
func TestFSSnapshotOverflowRerunsLive(t *testing.T) {
	h := newHarness(t)
	f := withFakeFS(t, h)
	h.env("FAKE_SNAP_SLOW=1")
	f.pressure = &fssnap.Pressure{Err: fssnap.ErrSnapshotOverflow, Path: h.src, Msg: "the snapshot vg0/data_restowsnap is 96.0 percent full"}
	fin := fsBackup(t, h, "ok", "")
	if fin.Status != api.StatusPartial || fin.SnapshotID == "" || codes(fin.Errors) != "snapshot_failed" || !strings.Contains(fin.Errors[0].Message, "96.0 percent") {
		t.Fatalf("%s %+v", fin.Status, fin.Errors)
	}
	if n := strings.Count(readFake(t, h, "commands.txt"), "backup"); n != 2 {
		t.Fatalf("%d restic runs", n)
	}
	if c := fin.Consistency; c == nil || c.State != "unavailable" {
		t.Fatalf("%+v", fin.Consistency)
	}
}

func TestFSSnapshotOverflowStopsUnderFail(t *testing.T) {
	h := newHarness(t)
	f := withFakeFS(t, h)
	h.env("FAKE_SNAP_SLOW=1")
	f.pressure = &fssnap.Pressure{Err: fssnap.ErrThinPoolPressure, Path: h.src, Msg: "the thin pool vg0/pool is 91.0 percent full (data)"}
	fin := fsBackup(t, h, "ok", api.SnapshotOnFailureFail)
	if fin.Status != api.StatusFailed || codes(fin.Errors) != "snapshot_failed" {
		t.Fatalf("%s %+v", fin.Status, fin.Errors)
	}
	if f.removed != 1 {
		t.Fatalf("snapshots removed %d times", f.removed)
	}
}

func TestWholeMachineBackup(t *testing.T) {
	h := newHarness(t)
	f := withFakeFS(t, h)
	m, err := baremetal.Decode(bytes.TrimRight(mustRead(t, "../baremetal/testdata/capture/debian12-uefi-luks-lvm/expected.json"), "\n"))
	if err != nil {
		t.Fatal(err)
	}
	f.manifest = m
	f.facts = fssnap.Facts{}
	f.created, f.outcome = nil, fssnap.Outcome{}
	h.srv.Config.WholeMachine = true
	h.srv.Config.Paths = []string{"/opt/never"}
	fin := fsBackup(t, h, "ok", "")
	if fin.Status != api.StatusSucceeded || len(fin.Errors) != 0 {
		t.Fatalf("%s %+v\n%s", fin.Status, fin.Errors, fin.LogTail)
	}
	args := readFake(t, h, "backup-args.txt")
	if !strings.Contains(args, "--one-file-system\n--group-by\nhost") || !strings.Contains(args, "--tag\nrestow-agent\n--tag\nrestow-baremetal") {
		t.Fatalf("args:\n%s", args)
	}
	if p := readFake(t, h, "paths.txt"); p != "/\n/boot\n/boot/efi\n/home\n" {
		t.Fatalf("paths:\n%s", p)
	}
	layout, err := os.ReadFile(filepath.Join(h.layout.BaremetalDir(), "layout.json"))
	if err != nil || !bytes.Equal(layout, fin.Layout) {
		t.Fatalf("layout.json and finish differ: %v\n%.300s\n%.300s", err, layout, fin.Layout)
	}
	sent, err := baremetal.Decode(fin.Layout)
	if err != nil {
		t.Fatal(err)
	}
	b := sent.Linux.Backup
	if strings.Join(b.Sources, ",") != "/,/boot,/boot/efi,/home" || b.FSSnapshots["/boot"] != "live" || b.LiveReasons["/boot"] != "partition" {
		t.Fatalf("%+v", b)
	}
	if !strings.Contains(strings.Join(b.Excludes, "\n"), h.layout.StateFile()) {
		t.Fatalf("excludes: %v", b.Excludes)
	}
	if ex := readFake(t, h, "excludes.txt"); !strings.Contains(ex, h.layout.StateFile()) {
		t.Fatalf("excludes:\n%s", ex)
	}
	if readFake(t, h, "helper-args.txt") == "" || f.measured == 0 {
		t.Fatal("a whole-machine backup always runs through the helper and measures in the tree")
	}
	if len(fin.Sample) != 1 || fin.Sample[0].Path != "/etc/hostname" {
		t.Fatalf("sample %+v", fin.Sample)
	}
}

func TestWholeMachineCaptureFails(t *testing.T) {
	h := newHarness(t)
	f := withFakeFS(t, h)
	f.capErr = errors.New("lsblk is not installed")
	f.facts = fssnap.Facts{}
	f.created, f.outcome = nil, fssnap.Outcome{}
	h.srv.Config.WholeMachine = true
	fin := fsBackup(t, h, "ok", "")
	if fin.Status != api.StatusPartial || codes(fin.Errors) != "layout_capture_failed" || fin.Layout != nil {
		t.Fatalf("%s %+v", fin.Status, fin.Errors)
	}
	if p := readFake(t, h, "paths.txt"); p != "/\n/boot\n" {
		t.Fatalf("paths from mountinfo:\n%s", p)
	}
}

func TestWholeMachineNotInContainer(t *testing.T) {
	h := newHarness(t)
	f := withFakeFS(t, h)
	f.manifest = &baremetal.Manifest{}
	h.machine = nil // the harness default: an LXC container
	h.srv.Config.WholeMachine = true
	h.srv.Config.FSSnapshot = api.FSSnapshotOff
	fin := fsBackup(t, h, "ok", "")
	if fin.Status != api.StatusSucceeded || fin.Layout != nil || strings.Contains(readFake(t, h, "backup-args.txt"), "--one-file-system") {
		t.Fatalf("%s %+v", fin.Status, fin.Errors)
	}
	if !strings.Contains(fin.LogTail, "container") {
		t.Fatalf("log:\n%s", fin.LogTail)
	}
}

// TestStateFileExcludedEveryBackup: the agent's secrets are excluded from
// every backup, also without whole machine (docs/BAREMETAL.md 5.4).
func TestStateFileExcludedEveryBackup(t *testing.T) {
	h := newHarness(t)
	h.srv.QueueTask(task("t-1", api.TaskBackupNow, nil))
	h.start()
	if fin := h.waitRun(1).Finish; fin.Status != api.StatusSucceeded {
		t.Fatalf("%s", fin.Status)
	}
	ex := readFake(t, h, "excludes.txt")
	for _, want := range []string{h.layout.StateFile(), filepath.Join(h.layout.StateDir, ".state-*.tmp"), h.layout.CacheDir(), "Restow-Restore-*"} {
		if !strings.Contains(ex, want) {
			t.Errorf("%s missing from the excludes:\n%s", want, ex)
		}
	}
}

// TestStaleSnapshotsCleanedBeforeEveryBackup: leftover snapshots are
// removed at the start and before every backup, also one without
// snapshots (docs/BAREMETAL.md 6.5).
func TestStaleSnapshotsCleanedBeforeEveryBackup(t *testing.T) {
	h := newHarness(t)
	f := withFakeFS(t, h)
	h.srv.Config.FSSnapshot = api.FSSnapshotOff
	fin := fsBackup(t, h, "ok", "")
	if fin.Status != api.StatusSucceeded || fin.Consistency != nil && fin.Consistency.Method != "" {
		t.Fatalf("%s %+v %+v", fin.Status, fin.Errors, fin.Consistency)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.stale < 2 || len(f.specs) != 0 || f.removed != 0 {
		t.Fatalf("stale cleanups %d (want the start and the backup), specs %d, removed %d", f.stale, len(f.specs), f.removed)
	}
}
