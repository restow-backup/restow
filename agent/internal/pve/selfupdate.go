//go:build !windows

package pve

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/restow-backup/restow/agent/internal/release"
	"github.com/restow-backup/restow/agent/internal/update"
)

// ReleaseTarget is the only target restow-pve ships for.
const ReleaseTarget = "linux-amd64"

// ReleaseFiles are the node files of a release, below <version>/linux-amd64/.
var ReleaseFiles = append([]string{"restow-pve"}, PluginFiles...)

// SelfUpdate installs a newer release the instance offers: the signature over
// SHA256SUMS is checked with the key compiled into this binary, every file
// against its signed hash, and the new binary must report the version before
// anything is renamed into place. Refused while a backup or restore is
// running on this node (busy: an open backup job or a live restore server).
func SelfUpdate(ctx context.Context, l Layout, srv *Server, current, next string) error {
	cur, err := update.ParseVersion(current)
	if err != nil {
		return err
	}
	if cur.IsDev() {
		return update.ErrDevBuild
	}
	nv, err := update.ParseVersion(next)
	if err != nil {
		return err
	}
	if update.Compare(nv, cur) <= 0 {
		return update.ErrNotNewer
	}
	if busy(l) {
		return errors.New("a backup or restore is running; the update waits")
	}
	key, err := release.TrustedKey()
	if err != nil {
		return err
	}
	version := strings.TrimPrefix(next, "v")
	base := "/install/agent/" + version + "/"
	sums, err := srv.Download(ctx, base+"SHA256SUMS", 1<<20)
	if err != nil {
		return err
	}
	sig, err := srv.Download(ctx, base+"SHA256SUMS.sig", 16<<10)
	if err != nil {
		return err
	}
	verified, err := release.VerifiedSums(key, sums, sig)
	if err != nil {
		return fmt.Errorf("release signature: %w", err)
	}
	staged := map[string][]byte{}
	for _, f := range ReleaseFiles {
		want, err := verified.Lookup(ReleaseTarget, f)
		if err != nil {
			return err
		}
		data, err := srv.Download(ctx, base+ReleaseTarget+"/"+f, 200<<20)
		if err != nil {
			return err
		}
		got := sha256.Sum256(data)
		if hex.EncodeToString(got[:]) != want {
			return fmt.Errorf("%s does not match its signed SHA-256", f)
		}
		staged[f] = data
	}
	tmp := filepath.Join(l.BinDir, ".restow-pve.new")
	if err := os.WriteFile(tmp, staged["restow-pve"], 0o755); err != nil {
		return err
	}
	out, err := exec.CommandContext(ctx, tmp, "version", "--short").Output()
	if err != nil || strings.TrimSpace(string(out)) != version {
		_ = os.Remove(tmp)
		return fmt.Errorf("the new binary does not report version %s", version)
	}
	for _, f := range PluginFiles {
		if err := writeFileAtomic(PluginPath(l, f), staged[f], 0o644); err != nil {
			return err
		}
	}
	return os.Rename(tmp, filepath.Join(l.BinDir, "restow-pve"))
}

// activeRuns lists the run ids of the backups open on this node (their job files). A
// job file that cannot be read is left out; the list is never nil.
func activeRuns(l Layout) []string {
	runs := []string{}
	entries, _ := os.ReadDir(filepath.Join(l.RunDir, "jobs"))
	for _, e := range entries {
		if e.IsDir() || strings.HasPrefix(e.Name(), ".") || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		var j jobState
		if readJSON(filepath.Join(l.RunDir, "jobs", e.Name()), &j) == nil && j.RunID != "" {
			runs = append(runs, j.RunID)
		}
	}
	return runs
}

// staleJobAge is when job-cleanup deletes a job file a backup left behind (a provider that was
// killed, a node that crashed). It never makes a job count as open (openJobs).
const staleJobAge = 48 * time.Hour

// busy says whether a backup or a restore works on this node now: a restore server that
// runs (its pid file names a live `restow-pve serve-restore` of that disk), a container restore
// whose folder's owner runs (ctrestore.go), or an open backup (a job file whose guest has a live
// provider process, or any job file while a vzdump task runs on the node). Logs, sockets and the
// files a finished or crashed backup or restore left behind do not count: only live work may
// hold back a self-update or a boot test.
func busy(l Layout) bool {
	return len(liveRestoreServers(l)) > 0 || openJobs(l) > 0 || liveContainerRestores(restoreTmpOf(l)) > 0
}

