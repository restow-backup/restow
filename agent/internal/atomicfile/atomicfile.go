// Package atomicfile replaces files atomically on every system. On Unix that
// is rename(2). On Windows a rename over an existing file fails with "access
// denied" or "sharing violation" while another process has the target open
// without FILE_SHARE_DELETE (Go opens files that way; so do virus scanners
// for a moment after a write), so the replacement is retried for up to about
// four seconds (docs/WINDOWS-AGENT.md, section 7).
package atomicfile

import (
	"io"
	"os"
	"time"
)

// Attempts and pauses of the retry on Windows.
const (
	maxAttempts = 10
	firstPause  = 50 * time.Millisecond
	maxPause    = time.Second
)

// Rename moves from over to (replacing it) and makes the change durable.
func Rename(from, to string) error {
	return retry(func() error { return rename(from, to) }, isTransient, time.Sleep)
}

// Open opens a file for reading so that it can still be replaced or deleted
// while it is open (FILE_SHARE_DELETE on Windows).
func Open(path string) (*os.File, error) { return open(path) }

// ReadFile reads a whole file opened with Open.
func ReadFile(path string) ([]byte, error) {
	f, err := Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return io.ReadAll(f)
}

// retry runs op until it succeeds, fails permanently or the attempts are used up.
func retry(op func() error, transient func(error) bool, sleep func(time.Duration)) error {
	pause := firstPause
	var err error
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		if err = op(); err == nil || !transient(err) {
			return err
		}
		if attempt < maxAttempts {
			sleep(pause)
			pause *= 2
			if pause > maxPause {
				pause = maxPause
			}
		}
	}
	return err
}
