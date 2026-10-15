package pve

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// Container backups go through restic into one repository per guest that the
// Restow server exposes append-only (docs/PROXMOX.md 2.5). backup_container
// runs as the ID-mapped container root (for example uid 100000) in a forked
// process, so everything it needs is prepared by backup_container_prepare
// (root) in a run folder owned by that uid: the per-run restic credential,
// which expires with the run, and the repository password.

type ctCredentials struct {
	ResticAccess
	RunID  string `json:"runId"`
	VMID   int    `json:"vmid"`
	Restic string `json:"restic"`
}

type ctResult struct {
	SnapshotID string `json:"snapshotId"`
	// Unreadable counts the items restic could not read (exit 3: the snapshot
	// exists but misses them); Remark names the first of them for the run.
	Unreadable int    `json:"unreadable,omitempty"`
	Remark     string `json:"remark,omitempty"`
	// UnreadablePaths names the first unreadable items for the restore point.
	UnreadablePaths []string `json:"unreadablePaths,omitempty"`
	BytesAdded      uint64   `json:"bytesAdded"`
	TotalBytes      uint64   `json:"totalBytes"`
	Root            string   `json:"root"`
	GuestConfig     string   `json:"guestConfig"`
	Firewall        *string  `json:"firewallConfig,omitempty"`
}

func (p *Provider) ctPointer(storeid string, vmid int) string {
	return filepath.Join(p.Layout.RunDir, fmt.Sprintf("ct-%s-%d.json", storeid, vmid))
}

func (p *Provider) resticBinary() string {
	if v := os.Getenv("RESTOW_PVE_RESTIC"); v != "" {
		return v
	}
	return filepath.Join(p.Layout.BinDir, "restic")
}

func (p *Provider) containerPrepare(ctx context.Context, req ProviderRequest) (any, error) {
	job, err := p.loadJob(req.StoreID, req.VMID)
	if err != nil {
		return nil, err
	}
	access, err := p.server.RunRestic(ctx, job.RunID)
	if err != nil {
		return nil, fmt.Errorf("get the restic credential of this run: %w", err)
	}
	uid := 0
	if req.Info.BackupUserID != nil {
		uid = *req.Info.BackupUserID
	}
	if err := os.MkdirAll(p.Layout.RunDir, 0o711); err != nil {
		return nil, err
	}
	_ = os.Chmod(p.Layout.RunDir, 0o711)
	runDir := filepath.Join(p.Layout.RunDir, "run-"+job.RunID)
	if err := os.MkdirAll(filepath.Join(runDir, "cache"), 0o700); err != nil {
		return nil, err
	}
	creds := ctCredentials{ResticAccess: *access, RunID: job.RunID, VMID: req.VMID, Restic: p.resticBinary()}
	data, _ := json.Marshal(creds)
	if err := os.WriteFile(filepath.Join(runDir, "credentials.json"), data, 0o400); err != nil {
		return nil, err
	}
	for _, path := range []string{runDir, filepath.Join(runDir, "cache"), filepath.Join(runDir, "credentials.json")} {
		if err := os.Chown(path, uid, -1); err != nil {
			return nil, fmt.Errorf("hand the run folder to uid %d: %w", uid, err)
		}
	}
	pointer, _ := json.Marshal(map[string]string{"runDir": runDir})
	if err := os.WriteFile(p.ctPointer(req.StoreID, req.VMID), pointer, 0o444); err != nil {
		return nil, err
	}
	_ = os.Chmod(p.ctPointer(req.StoreID, req.VMID), 0o444)
	job.RunDir = runDir
	return map[string]any{}, p.saveJob(job)
}

// ExcludeToRestic turns a vzdump exclude pattern into a restic --exclude
// pattern. vzdump patterns are shell globs; an absolute one is relative to
// the container root, which is the backup folder here.
func ExcludeToRestic(root, pattern string) string {
	pattern = strings.TrimSpace(pattern)
	if pattern == "" {
		return ""
	}
	if strings.HasPrefix(pattern, "/") {
		return filepath.Join(root, pattern)
	}
	return pattern
}

