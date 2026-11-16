//go:build linux && agentroot

package fssnap

// Real snapshots on loop devices (docs/BAREMETAL.md 21.2, CI job
// agent-root): LVM thick, thin and a full volume group, btrfs with nested
// subvolumes, the helper with its namespace and chroot, restic through it
// against rest-server, nothing left mounted after kill -9, the stale
// cleanup, the thin pool threshold, and what `-x` records of mount point
// folders ([Quelle] 1.2 item 2). The tests run only as root with
// RESTOW_AGENT_ROOT=1 and change the storage of the machine they run on:
// never on a workstation.

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/restow-backup/restow/agent/internal/baremetal"
	"github.com/restow-backup/restow/agent/internal/cmdrun"
)

// rootEnv is the machine of one agent-root test.
type rootEnv struct {
	t    *testing.T
	ctx  context.Context
	work string
	r    cmdrun.Runner
	host baremetal.Host
	h    ExecHelper
}

var builtAgent string

// TestMain removes the agent binary built for the helper.
func TestMain(m *testing.M) {
	code := m.Run()
	if builtAgent != "" {
		_ = os.RemoveAll(filepath.Dir(builtAgent))
	}
	os.Exit(code)
}

func newRootEnv(t *testing.T) *rootEnv {
	t.Helper()
	if os.Getenv("RESTOW_AGENT_ROOT") != "1" {
		t.Skip("agent-root test: set RESTOW_AGENT_ROOT=1 and run as root (CI job agent-root)")
	}
	if os.Geteuid() != 0 {
		t.Fatal("RESTOW_AGENT_ROOT=1 but not root")
	}
	// /var/tmp lies on the root file system of the CI runner, so the
	// read-only bind of / in the snapshot tree has the mount point folders.
	work, err := os.MkdirTemp("/var/tmp", "restow-agentroot-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(work) })
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	t.Cleanup(cancel)
	e := &rootEnv{t: t, ctx: ctx, work: work, r: cmdrun.ExecRunner{}, host: baremetal.LocalHost()}
	e.h = ExecHelper{AgentBin: agentBinary(t), TmpDir: filepath.Join(work, "tmp")}
	for _, d := range []string{"tmp", "cache", "mnt"} {
		if err := os.MkdirAll(filepath.Join(work, d), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	return e
}

// agentBinary is restow-agent for the helper: RESTOW_TEST_AGENT_BIN, else
// built once from this module.
func agentBinary(t *testing.T) string {
	t.Helper()
	if b := os.Getenv("RESTOW_TEST_AGENT_BIN"); b != "" {
		return b
	}
	if builtAgent != "" {
		return builtAgent
	}
	dir, err := os.MkdirTemp("/var/tmp", "restow-agentroot-bin-")
	if err != nil {
		t.Fatal(err)
	}
	bin := filepath.Join(dir, "restow-agent")
	cmd := exec.Command("go", "build", "-o", bin, "github.com/restow-backup/restow/agent/cmd/restow-agent")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("building restow-agent: %v\n%s", err, out)
	}
	builtAgent = bin
	return bin
}

// sh runs a command and fails the test on an error.
func (e *rootEnv) sh(name string, args ...string) string {
	e.t.Helper()
	out, err := exec.CommandContext(e.ctx, name, args...).CombinedOutput()
	if err != nil {
		e.t.Fatalf("%s %s: %v\n%s", name, strings.Join(args, " "), err, out)
	}
	return string(out)
}

// try runs a command for cleanup; errors are only logged.
func (e *rootEnv) try(name string, args ...string) {
	if out, err := exec.Command(name, args...).CombinedOutput(); err != nil {
		e.t.Logf("cleanup %s %s: %v %s", name, strings.Join(args, " "), err, out)
	}
}

// loop creates a sparse file of size MiB and attaches it as a loop device.
func (e *rootEnv) loop(name string, mib int) string {
	e.t.Helper()
	file := filepath.Join(e.work, name+".img")
	e.sh("truncate", "-s", strconv.Itoa(mib)+"M", file)
	dev := strings.TrimSpace(e.sh("losetup", "--find", "--show", "-P", file))
	e.t.Cleanup(func() { e.try("losetup", "-d", dev) })
	return dev
}

// vg creates a volume group on a new loop device.
func (e *rootEnv) vg(mib int) string {
	e.t.Helper()
	name := fmt.Sprintf("rt%d", time.Now().UnixNano()%1_000_000)
	dev := e.loop(name, mib)
	e.sh("pvcreate", "-ff", "-y", dev)
	e.sh("vgcreate", name, dev)
	e.t.Cleanup(func() {
		e.try("vgchange", "-an", name)
		e.try("vgremove", "-ff", "-y", name)
		e.try("pvremove", "-ff", "-y", dev)
	})
	return name
}

// mount mounts dev on a new folder below work/mnt and returns it.
func (e *rootEnv) mount(dev, name string, opts ...string) string {
	e.t.Helper()
	mnt := filepath.Join(e.work, "mnt", name)
	if err := os.MkdirAll(mnt, 0o755); err != nil {
		e.t.Fatal(err)
	}
	args := []string{}
	if len(opts) > 0 {
		args = append(args, "-o", strings.Join(opts, ","))
	}
	e.sh("mount", append(args, dev, mnt)...)
	e.t.Cleanup(func() { e.try("umount", "-l", mnt) })
	return mnt
}

func (e *rootEnv) write(p, content string) {
	e.t.Helper()
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		e.t.Fatal(err)
	}
	e.sh("sync")
}

func sum(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:])
}

