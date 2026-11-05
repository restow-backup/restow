package fssnap

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/restow-backup/restow/agent/internal/baremetal"
	"github.com/restow-backup/restow/agent/internal/cmdrun"
)

var update = flag.Bool("update", false, "rewrite the golden files")

const golden = "testdata/fssnap"

// fakeHelper records helper calls next to the runner's.
type fakeHelper struct {
	mu    sync.Mutex
	lines *[]string
	fail  map[string]error
	resp  MeasureResponse
	runs  []Spec
}

func (f *fakeHelper) Run(_ context.Context, spec Spec, argv []string) ([]byte, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if err := cmdrun.Forbidden(argv); err != nil {
		return nil, err
	}
	var m []string
	for _, x := range spec.Mounts {
		m = append(m, fmt.Sprintf("%s:%s(%s)", x.Source, x.Target, x.Options))
	}
	line := fmt.Sprintf("helper %s mounts=[%s] mkdirs=[%s] -- %s", spec.Kind, strings.Join(m, " "), strings.Join(spec.Mkdirs, " "), strings.Join(argv, " "))
	*f.lines = append(*f.lines, line)
	f.runs = append(f.runs, spec)
	for k, err := range f.fail {
		if strings.Contains(line, k) {
			return nil, err
		}
	}
	return nil, nil
}

func (f *fakeHelper) Measure(context.Context, Spec, MeasureRequest) (MeasureResponse, error) {
	return f.resp, nil
}

func (f *fakeHelper) Probe(context.Context) error { return nil }

// loggingRunner records the runner's calls into the same list.
type loggingRunner struct {
	next  cmdrun.Runner
	lines *[]string
}

func (l loggingRunner) Run(ctx context.Context, name string, args ...string) ([]byte, error) {
	*l.lines = append(*l.lines, strings.Join(append([]string{name}, args...), " "))
	return l.next.Run(ctx, name, args...)
}

// RunNoKill keeps the no-kill path visible to the fake.
func (l loggingRunner) RunNoKill(ctx context.Context, timeout time.Duration, name string, args ...string) ([]byte, error) {
	*l.lines = append(*l.lines, strings.Join(append([]string{name}, args...), " "))
	return cmdrun.RunNoKill(ctx, l.next, timeout, name, args...)
}

