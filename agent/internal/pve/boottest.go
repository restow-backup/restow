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
	"syscall"
	"time"

	"github.com/restow-backup/restow/agent/internal/lock"
)

// A boot test (docs/PVE.md, "Boot test") proves that a restore point boots: the
// node restores it through the normal restore path to a temporary VMID in the
// restore pool, on a storage of its own choice, cuts its network (every NIC
// link_down=1, or an isolated bridge without uplink the node names), takes
// away everything that reaches out of the guest (PCI and USB passthrough, host
// serial and parallel ports, virtiofs, ivshmem, audio, the host's random
// source, hugepages and NUMA binding, hook scripts), reads the configuration
// back, starts it and waits for the QEMU guest agent to answer. A container is
// started and its init is looked at. A VM with raw QEMU `args` or a disk on a
// host path is not booted at all (skipped): the test can neither keep them
// (they reach the host or a network) nor remove them (the copy may not boot
// without them, which would be a false red).
// The temporary guest is stopped and destroyed in every case; one that a crash
// or a restart of the node left behind is found again by its tag and name (or
// by the marker file) and destroyed when the service starts.
//
// Green needs proof: the guest agent answered (a container: systemd reports
// the system running). A VM that started and kept running without an answer,
// a container with a degraded system or an init Restow cannot ask is yellow; a
// restore, a start or a boot that failed (a stop, a panic, emergency mode) is
// red. A test the node cannot run safely
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
	// A qm or pct stuck in the kernel (a hung NFS storage) may outlive its kill: Wait returns
	// anyway, so a deadline really ends the call.
	cmd.WaitDelay = 10 * time.Second
	// A deadline or a stop asks first (qmrestore then stops its task), then kills.
	cmd.Cancel = func() error { return cmd.Process.Signal(syscall.SIGTERM) }
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

// cliTimeouts bound every qm and pct call: a call that hangs (a storage that does not answer)
// must not block the node's only task worker. Tests shorten them.
var cliTimeouts = struct {
	// Short: config, set, status, guest cmd (the agent's ping), exec, list.
	Short time.Duration
	// Long: start, stop, shutdown, destroy, unlock.
	Long time.Duration
	// Restore: qmrestore as root.
	Restore time.Duration
}{Short: 60 * time.Second, Long: 5 * time.Minute, Restore: 48 * time.Hour}

// cliTimeout is the deadline of one qm or pct call.
func cliTimeout(name string, args []string) time.Duration {
	if name == "qmrestore" {
		return cliTimeouts.Restore
	}
	if len(args) > 0 {
		switch args[0] {
		case "start", "stop", "shutdown", "destroy", "unlock", "reboot":
			return cliTimeouts.Long
		}
	}
	return cliTimeouts.Short
}

// command runs a qm or pct command with its deadline (cliTimeout).
func (b *BootTester) command(ctx context.Context, name string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, cliTimeout(name, args))
	defer cancel()
	out, err := b.Cmd.Run(ctx, name, args...)
	if err != nil && ctx.Err() == context.DeadlineExceeded {
		return out, fmt.Errorf("%s %s did not end within %s: %w", name, strings.Join(args, " "), minutes(cliTimeout(name, args)), err)
	}
	return out, err
}

