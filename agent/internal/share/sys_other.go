//go:build !linux

package share

import (
	"os"
	"syscall"
)

const errNoData = syscall.ENOATTR

type otherSystem struct{}

// OS is the real System; restow-share runs on Linux only, so here every call
// answers ErrUnsupported (the package still builds and vets on darwin).
func OS() System { return otherSystem{} }

func (otherSystem) Statfs(string) (int64, error)            { return 0, ErrUnsupported }
func (otherSystem) MountInfo() ([]byte, error)              { return nil, ErrUnsupported }
func (otherSystem) GetXattr(string, string) ([]byte, error) { return nil, ErrUnsupported }
func (otherSystem) SetXattr(string, string, []byte) error   { return ErrUnsupported }

// ctimeOf is the change time (ns since 1970) of a FileInfo from Lstat.
func ctimeOf(fi os.FileInfo) int64 {
	if st, ok := fi.Sys().(*syscall.Stat_t); ok {
		return st.Ctimespec.Sec*1e9 + st.Ctimespec.Nsec
	}
	return 0
}
