//go:build linux && agentroot

package core

// As root (CI job agent-root, RESTOW_AGENT_ROOT=1): what a normal user
// cannot do and the unit tests therefore do not rely on.

import (
	"os"
	"strings"
	"testing"

	"github.com/restow-backup/restow/agent/internal/api"
)

// TestRootHelperGetsItsOwnMountNamespace: restic through the snapshot
// helper starts in a new mount namespace, so nothing the helper mounts
// reaches the machine (docs/BAREMETAL.md 6.3).
func TestRootHelperGetsItsOwnMountNamespace(t *testing.T) {
	if os.Getenv("RESTOW_AGENT_ROOT") != "1" {
		t.Skip("agent-root test: set RESTOW_AGENT_ROOT=1 and run as root (CI job agent-root)")
	}
	if os.Geteuid() != 0 {
		t.Fatal("RESTOW_AGENT_ROOT=1 without root")
	}
	h := newHarness(t)
	f := withFakeFS(t, h)
	yes := true
	f.mountNS = &yes
	fin := fsBackup(t, h, "ok", "")
	if fin.Status != api.StatusSucceeded || len(fin.Errors) != 0 {
		t.Fatalf("%s %+v", fin.Status, fin.Errors)
	}
	helper := strings.TrimSpace(readFake(t, h, "helper-mntns.txt"))
	if own := ownMountNS(t); helper == "" || helper == own {
		t.Errorf("the helper ran in the mount namespace %q, the agent in %q", helper, own)
	}
}
