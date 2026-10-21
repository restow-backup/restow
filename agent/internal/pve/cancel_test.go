package pve

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// cancelNode is the Restow server and the local PVE API of one node, as far as the service loop
// needs them: heartbeats answer from `beats`, task results are kept, and vzdump runs until
// its task is stopped (DELETE).
type cancelNode struct {
	mu       sync.Mutex
	beats    []map[string]any // answered in turn; the last one again and again
	states   []string         // the `state` of every heartbeat
	results  map[string]map[string]any
	deleted  []string
	vzdumps  int
	active   []NodeTask
	stopped  bool
	restow   *httptest.Server
	pveAPI   *httptest.Server
	finished chan struct{}
}

const testUPID = "UPID:pve1:00001234:00000001:65000000:vzdump:101:restow@pve!restow:"

func newCancelNode(t *testing.T, beats ...map[string]any) *cancelNode {
	t.Helper()
	f := &cancelNode{beats: beats, results: map[string]map[string]any{}, finished: make(chan struct{}, 8)}
	f.restow = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := strings.TrimPrefix(r.URL.Path, "/agent/pve/v1")
		w.Header().Set("content-type", "application/json")
		f.mu.Lock()
		defer f.mu.Unlock()
		switch {
		case path == "/heartbeat":
			var in map[string]any
			_ = json.NewDecoder(r.Body).Decode(&in)
			state, _ := in["state"].(string)
			f.states = append(f.states, state)
			answer := map[string]any{"tasks": []any{}, "storageId": "restow", "usage": map[string]any{}}
			if len(f.beats) > 0 {
				answer = f.beats[0]
				if len(f.beats) > 1 {
					f.beats = f.beats[1:]
				}
			}
			_ = json.NewEncoder(w).Encode(answer)
		case strings.HasPrefix(path, "/tasks/") && strings.HasSuffix(path, "/result"):
			var in map[string]any
			_ = json.NewDecoder(r.Body).Decode(&in)
			f.results[strings.TrimSuffix(strings.TrimPrefix(path, "/tasks/"), "/result")] = in
			w.WriteHeader(http.StatusNoContent)
			f.finished <- struct{}{}
		case path == "/listing":
			_, _ = io.WriteString(w, `{"volumes":[]}`)
		default:
			_, _ = io.WriteString(w, `{}`)
		}
	}))
	f.pveAPI = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		reply := func(data any) { _ = json.NewEncoder(w).Encode(map[string]any{"data": data}) }
		p := r.URL.Path
		switch {
		case p == "/api2/json/version":
			reply(map[string]any{"version": "9.2.1"})
		case p == "/api2/json/access/permissions":
			reply(map[string]any{"/": map[string]int{"VM.Audit": 1, "VM.Backup": 1, "Datastore.Audit": 1,
				"Datastore.AllocateSpace": 1, "Sys.Audit": 1}})
		case p == "/api2/json/nodes/pve1/storage":
			reply([]map[string]any{{"storage": "local-lvm", "active": 1}})
		case p == "/api2/json/cluster/resources":
			reply([]any{})
		case p == "/api2/json/nodes/pve1/vzdump" && r.Method == http.MethodPost:
			f.vzdumps++
			reply(testUPID)
		case strings.HasSuffix(p, "/status") && strings.Contains(p, "/tasks/"):
			if f.stopped {
				reply(map[string]any{"status": "stopped", "exitstatus": "interrupted by signal"})
			} else {
				reply(map[string]any{"status": "running"})
			}
		case strings.HasSuffix(p, "/log") && strings.Contains(p, "/tasks/"):
			reply([]map[string]any{{"t": "INFO: interrupted by signal"}})
		case strings.HasPrefix(p, "/api2/json/nodes/pve1/tasks/") && r.Method == http.MethodDelete:
			f.deleted = append(f.deleted, strings.TrimPrefix(p, "/api2/json/nodes/pve1/tasks/"))
			f.stopped = true
			reply(nil)
		case p == "/api2/json/nodes/pve1/tasks":
			reply(f.active)
		default:
			reply(nil)
		}
	}))
	t.Cleanup(func() { f.restow.Close(); f.pveAPI.Close() })
	return f
}

