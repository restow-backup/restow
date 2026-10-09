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

	running      string
	lastInvent   time.Time
	pveVersion   string
	lastProblems []string
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
	for {
		if err := s.Tick(ctx); err != nil {
			s.Logf("heartbeat: %v", err)
			if IsStatus(err, 401) {
				s.Logf("the Restow server refuses this node's credentials (revoked?)")
			}
		}
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(s.Interval):
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
	problems := s.Problems(ctx)
	s.lastProblems = problems
	state := "idle"
	if s.running != "" {
		state = "running"
	}
	hb, err := s.Server.Heartbeat(ctx, HeartbeatRequest{
		HelperVersion: buildinfo.Version, PVEVersion: s.pveVersion, FleecingStorage: s.State.FleecingStorage,
		PluginLoaded: !contains(problems, "pve.plugin_not_loaded"), State: state, Problems: problems,
		RestoresAllowed: s.State.RestoresAllowed(),
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
	for _, t := range hb.Tasks {
		s.runTask(ctx, t)
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
	for _, r := range res {
		if r.Node != s.State.NodeName {
			continue
		}
		kind := "vm"
		if r.Type == "lxc" {
			kind = "ct"
		}
		g := InventoryGuest{VMID: r.VMID, Kind: kind, Name: r.Name, Node: r.Node, Status: r.Status,
			Template: r.Template == 1, Pool: r.Pool, Tags: splitTags(r.Tags)}
		if conf, err := s.PVE.GuestConfig(ctx, r.Node, kind, r.VMID); err == nil {
			g.Disks = GuestDisks(kind, conf)
			if kind == "ct" {
				g.Privileged = fmt.Sprint(conf["unprivileged"]) != "1"
			} else {
				g.Agent = strings.HasPrefix(fmt.Sprint(conf["agent"]), "1") || strings.Contains(fmt.Sprint(conf["agent"]), "enabled=1")
			}
		}
		guests = append(guests, g)
	}
	return len(guests), s.Server.ReportInventory(ctx, guests)
}

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

type restoreParams struct {
	Volname       string `json:"volname"`
	Kind          string `json:"kind"`
	TargetVMID    int    `json:"targetVmid"`
	TargetStorage string `json:"targetStorage"`
	Pool          string `json:"pool"`
	Start         bool   `json:"start"`
	// RestoreTest deletes the guest again after a successful restore.
	RestoreTest bool `json:"restoreTest"`
}

func (s *Service) runTask(ctx context.Context, t Task) {
	s.running = t.ID
	defer func() { s.running = "" }()
	result, err := s.task(ctx, t)
	status, msg := "done", ""
	if err != nil {
		status, msg = "failed", err.Error()
		s.Logf("task %s (%s) failed: %v", t.ID, t.Kind, err)
	}
	if rerr := s.Server.TaskResult(ctx, t.ID, status, msg, result); rerr != nil {
		s.Logf("task %s: report result: %v", t.ID, rerr)
	}
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
		upid, err := s.PVE.StartBackup(ctx, s.State.NodeName, p.VMID, s.State.StorageID, mode, fleecing)
		if err != nil {
			return nil, err
		}
		s.Logf("backup of %d started: %s", p.VMID, upid)
		exit, err := s.PVE.WaitTask(ctx, s.State.NodeName, upid, 5*time.Second)
		if err != nil {
			return nil, err
		}
		if exit != "OK" {
			tail, _ := s.PVE.TaskLogTail(ctx, s.State.NodeName, upid, 20)
			return map[string]any{"upid": upid}, fmt.Errorf("vzdump ended with %q: %s", exit, lastLines(tail, 8))
		}
		return map[string]any{"upid": upid}, nil
	case "restore":
		if !s.State.RestoresAllowed() {
			return nil, errors.New("restores are switched off on this node")
		}
		var p restoreParams
		if err := json.Unmarshal(t.Params, &p); err != nil || p.Volname == "" || p.TargetStorage == "" {
			return nil, errors.New("invalid restore task")
		}
		if p.Pool == "" {
			p.Pool = "restow-restore"
		}
		vmid := p.TargetVMID
		if vmid == 0 {
			var err error
			if vmid, err = s.PVE.NextID(ctx); err != nil {
				return nil, err
			}
		}
		archive := s.State.StorageID + ":backup/" + strings.TrimPrefix(p.Volname, "backup/")
		upid, err := s.PVE.RestoreGuest(ctx, s.State.NodeName, p.Kind, vmid, archive, p.TargetStorage, p.Pool, p.Start && !p.RestoreTest)
		if err != nil {
			return nil, err
		}
		exit, err := s.PVE.WaitTask(ctx, s.State.NodeName, upid, 5*time.Second)
		result := map[string]any{"vmid": vmid, "upid": upid}
		if err != nil {
			return result, err
		}
		if exit != "OK" {
			tail, _ := s.PVE.TaskLogTail(ctx, s.State.NodeName, upid, 20)
			return result, fmt.Errorf("restore ended with %q: %s", exit, lastLines(tail, 8))
		}
		if p.RestoreTest {
			conf, cerr := s.PVE.GuestConfig(ctx, s.State.NodeName, p.Kind, vmid)
			result["disks"] = len(GuestDisks(p.Kind, conf))
			if dupid, derr := s.PVE.DeleteGuest(ctx, s.State.NodeName, p.Kind, vmid); derr == nil {
				_, _ = s.PVE.WaitTask(ctx, s.State.NodeName, dupid, 5*time.Second)
				result["deleted"] = true
			} else {
				s.Logf("restore test: could not delete guest %d: %v", vmid, derr)
			}
			if cerr != nil {
				return result, fmt.Errorf("the restored guest has no readable configuration: %w", cerr)
			}
		}
		return result, nil
	case "refresh_inventory":
		n, err := s.ReportInventory(ctx)
		return map[string]any{"guests": n}, err
	}
	return nil, fmt.Errorf("unknown task kind %q", t.Kind)
}
