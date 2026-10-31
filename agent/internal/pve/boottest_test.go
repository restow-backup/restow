//go:build !windows

package pve

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/restow-backup/restow/agent/internal/lock"
)

// A simulated node for boot tests: qm and pct (fakeNode.Run) and the parts of the PVE API a boot
// test uses work on the same small world of guests. Nothing here talks to a real PVE.

type fakeGuest struct {
	kind   string
	node   string
	pool   string
	conf   map[string]string
	status string
	pings  int
}

type fakeNode struct {
	mu       sync.Mutex
	name     string
	guests   map[int]*fakeGuest
	commands []string
	nextID   int

	// Behaviour of the next boot.
	restoreExit    string
	restoreConfig  map[string]string
	agentAfter     int  // the guest agent answers from this ping on (0: never)
	stopAfterPings int  // the guest stops after this many pings (0: never)
	startFails     bool // `qm start` fails
	ignoreLinkDown bool // `qm set` does not apply link_down (a broken isolation)
	initComm       string
	destroyFails   bool
	vzdumpRunning  bool
	storages       []Storage
}

func newFakeNode() *fakeNode {
	return &fakeNode{
		name: "pve1", guests: map[int]*fakeGuest{}, nextID: 9001, restoreExit: "OK",
		storages: []Storage{{Storage: "local-lvm", Type: "lvmthin", Content: "images,rootdir", Active: 1, Avail: 500 << 30}},
	}
}

func (f *fakeNode) Run(_ context.Context, name string, args ...string) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.commands = append(f.commands, name+" "+strings.Join(args, " "))
	if name != "qm" && name != "pct" || len(args) < 2 {
		return "", fmt.Errorf("unknown command %s", name)
	}
	verb := args[0]
	if verb == "guest" {
		// qm guest cmd <id> ping
		id, _ := strconv.Atoi(args[2])
		g := f.guests[id]
		if g == nil || g.status != "running" {
			return "", errors.New("VM is not running")
		}
		g.pings++
		if f.stopAfterPings > 0 && g.pings >= f.stopAfterPings {
			g.status = "stopped"
		}
		if f.agentAfter > 0 && g.pings >= f.agentAfter {
			return "", nil
		}
		return "", errors.New("QEMU guest agent is not running")
	}
	id, err := strconv.Atoi(args[1])
	if err != nil {
		return "", err
	}
	g := f.guests[id]
	if g == nil {
		return "", fmt.Errorf("Configuration file 'nodes/pve1/qemu-server/%d.conf' does not exist", id)
	}
	switch verb {
	case "config":
		var keys []string
		for k := range g.conf {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		var b strings.Builder
		for _, k := range keys {
			fmt.Fprintf(&b, "%s: %s\n", k, g.conf[k])
		}
		return b.String(), nil
	case "set":
		for i := 2; i < len(args); i += 2 {
			key := strings.TrimPrefix(args[i], "--")
			if key == "delete" {
				for _, k := range strings.Split(args[i+1], ",") {
					delete(g.conf, k)
				}
				continue
			}
			v := args[i+1]
			if f.ignoreLinkDown {
				v = strings.ReplaceAll(v, ",link_down=1", "")
			}
			g.conf[key] = v
		}
		return "", nil
	case "start":
		if f.startFails {
			return "", errors.New("start failed: QEMU exited with code 1")
		}
		g.status = "running"
		return "", nil
	case "status":
		return "status: " + g.status, nil
	case "exec":
		if g.status != "running" || f.initComm == "" {
			return "", errors.New("exec failed")
		}
		return f.initComm + "\n", nil
	case "stop":
		g.status = "stopped"
		return "", nil
	case "destroy":
		if f.destroyFails {
			return "", errors.New("destroy failed")
		}
		delete(f.guests, id)
		return "", nil
	}
	return "", fmt.Errorf("unknown verb %s", verb)
}

// --- the PVE API part ---

func (f *fakeNode) NextID(context.Context) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	id := f.nextID
	f.nextID++
	return id, nil
}