func (f *cancelNode) service(t *testing.T) *Service {
	t.Helper()
	root := t.TempDir()
	srv, err := NewServer(f.restow.URL, "node-1", "secret", true)
	if err != nil {
		t.Fatal(err)
	}
	api, err := NewPVEAPI(f.pveAPI.URL, "restow@pve!restow", "x", "", "")
	if err != nil {
		t.Fatal(err)
	}
	for _, d := range []string{"data/cache", "run"} {
		_ = os.MkdirAll(filepath.Join(root, d), 0o700)
	}
	return &Service{
		Layout: Layout{DataDir: filepath.Join(root, "data"), RunDir: filepath.Join(root, "run"),
			PluginDir: root, ProviderDir: root},
		State: &State{NodeName: "pve1", StorageID: "restow", FleecingStorage: "local-lvm",
			BootTestsDisabled: true},
		Server: srv, PVE: api,
		Logf:     func(f string, a ...any) { t.Logf(f, a...) },
		Interval: 20 * time.Millisecond, BusyInterval: 20 * time.Millisecond,
		InventoryEvery: time.Hour,
	}
}

func backupTask(id string) map[string]any {
	return map[string]any{"id": id, "kind": "backup", "params": map[string]any{"vmid": 101}}
}

func TestCancelOrderStopsTheRunningVzdumpTask(t *testing.T) {
	f := newCancelNode(t,
		map[string]any{"tasks": []any{backupTask("task-1")}},
		map[string]any{"tasks": []any{}, "cancel": map[string]any{"tasks": []string{"task-1"}, "runs": []any{}}},
	)
	s := f.service(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = s.Run(ctx) }()
	select {
	case <-f.finished:
	case <-time.After(20 * time.Second):
		t.Fatal("the task never ended")
	}
	cancel()
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.deleted) != 1 || !strings.Contains(f.deleted[0], "vzdump") {
		t.Fatalf("stopped tasks = %v, want the vzdump task once", f.deleted)
	}
	res := f.results["task-1"]
	if res["status"] != "failed" || !strings.HasPrefix(res["error"].(string), "cancelled in Restow") {
		t.Fatalf("result = %v", res)
	}
	// The heartbeat went on while the backup ran, saying so.
	running := 0
	for _, st := range f.states {
		if st == "running" {
			running++
		}
	}
	if running == 0 {
		t.Fatalf("no heartbeat while the task ran: %v", f.states)
	}
}

