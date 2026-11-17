//go:build linux

package dbprobe

import (
	"os"
	"strconv"
	"syscall"
)

// fileIdentity: inode and device; Linux reports no birth time through stat.
func fileIdentity(_ *os.File, info os.FileInfo) (inode, device, created *string) {
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return nil, nil, nil
	}
	i := strconv.FormatUint(st.Ino, 10)
	d := strconv.FormatUint(uint64(st.Dev), 10) //nolint:unconvert // Dev differs in width between architectures
	return &i, &d, nil
}
