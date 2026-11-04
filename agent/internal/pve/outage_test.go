//go:build !windows

package pve

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// failingServer answers 503 to the first `fail` requests (a server restarting behind its
// proxy, as during an update of Restow), then 204.
func failingServer(t *testing.T, fail int32) (*Server, *atomic.Int32, *time.Duration) {
	t.Helper()
	var calls atomic.Int32
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if calls.Add(1) <= fail {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	t.Cleanup(ts.Close)
	s, err := NewServer(ts.URL, "n", "s", true)
	if err != nil {
		t.Fatal(err)
	}
	var waited time.Duration
	s.sleep = func(_ context.Context, d time.Duration) error {
		waited += d
		return nil
	}
	return s, &calls, &waited
}

func TestRunCallsRideOutAServerRestart(t *testing.T) {
	// Fifteen refusals are far more than the five attempts, but well inside five minutes.
	s, calls, waited := failingServer(t, 15)
	if err := s.PutBlocks(context.Background(), "run-1", []byte("frame")); err != nil {
		t.Fatalf("blocks during a restart: %v", err)
	}
	if calls.Load() != 16 {
		t.Fatalf("calls = %d, want 16", calls.Load())
	}
	if *waited > DefaultOutageWindow+30*time.Second {
		t.Fatalf("waited %s, longer than the window", *waited)
	}

	s, calls, _ = failingServer(t, 15)
	if err := s.FinishRun(context.Background(), "run-1", "ok", "", nil); err != nil {
		t.Fatalf("finish during a restart: %v", err)
	}
	if calls.Load() != 16 {
		t.Fatalf("finish calls = %d, want 16", calls.Load())
	}
}

func TestRunCallsGiveUpAfterTheOutageWindow(t *testing.T) {
	s, calls, waited := failingServer(t, 1_000)
	err := s.PutBlocks(context.Background(), "run-1", []byte("frame"))
	if !IsStatus(err, http.StatusServiceUnavailable) {
		t.Fatalf("err = %v, want the 503", err)
	}
	if *waited < DefaultOutageWindow {
		t.Fatalf("gave up after %s, before the window of %s", *waited, DefaultOutageWindow)
	}
	if calls.Load() > 40 {
		t.Fatalf("calls = %d: the outage must be waited out slowly", calls.Load())
	}
}

func TestOtherCallsKeepTheirAttempts(t *testing.T) {
	s, calls, _ := failingServer(t, 1_000)
	if _, err := s.Listings(context.Background()); err == nil {
		t.Fatal("listing succeeded against a server that is down")
	}
	if calls.Load() != 5 {
		t.Fatalf("listing calls = %d, want 5 attempts", calls.Load())
	}
	// An answer of the server itself is not an outage: a 400 is not retried at all.
	var bad atomic.Int32
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		bad.Add(1)
		w.WriteHeader(http.StatusBadRequest)
	}))
	t.Cleanup(ts.Close)
	s2, _ := NewServer(ts.URL, "n", "s", true)
	s2.sleep = func(context.Context, time.Duration) error { return nil }
	if err := s2.PutBlocks(context.Background(), "run-1", []byte("frame")); !IsStatus(err, 400) {
		t.Fatalf("err = %v, want the 400", err)
	}
	if bad.Load() != 1 {
		t.Fatalf("400 calls = %d, want 1", bad.Load())
	}
}

