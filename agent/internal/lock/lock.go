// Package lock provides the exclusive run lock shared by the service and the
// `backup-now` command, so two runs never work on the same repository from one
// machine at the same time. On Unix the lock is an flock(2) on a file
// (lock_unix.go), so the kernel releases it when the holder exits, even after a
// crash.
package lock

import (
	"errors"
	"os"
)

// ErrLocked is returned when another process holds the lock.
var ErrLocked = errors.New("another run is in progress")

// Lock is a held lock.
type Lock struct{ f *os.File }
