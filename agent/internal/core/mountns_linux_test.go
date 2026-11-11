//go:build linux

package core

import (
	"os"
	"os/exec"
	"reflect"
	"strings"
	"sync"
	"syscall"
	"testing"

	"github.com/restow-backup/restow/agent/internal/api"
	"github.com/restow-backup/restow/agent/internal/fssnap"
)

var unshareMounts struct {
	once sync.Once
	ok   bool
}

// mayUnshareMounts reports whether this process may start a child in a new
// mount namespace (CAP_SYS_ADMIN: root outside a restricted container). It
// asks the kernel instead of the user id: root in a container without the
// capability may not, and that is what counts.
func mayUnshareMounts() bool {
	unshareMounts.once.Do(func() {
		cmd := exec.Command("/bin/sh", "-c", "exit 0")
		cmd.SysProcAttr = &syscall.SysProcAttr{Unshareflags: syscall.CLONE_NEWNS}
		unshareMounts.ok = cmd.Run() == nil
	})
	return unshareMounts.ok
}

func ownMountNS(t *testing.T) string {
	t.Helper()
	ns, err := os.Readlink("/proc/self/ns/mnt")
	if err != nil {
		t.Fatal(err)
	}
	return ns
}

// The real backend always starts the helper in a mount namespace of its
// own: it mounts the snapshot tree there.
func TestRealHelperCommandAsksForAMountNamespace(t *testing.T) {
	l := &linuxFS{helper: fssnap.ExecHelper{AgentBin: "/usr/local/bin/restow-agent"}}
	argv, mountNS := l.HelperCommand("/run/restow/spec.json")
	if !mountNS {
		t.Error("the real helper does not ask for its own mount namespace")
	}
	if want := fssnap.HelperArgv("/usr/local/bin/restow-agent", "/run/restow/spec.json", []string{}); !reflect.DeepEqual(argv, want) {
		t.Errorf("argv %v, want %v", argv, want)
	}
}

// A backup through the helper works for whoever runs the tests: where the
// process may make a mount namespace the helper gets its own, elsewhere
// (a normal user, as in the CI job of the unit tests) it runs in the
// namespace of the agent. Before, the stand-in helper always asked for
// one, and these tests failed for every user but root with "fork/exec
// ...: operation not permitted".
func TestHelperMountNamespaceFollowsThePrivilege(t *testing.T) {
	h := newHarness(t)
	withFakeFS(t, h)
	fin := fsBackup(t, h, "ok", "")
	if fin.Status != api.StatusSucceeded || len(fin.Errors) != 0 {
		t.Fatalf("%s %+v", fin.Status, fin.Errors)
	}
	helper := strings.TrimSpace(readFake(t, h, "helper-mntns.txt"))
	if helper == "" {
		t.Fatal("the helper did not record its mount namespace")
	}
	if own := ownMountNS(t); (helper != own) != mayUnshareMounts() {
		t.Errorf("helper in %s, test in %s, may unshare %v", helper, own, mayUnshareMounts())
	}
	// Asking for a namespace without the privilege fails the backup, as
	// the kernel refuses it: that is why Probe lets the helper run only as
	// root.
	if !mayUnshareMounts() {
		h = newHarness(t)
		f := withFakeFS(t, h)
		yes := true
		f.mountNS = &yes
		fin = fsBackup(t, h, "ok", "")
		if fin.Status != api.StatusFailed || len(fin.Errors) == 0 || !strings.Contains(fin.Errors[0].Message, "operation not permitted") {
			t.Errorf("a mount namespace without the privilege: %s %+v", fin.Status, fin.Errors)
		}
	}
}
