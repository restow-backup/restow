package share

import (
	"os"
	"syscall"
)

// errNoData only has to be some Errno: restow-share runs on Linux only, and on
// Windows every System call answers ErrUnsupported (the package still builds
// and vets for the Windows agent).
const errNoData = syscall.ERROR_NOT_FOUND

type otherSystem struct{}

// OS is the real System; see sys_other.go.
func OS() System { return otherSystem{} }

func (otherSystem) Statfs(string) (int64, error)            { return 0, ErrUnsupported }
func (otherSystem) MountInfo() ([]byte, error)              { return nil, ErrUnsupported }
func (otherSystem) GetXattr(string, string) ([]byte, error) { return nil, ErrUnsupported }
func (otherSystem) SetXattr(string, string, []byte) error   { return ErrUnsupported }

// ctimeOf has no change time to offer on Windows.
func ctimeOf(os.FileInfo) int64 { return 0 }
