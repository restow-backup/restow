package dbrun

import (
	"runtime"

	"github.com/restow-backup/restow/agent/internal/api"
)

// CodePlatformUnsupported: PostgreSQL backups and restores by an agent on
// Windows come later (docs/DATABASES.md E7). The relay's socket folder and
// password file are protected by Unix modes, which Windows does not enforce;
// the server plans no run for such an agent and refuses "Jetzt sichern".
const CodePlatformUnsupported = "db_platform_unsupported"

// platformSupported is false where runs are refused (a variable for tests).
var platformSupported = runtime.GOOS != "windows"

// refusePlatform is the report of a run on a platform without runs.
func refusePlatform() (api.DBRunFinish, bool) {
	if platformSupported {
		return api.DBRunFinish{}, false
	}
	return api.DBRunFinish{
		Status:  "failed",
		Backups: []api.DBRunBackup{},
		Notes:   []map[string]any{},
		Error:   &api.DBProbeError{Code: CodePlatformUnsupported, Message: "Backups and restores of PostgreSQL by an agent on " + runtime.GOOS + " come with a later version."},
	}, true
}