// bootTestPVE is what a boot test and a restore task need of the local PVE API.
type bootTestPVE interface {
	NextID(ctx context.Context) (int, error)
	VMIDFree(ctx context.Context, vmid int) (bool, error)
	RestoreGuest(ctx context.Context, node, kind string, vmid int, archive, storage, pool string, mounts map[string]string) (string, error)
	WaitTask(ctx context.Context, node, upid string, poll time.Duration) (string, error)
	TaskLogTail(ctx context.Context, node, upid string, lines int) (string, error)
	Storages(ctx context.Context, node string) ([]Storage, error)
	Guests(ctx context.Context) ([]Resource, error)
	ActiveTasks(ctx context.Context, node, typeFilter string) ([]NodeTask, error)
	GuestConfig(ctx context.Context, node, kind string, vmid int) (map[string]any, error)
	TaskStatus(ctx context.Context, node, upid string) (TaskStatus, error)
	StopTask(ctx context.Context, node, upid string) error
	RecentTasks(ctx context.Context, node, typeFilter string, vmid int) ([]NodeTask, error)
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
	// AvoidVMIDs are VMIDs the temporary guest must not take: guests PVE no longer has whose
	// restore points or job Restow keeps (servers from 0.5.0).
	AvoidVMIDs []int `json:"avoidVmids"`
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
	// Warnings are the warning lines of a restore that ended "WARNINGS: n" (the test went on).
	Warnings []string `json:"warnings,omitempty"`
	// SkippedLxc are the raw lxc.* lines of a container's backup, which PVE restores only for
	// root@pam (the temporary container ran without them).
	SkippedLxc []string `json:"skippedLxc,omitempty"`
}

func (r BootTestResult) asMap() map[string]any {
	data, _ := json.Marshal(r)
	var out map[string]any
	_ = json.Unmarshal(data, &out)
	return out
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
	// ARCReclaimable is what the ZFS ARC can give back, in bytes (default: arcstats).
	ARCReclaimable func() uint64
	// ProcRoot is where the node's process table is read (default /proc).
	ProcRoot string
	// BackupRunning reports a backup on this node (default: the provider's job files).
	BackupRunning func() bool
	// SysNet is where the network interfaces of the node are read (default /sys/class/net).
	SysNet string
	// StorageConfig is the cluster's storage configuration (default /etc/pve/storage.cfg).
	StorageConfig string
	Logf          func(string, ...any)
	// Poll is the interval of the status checks (default 5 s); TaskPoll the restore task's.
	Poll     time.Duration
	TaskPoll time.Duration
	Now      func() time.Time

	mu      sync.Mutex
	log     []string
	testing bool // a boot test runs (its lines say so)
	// The output and result of root restores whose PVE task was not found (cliUPIDPrefix).
	cliOut map[string]string
	cliRes map[string]cliResult
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
		b.mu.Lock()
		prefix := "temporary guests: "
		if b.testing {
			prefix = "boot test: "
		}
		b.mu.Unlock()
		b.Logf("%s%s", prefix, line)
	}
}

