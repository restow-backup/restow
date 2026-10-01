//go:build unix

// Package lock provides the exclusive run lock shared by the service and the
// `backup-now` command, so two runs never work on the same repository from one
// machine at the same time. The lock is an flock(2) on a file, so the kernel
// releases it when the holder exits, even after a crash.
package lock

import (
	"errors"
	"os"
	"path/filepath"
	"syscall"
)

// ErrLocked is returned when another process holds the lock.
var ErrLocked = errors.New("another run is in progress")

// Lock is a held lock.
type Lock struct{ f *os.File }

// TryAcquire takes the lock without waiting.
func TryAcquire(path string) (*Lock, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		_ = f.Close()
		if errors.Is(err, syscall.EWOULDBLOCK) || errors.Is(err, syscall.EAGAIN) {
			return nil, ErrLocked
		}
		return nil, err
	}
	return &Lock{f: f}, nil
}

// Release drops the lock.
func (l *Lock) Release() error {
	if l == nil || l.f == nil {
		return nil
	}
	_ = syscall.Flock(int(l.f.Fd()), syscall.LOCK_UN)
	err := l.f.Close()
	l.f = nil
	return err
}
