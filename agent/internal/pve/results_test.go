//go:build !windows

package pve

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeVzdump is the part of the PVE API a backup task uses: it starts vzdump and ends it
// with `exit` and the task log `log`.
type fakeVzdump struct {
	mu      sync.Mutex
	running bool // the task runs on (its status says "running")
	exit    string
	log     []string
	forms   []url.Values
	starts  int
	// startAnswer is what POST vzdump answers ("" a UPID); resources what /cluster/resources
	// lists (resourcesFail: it fails); paths every path asked for.
	startAnswer   string
	resources     []Resource
	resourcesFail bool
	paths         []string
}

func (f *fakeVzdump) handler(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	answer := func(v any) { _ = json.NewEncoder(w).Encode(map[string]any{"data": v}) }
	f.paths = append(f.paths, r.Method+" "+r.URL.Path)
	switch {
	case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/vzdump"):
		body, _ := io.ReadAll(r.Body)
		form, _ := url.ParseQuery(string(body))
		f.forms = append(f.forms, form)
		f.starts++
		if f.startAnswer != "" {
			answer(f.startAnswer)
			return
		}
		answer("UPID:pve1:0001:vzdump:101:root@pam:")
	case strings.HasSuffix(r.URL.Path, "/cluster/resources") && f.resourcesFail:
		w.WriteHeader(http.StatusForbidden)
	case strings.HasSuffix(r.URL.Path, "/cluster/resources"):
		answer(f.resources)
	case strings.HasSuffix(r.URL.Path, "/status") && f.running:
		answer(map[string]any{"status": "running"})
	case strings.HasSuffix(r.URL.Path, "/status"):
		answer(map[string]any{"status": "stopped", "exitstatus": f.exit})
	case strings.HasSuffix(r.URL.Path, "/log"):
		lines := []map[string]string{}
		for _, l := range f.log {
			lines = append(lines, map[string]string{"t": l})
		}
		answer(lines)
	default:
		http.NotFound(w, r)
	}
}

// fakeResults is the Restow server's task result endpoint: it refuses `fail` results with 503,
// then takes them.
type fakeResults struct {
	mu   sync.Mutex
	fail        int
	got         []map[string]any
	ids         []string
	inventories int
}