func TestActiveRunsListsTheOpenJobFiles(t *testing.T) {
	l := Layout{RunDir: t.TempDir()}
	if got := activeRuns(l); got == nil || len(got) != 0 {
		t.Fatalf("no jobs dir: %#v, want an empty list", got)
	}
	dir := filepath.Join(l.RunDir, "jobs")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	write := func(name string, j jobState) {
		data, _ := json.Marshal(j)
		if err := os.WriteFile(filepath.Join(dir, name), data, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	write("restow-101.json", jobState{RunID: "11111111-1111-4111-8111-111111111111", VMID: 101})
	write("restow-102.json", jobState{RunID: "22222222-2222-4222-8222-222222222222", VMID: 102})
	write(".restow-103.json.tmp", jobState{RunID: "33333333-3333-4333-8333-333333333333"})
	if err := os.WriteFile(filepath.Join(dir, "restow-104.json"), []byte("{broken"), 0o600); err != nil {
		t.Fatal(err)
	}
	got := activeRuns(l)
	slices.Sort(got)
	want := []string{"11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"}
	if !slices.Equal(got, want) {
		t.Fatalf("activeRuns = %v, want %v", got, want)
	}
}

// fakeTaskAPI is the task status route of a PVE API: it fails the first `fail` calls with
// `failWith` (an HTTP status, or 0 to drop the connection), then answers `answer`.
type fakeTaskAPI struct {
	mu       sync.Mutex
	fail     int
	failWith int
	answer   TaskStatus
	calls    int
}

func (f *fakeTaskAPI) handler(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	if f.calls <= f.fail {
		if f.failWith == 0 {
			if hj, ok := w.(http.Hijacker); ok {
				c, _, _ := hj.Hijack()
				_ = c.Close()
				return
			}
		}
		w.WriteHeader(f.failWith)
		return
	}
	_ = json.NewEncoder(w).Encode(map[string]any{"data": f.answer})
}

// taskAPI is a PVE API client against f whose waits pass on a clock of their own.
func taskAPI(t *testing.T, f *fakeTaskAPI) (*PVEAPI, *time.Duration) {
	t.Helper()
	ts := httptest.NewServer(http.HandlerFunc(f.handler))
	t.Cleanup(ts.Close)
	api, err := NewPVEAPI(ts.URL, "restow@pve!t", "x", "", "")
	if err != nil {
		t.Fatal(err)
	}
	var waited time.Duration
	start := time.Unix(1_900_000_000, 0)
	api.now = func() time.Time { return start.Add(waited) }
	api.sleep = func(ctx context.Context, d time.Duration) error {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		waited += d
		return nil
	}
	return api, &waited
}

// A pveproxy restart (an upgrade of pve-manager, a renewed certificate) during a long backup or
// restore: the status calls fail for a while, PVE goes on, and the wait goes on with it.
func TestWaitTaskRidesOutAPVEAPIThatDoesNotAnswer(t *testing.T) {
	for _, failWith := range []int{0, 502, 503, 595, 596} {
		f := &fakeTaskAPI{fail: 12, failWith: failWith, answer: TaskStatus{Status: "stopped", ExitStatus: "OK"}}
		api, waited := taskAPI(t, f)
		exit, err := api.WaitTask(context.Background(), "pve1", "UPID:pve1:1:2:3:vzdump:101:root@pam:", 5*time.Second)
		if err != nil || exit != "OK" {
			t.Fatalf("%d: exit %q, err %v", failWith, exit, err)
		}
		if f.calls != 13 || *waited > DefaultWaitOutage {
			t.Fatalf("%d: %d calls, waited %s", failWith, f.calls, *waited)
		}
	}
}

func TestWaitTaskGivesUpAfterTheOutageWindow(t *testing.T) {
	f := &fakeTaskAPI{fail: 1_000_000, failWith: 503}
	api, waited := taskAPI(t, f)
	upid := "UPID:pve1:1:2:3:qmrestore:9001:restow@pve!t:"
	_, err := api.WaitTask(context.Background(), "pve1", upid, 5*time.Second)
	if err == nil || !strings.Contains(err.Error(), "the PVE API did not answer for 10 min; task "+upid+" may still run") {
		t.Fatalf("err = %v", err)
	}
	if *waited < DefaultWaitOutage || *waited > DefaultWaitOutage+maxWaitBackoff {
		t.Fatalf("waited %s", *waited)
	}
	if f.calls > 40 {
		t.Fatalf("%d calls: the outage must be waited out slowly", f.calls)
	}
	// The window is the node's to set.
	f = &fakeTaskAPI{fail: 1_000_000, failWith: 503}
	api, _ = taskAPI(t, f)
	api.WaitOutage = time.Minute
	if _, err := api.WaitTask(context.Background(), "pve1", upid, time.Second); err == nil || !strings.Contains(err.Error(), "for 1 min") {
		t.Fatalf("err = %v", err)
	}
}

// An answer of PVE itself is final: the token is refused, the task does not exist.
func TestWaitTaskStopsAtAnAnswerOfPVE(t *testing.T) {
	for _, status := range []int{401, 403, 404, 400} {
		f := &fakeTaskAPI{fail: 1_000, failWith: status}
		api, _ := taskAPI(t, f)
		_, err := api.WaitTask(context.Background(), "pve1", "UPID:x", time.Second)
		var pe *PVEAPIError
		if !errors.As(err, &pe) || pe.Status != status || f.calls != 1 {
			t.Fatalf("%d: err %v after %d calls", status, err, f.calls)
		}
	}
}

func TestWaitTaskEndsWhenItsContextEndsDuringTheBackoff(t *testing.T) {
	f := &fakeTaskAPI{fail: 1_000_000, failWith: 503}
	api, _ := taskAPI(t, f)
	ctx, cancel := context.WithCancel(context.Background())
	sleeps := 0
	api.sleep = func(ctx context.Context, d time.Duration) error {
		sleeps++
		if sleeps == 3 {
			cancel()
		}
		return ctx.Err()
	}
	if _, err := api.WaitTask(ctx, "pve1", "UPID:x", time.Second); !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v", err)
	}
}

// A qm or pct call that hangs (a storage that does not answer) ends at its deadline: the node's
// only task worker is not blocked.
func TestAHungQmCallIsBounded(t *testing.T) {
	old := cliTimeouts
	cliTimeouts.Short, cliTimeouts.Long = 50*time.Millisecond, 50*time.Millisecond
	defer func() { cliTimeouts = old }()
	f := newFakeNode()
	f.restoreConfig = parseConfigText(vmConfig)
	b := newTester(t, f)
	b.Cmd = runnerFunc(func(ctx context.Context, name string, args ...string) (string, error) {
		if args[0] == "config" {
			<-ctx.Done()
			return "", ctx.Err()
		}
		return f.Run(ctx, name, args...)
	})
	start := time.Now()
	res, err := b.Run(context.Background(), vmParams())
	if err == nil || res.Outcome != "" || !strings.Contains(err.Error(), "did not end within") {
		t.Fatalf("%+v %v", res, err)
	}
	if time.Since(start) > 5*time.Second {
		t.Fatalf("took %s", time.Since(start))
	}
}
