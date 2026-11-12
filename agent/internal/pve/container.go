//go:build !windows

package pve

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"syscall"
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
	// BytesAddedPacked is what restic stored for the new data, compressed.
	BytesAddedPacked uint64 `json:"bytesAddedPacked,omitempty"`
	TotalBytes       uint64 `json:"totalBytes"`
	// Restic's file counts, for the ransomware signals of the server.
	FilesNew     uint64  `json:"filesNew,omitempty"`
	FilesChanged uint64  `json:"filesChanged,omitempty"`
	FilesTotal   uint64  `json:"filesTotal,omitempty"`
	Root         string  `json:"root"`
	GuestConfig  string  `json:"guestConfig"`
	Firewall     *string `json:"firewallConfig,omitempty"`
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
	if err := os.MkdirAll(runDir, 0o700); err != nil {
		return nil, err
	}
	creds := ctCredentials{ResticAccess: *access, RunID: job.RunID, VMID: req.VMID, Restic: p.resticBinary()}
	data, _ := json.Marshal(creds)
	if err := os.WriteFile(filepath.Join(runDir, "credentials.json"), data, 0o400); err != nil {
		return nil, err
	}
	// The provider's record (cancel.go): backup_container cannot create files where root's are.
	if err := os.WriteFile(ctProviderPIDFile(runDir, req.VMID), nil, 0o600); err != nil {
		return nil, err
	}
	for _, path := range []string{runDir, filepath.Join(runDir, "credentials.json"), ctProviderPIDFile(runDir, req.VMID)} {
		if err := os.Chown(path, uid, -1); err != nil {
			return nil, fmt.Errorf("hand the run folder to uid %d: %w", uid, err)
		}
	}
	cacheDir, note := p.prepareContainerCache(req.VMID, uid)
	if note != "" {
		p.logf("info", "%s", note)
	}
	// The mount point of a copy's stable folder (containerBackupRoot); only the backup's own
	// mount namespace mounts anything on it.
	if err := os.MkdirAll(p.Layout.ctStableRoot(req.VMID), 0o711); err != nil {
		return nil, err
	}
	pointer, _ := json.Marshal(map[string]string{"runDir": runDir, "cacheDir": cacheDir})
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
		// CacheDir is the guest's restic cache; "" runs restic with --no-cache.
		CacheDir string `json:"cacheDir"`
	}
	// The pointer stays open while the backup runs: the service tells this guest's provider
	// by it (holdsPointer, cancel.go).
	pf, err := os.Open(p.ctPointer(req.StoreID, req.VMID))
	if err == nil {
		defer pf.Close()
		err = json.NewDecoder(pf).Decode(&pointer)
	}
	if err != nil {
		return nil, fmt.Errorf("the container backup was not prepared: %w", err)
	}
	// This call's lines go to the run folder; backup_cleanup folds them into the job's log.
	p.taskLog = ctTaskLog(pointer.RunDir)
	done, err := markProvider(ctProviderPIDFile(pointer.RunDir, req.VMID))
	if err != nil {
		p.logf("info", "this backup cannot be stopped from Restow: %v", err)
	}
	defer done()
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
	mounts := backupMountPoints(req.GuestConfig)
	stable, copied := containerBackupRoot(p.Layout, dir, req.VMID)
	var cmd *exec.Cmd
	var stdout io.ReadCloser
	errs := &resticErrors{}
	stderr := errs.stderr()
	root, err := p.startContainerRestic(dir, stable, copied, func(root string) error {
		args := containerBackupArgs(root, sources, mounts, req.ExcludePatterns, req.VMID, creds.RunID,
			pointer.CacheDir, req.Info.BandwidthLimit, copied)
		cmd = exec.CommandContext(ctx, creds.Restic, args...)
		cmd.Dir = root
		cmd.Env = resticEnv(&creds.ResticAccess)
		cmd.Stderr = stderr
		stopResticGently(cmd)
		var err error
		if stdout, err = cmd.StdoutPipe(); err != nil {
			return err
		}
		return cmd.Start()
	})
	if err != nil {
		return nil, fmt.Errorf("restic backup failed: %w", err)
	}
	reporter := StartProgress(ctx, intervalSeconds(creds.ProgressIntervalSeconds),
		newRunCredentialSender(creds.ProgressURL, creds.Username, creds.Password))
	res := ctResult{Root: root, GuestConfig: req.GuestConfig, Firewall: req.Info.FirewallConfig}
	// restic's other lines (older versions report unreadable items on stdout).
	readResticBackupOutput(stdout, &res, reporter, errs)
	err = cmd.Wait()
	stderr.Flush()
	reporter.Stop()
	// Exit 3: restic wrote the snapshot but could not read some items. The
	// restore point is kept and the run says what is missing; any other
	// failure fails the backup.
	incomplete := false
	if err != nil {
		var exitErr *exec.ExitError
		if !errors.As(err, &exitErr) || exitErr.ExitCode() != resticExitIncomplete {
			return nil, fmt.Errorf("restic backup failed: %v: %s", err, errs.lastLines(10))
		}
		incomplete = true
	}
	if res.SnapshotID == "" {
		if incomplete {
			return nil, fmt.Errorf("restic backup failed: exit status 3 without a snapshot: %s", errs.lastLines(10))
		}
		return nil, errors.New("restic reported no snapshot")
	}
	if incomplete {
		count, items := errs.result()
		res.Unreadable = count
		res.UnreadablePaths = items[:min(len(items), maxReportedUnreadable)]
		for i, item := range items {
			if i == maxLoggedUnreadable {
				break
			}
			p.logf("warn", "could not read %s", item)
		}
		if logged := min(len(items), maxLoggedUnreadable); count > logged {
			p.logf("warn", "... and %d more", count-logged)
		}
		res.Remark = unreadableRemark(count, items)
		p.logf("warn", "%s", res.Remark)
	}
	data, _ := json.Marshal(res)
	if err := os.WriteFile(filepath.Join(pointer.RunDir, "result.json"), data, 0o600); err != nil {
		return nil, err
	}
	p.logf("info", "restic snapshot %s, %d MiB added", res.SnapshotID, res.BytesAdded>>20)
	return map[string]any{}, nil
}

