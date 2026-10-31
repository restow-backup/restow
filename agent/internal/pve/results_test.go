//go:build !windows

package pve

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeVzdump is the part of the PVE API a backup task uses: it starts vzdump and ends it
// with `exit` and the task log `log`.
type fakeVzdump struct {
	mu     sync.Mutex
	exit   string
	log    []string
	forms  []url.Values
	starts int
}

func (f *fakeVzdump) handler(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	answer := func(v any) { _ = json.NewEncoder(w).Encode(map[string]any{"data": v}) }
	switch {
	case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/vzdump"):
		body, _ := io.ReadAll(r.Body)
		form, _ := url.ParseQuery(string(body))
		f.forms = append(f.forms, form)
		f.starts++
		answer("UPID:pve1:0001:vzdump:101:root@pam:")
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
	fail int
	got  []map[string]any
	ids  []string
}

func (f *fakeResults) handler(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
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
	if !VzdumpWarnings("WARNINGS: 2") || VzdumpWarnings("OK") || VzdumpWarnings("job errors") {
		t.Fatal("VzdumpWarnings")
	}
	lines := WarningLines("INFO: a\nWARN: one\nwarning: two\nTASK WARNINGS: 2\n", 10)
	if len(lines) != 2 || lines[0] != "WARN: one" {
		t.Fatalf("lines = %v", lines)
	}
}