// hostMounts is the mount table of the test process (the host namespace).
func hostMounts(t *testing.T) string {
	t.Helper()
	b, err := os.ReadFile("/proc/self/mountinfo")
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// assertNothingMounted: neither the tree nor a btrfs top level is mounted
// on the host (R11).
func assertNothingMounted(t *testing.T) {
	t.Helper()
	mi := hostMounts(t)
	for _, p := range []string{SnapTreeDir, BtrfsTopDir} {
		if strings.Contains(mi, " "+p) {
			t.Fatalf("%s is mounted on the host:\n%s", p, mi)
		}
	}
}

// ownedLVs lists the LVs of a VG with the agent's tag.
func (e *rootEnv) lvNames(vg string) string {
	return e.sh("lvs", "--noheadings", "-o", "lv_name,lv_tags", vg)
}

// plan discovers and plans one source.
func (e *rootEnv) plan(src string) (Facts, Plan) {
	e.t.Helper()
	f, err := Discover(e.ctx, e.r, e.host, []string{src}, false)
	if err != nil {
		e.t.Fatal(err)
	}
	return f, MakePlan(f, "auto")
}

func (e *rootEnv) treeOpts(runID string) TreeOptions {
	return TreeOptions{CacheDir: filepath.Join(e.work, "cache"), TmpDir: filepath.Join(e.work, "tmp"), RunID: runID}
}

// TestRootThickLVM: a thick snapshot is created, holds the content at its
// time under the real path in the tree, and is removed.
func TestRootThickLVM(t *testing.T) {
	e := newRootEnv(t)
	vg := e.vg(4096)
	e.sh("lvcreate", "-y", "-L", "1G", "-n", "data", vg)
	e.sh("mkfs.ext4", "-q", "/dev/"+vg+"/data")
	mnt := e.mount("/dev/"+vg+"/data", "thick")
	e.write(filepath.Join(mnt, "a.txt"), "before")

	f, p := e.plan(mnt)
	if s := f.Sources[0]; s.Kind != "lv" || s.VG != vg || s.LV != "data" || s.Thin {
		t.Fatalf("discovered %+v", s)
	}
	if s := p.Sources[0]; s.Method != MethodLVM || s.CowBytes != GiB || p.Method != "lvm" {
		t.Fatalf("planned %+v (%s)", s, p.Method)
	}
	if err := e.h.Probe(e.ctx); err != nil {
		t.Fatal(err)
	}
	runID := "11111111-1111-4111-8111-111111111111"
	created, out := Create(e.ctx, e.r, e.h, p, runID)
	if len(created) != 1 || strings.Join(out.Snapshotted, ",") != mnt || len(out.Failed) != 0 || out.Unavailable != "" {
		t.Fatalf("created %+v outcome %+v", created, out)
	}
	if l := e.lvNames(vg); !strings.Contains(l, "data"+SnapshotSuffix) || !strings.Contains(l, SnapshotTag) {
		t.Fatalf("lvs:\n%s", l)
	}
	e.write(filepath.Join(mnt, "a.txt"), "after!")

	spec := TreeSpec(p, f, created, e.treeOpts(runID))
	resp, err := e.h.Measure(e.ctx, spec, MeasureRequest{Sample: []SampleFile{{Path: filepath.Join(mnt, "a.txt"), Size: 6}}})
	if err != nil {
		t.Fatal(err)
	}
	if len(resp.Sample) != 1 || resp.Sample[0].SHA256 != sum("before") {
		t.Fatalf("the tree does not show the snapshot under the real path: %+v", resp.Sample)
	}
	assertNothingMounted(t)
	if fails := Remove(e.ctx, e.r, e.h, created, runID); len(fails) != 0 {
		t.Fatalf("remove: %+v", fails)
	}
	if l := e.lvNames(vg); strings.Contains(l, SnapshotSuffix) {
		t.Fatalf("snapshot left:\n%s", l)
	}
}

// TestRootFullVG: a VG without 1 GiB free has no method (vg_no_space).
func TestRootFullVG(t *testing.T) {
	e := newRootEnv(t)
	vg := e.vg(1536)
	e.sh("lvcreate", "-y", "-l", "100%FREE", "-n", "full", vg)
	e.sh("mkfs.ext4", "-q", "/dev/"+vg+"/full")
	mnt := e.mount("/dev/"+vg+"/full", "fullvg")
	_, p := e.plan(mnt)
	if s := p.Sources[0]; s.Method != MethodLive || s.LiveReason != ReasonVGNoSpace || p.Method != "" {
		t.Fatalf("planned %+v (%s)", s, p.Method)
	}
}

// TestRootThinPool: a thin snapshot below 80 percent; the monitor stops at
// 90 percent; afterwards the plan reads the source live (thin_pool_busy).
func TestRootThinPool(t *testing.T) {
	e := newRootEnv(t)
	vg := e.vg(2048)
	// errorwhenfull: a full pool fails writes instead of queueing them. Set
	// with lvchange once the pool exists: lvcreate of LVM 2.03.16 (Ubuntu
	// 24.04, the CI runner) refuses the option together with --type
	// thin-pool ("Option --errorwhenfull is unsupported with thin pools").
	e.sh("lvcreate", "-y", "--type", "thin-pool", "-L", "1G", "-n", "pool", vg)
	e.sh("lvchange", "-y", "--errorwhenfull", "y", vg+"/pool")
	e.sh("lvcreate", "-y", "-V", "2G", "--thinpool", vg+"/pool", "-n", "thin", vg)
	e.sh("mkfs.ext4", "-q", "-E", "nodiscard", "/dev/"+vg+"/thin")
	mnt := e.mount("/dev/"+vg+"/thin", "thin")
	e.write(filepath.Join(mnt, "a.txt"), "before")

	_, p := e.plan(mnt)
	if s := p.Sources[0]; s.Method != MethodLVM || !s.Thin || s.CowBytes != 0 {
		t.Fatalf("planned %+v", s)
	}
	runID := "22222222-2222-4222-8222-222222222222"
	created, out := Create(e.ctx, e.r, e.h, p, runID)
	if len(created) != 1 || len(out.Snapshotted) != 1 {
		t.Fatalf("created %+v outcome %+v", created, out)
	}
	t.Cleanup(func() { Remove(context.Background(), e.r, e.h, created, runID) })

	wctx, stop := context.WithCancelCause(e.ctx)
	defer stop(nil)
	done := make(chan *Pressure, 1)
	go func() { done <- Watch(wctx, e.r, created, time.Second, stop) }()
	// New blocks in the origin while the snapshot keeps the old ones.
	_ = exec.CommandContext(e.ctx, "dd", "if=/dev/urandom", "of="+filepath.Join(mnt, "fill"), "bs=1M", "count=940", "conv=fsync").Run()
	var pr *Pressure
	select {
	case pr = <-done:
	case <-time.After(2 * time.Minute):
		t.Fatal("the monitor did not stop at 90 percent")
	}
	if pr == nil || pr.Err != ErrThinPoolPressure || context.Cause(wctx) != ErrThinPoolPressure {
		t.Fatalf("pressure %+v cause %v", pr, context.Cause(wctx))
	}
	if fails := Remove(e.ctx, e.r, e.h, created, runID); len(fails) != 0 {
		t.Fatalf("remove: %+v", fails)
	}
	created = nil
	_, p = e.plan(mnt)
	if s := p.Sources[0]; s.Method != MethodLive || s.LiveReason != ReasonThinPoolBusy {
		t.Fatalf("rerun planned %+v", s)
	}
}

// TestRootBtrfsNested: a read-only snapshot per subvolume through the
// helper; the nested subvolume has its own; nothing stays mounted; the
// stale cleanup removes only what lies below .restow-snapshots.
func TestRootBtrfsNested(t *testing.T) {
	e := newRootEnv(t)
	dev := e.loop("btrfs", 4096)
	e.sh("mkfs.btrfs", "-q", "-f", dev)
	top := e.mount(dev, "btrfs-top")
	e.sh("btrfs", "subvolume", "create", filepath.Join(top, "@data"))
	e.sh("btrfs", "subvolume", "create", filepath.Join(top, "@data", "nested"))
	e.sh("btrfs", "subvolume", "create", filepath.Join(top, "foreign"))
	e.sh("umount", top)
	mnt := e.mount(dev, "btrfs", "subvol=@data")
	e.write(filepath.Join(mnt, "a.txt"), "before")
	e.write(filepath.Join(mnt, "nested", "b.txt"), "nested")

	f, err := Discover(e.ctx, e.r, e.host, []string{mnt, filepath.Join(mnt, "nested")}, false)
	if err != nil {
		t.Fatal(err)
	}
	if a, b := f.Sources[0], f.Sources[1]; a.SubvolPath != "@data" || b.SubvolPath != "@data/nested" || a.SubvolID == b.SubvolID || a.BtrfsUUID == "" {
		t.Fatalf("discovered %+v / %+v", a, b)
	}
	p := MakePlan(f, "auto")
	if p.Method != "btrfs" || p.Sources[0].PreFail != "" {
		t.Fatalf("planned %+v", p)
	}
	runID := "33333333-3333-4333-8333-333333333333"
	created, out := Create(e.ctx, e.r, e.h, p, runID)
	if len(created) != 2 || len(out.Snapshotted) != 2 {
		t.Fatalf("created %+v outcome %+v", created, out)
	}
	assertNothingMounted(t)
	list := e.sh("btrfs", "subvolume", "list", "-a", mnt)
	for _, c := range created {
		if !strings.Contains(list, c.SnapPath) {
			t.Fatalf("%s missing:\n%s", c.SnapPath, list)
		}
	}
	e.write(filepath.Join(mnt, "a.txt"), "after!")
	spec := TreeSpec(p, f, created, e.treeOpts(runID))
	resp, err := e.h.Measure(e.ctx, spec, MeasureRequest{Sample: []SampleFile{
		{Path: filepath.Join(mnt, "a.txt"), Size: 6}, {Path: filepath.Join(mnt, "nested", "b.txt"), Size: 6}}})
	if err != nil {
		t.Fatal(err)
	}
	if len(resp.Sample) != 2 || resp.Sample[0].SHA256 != sum("before") || resp.Sample[1].SHA256 != sum("nested") {
		t.Fatalf("tree: %+v", resp.Sample)
	}

	// A crash leaves the snapshots; the stale cleanup removes them and
	// leaves every other subvolume alone.
	rep := CleanupStale(e.ctx, e.r, e.h, e.host, "")
	if rep.Removed != 2 || len(rep.Failures) != 0 {
		t.Fatalf("stale cleanup: %+v", rep)
	}
	list = e.sh("btrfs", "subvolume", "list", "-a", mnt)
	if strings.Contains(list, SnapDirName+"/") || !strings.Contains(list, "foreign") || !strings.Contains(list, "@data/nested") {
		t.Fatalf("after the cleanup:\n%s", list)
	}
	assertNothingMounted(t)
}

// TestRootCleanupStaleLVM: only LVs with both the tag and the suffix go.
func TestRootCleanupStaleLVM(t *testing.T) {
	e := newRootEnv(t)
	vg := e.vg(6144)
	e.sh("lvcreate", "-y", "-L", "256M", "-n", "data", vg)
	e.sh("lvcreate", "-y", "-s", "-L", "256M", "-n", "data"+SnapshotSuffix, "--addtag", SnapshotTag, vg+"/data")
	e.sh("lvcreate", "-y", "-s", "-L", "256M", "-n", "other"+SnapshotSuffix, vg+"/data")
	e.sh("lvcreate", "-y", "-s", "-L", "256M", "-n", "tagged", "--addtag", SnapshotTag, vg+"/data")
	rep := CleanupStale(e.ctx, e.r, nil, nil, "")
	if rep.Removed != 1 || len(rep.Failures) != 0 || !strings.Contains(rep.String(), "1 leftover") {
		t.Fatalf("stale cleanup: %+v %q", rep, rep.String())
	}
	l := e.lvNames(vg)
	if strings.Contains(l, "data"+SnapshotSuffix) || !strings.Contains(l, "other"+SnapshotSuffix) || !strings.Contains(l, "tagged") {
		t.Fatalf("lvs after the cleanup:\n%s", l)
	}
}

// liveTree is a whole-machine tree without snapshots: an ext4 loop device
// mounted on the host (read live) and a second one only in the helper
// (noauto, mounted read-only there, R13).
func (e *rootEnv) liveTree() (Facts, string, string) {
	e.t.Helper()
	dev := e.loop("live", 64)
	e.sh("mkfs.ext4", "-q", dev)
	mnt := e.mount(dev, "live")
	e.write(filepath.Join(mnt, "a.txt"), "live")
	dev2 := e.loop("noauto", 64)
	e.sh("mkfs.ext4", "-q", dev2)
	tmp := e.mount(dev2, "noauto-fill")
	e.write(filepath.Join(tmp, "n.txt"), "noauto")
	e.sh("umount", tmp)
	noauto := filepath.Join(e.work, "mnt", "noauto")
	if err := os.MkdirAll(noauto, 0o755); err != nil {
		e.t.Fatal(err)
	}
	f, err := Discover(e.ctx, e.r, e.host, []string{mnt}, false)
	if err != nil {
		e.t.Fatal(err)
	}
	f.Sources = append(f.Sources, Source{Path: noauto, MountTarget: noauto, FSType: "ext4", Device: dev2, Kind: "noauto", Noauto: true})
	return f, mnt, noauto
}

// TestRootHelperLiveTree: the tree with live binds and a noauto mount;
// the files appear under their real paths; nothing reaches the host.
func TestRootHelperLiveTree(t *testing.T) {
	e := newRootEnv(t)
	f, mnt, noauto := e.liveTree()
	if s := MakePlan(f, "auto").Sources[0]; s.Method != MethodLive || s.LiveReason != ReasonPartition {
		t.Fatalf("a plain disk has no method: %+v", s)
	}
	spec := LiveSpec(f, e.treeOpts("66666666-6666-4666-8666-666666666666"))
	var opts string
	for _, m := range spec.Mounts {
		if m.Target == filepath.Join(SnapTreeDir, noauto) {
			opts = m.Options
		}
	}
	if opts != "ro,noload" {
		t.Fatalf("noauto mount options %q in %+v", opts, spec.Mounts)
	}
	resp, err := e.h.Measure(e.ctx, spec, MeasureRequest{Sample: []SampleFile{
		{Path: filepath.Join(mnt, "a.txt"), Size: 4}, {Path: filepath.Join(noauto, "n.txt"), Size: 6}}})
	if err != nil {
		t.Fatal(err)
	}
	if len(resp.Sample) != 2 || resp.Sample[0].SHA256 != sum("live") || resp.Sample[1].SHA256 != sum("noauto") {
		t.Fatalf("tree: %+v", resp.Sample)
	}
	assertNothingMounted(t)
	if strings.Contains(hostMounts(t), " "+noauto+" ") {
		t.Fatalf("the noauto entry is mounted on the host")
	}
}

// TestRootKill9LeavesNothingMounted: the helper killed with SIGKILL, and a
// parent (the agent) killed with SIGKILL: the namespace and its mounts go
// with the process (Pdeathsig), in no namespace does the tree remain.
func TestRootKill9LeavesNothingMounted(t *testing.T) {
	e := newRootEnv(t)
	f, _, noauto := e.liveTree()
	file, cleanup, err := e.h.WriteSpec(LiveSpec(f, e.treeOpts("44444444-4444-4444-8444-444444444444")))
	if err != nil {
		t.Fatal(err)
	}
	defer cleanup()

	for _, viaParent := range []bool{false, true} {
		var cmd *exec.Cmd
		if viaParent {
			// The parent stands in for the agent: it starts the helper the
			// way the agent does (Pdeathsig) and is then killed.
			cmd = exec.Command(os.Args[0], "-test.run=^TestRootHelperParent$")
			cmd.Env = append(os.Environ(), "RESTOW_AGENTROOT_PARENT="+file, "RESTOW_AGENTROOT_BIN="+e.h.AgentBin, "RESTOW_AGENTROOT_MARK="+noauto)
		} else {
			cmd = e.h.command(context.Background(), file, []string{"/bin/sleep", "300"})
		}
		stdout, _ := cmd.StdoutPipe()
		var stderr bytes.Buffer
		cmd.Stderr = &stderr
		if err := cmd.Start(); err != nil {
			t.Fatal(err)
		}
		pid := cmd.Process.Pid
		if viaParent {
			// The parent prints the helper's pid once the tree is mounted.
			sc := bufio.NewScanner(stdout)
			for sc.Scan() {
				if rest, ok := strings.CutPrefix(sc.Text(), "helper "); ok {
					pid, _ = strconv.Atoi(rest)
					break
				}
			}
			if pid == cmd.Process.Pid {
				t.Fatal("the parent did not report the helper")
			}
		}
		if !waitMounted(pid, noauto) {
			_ = cmd.Process.Kill()
			_ = cmd.Wait()
			t.Fatalf("pid %d (parent: %v) never had the tree mounted: %s", pid, viaParent, stderr.String())
		}
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		waitGone(t, pid)
		assertNothingMounted(t)
		assertNoNamespaceHoldsTree(t, noauto)
	}
}

// assertNoNamespaceHoldsTree: no process on the machine has the tree
// (inside the chroot mountinfo shows the paths below the tree, so the
// noauto mount point marks it).
func assertNoNamespaceHoldsTree(t *testing.T, mark string) {
	t.Helper()
	files, _ := filepath.Glob("/proc/[0-9]*/mountinfo")
	for _, f := range files {
		if treeMounted(f, mark) {
			t.Fatalf("%s still has the snapshot tree", f)
		}
	}
}

// treeMounted reports whether a mountinfo has the tree: seen from outside
// (SnapTreeDir) or from inside the chroot (the mark mounted).
func treeMounted(mountinfo, mark string) bool {
	b, err := os.ReadFile(mountinfo)
	if err != nil {
		return false
	}
	return bytes.Contains(b, []byte(" "+SnapTreeDir)) || bytes.Contains(b, []byte(" "+mark+" "))
}

// TestRootHelperParent is the stand-in agent of the kill -9 test.
func TestRootHelperParent(t *testing.T) {
	spec := os.Getenv("RESTOW_AGENTROOT_PARENT")
	if spec == "" {
		t.Skip("only as the child of TestRootKill9LeavesNothingMounted")
	}
	h := ExecHelper{AgentBin: os.Getenv("RESTOW_AGENTROOT_BIN")}
	cmd := h.command(context.Background(), spec, []string{"/bin/sleep", "300"})
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	if !waitMounted(cmd.Process.Pid, os.Getenv("RESTOW_AGENTROOT_MARK")) {
		t.Fatal("the helper never had the tree mounted")
	}
	fmt.Printf("helper %d\n", cmd.Process.Pid)
	_ = cmd.Wait()
}

func waitMounted(pid int, mark string) bool {
	for i := 0; i < 300; i++ {
		if treeMounted(fmt.Sprintf("/proc/%d/mountinfo", pid), mark) {
			return true
		}
		time.Sleep(100 * time.Millisecond)
	}
	return false
}

func waitGone(t *testing.T, pid int) {
	t.Helper()
	for i := 0; i < 300; i++ {
		if err := syscall.Kill(pid, 0); err != nil {
			return
		}
		// A zombie still answers; it holds no mounts any more.
		if b, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid)); err == nil && bytes.Contains(b, []byte(") Z ")) {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("pid %d is still running after SIGKILL of its parent", pid)
}

// restServer starts rest-server (RESTOW_TEST_REST_SERVER) and returns a
// repository URL; it skips without restic and rest-server.
func (e *rootEnv) restServer() (restic, repo string) {
	e.t.Helper()
	restic = os.Getenv("RESTIC_BINARY")
	if restic == "" {
		restic = os.Getenv("RESTOW_TEST_RESTIC")
	}
	rs := os.Getenv("RESTOW_TEST_REST_SERVER")
	if restic == "" {
		e.t.Skip("RESTIC_BINARY is needed")
	}
	if rs == "" {
		// Without rest-server: a local repository in the cache folder,
		// which the tree binds writable at the same path.
		repo = filepath.Join(e.work, "cache", "repo")
		e.restic(restic, repo, "init")
		return restic, repo
	}
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		e.t.Fatal(err)
	}
	addr := l.Addr().String()
	_ = l.Close()
	cmd := exec.Command(rs, "--no-auth", "--listen", addr, "--path", filepath.Join(e.work, "repo"))
	if err := cmd.Start(); err != nil {
		e.t.Fatal(err)
	}
	e.t.Cleanup(func() { _ = cmd.Process.Kill(); _ = cmd.Wait() })
	for i := 0; i < 100; i++ {
		if c, err := net.Dial("tcp", addr); err == nil {
			_ = c.Close()
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	repo = "rest:http://" + addr + "/"
	e.restic(restic, repo, "init")
	return restic, repo
}

func (e *rootEnv) restic(bin, repo string, args ...string) string {
	e.t.Helper()
	cmd := exec.CommandContext(e.ctx, bin, append([]string{"-r", repo, "--no-cache"}, args...)...)
	cmd.Env = append(os.Environ(), "RESTIC_PASSWORD=agentroot")
	out, err := cmd.CombinedOutput()
	if err != nil {
		e.t.Fatalf("restic %s: %v\n%s", strings.Join(args, " "), err, out)
	}
	return string(out)
}

// resticInTree runs restic backup through the helper (chroot into the
// tree) with the agent's options.
func (e *rootEnv) resticInTree(spec Spec, bin, repo, tag string, sources ...string) {
	e.t.Helper()
	file, cleanup, err := e.h.WriteSpec(spec)
	if err != nil {
		e.t.Fatal(err)
	}
	defer cleanup()
	argv := append([]string{bin, "-r", repo, "--no-cache", "backup", "--json", "--one-file-system", "--group-by", "host", "--tag", tag}, sources...)
	cmd := e.h.command(e.ctx, file, argv)
	// restic writes its temporary files where the agent points TMPDIR: the
	// writable TmpDir bind of the tree.
	cmd.Env = append(cmd.Env, "RESTIC_PASSWORD=agentroot", "TMPDIR="+filepath.Join(e.work, "tmp"))
	if out, err := cmd.CombinedOutput(); err != nil {
		e.t.Fatalf("restic through the helper: %v\n%s", err, out)
	}
	assertNothingMounted(e.t)
}

// TestRootResticLiveTree: restic in the tree without snapshots (whole
// machine with fsSnapshot off, R13): the live source and the noauto entry
// are backed up under their real paths; the noauto entry never appears on
// the host. Then [Quelle] 1.2 item 2 on the live file systems: -x does not
// cross into a file system mounted below a source; whether it records the
// mount point folder itself goes to the log for docs/BAREMETAL.md (either
// answer is valid: recover creates the folders, 10.12).
func TestRootResticLiveTree(t *testing.T) {
	e := newRootEnv(t)
	bin, repo := e.restServer()
	f, mnt, noauto := e.liveTree()
	opts := e.treeOpts("77777777-7777-4777-8777-777777777777")
	opts.ResticBin = bin
	e.resticInTree(LiveSpec(f, opts), bin, repo, "tree", mnt, noauto)
	ls := e.restic(bin, repo, "ls", "--json", "--tag", "tree", "latest")
	if !lsHas(ls, filepath.Join(mnt, "a.txt")) || !lsHas(ls, filepath.Join(noauto, "n.txt")) {
		t.Fatalf("not under the real paths:\n%s", ls)
	}
	if strings.Contains(hostMounts(t), " "+noauto+" ") {
		t.Fatal("the noauto entry is mounted on the host")
	}

	sub := filepath.Join(mnt, "sub")
	if err := os.MkdirAll(sub, 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.Chown(sub, 1234, 1234); err != nil {
		t.Fatal(err)
	}
	dev := e.loop("sub", 64)
	e.sh("mkfs.ext4", "-q", dev)
	e.sh("mount", dev, sub)
	t.Cleanup(func() { e.try("umount", "-l", sub) })
	e.write(filepath.Join(sub, "inner.txt"), "inner")
	e.restic(bin, repo, "backup", "--one-file-system", "--tag", "live", mnt)
	ls = e.restic(bin, repo, "ls", "--json", "--tag", "live", "latest")
	if lsHas(ls, filepath.Join(sub, "inner.txt")) {
		t.Fatalf("-x crossed into the file system on %s:\n%s", sub, ls)
	}
	mode, uid, ok := lsNode(ls, sub)
	t.Logf("QUELLE-1.2.2 restic -x records the mount point folder %s: %v (mode %s, uid %s)", sub, ok, mode, uid)
}

// TestRootResticThroughHelper: restic in the tree reads the LVM snapshot
// (the content at its time) and records the real paths.
func TestRootResticThroughHelper(t *testing.T) {
	e := newRootEnv(t)
	bin, repo := e.restServer()
	vg := e.vg(4096)
	e.sh("lvcreate", "-y", "-L", "1G", "-n", "data", vg)
	e.sh("mkfs.ext4", "-q", "/dev/"+vg+"/data")
	mnt := e.mount("/dev/"+vg+"/data", "restic")
	e.write(filepath.Join(mnt, "a.txt"), "before")
	f, p := e.plan(mnt)
	runID := "55555555-5555-4555-8555-555555555555"
	created, _ := Create(e.ctx, e.r, e.h, p, runID)
	if len(created) != 1 {
		t.Fatalf("created %+v", created)
	}
	defer Remove(context.Background(), e.r, e.h, created, runID)
	e.write(filepath.Join(mnt, "a.txt"), "after!")
	opts := e.treeOpts(runID)
	opts.ResticBin = bin
	e.resticInTree(TreeSpec(p, f, created, opts), bin, repo, "tree", mnt)
	if !lsHas(e.restic(bin, repo, "ls", "--json", "--tag", "tree", "latest"), filepath.Join(mnt, "a.txt")) {
		t.Fatalf("the snapshot is not under the real path %s", mnt)
	}
	if dump := e.restic(bin, repo, "dump", "--tag", "tree", "latest", filepath.Join(mnt, "a.txt")); dump != "before" {
		t.Fatalf("backed up %q, not the snapshot's content", dump)
	}
}

type lsEntry struct {
	Path string `json:"path"`
	Mode int64  `json:"mode"`
	UID  int64  `json:"uid"`
}

func lsNode(ls, p string) (mode, uid string, ok bool) {
	for _, line := range strings.Split(ls, "\n") {
		var n lsEntry
		if json.Unmarshal([]byte(line), &n) == nil && n.Path == p {
			return strconv.FormatInt(n.Mode, 8), strconv.FormatInt(n.UID, 10), true
		}
	}
	return "", "", false
}

func lsHas(ls, p string) bool {
	_, _, ok := lsNode(ls, p)
	return ok
}
