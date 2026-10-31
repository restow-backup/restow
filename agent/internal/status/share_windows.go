//go:build windows

package status

import (
	"github.com/restow-backup/restow/agent/internal/paths"
	"github.com/restow-backup/restow/agent/internal/winapi"
)

// shareStatusFile lets Users read the status file (it holds no secrets), so
// `restow-agent status` works without elevation. Its folder only lets them
// list it (paths.DataDirSDDL).
func shareStatusFile(path string) error {
	if paths.DevLayout() {
		return nil
	}
	return winapi.SetFileDACL(path, paths.StatusFileSDDL)
}
