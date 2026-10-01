//go:build unix

package state

import (
	"fmt"
	"os"
	"syscall"
)

// ensureDir creates the state directory with mode 0700 and tightens an
// existing one.
func ensureDir(dir string) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	return os.Chmod(dir, 0o700)
}

func syncDir(dir string) error {
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer d.Close()
	// Some file systems do not support fsync on directories; the rename above
	// is already atomic, so this is best effort.
	_ = d.Sync()
	return nil
}

// checkFile enforces the protection of the state file: not readable by group
// or others, and, when running as root, owned by root.
func checkFile(path string) ([]string, error) {
	st, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !st.Mode().IsRegular() {
		return nil, fmt.Errorf("state file %s is not a regular file", path)
	}
	var warnings []string
	if sys, ok := st.Sys().(*syscall.Stat_t); ok && os.Geteuid() == 0 && sys.Uid != 0 {
		return nil, fmt.Errorf("state file %s is owned by uid %d, not root; refusing to use it", path, sys.Uid)
	}
	if perm := st.Mode().Perm(); perm&0o077 != 0 {
		if err := os.Chmod(path, 0o600); err != nil {
			return nil, fmt.Errorf("state file %s has mode %#o and cannot be tightened: %w", path, perm, err)
		}
		warnings = append(warnings, fmt.Sprintf("state file %s had mode %#o, changed to 0600", path, perm))
	}
	return warnings, nil
}
