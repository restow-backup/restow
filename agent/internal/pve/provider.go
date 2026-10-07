package pve

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/restow-backup/restow/agent/internal/nbd"
)

// ProviderVerbs are the calls of the storage plugin shim (docs/PVE-PROTOCOL.md).
var ProviderVerbs = []string{
	"job-init", "job-cleanup", "backup-init", "backup-get-mechanism",
	"backup-vm-query-incremental", "backup-vm", "backup-container-prepare",
	"backup-container", "backup-cleanup", "backup-handle-log-file",
	"restore-get-mechanism", "archive-get-guest-config", "archive-get-firewall-config",
	"restore-vm-init", "restore-vm-cleanup", "restore-vm-volume-init",
	"restore-vm-volume-cleanup", "restore-container-init", "restore-container-cleanup",
	"storage-status", "list-volumes", "activate-storage",
}

// ProviderRequest is the JSON object the shim writes to stdin. Fields not
// used by a verb are absent.
type ProviderRequest struct {
	StoreID         string                    `json:"storeid"`
	VMID            int                       `json:"vmid,omitempty"`
	VMType          string                    `json:"vmtype,omitempty"` // qemu | lxc
	StartTime       int64                     `json:"startTime,omitempty"`
	Volumes         map[string]ProviderVolume `json:"volumes,omitempty"`
	GuestConfig     string                    `json:"guestConfig,omitempty"`
	ExcludePatterns []string                  `json:"excludePatterns,omitempty"`
	Info            ProviderInfo              `json:"info"`
	Success         bool                      `json:"success,omitempty"`
	LogFile         string                    `json:"logFile,omitempty"`
	Volname         string                    `json:"volname,omitempty"`
	Device          string                    `json:"device,omitempty"`
}

// ProviderVolume is one disk of backup_vm or backup_vm_query_incremental.
type ProviderVolume struct {
	Size       uint64 `json:"size"`
	BitmapMode string `json:"bitmapMode,omitempty"`
	NBDPath    string `json:"nbdPath,omitempty"`
	NBDExport  string `json:"nbdExport,omitempty"`
	BitmapName string `json:"bitmapName,omitempty"`
}

// ProviderInfo is the $info hash of the PVE call.
type ProviderInfo struct {
	BandwidthLimit uint64   `json:"bandwidthLimit,omitempty"` // bytes per second
	FirewallConfig *string  `json:"firewallConfig,omitempty"`
	Directory      string   `json:"directory,omitempty"`
	Sources        []string `json:"sources,omitempty"`
	BackupUserID   *int     `json:"backupUserId,omitempty"`
	Error          string   `json:"error,omitempty"`
}

// ProviderResponse is what restow-pve writes to stdout.
type ProviderResponse struct {
	OK     bool   `json:"ok"`
	Result any    `json:"result,omitempty"`
	Error  string `json:"error,omitempty"`
}

// Provider runs one shim call.
type Provider struct {
	Layout Layout
	// Log writes "info: ...", "warn: ..." and "err: ..." lines that the shim
	// relays to the PVE task log.
	Log io.Writer
	// Exe is the restow-pve binary, for the detached restore server.
	Exe string
	// Dial opens an NBD export (tests replace it).
	Dial func(ctx context.Context, socket, export string, contexts []string) (BlockSource, func() error, error)
	// state and server are loaded lazily (backup-container runs unprivileged
	// and must not need them).
	state  *State
	server *Server
	now    func() time.Time
}

func (p *Provider) logf(level, format string, args ...any) {
	if p.Log != nil {
		fmt.Fprintf(p.Log, "%s: %s\n", level, fmt.Sprintf(format, args...))
	}
}

func (p *Provider) load() error {
	if p.server != nil {
		return nil
	}
	st, err := LoadState(p.Layout.StateFile)
	if err != nil {
		return err
	}
	if err := st.Validate(); err != nil {
		return err
	}
	srv, err := NewServer(st.URL, st.NodeID, st.NodeSecret, st.AllowInsecureHTTP)
	if err != nil {
		return err
	}
	p.state, p.server = st, srv
	return nil
}

