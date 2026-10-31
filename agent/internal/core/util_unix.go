//go:build unix

package core

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/restow-backup/restow/agent/internal/paths"
)

// defaultRestoreDir chooses the new folder for a restore that names no target:
// Restow-Restore-<yyyyMMdd-HHmmss> inside the first backed-up root that exists
// and that no other user can change (a folder in a user's home could be
// swapped for a link while root restores into it); without one, at the file
// system root (macOS: /Users, because / is read-only).
func defaultRestoreDir(roots []string, now time.Time) string {
	name := "Restow-Restore-" + now.Format("20060102-150405")
	for _, p := range roots {
		if !filepath.IsAbs(p) {
			continue
		}
		if st, err := os.Stat(p); err != nil || !st.IsDir() {
			continue
		}
		if resolved, err := paths.TrustedDir(p, true); err == nil {
			return filepath.Join(resolved, name)
		}
	}
	if runtime.GOOS == "darwin" {
		return filepath.Join("/Users", name)
	}
	return filepath.Join("/", name)
}

// prepareRestoreTarget makes sure a restore can never overwrite anything or be
// redirected, and creates the target folder. The target must be a canonical
// absolute path (no "..", ".", "//" or trailing slash); its parent must exist
// and, like every folder above it, be changeable by root only (a world-writable
// folder with the sticky bit, such as /tmp, is fine); the target itself must
// not exist yet or be an empty folder owned by root. It returns the target
// with the parent's links resolved, which is where restic writes.
func prepareRestoreTarget(target string) (string, error) {
	if !filepath.IsAbs(target) || strings.ContainsRune(target, 0) {
		return "", targetFail("invalid_task", "the restore target %q must be an absolute path", target)
	}
	if filepath.Clean(target) != target {
		return "", targetFail("invalid_task", "the restore target %q is not a plain path (no \"..\", \".\", double or trailing slashes)", target)
	}
	if target == "/" || filepath.Dir(target) == target {
		return "", targetFail("invalid_task", "refusing to restore into the file system root %q", target)
	}
	parent, err := paths.TrustedDir(filepath.Dir(target), true)
	if err != nil {
		if os.IsNotExist(err) {
			return "", targetFail("target_unusable", "the folder %s does not exist; restore into an existing folder or leave the target empty", filepath.Dir(target))
		}
		return "", targetFail("target_unusable", "the restore target %q is refused: %v", target, err)
	}
	final := filepath.Join(parent, filepath.Base(target))
	st, err := os.Lstat(final)
	switch {
	case os.IsNotExist(err):
		// A fresh folder only root can enter; the restored files keep their modes.
		if err := os.Mkdir(final, 0o700); err != nil {
			if os.IsExist(err) {
				return "", targetFail("target_not_empty", "the restore target %q appeared while preparing the restore; Restow never overwrites existing files, pick a new folder", target)
			}
			return "", targetFail("target_unusable", "cannot create the restore folder %s: %v", final, err)
		}
		return final, nil
	case err != nil:
		return "", targetFail("target_unusable", "cannot inspect the restore target %q: %v", target, err)
	case !st.IsDir():
		return "", targetFail("target_not_empty", "the restore target %q exists and is not a directory; Restow never overwrites existing files", target)
	}
	entries, err := os.ReadDir(final)
	if err != nil {
		return "", targetFail("target_unusable", "cannot read the restore target %q: %v", target, err)
	}
	if len(entries) > 0 {
		return "", targetFail("target_not_empty", "the restore target %q already contains files; Restow never overwrites existing files, pick a new folder", target)
	}
	// The folder itself must be root's alone: anything another user could
	// create in it during the restore (a link) would redirect restic.
	if _, err := paths.TrustedDir(final, true); err != nil || st.Mode().Perm()&0o022 != 0 {
		if err == nil {
			err = fmt.Errorf("it is writable by group or others (mode %#o)", st.Mode().Perm())
		}
		return "", targetFail("target_unusable", "the empty restore target %q is refused: %v", target, err)
	}
	return final, nil
}