func (p *Provider) backupContainer(ctx context.Context, req ProviderRequest) (any, error) {
	var pointer struct {
		RunDir string `json:"runDir"`
	}
	if err := readJSON(p.ctPointer(req.StoreID, req.VMID), &pointer); err != nil {
		return nil, fmt.Errorf("the container backup was not prepared: %w", err)
	}
	var creds ctCredentials
	if err := readJSON(filepath.Join(pointer.RunDir, "credentials.json"), &creds); err != nil {
		return nil, err
	}
	dir := req.Info.Directory
	if dir == "" {
		return nil, errors.New("PVE passed no backup directory")
	}
	sources := req.Info.Sources
	if len(sources) == 0 {
		sources = []string{"."}
	}
	args := containerBackupArgs(dir, sources, req.ExcludePatterns, req.VMID, creds.RunID,
		filepath.Join(pointer.RunDir, "cache"), req.Info.BandwidthLimit)
	cmd := exec.CommandContext(ctx, creds.Restic, args...)
	cmd.Dir = dir
	cmd.Env = resticEnv(&creds.ResticAccess)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("restic backup failed: %w", err)
	}
	reporter := StartProgress(ctx, intervalSeconds(creds.ProgressIntervalSeconds),
		newRunCredentialSender(creds.ProgressURL, creds.Username, creds.Password))
	res := ctResult{Root: dir, GuestConfig: req.GuestConfig, Firewall: req.Info.FirewallConfig}
	// restic's other lines (older versions report unreadable items on stdout).
	others := readResticBackupOutput(stdout, &res, reporter)
	err = cmd.Wait()
	reporter.Stop()
	// Exit 3: restic wrote the snapshot but could not read some items. The
	// restore point is kept and the run says what is missing; any other
	// failure fails the backup.
	incomplete := false
	if err != nil {
		var exitErr *exec.ExitError
		if !errors.As(err, &exitErr) || exitErr.ExitCode() != resticExitIncomplete {
			return nil, fmt.Errorf("restic backup failed: %v: %s", err, lastLines(stderr.String(), 10))
		}
		incomplete = true
	}
	if res.SnapshotID == "" {
		if incomplete {
			return nil, fmt.Errorf("restic backup failed: exit status 3 without a snapshot: %s", lastLines(stderr.String(), 10))
		}
		return nil, errors.New("restic reported no snapshot")
	}
	if incomplete {
		items := unreadableItems(stderr.Bytes(), others)
		res.Unreadable = len(items)
		res.UnreadablePaths = items[:min(len(items), maxReportedUnreadable)]
		for i, item := range items {
			if i == maxLoggedUnreadable {
				p.logf("warn", "... and %d more", len(items)-maxLoggedUnreadable)
				break
			}
			p.logf("warn", "could not read %s", item)
		}
		res.Remark = unreadableRemark(items)
		p.logf("warn", "%s", res.Remark)
	}
	data, _ := json.Marshal(res)
	if err := os.WriteFile(filepath.Join(pointer.RunDir, "result.json"), data, 0o600); err != nil {
		return nil, err
	}
	p.logf("info", "restic snapshot %s, %d MiB added", res.SnapshotID, res.BytesAdded>>20)
	return map[string]any{}, nil
}

// resticExitIncomplete is restic's exit code for a snapshot that was written
// although some source items could not be read.
const resticExitIncomplete = 3

// maxLoggedUnreadable bounds the unreadable items named in the PVE task log.
const maxLoggedUnreadable = 20

// maxReportedUnreadable bounds the unreadable items the restore point names.
const maxReportedUnreadable = 20

