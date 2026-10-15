package core

import (
	"reflect"
	"sync/atomic"
	"testing"
	"time"

	"github.com/restow-backup/restow/agent/internal/api"
	"github.com/restow-backup/restow/agent/internal/sysinfo"
	"github.com/restow-backup/restow/agent/internal/testutil/fakeserver"
)

// The heartbeat says what the machine is and which data folders it has
// (#59); the agent looks again only after machineRefresh.
func TestHeartbeatReportsTheMachine(t *testing.T) {
	h := newHarness(t)
	var looks atomic.Int32
	h.machine = func() sysinfo.Machine {
		looks.Add(1)
		return sysinfo.Machine{Virtualization: sysinfo.VirtVM, Technology: "kvm", DataFolders: []string{"/opt", "/var/lib/mysql"}}
	}
	h.start()
	if !fakeserver.WaitFor(10*time.Second, func() bool { return h.srv.HeartbeatCount() >= 3 }) {
		t.Fatal("no heartbeats")
	}
	h.srv.Lock()
	first := h.srv.Heartbeats[0]
	h.srv.Unlock()
	want := &api.MachineFacts{Virtualization: "vm", Technology: "kvm"}
	if !reflect.DeepEqual(first.Machine, want) {
		t.Fatalf("machine = %+v", first.Machine)
	}
	if !reflect.DeepEqual(first.DataFolders, []string{"/opt", "/var/lib/mysql"}) {
		t.Fatalf("data folders = %v", first.DataFolders)
	}
	if n := looks.Load(); n != 1 {
		t.Fatalf("looked at the machine %d times within the hour", n)
	}
}