func (f *fakeNode) RestoreGuest(_ context.Context, node, kind string, vmid int, archive, storage, pool string, start bool) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if start {
		return "", errors.New("a boot test must not start the guest with the restore")
	}
	if _, taken := f.guests[vmid]; taken {
		return "", errors.New("VMID taken")
	}
	conf := map[string]string{}
	for k, v := range f.restoreConfig {
		conf[k] = v
	}
	f.guests[vmid] = &fakeGuest{kind: kind, node: node, pool: pool, conf: conf, status: "stopped"}
	f.commands = append(f.commands, fmt.Sprintf("restore %s %d %s %s %s", kind, vmid, archive, storage, pool))
	return fmt.Sprintf("UPID:%s:0000AAAA:00BBBBBB:6700000:qmrestore:%d:restow@pve!pve1:", node, vmid), nil
}

func (f *fakeNode) WaitTask(context.Context, string, string, time.Duration) (string, error) {
	return f.restoreExit, nil
}

func (f *fakeNode) TaskLogTail(context.Context, string, string, int) (string, error) {
	return "error: chunk missing\n", nil
}

func (f *fakeNode) Storages(context.Context, string) ([]Storage, error) { return f.storages, nil }

func (f *fakeNode) Guests(context.Context) ([]Resource, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []Resource
	for id, g := range f.guests {
		typ := "qemu"
		name := g.conf["name"]
		if g.kind == "ct" {
			typ, name = "lxc", g.conf["hostname"]
		}
		out = append(out, Resource{VMID: id, Type: typ, Name: name, Node: g.node, Pool: g.pool, Tags: g.conf["tags"], Status: g.status})
	}
	return out, nil
}

func (f *fakeNode) ActiveTasks(context.Context, string, string) ([]NodeTask, error) {
	if f.vzdumpRunning {
		return []NodeTask{{Type: "vzdump", Status: "running"}}, nil
	}
	return nil, nil
}

func (f *fakeNode) commandsFor(vmid int) []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []string
	for _, c := range f.commands {
		fields := strings.Fields(c)
		if len(fields) >= 3 && (fields[2] == strconv.Itoa(vmid) || (len(fields) >= 4 && fields[3] == strconv.Itoa(vmid))) {
			out = append(out, c)
		}
	}
	return out
}

// A clock that moves on 30 seconds per look: the waits run through at once.
type steppingClock struct {
	mu  sync.Mutex
	now time.Time
}

func (c *steppingClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(30 * time.Second)
	return c.now
}

const vmConfig = `boot: order=scsi0
cores: 2
memory: 4096
name: web01
net0: virtio=BC:24:11:00:00:01,bridge=vmbr0,firewall=1
net1: e1000=BC:24:11:00:00:02,bridge=vmbr1,tag=20,link_down=0
hostpci0: 0000:01:00.0
usb0: host=1-2
serial0: /dev/ttyS0
serial1: socket
ide2: local:iso/debian.iso,media=cdrom
hookscript: local:snippets/notify.pl
onboot: 1
protection: 1
scsi0: local-lvm:vm-101-disk-0,size=32G

[before-update]
memory: 99999
`

func newTester(t *testing.T, f *fakeNode) *BootTester {
	t.Helper()
	root := t.TempDir()
	layout := Layout{DataDir: filepath.Join(root, "data"), RunDir: filepath.Join(root, "run")}
	st := &State{NodeName: "pve1", StorageID: "restow", FleecingStorage: "local-lvm"}
	return &BootTester{
		Layout: layout, State: st, PVE: f, Cmd: f,
		Resolve: func(_ context.Context, volname string) (*RestorePoint, error) {
			return &RestorePoint{SnapshotID: "s1", Kind: "vm", VMID: 101, GuestConfig: f.restoreConfigText()}, nil
		},
		MemAvailable:  func() (uint64, error) { return 64 << 30, nil },
		BackupRunning: func() bool { return false },
		Poll:          time.Millisecond, TaskPoll: time.Millisecond,
		Now: (&steppingClock{now: time.Unix(1_900_000_000, 0)}).Now,
	}
}

