package recovery

import (
	"errors"
	"io/fs"
)

// Rootfs is file access below the target root (docs/BAREMETAL.md 10.13):
// every path is a path of the restored system ("/etc/fstab"), and links
// are resolved inside the target, never outside (rootfs_linux.go uses
// openat2 with RESOLVE_IN_ROOT). Tests use an in-memory implementation.
type Rootfs interface {
	// ReadFile reads a regular file of at most max bytes.
	ReadFile(p string, max int64) ([]byte, error)
	// WriteFileAtomic replaces p with data (mode, owner) through a
	// temporary file and a rename; with backup set the previous file is
	// kept under that name in the same folder. A symlink as the last
	// component is refused.
	WriteFileAtomic(p string, data []byte, mode fs.FileMode, uid, gid int, backup string) error
	// MkdirAll creates p and its parents with mode (root:root).
	MkdirAll(p string, mode fs.FileMode) error
	// Lstat describes p without following a link in the last component.
	Lstat(p string) (fs.FileInfo, error)
	Chmod(p string, mode fs.FileMode) error
	Chown(p string, uid, gid int) error
	// Remove removes a file or an empty folder.
	Remove(p string) error
	// ReadDir lists the names in a folder.
	ReadDir(p string) ([]string, error)
	// Getxattr reads an extended attribute (security.selinux).
	Getxattr(p, name string) ([]byte, error)
}

// ErrSymlinkTarget is returned when a write would replace a symlink.
var ErrSymlinkTarget = errors.New("the file is a symlink in the target; it is not rewritten")