func (f *fakeResults) handler(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if strings.HasSuffix(r.URL.Path, "/inventory") {
		f.inventories++
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if !strings.HasSuffix(r.URL.Path, "/result") {
		http.NotFound(w, r)
		return
	}
	if f.fail > 0 {
		f.fail--
		w.WriteHeader(http.StatusServiceUnavailable)
		return
	}
	var body map[string]any
	_ = json.NewDecoder(r.Body).Decode(&body)
	f.got = append(f.got, body)
	parts := strings.Split(r.URL.Path, "/")
	f.ids = append(f.ids, parts[len(parts)-2])
	w.WriteHeader(http.StatusNoContent)
}

func newTaskService(t *testing.T, vz *fakeVzdump, res *fakeResults) *Service {
	t.Helper()
	pveSrv := httptest.NewServer(http.HandlerFunc(vz.handler))
	t.Cleanup(pveSrv.Close)
	restow := httptest.NewServer(http.HandlerFunc(res.handler))
	t.Cleanup(restow.Close)
	api, err := NewPVEAPI(pveSrv.URL, "restow@pve!t", "x", "", "")
	if err != nil {
		t.Fatal(err)
	}
	srv, err := NewServer(restow.URL, "n", "s", true)
	if err != nil {
		t.Fatal(err)
	}
	srv.Attempts = 1
	srv.sleep = func(context.Context, time.Duration) error { return nil }
	dir := t.TempDir()
	return &Service{
		Layout: Layout{DataDir: dir + "/data", RunDir: dir + "/run"},
		State:  &State{NodeName: "pve1", StorageID: "restow"},
		Server: srv, PVE: api, Logf: func(string, ...any) {},
	}
}

func backupTask(id string) Task {
	return Task{ID: id, Kind: "backup", Params: json.RawMessage(`{"vmid":101}`)}
}

func TestStartBackupAsksForNoNotes(t *testing.T) {
	vz := &fakeVzdump{exit: "OK"}
	s := newTaskService(t, vz, &fakeResults{})
	if _, err := s.PVE.StartBackup(context.Background(), "pve1", 101, "restow", "snapshot", ""); err != nil {
		t.Fatal(err)
	}
	form := vz.forms[0]
	if _, ok := form["notes-template"]; ok {
		t.Fatalf("vzdump was asked for notes: %v", form)
	}
	if form.Get("storage") != "restow" || form.Get("vmid") != "101" {
		t.Fatalf("form = %v", form)
	}
}

func TestBackupEndingWithWarningsIsDoneAndCarriesThem(t *testing.T) {
	vz := &fakeVzdump{exit: "WARNINGS: 1", log: []string{
		"INFO: starting new backup job: vzdump 101 --storage restow",
		"INFO: restore point 0b5c committed",
		"WARN: unable to set notes - restow: notes of restore points are kept in Restow",
		"INFO: Backup job finished with errors",
		"TASK WARNINGS: 1",
	}}
	res := &fakeResults{}
	s := newTaskService(t, vz, res)
	s.runTask(context.Background(), backupTask("task-1"))
	if len(res.got) != 1 {
		t.Fatalf("results = %v", res.got)
	}
	got := res.got[0]
	if got["status"] != "done" {
		t.Fatalf("status = %v (%v)", got["status"], got["error"])
	}
	result := got["result"].(map[string]any)
	warnings := result["warnings"].([]any)
	if len(warnings) != 1 || !strings.Contains(warnings[0].(string), "unable to set notes") {
		t.Fatalf("warnings = %v", warnings)
	}
	if result["exitStatus"] != "WARNINGS: 1" {
		t.Fatalf("exit status = %v", result["exitStatus"])
	}
}

func TestBackupEndingWithAnErrorFails(t *testing.T) {
	vz := &fakeVzdump{exit: "job errors", log: []string{"ERROR: Backup of VM 101 failed - boom"}}
	res := &fakeResults{}
	s := newTaskService(t, vz, res)
	s.runTask(context.Background(), backupTask("task-1"))
	if len(res.got) != 1 || res.got[0]["status"] != "failed" || !strings.Contains(res.got[0]["error"].(string), "boom") {
		t.Fatalf("results = %v", res.got)
	}
}

func TestAResultTheServerCouldNotTakeIsSentLaterAndTheTaskNotRunAgain(t *testing.T) {
	vz := &fakeVzdump{exit: "OK"}
	res := &fakeResults{fail: 1}
	s := newTaskService(t, vz, res)
	s.runTask(context.Background(), backupTask("task-1"))
	if len(res.got) != 0 || !s.pendingResult("task-1") {
		t.Fatalf("the result is not kept: got %v", res.got)
	}
	// The server delivers the task again (it never saw the result): it is not run a second
	// time, the kept result is sent instead.
	s.runTask(context.Background(), backupTask("task-1"))
	if vz.starts != 1 {
		t.Fatalf("vzdump started %d times", vz.starts)
	}
	if len(res.got) != 1 || res.ids[0] != "task-1" || res.got[0]["status"] != "done" {
		t.Fatalf("results = %v", res.got)
	}
	if s.pendingResult("task-1") {
		t.Fatal("the result is still kept after the server took it")
	}
}

func TestKeptResultsGoFirstAndStayWhileTheServerIsAway(t *testing.T) {
	res := &fakeResults{fail: 100}
	s := newTaskService(t, &fakeVzdump{exit: "OK"}, res)
	s.reportResult(context.Background(), PendingResult{TaskID: "a", Status: "done"})
	s.reportResult(context.Background(), PendingResult{TaskID: "b", Status: "failed", Error: "x"})
	s.flushResults(context.Background())
	if got := s.loadPending(); len(got) != 2 {
		t.Fatalf("kept = %v", got)
	}
	res.mu.Lock()
	res.fail = 0
	res.mu.Unlock()
	s.flushResults(context.Background())
	if len(res.ids) != 2 || res.ids[0] != "a" || res.ids[1] != "b" {
		t.Fatalf("sent = %v", res.ids)
	}
	if got := s.loadPending(); len(got) != 0 {
		t.Fatalf("kept after sending = %v", got)
	}
}

func TestAResultTheServerRefusesForGoodIsNotKept(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/problem+json")
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"title":"Task not found"}`))
	}))
	t.Cleanup(srv.Close)
	s := newTaskService(t, &fakeVzdump{exit: "OK"}, &fakeResults{})
	server, _ := NewServer(srv.URL, "n", "s", true)
	server.Attempts = 1
	s.Server = server
	s.reportResult(context.Background(), PendingResult{TaskID: "gone", Status: "done"})
	if s.pendingResult("gone") {
		t.Fatal("a refused result is kept")
	}
}

func TestSMBIOSUUIDAndWarningLines(t *testing.T) {
	if got := SMBIOSUUID(map[string]any{"smbios1": "uuid=7B0E3C5A-1D2F-4E6A-9B8C-0D1E2F3A4B5C,manufacturer=QEMU"}); got != "7b0e3c5a-1d2f-4e6a-9b8c-0d1e2f3a4b5c" {
		t.Fatalf("uuid = %q", got)
	}
	for _, conf := range []map[string]any{{}, {"smbios1": "manufacturer=x"}, {"smbios1": "uuid=nope"}} {
		if got := SMBIOSUUID(conf); got != "" {
			t.Fatalf("uuid of %v = %q", conf, got)
		}
	}
	if !TaskWarnings("WARNINGS: 2") || !TaskWarnings(" warnings: 13 ") || TaskWarnings("OK") || TaskWarnings("job errors") ||
		TaskWarnings("WARNINGS") || TaskWarnings("WARNINGS: 1, and an error") {
		t.Fatal("TaskWarnings")
	}
	lines := WarningLines("INFO: a\nWARN: one\nwarning: two\nTASK WARNINGS: 2\n", 10)
	if len(lines) != 2 || lines[0] != "WARN: one" {
		t.Fatalf("lines = %v", lines)
	}
}

// restow-pve stops while vzdump runs (systemctl restart, the installer, a self-update): the task
// is not reported failed, which would close the healthy backup's run in Restow. The service
// waits for the vzdump task again when it starts and reports how it really ended.
func TestAServiceStopDuringABackupReportsNothingAndTheRestartWaitsAgain(t *testing.T) {
	vz := &fakeVzdump{running: true, exit: "OK"}
	res := &fakeResults{}
	s := newTaskService(t, vz, res)
	s.PVE.sleep = func(ctx context.Context, d time.Duration) error {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(time.Millisecond):
			return nil
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		s.runTask(ctx, backupTask("task-1"))
	}()
	for i := 0; i < 500 && s.inflight("task-1") == nil; i++ {
		time.Sleep(5 * time.Millisecond)
	}
	cancel()
	<-done
	res.mu.Lock()
	got := len(res.got)
	res.mu.Unlock()
	if got != 0 || len(s.loadPending()) != 0 {
		t.Fatalf("a result was reported or kept: %v %v", res.got, s.loadPending())
	}
	e := s.inflight("task-1")
	if e == nil || e.UPID != "UPID:pve1:0001:vzdump:101:root@pam:" || e.Kind != "backup" || e.VMID != 101 {
		t.Fatalf("inflight %+v", e)
	}

	// vzdump finished meanwhile; the service starts again.
	vz.mu.Lock()
	vz.running = false
	vz.mu.Unlock()
	s.Interval, s.BusyInterval = 10*time.Millisecond, 10*time.Millisecond
	ctx, cancel = context.WithCancel(context.Background())
	defer cancel()
	stopped := make(chan struct{})
	go func() {
		defer close(stopped)
		_ = s.Run(ctx)
	}()
	for i := 0; i < 500; i++ {
		res.mu.Lock()
		got = len(res.got)
		res.mu.Unlock()
		if got > 0 {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	cancel()
	<-stopped
	if len(res.got) != 1 || res.got[0]["status"] != "done" || res.ids[0] != "task-1" {
		t.Fatalf("results = %v %v", res.ids, res.got)
	}
	if vz.starts != 1 {
		t.Fatalf("vzdump started %d times", vz.starts)
	}
	if s.inflight("task-1") != nil {
		t.Fatal("the task is still kept as running")
	}
}

// vzdump answers "OK" and starts nothing for a guest that is not on the node: it migrated after
// the last inventory, or it is gone. The task says so (never WaitTask on "OK"), asks for the
// inventory at once, and leaves no full-read request behind.
func TestBackupOfAGuestThatIsNoLongerOnTheNode(t *testing.T) {
	for _, tc := range []struct {
		name      string
		resources []Resource
		fail      bool
		want      string
		inventory int
	}{
		{"migrated", []Resource{{VMID: 101, Type: "lxc", Node: "pve2"}, {VMID: 102, Type: "qemu", Node: "pve1"}},
			false, "guest 101 now runs on node pve2; Restow backs it up there after the next inventory", 1},
		{"gone", []Resource{{VMID: 102, Type: "qemu", Node: "pve1"}}, false, "guest 101 was not found in the cluster", 0},
		{"unknown", nil, true, "vzdump started no task; guest 101 is probably no longer on node pve1", 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			vz := &fakeVzdump{startAnswer: "OK", resources: tc.resources, resourcesFail: tc.fail}
			res := &fakeResults{}
			s := newTaskService(t, vz, res)
			_, err := s.task(context.Background(), Task{ID: "t1", Kind: "backup", Params: json.RawMessage(`{"vmid":101,"verifyRead":true}`)})
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err = %v, want %q", err, tc.want)
			}
			for _, p := range vz.paths {
				if strings.Contains(p, "/tasks/") {
					t.Fatalf("a task was waited for or stopped: %v", vz.paths)
				}
			}
			if res.inventories != tc.inventory {
				t.Fatalf("%d inventories sent", res.inventories)
			}
			if _, err := os.Stat(s.Layout.forceNewFile(101)); !os.IsNotExist(err) {
				t.Fatalf("the full-read request stayed behind: %v", err)
			}
			if s.inflight("t1") != nil {
				t.Fatal("a task that started nothing is kept as in flight")
			}
		})
	}
}

func TestRestoreThatStartsNoTaskFails(t *testing.T) {
	vz := &fakeVzdump{}
	s := newTaskService(t, vz, &fakeResults{})
	pveSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"data": "OK"})
	}))
	t.Cleanup(pveSrv.Close)
	api, err := NewPVEAPI(pveSrv.URL, "restow@pve!t", "x", "", "")
	if err != nil {
		t.Fatal(err)
	}
	s.PVE = api
	_, err = s.PVE.RestoreGuest(context.Background(), "pve1", "vm", 9001, "restow:backup/vm/101/x", "local-lvm", "restow-restore", nil)
	var none *NoTaskError
	if !errors.As(err, &none) || none.Answer != "OK" {
		t.Fatalf("err = %v", err)
	}
}
