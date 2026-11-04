//go:build !windows

package pve

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
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

// plainVMConfig is a VM without anything only root@pam may restore: the token restores it.
const plainVMConfig = `boot: order=scsi0
cores: 2
memory: 4096
name: web01
net0: virtio=BC:24:11:00:00:01,bridge=vmbr0,firewall=1
onboot: 1
protection: 1
scsi0: local-lvm:vm-101-disk-0,size=32G
`

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
	f.restoreConfig = parseConfigText(plainVMConfig) // protection: 1, onboot: 1
	f.ctime = 1_900_000_100
	s := restoreService(t, f, "vm", plainVMConfig)
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
	f.restoreConfig = parseConfigText(plainVMConfig)
	f.destroyFails = true
	s := restoreService(t, f, "vm", plainVMConfig)
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
	f.restoreConfig = parseConfigText(plainVMConfig)
	f.restoreRunning = true
	f.waitErr = errors.New("PVE API GET /nodes/pve1/tasks/x/status: 403 Permission check failed")
	s := restoreService(t, f, "vm", plainVMConfig)
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
	f.restoreConfig = parseConfigText(plainVMConfig)
	f.guests[9001] = &fakeGuest{kind: "vm", node: "pve2", pool: "restow-restore", conf: map[string]string{"name": "restow-boottest-55", "tags": BootTestTag}}
	f.ctime = 1_900_000_100
	s := restoreService(t, f, "vm", plainVMConfig)
	result, err := s.task(context.Background(), checkTask(t, "vm"))
	if err != nil || result["vmid"] != 9002 || result["deleted"] != true {
		t.Fatalf("result %v, err %v", result, err)
	}
	if _, ok := f.guests[9001]; !ok {
		t.Fatal("the other node's guest was removed")
	}
	// A boot test retries the same way, and a refused restore is an error, never red.
	f = newFakeNode()
	f.restoreConfig = parseConfigText(plainVMConfig)
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
	f.restoreConfig = parseConfigText(plainVMConfig)
	f.restoreRunning = true
	f.waitErr = context.Canceled
	s := restoreService(t, f, "vm", plainVMConfig)
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

// The node reboots during a restore check, which had restored its guest but not yet tagged it:
// when the service starts, pveproxy does not answer yet. That proves nothing either way, so the
// marker stays (the guest is never touched meanwhile), and the worker tries again until the API
// answers and the guest, proven ours by its creation time, is gone.
func TestALeftoverIsRemovedOnceThePVEAPIAnswersAgain(t *testing.T) {
	f := newFakeNode()
	f.guests[9200] = &fakeGuest{kind: "vm", node: "pve1", pool: "restow-restore", status: "stopped",
		conf: map[string]string{"name": "web01", "onboot": "1", "meta": "creation-qemu=9.0.2,ctime=1900000100"}}
	f.tasks = map[string]string{"UPID:pve1:1:2:3:qmrestore:9200:restow@pve!pve1:": "stopped"}
	f.guestsErr = errors.New("PVE API GET /cluster/resources: dial tcp 127.0.0.1:8006: connect: connection refused")
	s := restoreService(t, f, "vm", vmConfig)
	b := s.bootTester()
	_ = b.writeMarker(tempMarker{VMID: 9200, Kind: "vm", Purpose: PurposeRestoreCheck,
		UPID: "UPID:pve1:1:2:3:qmrestore:9200:restow@pve!pve1:", CTime: 1900000100})
	if b.Cleanup(context.Background()) {
		t.Fatal("the cleanup reports done although the cluster could not be asked")
	}
	if b.readMarker(9200) == nil || f.guests[9200] == nil {
		t.Fatalf("marker %v, guest %v: an unreadable cluster dropped the marker or removed the guest", b.readMarker(9200), f.guests[9200])
	}
	for _, c := range f.commandsFor(9200) {
		if !strings.HasPrefix(c, "qm config") {
			t.Fatalf("the guest was touched: %v", f.commandsFor(9200))
		}
	}
	// The configuration cannot be read either (a 5xx): still kept.
	f.mu.Lock()
	f.guestsErr = nil
	f.mu.Unlock()
	b.PVE = configFails{f}
	if b.Cleanup(context.Background()) || b.readMarker(9200) == nil || f.guests[9200] == nil {
		t.Fatal("an unreadable configuration dropped the marker or removed the guest")
	}

	// The service: its first cleanup finds the API down, the worker tries again.
	b.PVE = f
	f.mu.Lock()
	f.guestsErr = errors.New("PVE API answered 595: Connection refused")
	f.mu.Unlock()
	old := cleanupRetry
	cleanupRetry.Min, cleanupRetry.Max = 5*time.Millisecond, 20*time.Millisecond
	t.Cleanup(func() { cleanupRetry = old })
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if !b.Cleanup(ctx) {
		s.setCleanupPending(true)
	}
	done := make(chan struct{})
	go func() { defer close(done); s.work(ctx) }()
	time.Sleep(30 * time.Millisecond)
	if f.guestCount() != 1 || b.readMarker(9200) == nil {
		t.Fatal("removed or forgotten while the API was down")
	}
	f.mu.Lock()
	f.guestsErr = nil
	f.mu.Unlock()
	for i := 0; i < 400 && (f.guestCount() != 0 || s.isCleanupPending()); i++ {
		time.Sleep(5 * time.Millisecond)
	}
	cancel()
	<-done
	if f.guestCount() != 0 || b.readMarker(9200) != nil || s.isCleanupPending() {
		t.Fatalf("guests %v, marker %v, pending %v", f.guests, b.readMarker(9200), s.isCleanupPending())
	}
}

