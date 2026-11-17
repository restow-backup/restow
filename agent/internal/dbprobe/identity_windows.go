//go:build windows

package dbprobe

import (
	"os"
	"strconv"
	"syscall"
	"time"
)

// fileIdentity: the file index and volume serial number, and the creation time.
func fileIdentity(f *os.File, info os.FileInfo) (inode, device, created *string) {
	var hi syscall.ByHandleFileInformation
	if err := syscall.GetFileInformationByHandle(syscall.Handle(f.Fd()), &hi); err == nil {
		i := strconv.FormatUint(uint64(hi.FileIndexHigh)<<32|uint64(hi.FileIndexLow), 10)
		d := strconv.FormatUint(uint64(hi.VolumeSerialNumber), 10)
		inode, device = &i, &d
	}
	if attr, ok := info.Sys().(*syscall.Win32FileAttributeData); ok {
		c := time.Unix(0, attr.CreationTime.Nanoseconds()).UTC().Format(time.RFC3339Nano)
		created = &c
	}
	return inode, device, created
}
