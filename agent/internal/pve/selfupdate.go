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
// running on this node (a job file or a restore server exists).
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

func busy(l Layout) bool {
	for _, dir := range []string{filepath.Join(l.RunDir, "jobs"), filepath.Join(l.RunDir, "restore")} {
		entries, _ := os.ReadDir(dir)
		for _, e := range entries {
			if !bytes.HasPrefix([]byte(e.Name()), []byte(".")) {
				return true
			}
		}
	}
	return false
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
func InstallUpdate(ctx context.Context, apply func(context.Context) error, cmd CommandRunner, logf func(string, ...any)) error {
	if err := apply(ctx); err != nil {
		return err
	}
	ReloadPVEDaemons(ctx, cmd, logf)
	return nil
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