// statusCalls counts the fake node's TaskStatus calls.
type statusCalls struct {
	*fakeNode
	n int
}

func (c *statusCalls) TaskStatus(ctx context.Context, node, upid string) (TaskStatus, error) {
	c.n++
	return c.fakeNode.TaskStatus(ctx, node, upid)
}

// configFails is the fake node whose API cannot read a guest's configuration.
type configFails struct{ *fakeNode }

func (configFails) GuestConfig(context.Context, string, string, int) (map[string]any, error) {
	return nil, &PVEAPIError{Status: 500, Message: "500 got timeout"}
}

func (f *fakeNode) guestCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.guests)
}

// A guest a VM restore as root still creates (qmrestore of a VM with passthrough; its task is
// root@pam's): the node's token may not stop that task (403, Sys.Modify), so the removal stops
// it as root through pvesh, and destroys the guest only once it has ended. When that fails too,
// nothing is destroyed under the running restore, the marker stays, and the removal does not
// wait two minutes for a stop that was never made.
func TestTheRemovalStopsARootRestoreTaskAsRoot(t *testing.T) {
	const upid = "UPID:pve1:0000CCCC:00DDDDDD:70000001:qmrestore:9001:root@pam:"
	setup := func() (*fakeNode, *BootTester) {
		f := newFakeNode()
		f.guests[9001] = &fakeGuest{kind: "vm", node: "pve1", status: "stopped",
			conf: map[string]string{"name": "plex", "lock": "create", "hostpci0": "mapping=gpu"}}
		f.tasks = map[string]string{upid: "running"}
		b := newTester(t, f)
		b.State.PVETokenID = "restow@pve!pve1"
		_ = b.writeMarker(tempMarker{VMID: 9001, Kind: "vm", Purpose: PurposeBootTest, UPID: upid, StartedAt: "2030-01-01T00:00:00Z"})
		return f, b
	}
	f, b := setup()
	if !b.removeTemp(context.Background(), "vm", 9001) || f.guestCount() != 0 {
		t.Fatalf("guests %v", f.guests)
	}
	if fmt.Sprint(f.stoppedBy) != "[root]" || !strings.Contains(strings.Join(f.commands, "\n"), "pvesh delete /nodes/pve1/tasks/"+upid) {
		t.Fatalf("stopped by %v, commands %v", f.stoppedBy, f.commands)
	}

	f, b = setup()
	f.pveshFails = true
	counted := &statusCalls{fakeNode: f}
	b.PVE = counted
	if b.removeTemp(context.Background(), "vm", 9001) {
		t.Fatal("removed although its restore task still runs")
	}
	if counted.n > 2 {
		// owned() and stopTask ask once each; a wait for the stop would poll on.
		t.Fatalf("asked %d times for the state of a task whose stop failed", counted.n)
	}
	if f.guests[9001] == nil || b.readMarker(9001) == nil || f.tasks[upid] != "running" {
		t.Fatalf("guest %v, marker %v, task %s", f.guests[9001], b.readMarker(9001), f.tasks[upid])
	}
	for _, c := range f.commands {
		if strings.HasPrefix(c, "qm destroy") || strings.HasPrefix(c, "qm unlock") {
			t.Fatalf("touched under the running restore: %v", f.commands)
		}
	}
	// Root's pvesh works again: the next try removes it.
	f.pveshFails = false
	if !b.Cleanup(context.Background()) || f.guestCount() != 0 {
		t.Fatalf("guests %v", f.guests)
	}
}

// The state of the restore task cannot be read: the guest is not destroyed (the restore may run).
func TestTheRemovalWaitsWhenTheRestoreTaskIsUnknown(t *testing.T) {
	f := newFakeNode()
	f.guests[9001] = &fakeGuest{kind: "vm", node: "pve1", pool: "restow-restore", status: "stopped",
		conf: map[string]string{"name": "restow-boottest-101", "tags": BootTestTag}}
	b := newTester(t, f)
	_ = b.writeMarker(tempMarker{VMID: 9001, Kind: "vm", Purpose: PurposeBootTest, StartedAt: "2030-01-01T00:00:00Z"})
	f.activeTasksErr = errors.New("PVE API answered 500: got timeout")
	if b.removeTemp(context.Background(), "vm", 9001) || f.guests[9001] == nil || b.readMarker(9001) == nil {
		t.Fatalf("guest %v, marker %v", f.guests[9001], b.readMarker(9001))
	}
	f.activeTasksErr = nil
	if !b.removeTemp(context.Background(), "vm", 9001) || f.guestCount() != 0 {
		t.Fatalf("guests %v", f.guests)
	}
}
