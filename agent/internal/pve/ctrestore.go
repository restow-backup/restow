//go:build !windows

package pve

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// A container restore (restore-container-init) unpacks the restore point with restic into a
// folder of its own below the restore folder (RestoreTmp, `restow-pve config --restore-tmp`),
// from which PVE copies it into the new container's volumes; restore-container-cleanup
// removes it. Every init gets its own folder (ct-<hash of the volname>-<random>), so two
// restores of one restore point (a boot test beside a restore from the PVE GUI) never share or
// delete each other's tree:
//
//	<restore folder>/ct-<hash>-<random>/owner   "<pid> <start time>" of the PVE worker
//	<restore folder>/ct-<hash>-<random>/root    the archive directory PVE reads
//
// The PVE worker that restores (the parent of `restow-pve provider`) calls init and cleanup
// from the same process; the shim passes the directory init gave to cleanup. A folder whose
// owner is gone (a crash, a killed task) is swept by the next init.

// restoreFolderPrefix starts the folder of every container restore.
const restoreFolderPrefix = "ct-"

// legacyRestoreFolderAge: a folder without owner (the layout before 0.5.0) is swept after this.
const legacyRestoreFolderAge = 48 * time.Hour

// restoreSpaceReserve is the share of the restore folder's file system that stays free.
const restoreSpaceReserve = 0.05

// statfs reads the size and the free space (for unprivileged users, as df) of a file system.
var statfs = func(path string) (total, avail uint64, err error) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return 0, 0, err
	}
	return st.Blocks * uint64(st.Bsize), st.Bavail * uint64(st.Bsize), nil
}

// restoreOwner is the process the restore belongs to: the PVE worker that runs the shim.
var restoreOwner = os.Getppid

func (p *Provider) restoreTmpDir() string {
	if p.state != nil && p.state.RestoreTmpDir != "" {
		return p.state.RestoreTmpDir
	}
	return p.Layout.RestoreTmp
}

// containerRestoreArgs is the restic command line of a container restore: --sparse keeps the
// holes of sparse files (database preallocation, swap files) in the temporary copy and in the
// new rootfs; --retry-lock waits for the exclusive lock the server holds while it checks or
// prunes the repository, typically right after a backup (as containerBackupArgs).
func containerRestoreArgs(snapshot, target string) []string {
	return []string{"restore", snapshot, "--target", target, "--no-cache", "--sparse", "--retry-lock", containerRetryLock}
}

// resticLockedExit is restic's exit code for a repository locked by someone else.
const resticLockedExit = 11

// restoreSpaceCheck refuses a restore of need bytes into dir when its file system would keep
// less than restoreSpaceReserve free. Unknown (no size, statfs fails) is no refusal.
func restoreSpaceCheck(dir string, size uint64) (string, error) {
	if size == 0 {
		return "the size of the restore point is not known; the free space of the restore folder is not checked", nil
	}
	total, avail, err := statfs(dir)
	if err != nil {
		return fmt.Sprintf("the free space of %s is not known (%v)", dir, err), nil
	}
	need := size + size/10
	reserve := uint64(float64(total) * restoreSpaceReserve)
	if avail < need+reserve {
		return "", fmt.Errorf("the temporary folder %s has %s free, the restore needs about %s (and %s stay free); set restow-pve config --restore-tmp <a folder on a data storage>",
			dir, gbString(avail), gbString(need), gbString(reserve))
	}
	return fmt.Sprintf("%s has %s free, the restore needs about %s", dir, gbString(avail), gbString(need)), nil
}

func gbString(n uint64) string {
	return fmt.Sprintf("%.1f GB", float64(n)/1e9)
}

func volnameHash(volname string) string {
	sum := sha256.Sum256([]byte(volname))
	return hex.EncodeToString(sum[:6])
}

