//go:build !windows

package pve

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/restow-backup/restow/agent/internal/buildinfo"
)

// PluginFiles are the files of the storage plugin shim as a release ships them.
var PluginFiles = []string{"RestowPlugin.pm", "RestowProvider.pm"}

// PluginPath is where a file of the shim is installed: the storage plugin in
// PVE's custom plugin folder, the provider among the backup providers (a
// module in the custom folder that is no storage plugin would be reported by
// PVE on every load).
func PluginPath(l Layout, file string) string {
	if file == "RestowProvider.pm" {
		return filepath.Join(l.ProviderDir, "Restow.pm")
	}
	return filepath.Join(l.PluginDir, file)
}

// Service is the long-running part (`restow-pve run`): heartbeat, tasks,
// inventory and the caches the storage plugin reads.
type Service struct {
	Layout Layout
	State  *State
	Server *Server
	PVE    *PVEAPI
	Logf   func(string, ...any)
	// Interval between heartbeats (default 60 s).
	Interval time.Duration
	// InventoryEvery is how often the inventory is reported (default 5 min).
	InventoryEvery time.Duration

	// BusyInterval is the time between heartbeats while a task runs or waits (default 15 s), so
	// a backup cancelled in Restow stops within seconds.
	BusyInterval time.Duration
	// OnUpdate installs an offered release when the server says "update now" and the node is
	// idle (`restow-pve run` sets it: verify, install, restart); nil means never.
	OnUpdate func(ctx context.Context, version string)

	// VzdumpRunning reports a vzdump task of PVE on this node (an update waits for it); nil
	// asks the PVE API.
	VzdumpRunning func(ctx context.Context) bool

	// Cmd runs qm and pct (boot tests); nil means the real commands.
	Cmd CommandRunner
	// BootTests runs the boot tests; nil means one built from the fields above.
	BootTests *BootTester

	// The tasks: the heartbeat queues them, one worker runs them one after another, and the
	// heartbeat goes on meanwhile (cancel orders, cancel.go).
	mu        sync.Mutex
	cur       *current
	queue     []Task
	cancelled map[string]bool
	stopped   map[string]bool
	wake      chan struct{}
	// updateMu keeps tasks and a self-update apart: the worker holds it while it takes and runs
	// a task, an update from its check until the process exits (UpdateWhenIdle).
	updateMu sync.Mutex

	// Owned by the heartbeat loop.
	lastInvent   time.Time
	pveVersion   string
	lastProblems []string
}

// lazyLocked creates the task state; s.mu is held.
func (s *Service) lazyLocked() {
	if s.wake == nil {
		s.wake = make(chan struct{}, 1)
		s.cancelled = map[string]bool{}
		s.stopped = map[string]bool{}
	}
}

// Busy reports whether a task runs or waits on this node.
func (s *Service) Busy() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.cur != nil || len(s.queue) > 0
}

// enqueue adds the tasks of a heartbeat that are not queued or running already.
func (s *Service) enqueue(tasks []Task) {
	if len(tasks) == 0 {
		return
	}
	s.mu.Lock()
	s.lazyLocked()
	for _, t := range tasks {
		known := s.cur != nil && s.cur.id == t.ID
		for _, q := range s.queue {
			known = known || q.ID == t.ID
		}
		if !known {
			s.queue = append(s.queue, t)
		}
	}
	wake := s.wake
	s.mu.Unlock()
	select {
	case wake <- struct{}{}:
	default:
	}
}

// dropQueued removes a task that waits in the queue; false when it does not wait there.
func (s *Service) dropQueued(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, q := range s.queue {
		if q.ID == id {
			s.queue = append(s.queue[:i], s.queue[i+1:]...)
			return true
		}
	}
	return false
}

func (s *Service) isCancelled(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.cancelled[id]
}

