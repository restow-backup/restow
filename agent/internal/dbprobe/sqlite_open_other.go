//go:build !unix

package dbprobe

import "os"

// openNoFollow opens a file for reading; the caller checked with Lstat that it
// is a regular file and compares the opened file with it.
func openNoFollow(path string) (*os.File, error) {
	return os.Open(path) // #nosec G304 -- the path the administrator named for this connection
}