func checkGolden(t *testing.T, name string, got []byte) {
	t.Helper()
	p := filepath.Join(golden, name)
	if *update {
		if err := os.MkdirAll(golden, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, got, 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	want, err := os.ReadFile(p)
	if err != nil {
		t.Fatalf("%s: %v (run with -update)", name, err)
	}
	if string(want) != string(got) {
		t.Fatalf("%s differs:\n--- got\n%s\n--- want\n%s", name, got, want)
	}
}

// facts builds Facts for the planner without discovery.
func lvSrc(path, vg, lv, fstype string) Source {
	return Source{Path: path, MountTarget: path, FSType: fstype, Device: "/dev/mapper/" + vg + "-" + lv, Kind: "lv", VG: vg, LV: lv}
}

func thickFacts(free int64) Facts {
	root := lvSrc("/", "vg0", "root", "ext4")
	home := lvSrc("/home", "vg0", "home", "xfs")
	return Facts{Root: root, Sources: []Source{root, home,
		{Path: "/boot", MountTarget: "/boot", FSType: "ext4", Device: "/dev/sda2", Kind: "partition"},
		{Path: "/boot/efi", MountTarget: "/boot/efi", FSType: "vfat", Device: "/dev/sda1", Kind: "partition"}},
		VGs:   map[string]VG{"vg0": {Name: "vg0", SizeBytes: 500 * GiB, FreeBytes: free, Extent: 4 << 20}},
		LVs:   map[string]LV{"vg0/root": {VG: "vg0", Name: "root", SizeBytes: 50 * GiB}, "vg0/home": {VG: "vg0", Name: "home", SizeBytes: 400 * GiB}},
		Pools: map[string]LV{}, Btrfs: map[string]BtrfsFS{}}
}

func thinFacts(data, meta float64) Facts {
	root := lvSrc("/", "vg0", "root", "ext4")
	root.Thin, root.Pool = true, "pool"
	return Facts{Root: root, Sources: []Source{root}, VGs: map[string]VG{"vg0": {Name: "vg0", FreeBytes: 10 * GiB}},
		LVs:   map[string]LV{"vg0/root": {VG: "vg0", Name: "root", SizeBytes: 40 * GiB, Thin: true, Pool: "pool"}},
		Pools: map[string]LV{"vg0/pool": {VG: "vg0", Name: "pool", DataPercent: data, MetaPercent: meta}}, Btrfs: map[string]BtrfsFS{}}
}

func btrfsFacts(free int64) Facts {
	root := Source{Path: "/", MountTarget: "/", FSType: "btrfs", Device: "/dev/nvme0n1p3", Kind: "btrfs", BtrfsUUID: "f1", SubvolPath: "root", SubvolID: 257, SubvolTarget: "/"}
	home := Source{Path: "/home", MountTarget: "/home", FSType: "btrfs", Device: "/dev/nvme0n1p3", Kind: "btrfs", BtrfsUUID: "f1", SubvolPath: "home", SubvolID: 256, SubvolTarget: "/home"}
	mach := Source{Path: "/var/lib/machines", MountTarget: "/", FSType: "btrfs", Device: "/dev/nvme0n1p3", Kind: "btrfs", BtrfsUUID: "f1", SubvolPath: "root/var/lib/machines", SubvolID: 258, SubvolTarget: "/var/lib/machines"}
	srv := lvSrc("/srv", "data", "srv", "ext4")
	return Facts{Root: root, Sources: []Source{root, home, mach, srv},
		VGs:   map[string]VG{"data": {Name: "data", FreeBytes: 100 * GiB}},
		LVs:   map[string]LV{"data/srv": {VG: "data", Name: "srv", SizeBytes: 100 * GiB}},
		Pools: map[string]LV{}, Btrfs: map[string]BtrfsFS{"f1": {UUID: "f1", Device: "/dev/nvme0n1p3", Mount: "/", SizeBytes: 1000 * GiB, FreeBytes: free}}}
}

func TestCOWSizing(t *testing.T) {
	for size, want := range map[int64]int64{5 * GiB: 1 * GiB, 50 * GiB: 5 * GiB, 400 * GiB: 32 * GiB, 320 * GiB: 32 * GiB, 100 * GiB: 10 * GiB} {
		if got := COWBytes(size); got != want {
			t.Errorf("%d: %d, want %d", size, got, want)
		}
	}
}

func TestPlanThick(t *testing.T) {
	p := MakePlan(thickFacts(40*GiB), "auto")
	got := map[string]string{}
	for _, s := range p.Sources {
		got[s.Path] = string(s.Method) + "/" + s.LiveReason
	}
	// 90 % of 40 GiB is 36 GiB: root (5 GiB) first, home (32 GiB) does not fit.
	want := map[string]string{"/": "lvm/", "/home": "live/vg_no_space", "/boot": "live/partition", "/boot/efi": "live/vfat"}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("%s: %s, want %s", k, got[k], v)
		}
	}
	if p.Sources[0].CowBytes != 5*GiB || p.Method != "lvm" || len(p.Notes) != 1 || !strings.Contains(p.Notes[0], "/home") {
		t.Fatalf("%+v", p)
	}
	// Enough space: both.
	p = MakePlan(thickFacts(100*GiB), "auto")
	if p.Sources[1].Method != MethodLVM || p.Sources[1].CowBytes != 32*GiB {
		t.Fatalf("%+v", p.Sources[1])
	}
	// The guided installations fill the VG: no method, no error.
	p = MakePlan(thickFacts(4<<20), "auto")
	if p.Sources[0].LiveReason != ReasonVGNoSpace || p.Sources[1].LiveReason != ReasonVGNoSpace || p.Method != "" || len(p.Notes) != 0 {
		t.Fatalf("%+v", p)
	}
	// Off.
	p = MakePlan(thickFacts(100*GiB), "off")
	for _, s := range p.Sources {
		if s.Method != MethodLive || s.LiveReason != ReasonOff {
			t.Fatalf("%+v", s)
		}
	}
	if p.Requested || p.Method != "" {
		t.Fatal(p)
	}
	fs, lr := MakePlan(thickFacts(40*GiB), "auto").FSSnapshots()
	if fs["/"] != "lvm" || fs["/home"] != "live" || lr["/home"] != "vg_no_space" || lr["/"] != "" {
		t.Fatalf("%v %v", fs, lr)
	}
}