func (b *BootTester) logText() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return strings.Join(b.log, "\n")
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
	b.log, b.testing = nil, true
	b.mu.Unlock()
	defer func() {
		b.mu.Lock()
		b.testing = false
		b.mu.Unlock()
	}()
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
	held, err := lock.TryAcquire(b.lockFile())
	if errors.Is(err, lock.ErrLocked) {
		return skipped(reasonBootTestRunning, "Another boot test runs on this node.")
	}
	if err != nil {
		return BootTestResult{Message: "boot test lock: " + err.Error()}
	}
	defer func() { _ = held.Release() }()
	// Whatever an earlier test or check left behind goes first, also when they are switched off.
	b.Cleanup(ctx)
	if !b.State.RestoresAllowed() {
		return skipped(reasonRestoresOff, "Restores are switched off on this node (restow-pve config --allow-restores).")
	}
	if b.State.BootTestsDisabled {
		return skipped(reasonBootTestsOff, "Boot tests are switched off on this node (restow-pve config --boot-tests).")
	}
	if reason, msg := b.backupBusy(ctx); reason != "" {
		return skipped(reason, msg)
	}
	rp, err := b.Resolve(ctx, p.Volname)
	if err != nil {
		return BootTestResult{Message: "restore point: " + err.Error()}
	}
	conf := parseConfigText(rp.GuestConfig)
	if p.Kind == "vm" {
		if reason, msg := unisolatableVM(conf); reason != "" {
			return skipped(reason, msg)
		}
	}
	memMiB := guestMemoryMiB(conf)
	maxMiB := p.MaxMemoryMiB
	if maxMiB <= 0 {
		maxMiB = defaultBootTestMaxMemory
	}
	b.logf("restore point %s of %s %d: %d MiB memory, %d bytes of disks", p.Volname, p.Kind, p.VMID, memMiB, p.DiskBytes)
	if memMiB > maxMiB {
		return skipped(reasonMemoryLimit, fmt.Sprintf("The guest needs %d MiB of memory; the job allows boot tests up to %d MiB.", memMiB, maxMiB))
	}
	memFn := b.MemAvailable
	if memFn == nil {
		memFn = ProcMemAvailable
	}
	if avail, err := memFn(); err == nil {
		arcFn := b.ARCReclaimable
		if arcFn == nil {
			arcFn = func() uint64 { return zfsARCReclaimable(zfsARCStats) }
		}
		// The ZFS ARC gives memory back when a guest needs it, but MemAvailable does not count it.
		arc := arcFn()
		avail += arc
		need := uint64(memMiB)<<20 + bootTestMemoryMarginBytes
		if avail < need {
			msg := fmt.Sprintf("The node has %d MiB of memory available; the guest needs %d MiB and 1 GiB stays free.", avail>>20, memMiB)
			if arc > 0 {
				msg = fmt.Sprintf("The node has %d MiB of memory available, %d MiB of them in the ZFS ARC that it can give back (above zfs_arc_min); the guest needs %d MiB and 1 GiB stays free.", avail>>20, arc>>20, memMiB)
			}
			return skipped(reasonNodeMemory, msg)
		}
	} else {
		b.logf("available memory unknown: %v", err)
	}
	storage := b.storage()
	if storage == "" {
		return skipped(reasonNoStorage, "This node has no storage for boot tests (restow-pve config --boot-test-storage).")
	}
	if reason, msg := b.checkStorage(ctx, storage, p, conf, rp); reason != "" {
		return skipped(reason, msg)
	}
	if bridge := strings.TrimSpace(b.State.BootTestBridge); bridge != "" {
		if msg := b.bridgeIsolated(bridge); msg != "" {
			return skipped(reasonBridgeNotIsolated, msg)
		}
	}
	res := b.restoreAndBoot(ctx, p, rp, conf, rawLxcOptions(rp.GuestConfig), storage)
	res.Storage = storage
	return res
}

// backupBusy says whether a backup or a restore works on this node now.
func (b *BootTester) backupBusy(ctx context.Context) (reason, message string) {
	running := b.BackupRunning
	if running == nil {
		running = func() bool { return busy(b.Layout) }
	}
	if running() {
		return reasonBackupRunning, "A backup or a restore runs on this node."
	}
	tasks, err := b.PVE.ActiveTasks(ctx, b.State.NodeName, "vzdump")
	if err != nil {
		b.logf("running PVE tasks unknown: %v", err)
		return "", ""
	}
	if len(tasks) > 0 {
		return reasonBackupRunning, "A PVE backup (vzdump) runs on this node."
	}
	return "", ""
}

func (b *BootTester) checkStorage(ctx context.Context, name string, p BootTestParams, conf map[string]string, rp *RestorePoint) (reason, message string) {
	data, disks := p.DataBytes, p.DiskBytes
	if p.Kind == "ct" {
		if sum := containerVolumeBytes(conf); sum > 0 {
			disks = sum
		}
		if data == 0 && rp != nil {
			data = rp.ByteSize
		}
	}
	f := b.fitStorage(ctx, name, p.Kind, data, disks)
	switch f.Problem {
	case "missing":
		return reasonNoStorage, fmt.Sprintf("The boot test storage %s does not exist on this node.", name)
	case "inactive":
		return reasonNoStorage, fmt.Sprintf("The boot test storage %s is not active on this node.", name)
	case "content":
		return reasonStorageContent, fmt.Sprintf("The boot test storage %s does not hold %s.", name, f.Want)
	case "space":
		return reasonStorageSpace, fmt.Sprintf("The boot test storage %s has %d MiB free; the restore needs about %d MiB (%s).", name, f.Avail>>20, f.Need>>20, f.Basis)
	}
	return "", ""
}

