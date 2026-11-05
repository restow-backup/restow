//go:build linux

package recovery

import (
	"syscall"
	"time"
)

// SetClock sets the system clock (by hand only, 10.3).
func SetClock(t time.Time) error {
	tv := syscall.NsecToTimeval(t.UnixNano())
	return syscall.Settimeofday(&tv)
}