// readResticBackupOutput reads `restic backup --json` while it runs: the
// status lines become progress (bytes read of the total restic's scan
// found), the summary goes into res, and every other line is returned.
func readResticBackupOutput(r io.Reader, res *ctResult, reporter *ProgressReporter) []byte {
	var others bytes.Buffer
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 1<<20), 1<<20)
	for sc.Scan() {
		var m struct {
			MessageType string `json:"message_type"`
			SnapshotID  string `json:"snapshot_id"`
			DataAdded   uint64 `json:"data_added"`
			TotalBytes  uint64 `json:"total_bytes_processed"`
			BytesDone   uint64 `json:"bytes_done"`
			StatusTotal uint64 `json:"total_bytes"`
		}
		line := sc.Bytes()
		if json.Unmarshal(line, &m) != nil {
			others.Write(line)
			others.WriteByte('\n')
			continue
		}
		switch m.MessageType {
		case "status":
			p := Progress{BytesDone: m.BytesDone}
			// Without a finished scan restic does not know the total yet.
			if m.StatusTotal > 0 {
				p.BytesTotal = uint64Ptr(m.StatusTotal)
			}
			reporter.Set(p)
		case "summary":
			res.SnapshotID, res.BytesAdded, res.TotalBytes = m.SnapshotID, m.DataAdded, m.TotalBytes
		default:
			others.Write(line)
			others.WriteByte('\n')
		}
	}
	// Drain what is left, so restic never blocks on a full pipe.
	_, _ = io.Copy(io.Discard, r)
	return others.Bytes()
}

// containerBackupArgs is the restic command line of a container backup. Each
// source is the root of one file system (the root fs and every mount point);
// its lost+found is left out: on ext4 it belongs to the host's root, which an
// unprivileged container's ID map does not include, so the mapped root cannot
// read it (vzdump's own archives leave it out for the same reason).
func containerBackupArgs(dir string, sources, excludes []string, vmid int, runID, cacheDir string, bwlimitKiB uint64) []string {
	// No --no-scan: restic's scan gives the total its progress needs (#51).
	args := []string{"backup", "--json", "--host", fmt.Sprintf("pve-ct-%d", vmid),
		"--tag", fmt.Sprintf("vmid=%d", vmid), "--tag", "run=" + runID,
		"--cache-dir", cacheDir}
	for _, ex := range excludes {
		if e := ExcludeToRestic(dir, ex); e != "" {
			args = append(args, "--exclude", e)
		}
	}
	for _, src := range sources {
		args = append(args, "--exclude", filepath.Join(dir, src, "lost+found"))
	}
	if bwlimitKiB > 0 {
		args = append(args, "--limit-upload", fmt.Sprint(max(1, bwlimitKiB/1024)))
	}
	args = append(args, "--")
	return append(args, sources...)
}

// unreadableItems lists the items restic reported as unreadable (JSON
// message_type "error"), from stderr (restic 0.19) and stdout (older restic),
// each once, in restic's order.
func unreadableItems(streams ...[]byte) []string {
	var items []string
	seen := map[string]bool{}
	for _, stream := range streams {
		sc := bufio.NewScanner(bytes.NewReader(stream))
		sc.Buffer(make([]byte, 1<<20), 1<<20)
		for sc.Scan() {
			var m struct {
				MessageType string `json:"message_type"`
				Item        string `json:"item"`
				Error       struct {
					Message string `json:"message"`
				} `json:"error"`
			}
			if json.Unmarshal(sc.Bytes(), &m) != nil || m.MessageType != "error" {
				continue
			}
			item := m.Item
			if item == "" {
				item = m.Error.Message
			}
			if item != "" && !seen[item] {
				seen[item] = true
				items = append(items, item)
			}
		}
	}
	return items
}

// unreadableRemark is the one line the restore point records about what it misses.
func unreadableRemark(items []string) string {
	switch len(items) {
	case 0:
		return "restic could not read some items; the restore point is incomplete"
	case 1:
		return fmt.Sprintf("restic could not read 1 item (%s); the restore point is incomplete", items[0])
	default:
		return fmt.Sprintf("restic could not read %d items (first: %s); the restore point is incomplete", len(items), items[0])
	}
}