// storageFit is whether a storage of this node takes a restore (fitStorage): Problem is ""
// (it does, or the storages could not be read), "missing", "inactive", "content" (it holds no
// Want: images for a VM, rootdir for a container) or "space" (Avail is less than Need).
type storageFit struct {
	Problem     string
	Want        string
	Avail, Need uint64
	Basis       string
}

// fitStorage checks a storage of this node for a restore of a guest of kind with data bytes
// of stored data and disks bytes of disks: there, active, holding the guest's content, and
// with the space the restore takes of it (RestoreSpaceNeed, with a tenth and 1 GiB beside).
func (b *BootTester) fitStorage(ctx context.Context, name, kind string, data, disks uint64) storageFit {
	want := "images"
	if kind == "ct" {
		want = "rootdir"
	}
	list, err := b.PVE.Storages(ctx, b.State.NodeName)
	if err != nil {
		b.logf("storages unknown: %v", err)
		return storageFit{Want: want}
	}
	for _, s := range list {
		if s.Storage != name {
			continue
		}
		if s.Active != 1 {
			return storageFit{Problem: "inactive", Want: want}
		}
		if s.Content != "" && !strings.Contains(","+s.Content+",", ","+want+",") {
			return storageFit{Problem: "content", Want: want}
		}
		need, basis := RestoreSpaceNeed(kind, s, b.storageOptions(name), data, disks)
		need += need/10 + bootTestStorageMarginBytes
		b.logf("the restore needs about %d MiB on %s (%s): %d MiB free", need>>20, name, basis, s.Avail>>20)
		if s.Avail < need {
			return storageFit{Problem: "space", Want: want, Avail: s.Avail, Need: need, Basis: basis}
		}
		return storageFit{Want: want}
	}
	return storageFit{Problem: "missing", Want: want}
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

func (b *BootTester) restoreAndBoot(ctx context.Context, p BootTestParams, rp *RestorePoint, conf map[string]string, lxc lxcOptions, storage string) (res BootTestResult) {
	sp := restoreSpec{Purpose: PurposeBootTest, Kind: p.Kind, SourceVMID: p.VMID, Storage: storage, Pool: BootTestPool,
		Archive: b.State.StorageID + ":backup/" + strings.TrimPrefix(p.Volname, "backup/"), Avoid: vmidSet(p.AvoidVMIDs)}
	if p.Kind == "ct" {
		mounts, omitted, err := RestoreMounts(conf, storage, b.mountSizing(ctx, storage, rp))
		if err != nil {
			// Nothing was restored: the test could not run, which says nothing about the backup.
			res.Message = "the restore could not be planned: " + err.Error()
			return res
		}
		if len(omitted) > 0 {
			b.logf("left out of the temporary container (not part of the backup): %s", strings.Join(omitted, " | "))
		}
		sp.Params = map[string]string{"hostname": tempName(PurposeBootTest, p.VMID)}
		for k, v := range mounts {
			sp.Params[k] = v
		}
	}
	if p.Kind == "vm" {
		if keys := rootOnlyVMKeys(conf); len(keys) > 0 {
			// PVE restores these only for root@pam; isolate() removes them before the start.
			sp.Root = true
			b.logf("the VM has %s, which PVE restores only for root@pam: restoring as root", strings.Join(keys, ", "))
		}
	}
	b.logf("restoring the %s to a temporary guest on %s", p.Kind, storage)
	vmid, upid, err := b.startRestore(ctx, sp)
	if vmid > 0 {
		res.TempVMID = vmid
		// The temporary guest goes in every case, also when the test itself is cancelled.
		defer func() {
			cctx, cancel := cleanupContext(ctx)
			defer cancel()
			res.CleanedUp = b.removeTemp(cctx, p.Kind, vmid)
		}()
	}
	if err != nil {
		// PVE did not run a restore (a VMID taken, a refused call): an error, never red.
		res.Message = "the restore did not start: " + err.Error()
		return res
	}
	b.logf("restoring to the temporary %s %d (%s)", p.Kind, vmid, upid)
	exit, err := b.waitRestore(ctx, upid)
	if err != nil {
		res.Outcome, res.Message = "", "waiting for the restore: "+err.Error()
		return res
	}
	if p.Kind == "ct" && len(lxc.Lines) > 0 {
		res.SkippedLxc = lxc.Lines
	}
	if exit != "OK" {
		tail := b.taskLog(ctx, upid, 200)
		if !TaskWarnings(exit) {
			b.logf("restore ended with %q: %s", exit, lastLines(tail, 8))
			if outOfSpaceRE.MatchString(exit + "\n" + tail) {
				// The node had too little room (the boot test storage, or the temporary folder of
				// a container restore): nothing is wrong with the restore point.
				res.Outcome, res.Reason, res.Message = "skipped", reasonStorageSpace, fmt.Sprintf("The restore ran out of space on the node (the boot test storage %s or the temporary folder): %s", storage, lastLines(tail, 3))
				return res
			}
			msg := fmt.Sprintf("The restore ended with %q: %s", exit, lastLines(tail, 3))
			if p.Kind == "ct" && lxc.IDMap {
				msg += " (" + idmapHint + ")"
			}
			res.Outcome, res.Reason, res.Message = "red", reasonRestoreFailed, msg
			return res
		}
		// The restore ran to its end and warned beside it (PVE skipped what only root@pam may
		// restore): the test goes on; isolate() reads the configuration of the guest first.
		res.Warnings = WarningLines(tail, 10)
		b.logf("restored with warnings: %s", strings.Join(res.Warnings, " | "))
	} else {
		b.logf("restored")
	}
	if len(res.SkippedLxc) > 0 {
		b.logf("PVE restores raw LXC options only for root@pam; the temporary container runs without: %s", strings.Join(res.SkippedLxc, " | "))
	}
	// Its creation time proves the guest ours until isolate() gives it the tag.
	if c, err := b.PVE.GuestConfig(ctx, b.State.NodeName, p.Kind, vmid); err == nil {
		b.recordCreated(vmid, c)
	}
	agentForced, err := b.isolate(ctx, p, vmid)
	if err != nil {
		var skip *isolationSkip
		if errors.As(err, &skip) {
			b.logf("not started: %s", skip.message)
			res.Outcome, res.Reason, res.Message = "skipped", skip.reason, skip.message
			return res
		}
		// Never start a guest whose network could not be cut.
		res.Outcome, res.Message = "", "isolating the temporary guest: "+err.Error()
		return res
	}
	cli := b.cli(p.Kind)
	timeout := defaultBootTestTimeout
	if p.TimeoutSeconds > 0 {
		timeout = time.Duration(p.TimeoutSeconds) * time.Second
	}
	// The boot phase as a whole has a deadline too: each call has its own, but a node whose qm
	// or pct calls all run into theirs would otherwise take far longer than the wait.
	bootLimit := bootPhaseLimit(timeout)
	bootCtx, cancelBoot := context.WithTimeout(ctx, bootLimit)
	defer cancelBoot()
	if _, err := b.command(bootCtx, cli, "start", strconv.Itoa(vmid)); err != nil {
		if ctx.Err() == nil && bootCtx.Err() != nil {
			res.Outcome, res.Message = "", fmt.Sprintf("the boot phase did not end within %s (qm or pct did not answer)", minutes(bootLimit))
			return res
		}
		b.logf("start failed: %v", err)
		if nodeResourcesRE.MatchString(err.Error()) {
			// The node could not give the copy its memory beside the running guests: that says
			// nothing about the restore point.
			res.Outcome, res.Reason, res.Message = "skipped", reasonNodeResources, "The node could not allocate the memory of the temporary guest: "+err.Error()
			return res
		}
		res.Outcome, res.Reason, res.Message = "red", reasonStartFailed, "The temporary guest did not start: "+err.Error()
		return res
	}
	started := b.now()
	b.logf("started")
	outcome := b.waitForBoot(bootCtx, p.Kind, vmid, started, timeout, agentForced)
	if outcome.outcome == "" && ctx.Err() == nil && bootCtx.Err() != nil {
		outcome.message = fmt.Sprintf("the boot phase did not end within %s (qm or pct did not answer)", minutes(bootLimit))
	}
	res.Outcome, res.Reason, res.Message, res.GuestAgent = outcome.outcome, outcome.reason, outcome.message, outcome.agent
	if outcome.outcome == "green" {
		secs := b.now().Sub(started).Seconds()
		res.BootSeconds = &secs
	}
	return res
}

// bootPhaseLimit bounds the start and the wait for the boot: twice the wait plus five minutes
// for the start and the calls around it.
func bootPhaseLimit(timeout time.Duration) time.Duration {
	return 2*timeout + 5*time.Minute
}

type bootOutcome struct {
	outcome, reason, message string
	agent                    bool
}

var (
	netKeyRE        = regexp.MustCompile(`^net\d+$`)
	passthroughRE   = regexp.MustCompile(`^(hostpci|usb|parallel|virtiofs)\d+$`)
	serialRE        = regexp.MustCompile(`^serial\d+$`)
	driveKeyRE      = regexp.MustCompile(`^(ide|sata|scsi)\d+$`)
	numaNodeRE      = regexp.MustCompile(`^numa\d+$`)
	ctDevRE         = regexp.MustCompile(`^dev\d+$`)
	ctMountRE       = regexp.MustCompile(`^mp\d+$`)
	bridgeOptionRE  = regexp.MustCompile(`(^|,)bridge=[^,]*`)
	linkDownRE      = regexp.MustCompile(`(^|,)link_down=[^,]*`)
	vlanTagOptionRE = regexp.MustCompile(`(^|,)(tag|trunks)=[^,]*`)
	// The ports PVE itself puts on a bridge for guests: a VM's tap, a container's veth, the
	// firewall bridge's fwpr. Anything else (a NIC, a bond, a VLAN, a VXLAN) is a way out.
	guestPortRE = regexp.MustCompile(`^(tap\d+i\d+|veth\d+i\d+|fwpr\d+p\d+)$`)
	// A restore that failed for want of space on the node, not for its restore point.
	outOfSpaceRE = regexp.MustCompile(`(?i)no space left|insufficient free space|out of space|not enough (free )?space|lvcreate .*failed|refreservation|disk quota exceeded|ENOSPC`)
	// A start that failed for want of memory of the node (hugepages, a memory backend).
	nodeResourcesRE = regexp.MustCompile(`(?i)hugepage|cannot allocate memory|out of memory|not enough memory|memory allocation|unable to allocate|failed to allocate`)
	// The raw lxc.* lines that reach the host's devices, network or programs.
	hostLxcRE = regexp.MustCompile(`^lxc\.(net|mount\.entry|mount\.auto|hook|cgroup2?\.devices)`)
)

// isolationSkip: the restored guest cannot be isolated without changing what it needs to boot;
// the test is skipped with the reason.
type isolationSkip struct{ reason, message string }

func (e *isolationSkip) Error() string { return e.message }

// unisolatableVM says why a VM configuration is never booted by a boot test: raw QEMU arguments
// can add a disk of the host, a network or a device that no other key shows, and the copy may
// need them to boot, so they can neither stay nor go. Arguments that only tune the CPU, the
// firmware tables or the clock (safeQemuArgs) stay.
func unisolatableVM(conf map[string]string) (reason, message string) {
	if v := strings.TrimSpace(conf["args"]); v != "" && !safeQemuArgs(v) {
		return reasonCustomQemuArgs, fmt.Sprintf("The VM has raw QEMU arguments (args: %s), which can reach the host's disks, devices or a network; a boot test cannot isolate it without them and does not boot it with them.", v)
	}
	return "", ""
}

// safeQemuOptions are QEMU options that reach nothing outside the guest.
var safeQemuOptions = map[string]bool{"-cpu": true, "-smbios": true, "-rtc": true, "-overcommit": true, "-msg": true}

// safeQemuArgs: raw QEMU arguments made only of safeQemuOptions, each with at most one value
// ("-cpu host,+invtsc"). Quotes or anything else make them unsafe.
func safeQemuArgs(v string) bool {
	if strings.ContainsAny(v, "\"'\\") {
		return false
	}
	fields := strings.Fields(v)
	for i := 0; i < len(fields); i++ {
		if !safeQemuOptions[fields[i]] {
			return false
		}
		if i+1 < len(fields) && !strings.HasPrefix(fields[i+1], "-") {
			i++
		}
	}
	return len(fields) > 0
}

// hostDisk is a disk of a restored VM configuration on an absolute host path
// (/dev/disk/by-id/...). A disk that was backed up is restored onto the boot test storage, so
// such a line is one the restore kept as it was: the copy would open the original's device.
func hostDisk(conf map[string]string) (string, string) {
	keys := make([]string, 0, len(conf))
	for k := range conf {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		v := conf[k]
		if !diskKeyRE.MatchString(k) || strings.Contains(v, "media=cdrom") {
			continue
		}
		vol := mountVolume(v)
		if strings.HasPrefix(vol, "/") {
			return k, v
		}
	}
	return "", ""
}

// isolatedKey says whether a key of a restored configuration reaches out of the guest and goes
// before the start (and must be gone when the configuration is read back).
func isolatedKey(kind, k, v string) bool {
	if k == "hookscript" {
		return true
	}
	if kind == "ct" {
		return ctDevRE.MatchString(k) || (ctMountRE.MatchString(k) && !isVolumeMount(v))
	}
	switch {
	case k == "args":
		// Raw QEMU arguments may add a device, a disk or a network of their own.
		return !safeQemuArgs(v)
	case k == "ivshmem", k == "audio0", k == "rng0":
		// Shared memory with the host or other guests; the host's sound and random source.
		return true
	case k == "hugepages", k == "keephugepages", numaNodeRE.MatchString(k):
		// Pages and NUMA nodes of the host the running original holds; the copy runs on
		// normal memory, which changes nothing a restore point proves.
		return true
	case passthroughRE.MatchString(k):
		return true
	case serialRE.MatchString(k) && strings.TrimSpace(v) != "socket":
		return true
	}
	return false
}

// isolate makes the restored guest safe to start: no network to the outside, no host devices,
// no hook script, no start on boot, the boot test's tag and name. agentForced: the VM's
// configuration had the QEMU guest agent off, and isolate switched it on.
func (b *BootTester) isolate(ctx context.Context, p BootTestParams, vmid int) (agentForced bool, err error) {
	id := strconv.Itoa(vmid)
	cli := b.cli(p.Kind)
	out, err := b.command(ctx, cli, "config", id)
	if err != nil {
		return false, err
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
		case isolatedKey(p.Kind, k, v):
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
		case p.Kind == "vm" && driveKeyRE.MatchString(k) && strings.Contains(v, "media=cdrom") && !strings.HasPrefix(v, "none"):
			// An ISO or the host's drive: the boot test needs neither (and a missing ISO stops the start).
			args = append(args, "--"+k, "none,media=cdrom")
		}
	}
	if p.Kind == "vm" && !agentEnabled(conf["agent"]) {
		// So an installed guest agent can answer although the original has it off.
		args = append(args, "--agent", "enabled=1")
		agentForced = true
	}
	if len(del) > 0 {
		args = append(args, "--delete", strings.Join(del, ","))
	}
	if _, err := b.command(ctx, cli, args...); err != nil {
		return agentForced, err
	}
	if p.Kind == "vm" {
		// Tagged and named by now, so its removal finds it ours.
		if k, v := hostDisk(conf); k != "" {
			return agentForced, &isolationSkip{reasonHostDisk, fmt.Sprintf("The restored VM has a disk on a host device (%s: %s); its copy would open the same device as the original.", k, v)}
		}
	}
	// Read back: no interface may reach a network, nothing of the host may be left.
	out, err = b.command(ctx, cli, "config", id)
	if err != nil {
		return agentForced, err
	}
	return agentForced, b.checkIsolated(p.Kind, out, bridge)
}

