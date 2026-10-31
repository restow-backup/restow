//go:build windows

package atomicfile

import (
	"os"
	"syscall"

	"github.com/restow-backup/restow/agent/internal/winapi"
)

// rename replaces to with POSIX semantics first, so a reader that holds to open
// with FILE_SHARE_DELETE (atomicfile.Open) does not block it. Where Windows or the
// file system cannot do that (or refuses it for any other reason), MoveFileExW does
// what it did before: it fails while to is open, and Rename retries.
func rename(from, to string) error {
	if err := winapi.RenameReplacing(from, to); err == nil {
		return nil
	}
	if err := winapi.MoveFileEx(from, to, winapi.MoveFileReplaceExisting|winapi.MoveFileWriteThrough); err != nil {
		return &os.LinkError{Op: "rename", Old: from, New: to, Err: err}
	}
	return nil
}

func isTransient(err error) bool {
	return winapi.IsErrno(err, winapi.ErrorAccessDenied) || winapi.IsErrno(err, winapi.ErrorSharingViolation)
}

func open(path string) (*os.File, error) {
	p, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return nil, err
	}
	h, err := syscall.CreateFile(p, syscall.GENERIC_READ,
		syscall.FILE_SHARE_READ|syscall.FILE_SHARE_WRITE|syscall.FILE_SHARE_DELETE, nil,
		syscall.OPEN_EXISTING, syscall.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		return nil, &os.PathError{Op: "open", Path: path, Err: err}
	}
	return os.NewFile(uintptr(h), path), nil
}
