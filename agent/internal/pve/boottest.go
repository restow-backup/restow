//go:build !windows

package pve

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/restow-backup/restow/agent/internal/lock"
)

// A boot test (docs/PVE.md, "Boot test") proves that a restore point boots: the
// node restores it through the normal restore path to a temporary VMID in the
// restore pool, on a storage of its own choice, cuts its network (every NIC
// link_down=1, or an isolated bridge the node names), takes away everything
// that reaches out of the guest (PCI and USB passthrough, host serial and
// parallel ports, virtiofs, hook scripts), starts it and waits for the QEMU
// guest agent to answer. A container is started and its init is looked at.
// The temporary guest is stopped and destroyed in every case; one that a crash
// or a restart of the node left behind is found again by its tag and name (or
// by the marker file) and destroyed when the service starts.
//
// Green needs proof: the guest agent answered (a container: its PID 1 runs).
// A VM that started and kept running without an answer is yellow; a restore,
// a start or a boot that failed is red. A test the node cannot run safely
// (not enough memory or space, a backup running, another boot test) is
// skipped with the reason.

// BootTestCapability is what a node announces in its heartbeat when it runs boot tests.
const BootTestCapability = "boot_test"

// BootTestTag marks the temporary guests of boot tests (and only those).
const BootTestTag = "restow-boottest"

// BootTestNamePrefix starts the name of every temporary guest.
const BootTestNamePrefix = "restow-boottest-"

// BootTestPool is where the temporary guests live (the restore pool).
const BootTestPool = "restow-restore"

// CommandRunner runs a command of the node (qm, pct) and returns its output.
type CommandRunner interface {
	Run(ctx context.Context, name string, args ...string) (string, error)
}

// ExecRunner runs commands with os/exec.
type ExecRunner struct{}

// Run implements CommandRunner.
func (ExecRunner) Run(ctx context.Context, name string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Env = append(os.Environ(), "LC_ALL=C")
	out, err := cmd.CombinedOutput()
	text := strings.TrimSpace(string(out))
	if err != nil {
		if len(text) > 2000 {
			text = text[len(text)-2000:]
		}
		return text, fmt.Errorf("%s %s: %w: %s", name, strings.Join(args, " "), err, text)
	}
	return text, nil
}

// bootTestPVE is what a boot test needs of the local PVE API.
type bootTestPVE interface {
	NextID(ctx context.Context) (int, error)
	RestoreGuest(ctx context.Context, node, kind string, vmid int, archive, storage, pool string, start bool) (string, error)
	WaitTask(ctx context.Context, node, upid string, poll time.Duration) (string, error)
	TaskLogTail(ctx context.Context, node, upid string, lines int) (string, error)
	Storages(ctx context.Context, node string) ([]Storage, error)
	Guests(ctx context.Context) ([]Resource, error)
	ActiveTasks(ctx context.Context, node, typeFilter string) ([]NodeTask, error)
}

// BootTestParams is the task the server sends.
type BootTestParams struct {
	Volname string `json:"volname"`
	Kind    string `json:"kind"`
	// VMID is the guest's own VMID (for names and logs; never touched).
	VMID int `json:"vmid"`
	// MaxMemoryMiB: a guest that needs more is not booted.
	MaxMemoryMiB int `json:"maxMemoryMiB"`
	// TimeoutSeconds is how long to wait for the guest agent after the start.
	TimeoutSeconds int `json:"timeoutSeconds"`
	// DataBytes is what the restore writes (the restore point's stored, non-zero data).
	DataBytes uint64 `json:"dataBytes"`
	// DiskBytes is the size of all disks of the restore point.
	DiskBytes uint64 `json:"diskBytes"`
}