// checkIsolated reads a temporary guest's configuration back after isolate(): an error names
// what still reaches out of it.
func (b *BootTester) checkIsolated(kind, text, bridge string) error {
	after := parseConfigText(text)
	keys := make([]string, 0, len(after))
	for k := range after {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		v := after[k]
		switch {
		case netKeyRE.MatchString(k):
			if bridge != "" {
				if !strings.Contains(","+v+",", ",bridge="+bridge+",") {
					return fmt.Errorf("%s is still connected: %s", k, v)
				}
			} else if kind == "ct" || !strings.Contains(","+v+",", ",link_down=1,") {
				return fmt.Errorf("%s is still connected: %s", k, v)
			}
		case isolatedKey(kind, k, v):
			return fmt.Errorf("%s is still configured: %s", k, v)
		case kind == "vm" && driveKeyRE.MatchString(k) && strings.Contains(v, "media=cdrom") && !strings.HasPrefix(v, "none"):
			return fmt.Errorf("%s still holds a medium: %s", k, v)
		}
	}
	if kind == "vm" {
		if k, v := hostDisk(after); k != "" {
			return fmt.Errorf("%s is a disk on a host device: %s", k, v)
		}
	}
	for _, line := range rawLxcOptions(text).Lines {
		if hostLxcRE.MatchString(line) {
			return fmt.Errorf("the raw LXC option %q is still configured", line)
		}
	}
	b.logf("network cut, host devices and hook script removed")
	return nil
}