func TestPlanThinAndOthers(t *testing.T) {
	if p := MakePlan(thinFacts(50, 10), "auto"); p.Sources[0].Method != MethodLVM || p.Sources[0].CowBytes != 0 {
		t.Fatalf("%+v", p)
	}
	for _, f := range []Facts{thinFacts(85, 10), thinFacts(10, 80)} {
		if p := MakePlan(f, "auto"); p.Sources[0].LiveReason != ReasonThinPoolBusy || len(p.Notes) != 1 {
			t.Fatalf("%+v", p)
		}
	}
	f := thickFacts(100 * GiB)
	f.Sources[1].LUKSOnLV = true
	f.Sources = append(f.Sources, Source{Path: "/srv", MountTarget: "/srv", FSType: "ext4", Kind: "md"}, lvSrc("/data", "vg0", "data", "f2fs"))
	p := MakePlan(f, "auto")
	if p.Sources[1].LiveReason != ReasonLUKSOnLV || p.Sources[4].LiveReason != ReasonMD || p.Sources[5].LiveReason != ReasonUnsupportedFS {
		t.Fatalf("%+v", p.Sources)
	}
	// Tools missing: unavailable.
	f = thickFacts(100 * GiB)
	f.Unavailable = "the LVM tools (lvm2) are not installed"
	if p := MakePlan(f, "auto"); p.Unavailable == "" {
		t.Fatal("unavailable not set")
	}
}

func TestPlanBtrfs(t *testing.T) {
	p := MakePlan(btrfsFacts(500*GiB), "auto")
	if p.Method != "mixed" {
		t.Fatalf("method %s", p.Method)
	}
	for _, s := range p.Sources[:3] {
		if s.Method != MethodBtrfs || s.PreFail != "" {
			t.Fatalf("%+v", s)
		}
	}
	// 3 % free: snapshot_failed (the method exists).
	p = MakePlan(btrfsFacts(30*GiB), "auto")
	if p.Sources[0].PreFail == "" || p.Sources[0].Method != MethodBtrfs {
		t.Fatalf("%+v", p.Sources[0])
	}
	f := btrfsFacts(1 * GiB)
	f.Btrfs["f1"] = BtrfsFS{UUID: "f1", SizeBytes: 10 * GiB, FreeBytes: 1 * GiB}
	if p := MakePlan(f, "auto"); p.Sources[0].PreFail == "" {
		t.Fatal("below 2 GiB not refused")
	}
}

func runCreate(t *testing.T, name string, f Facts, rec func(*cmdrun.FakeRunner), helperFail map[string]error) ([]Created, Outcome, []string) {
	t.Helper()
	var lines []string
	fake := cmdrun.NewFake(t)
	if rec != nil {
		rec(fake)
	}
	h := &fakeHelper{lines: &lines, fail: helperFail}
	r := loggingRunner{next: fake, lines: &lines}
	plan := MakePlan(f, "auto")
	created, out := Create(context.Background(), r, h, plan, "run-1")
	lines = append(lines, "-- remove")
	out.CleanupFailed = append(out.CleanupFailed, Remove(context.Background(), r, h, created, "run-1")...)
	if name != "" {
		checkGolden(t, name+".cmds", []byte(strings.Join(lines, "\n")+"\n"))
	}
	return created, out, lines
}

func TestCreateThick(t *testing.T) {
	created, out, _ := runCreate(t, "thick-free", thickFacts(100*GiB), func(f *cmdrun.FakeRunner) {
		f.Add(LVCreateThick("vg0", "root", 5*GiB), "  Logical volume \"root_restowsnap\" created.\n", 0)
		f.Add(LVCreateThick("vg0", "home", 32*GiB), "", 0)
		f.Add(LVRemove("vg0", "root_restowsnap"), "", 0)
		f.Add(LVRemove("vg0", "home_restowsnap"), "", 0)
	}, nil)
	if len(created) != 2 || strings.Join(out.Snapshotted, ",") != "/,/home" || strings.Join(out.Live, ",") != "/boot,/boot/efi" || len(out.Failed) != 0 {
		t.Fatalf("%+v %+v", created, out)
	}
}