// BootTestResult is what the node reports (the task's result).
type BootTestResult struct {
	Outcome     string   `json:"outcome"` // green | yellow | red | skipped
	Reason      string   `json:"reason"`
	Message     string   `json:"message"`
	DurationMs  int64    `json:"durationMs"`
	BootSeconds *float64 `json:"bootSeconds"`
	GuestAgent  bool     `json:"guestAgent"`
	TempVMID    int      `json:"tempVmid,omitempty"`
	Storage     string   `json:"storage,omitempty"`
	CleanedUp   bool     `json:"cleanedUp"`
	Log         string   `json:"log"`
}

func (r BootTestResult) asMap() map[string]any {
	data, _ := json.Marshal(r)
	var out map[string]any
	_ = json.Unmarshal(data, &out)
	return out
}

// bootTestMarker is written before a temporary guest exists, so a restart finds it again.
type bootTestMarker struct {
	VMID      int    `json:"vmid"`
	Kind      string `json:"kind"`
	UPID      string `json:"upid,omitempty"`
	StartedAt string `json:"startedAt"`
}

// BootTester runs boot tests on this node.
type BootTester struct {
	Layout Layout
	State  *State
	PVE    bootTestPVE
	Cmd    CommandRunner
	// Resolve looks the restore point up on the server (its guest configuration).
	Resolve func(ctx context.Context, volname string) (*RestorePoint, error)
	// MemAvailable is the node's available memory in bytes (default: /proc/meminfo).
	MemAvailable func() (uint64, error)
	// BackupRunning reports a backup on this node (default: the provider's job files).
	BackupRunning func() bool
	Logf          func(string, ...any)
	// Poll is the interval of the status checks (default 5 s); TaskPoll the restore task's.
	Poll     time.Duration
	TaskPoll time.Duration
	Now      func() time.Time

	mu  sync.Mutex
	log []string
}

const (
	bootTestMemoryMarginBytes  = 1 << 30
	bootTestStorageMarginBytes = 1 << 30
	bootTestLogLines           = 200
	defaultBootTestTimeout     = 300 * time.Second
	defaultBootTestMaxMemory   = 8192
)

func (b *BootTester) now() time.Time {
	if b.Now != nil {
		return b.Now()
	}
	return time.Now()
}

func (b *BootTester) logf(format string, args ...any) {
	line := fmt.Sprintf(format, args...)
	b.mu.Lock()
	b.log = append(b.log, b.now().UTC().Format("15:04:05")+" "+line)
	if len(b.log) > bootTestLogLines {
		b.log = b.log[len(b.log)-bootTestLogLines:]
	}
	b.mu.Unlock()
	if b.Logf != nil {
		b.Logf("boot test: %s", line)
	}
}

func (b *BootTester) logText() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return strings.Join(b.log, "\n")
}

func (b *BootTester) markerFile() string {
	return filepath.Join(b.Layout.DataDir, "boottest", "current.json")
}

func (b *BootTester) lockFile() string { return filepath.Join(b.Layout.RunDir, "boottest.lock") }

// Storage is where the temporary guest goes: the node's own choice, else its fleecing storage
// (a thin, local storage on every node with backups).
func (b *BootTester) storage() string {
	if s := strings.TrimSpace(b.State.BootTestStorage); s != "" {
		return s
	}
	return b.State.FleecingStorage
}

// Run carries out one boot test. An error means the node could not run it at all; every
// outcome of a test that ran (also red and skipped) comes back as a result.
func (b *BootTester) Run(ctx context.Context, p BootTestParams) (BootTestResult, error) {
	b.mu.Lock()
	b.log = nil
	b.mu.Unlock()
	start := b.now()
	res := b.run(ctx, p)
	res.DurationMs = b.now().Sub(start).Milliseconds()
	res.Log = b.logText()
	if res.Outcome == "" {
		return res, errors.New(res.Message)
	}
	return res, nil
}

func skipped(reason, message string) BootTestResult {
	return BootTestResult{Outcome: "skipped", Reason: reason, Message: message}
}