// startedVzdump records the vzdump task of the running task. True when the task was cancelled
// meanwhile: the caller stops the vzdump task at once.
func (s *Service) startedVzdump(id, upid string, vmid int) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.lazyLocked()
	if s.cur != nil && s.cur.id == id {
		s.cur.upid, s.cur.vmid = upid, vmid
	}
	if s.cancelled[id] && !s.stopped[upid] {
		s.stopped[upid] = true
		return true
	}
	return false
}

// work runs the queued tasks one after another until ctx ends. It takes a task only while no
// self-update runs (updateMu): an update that found the node idle restarts it before the next.
func (s *Service) work(ctx context.Context) {
	for {
		s.mu.Lock()
		s.lazyLocked()
		waiting := len(s.queue) > 0
		wake := s.wake
		s.mu.Unlock()
		if !waiting {
			select {
			case <-ctx.Done():
				return
			case <-wake:
			}
			continue
		}
		s.updateMu.Lock()
		s.mu.Lock()
		var next *Task
		if len(s.queue) > 0 {
			t := s.queue[0]
			s.queue = s.queue[1:]
			next = &t
			s.cur = &current{id: t.ID, kind: t.Kind}
		}
		s.mu.Unlock()
		if next != nil {
			s.runTask(ctx, *next)
		}
		s.updateMu.Unlock()
	}
}

// UpdateWhenIdle calls install (a self-update, or the restart of the PVE daemons) only while
// nothing works on this node: no task of the service runs or waits, no backup or restore of PVE
// works here (busy), no vzdump task runs. From the check until install returns the worker
// starts no task; a successful update exits the process inside install, so none starts before
// the restart. It returns why install was not called ("" when it was).
func (s *Service) UpdateWhenIdle(ctx context.Context, install func(context.Context)) string {
	if !s.updateMu.TryLock() {
		return "a task runs on this node"
	}
	defer s.updateMu.Unlock()
	if s.Busy() {
		return "a task runs or waits on this node"
	}
	if busy(s.Layout) {
		return "a backup or restore runs on this node"
	}
	if s.vzdumpRunning(ctx) {
		return "a PVE backup (vzdump) runs on this node"
	}
	install(ctx)
	return ""
}

// vzdumpRunning: a vzdump task runs on this node (also one before its first call of the
// provider, which leaves no job file yet). Unknown counts as none.
func (s *Service) vzdumpRunning(ctx context.Context) bool {
	if s.VzdumpRunning != nil {
		return s.VzdumpRunning(ctx)
	}
	if s.PVE == nil {
		return false
	}
	tasks, err := s.PVE.ActiveTasks(ctx, s.State.NodeName, "vzdump")
	return err == nil && len(tasks) > 0
}

// Capabilities are the task kinds beyond the original set this node announces.
func (s *Service) Capabilities() []string {
	caps := []string{}
	if !s.State.BootTestsDisabled {
		caps = append(caps, BootTestCapability)
	}
	return caps
}

func (s *Service) bootTester() *BootTester {
	if s.BootTests == nil {
		cmd := s.Cmd
		if cmd == nil {
			cmd = ExecRunner{}
		}
		s.BootTests = &BootTester{Layout: s.Layout, State: s.State, PVE: s.PVE, Cmd: cmd,
			Resolve: s.Server.ResolveVolname, Logf: s.Logf}
	}
	return s.BootTests
}

// ServiceStatus is written after every heartbeat (status, diagnose).
type ServiceStatus struct {
	LastHeartbeat string   `json:"lastHeartbeat"`
	LastError     string   `json:"lastError,omitempty"`
	PVEVersion    string   `json:"pveVersion"`
	Problems      []string `json:"problems"`
	Guests        int      `json:"guests"`
}