func TestCreateThin(t *testing.T) {
	_, out, _ := runCreate(t, "thin-50", thinFacts(50, 10), func(f *cmdrun.FakeRunner) {
		f.Add(LVCreateThin("vg0", "root"), "", 0)
		f.Add(LVActivate("vg0", "root_restowsnap"), "", 0)
		f.Add(LVRemove("vg0", "root_restowsnap"), "", 0)
	}, nil)
	if strings.Join(out.Snapshotted, ",") != "/" {
		t.Fatalf("%+v", out)
	}
	_, out, lines := runCreate(t, "thin-85", thinFacts(85, 10), nil, nil)
	if len(out.Snapshotted) != 0 || strings.Join(out.Live, ",") != "/" || len(lines) != 1 {
		t.Fatalf("%+v %v", out, lines)
	}
	_, _, lines = runCreate(t, "thick-full-vg", thickFacts(4<<20), nil, nil)
	if len(lines) != 1 {
		t.Fatalf("commands for a full VG: %v", lines)
	}
}

func TestCreateMixed(t *testing.T) {
	created, out, _ := runCreate(t, "mixed", btrfsFacts(500*GiB), func(f *cmdrun.FakeRunner) {
		f.Add(LVCreateThick("data", "srv", 10*GiB), "", 0)
		f.Add(LVRemove("data", "srv_restowsnap"), "", 0)
	}, nil)
	if len(created) != 4 || len(out.Snapshotted) != 4 {
		t.Fatalf("%+v %+v", created, out)
	}
}

func TestCreateFailures(t *testing.T) {
	// lvcreate fails with space: that file system is read live, snapshot_failed.
	_, out, _ := runCreate(t, "thick-lvcreate-fails", thickFacts(100*GiB), func(f *cmdrun.FakeRunner) {
		f.Add(LVCreateThick("vg0", "root", 5*GiB), "", 0)
		f.AddRecorded(LVCreateThick("vg0", "home", 32*GiB), cmdrun.Recorded{Exit: 5, Stderr: "  device-mapper: create ioctl on vg0-home_restowsnap failed: Device or resource busy"})
		f.AddRecorded(LVSOne("vg0", "home_restowsnap"), cmdrun.Recorded{Exit: 5, Stderr: "  Failed to find logical volume \"vg0/home_restowsnap\""})
		f.Add(LVRemove("vg0", "root_restowsnap"), "", 0)
	}, nil)
	if len(out.Failed) != 1 || out.Failed[0].Path != "/home" || out.Unavailable != "" || strings.Join(out.Snapshotted, ",") != "/" {
		t.Fatalf("%+v", out)
	}
	// No rights: unavailable, the first snapshot is removed again.
	_, out, _ = runCreate(t, "thick-no-rights", thickFacts(100*GiB), func(f *cmdrun.FakeRunner) {
		f.Add(LVCreateThick("vg0", "root", 5*GiB), "", 0)
		f.AddRecorded(LVCreateThick("vg0", "home", 32*GiB), cmdrun.Recorded{Exit: 5, Stderr: "  /dev/mapper/control: open failed: Permission denied"})
		f.AddRecorded(LVSOne("vg0", "home_restowsnap"), cmdrun.Recorded{Exit: 5, Stderr: "  /dev/mapper/control: open failed: Permission denied"})
		f.Add(LVRemove("vg0", "root_restowsnap"), "", 0)
	}, nil)
	if out.Unavailable == "" || len(out.Snapshotted) != 0 || len(out.Live) != 4 {
		t.Fatalf("%+v", out)
	}
	// btrfs below the free space threshold: failed before any command.
	_, out, lines := runCreate(t, "", btrfsFacts(30*GiB), func(f *cmdrun.FakeRunner) {
		f.Add(LVCreateThick("data", "srv", 10*GiB), "", 0)
		f.Add(LVRemove("data", "srv_restowsnap"), "", 0)
	}, nil)
	if len(out.Failed) != 3 || strings.Join(out.Snapshotted, ",") != "/srv" {
		t.Fatalf("%+v %v", out, lines)
	}
	// The helper cannot run: unavailable.
	_, out, _ = runCreate(t, "", btrfsFacts(500*GiB), func(f *cmdrun.FakeRunner) {
		f.AllowMissing = true
	}, map[string]error{"snapshot -r": ErrNoHelper})
	if out.Unavailable == "" {
		t.Fatalf("%+v", out)
	}
}