func (b *BootTester) run(ctx context.Context, p BootTestParams) BootTestResult {
	if p.Volname == "" || (p.Kind != "vm" && p.Kind != "ct") {
		return BootTestResult{Message: "invalid boot test task"}
	}
	if !b.State.RestoresAllowed() {
		return skipped("restores_off", "Restores are switched off on this node (restow-pve config --allow-restores).")
	}
	if b.State.BootTestsDisabled {
		return skipped("boot_tests_off", "Boot tests are switched off on this node (restow-pve config --boot-tests).")
	}
	held, err := lock.TryAcquire(b.lockFile())
	if errors.Is(err, lock.ErrLocked) {
		return skipped("boot_test_running", "Another boot test runs on this node.")
	}
	if err != nil {
		return BootTestResult{Message: "boot test lock: " + err.Error()}
	}
	defer func() { _ = held.Release() }()
	// Whatever an earlier test left behind goes first.
	b.Cleanup(ctx)
	if reason, msg := b.backupBusy(ctx); reason != "" {
		return skipped(reason, msg)
	}
	rp, err := b.Resolve(ctx, p.Volname)
	if err != nil {
		return BootTestResult{Message: "restore point: " + err.Error()}
	}
	conf := parseConfigText(rp.GuestConfig)
	memMiB := guestMemoryMiB(conf)
	maxMiB := p.MaxMemoryMiB
	if maxMiB <= 0 {
		maxMiB = defaultBootTestMaxMemory
	}
	b.logf("restore point %s of %s %d: %d MiB memory, %d bytes of disks", p.Volname, p.Kind, p.VMID, memMiB, p.DiskBytes)
	if memMiB > maxMiB {
		return skipped("memory_limit", fmt.Sprintf("The guest needs %d MiB of memory; the job allows boot tests up to %d MiB.", memMiB, maxMiB))
	}
	memFn := b.MemAvailable
	if memFn == nil {
		memFn = ProcMemAvailable
	}
	if avail, err := memFn(); err == nil {
		need := uint64(memMiB)<<20 + bootTestMemoryMarginBytes
		if avail < need {
			return skipped("node_memory", fmt.Sprintf("The node has %d MiB of memory available; the guest needs %d MiB and 1 GiB stays free.", avail>>20, memMiB))
		}
	} else {
		b.logf("available memory unknown: %v", err)
	}
	storage := b.storage()
	if storage == "" {
		return skipped("no_storage", "This node has no storage for boot tests (restow-pve config --boot-test-storage).")
	}
	if reason, msg := b.checkStorage(ctx, storage, p); reason != "" {
		return skipped(reason, msg)
	}
	res := b.restoreAndBoot(ctx, p, storage)
	res.Storage = storage
	return res
}

// backupBusy says whether a backup or a restore works on this node now.
func (b *BootTester) backupBusy(ctx context.Context) (string, string) {
	running := b.BackupRunning
	if running == nil {
		running = func() bool { return len(activeRuns(b.Layout)) > 0 || busy(b.Layout) }
	}
	if running() {
		return "backup_running", "A backup or a restore runs on this node."
	}
	tasks, err := b.PVE.ActiveTasks(ctx, b.State.NodeName, "vzdump")
	if err != nil {
		b.logf("running PVE tasks unknown: %v", err)
		return "", ""
	}
	if len(tasks) > 0 {
		return "backup_running", "A PVE backup (vzdump) runs on this node."
	}
	return "", ""
}

func (b *BootTester) checkStorage(ctx context.Context, name string, p BootTestParams) (string, string) {
	list, err := b.PVE.Storages(ctx, b.State.NodeName)
	if err != nil {
		b.logf("storages unknown: %v", err)
		return "", ""
	}
	for _, s := range list {
		if s.Storage != name {
			continue
		}
		if s.Active != 1 {
			return "no_storage", fmt.Sprintf("The boot test storage %s is not active on this node.", name)
		}
		want := "images"
		if p.Kind == "ct" {
			want = "rootdir"
		}
		if s.Content != "" && !strings.Contains(","+s.Content+",", ","+want+",") {
			return "storage_content", fmt.Sprintf("The boot test storage %s does not hold %s.", name, want)
		}
		need := p.DataBytes
		if need == 0 {
			need = p.DiskBytes
		}
		need += need/10 + bootTestStorageMarginBytes
		if s.Avail < need {
			return "storage_space", fmt.Sprintf("The boot test storage %s has %d MiB free; the restore needs about %d MiB.", name, s.Avail>>20, need>>20)
		}
		return "", ""
	}
	return "no_storage", fmt.Sprintf("The boot test storage %s does not exist on this node.", name)
}