// liveRestoreServers lists the keys of the restore servers that run now.
func liveRestoreServers(l Layout) []string {
	var out []string
	entries, _ := os.ReadDir(filepath.Join(l.RunDir, "restore"))
	for _, e := range entries {
		name := e.Name()
		if strings.HasPrefix(name, ".") || !strings.HasSuffix(name, ".pid") {
			continue
		}
		key := strings.TrimSuffix(name, ".pid")
		if pid := readPID(filepath.Join(l.RunDir, "restore", name)); pid > 1 && liveProcess(pid, "restow-pve", "serve-restore", key) {
			out = append(out, key)
		}
	}
	return out
}

// openJobs counts the backups open on this node: a job file (backup-init writes it, the end of
// the backup removes it) whose guest has a live provider, or, between the provider's calls
// (each is a process of its own), while a vzdump task runs on the node. A job file that a
// killed provider or a crash of the node left behind counts for nothing, however young.
func openJobs(l Layout) int {
	n := 0
	vzdump := -1 // vzdumpRuns, asked once
	dir := filepath.Join(l.RunDir, "jobs")
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if e.IsDir() || strings.HasPrefix(e.Name(), ".") || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		var j jobState
		if readJSON(filepath.Join(dir, e.Name()), &j) != nil || j.RunID == "" {
			continue
		}
		if providerAlive(l, j.VMID) {
			n++
			continue
		}
		if vzdump < 0 {
			vzdump = 0
			if vzdumpRuns() {
				vzdump = 1
			}
		}
		n += vzdump
	}
	return n
}

// vzdumpRuns says whether a vzdump task runs on this node. PVE names the worker process of every
// task "task UPID:<node>:...:vzdump:<vmid or empty>:<user>:" (fork_worker sets $0), for a
// backup job of the scheduler, a backup asked for through the API and the vzdump command alike;
// it reads the process table, so it needs no PVE API.
func vzdumpRuns() bool {
	entries, err := os.ReadDir(procRoot)
	if err != nil {
		return false
	}
	for _, e := range entries {
		if _, err := strconv.Atoi(e.Name()); err != nil {
			continue
		}
		cmdline, err := os.ReadFile(filepath.Join(procRoot, e.Name(), "cmdline"))
		if err == nil && bytes.HasPrefix(cmdline, []byte("task UPID:")) && bytes.Contains(cmdline, []byte(":vzdump:")) {
			return true
		}
	}
	return false
}

// providerAlive says whether a provider process backs up the guest now.
func providerAlive(l Layout, vmid int) bool {
	return findProvider(l, vmid) > 1
}

// readPID reads a pid file; 0 when it is missing or damaged.
func readPID(path string) int {
	data, err := os.ReadFile(path)
	if err != nil {
		return 0
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(data)))
	if err != nil {
		return 0
	}
	return pid
}

// liveProcess says whether the process pid runs and its command line holds every word: a pid
// file may outlive its process, and the pid may belong to another process since.
func liveProcess(pid int, words ...string) bool {
	cmdline, err := os.ReadFile(filepath.Join(procRoot, strconv.Itoa(pid), "cmdline"))
	if err != nil {
		return false
	}
	for _, w := range words {
		if !bytes.Contains(cmdline, []byte(w)) {
			return false
		}
	}
	return true
}

// PVEDaemons are the Proxmox VE services that load the storage plugin when they start; they
// keep the old plugin until they are reloaded or restarted. The installer restarts the same
// ones (install/pve.sh, restart_pve_daemons).
var PVEDaemons = []string{"pvedaemon", "pveproxy", "pvestatd", "pvescheduler"}

// HelperUnit is the systemd unit of restow-pve itself.
const HelperUnit = "restow-pve"

// daemonCommandTimeout bounds one systemctl call: a reload of pveproxy waits for its workers.
const daemonCommandTimeout = 2 * time.Minute