// ctCacheMinFree is the free space the cache's file system needs, or restic runs without a cache.
const ctCacheMinFree = 1 << 30

// ctCacheDir is the restic cache of a container, kept between its backups.
func (l Layout) ctCacheDir(vmid int) string {
	if l.CacheDir == "" {
		return ""
	}
	return filepath.Join(l.CacheDir, fmt.Sprintf("ct-%d", vmid))
}

// prepareContainerCache hands the container's restic cache to the uid its backup runs as
// (the mapped container root) and returns it, or "" for --no-cache with the reason. The cache
// stays between backups, so restic does not download the repository's index and the parent's
// trees again on every run, and it lives on disk, not in /run (a tmpfs of a tenth of the RAM).
// After a change of the ID map the cache is handed to the new uid; links in it are never
// followed.
func (p *Provider) prepareContainerCache(vmid, uid int) (string, string) {
	dir := p.Layout.ctCacheDir(vmid)
	if dir == "" {
		return "", ""
	}
	if err := os.MkdirAll(p.Layout.CacheDir, 0o711); err != nil {
		return "", fmt.Sprintf("restic runs without a cache: %v", err)
	}
	_ = os.Chmod(p.Layout.CacheDir, 0o711)
	if _, avail, err := statfs(p.Layout.CacheDir); err == nil && avail < ctCacheMinFree {
		return "", fmt.Sprintf("restic runs without a cache: %s has %s free (it needs %s)", p.Layout.CacheDir, gbString(avail), gbString(ctCacheMinFree))
	}
	if st, err := os.Lstat(dir); err == nil && !st.IsDir() {
		_ = os.Remove(dir)
	}
	if err := os.Mkdir(dir, 0o700); err != nil && !errors.Is(err, os.ErrExist) {
		return "", fmt.Sprintf("restic runs without a cache: %v", err)
	}
	st, err := os.Lstat(dir)
	if err != nil {
		return "", fmt.Sprintf("restic runs without a cache: %v", err)
	}
	if sys, ok := st.Sys().(*syscall.Stat_t); ok && int(sys.Uid) != uid {
		err := filepath.WalkDir(dir, func(path string, _ os.DirEntry, err error) error {
			if err != nil {
				return err
			}
			return os.Lchown(path, uid, -1)
		})
		if err != nil {
			return "", fmt.Sprintf("restic runs without a cache: hand %s to uid %d: %v", dir, uid, err)
		}
	}
	_ = os.Chmod(dir, 0o700)
	return dir, ""
}

// pruneContainerCaches removes the restic caches of containers that are not on this node
// (any more): removed, or migrated to another node.
func pruneContainerCaches(l Layout, here map[int]bool) {
	if l.CacheDir == "" {
		return
	}
	entries, _ := os.ReadDir(l.CacheDir)
	for _, e := range entries {
		rest, ok := strings.CutPrefix(e.Name(), "ct-")
		vmid, err := strconv.Atoi(rest)
		if !ok || err != nil || here[vmid] {
			continue
		}
		_ = os.RemoveAll(filepath.Join(l.CacheDir, e.Name()))
	}
}