// processStart is a process's start time in clock ticks since boot (field 22 of
// /proc/<pid>/stat), which tells a process from a later one with the same pid; "" when the
// process does not run.
func processStart(pid int) string {
	data, err := os.ReadFile(filepath.Join(procRoot, strconv.Itoa(pid), "stat"))
	if err != nil {
		return ""
	}
	// The command name in parentheses may hold spaces; the fields after it are plain.
	s := string(data)
	i := strings.LastIndexByte(s, ')')
	if i < 0 {
		return ""
	}
	fields := strings.Fields(s[i+1:])
	if len(fields) < 20 {
		return ""
	}
	return fields[19]
}

// ownerAlive says whether the owner recorded in a restore folder still runs.
func ownerAlive(folder string) (alive, known bool) {
	data, err := os.ReadFile(filepath.Join(folder, "owner"))
	if err != nil {
		return false, false
	}
	f := strings.Fields(string(data))
	if len(f) != 2 {
		return false, true
	}
	pid, err := strconv.Atoi(f[0])
	if err != nil || pid <= 1 {
		return false, true
	}
	return processStart(pid) == f[1], true
}

func writeOwner(folder string, pid int) error {
	return os.WriteFile(filepath.Join(folder, "owner"), []byte(fmt.Sprintf("%d %s\n", pid, processStart(pid))), 0o600)
}

// sweepRestoreFolders removes the folders of container restores that no process owns any more
// (and those of the layout before 0.5.0 after two days).
func (p *Provider) sweepRestoreFolders(base string) {
	entries, err := os.ReadDir(base)
	if err != nil {
		return
	}
	for _, e := range entries {
		if !e.IsDir() || !strings.HasPrefix(e.Name(), restoreFolderPrefix) {
			continue
		}
		folder := filepath.Join(base, e.Name())
		alive, known := ownerAlive(folder)
		if alive {
			continue
		}
		if !known {
			info, err := e.Info()
			if err != nil || time.Since(info.ModTime()) < legacyRestoreFolderAge {
				continue
			}
		}
		p.logf("info", "removing %s, left by a restore that ended without its cleanup", folder)
		// Its PVE task has ended (its worker is gone): the service reports how.
		leaveRestoreEnd(p.Layout, folder)
		_ = os.RemoveAll(folder)
	}
}

// liveContainerRestores counts the container restores whose owner runs (busy()).
func liveContainerRestores(base string) int {
	n := 0
	entries, _ := os.ReadDir(base)
	for _, e := range entries {
		if e.IsDir() && strings.HasPrefix(e.Name(), restoreFolderPrefix) {
			if alive, _ := ownerAlive(filepath.Join(base, e.Name())); alive {
				n++
			}
		}
	}
	return n
}

// restoreTmpOf is the restore folder of a node from its state file (busy() has the layout only).
func restoreTmpOf(l Layout) string {
	if l.StateFile != "" {
		if st, err := LoadState(l.StateFile); err == nil && st.RestoreTmpDir != "" {
			return st.RestoreTmpDir
		}
	}
	return l.RestoreTmp
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
	base := p.restoreTmpDir()
	if err := os.MkdirAll(base, 0o700); err != nil {
		return nil, err
	}
	p.sweepRestoreFolders(base)
	note, err := restoreSpaceCheck(base, rp.ByteSize)
	if err != nil {
		return nil, err
	}
	p.logf("info", "%s", note)
	access, err := p.server.RestoreRestic(ctx, rp.SnapshotID)
	if err != nil {
		return nil, err
	}
	var rnd [6]byte
	if _, err := rand.Read(rnd[:]); err != nil {
		return nil, err
	}
	folder := filepath.Join(base, restoreFolderPrefix+volnameHash(req.Volname)+"-"+hex.EncodeToString(rnd[:]))
	target := filepath.Join(folder, "root")
	if err := os.MkdirAll(target, 0o700); err != nil {
		return nil, err
	}
	if err := writeOwner(folder, restoreOwner()); err != nil {
		_ = os.RemoveAll(folder)
		return nil, err
	}
	if access.RunID != "" {
		p.keepRestoreRun(folder, access.RunID, req.Volname, restoreOwner())
	}
	// The sources were relative to the backup folder ("." and the mount
	// points), so the snapshot's tree is the container root itself.
	cmd := exec.CommandContext(ctx, p.resticBinary(), containerRestoreArgs(rp.ResticSnapshot, target)...)
	cmd.Env = resticEnv(access)
	stopResticGently(cmd)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		_ = os.RemoveAll(folder)
		var exit *exec.ExitError
		if errors.As(err, &exit) && exit.ExitCode() == resticLockedExit {
			return nil, fmt.Errorf("the Restow server is checking or pruning this container's repository; try again in a few minutes (restic waited %s for its lock: %s)", containerRetryLock, lastLines(stderr.String(), 3))
		}
		return nil, fmt.Errorf("restic restore failed: %v: %s", err, lastLines(stderr.String(), 10))
	}
	p.logf("info", "restore point unpacked to %s", target)
	return map[string]any{"archiveDirectory": target}, nil
}