func (b *BootTester) cli(kind string) string {
	if kind == "ct" {
		return "pct"
	}
	return "qm"
}

func (b *BootTester) poll() time.Duration {
	if b.Poll > 0 {
		return b.Poll
	}
	return 5 * time.Second
}

func (b *BootTester) restoreAndBoot(ctx context.Context, p BootTestParams, storage string) (res BootTestResult) {
	vmid, err := b.PVE.NextID(ctx)
	if err != nil {
		return BootTestResult{Message: "no free VMID: " + err.Error()}
	}
	marker := bootTestMarker{VMID: vmid, Kind: p.Kind, StartedAt: b.now().UTC().Format(time.RFC3339)}
	if err := writeJSONAtomic(b.markerFile(), marker, 0o600); err != nil {
		return BootTestResult{Message: "boot test marker: " + err.Error()}
	}
	res.TempVMID = vmid
	// The temporary guest goes in every case, also when the test itself is cancelled.
	defer func() {
		cctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Minute)
		defer cancel()
		res.CleanedUp = b.destroy(cctx, p.Kind, vmid)
		if res.CleanedUp {
			_ = os.Remove(b.markerFile())
		}
	}()
	archive := b.State.StorageID + ":backup/" + strings.TrimPrefix(p.Volname, "backup/")
	b.logf("restoring to the temporary %s %d on %s", p.Kind, vmid, storage)
	upid, err := b.PVE.RestoreGuest(ctx, b.State.NodeName, p.Kind, vmid, archive, storage, BootTestPool, false)
	if err != nil {
		res.Outcome, res.Reason, res.Message = "red", "restore_failed", "The restore did not start: "+err.Error()
		return res
	}
	marker.UPID = upid
	_ = writeJSONAtomic(b.markerFile(), marker, 0o600)
	taskPoll := b.TaskPoll
	if taskPoll <= 0 {
		taskPoll = 5 * time.Second
	}
	exit, err := b.PVE.WaitTask(ctx, b.State.NodeName, upid, taskPoll)
	if err != nil {
		res.Outcome, res.Message = "", "waiting for the restore: "+err.Error()
		return res
	}
	if exit != "OK" {
		tail, _ := b.PVE.TaskLogTail(ctx, b.State.NodeName, upid, 20)
		b.logf("restore ended with %q: %s", exit, lastLines(tail, 8))
		res.Outcome, res.Reason, res.Message = "red", "restore_failed", fmt.Sprintf("The restore ended with %q: %s", exit, lastLines(tail, 3))
		return res
	}
	b.logf("restored")
	if err := b.isolate(ctx, p, vmid); err != nil {
		// Never start a guest whose network could not be cut.
		res.Outcome, res.Message = "", "isolating the temporary guest: "+err.Error()
		return res
	}
	cli := b.cli(p.Kind)
	if _, err := b.Cmd.Run(ctx, cli, "start", strconv.Itoa(vmid)); err != nil {
		b.logf("start failed: %v", err)
		res.Outcome, res.Reason, res.Message = "red", "start_failed", "The temporary guest did not start: "+err.Error()
		return res
	}
	started := b.now()
	b.logf("started")
	timeout := defaultBootTestTimeout
	if p.TimeoutSeconds > 0 {
		timeout = time.Duration(p.TimeoutSeconds) * time.Second
	}
	outcome := b.waitForBoot(ctx, p.Kind, vmid, started, timeout)
	res.Outcome, res.Reason, res.Message, res.GuestAgent = outcome.outcome, outcome.reason, outcome.message, outcome.agent
	if outcome.outcome == "green" {
		secs := b.now().Sub(started).Seconds()
		res.BootSeconds = &secs
	}
	return res
}