func (p *Provider) clock() time.Time {
	if p.now != nil {
		return p.now()
	}
	return time.Now()
}

// Handle runs a verb.
func (p *Provider) Handle(ctx context.Context, verb string, req ProviderRequest) (any, error) {
	if verb != "backup-container" && verb != "storage-status" && verb != "list-volumes" {
		if err := p.load(); err != nil {
			return nil, err
		}
	}
	switch verb {
	case "activate-storage":
		return map[string]any{}, nil
	case "storage-status":
		return p.storageStatus(), nil
	case "list-volumes":
		return p.listVolumes(req), nil
	case "job-init":
		p.refreshListing(ctx)
		return map[string]any{}, nil
	case "job-cleanup":
		p.cleanupStaleJobs(req.StoreID)
		p.refreshListing(ctx)
		return map[string]any{}, nil
	case "backup-init":
		return p.backupInit(ctx, req)
	case "backup-get-mechanism":
		if req.VMType == "lxc" {
			return map[string]any{"mechanism": "directory"}, nil
		}
		return map[string]any{"mechanism": "nbd"}, nil
	case "backup-vm-query-incremental":
		return p.queryIncremental(ctx, req)
	case "backup-vm":
		return p.backupVM(ctx, req)
	case "backup-container-prepare":
		return p.containerPrepare(ctx, req)
	case "backup-container":
		return p.backupContainer(ctx, req)
	case "backup-cleanup":
		return p.backupCleanup(ctx, req)
	case "backup-handle-log-file":
		return p.handleLogFile(ctx, req)
	case "restore-get-mechanism":
		rp, err := p.server.ResolveVolname(ctx, req.Volname)
		if err != nil {
			return nil, err
		}
		if rp.Kind == "ct" {
			return map[string]any{"mechanism": "directory", "vmtype": "lxc"}, nil
		}
		return map[string]any{"mechanism": "qemu-img", "vmtype": "qemu"}, nil
	case "archive-get-guest-config":
		rp, err := p.server.ResolveVolname(ctx, req.Volname)
		if err != nil {
			return nil, err
		}
		return map[string]any{"config": rp.GuestConfig}, nil
	case "archive-get-firewall-config":
		rp, err := p.server.ResolveVolname(ctx, req.Volname)
		if err != nil {
			return nil, err
		}
		return map[string]any{"config": rp.FirewallConfig}, nil
	case "restore-vm-init":
		rp, err := p.server.ResolveVolname(ctx, req.Volname)
		if err != nil {
			return nil, err
		}
		devices := map[string]any{}
		for _, d := range rp.Devices {
			devices[d.Device] = map[string]any{"size": d.Size}
		}
		return map[string]any{"devices": devices}, nil
	case "restore-vm-volume-init":
		return p.restoreVolumeInit(ctx, req)
	case "restore-vm-volume-cleanup":
		p.stopRestoreServers(req.Volname, req.Device)
		return map[string]any{}, nil
	case "restore-vm-cleanup":
		p.stopRestoreServers(req.Volname, "")
		return map[string]any{}, nil
	case "restore-container-init":
		return p.restoreContainerInit(ctx, req)
	case "restore-container-cleanup":
		p.restoreContainerCleanup(req)
		return map[string]any{}, nil
	}
	return nil, fmt.Errorf("unknown provider verb %q", verb)
}

// --- jobs ----------------------------------------------------------------

type jobState struct {
	RunID       string                       `json:"runId"`
	GuestID     string                       `json:"guestId"`
	ArchiveName string                       `json:"archiveName"`
	Kind        string                       `json:"kind"`
	VMID        int                          `json:"vmid"`
	StoreID     string                       `json:"storeid"`
	Bases       map[string]IncrementalDevice `json:"bases,omitempty"`
	CommitID    string                       `json:"commitId,omitempty"`
	SnapshotID  string                       `json:"snapshotId,omitempty"`
	Committed   bool                         `json:"committed"`
	RunDir      string                       `json:"runDir,omitempty"`
}

