//go:build !windows

package pve

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// PVE reads the parameters of a DELETE from the query string; a form body is dropped.
func TestDeleteParametersGoIntoTheQueryString(t *testing.T) {
	var query, body string
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		data, _ := io.ReadAll(r.Body)
		query, body = r.URL.RawQuery, string(data)
		_ = json.NewEncoder(w).Encode(map[string]any{"data": nil})
	}))
	defer ts.Close()
	api, _ := NewPVEAPI(ts.URL, "restow@pve!t", "x", "", "")
	if err := api.call(context.Background(), http.MethodDelete, "/nodes/pve1/qemu/9001",
		map[string][]string{"purge": {"1"}, "destroy-unreferenced-disks": {"1"}}, nil); err != nil {
		t.Fatal(err)
	}
	if query != "destroy-unreferenced-disks=1&purge=1" || body != "" {
		t.Fatalf("query %q, body %q", query, body)
	}
}

func checkTask(t *testing.T, kind string) Task {
	t.Helper()
	params, _ := json.Marshal(map[string]any{"volname": "backup/" + kind + "/101/2030-01-01T00:00:00Z", "kind": kind,
		"targetStorage": "local-lvm", "restoreTest": true})
	return Task{ID: "t-check", Kind: "restore", Params: params}
}

// The restore check of a protected production VM: PVE copies protection (and onboot) into the
// restored copy; the check clears it and removes the guest, and says so only once it is gone.
func TestRestoreCheckRemovesAProtectedGuest(t *testing.T) {
	f := newFakeNode()
	f.restoreConfig = parseConfigText(vmConfig) // protection: 1, onboot: 1
	f.ctime = 1_900_000_100
	s := restoreService(t, f, "vm", vmConfig)
	result, err := s.task(context.Background(), checkTask(t, "vm"))
	if err != nil {
		t.Fatal(err)
	}
	if result["deleted"] != true || len(f.guests) != 0 {
		t.Fatalf("result %v, guests %v", result, f.guests)
	}
	all := strings.Join(f.commands, "\n")
	for _, want := range []string{"qm set 9001 --name restow-restorecheck-101 --tags restow-restorecheck --onboot 0 --protection 0",
		"qm destroy 9001 --purge 1 --destroy-unreferenced-disks 1 --skiplock 1"} {
		if !strings.Contains(all, want) {
			t.Fatalf("no %q in\n%s", want, all)
		}
	}
	if s.bootTester().readMarker(9001) != nil {
		t.Fatal("the marker stays")
	}
}

// A guest that cannot be removed: the check says so (deleted false, the VMID) and keeps the
// marker, so the next start of the service removes it.
func TestRestoreCheckSaysWhenItsGuestStays(t *testing.T) {
	f := newFakeNode()
	f.restoreConfig = parseConfigText(vmConfig)
	f.destroyFails = true
	s := restoreService(t, f, "vm", vmConfig)
	result, err := s.task(context.Background(), checkTask(t, "vm"))
	if err != nil {
		t.Fatal(err)
	}
	if result["deleted"] != false || result["leftoverVmid"] != 9001 {
		t.Fatalf("result %v", result)
	}
	if s.bootTester().readMarker(9001) == nil {
		t.Fatal("no marker for the leftover")
	}
	// The task's result was reported: it is no longer waited for.
	s.dropInflight("t-check")
	f.destroyFails = false
	s.bootTester().Cleanup(context.Background())
	if len(f.guests) != 0 {
		t.Fatal("the leftover is not removed")
	}
}

// The wait for the restore fails while PVE still restores: the check stops the restore task
// before it removes anything (no destroy under a running restore).
func TestRestoreCheckStopsARunningRestoreBeforeItRemovesTheGuest(t *testing.T) {
	f := newFakeNode()
	f.restoreConfig = parseConfigText(vmConfig)
	f.restoreRunning = true
	f.waitErr = errors.New("PVE API GET /nodes/pve1/tasks/x/status: 403 Permission check failed")
	s := restoreService(t, f, "vm", vmConfig)
	result, err := s.task(context.Background(), checkTask(t, "vm"))
	if err == nil || result["deleted"] != true {
		t.Fatalf("result %v, err %v", result, err)
	}
	if len(f.stoppedTasks) != 1 || len(f.guests) != 0 {
		t.Fatalf("stopped %v, guests %v", f.stoppedTasks, f.guests)
	}
	for _, c := range f.commands {
		if strings.HasPrefix(c, "stoptask") {
			break
		}
		if strings.HasPrefix(c, "qm destroy") {
			t.Fatalf("destroyed before the restore task stopped: %v", f.commands)
		}
	}
}

