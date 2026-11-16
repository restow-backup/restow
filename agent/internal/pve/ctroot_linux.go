//go:build linux

package pve

import (
	"fmt"
	"syscall"
)

// bindPrivate gives the calling thread a private mount namespace and bind-mounts dir (with
// everything mounted below it) onto target there. The caller has locked its goroutine to the
// thread and never unlocks it, so the thread ends with the goroutine and nothing else of the
// process sees the mount. backup_container runs as the mapped root of PVE's user namespace,
// which may do so in a mount namespace of its own; the host never sees the mount, and it goes
// with the last process of the namespace (restic).
func bindPrivate(dir, target string) error {
	if err := syscall.Unshare(syscall.CLONE_NEWNS); err != nil {
		return fmt.Errorf("unshare a mount namespace: %w", err)
	}
	// Nothing mounted here reaches the host's namespace.
	if err := syscall.Mount("", "/", "", syscall.MS_REC|syscall.MS_PRIVATE, ""); err != nil {
		return fmt.Errorf("make the mounts private: %w", err)
	}
	if err := syscall.Mount(dir, target, "", syscall.MS_BIND|syscall.MS_REC, ""); err != nil {
		return fmt.Errorf("bind-mount %s onto %s: %w", dir, target, err)
	}
	return nil
}
