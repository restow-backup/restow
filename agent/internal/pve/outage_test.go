//go:build !windows

package pve

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
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