// Run loops until ctx ends.
func (s *Service) Run(ctx context.Context) error {
	if s.Interval == 0 {
		s.Interval = 60 * time.Second
	}
	if s.InventoryEvery == 0 {
		s.InventoryEvery = 5 * time.Minute
	}
	if s.BusyInterval == 0 {
		s.BusyInterval = 15 * time.Second
	}
	// A boot test or restore check the last run of the service could not finish leaves a
	// temporary guest; it goes also when boot tests or restores are switched off since.
	s.bootTester().Cleanup(ctx)
	// Backups and restores PVE went on with while the service was stopped are waited for again.
	for _, e := range loadInflight(s.Layout) {
		s.Logf("task %s (%s): waiting again for %s, which PVE started before restow-pve stopped", e.TaskID, e.Kind, e.UPID)
		s.enqueue([]Task{{ID: e.TaskID, Kind: e.Kind, Params: e.Params}})
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		s.work(ctx)
	}()
	defer func() { <-done }()
	for {
		if err := s.Tick(ctx); err != nil {
			s.Logf("heartbeat: %v", err)
			if IsStatus(err, 401) {
				s.Logf("the Restow server refuses this node's credentials (revoked?)")
			}
		}
		wait := s.Interval
		if s.Busy() && s.BusyInterval < wait {
			wait = s.BusyInterval
		}
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(wait):
		}
	}
}

// Problems lists what keeps backups from working on this node (failure cause codes).
func (s *Service) Problems(ctx context.Context) []string {
	var out []string
	for _, f := range PluginFiles {
		if _, err := os.Stat(PluginPath(s.Layout, f)); err != nil {
			out = append(out, "pve.plugin_not_loaded")
			break
		}
	}
	v, err := s.PVE.Version(ctx)
	if err != nil {
		var pe *PVEAPIError
		if errors.As(err, &pe) && pe.Status == 401 {
			out = append(out, "pve.token_invalid")
		} else {
			out = append(out, "pve.api_unreachable")
		}
		return out
	}
	s.pveVersion = v
	if !VersionAtLeast(v, 8, 4) {
		out = append(out, "pve.version_unsupported")
	}
	if perms, err := s.PVE.Permissions(ctx); err == nil {
		if missing := MissingPrivileges(perms); len(missing) > 0 {
			out = append(out, "pve.permission_missing")
		}
	}
	if s.State.FleecingStorage == "" {
		out = append(out, "pve.fleecing_missing")
	} else if st, err := s.PVE.Storages(ctx, s.State.NodeName); err == nil {
		found := false
		for _, x := range st {
			if x.Storage == s.State.FleecingStorage && x.Active == 1 {
				found = true
			}
		}
		if !found {
			out = append(out, "pve.fleecing_missing")
		}
	}
	return out
}

// RequiredPrivileges are what backups need on "/" (docs/PVE.md, onboarding).
var RequiredPrivileges = []string{"VM.Audit", "VM.Backup", "Datastore.Audit", "Datastore.AllocateSpace", "Sys.Audit"}

// MissingPrivileges compares GET /access/permissions with RequiredPrivileges.
// PVE lists every privilege the token holds on a path; the value is only the
// propagate flag, so a privilege set without propagation (0) is held as well.
func MissingPrivileges(perms map[string]map[string]int) []string {
	root := perms["/"]
	var missing []string
	for _, p := range RequiredPrivileges {
		if _, ok := root[p]; !ok {
			missing = append(missing, p)
		}
	}
	return missing
}

var versionRE = regexp.MustCompile(`^(\d+)\.(\d+)`)

// VersionAtLeast compares a PVE version ("9.2.1") with major.minor.
func VersionAtLeast(v string, major, minor int) bool {
	m := versionRE.FindStringSubmatch(v)
	if m == nil {
		return false
	}
	a, _ := strconv.Atoi(m[1])
	b, _ := strconv.Atoi(m[2])
	return a > major || (a == major && b >= minor)
}

