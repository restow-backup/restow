//go:build darwin

package dbprobe

import (
	"os"
	"strconv"
	"syscall"
	"time"
)

// fileIdentity: inode, device and birth time.
func fileIdentity(_ *os.File, info os.FileInfo) (inode, device, created *string) {
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return nil, nil, nil
	}
	i := strconv.FormatUint(st.Ino, 10)
	d := strconv.FormatUint(uint64(st.Dev), 10) //nolint:unconvert
	c := time.Unix(st.Birthtimespec.Sec, st.Birthtimespec.Nsec).UTC().Format(time.RFC3339Nano)
	return &i, &d, &c
}