// cancelOn cancels the run while a given command runs (a cancellation from
// the server, systemctl stop, a self-update).
type cancelOn struct {
	cmdrun.Runner
	name   string
	cancel context.CancelFunc
}

func (c cancelOn) RunNoKill(ctx context.Context, timeout time.Duration, name string, args ...string) ([]byte, error) {
	if name == c.name {
		c.cancel()
	}
	return cmdrun.RunNoKill(ctx, c.Runner, timeout, name, args...)
}

func TestCreateNeverKillsLVM(t *testing.T) {
	// The run is cancelled while lvcreate runs: lvcreate finishes (the
	// cancellation does not reach it), its snapshot is recorded and
	// removed, and no further snapshot is started.
	fake := cmdrun.NewFake(t)
	fake.Add(LVCreateThick("vg0", "root", 5*GiB), "", 0)
	fake.Add(LVRemove("vg0", "root_restowsnap"), "", 0)
	ctx, cancel := context.WithCancel(context.Background())
	r := cancelOn{Runner: fake, name: "lvcreate", cancel: cancel}
	created, out := Create(ctx, r, &fakeHelper{lines: &[]string{}}, MakePlan(thickFacts(100*GiB), "auto"), "run-1")
	if len(created) != 1 || created[0].LV != "root_restowsnap" || strings.Join(out.Snapshotted, ",") != "/" {
		t.Fatalf("%+v %+v", created, out)
	}
	if fails := Remove(ctx, r, nil, created, "run-1"); len(fails) != 0 {
		t.Fatalf("%+v", fails)
	}
	for _, argv := range [][]string{LVCreateThick("vg0", "root", 5*GiB), LVRemove("vg0", "root_restowsnap")} {
		if !fake.RanNoKill(argv) {
			t.Errorf("%q ran killable", argv)
		}
	}
	if strings.Contains(fake.CallLines(), "home") {
		t.Fatalf("a snapshot was started after the cancellation:\n%s", fake.CallLines())
	}
	// Thin: lvchange runs unkillable too.
	fake = cmdrun.NewFake(t)
	fake.Add(LVCreateThin("vg0", "root"), "", 0)
	fake.Add(LVActivate("vg0", "root_restowsnap"), "", 0)
	if _, out := Create(context.Background(), fake, nil, MakePlan(thinFacts(50, 10), "auto"), "run-1"); len(out.Snapshotted) != 1 ||
		!fake.RanNoKill(LVActivate("vg0", "root_restowsnap")) {
		t.Fatalf("%+v", out)
	}
}

func TestCreateRemovesLeftoverAfterFailedLVCreate(t *testing.T) {
	// lvcreate failed (or hit its limit) after the LV was created: the
	// snapshot is found with tag and suffix and removed right away.
	_, out, lines := runCreate(t, "thick-lvcreate-leftover", thickFacts(100*GiB), func(f *cmdrun.FakeRunner) {
		f.Add(LVCreateThick("vg0", "root", 5*GiB), "", 0)
		f.AddRecorded(LVCreateThick("vg0", "home", 32*GiB), cmdrun.Recorded{Exit: 5, Stderr: "  Failed to activate new LV home_restowsnap."})
		f.Add(LVSOne("vg0", "home_restowsnap"), `{"report":[{"lv":[{"lv_name":"home_restowsnap","vg_name":"vg0","lv_tags":"restow-agent-snapshot"}]}]}`, 0)
		f.Add(LVRemove("vg0", "home_restowsnap"), "", 0)
		f.Add(LVRemove("vg0", "root_restowsnap"), "", 0)
	}, nil)
	if len(out.Failed) != 1 || out.Failed[0].Path != "/home" || len(out.CleanupFailed) != 0 {
		t.Fatalf("%+v", out)
	}
	if !strings.Contains(strings.Join(lines, "\n"), "lvremove -y vg0/home_restowsnap\n-- remove") {
		t.Fatalf("the leftover was not removed right away: %v", lines)
	}
	// An LV of that name without the tag is not the agent's: left alone.
	_, out, lines = runCreate(t, "", thickFacts(100*GiB), func(f *cmdrun.FakeRunner) {
		f.Add(LVCreateThick("vg0", "root", 5*GiB), "", 0)
		f.AddRecorded(LVCreateThick("vg0", "home", 32*GiB), cmdrun.Recorded{Exit: 5, Stderr: "  Logical Volume \"home_restowsnap\" already exists in volume group \"vg0\""})
		f.Add(LVSOne("vg0", "home_restowsnap"), `{"report":[{"lv":[{"lv_name":"home_restowsnap","vg_name":"vg0","lv_tags":""}]}]}`, 0)
		f.Add(LVRemove("vg0", "root_restowsnap"), "", 0)
	}, nil)
	if strings.Contains(strings.Join(lines, "\n"), "lvremove -y vg0/home_restowsnap") || len(out.Failed) != 1 {
		t.Fatalf("%+v %v", out, lines)
	}
}

