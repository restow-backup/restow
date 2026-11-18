package dbrun

import (
	"os"
	"path/filepath"
	"strings"
	"time"
)

// TempPrefixes are the prefixes of a run's private folders (the relay's
// socket, the password file, the restic temporary files).
var TempPrefixes = []string{"restow-db-", "restow-pg-relay-"}

// SweepStale removes what crashed runs left in base: only folders with one
// of TempPrefixes, owned by the agent's own user and not changed for maxAge
// (longer than any run lasts). It returns how many went; an entry that
// cannot be read or removed is skipped.
func SweepStale(base string, maxAge time.Duration, now time.Time) int {
	if base == "" {
		base = RAMDir()
	}
	entries, err := os.ReadDir(base)
	if err != nil {
		return 0
	}
	removed := 0
	for _, entry := range entries {
		name := entry.Name()
		matched := false
		for _, prefix := range TempPrefixes {
			if strings.HasPrefix(name, prefix) {
				matched = true
				break
			}
		}
		if !matched {
			continue
		}
		path := filepath.Join(base, name)
		fi, err := os.Lstat(path)
		if err != nil || !fi.IsDir() || !ownedBySelf(fi) || now.Sub(fi.ModTime()) < maxAge {
			continue
		}
		if os.RemoveAll(path) == nil {
			removed++
		}
	}
	return removed
}
