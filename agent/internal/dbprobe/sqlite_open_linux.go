//go:build linux

package dbprobe

import (
	"errors"
	"os"
	"path/filepath"
	"syscall"
	"unsafe"
)

// resolveNoSymlinks makes openat2 refuse a symbolic link in any part of the path.
const resolveNoSymlinks = 0x04

type openHow struct {
	flags   uint64
	mode    uint64
	resolve uint64
}

// openNoFollow opens a file for reading without following a link in any part
// of its path and without blocking on a pipe or device. Where the kernel has
// no openat2 (or a sandbox forbids it), the path is resolved and refused when
// it leads elsewhere than it says.
func openNoFollow(path string) (*os.File, error) {
	p, err := syscall.BytePtrFromString(path)
	if err != nil {
		return nil, err
	}
	how := openHow{
		flags:   uint64(syscall.O_RDONLY | syscall.O_NOFOLLOW | syscall.O_NONBLOCK | syscall.O_CLOEXEC),
		resolve: resolveNoSymlinks,
	}
	cwd := -100 // AT_FDCWD
	fd, _, errno := syscall.Syscall6(sysOpenat2, uintptr(cwd), uintptr(unsafe.Pointer(p)),
		uintptr(unsafe.Pointer(&how)), unsafe.Sizeof(how), 0, 0)
	switch {
	case errno == 0:
		return os.NewFile(fd, path), nil
	case errno == syscall.ELOOP || errno == syscall.EXDEV:
		return nil, errNotRegular
	case errno == syscall.ENOSYS || errno == syscall.EPERM || errno == syscall.EINVAL:
		return openWithoutLinks(path)
	}
	return nil, &os.PathError{Op: "open", Path: path, Err: errno}
}

// openWithoutLinks is the check without openat2: the path must resolve to
// itself, and its last element is opened without following a link.
func openWithoutLinks(path string) (*os.File, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return nil, err
	}
	resolved, err := filepath.EvalSymlinks(abs)
	if err != nil {
		var pe *os.PathError
		if errors.As(err, &pe) && errors.Is(pe.Err, syscall.ELOOP) {
			return nil, errNotRegular
		}
		return nil, err
	}
	if resolved != filepath.Clean(abs) {
		return nil, errNotRegular
	}
	// #nosec G304 -- the path the administrator named for this connection
	return os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK|syscall.O_CLOEXEC, 0)
}