func TestCancelOrderDropsAQueuedTask(t *testing.T) {
	f := newCancelNode(t)
	s := f.service(t)
	s.enqueue([]Task{{ID: "task-2", Kind: "backup", Params: json.RawMessage(`{"vmid":101}`)}})
	if !s.Busy() {
		t.Fatal("a queued task makes the node busy")
	}
	s.applyCancel(context.Background(), &CancelOrders{Tasks: []string{"task-2"}})
	if s.Busy() {
		t.Fatal("the cancelled task is still queued")
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.results["task-2"]["status"] != "failed" || f.results["task-2"]["error"] != "cancelled in Restow" {
		t.Fatalf("result = %v", f.results["task-2"])
	}
	if f.vzdumps != 0 {
		t.Fatal("vzdump started for a cancelled task")
	}
}

func TestCancelledTaskNeverStartsVzdump(t *testing.T) {
	f := newCancelNode(t)
	s := f.service(t)
	s.mu.Lock()
	s.lazyLocked()
	s.cur = &current{id: "task-3", kind: "backup"}
	s.mu.Unlock()
	// The order arrives before vzdump was started.
	s.applyCancel(context.Background(), &CancelOrders{Tasks: []string{"task-3"}})
	_, err := s.task(context.Background(), Task{ID: "task-3", Kind: "backup", Params: json.RawMessage(`{"vmid":101}`)})
	if err != ErrCancelled {
		t.Fatalf("err = %v, want ErrCancelled", err)
	}
	if f.vzdumps != 0 {
		t.Fatal("vzdump started for a cancelled task")
	}
}

func TestCancelOrderStopsTheProviderOfABackupStartedInPVE(t *testing.T) {
	f := newCancelNode(t)
	s := f.service(t)
	done := markProvider(s.Layout, 101)
	defer done()
	proc := t.TempDir()
	pid := strconv.Itoa(os.Getpid())
	_ = os.MkdirAll(filepath.Join(proc, pid), 0o700)
	_ = os.WriteFile(filepath.Join(proc, pid, "cmdline"), []byte("/opt/restow-pve/bin/restow-pve\x00provider\x00backup-vm\x00"), 0o600)
	oldProc, oldSignal := procRoot, signalProcess
	var signalled []int
	procRoot = proc
	signalProcess = func(p int) error { signalled = append(signalled, p); return nil }
	defer func() { procRoot, signalProcess = oldProc, oldSignal }()

	order := &CancelOrders{Runs: []CancelRun{{ID: "run-1", VMID: 101}}}
	s.applyCancel(context.Background(), order)
	s.applyCancel(context.Background(), order) // acted on once
	if len(signalled) != 1 || signalled[0] != os.Getpid() {
		t.Fatalf("signalled %v, want this provider once", signalled)
	}
	if len(f.deleted) != 0 {
		t.Fatalf("the vzdump job was stopped as well: %v", f.deleted)
	}
}

func TestCancelOrderStopsTheVzdumpTaskOfAGuestWithoutProvider(t *testing.T) {
	f := newCancelNode(t)
	f.active = []NodeTask{{UPID: "UPID:other", Type: "vzdump", ID: "102"}, {UPID: testUPID, Type: "vzdump", ID: "101"}}
	s := f.service(t)
	oldProc := procRoot
	procRoot = t.TempDir()
	defer func() { procRoot = oldProc }()
	s.applyCancel(context.Background(), &CancelOrders{Runs: []CancelRun{{ID: "run-2", VMID: 101}}})
	if len(f.deleted) != 1 || !strings.Contains(f.deleted[0], "vzdump:101") {
		t.Fatalf("stopped %v, want the vzdump task of guest 101", f.deleted)
	}
}

func TestStaleProviderRecordIsNeverSignalled(t *testing.T) {
	l := Layout{RunDir: t.TempDir()}
	_ = os.MkdirAll(filepath.Dir(l.providerPIDFile(5)), 0o700)
	_ = os.WriteFile(l.providerPIDFile(5), []byte(strconv.Itoa(os.Getpid())), 0o600)
	proc := t.TempDir()
	pid := strconv.Itoa(os.Getpid())
	_ = os.MkdirAll(filepath.Join(proc, pid), 0o700)
	_ = os.WriteFile(filepath.Join(proc, pid, "cmdline"), []byte("/usr/bin/sshd\x00"), 0o600)
	oldProc, oldSignal := procRoot, signalProcess
	procRoot = proc
	signalProcess = func(int) error { t.Fatal("signalled a process that is no provider"); return nil }
	defer func() { procRoot, signalProcess = oldProc, oldSignal }()
	if stopProvider(l, 5) {
		t.Fatal("stopProvider = true for a reused pid")
	}
}

func TestUpdateNowInstallsOnlyWhenIdle(t *testing.T) {
	f := newCancelNode(t, map[string]any{"tasks": []any{}, "update": map[string]any{"version": "9.9.9", "now": true}})
	s := f.service(t)
	var installed []string
	s.OnUpdate = func(_ context.Context, v string) { installed = append(installed, v) }
	s.enqueue([]Task{{ID: "busy", Kind: "refresh_inventory"}})
	if err := s.Tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(installed) != 0 {
		t.Fatal("updated while a task waits")
	}
	s.dropQueued("busy")
	if err := s.Tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(installed) != 1 || installed[0] != "9.9.9" {
		t.Fatalf("installed %v, want 9.9.9 once", installed)
	}
	// Without "now" the periodic check decides, not the heartbeat.
	f.mu.Lock()
	f.beats = []map[string]any{{"tasks": []any{}, "update": map[string]any{"version": "9.9.9"}}}
	f.mu.Unlock()
	if err := s.Tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(installed) != 1 {
		t.Fatalf("installed %v without now", installed)
	}
}