func resticEnv(a *ResticAccess) []string {
	env := []string{"PATH=/usr/sbin:/usr/bin:/sbin:/bin", "HOME=/nonexistent",
		"RESTIC_REPOSITORY=rest:" + a.RepositoryURL,
		"RESTIC_REST_USERNAME=" + a.Username, "RESTIC_REST_PASSWORD=" + a.Password,
		"RESTIC_PASSWORD=" + a.RepositoryPassword}
	for _, k := range []string{"HTTPS_PROXY", "https_proxy", "NO_PROXY", "no_proxy", "SSL_CERT_FILE"} {
		if v := os.Getenv(k); v != "" {
			env = append(env, k+"="+v)
		}
	}
	return env
}

func lastLines(s string, n int) string {
	lines := strings.Split(strings.TrimSpace(s), "\n")
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return strings.Join(lines, " | ")
}

func (p *Provider) commitContainer(ctx context.Context, job *jobState) (uint64, error) {
	var res ctResult
	if err := readJSON(filepath.Join(job.RunDir, "result.json"), &res); err != nil {
		return 0, fmt.Errorf("the container backup left no result: %w", err)
	}
	if job.CommitID == "" {
		job.CommitID = newCommitID()
		if err := p.saveJob(job); err != nil {
			return 0, err
		}
	}
	commit, err := p.server.Commit(ctx, job.RunID, CommitRequest{CommitID: job.CommitID, GuestConfig: res.GuestConfig,
		FirewallConfig: res.Firewall, ResticSnapshotID: res.SnapshotID, ResticBytesAdded: res.BytesAdded,
		ResticTotalBytes: res.TotalBytes, ResticRoot: res.Root,
		ConsistencyRemark: res.Remark, ResticUnreadable: res.Unreadable,
		ResticUnreadablePaths: res.UnreadablePaths})
	if err != nil {
		return 0, fmt.Errorf("commit the restore point: %w", err)
	}
	job.SnapshotID, job.Committed = commit.SnapshotID, true
	_ = p.saveJob(job)
	p.logf("info", "restore point %s committed", commit.SnapshotID)
	return res.TotalBytes, nil
}

func (p *Provider) restoreTmpDir() string {
	if p.state != nil && p.state.RestoreTmpDir != "" {
		return p.state.RestoreTmpDir
	}
	return p.Layout.RestoreTmp
}

func restoreDirFor(base, volname string) string {
	safe := strings.NewReplacer("/", "_", ":", "-").Replace(volname)
	return filepath.Join(base, "ct-"+safe)
}

func (p *Provider) restoreContainerInit(ctx context.Context, req ProviderRequest) (any, error) {
	if !p.state.RestoresAllowed() {
		return nil, errors.New("restores are switched off on this node (restow-pve config --allow-restores=false)")
	}
	rp, err := p.server.ResolveVolname(ctx, req.Volname)
	if err != nil {
		return nil, err
	}
	if rp.Kind != "ct" || rp.ResticSnapshot == "" {
		return nil, errors.New("not a container restore point")
	}
	access, err := p.server.RestoreRestic(ctx, rp.SnapshotID)
	if err != nil {
		return nil, err
	}
	target := restoreDirFor(p.restoreTmpDir(), req.Volname)
	_ = os.RemoveAll(target)
	if err := os.MkdirAll(target, 0o700); err != nil {
		return nil, err
	}
	// The sources were relative to the backup folder ("." and the mount
	// points), so the snapshot's tree is the container root itself.
	cmd := exec.CommandContext(ctx, p.resticBinary(), "restore", rp.ResticSnapshot, "--target", target, "--no-cache")
	cmd.Env = resticEnv(access)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		_ = os.RemoveAll(target)
		return nil, fmt.Errorf("restic restore failed: %v: %s", err, lastLines(stderr.String(), 10))
	}
	p.logf("info", "restore point unpacked to %s", target)
	return map[string]any{"archiveDirectory": target}, nil
}

func (p *Provider) restoreContainerCleanup(req ProviderRequest) {
	_ = os.RemoveAll(restoreDirFor(p.restoreTmpDir(), req.Volname))
}
