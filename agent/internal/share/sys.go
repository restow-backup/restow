package share

import (
	"errors"
	"syscall"
)

// System is the kernel interface of the runner: statfs, the mount table and
// extended attributes. OS() is the real one (Linux only); the tests use fakes.
type System interface {
	// Statfs returns f_type of the file system that holds path.
	Statfs(path string) (int64, error)
	// MountInfo returns /proc/self/mountinfo.
	MountInfo() ([]byte, error)
	Xattrs
}

// Xattrs reads and writes extended attributes without following symbolic
// links at the end of the path (the callers never pass a link).
type Xattrs interface {
	GetXattr(path, name string) ([]byte, error)
	SetXattr(path, name string, value []byte) error
}

// ErrUnsupported is what the real System answers on a platform without the
// Linux calls (restow-share runs on Linux only; this keeps darwin vet green).
var ErrUnsupported = errors.New("not supported on this platform")

// File system magic numbers (statfs f_type) [K].
const (
	MagicCIFS = 0xFF534D42
	MagicSMB2 = 0xFE534D42
	MagicNFS  = 0x6969
)

// errnoName is the symbolic name of a system error ("EACCES"), or "" when err
// carries no errno.
func errnoName(err error) string {
	var errno syscall.Errno
	if !errors.As(err, &errno) {
		return ""
	}
	switch errno {
	case syscall.EACCES:
		return "EACCES"
	case syscall.EPERM:
		return "EPERM"
	case syscall.ENOENT:
		return "ENOENT"
	case syscall.EIO:
		return "EIO"
	case syscall.ETIMEDOUT:
		return "ETIMEDOUT"
	case syscall.EBUSY:
		return "EBUSY"
	case syscall.ERANGE:
		return "ERANGE"
	case syscall.EINVAL:
		return "EINVAL"
	case syscall.E2BIG:
		return "E2BIG"
	case syscall.ENOTDIR:
		return "ENOTDIR"
	case syscall.EHOSTDOWN:
		return "EHOSTDOWN"
	case syscall.EHOSTUNREACH:
		return "EHOSTUNREACH"
	case syscall.ECONNREFUSED:
		return "ECONNREFUSED"
	case syscall.ENOSPC:
		return "ENOSPC"
	case syscall.EROFS:
		return "EROFS"
	}
	if isNoData(errno) {
		return "ENODATA"
	}
	if isNotSupported(errno) {
		return "EOPNOTSUPP"
	}
	return errno.Error()
}

// isNoData: the attribute does not exist (ENODATA on Linux, ENOATTR elsewhere).
func isNoData(err error) bool {
	var errno syscall.Errno
	if !errors.As(err, &errno) {
		return false
	}
	return errno == errNoData
}

// isNotSupported: the file system has no such attribute family.
func isNotSupported(err error) bool {
	var errno syscall.Errno
	if !errors.As(err, &errno) {
		return false
	}
	return errno == syscall.EOPNOTSUPP || errno == syscall.ENOTSUP
}

// isAccess: the server refused (EACCES or EPERM).
func isAccess(err error) bool {
	var errno syscall.Errno
	if !errors.As(err, &errno) {
		return false
	}
	return errno == syscall.EACCES || errno == syscall.EPERM
}

// isUnreachable: the server stopped answering.
func isUnreachable(err error) bool {
	var errno syscall.Errno
	if !errors.As(err, &errno) {
		return false
	}
	switch errno {
	case syscall.EIO, syscall.ETIMEDOUT, syscall.EHOSTDOWN, syscall.EHOSTUNREACH, syscall.ECONNREFUSED:
		return true
	}
	return false
}