// vzsnapDir is where vzdump mounts a container's snapshot (snapshot mode): the same path on
// every run, with the container's own file systems below it (tests point it elsewhere).
var vzsnapDir = "/mnt/vzsnap0"

// ctStableRoot is the folder a container's copy is backed up through (containerBackupRoot).
func (l Layout) ctStableRoot(vmid int) string {
	return filepath.Join(l.RunDir, fmt.Sprintf("ctroot-%d", vmid))
}

// containerBackupRoot is the folder restic backs a container up from. In snapshot mode it is
// PVE's snapshot mount. In suspend and stop mode PVE hands over a copy in a folder that is new
// on every run (/var/tmp/vzdumptmp<pid>_<vmid>): restic chooses the parent snapshot by host and
// path, so it never found one and read and hashed the whole container every time, and every
// file counted as new for the change rate. Such a copy (copied) is backed up through the
// stable folder instead, the same on every run; its files are new inodes with a new ctime, so
// restic compares them by size and mtime only (rsync keeps both).
func containerBackupRoot(l Layout, dir string, vmid int) (stable string, copied bool) {
	if filepath.Clean(dir) == filepath.Clean(vzsnapDir) {
		return dir, false
	}
	return l.ctStableRoot(vmid), true
}

// bindStableRoot bind-mounts a copy onto the stable folder, for the calling thread only
// (tests replace it).
var bindStableRoot = bindPrivate

