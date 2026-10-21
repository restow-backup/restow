package core

import (
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/restow-backup/restow/agent/internal/api"
	"github.com/restow-backup/restow/agent/internal/buildinfo"
	"github.com/restow-backup/restow/agent/internal/release"
	"github.com/restow-backup/restow/agent/internal/testutil/fakeserver"
)

func TestCancelOrderStopsTheRunningBackup(t *testing.T) {
	h := newHarness(t)
	h.env("FAKE_BACKUP_SLEEP=30")
	h.srv.QueueTask(task("t-1", api.TaskBackupNow, nil))
	h.start()
	fakeserver.WaitFor(10*time.Second, func() bool {
		return len(h.srv.AllRuns()) == 1 && strings.Contains(h.commands(), "backup")
	})
	time.Sleep(100 * time.Millisecond)
	// Another run's order changes nothing; this run's stops restic.
	h.srv.Lock()
	h.srv.Cancel = &api.CancelOrders{Runs: []api.Flex{"run-99"}}
	h.srv.Unlock()
	time.Sleep(200 * time.Millisecond)
	if fin := h.srv.AllRuns()[0].Finish; fin != nil {
		t.Fatalf("stopped by another run's order: %+v", fin)
	}
	h.srv.Lock()
	h.srv.Cancel = &api.CancelOrders{Runs: []api.Flex{"run-1"}}
	h.srv.Unlock()
	run := h.waitRun(1)
	fin := run.Finish
	if fin.Status != api.StatusFailed || len(fin.Errors) != 1 || fin.Errors[0].Code != "cancelled" {
		t.Fatalf("finish: %+v", fin)
	}
	if !strings.Contains(fin.LogTail, "Run finished: failed") {
		t.Fatalf("log:\n%s", fin.LogTail)
	}
	st := h.statusAfterRun()
	if st.Interrupted || st.ConsecutiveFailures != 0 || st.Current != nil {
		t.Fatalf("a cancelled backup is neither resumed nor a failure: %+v", st)
	}
}

func TestCancelOrderForTheTaskStopsItsRun(t *testing.T) {
	h := newHarness(t)
	h.env("FAKE_BACKUP_SLEEP=30")
	h.srv.QueueTask(task("t-2", api.TaskBackupNow, nil))
	h.start()
	fakeserver.WaitFor(10*time.Second, func() bool {
		return len(h.srv.AllRuns()) == 1 && strings.Contains(h.commands(), "backup")
	})
	h.srv.Lock()
	h.srv.Cancel = &api.CancelOrders{Tasks: []api.Flex{"t-2"}}
	h.srv.Unlock()
	run := h.waitRun(1)
	if run.Finish.Errors[0].Code != "cancelled" {
		t.Fatalf("finish: %+v", run.Finish)
	}
}

func TestWithdrawnTaskIsRefusedOnceAndDropped(t *testing.T) {
	h := newHarness(t)
	h.srv.RefuseTasks = map[string]bool{"t-3": true}
	h.srv.QueueTask(task("t-3", api.TaskBackupNow, nil))
	h.start()
	fakeserver.WaitFor(10*time.Second, func() bool {
		h.srv.Lock()
		defer h.srv.Unlock()
		return h.srv.RunStartTries >= 1
	})
	// A retry would come after 30 s; nothing is retried at all.
	time.Sleep(300 * time.Millisecond)
	h.srv.Lock()
	tries := h.srv.RunStartTries
	h.srv.Unlock()
	if tries != 1 || len(h.srv.AllRuns()) != 0 {
		t.Fatalf("start tries = %d, runs = %d; want one refused start", tries, len(h.srv.AllRuns()))
	}
	if !h.agent.idle() {
		t.Fatal("the agent is still busy with a withdrawn task")
	}
}

func TestUpdateNowLooksForTheUpdateAtOnce(t *testing.T) {
	h := newHarness(t)
	old := buildinfo.Version
	buildinfo.Version = "0.1.0"
	t.Cleanup(func() { buildinfo.Version = old })
	h.binDir = trustedDir(t)
	h.exe = filepath.Join(h.binDir, "restow-agent")
	if err := os.WriteFile(h.exe, []byte("#!/bin/sh\necho restow-agent 0.1.0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	h.updateKey = release.NewPublicKey(pub, "test")
	target := runtime.GOOS + "-" + runtime.GOARCH
	next := []byte("#!/bin/sh\necho \"restow-agent 0.2.0\"\n")
	h.srv.SetRelease("0.2.0", map[string][]byte{target + "/restow-agent": next, target + "/restic": []byte("restic")}, priv)
	h.srv.SetUpdate("0.2.0", target, next)
	h.srv.UpdateNow = true
	h.build()
	h.agent.o.SelfUpdate = true
	h.agent.o.UpdateInterval = time.Hour
	// No early check: only the heartbeat's "update now" makes it look before a minute is over.
	h.start()
	select {
	case err := <-h.done:
		if !errors.Is(err, ErrRestart) {
			t.Fatalf("Run returned %v, want ErrRestart", err)
		}
	case <-time.After(15 * time.Second):
		t.Fatal("no update after the server asked for it")
	}
	h.cancel = nil
	b, _ := os.ReadFile(h.exe)
	if !strings.Contains(string(b), "0.2.0") {
		t.Fatalf("binary not replaced: %s", b)
	}
}