func (f *fakeNode) restoreConfigText() string {
	var keys []string
	for k := range f.restoreConfig {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var b strings.Builder
	for _, k := range keys {
		fmt.Fprintf(&b, "%s: %s\n", k, f.restoreConfig[k])
	}
	return b.String()
}

func vmParams() BootTestParams {
	return BootTestParams{Volname: "backup/vm/101/2030-01-01T00:00:00Z", Kind: "vm", VMID: 101,
		MaxMemoryMiB: 8192, TimeoutSeconds: 300, DataBytes: 10 << 30, DiskBytes: 32 << 30}
}

func TestBootTestGreenWhenTheGuestAgentAnswers(t *testing.T) {
	f := newFakeNode()
	f.restoreConfig = parseConfigText(vmConfig)
	f.agentAfter = 3
	b := newTester(t, f)
	res, err := b.Run(context.Background(), vmParams())
	if err != nil {
		t.Fatal(err)
	}
	if res.Outcome != "green" || res.Reason != "agent_answered" || !res.GuestAgent || res.BootSeconds == nil {
		t.Fatalf("result %+v", res)
	}
	if res.TempVMID != 9001 || res.Storage != "local-lvm" || !res.CleanedUp {
		t.Fatalf("result %+v", res)
	}
	if len(f.guests) != 0 {
		t.Fatalf("the temporary guest is left: %+v", f.guests)
	}
	if _, err := os.Stat(b.markerFile()); !os.IsNotExist(err) {
		t.Fatalf("marker left: %v", err)
	}
	// The original VMID is never touched; the restore went into the restore pool without a start.
	if cmds := f.commandsFor(101); len(cmds) != 0 {
		t.Fatalf("commands on the original guest: %v", cmds)
	}
	all := strings.Join(f.commands, "\n")
	if !strings.Contains(all, "restore vm 9001 restow:backup/vm/101/2030-01-01T00:00:00Z local-lvm restow-restore") {
		t.Fatalf("restore: %s", all)
	}
	if !strings.Contains(res.Log, "QEMU guest agent answered") {
		t.Fatalf("log: %s", res.Log)
	}
}

func TestBootTestIsolatesTheVMBeforeItStarts(t *testing.T) {
	f := newFakeNode()
	f.restoreConfig = parseConfigText(vmConfig)
	f.agentAfter = 1
	b := newTester(t, f)
	var seen map[string]string
	// Look at the configuration the moment the guest starts.
	b.Cmd = runnerFunc(func(ctx context.Context, name string, args ...string) (string, error) {
		if args[0] == "start" {
			id, _ := strconv.Atoi(args[1])
			seen = map[string]string{}
			for k, v := range f.guests[id].conf {
				seen[k] = v
			}
		}
		return f.Run(ctx, name, args...)
	})
	if res, err := b.Run(context.Background(), vmParams()); err != nil || res.Outcome != "green" {
		t.Fatalf("%+v %v", res, err)
	}
	want := map[string]string{
		"net0":       "virtio=BC:24:11:00:00:01,bridge=vmbr0,firewall=1,link_down=1",
		"net1":       "e1000=BC:24:11:00:00:02,bridge=vmbr1,tag=20,link_down=1",
		"ide2":       "none,media=cdrom",
		"serial1":    "socket",
		"onboot":     "0",
		"protection": "0",
		"tags":       BootTestTag,
		"name":       "restow-boottest-101",
		"agent":      "enabled=1",
	}
	for k, v := range want {
		if seen[k] != v {
			t.Errorf("%s = %q, want %q", k, seen[k], v)
		}
	}
	for _, k := range []string{"hostpci0", "usb0", "serial0", "hookscript"} {
		if _, ok := seen[k]; ok {
			t.Errorf("%s still configured: %q", k, seen[k])
		}
	}
}

type runnerFunc func(ctx context.Context, name string, args ...string) (string, error)

func (r runnerFunc) Run(ctx context.Context, name string, args ...string) (string, error) {
	return r(ctx, name, args...)
}

func TestBootTestUsesTheIsolatedBridgeWhenTheNodeNamesOne(t *testing.T) {
	if got := isolatedNIC("virtio=AA,bridge=vmbr0,tag=20,firewall=1", "vmbr99"); got != "virtio=AA,bridge=vmbr99,firewall=1" {
		t.Fatalf("got %q", got)
	}
	if got := isolatedNIC("virtio=AA", "vmbr99"); got != "virtio=AA,bridge=vmbr99" {
		t.Fatalf("got %q", got)
	}
	f := newFakeNode()
	f.restoreConfig = parseConfigText(vmConfig)
	f.agentAfter = 1
	b := newTester(t, f)
	b.State.BootTestBridge = "vmbr99"
	res, err := b.Run(context.Background(), vmParams())
	if err != nil || res.Outcome != "green" {
		t.Fatalf("%+v %v", res, err)
	}
	if !strings.Contains(strings.Join(f.commands, "\n"), "--net1 e1000=BC:24:11:00:00:02,bridge=vmbr99,link_down=0") {
		t.Fatalf("commands: %v", f.commands)
	}
}

func TestBootTestYellowWithoutAGuestAgent(t *testing.T) {
	f := newFakeNode()
	f.restoreConfig = parseConfigText(vmConfig)
	b := newTester(t, f)
	res, err := b.Run(context.Background(), vmParams())
	if err != nil {
		t.Fatal(err)
	}
	if res.Outcome != "yellow" || res.Reason != "no_guest_agent" || res.GuestAgent || !res.CleanedUp {
		t.Fatalf("result %+v", res)
	}
	if len(f.guests) != 0 {
		t.Fatal("the temporary guest is left")
	}
}

func TestBootTestRedWhenTheGuestStops(t *testing.T) {
	f := newFakeNode()
	f.restoreConfig = parseConfigText(vmConfig)
	f.stopAfterPings = 2
	b := newTester(t, f)
	res, err := b.Run(context.Background(), vmParams())
	if err != nil {
		t.Fatal(err)
	}
	if res.Outcome != "red" || res.Reason != "guest_stopped" || !res.CleanedUp {
		t.Fatalf("result %+v", res)
	}
}

func TestBootTestRedWhenTheRestoreOrTheStartFails(t *testing.T) {
	f := newFakeNode()
	f.restoreConfig = parseConfigText(vmConfig)
	f.restoreExit = "command 'qemu-img convert' failed: exit code 1"
	b := newTester(t, f)
	res, err := b.Run(context.Background(), vmParams())
	if err != nil || res.Outcome != "red" || res.Reason != "restore_failed" || !res.CleanedUp || len(f.guests) != 0 {
		t.Fatalf("restore: %+v %v (guests %d)", res, err, len(f.guests))
	}
	f = newFakeNode()
	f.restoreConfig = parseConfigText(vmConfig)
	f.startFails = true
	b = newTester(t, f)
	res, err = b.Run(context.Background(), vmParams())
	if err != nil || res.Outcome != "red" || res.Reason != "start_failed" || !res.CleanedUp || len(f.guests) != 0 {
		t.Fatalf("start: %+v %v", res, err)
	}
}

func TestBootTestNeverStartsAGuestItCouldNotIsolate(t *testing.T) {
	f := newFakeNode()
	f.restoreConfig = parseConfigText(vmConfig)
	f.ignoreLinkDown = true
	b := newTester(t, f)
	res, err := b.Run(context.Background(), vmParams())
	if err == nil || res.Outcome != "" || !strings.Contains(err.Error(), "still connected") {
		t.Fatalf("%+v %v", res, err)
	}
	for _, c := range f.commands {
		if strings.HasPrefix(c, "qm start") {
			t.Fatalf("started: %v", f.commands)
		}
	}
	if !res.CleanedUp || len(f.guests) != 0 {
		t.Fatalf("not cleaned up: %+v", res)
	}
}

func TestBootTestSkipsWhatTheNodeCannotCarry(t *testing.T) {
	cases := []struct {
		name   string
		prep   func(f *fakeNode, b *BootTester, p *BootTestParams)
		reason string
	}{
		{"memory over the job's limit", func(_ *fakeNode, _ *BootTester, p *BootTestParams) { p.MaxMemoryMiB = 2048 }, "memory_limit"},
		{"node memory", func(_ *fakeNode, b *BootTester, _ *BootTestParams) {
			b.MemAvailable = func() (uint64, error) { return 4 << 30, nil }
		}, "node_memory"},
		{"storage space", func(f *fakeNode, _ *BootTester, _ *BootTestParams) { f.storages[0].Avail = 5 << 30 }, "storage_space"},
		{"storage missing", func(_ *fakeNode, b *BootTester, _ *BootTestParams) { b.State.BootTestStorage = "fast-nvme" }, "no_storage"},
		{"storage without images", func(f *fakeNode, _ *BootTester, _ *BootTestParams) { f.storages[0].Content = "backup,iso" }, "storage_content"},
		{"a Restow backup runs", func(_ *fakeNode, b *BootTester, _ *BootTestParams) { b.BackupRunning = func() bool { return true } }, "backup_running"},
		{"a PVE backup runs", func(f *fakeNode, _ *BootTester, _ *BootTestParams) { f.vzdumpRunning = true }, "backup_running"},
		{"restores off", func(_ *fakeNode, b *BootTester, _ *BootTestParams) {
			off := false
			b.State.AllowRestores = &off
		}, "restores_off"},
		{"boot tests off", func(_ *fakeNode, b *BootTester, _ *BootTestParams) { b.State.BootTestsDisabled = true }, "boot_tests_off"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := newFakeNode()
			f.restoreConfig = parseConfigText(vmConfig)
			f.agentAfter = 1
			b := newTester(t, f)
			p := vmParams()
			c.prep(f, b, &p)
			res, err := b.Run(context.Background(), p)
			if err != nil || res.Outcome != "skipped" || res.Reason != c.reason || res.Message == "" {
				t.Fatalf("%+v %v", res, err)
			}
			for _, cmd := range f.commands {
				if strings.HasPrefix(cmd, "restore") {
					t.Fatalf("restored although skipped: %v", f.commands)
				}
			}
		})
	}
}