// startContainerRestic runs start (which starts restic in the folder it gets) in the folder
// containerBackupRoot chose and returns that folder. A copy is first bind-mounted onto the
// stable folder in a mount namespace of a thread of its own, which restic inherits; when that
// is not possible (no mount namespace for PVE's user namespace), restic runs in dir as before
// and the line says why.
func (p *Provider) startContainerRestic(dir, stable string, copied bool, start func(root string) error) (string, error) {
	if !copied {
		return dir, start(dir)
	}
	type result struct{ bindErr, err error }
	ch := make(chan result, 1)
	go func() {
		// Never unlocked: the thread and its mount namespace end with this goroutine.
		runtime.LockOSThread()
		if err := bindStableRoot(dir, stable); err != nil {
			ch <- result{bindErr: err}
			return
		}
		ch <- result{err: start(stable)}
	}()
	r := <-ch
	if r.bindErr == nil {
		return stable, r.err
	}
	p.logf("info", "backing up %s directly (%v): restic finds no earlier backup of this copy and reads all of it", dir, r.bindErr)
	return dir, start(dir)
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
// found), the summary goes into res, and every other line goes to errs (older
// restic reports unreadable items on stdout). A line longer than
// maxResticLine is skipped; reading goes on, so restic never blocks on a
// full pipe and the summary is never lost.
func readResticBackupOutput(r io.Reader, res *ctResult, reporter *ProgressReporter, errs *resticErrors) {
	lw := &lineWriter{fn: func(line []byte, truncated bool) {
		if truncated {
			errs.line(line, true, false)
			return
		}
		var m struct {
			MessageType string `json:"message_type"`
			SnapshotID  string `json:"snapshot_id"`
			DataAdded   uint64 `json:"data_added"`
			DataPacked  uint64 `json:"data_added_packed"`
			TotalBytes  uint64 `json:"total_bytes_processed"`
			BytesDone   uint64 `json:"bytes_done"`
			StatusTotal uint64 `json:"total_bytes"`
			FilesNew    uint64 `json:"files_new"`
			FilesChange uint64 `json:"files_changed"`
			FilesTotal  uint64 `json:"total_files_processed"`
		}
		if json.Unmarshal(line, &m) != nil {
			return
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
			res.BytesAddedPacked = m.DataPacked
			res.FilesNew, res.FilesChanged, res.FilesTotal = m.FilesNew, m.FilesChange, m.FilesTotal
		default:
			errs.line(line, false, false)
		}
	}}
	_, _ = io.Copy(lw, r)
	lw.Flush()
}

// containerRetryLock is how long a container backup waits for the lock of the
// server's check or retention of the repository.
const containerRetryLock = "15m"

// containerBackupArgs is the restic command line of a container backup. The
// lost+found of the root file system and of every mount point is left out: on
// ext4 it belongs to the host's root, which an unprivileged container's ID map
// does not include, so the mapped root cannot read it (vzdump's own archives
// leave it out for the same reason). In snapshot mode PVE passes one source per
// file system ("." and "./mnt/data"); in suspend and stop mode it passes "."
// only, with every mount point copied or mounted below it, so the mount points
// come from the guest's configuration (mounts) as well. dir is the folder restic
// runs in (containerBackupRoot).
//
// --retry-lock (restic 0.16+, pinned 0.19.1 in tools.env) waits for an
// exclusive lock the server holds while it checks or prunes the container's
// repository, instead of failing the backup at once (as for machines and file
// shares).
func containerBackupArgs(dir string, sources, mounts, excludes []string, vmid int, runID, cacheDir string, bwlimitKiB uint64, copied bool) []string {
	// No --no-scan: restic's scan gives the total its progress needs (#51).
	args := []string{"backup", "--json", "--host", fmt.Sprintf("pve-ct-%d", vmid),
		"--tag", fmt.Sprintf("vmid=%d", vmid), "--tag", "run=" + runID}
	if cacheDir != "" {
		args = append(args, "--cache-dir", cacheDir)
	} else {
		args = append(args, "--no-cache")
	}
	args = append(args, "--retry-lock", containerRetryLock)
	if copied {
		// A fresh copy: new inodes and ctimes, the same size and mtime (containerBackupRoot).
		args = append(args, "--ignore-inode", "--ignore-ctime")
	}
	for _, ex := range excludes {
		if e := ExcludeToRestic(dir, ex); e != "" {
			args = append(args, "--exclude", e)
		}
	}
	seen := map[string]bool{}
	for _, fs := range append(append([]string{}, sources...), mounts...) {
		lf := filepath.Join(dir, fs, "lost+found")
		if !seen[lf] {
			seen[lf] = true
			args = append(args, "--exclude", lf)
		}
	}
	if bwlimitKiB > 0 {
		args = append(args, "--limit-upload", fmt.Sprint(max(1, bwlimitKiB/1024)))
	}
	args = append(args, "--")
	return append(args, sources...)
}

// backupMountPoints are the paths of the mount points vzdump backs up with the
// container, from its configuration: the volume mount points with backup=1
// ("mp0: local-lvm:vm-105-disk-1,mp=/srv/data,backup=1"). Bind and device
// mount points (a host path) are never part of the backup. As
// containerBackupPaths of the server (apps/api/src/features/pve/files.ts).
func backupMountPoints(guestConfig string) []string {
	var out []string
	seen := map[string]bool{}
	for k, v := range parseConfigText(guestConfig) {
		if k == "rootfs" || !mpKeyRE.MatchString(k) || !isVolumeMount(v) || mountVolume(v) == "" {
			continue
		}
		var path string
		backup := false
		for _, opt := range mountOptions(v) {
			key, val, _ := strings.Cut(opt, "=")
			switch strings.TrimSpace(key) {
			case "mp":
				path = strings.TrimSpace(val)
			case "backup":
				switch strings.TrimSpace(val) {
				case "1", "yes", "true", "on":
					backup = true
				}
			}
		}
		path = strings.TrimRight(path, "/")
		if !backup || !strings.HasPrefix(path, "/") || seen[path] {
			continue
		}
		seen[path] = true
		out = append(out, path)
	}
	sort.Strings(out)
	return out
}

// unreadableRemark is the one line the restore point records about what it misses: count
// items, the first of which are items.
func unreadableRemark(count int, items []string) string {
	switch {
	case count == 0 || len(items) == 0:
		return "restic could not read some items; the restore point is incomplete"
	case count == 1:
		return fmt.Sprintf("restic could not read 1 item (%s); the restore point is incomplete", items[0])
	default:
		return fmt.Sprintf("restic could not read %d items (first: %s); the restore point is incomplete", count, items[0])
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
		ResticBytesAddedPacked: res.BytesAddedPacked, ResticTotalBytes: res.TotalBytes, ResticRoot: res.Root,
		ConsistencyRemark: res.Remark, ResticUnreadable: res.Unreadable,
		ResticUnreadablePaths: res.UnreadablePaths, ResticFilesNew: res.FilesNew,
		ResticFilesChanged: res.FilesChanged, ResticFilesTotal: res.FilesTotal})
	if err != nil {
		return 0, fmt.Errorf("commit the restore point: %w", err)
	}
	job.SnapshotID, job.Committed = commit.SnapshotID, true
	_ = p.saveJob(job)
	p.logf("info", "restore point %s committed", commit.SnapshotID)
	return res.TotalBytes, nil
}
