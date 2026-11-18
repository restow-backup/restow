//go:build windows

package dbrun

import "os"

// ownedBySelf: on Windows the run's folders lie in the agent's own temporary
// folder (SYSTEM's), which no other user can write; every entry there is the
// agent's.
func ownedBySelf(os.FileInfo) bool { return true }