func TestOneBootTestPerNodeAtATime(t *testing.T) {
	f := newFakeNode()
	f.restoreConfig = parseConfigText(vmConfig)
	f.agentAfter = 1
	b := newTester(t, f)
	held, err := lock.TryAcquire(b.lockFile())
	if err != nil {
		t.Fatal(err)
	}
	res, err := b.Run(context.Background(), vmParams())
	if err != nil || res.Outcome != "skipped" || res.Reason != "boot_test_running" {
		t.Fatalf("%+v %v", res, err)
	}
	_ = held.Release()
	res, err = b.Run(context.Background(), vmParams())
	if err != nil || res.Outcome != "green" {
		t.Fatalf("after the other test: %+v %v", res, err)
	}
}

func TestBootTestOfAContainer(t *testing.T) {
	f := newFakeNode()
	f.restoreConfig = map[string]string{
		"hostname": "db01", "memory": "1024", "rootfs": "local-lvm:vm-200-disk-0,size=8G",
		"mp0": "local-lvm:vm-200-disk-1,mp=/srv,backup=1,size=4G", "mp1": "/mnt/host,mp=/host",
		"net0": "name=eth0,bridge=vmbr0,ip=dhcp", "dev0": "/dev/ttyUSB0", "unprivileged": "1",
	}
	f.initComm = "systemd"
	b := newTester(t, f)
	var seen map[string]string
	b.Cmd = runnerFunc(func(ctx context.Context, name string, args ...string) (string, error) {
		if name == "qm" {
			t.Errorf("qm for a container: %v", args)
		}
		if args[0] == "start" {
			id, _ := strconv.Atoi(args[1])
			seen = map[string]string{}
			for k, v := range f.guests[id].conf {
				seen[k] = v
			}
		}
		return f.Run(ctx, name, args...)
	})
	p := BootTestParams{Volname: "backup/ct/200/2030-01-01T00:00:00Z", Kind: "ct", VMID: 200, DataBytes: 2 << 30}
	res, err := b.Run(context.Background(), p)
	if err != nil || res.Outcome != "green" || res.Reason != "init_running" || !res.CleanedUp {
		t.Fatalf("%+v %v", res, err)
	}
	for _, k := range []string{"net0", "dev0", "mp1"} {
		if _, ok := seen[k]; ok {
			t.Errorf("%s still configured", k)
		}
	}
	if seen["mp0"] == "" || seen["hostname"] != "restow-boottest-200" || seen["tags"] != BootTestTag {
		t.Errorf("config at start: %v", seen)
	}
}

