//go:build unix && !linux

package dbprobe

import (
	"os"
	"syscall"
)

// openNoFollow opens a file for reading without following a link in its last
// element and without blocking on a pipe or device.
func openNoFollow(path string) (*os.File, error) {
	// #nosec G304 -- the path the administrator named for this connection
	return os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
}
