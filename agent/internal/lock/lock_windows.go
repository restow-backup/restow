//go:build windows

package lock

import "errors"

// TryAcquire is not available on Windows yet (LockFileEx, docs/WINDOWS-AGENT.md,
// section 10).
func TryAcquire(string) (*Lock, error) {
	return nil, errors.New("the run lock is not supported on Windows yet")
}

// Release drops the lock.
func (l *Lock) Release() error {
	if l == nil || l.f == nil {
		return nil
	}
	err := l.f.Close()
	l.f = nil
	return err
}