func TestCleanupRemovesOnlyTheBootTestsLeftovers(t *testing.T) {
	f := newFakeNode()
	tagged := func(name string) map[string]string {
		return map[string]string{"name": name, "tags": "restow-boottest"}
	}
	f.guests[9100] = &fakeGuest{kind: "vm", node: "pve1", pool: "restow-restore", conf: tagged("restow-boottest-101"), status: "running"}
	f.guests[9101] = &fakeGuest{kind: "vm", node: "pve2", pool: "restow-restore", conf: tagged("restow-boottest-102"), status: "running"}
	f.guests[9102] = &fakeGuest{kind: "vm", node: "pve1", pool: "restow-restore", conf: map[string]string{"name": "restow-boottest-103"}}
	f.guests[9103] = &fakeGuest{kind: "vm", node: "pve1", pool: "", conf: tagged("restow-boottest-104")}
	f.guests[9104] = &fakeGuest{kind: "vm", node: "pve1", pool: "restow-restore", conf: map[string]string{"name": "web01"}}
	f.guests[9105] = &fakeGuest{kind: "vm", node: "pve1", pool: "restow-restore", conf: map[string]string{"name": "web02"}}
	f.guests[101] = &fakeGuest{kind: "vm", node: "pve1", conf: map[string]string{"name": "web01", "tags": "prod"}}
	b := newTester(t, f)
	// The marker of a test that was restoring 9104 when the node went down.
	if err := writeJSONAtomic(b.markerFile(), bootTestMarker{VMID: 9104, Kind: "vm", UPID: "UPID:pve1:1:2:3:qmrestore:9104:restow@pve!pve1:"}, 0o600); err != nil {
		t.Fatal(err)
	}
	b.Cleanup(context.Background())
	for _, gone := range []int{9100, 9104} {
		if _, ok := f.guests[gone]; ok {
			t.Errorf("%d not removed", gone)
		}
	}
	for _, kept := range []int{9101, 9102, 9103, 9105, 101} {
		if _, ok := f.guests[kept]; !ok {
			t.Errorf("%d removed", kept)
		}
	}
	if _, err := os.Stat(b.markerFile()); !os.IsNotExist(err) {
		t.Fatal("marker kept")
	}
	// A marker without the restore task: the guest is not taken for one of ours.
	if err := writeJSONAtomic(b.markerFile(), bootTestMarker{VMID: 9105, Kind: "vm"}, 0o600); err != nil {
		t.Fatal(err)
	}
	b.Cleanup(context.Background())
	if _, ok := f.guests[9105]; !ok {
		t.Error("9105 removed without proof it was a boot test's")
	}
}