type bootOutcome struct {
	outcome, reason, message string
	agent                    bool
}

func (b *BootTester) waitForBoot(ctx context.Context, kind string, vmid int, started time.Time, timeout time.Duration) bootOutcome {
	id := strconv.Itoa(vmid)
	cli := b.cli(kind)
	for {
		if kind == "vm" {
			if _, err := b.Cmd.Run(ctx, "qm", "guest", "cmd", id, "ping"); err == nil {
				b.logf("the QEMU guest agent answered")
				return bootOutcome{"green", "agent_answered", "The restored VM booted: its QEMU guest agent answered.", true}
			}
		} else if out, err := b.Cmd.Run(ctx, "pct", "exec", id, "--", "cat", "/proc/1/comm"); err == nil && strings.TrimSpace(out) != "" {
			b.logf("init runs: %s", strings.TrimSpace(out))
			return bootOutcome{"green", "init_running", fmt.Sprintf("The restored container started: its init (%s) runs.", strings.TrimSpace(out)), false}
		}
		if st, err := b.Cmd.Run(ctx, cli, "status", id); err == nil && !strings.Contains(st, "running") {
			b.logf("the guest stopped: %s", st)
			return bootOutcome{"red", "guest_stopped", "The temporary guest stopped while it booted (" + strings.TrimSpace(st) + ").", false}
		}
		if b.now().Sub(started) >= timeout {
			if kind == "vm" {
				b.logf("no answer of the guest agent within %s", timeout)
				return bootOutcome{"yellow", "no_guest_agent", fmt.Sprintf("The restored VM started and kept running for %s, but its QEMU guest agent did not answer (not installed?).", timeout), false}
			}
			return bootOutcome{"yellow", "init_unknown", fmt.Sprintf("The restored container kept running for %s, but its init could not be looked at.", timeout), false}
		}
		select {
		case <-ctx.Done():
			return bootOutcome{"", "", "cancelled: " + ctx.Err().Error(), false}
		case <-time.After(b.poll()):
		}
	}
}

var (
	netKeyRE        = regexp.MustCompile(`^net\d+$`)
	passthroughRE   = regexp.MustCompile(`^(hostpci|usb|parallel|virtiofs)\d+$`)
	serialRE        = regexp.MustCompile(`^serial\d+$`)
	driveKeyRE      = regexp.MustCompile(`^(ide|sata|scsi)\d+$`)
	ctDevRE         = regexp.MustCompile(`^dev\d+$`)
	ctMountRE       = regexp.MustCompile(`^mp\d+$`)
	bridgeOptionRE  = regexp.MustCompile(`(^|,)bridge=[^,]*`)
	linkDownRE      = regexp.MustCompile(`(^|,)link_down=[^,]*`)
	vlanTagOptionRE = regexp.MustCompile(`(^|,)(tag|trunks)=[^,]*`)
)