// bridgeIsolated says why the node's boot test bridge is no isolated network ("" when it is):
// a Linux bridge whose ports are only those of guests (no NIC, bond, VLAN or tunnel).
func (b *BootTester) bridgeIsolated(bridge string) string {
	root := b.SysNet
	if root == "" {
		root = "/sys/class/net"
	}
	if strings.ContainsAny(bridge, "/.") || bridge == "" {
		return fmt.Sprintf("The boot test bridge %q is no valid interface name (restow-pve config --boot-test-bridge).", bridge)
	}
	if _, err := os.Stat(filepath.Join(root, bridge, "bridge")); err != nil {
		return fmt.Sprintf("The boot test bridge %s is no Linux bridge of this node (restow-pve config --boot-test-bridge); its isolation cannot be verified.", bridge)
	}
	ports, err := os.ReadDir(filepath.Join(root, bridge, "brif"))
	if err != nil {
		return fmt.Sprintf("The ports of the boot test bridge %s cannot be read (%v); its isolation cannot be verified.", bridge, err)
	}
	for _, port := range ports {
		name := port.Name()
		if !guestPortRE.MatchString(name) {
			return fmt.Sprintf("The boot test bridge %s has the port %s (a network card, bond, VLAN or tunnel), so a temporary guest on it could reach a network; use a bridge without ports (bridge-ports none).", bridge, name)
		}
	}
	return ""
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
