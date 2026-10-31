//go:build windows

package lock

import (
	"os"
	"path/filepath"
	"syscall"

	"github.com/restow-backup/restow/agent/internal/winapi"
)

// TryAcquire takes the lock without waiting: LockFileEx on the first byte of
// the lock file (docs/WINDOWS-AGENT.md, section 10). Windows releases the lock
// with the handle, also when the process dies.
func TryAcquire(path string) (*Lock, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, err
	}
	p, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return nil, err
	}
	h, err := syscall.CreateFile(p, syscall.GENERIC_READ|syscall.GENERIC_WRITE,
		syscall.FILE_SHARE_READ|syscall.FILE_SHARE_WRITE|syscall.FILE_SHARE_DELETE, nil,
		syscall.OPEN_ALWAYS, syscall.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		return nil, &os.PathError{Op: "open", Path: path, Err: err}
	}
	var ol syscall.Overlapped
	if err := winapi.LockFileEx(h, winapi.LockfileExclusiveLock|winapi.LockfileFailImmediately, 1, 0, &ol); err != nil {
		_ = syscall.CloseHandle(h)
		if winapi.IsErrno(err, winapi.ErrorLockViolation) || winapi.IsErrno(err, winapi.ErrorIOPending) {
			return nil, ErrLocked
		}
		return nil, err
	}
	return &Lock{f: os.NewFile(uintptr(h), path)}, nil
}

// Release drops the lock.
func (l *Lock) Release() error {
	if l == nil || l.f == nil {
		return nil
	}
	var ol syscall.Overlapped
	_ = winapi.UnlockFileEx(syscall.Handle(l.f.Fd()), 1, 0, &ol)
	err := l.f.Close()
	l.f = nil
	return err
}
