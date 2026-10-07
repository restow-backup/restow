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