// Tick runs one heartbeat round.
func (s *Service) Tick(ctx context.Context) error {
	// Results the server did not take before (it was unreachable) go first: a task the
	// server would otherwise hand out again is settled before the heartbeat.
	s.flushResults(ctx)
	problems := s.Problems(ctx)
	s.lastProblems = problems
	state := "idle"
	if s.Busy() {
		state = "running"
	}
	hb, err := s.Server.Heartbeat(ctx, HeartbeatRequest{
		HelperVersion: buildinfo.Version, PVEVersion: s.pveVersion, FleecingStorage: s.State.FleecingStorage,
		PluginLoaded: !contains(problems, "pve.plugin_not_loaded"), State: state, Problems: problems,
		RestoresAllowed: s.State.RestoresAllowed(), ActiveRuns: activeRuns(s.Layout),
		Capabilities: s.Capabilities(),
	})
	status := ServiceStatus{LastHeartbeat: time.Now().UTC().Format(time.RFC3339), PVEVersion: s.pveVersion, Problems: problems}
	if err != nil {
		status.LastError = err.Error()
		_ = writeJSONAtomic(s.Layout.ServiceStatus(), status, 0o644)
		return err
	}
	total := uint64(hb.Usage.BudgetBytes)
	used := uint64(hb.Usage.UsedBytes)
	if total == 0 || total < used {
		total = used + 1<<40
	}
	_ = os.MkdirAll(filepath.Dir(s.Layout.StatusCache()), 0o755)
	_ = writeJSONAtomic(s.Layout.StatusCache(), StatusCache{Total: total, Used: used, Avail: total - used, Active: true}, 0o644)
	if l, err := s.Server.Listings(ctx); err == nil {
		_ = writeJSONAtomic(s.Layout.VolumesCache(), l, 0o644)
	}
	if time.Since(s.lastInvent) > s.InventoryEvery {
		if n, err := s.ReportInventory(ctx); err != nil {
			s.Logf("inventory: %v", err)
		} else {
			s.lastInvent = time.Now()
			status.Guests = n
		}
	}
	_ = writeJSONAtomic(s.Layout.ServiceStatus(), status, 0o644)
	s.applyCancel(ctx, hb.Cancel)
	s.enqueue(hb.Tasks)
	// "Update now": installed only while nothing runs here (no task, no backup PVE started).
	if hb.Update != nil && hb.Update.Now && s.OnUpdate != nil {
		v := hb.Update.Version
		s.UpdateWhenIdle(ctx, func(ctx context.Context) {
			s.Logf("the Restow server asks this node to update to %s now", v)
			s.OnUpdate(ctx, v)
		})
	}
	return nil
}

func contains(list []string, v string) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}

var diskKeyRE = regexp.MustCompile(`^(scsi|virtio|sata|ide|efidisk|tpmstate)\d+$`)
var mpKeyRE = regexp.MustCompile(`^(rootfs|mp\d+)$`)
var sizeRE = regexp.MustCompile(`(?:^|,)size=(\d+(?:\.\d+)?)([KMGT]?)`)

// ParseDiskSize reads the size= option of a disk line ("local-lvm:vm-101-disk-0,size=32G").
func ParseDiskSize(value string) uint64 {
	m := sizeRE.FindStringSubmatch(value)
	if m == nil {
		return 0
	}
	f, _ := strconv.ParseFloat(m[1], 64)
	mult := map[string]float64{"": 1, "K": 1 << 10, "M": 1 << 20, "G": 1 << 30, "T": 1 << 40}[m[2]]
	return uint64(f * mult)
}

// GuestDisks lists the disks of a guest configuration. VM device names are
// QEMU drive ids as PVE passes them to the provider (drive-scsi0; the TPM
// state appears as drive-tpmstate0-backup).
func GuestDisks(kind string, conf map[string]any) []InventoryDisk {
	var out []InventoryDisk
	for k, v := range conf {
		s, ok := v.(string)
		if !ok {
			continue
		}
		if kind == "vm" && diskKeyRE.MatchString(k) {
			if strings.Contains(s, "media=cdrom") || strings.HasPrefix(s, "none") || strings.Contains(s, "cloudinit") {
				continue
			}
			dev := "drive-" + k
			if strings.HasPrefix(k, "tpmstate") {
				dev += "-backup"
			}
			out = append(out, InventoryDisk{Device: dev, Size: ParseDiskSize(s), Backup: !strings.Contains(s, "backup=0")})
		}
		if kind == "ct" && mpKeyRE.MatchString(k) {
			backup := k == "rootfs" || strings.Contains(s, "backup=1")
			out = append(out, InventoryDisk{Device: k, Size: ParseDiskSize(s), Backup: backup})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Device < out[j].Device })
	return out
}