func TestTreeMounts(t *testing.T) {
	o := TreeOptions{ResticBin: "/opt/restow-agent/bin/restic", CacheDir: "/var/lib/restow-agent/cache", TmpDir: "/var/lib/restow-agent/tmp", RunID: "run-1"}
	cases := map[string]Facts{"thick-free": thickFacts(100 * GiB), "thick-full-vg": thickFacts(4 << 20), "mixed": btrfsFacts(500 * GiB)}
	for name, f := range cases {
		var lines []string
		plan := MakePlan(f, "auto")
		fake := cmdrun.NewFake(t)
		fake.AllowMissing = true
		for _, s := range plan.Sources {
			if s.Method == MethodLVM {
				fake.Add(LVCreateThick(s.VG, s.LV, s.CowBytes), "", 0)
			}
		}
		created, _ := Create(context.Background(), fake, &fakeHelper{lines: &lines}, plan, "run-1")
		mounts := TreeMounts(plan, f, created, o)
		b, _ := json.MarshalIndent(mounts, "", "  ")
		checkGolden(t, name+".mounts.json", append(b, '\n'))
		if mounts[0].FSType != "tmpfs" || mounts[1].Target != SnapTreeDir {
			t.Fatalf("%s: the root file system must come right after the tmpfs: %+v", name, mounts[:2])
		}
		last := -1
		for _, m := range mounts[1:] {
			d := depth(strings.TrimPrefix(m.Target, SnapTreeDir))
			if m.Target == SnapTreeDir {
				d = -1
			}
			if d < last {
				t.Fatalf("%s: not ordered by depth: %+v", name, mounts)
			}
			last = d
		}
	}
	// The root file system is in the tree even when no source is on it.
	f := thickFacts(100 * GiB)
	f.Sources = f.Sources[1:2]
	ms := TreeMounts(MakePlan(f, "off"), f, nil, o)
	if !ms[1].Bind || ms[1].Source != "/" || ms[1].Options != "ro" {
		t.Fatalf("%+v", ms[1])
	}
	// noauto entries are mounted read-only by the helper.
	f.Sources = append(f.Sources, Source{Path: "/boot/efi", MountTarget: "/boot/efi", FSType: "vfat", Device: "/dev/disk/by-uuid/1A2B-3C4D", Noauto: true},
		Source{Path: "/data", MountTarget: "/data", FSType: "xfs", Device: "/dev/sdb1", Noauto: true})
	found := 0
	for _, m := range TreeMounts(MakePlan(f, "auto"), f, nil, o) {
		switch m.Target {
		case SnapTreeDir + "/boot/efi":
			found++
			if m.Options != "ro" || m.FSType != "vfat" || m.Bind {
				t.Fatalf("%+v", m)
			}
		case SnapTreeDir + "/data":
			found++
			if m.Options != "ro,norecovery" {
				t.Fatalf("%+v", m)
			}
		}
	}
	if found != 2 {
		t.Fatal("noauto mounts missing")
	}
	if snapOptions("ext4") != "ro,noload" || snapOptions("xfs") != "ro,nouuid,norecovery" || noautoOptions("ext4") != "ro,noload" {
		t.Fatal("options")
	}
	spec := LiveSpec(f, o)
	b, _ := spec.Encode()
	back, err := DecodeSpec(b)
	if err != nil || back.Kind != SpecTree || len(back.Mounts) != len(spec.Mounts) {
		t.Fatalf("%v", err)
	}
}