// ReloadPVEDaemons makes the PVE daemons load the plugin a self-update installed, as the
// installer does: every one that is active is reloaded or restarted (systemctl
// reload-or-restart); one that is not active is left alone. A failure is logged and does not
// undo the update (the files are in place; the daemon loads them on its next start). Returns the
// daemons that could not be reloaded.
func ReloadPVEDaemons(ctx context.Context, cmd CommandRunner, logf func(string, ...any)) []string {
	var failed []string
	for _, unit := range PVEDaemons {
		if !unitActive(ctx, cmd, unit) {
			logf("%s is not running; it loads the new storage plugin when it starts", unit)
			continue
		}
		if err := systemctl(ctx, cmd, "reload-or-restart", unit); err != nil {
			logf("could not restart %s, it keeps the old storage plugin until it restarts: %v", unit, err)
			failed = append(failed, unit)
			continue
		}
		logf("restarted %s, it loads the new storage plugin", unit)
	}
	return failed
}

// RestartHelper restarts the restow-pve service when it runs, so it runs the new binary (after
// `restow-pve update` by hand; the service itself exits after its own update and systemd starts
// the new binary).
func RestartHelper(ctx context.Context, cmd CommandRunner, logf func(string, ...any)) error {
	if !unitActive(ctx, cmd, HelperUnit) {
		return nil
	}
	if err := systemctl(ctx, cmd, "try-restart", HelperUnit); err != nil {
		logf("could not restart %s: %v", HelperUnit, err)
		return err
	}
	logf("restarted %s", HelperUnit)
	return nil
}

// InstallUpdate applies an update (SelfUpdate) and then makes the PVE daemons load the new
// storage plugin (ReloadPVEDaemons): a self-update replaces the plugin files, but pvedaemon,
// pveproxy, pvestatd and pvescheduler keep the old plugin loaded until they restart.
func InstallUpdate(ctx context.Context, l Layout, apply func(context.Context) error, cmd CommandRunner, logf func(string, ...any)) error {
	if err := apply(ctx); err != nil {
		return err
	}
	if failed := ReloadPVEDaemons(ctx, cmd, logf); len(failed) == 0 {
		recordPluginLoaded(l)
	}
	return nil
}

// EnsurePluginLoaded restarts the PVE daemons once for plugin files they were not restarted
// for yet: a node that an older restow-pve updated (before 0.4.3 a self-update left the daemons
// on the old plugin) catches up by itself. The plugin files the daemons were last restarted for
// are remembered by their hash (DataDir/plugin-loaded); nothing happens while they match, nor
// while a backup or restore runs here (the next call tries again).
func EnsurePluginLoaded(ctx context.Context, l Layout, cmd CommandRunner, logf func(string, ...any)) {
	current, err := pluginFingerprint(l)
	if err != nil {
		return
	}
	if seen, err := os.ReadFile(pluginMarker(l)); err == nil && strings.TrimSpace(string(seen)) == current {
		return
	}
	if busy(l) {
		return
	}
	logf("the PVE daemons may still run an older storage plugin; restarting them once")
	if failed := ReloadPVEDaemons(ctx, cmd, logf); len(failed) == 0 {
		recordPluginLoaded(l)
	}
}

func pluginMarker(l Layout) string { return filepath.Join(l.DataDir, "plugin-loaded") }

// pluginFingerprint hashes the installed plugin files (names and contents).
func pluginFingerprint(l Layout) (string, error) {
	h := sha256.New()
	for _, f := range PluginFiles {
		data, err := os.ReadFile(PluginPath(l, f))
		if err != nil {
			return "", err
		}
		fmt.Fprintf(h, "%s %d\n", f, len(data))
		h.Write(data)
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func recordPluginLoaded(l Layout) {
	if fp, err := pluginFingerprint(l); err == nil {
		_ = os.MkdirAll(l.DataDir, 0o755)
		_ = writeFileAtomic(pluginMarker(l), []byte(fp+"\n"), 0o644)
	}
}

func unitActive(ctx context.Context, cmd CommandRunner, unit string) bool {
	return systemctl(ctx, cmd, "is-active", "--quiet", unit) == nil
}

func systemctl(ctx context.Context, cmd CommandRunner, args ...string) error {
	ctx, cancel := context.WithTimeout(ctx, daemonCommandTimeout)
	defer cancel()
	_, err := cmd.Run(ctx, "systemctl", args...)
	return err
}