// ReportInventory sends the guests that run on this node.
func (s *Service) ReportInventory(ctx context.Context) (int, error) {
	res, err := s.PVE.Guests(ctx)
	if err != nil {
		return 0, err
	}
	var guests []InventoryGuest
	containers := map[int]bool{}
	for _, r := range res {
		if r.Node != s.State.NodeName {
			continue
		}
		kind := "vm"
		if r.Type == "lxc" {
			kind = "ct"
			containers[r.VMID] = true
		}
		g := InventoryGuest{VMID: r.VMID, Kind: kind, Name: r.Name, Node: r.Node, Status: r.Status,
			Template: r.Template == 1, Pool: r.Pool, Tags: splitTags(r.Tags)}
		if conf, err := s.PVE.GuestConfig(ctx, r.Node, kind, r.VMID); err == nil {
			g.Disks = GuestDisks(kind, conf)
			if kind == "ct" {
				g.Privileged = fmt.Sprint(conf["unprivileged"]) != "1"
			} else {
				g.Agent = strings.HasPrefix(fmt.Sprint(conf["agent"]), "1") || strings.Contains(fmt.Sprint(conf["agent"]), "enabled=1")
				g.SMBIOSUUID = SMBIOSUUID(conf)
			}
		}
		guests = append(guests, g)
	}
	pruneContainerCaches(s.Layout, containers)
	return len(guests), s.Server.ReportInventory(ctx, guests)
}

// SMBIOSUUID is the SMBIOS UUID of a VM (`smbios1: uuid=...`), lower case, or "". The guest
// reads it as /sys/class/dmi/id/product_uuid, so the Restow server can tell whether a VM is
// the one it runs in (docs/PVE.md, "The Restow server's own VM").
func SMBIOSUUID(conf map[string]any) string {
	raw, ok := conf["smbios1"].(string)
	if !ok {
		return ""
	}
	for _, part := range strings.Split(raw, ",") {
		k, v, found := strings.Cut(strings.TrimSpace(part), "=")
		if found && k == "uuid" && uuidRE.MatchString(v) {
			return strings.ToLower(v)
		}
	}
	return ""
}

var uuidRE = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

func splitTags(s string) []string {
	var out []string
	for _, t := range strings.FieldsFunc(s, func(r rune) bool { return r == ';' || r == ',' || r == ' ' }) {
		out = append(out, t)
	}
	return out
}

type backupParams struct {
	VMID       int    `json:"vmid"`
	Mode       string `json:"mode"`
	Fleecing   string `json:"fleecingStorage"`
	VerifyRead bool   `json:"verifyRead"`
}