// restoreContainerCleanup removes the folder of this restore: the one the shim names (it must
// be a restore folder below the restore folder), or without a name (a shim before 0.5.0) the
// folders of the volname this worker owns and the folder of the layout before 0.5.0.
func (p *Provider) restoreContainerCleanup(req ProviderRequest) error {
	base := filepath.Clean(p.restoreTmpDir())
	if req.Directory != "" {
		folder, err := restoreFolderOf(base, req.Directory)
		if err != nil {
			return err
		}
		// PVE's restore task goes on for a moment after the cleanup: the service waits for its
		// end and reports it.
		leaveRestoreEnd(p.Layout, folder)
		return os.RemoveAll(folder)
	}
	owner := restoreOwner()
	prefix := restoreFolderPrefix + volnameHash(req.Volname) + "-"
	entries, _ := os.ReadDir(base)
	for _, e := range entries {
		if !e.IsDir() || !strings.HasPrefix(e.Name(), prefix) {
			continue
		}
		folder := filepath.Join(base, e.Name())
		data, _ := os.ReadFile(filepath.Join(folder, "owner"))
		if f := strings.Fields(string(data)); len(f) == 2 && f[0] == strconv.Itoa(owner) {
			leaveRestoreEnd(p.Layout, folder)
			_ = os.RemoveAll(folder)
		}
	}
	safe := strings.NewReplacer("/", "_", ":", "-").Replace(req.Volname)
	_ = os.RemoveAll(filepath.Join(base, restoreFolderPrefix+safe))
	return nil
}

// restoreFolderOf is the restore folder of an archive directory init gave
// (<base>/ct-.../root); an error for anything else.
func restoreFolderOf(base, dir string) (string, error) {
	dir = filepath.Clean(dir)
	if filepath.Base(dir) != "root" {
		return "", fmt.Errorf("%s is no archive directory of a container restore", dir)
	}
	folder := filepath.Dir(dir)
	if filepath.Dir(folder) != base || !strings.HasPrefix(filepath.Base(folder), restoreFolderPrefix) {
		return "", fmt.Errorf("%s is not below the restore folder %s", dir, base)
	}
	return folder, nil
}

// RestoreFolderStatus is the restore folder of a node and its free space (diagnose).
func RestoreFolderStatus(l Layout, st *State) (dir string, total, avail uint64, onRoot bool, err error) {
	dir = l.RestoreTmp
	if st != nil && st.RestoreTmpDir != "" {
		dir = st.RestoreTmpDir
	}
	probe := dir
	for {
		if _, err := os.Stat(probe); err == nil {
			break
		}
		parent := filepath.Dir(probe)
		if parent == probe {
			break
		}
		probe = parent
	}
	total, avail, err = statfs(probe)
	var a, r syscall.Stat_t
	if syscall.Stat(probe, &a) == nil && syscall.Stat("/", &r) == nil {
		onRoot = a.Dev == r.Dev
	}
	return dir, total, avail, onRoot, err
}