func TestJudge(t *testing.T) {
	created := []Created{
		{Method: MethodLVM, VG: "vg0", LV: "root_restowsnap", Origin: "root", Sources: []string{"/"}},
		{Method: MethodLVM, VG: "vg0", LV: "home_restowsnap", Origin: "home", Thin: true, Pool: "pool", Sources: []string{"/home"}},
	}
	row := func(lv, attr, data, meta, snap string) string {
		return fmt.Sprintf(`{"lv_name":"%s","vg_name":"vg0","lv_attr":"%s","data_percent":"%s","metadata_percent":"%s","snap_percent":"%s","lv_tags":""}`, lv, attr, data, meta, snap)
	}
	report := func(rows ...string) []byte {
		return []byte(`{"report":[{"lv":[` + strings.Join(rows, ",") + `]}]}`)
	}
	ok := report(row("root_restowsnap", "swi-a-s---", "", "", "40.00"), row("pool", "twi-aotz--", "70.00", "20.00", ""))
	if p := judge(ok, created); p != nil {
		t.Fatalf("%+v", p)
	}
	if p := judge(report(row("root_restowsnap", "swi-a-s---", "", "", "96.00"), row("pool", "twi-aotz--", "70.00", "20.00", "")), created); p == nil || !errors.Is(p.Err, ErrSnapshotOverflow) || p.Path != "/" {
		t.Fatalf("%+v", p)
	}
	if p := judge(report(row("root_restowsnap", "swi-I-s---", "", "", "100.00"), row("pool", "twi-aotz--", "70.00", "20.00", "")), created); p == nil || !errors.Is(p.Err, ErrSnapshotOverflow) {
		t.Fatalf("invalid snapshot: %+v", p)
	}
	if p := judge(report(row("root_restowsnap", "swi-a-s---", "", "", "10.00"), row("pool", "twi-aotz--", "91.00", "20.00", "")), created); p == nil || !errors.Is(p.Err, ErrThinPoolPressure) || p.Path != "/home" {
		t.Fatalf("%+v", p)
	}
	if p := judge(report(row("root_restowsnap", "swi-a-s---", "", "", "10.00"), row("pool", "twi-aotz--", "50.00", "92.00", "")), created); p == nil || !errors.Is(p.Err, ErrThinPoolPressure) {
		t.Fatalf("metadata: %+v", p)
	}
}

func TestWatchCancels(t *testing.T) {
	created := []Created{{Method: MethodLVM, VG: "vg0", LV: "root_restowsnap", Origin: "root", Sources: []string{"/"}}}
	f := cmdrun.NewFake(t)
	f.Add(LVSMonitor(), `{"report":[{"lv":[{"lv_name":"root_restowsnap","vg_name":"vg0","lv_attr":"swi-a-s---","snap_percent":"99.00"}]}]}`, 0)
	ctx, cancel := context.WithCancelCause(context.Background())
	p := Watch(ctx, f, created, 1, cancel)
	if p == nil || !errors.Is(context.Cause(ctx), ErrSnapshotOverflow) {
		t.Fatalf("%+v %v", p, context.Cause(ctx))
	}
}

func TestCleanupOwnership(t *testing.T) {
	for _, c := range []struct {
		lv   string
		tags []string
		want bool
	}{
		{"root_restowsnap", []string{SnapshotTag}, true},
		{"root_restowsnap", nil, false},
		{"root", []string{SnapshotTag}, false},
		{"_restowsnap", []string{SnapshotTag}, false},
		{"root_restowsnap", []string{"other"}, false},
		{"snap_restowsnap_x", []string{SnapshotTag}, false},
	} {
		if Owned(c.lv, c.tags) != c.want {
			t.Errorf("%+v", c)
		}
	}
	for p, want := range map[string]string{".restow-snapshots/run-1/257": "run-1", ".restow-snapshots/run-1": "", "root/.restow-snapshots/run-1/257": "",
		".restow-snapshots/../x/257": "", ".snapshots/1/snapshot": "", ".restow-snapshots/run-1/257/nested": "", ".restow-snapshots/run-1/x": ""} {
		run, ok := OwnedSubvol(p)
		if (want != "") != ok || run != want {
			t.Errorf("%s: %q %v", p, run, ok)
		}
	}
}

