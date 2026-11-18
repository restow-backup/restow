//go:build linux

package oneshot

import (
	"testing"

	"github.com/restow-backup/restow/agent/internal/paths"
	"github.com/restow-backup/restow/agent/internal/pve"
)

// The wrong-machine guard knows every state an enrolled Restow agent leaves.
func TestStateFilesAreTheAgentsAndThePVEHelpers(t *testing.T) {
	t.Setenv(paths.EnvAgentDir, "")
	t.Setenv("RESTOW_PVE_ROOT", "")
	want := map[string]bool{paths.Default().StateFile(): true, pve.DefaultLayout().StateFile: true}
	if len(StateFiles) != len(want) {
		t.Fatalf("StateFiles %v, want %v", StateFiles, want)
	}
	for _, f := range StateFiles {
		if !want[f] {
			t.Errorf("%s is no state file of an agent (want %v)", f, want)
		}
	}
}
