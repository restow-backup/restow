//go:build unix

package recovery

import (
	"io/fs"
	"syscall"
)

// fileOwner is the uid and gid of a file of the target.
func fileOwner(st fs.FileInfo) ([2]int, bool) {
	if s, ok := st.Sys().(*syscall.Stat_t); ok {
		return [2]int{int(s.Uid), int(s.Gid)}, true
	}
	return [2]int{}, false
}