func (s *Service) runTask(ctx context.Context, t Task) {
	// A task whose result is still waiting to be sent ran already: the server delivered it
	// again because the result never reached it. It is not run a second time.
	if s.pendingResult(t.ID) {
		s.Logf("task %s ran already; its result is sent again", t.ID)
		s.dropInflight(t.ID)
		s.flushResults(ctx)
		return
	}
	defer func() {
		s.mu.Lock()
		s.cur = nil
		delete(s.cancelled, t.ID)
		s.mu.Unlock()
	}()
	var result map[string]any
	var err error
	if e := s.inflight(t.ID); e != nil {
		result, err = s.resume(ctx, *e)
	} else {
		result, err = s.task(ctx, t)
	}
	if err != nil && ctx.Err() != nil {
		// The service stops (systemctl restart, the installer, a self-update, a reboot): that
		// says nothing about the task. A PVE task that runs is waited for again after the
		// restart; a task that had not started one is delivered again by the server.
		if e := s.inflight(t.ID); e != nil {
			s.Logf("task %s (%s): the service stops; %s is waited for again after the restart", t.ID, t.Kind, e.UPID)
		} else {
			s.Logf("task %s (%s) was interrupted by the stop of the service; no result is reported", t.ID, t.Kind)
		}
		return
	}
	status, msg := "done", ""
	if err != nil {
		status, msg = "failed", err.Error()
		if s.isCancelled(t.ID) && !errors.Is(err, ErrCancelled) {
			msg = ErrCancelled.Error() + ": " + msg
		}
		s.Logf("task %s (%s) failed: %v", t.ID, t.Kind, err)
	} else if w, ok := result["warnings"].([]string); ok && len(w) > 0 {
		s.Logf("task %s (%s) done with warnings: %s", t.ID, t.Kind, strings.Join(w, " | "))
	}
	s.reportResult(ctx, PendingResult{TaskID: t.ID, Status: status, Error: msg, Result: result})
	s.dropInflight(t.ID)
}

// resume waits again for the PVE task of a backup or restore that ran when the service stopped,
// and ends the task as it would have ended without the stop.
func (s *Service) resume(ctx context.Context, e inflightTask) (map[string]any, error) {
	switch e.Kind {
	case "backup":
		if s.startedVzdump(e.TaskID, e.UPID, e.VMID) {
			if err := s.PVE.StopTask(ctx, s.State.NodeName, e.UPID); err != nil {
				s.Logf("stopping %s: %v", e.UPID, err)
			}
		}
		return s.finishBackup(ctx, e.UPID)
	case "restore":
		var p restoreParams
		if err := json.Unmarshal(e.Params, &p); err != nil || e.Restore == nil {
			return nil, errors.New("invalid restore task")
		}
		return s.finishRestore(ctx, e.TaskID, p, *e.Restore)
	}
	return nil, fmt.Errorf("a task of kind %q cannot be waited for again", e.Kind)
}

var taskWarningsRE = regexp.MustCompile(`^WARNINGS:\s*\d+$`)

// TaskWarnings says whether the exit status of a PVE task is "WARNINGS: n": the task ran to its
// end and logged warnings beside it. vzdump ends so for a notes template or a hook script; a
// restore ends so when it skipped what only root@pam may restore (raw lxc.* keys) or its
// autostart failed. Any other status but "OK" is an error.
func TaskWarnings(exit string) bool {
	return taskWarningsRE.MatchString(strings.ToUpper(strings.TrimSpace(exit)))
}

// WarningLines picks the warning lines of a task log tail (at most max, the last ones).
func WarningLines(tail string, max int) []string {
	var out []string
	for _, line := range strings.Split(tail, "\n") {
		line = strings.TrimSpace(line)
		upper := strings.ToUpper(line)
		if line == "" || strings.HasPrefix(upper, "TASK WARNINGS") {
			continue
		}
		if strings.Contains(upper, "WARN") {
			if len(line) > 500 {
				line = line[:500]
			}
			out = append(out, line)
		}
	}
	if len(out) > max {
		out = out[len(out)-max:]
	}
	return out
}

