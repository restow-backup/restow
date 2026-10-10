//go:build linux

package share

import (
	"errors"
	"os"
	"syscall"
)

const errNoData = syscall.ENODATA

type osSystem struct{}

// OS is the real System.
func OS() System { return osSystem{} }

func (osSystem) Statfs(path string) (int64, error) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return 0, &os.PathError{Op: "statfs", Path: path, Err: err}
	}
	// f_type is a signed word on some architectures; the magic numbers are 32 bit.
	return int64(uint32(st.Type)), nil
}

func (osSystem) MountInfo() ([]byte, error) { return os.ReadFile("/proc/self/mountinfo") }

// maxXattrSize is the largest value the kernel hands out (XATTR_SIZE_MAX).
const maxXattrSize = 64 * 1024

func (osSystem) GetXattr(path, name string) ([]byte, error) {
	size := 256
	for {
		buf := make([]byte, size)
		n, err := syscall.Getxattr(path, name, buf)
		if err == nil {
			return buf[:n], nil
		}
		if errors.Is(err, syscall.ERANGE) && size < maxXattrSize {
			// Ask for the size, then retry with that much room.
			if need, serr := syscall.Getxattr(path, name, nil); serr == nil && need > size {
				size = need
			} else {
				size *= 4
			}
			if size > maxXattrSize {
				size = maxXattrSize
			}
			continue
		}
		return nil, &os.PathError{Op: "getxattr " + name, Path: path, Err: err}
	}
}

func (osSystem) SetXattr(path, name string, value []byte) error {
	if err := syscall.Setxattr(path, name, value, 0); err != nil {
		return &os.PathError{Op: "setxattr " + name, Path: path, Err: err}
	}
	return nil
}

// ctimeOf is the change time (ns since 1970) of a FileInfo from Lstat.
func ctimeOf(fi os.FileInfo) int64 {
	if st, ok := fi.Sys().(*syscall.Stat_t); ok {
		return st.Ctim.Sec*1e9 + st.Ctim.Nsec
	}
	return 0
}