func (p *Provider) loadJob(storeid string, vmid int) (*jobState, error) {
	var j jobState
	if err := readJSON(p.Layout.jobFile(storeid, vmid), &j); err != nil {
		return nil, fmt.Errorf("no backup of guest %d is open on this node (backup_init did not run or failed): %w", vmid, err)
	}
	return &j, nil
}

func (p *Provider) saveJob(j *jobState) error {
	if err := os.MkdirAll(filepath.Join(p.Layout.RunDir, "jobs"), 0o700); err != nil {
		return err
	}
	return writeJSONAtomic(p.Layout.jobFile(j.StoreID, j.VMID), j, 0o600)
}

func guestKind(vmtype string) string {
	if vmtype == "lxc" {
		return "ct"
	}
	return "vm"
}

// ArchiveName is the name of a restore point inside the storage:
// "<vm|ct>/<vmid>/<UTC time>", e.g. vm/101/2026-10-03T22:00:00Z. PVE shows
// it as <storeid>:backup/<archive name>.
func ArchiveName(kind string, vmid int, t time.Time) string {
	return fmt.Sprintf("%s/%d/%s", kind, vmid, t.UTC().Format("2006-01-02T15:04:05Z"))
}

var volnameRE = regexp.MustCompile(`^(?:backup/)?(vm|ct)/([0-9]+)/([0-9TZ:-]+)$`)

// ParseVolname splits a PVE volume name of this storage.
func ParseVolname(volname string) (kind string, vmid int, ok bool) {
	m := volnameRE.FindStringSubmatch(volname)
	if m == nil {
		return "", 0, false
	}
	_, err := fmt.Sscan(m[2], &vmid)
	return m[1], vmid, err == nil
}

func (p *Provider) backupInit(ctx context.Context, req ProviderRequest) (any, error) {
	if req.VMID <= 0 {
		return nil, errors.New("backup-init needs a vmid")
	}
	start := p.clock()
	if req.StartTime > 0 {
		start = time.Unix(req.StartTime, 0)
	}
	kind := guestKind(req.VMType)
	name := ArchiveName(kind, req.VMID, start)
	run, err := p.server.OpenRun(ctx, OpenRunRequest{VMID: req.VMID, Kind: kind, ArchiveName: name,
		StorageID: req.StoreID, StartedAt: start.UTC().Format(time.RFC3339), Node: p.state.NodeName})
	if err != nil {
		return nil, fmt.Errorf("open the backup run on the Restow server: %w", err)
	}
	if err := p.saveJob(&jobState{RunID: run.RunID, GuestID: run.GuestID, ArchiveName: name, Kind: kind,
		VMID: req.VMID, StoreID: req.StoreID}); err != nil {
		return nil, err
	}
	p.logf("info", "Restow run %s, archive %s", run.RunID, name)
	return map[string]any{"archiveName": name}, nil
}

// journalEntry records the last committed backup of one disk through one storage.
type journalEntry struct {
	StoreID       string `json:"storeid"`
	SnapshotID    string `json:"snapshotId"`
	Size          uint64 `json:"size"`
	Digest        string `json:"digest"`
	SinceFullRead int    `json:"sinceFullRead"`
}

type journal map[string]journalEntry

func (p *Provider) loadJournal(vmid int) journal {
	j := journal{}
	_ = readJSON(p.Layout.journalFile(vmid), &j)
	return j
}

// VerifyReadEvery forces a full read after this many incremental backups.
const VerifyReadEvery = 30

