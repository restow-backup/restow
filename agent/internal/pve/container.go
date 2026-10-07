package pve

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
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
	SnapshotID  string  `json:"snapshotId"`
	BytesAdded  uint64  `json:"bytesAdded"`
	TotalBytes  uint64  `json:"totalBytes"`
	Root        string  `json:"root"`
	GuestConfig string  `json:"guestConfig"`
	Firewall    *string `json:"firewallConfig,omitempty"`
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
	args := []string{"backup", "--json", "--no-scan", "--host", fmt.Sprintf("pve-ct-%d", req.VMID),
		"--tag", fmt.Sprintf("vmid=%d", req.VMID), "--tag", "run=" + creds.RunID,
		"--cache-dir", filepath.Join(pointer.RunDir, "cache")}
	for _, ex := range req.ExcludePatterns {
		if e := ExcludeToRestic(dir, ex); e != "" {
			args = append(args, "--exclude", e)
		}
	}
	if req.Info.BandwidthLimit > 0 {
		args = append(args, "--limit-upload", fmt.Sprint(max(1, req.Info.BandwidthLimit/1024)))
	}
	args = append(args, "--")
	args = append(args, sources...)
	cmd := exec.CommandContext(ctx, creds.Restic, args...)
	cmd.Dir = dir
	cmd.Env = resticEnv(&creds.ResticAccess)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("restic backup failed: %v: %s", err, lastLines(stderr.String(), 10))
	}
	res := ctResult{Root: dir, GuestConfig: req.GuestConfig, Firewall: req.Info.FirewallConfig}
	sc := bufio.NewScanner(bytes.NewReader(out))
	sc.Buffer(make([]byte, 1<<20), 1<<20)
	for sc.Scan() {
		var m struct {
			MessageType string `json:"message_type"`
			SnapshotID  string `json:"snapshot_id"`
			DataAdded   uint64 `json:"data_added"`
			TotalBytes  uint64 `json:"total_bytes_processed"`
		}
		if json.Unmarshal(sc.Bytes(), &m) == nil && m.MessageType == "summary" {
			res.SnapshotID, res.BytesAdded, res.TotalBytes = m.SnapshotID, m.DataAdded, m.TotalBytes
		}
	}
	if res.SnapshotID == "" {
		return nil, errors.New("restic reported no snapshot")
	}
	data, _ := json.Marshal(res)
	if err := os.WriteFile(filepath.Join(pointer.RunDir, "result.json"), data, 0o600); err != nil {
		return nil, err
	}
	p.logf("info", "restic snapshot %s, %d MiB added", res.SnapshotID, res.BytesAdded>>20)
	return map[string]any{}, nil
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
		ResticTotalBytes: res.TotalBytes, ResticRoot: res.Root})
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