func (s *Service) task(ctx context.Context, t Task) (map[string]any, error) {
	switch t.Kind {
	case "backup":
		var p backupParams
		if err := json.Unmarshal(t.Params, &p); err != nil || p.VMID <= 0 {
			return nil, errors.New("invalid backup task")
		}
		mode := p.Mode
		if mode != "suspend" && mode != "stop" {
			mode = "snapshot"
		}
		fleecing := p.Fleecing
		if fleecing == "" {
			fleecing = s.State.FleecingStorage
		}
		if p.VerifyRead {
			_ = os.MkdirAll(filepath.Dir(s.Layout.forceNewFile(p.VMID)), 0o700)
			_ = os.WriteFile(s.Layout.forceNewFile(p.VMID), nil, 0o600)
		}
		if s.isCancelled(t.ID) {
			return nil, ErrCancelled
		}
		upid, err := s.PVE.StartBackup(ctx, s.State.NodeName, p.VMID, s.State.StorageID, mode, fleecing)
		if err != nil {
			// No backup ran, so no full read is owed to it.
			_ = os.Remove(s.Layout.forceNewFile(p.VMID))
			var none *NoTaskError
			if errors.As(err, &none) {
				return nil, s.whereIsGuest(ctx, p.VMID)
			}
			return nil, err
		}
		s.Logf("backup of %d started: %s", p.VMID, upid)
		s.keepInflight(inflightTask{TaskID: t.ID, Kind: t.Kind, Params: t.Params, UPID: upid, VMID: p.VMID,
			StartedAt: time.Now().UTC().Format(time.RFC3339)})
		if s.startedVzdump(t.ID, upid, p.VMID) {
			// Cancelled while vzdump was being started.
			if err := s.PVE.StopTask(ctx, s.State.NodeName, upid); err != nil {
				s.Logf("stopping %s: %v", upid, err)
			}
		}
		return s.finishBackup(ctx, upid)
	case "restore":
		return s.restoreTask(ctx, t)
	case "boot_test":
		var p BootTestParams
		if err := json.Unmarshal(t.Params, &p); err != nil {
			return nil, errors.New("invalid boot test task")
		}
		res, err := s.bootTester().Run(ctx, p)
		return res.asMap(), err
	case "refresh_inventory":
		n, err := s.ReportInventory(ctx)
		return map[string]any{"guests": n}, err
	}
	return nil, fmt.Errorf("unknown task kind %q", t.Kind)
}

// whereIsGuest explains why vzdump started no task for the guest: it is on another node now
// (Restow backs it up there once the inventory says so, which this asks for at once), or in no
// node of the cluster any more.
func (s *Service) whereIsGuest(ctx context.Context, vmid int) error {
	node := s.State.NodeName
	guests, err := s.PVE.Guests(ctx)
	if err != nil {
		return fmt.Errorf("vzdump started no task; guest %d is probably no longer on node %s (the cluster's guests cannot be read: %v)", vmid, node, err)
	}
	for _, g := range guests {
		if g.VMID != vmid {
			continue
		}
		if g.Node == node {
			return fmt.Errorf("vzdump started no task for guest %d on node %s, where PVE lists it", vmid, node)
		}
		if _, err := s.ReportInventory(ctx); err != nil {
			s.Logf("inventory: %v", err)
		}
		return fmt.Errorf("guest %d now runs on node %s; Restow backs it up there after the next inventory", vmid, g.Node)
	}
	return fmt.Errorf("guest %d was not found in the cluster", vmid)
}

// finishBackup waits for a vzdump task and makes the task's result of its end.
func (s *Service) finishBackup(ctx context.Context, upid string) (map[string]any, error) {
	exit, err := s.PVE.WaitTask(ctx, s.State.NodeName, upid, 5*time.Second)
	if err != nil {
		return nil, err
	}
	result := map[string]any{"upid": upid, "exitStatus": exit}
	if exit == "OK" {
		return result, nil
	}
	tail, _ := s.PVE.TaskLogTail(ctx, s.State.NodeName, upid, 200)
	if TaskWarnings(exit) {
		// vzdump finished the backup and warned about something beside it: the task is done;
		// the server decides by the run's restore point whether the backup succeeded, and
		// shows the warnings with it (docs/PVE-PROTOCOL.md, "Task results").
		result["warnings"] = WarningLines(tail, 10)
		return result, nil
	}
	return result, fmt.Errorf("vzdump ended with %q: %s", exit, lastLines(tail, 8))
}