func TestCleanupStale(t *testing.T) {
	dir := t.TempDir()
	write := func(p, s string) {
		full := filepath.Join(dir, "root", p)
		_ = os.MkdirAll(filepath.Dir(full), 0o755)
		if err := os.WriteFile(full, []byte(s), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("proc/self/mountinfo", "30 1 0:40 /root / rw,relatime - btrfs /dev/sda2 rw,subvolid=257,subvol=/root\n31 30 0:40 /home /home rw,relatime - btrfs /dev/sda2 rw,subvolid=256,subvol=/home\n")
	write("sys/fs/btrfs/f1/devices/sda2", "")
	var lines []string
	fake := cmdrun.NewFake(t)
	fake.Add(LVSOwned(), `{"report":[{"lv":[
		{"lv_name":"root_restowsnap","vg_name":"vg0","lv_tags":"restow-agent-snapshot","lv_time":"2026-11-03 21:00:03 +0100"},
		{"lv_name":"root","vg_name":"vg0","lv_tags":"restow-agent-snapshot","lv_time":"2026-01-01 00:00:00 +0100"},
		{"lv_name":"backup_restowsnap","vg_name":"vg0","lv_tags":"","lv_time":"2026-01-01 00:00:00 +0100"},
		{"lv_name":"home","vg_name":"vg0","lv_tags":"","lv_time":"2026-01-01 00:00:00 +0100"}]}]}`, 0)
	fake.Add(LVRemove("vg0", "root_restowsnap"), "", 0)
	fake.Add(BtrfsList("/"), "ID 256 gen 1 top level 5 path home\nID 257 gen 1 top level 5 path root\n"+
		"ID 300 gen 1 top level 5 path .restow-snapshots/old-run/257\nID 301 gen 1 top level 5 path .restow-snapshots/run-now/257\n"+
		"ID 302 gen 1 top level 5 path root/.restow-snapshots/x/1\nID 303 gen 1 top level 5 path .snapshots/1/snapshot\n", 0)
	h := &fakeHelper{lines: &lines}
	rep := CleanupStale(context.Background(), loggingRunner{next: fake, lines: &lines}, h, baremetal.DirHost{Root: filepath.Join(dir, "root")}, "run-now")
	checkGolden(t, "cleanup-stale.cmds", []byte(strings.Join(lines, "\n")+"\n"))
	if rep.Removed != 2 || rep.Since != "2026-11-03" || !strings.Contains(rep.String(), "2 leftover snapshots from 2026-11-03 removed") {
		t.Fatalf("%+v %q", rep, rep.String())
	}
	for _, l := range lines {
		if strings.Contains(l, "delete") && !strings.Contains(l, "/run/restow-agent/btrfs/f1/.restow-snapshots/old-run/257") {
			t.Fatalf("deleted something not owned: %s", l)
		}
		if strings.Contains(l, "lvremove") && !strings.Contains(l, "vg0/root_restowsnap") {
			t.Fatalf("removed an LV not owned: %s", l)
		}
	}
}

func TestHelperArgv(t *testing.T) {
	got := strings.Join(HelperArgv("/opt/restow-agent/bin/restow-agent", "/tmp/s.json", []string{"/opt/restow-agent/bin/restic", "backup"}), " ")
	if got != "/opt/restow-agent/bin/restow-agent snapshot-exec --spec /tmp/s.json -- /opt/restow-agent/bin/restic backup" {
		t.Fatal(got)
	}
	if got := HelperArgv("a", "s", nil); strings.Join(got, " ") != "a snapshot-exec --spec s --measure" {
		t.Fatal(got)
	}
	if got := HelperArgv("a", "s", []string{}); strings.Join(got, " ") != "a snapshot-exec --spec s --" {
		t.Fatal(got)
	}
}

func TestHandleMeasure(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "a.txt")
	if err := os.WriteFile(p, []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	resp := HandleMeasure(MeasureRequest{Sample: []SampleFile{{Path: p, Size: 5}, {Path: p, Size: 6}, {Path: dir, Size: 0}}, Activity: []string{p}})
	if len(resp.Sample) != 1 || resp.Sample[0].SHA256 != "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824" || len(resp.Activity) != 1 {
		t.Fatalf("%+v", resp)
	}
}