func (p *Provider) queryIncremental(ctx context.Context, req ProviderRequest) (any, error) {
	job, err := p.loadJob(req.StoreID, req.VMID)
	if err != nil {
		return nil, err
	}
	var devs []DeviceSize
	for name, v := range req.Volumes {
		devs = append(devs, DeviceSize{Device: name, Size: v.Size})
	}
	sort.Slice(devs, func(i, k int) bool { return devs[i].Device < devs[k].Device })
	answer, err := p.server.QueryIncremental(ctx, job.RunID, devs)
	if err != nil {
		return nil, fmt.Errorf("ask the Restow server for the base restore point: %w", err)
	}
	jr := p.loadJournal(req.VMID)
	_, forceErr := os.Stat(p.Layout.forceNewFile(req.VMID))
	forced := forceErr == nil
	job.Bases = map[string]IncrementalDevice{}
	out := map[string]string{}
	for _, d := range answer {
		mode := "new"
		entry, known := jr[d.Device]
		switch {
		case d.Mode != "use":
		case forced:
			p.logf("info", "%s: full read requested (verify read)", d.Device)
		case !known || entry.StoreID != req.StoreID || entry.SnapshotID != d.BaseSnapshotID:
			p.logf("info", "%s: this node's journal does not end at the server's newest restore point, reading the whole disk", d.Device)
		case entry.SinceFullRead >= VerifyReadEvery:
			p.logf("info", "%s: %d incremental backups since the last full read, reading the whole disk (verify read)", d.Device, entry.SinceFullRead)
		default:
			mode = "use"
		}
		if d.BaseSnapshotID != "" {
			if _, err := p.baseHashes(ctx, req.VMID, d); err != nil {
				p.logf("warn", "%s: block list of the base restore point unavailable (%v), reading and uploading the whole disk", d.Device, err)
				mode = "new"
				d.BaseSnapshotID = ""
			}
		}
		job.Bases[d.Device] = d
		out[d.Device] = mode
	}
	if err := p.saveJob(job); err != nil {
		return nil, err
	}
	return map[string]any{"devices": out}, nil
}

// baseHashes returns the cached block list of the base, fetched from the
// server when the cache is missing or does not match the server's digest.
func (p *Provider) baseHashes(ctx context.Context, vmid int, d IncrementalDevice) (*HashList, error) {
	path := p.Layout.hashFile(vmid, d.Device)
	if data, err := os.ReadFile(path); err == nil {
		if h, err := DecodeHashList(data); err == nil && (d.HashesDigest == "" || h.Digest() == d.HashesDigest) {
			return h, nil
		}
	}
	h, err := p.server.BaseHashes(ctx, d.BaseSnapshotID, d.Device)
	if err != nil {
		return nil, err
	}
	if d.HashesDigest != "" && h.Digest() != d.HashesDigest {
		return nil, errors.New("the block list the server sent does not match its digest")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err == nil {
		_ = writeFileAtomic(path, h.Encode(), 0o600)
	}
	return h, nil
}

func newCommitID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	h := hex.EncodeToString(b[:])
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:32]
}

func (p *Provider) dial(ctx context.Context, socket, export string, contexts []string) (BlockSource, func() error, error) {
	if p.Dial != nil {
		return p.Dial(ctx, socket, export, contexts)
	}
	c, err := nbd.Dial(ctx, "unix", socket, nbd.ClientOptions{Export: export, MetaContexts: contexts})
	if err != nil {
		return nil, nil, err
	}
	return c, c.Close, nil
}