// isolate makes the restored guest safe to start: no network to the outside, no host devices,
// no hook script, no start on boot, the boot test's tag and name.
func (b *BootTester) isolate(ctx context.Context, p BootTestParams, vmid int) error {
	id := strconv.Itoa(vmid)
	cli := b.cli(p.Kind)
	out, err := b.Cmd.Run(ctx, cli, "config", id)
	if err != nil {
		return err
	}
	conf := parseConfigText(out)
	name := fmt.Sprintf("%s%d", BootTestNamePrefix, p.VMID)
	args := []string{"set", id}
	if p.Kind == "vm" {
		args = append(args, "--name", name)
	} else {
		args = append(args, "--hostname", name)
	}
	args = append(args, "--tags", BootTestTag, "--onboot", "0", "--protection", "0")
	var del []string
	keys := make([]string, 0, len(conf))
	for k := range conf {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	bridge := strings.TrimSpace(b.State.BootTestBridge)
	for _, k := range keys {
		v := conf[k]
		switch {
		case k == "hookscript":
			del = append(del, k)
		case netKeyRE.MatchString(k):
			switch {
			case bridge != "":
				args = append(args, "--"+k, isolatedNIC(v, bridge))
			case p.Kind == "vm":
				args = append(args, "--"+k, linkDown(v))
			default:
				// A container's interfaces go altogether: it needs none to start.
				del = append(del, k)
			}
		case p.Kind == "vm" && passthroughRE.MatchString(k):
			del = append(del, k)
		case p.Kind == "vm" && serialRE.MatchString(k) && strings.TrimSpace(v) != "socket":
			del = append(del, k)
		case p.Kind == "vm" && driveKeyRE.MatchString(k) && strings.Contains(v, "media=cdrom") && !strings.HasPrefix(v, "none"):
			// An ISO or the host's drive: the boot test needs neither (and a missing ISO stops the start).
			args = append(args, "--"+k, "none,media=cdrom")
		case p.Kind == "ct" && ctDevRE.MatchString(k):
			del = append(del, k)
		case p.Kind == "ct" && ctMountRE.MatchString(k) && strings.HasPrefix(strings.TrimSpace(v), "/"):
			// A bind mount of a host folder.
			del = append(del, k)
		}
	}
	if p.Kind == "vm" && !agentEnabled(conf["agent"]) {
		// So an installed guest agent can answer although the original has it off.
		args = append(args, "--agent", "enabled=1")
	}
	if len(del) > 0 {
		args = append(args, "--delete", strings.Join(del, ","))
	}
	if _, err := b.Cmd.Run(ctx, cli, args...); err != nil {
		return err
	}
	// Read back: no interface may reach a network.
	out, err = b.Cmd.Run(ctx, cli, "config", id)
	if err != nil {
		return err
	}
	after := parseConfigText(out)
	for k, v := range after {
		if !netKeyRE.MatchString(k) {
			continue
		}
		if bridge != "" {
			if !strings.Contains(","+v+",", ",bridge="+bridge+",") {
				return fmt.Errorf("%s is still connected: %s", k, v)
			}
		} else if !strings.Contains(","+v+",", ",link_down=1,") {
			return fmt.Errorf("%s is still connected: %s", k, v)
		}
	}
	b.logf("network cut, host devices and hook script removed")
	return nil
}

func linkDown(v string) string {
	v = linkDownRE.ReplaceAllString(v, "")
	return strings.TrimPrefix(v+",link_down=1", ",")
}

func isolatedNIC(v, bridge string) string {
	v = vlanTagOptionRE.ReplaceAllString(v, "")
	if bridgeOptionRE.MatchString(v) {
		return bridgeOptionRE.ReplaceAllString(v, "${1}bridge="+bridge)
	}
	return strings.TrimPrefix(v+",bridge="+bridge, ",")
}

func agentEnabled(v string) bool {
	v = strings.TrimSpace(v)
	return v == "1" || strings.HasPrefix(v, "1,") || strings.Contains(","+v+",", ",enabled=1,")
}

// destroy stops and removes a temporary guest; true when it is gone.
func (b *BootTester) destroy(ctx context.Context, kind string, vmid int) bool {
	id := strconv.Itoa(vmid)
	cli := b.cli(kind)
	if !b.exists(ctx, kind, vmid) {
		return true
	}
	if _, err := b.Cmd.Run(ctx, cli, "stop", id, "--skiplock", "1"); err != nil {
		b.logf("stop: %v", err)
	}
	args := []string{"destroy", id, "--purge", "1", "--destroy-unreferenced-disks", "1"}
	if kind == "vm" {
		args = append(args, "--skiplock", "1")
	} else {
		args = append(args, "--force", "1")
	}
	if _, err := b.Cmd.Run(ctx, cli, args...); err != nil {
		b.logf("destroy: %v", err)
	}
	if b.exists(ctx, kind, vmid) {
		b.logf("the temporary guest %d is still there; it is removed on the next start of the service", vmid)
		return false
	}
	b.logf("the temporary guest %d is destroyed", vmid)
	return true
}

func (b *BootTester) exists(ctx context.Context, kind string, vmid int) bool {
	_, err := b.Cmd.Run(ctx, b.cli(kind), "config", strconv.Itoa(vmid))
	return err == nil
}

// Cleanup destroys what earlier boot tests left behind: the guest of the marker file (when the
// marker shows the restore was started by this node) and every guest of this node in the
// restore pool that carries both the boot test's tag and its name.
func (b *BootTester) Cleanup(ctx context.Context) {
	var m bootTestMarker
	if err := readJSON(b.markerFile(), &m); err == nil && m.VMID > 0 {
		ours := m.UPID != "" && strings.Contains(m.UPID, ":"+strconv.Itoa(m.VMID)+":")
		if !ours && b.exists(ctx, m.Kind, m.VMID) {
			// The restore was perhaps never started by this node: not ours to remove.
			b.logf("guest %d of an interrupted boot test is not removed: its restore task is unknown", m.VMID)
			_ = os.Remove(b.markerFile())
		} else if b.destroy(ctx, m.Kind, m.VMID) {
			_ = os.Remove(b.markerFile())
		}
	}
	guests, err := b.PVE.Guests(ctx)
	if err != nil {
		return
	}
	for _, g := range guests {
		if g.Node != b.State.NodeName || g.Pool != BootTestPool || !strings.HasPrefix(g.Name, BootTestNamePrefix) {
			continue
		}
		if !hasTag(g.Tags, BootTestTag) {
			continue
		}
		kind := "vm"
		if g.Type == "lxc" {
			kind = "ct"
		}
		b.logf("removing the leftover temporary guest %d (%s)", g.VMID, g.Name)
		b.destroy(ctx, kind, g.VMID)
	}
}

func hasTag(tags, tag string) bool {
	for _, t := range splitTags(tags) {
		if t == tag {
			return true
		}
	}
	return false
}

// parseConfigText reads a PVE guest configuration ("key: value" lines) up to the first
// snapshot section.
func parseConfigText(text string) map[string]string {
	out := map[string]string{}
	sc := bufio.NewScanner(strings.NewReader(text))
	sc.Buffer(make([]byte, 64*1024), 1<<20)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if strings.HasPrefix(line, "[") {
			break
		}
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		k, v, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		out[strings.TrimSpace(k)] = strings.TrimSpace(v)
	}
	return out
}