func TestBootTestKeepsTheMarkerWhenTheGuestCannotBeDestroyed(t *testing.T) {
	f := newFakeNode()
	f.restoreConfig = parseConfigText(vmConfig)
	f.agentAfter = 1
	f.destroyFails = true
	b := newTester(t, f)
	res, err := b.Run(context.Background(), vmParams())
	if err != nil || res.Outcome != "green" || res.CleanedUp {
		t.Fatalf("%+v %v", res, err)
	}
	var m bootTestMarker
	if err := readJSON(b.markerFile(), &m); err != nil || m.VMID != 9001 || m.UPID == "" {
		t.Fatalf("marker %+v %v", m, err)
	}
	// The next start of the service removes it.
	f.destroyFails = false
	b.Cleanup(context.Background())
	if len(f.guests) != 0 {
		t.Fatal("still there")
	}
}

func TestGuestMemoryAndCapabilities(t *testing.T) {
	if got := guestMemoryMiB(parseConfigText(vmConfig)); got != 4096 {
		t.Fatalf("memory %d (the snapshot section must not count)", got)
	}
	if got := guestMemoryMiB(map[string]string{"memory": "current=2048"}); got != 2048 {
		t.Fatalf("memory %d", got)
	}
	if got := guestMemoryMiB(map[string]string{}); got != 512 {
		t.Fatalf("default %d", got)
	}
	s := &Service{State: &State{}}
	if caps := s.Capabilities(); len(caps) != 1 || caps[0] != BootTestCapability {
		t.Fatalf("caps %v", caps)
	}
	s.State.BootTestsDisabled = true
	if caps := s.Capabilities(); caps == nil || len(caps) != 0 {
		t.Fatalf("caps %v (never null)", caps)
	}
}