func (p *Provider) backupVM(ctx context.Context, req ProviderRequest) (any, error) {
	job, err := p.loadJob(req.StoreID, req.VMID)
	if err != nil {
		return nil, err
	}
	names := make([]string, 0, len(req.Volumes))
	for n := range req.Volumes {
		names = append(names, n)
	}
	sort.Strings(names)
	limit := NewRateLimiter(req.Info.BandwidthLimit)
	var devices []CommitDevice
	results := map[string]*HashList{}
	for _, name := range names {
		v := req.Volumes[name]
		plan := DiskPlan{Device: name, Size: v.Size, BitmapMode: v.BitmapMode, BitmapName: v.BitmapName}
		if b, ok := job.Bases[name]; ok && b.BaseSnapshotID != "" {
			if h, err := p.baseHashes(ctx, req.VMID, b); err == nil {
				plan.Base = h
			} else if v.BitmapMode == "reuse" {
				return nil, fmt.Errorf("%s: block list of the base restore point unavailable: %w", name, err)
			}
		}
		export := v.NBDExport
		if export == "" {
			export = name
		}
		var contexts []string
		if v.BitmapMode == "reuse" {
			contexts = []string{nbd.DirtyBitmapPrefix + v.BitmapName}
		}
		src, closeFn, err := p.dial(ctx, v.NBDPath, export, contexts)
		if err != nil {
			return nil, fmt.Errorf("%s: open the NBD export: %w", name, err)
		}
		p.logf("info", "%s: %d GiB, bitmap mode %s", name, v.Size>>30, v.BitmapMode)
		res, err := BackupDisk(ctx, src, p.server, job.RunID, plan, limit, func(f string, a ...any) { p.logf("info", f, a...) })
		_ = closeFn()
		if err != nil {
			return nil, err
		}
		devices = append(devices, res.CommitDevice)
		results[name] = res.Hashes
	}
	// The commit id is stored before the commit is sent: a retry after a
	// lost answer asks for the same commit, which the server answers with
	// the snapshot it already made.
	job.CommitID = newCommitID()
	if err := p.saveJob(job); err != nil {
		return nil, err
	}
	commit, err := p.server.Commit(ctx, job.RunID, CommitRequest{CommitID: job.CommitID, Devices: devices,
		GuestConfig: req.GuestConfig, FirewallConfig: req.Info.FirewallConfig})
	if err != nil {
		// Unknown outcome: dying lets QEMU merge the bitmap back; the next
		// run reads the whole disk if the server did commit (journal mismatch).
		return nil, fmt.Errorf("commit the restore point: %w", err)
	}
	job.SnapshotID, job.Committed = commit.SnapshotID, true
	_ = p.saveJob(job)
	jr := p.loadJournal(req.VMID)
	for _, d := range devices {
		h := results[d.Device]
		digest := h.Digest()
		if want := commit.HashesDigests[d.Device]; want != "" && want != digest {
			p.logf("warn", "%s: the server's block list differs from this node's; it is fetched again next time", d.Device)
			_ = os.Remove(p.Layout.hashFile(req.VMID, d.Device))
			digest = want
		} else {
			path := p.Layout.hashFile(req.VMID, d.Device)
			if err := os.MkdirAll(filepath.Dir(path), 0o700); err == nil {
				_ = writeFileAtomic(path, h.Encode(), 0o600)
			}
		}
		since := jr[d.Device].SinceFullRead + 1
		if d.BitmapMode != "reuse" {
			since = 0
		}
		jr[d.Device] = journalEntry{StoreID: req.StoreID, SnapshotID: commit.SnapshotID, Size: d.Size, Digest: digest, SinceFullRead: since}
	}
	if err := os.MkdirAll(filepath.Dir(p.Layout.journalFile(req.VMID)), 0o700); err == nil {
		_ = writeJSONAtomic(p.Layout.journalFile(req.VMID), jr, 0o600)
	}
	_ = os.Remove(p.Layout.forceNewFile(req.VMID))
	p.logf("info", "restore point %s committed", commit.SnapshotID)
	return map[string]any{"snapshotId": commit.SnapshotID}, nil
}

