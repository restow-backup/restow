//go:build unix

package dbrun

import (
	"os"
	"syscall"
)

// ownedBySelf: the entry belongs to the user the agent runs as.
func ownedBySelf(fi os.FileInfo) bool {
	st, ok := fi.Sys().(*syscall.Stat_t)
	return ok && int(st.Uid) == os.Geteuid()
}