// guestMemoryMiB is the memory a guest's configuration asks for (PVE's default 512 MiB).
func guestMemoryMiB(conf map[string]string) int {
	v := conf["memory"]
	// PVE 9 also writes "memory: current=4096".
	if strings.Contains(v, "current=") {
		for _, part := range strings.Split(v, ",") {
			if after, ok := strings.CutPrefix(strings.TrimSpace(part), "current="); ok {
				v = after
			}
		}
	}
	if n, err := strconv.Atoi(strings.TrimSpace(v)); err == nil && n > 0 {
		return n
	}
	return 512
}

// ProcMemAvailable reads MemAvailable from /proc/meminfo, in bytes.
func ProcMemAvailable() (uint64, error) {
	data, err := os.ReadFile("/proc/meminfo")
	if err != nil {
		return 0, err
	}
	for _, line := range strings.Split(string(data), "\n") {
		if rest, ok := strings.CutPrefix(line, "MemAvailable:"); ok {
			fields := strings.Fields(rest)
			if len(fields) == 0 {
				break
			}
			kib, err := strconv.ParseUint(fields[0], 10, 64)
			if err != nil {
				return 0, err
			}
			return kib << 10, nil
		}
	}
	return 0, errors.New("no MemAvailable in /proc/meminfo")
}