func (p *Provider) backupCleanup(ctx context.Context, req ProviderRequest) (any, error) {
	job, err := p.loadJob(req.StoreID, req.VMID)
	if err != nil {
		return map[string]any{"stats": map[string]any{"archiveSize": 0}}, nil
	}
	var size uint64
	var cerr error
	if job.Kind == "ct" && req.Success && !job.Committed {
		size, cerr = p.commitContainer(ctx, job)
	}
	status, msg := "succeeded", ""
	switch {
	case cerr != nil:
		status, msg = "failed", cerr.Error()
	case !req.Success:
		status, msg = "failed", req.Info.Error
		if job.Committed {
			msg = strings.TrimSpace(msg + " (the restore point was committed before and is kept)")
		}
	case !job.Committed:
		status, msg = "failed", "the backup ended without a committed restore point"
	}
	if err := p.server.FinishRun(ctx, job.RunID, status, msg, map[string]any{"archiveSize": size}); err != nil {
		p.logf("warn", "could not report the end of the run: %v", err)
	}
	if job.RunDir != "" {
		_ = os.RemoveAll(job.RunDir)
		_ = os.Remove(p.ctPointer(job.StoreID, job.VMID))
	}
	if cerr != nil {
		return nil, cerr
	}
	return map[string]any{"stats": map[string]any{"archiveSize": size}}, nil
}

func (p *Provider) handleLogFile(ctx context.Context, req ProviderRequest) (any, error) {
	job, err := p.loadJob(req.StoreID, req.VMID)
	if err == nil {
		if data, err := readTail(req.LogFile, 64<<10); err == nil {
			if err := p.server.RunLog(ctx, job.RunID, string(data)); err != nil {
				p.logf("warn", "could not upload the task log: %v", err)
			}
		}
		_ = os.Remove(p.Layout.jobFile(req.StoreID, req.VMID))
	}
	return map[string]any{}, nil
}

func readTail(path string, n int64) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if st.Size() > n {
		if _, err := f.Seek(st.Size()-n, io.SeekStart); err != nil {
			return nil, err
		}
	}
	return io.ReadAll(io.LimitReader(f, n))
}

func (p *Provider) cleanupStaleJobs(storeid string) {
	dir := filepath.Join(p.Layout.RunDir, "jobs")
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if !strings.HasPrefix(e.Name(), storeid+"-") {
			continue
		}
		if info, err := e.Info(); err == nil && time.Since(info.ModTime()) > 48*time.Hour {
			_ = os.Remove(filepath.Join(dir, e.Name()))
		}
	}
}

// --- storage plugin caches ---------------------------------------------------

// StatusCache is what storage-status answers, maintained by the service.
type StatusCache struct {
	Total  uint64 `json:"total"`
	Used   uint64 `json:"used"`
	Avail  uint64 `json:"avail"`
	Active bool   `json:"active"`
}

func (p *Provider) storageStatus() StatusCache {
	var s StatusCache
	if err := readJSON(p.Layout.StatusCache(), &s); err != nil {
		// Not known yet: active with a nominal size, never blocking.
		return StatusCache{Total: 1 << 40, Avail: 1 << 40, Active: true}
	}
	return s
}

func (p *Provider) listVolumes(req ProviderRequest) map[string]any {
	var all []Listing
	_ = readJSON(p.Layout.VolumesCache(), &all)
	out := []map[string]any{}
	for _, l := range all {
		if req.VMID > 0 && l.VMID != req.VMID {
			continue
		}
		subtype := "qemu"
		if l.Kind == "ct" {
			subtype = "lxc"
		}
		out = append(out, map[string]any{
			"volname": "backup/" + l.Volname, "vmid": l.VMID, "ctime": l.CTime, "size": l.Size,
			"subtype": subtype, "format": "restow-" + l.Kind,
		})
	}
	return map[string]any{"volumes": out}
}

func (p *Provider) refreshListing(ctx context.Context) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if l, err := p.server.Listings(ctx); err == nil {
		_ = os.MkdirAll(filepath.Dir(p.Layout.VolumesCache()), 0o755)
		_ = writeJSONAtomic(p.Layout.VolumesCache(), l, 0o644)
	}
}