// Two restores got the same VMID from /cluster/nextid: the other guest is left alone, and the
// restore asks for another VMID.
func TestARestoreRetriesWhenItsVMIDWasTaken(t *testing.T) {
	f := newFakeNode()
	f.restoreConfig = parseConfigText(vmConfig)
	f.guests[9001] = &fakeGuest{kind: "vm", node: "pve2", pool: "restow-restore", conf: map[string]string{"name": "restow-boottest-55", "tags": BootTestTag}}
	f.ctime = 1_900_000_100
	s := restoreService(t, f, "vm", vmConfig)
	result, err := s.task(context.Background(), checkTask(t, "vm"))
	if err != nil || result["vmid"] != 9002 || result["deleted"] != true {
		t.Fatalf("result %v, err %v", result, err)
	}
	if _, ok := f.guests[9001]; !ok {
		t.Fatal("the other node's guest was removed")
	}
	// A boot test retries the same way, and a refused restore is an error, never red.
	f = newFakeNode()
	f.restoreConfig = parseConfigText(vmConfig)
	f.agentAfter = 1
	f.guests[9001] = &fakeGuest{kind: "vm", node: "pve2", pool: "restow-restore", conf: map[string]string{"name": "x"}}
	b := newTester(t, f)
	res, err := b.Run(context.Background(), vmParams())
	if err != nil || res.Outcome != "green" || res.TempVMID != 9002 {
		t.Fatalf("%+v %v", res, err)
	}
	f.restoreErr = &PVEAPIError{Status: 403, Message: "Permission check failed (/pool/restow-restore, VM.Allocate)"}
	res, err = b.Run(context.Background(), vmParams())
	if err == nil || res.Outcome != "" || !strings.Contains(res.Message, "the restore did not start") {
		t.Fatalf("%+v %v", res, err)
	}
	if _, ok := f.guests[9001]; !ok {
		t.Fatal("the other guest was removed")
	}
}

// Leftovers go when the service starts, also with boot tests and restores switched off.
func TestTheServiceRemovesLeftoversWhenItStartsWithEverythingOff(t *testing.T) {
	f := newFakeNode()
	f.guests[9100] = &fakeGuest{kind: "vm", node: "pve1", pool: "restow-restore", conf: map[string]string{"name": "restow-boottest-101", "tags": BootTestTag, "onboot": "1"}}
	f.guests[9101] = &fakeGuest{kind: "ct", node: "pve1", pool: "restow-restore", conf: map[string]string{"hostname": "restow-restorecheck-113", "tags": RestoreCheckTag}}
	s := restoreService(t, f, "vm", vmConfig)
	off := false
	s.State.BootTestsDisabled, s.State.AllowRestores = true, &off
	s.Server, _ = NewServer("http://127.0.0.1:1", "n", "s", true)
	s.Server.Attempts = 1
	s.Server.sleep = func(context.Context, time.Duration) error { return nil }
	s.PVE, _ = NewPVEAPI("http://127.0.0.1:1", "restow@pve!t", "x", "", "")
	s.Interval = time.Hour
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		_ = s.Run(ctx)
	}()
	for i := 0; i < 200; i++ {
		f.mu.Lock()
		n := len(f.guests)
		f.mu.Unlock()
		if n == 0 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	cancel()
	<-done
	if len(f.guests) != 0 {
		t.Fatalf("leftovers: %v", f.guests)
	}
}

// A restore check that ran when the service stopped is waited for again when it starts: the
// cleanup at the start leaves its guest to it, and it removes the guest when it ends.
func TestARestoreCheckIsWaitedForAgainAfterARestart(t *testing.T) {
	f := newFakeNode()
	f.restoreConfig = parseConfigText(vmConfig)
	f.restoreRunning = true
	f.waitErr = context.Canceled
	s := restoreService(t, f, "vm", vmConfig)
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // the service stops while the restore runs
	task := checkTask(t, "vm")
	s.runTask(ctx, task)
	if s.inflight(task.ID) == nil || len(f.guests) != 1 || len(f.stoppedTasks) != 0 {
		t.Fatalf("inflight %v, guests %v, stopped %v", s.inflight(task.ID), f.guests, f.stoppedTasks)
	}
	// The restore ended meanwhile; the service starts again.
	f.mu.Lock()
	f.waitErr, f.restoreRunning = nil, false
	for upid := range f.tasks {
		f.tasks[upid] = "stopped"
	}
	delete(f.guests[9001].conf, "lock")
	f.guests[9001].pool = "restow-restore"
	f.mu.Unlock()
	s.bootTester().Cleanup(context.Background())
	if len(f.guests) != 1 {
		t.Fatal("the cleanup removed the guest a recorded task waits for")
	}
	e := s.inflight(task.ID)
	result, err := s.resume(context.Background(), *e)
	if err != nil || result["deleted"] != true || len(f.guests) != 0 {
		t.Fatalf("result %v, err %v, guests %v", result, err, f.guests)
	}
}

// A boot test whose isolation fails before the tag is set: the restored VM is still removed,
// proven ours by the creation time its marker recorded.
func TestBootTestRemovesItsGuestWhenTheIsolationFailsAtOnce(t *testing.T) {
	f := newFakeNode()
	f.restoreConfig = parseConfigText(vmConfig)
	f.ctime = 1_900_000_200
	b := newTester(t, f)
	configs := 0
	b.Cmd = runnerFunc(func(ctx context.Context, name string, args ...string) (string, error) {
		if args[0] == "config" {
			configs++
			if configs == 1 {
				return "", errors.New("got timeout")
			}
		}
		return f.Run(ctx, name, args...)
	})
	res, err := b.Run(context.Background(), vmParams())
	if err == nil || res.Outcome != "" || !res.CleanedUp || len(f.guests) != 0 {
		t.Fatalf("%+v %v, guests %v", res, err, f.guests)
	}
}
