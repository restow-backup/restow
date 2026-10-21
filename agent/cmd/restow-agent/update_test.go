package main

import (
	"path/filepath"
	"strings"
	"testing"

	"github.com/restow-backup/restow/agent/internal/api"
	"github.com/restow-backup/restow/agent/internal/lock"
	"github.com/restow-backup/restow/agent/internal/paths"
)

func TestUpdateWithoutEnrollment(t *testing.T) {
	c := newCLI(t)
	_, se, code := c.run("update")
	if code != exitError || !strings.Contains(se, "not enrolled") {
		t.Fatalf("%d %s", code, se)
	}
}

func TestUpdateCommand(t *testing.T) {
	c := newCLI(t)
	if so, se, code := c.run("enroll", "--allow-insecure-http"); code != exitOK {
		t.Fatalf("enroll: %d\n%s\n%s", code, so, se)
	}
	restarts := 0
	old := restartService
	restartService = func() (bool, error) { restarts++; return true, nil }
	t.Cleanup(func() { restartService = old })

	// Nothing offered: says so, changes nothing.
	so, se, code := c.run("update")
	if code != exitOK || !strings.Contains(so, "No newer release is offered") {
		t.Fatalf("no offer: %d\n%s\n%s", code, so, se)
	}

	// An offer while a backup holds the run lock: refused, nothing downloaded.
	c.srv.Lock()
	c.srv.Update = &api.UpdateInfo{Version: "99.0.0", URL: "/install/agent/99.0.0/x/restow-agent", SHA256: strings.Repeat("0", 64)}
	c.srv.Unlock()
	held, err := lock.TryAcquire(paths.Default().LockFile())
	if err != nil {
		t.Fatal(err)
	}
	so, se, code = c.run("update")
	_ = held.Release()
	if code != exitError || !strings.Contains(se, "A backup is running; the update waits.") {
		t.Fatalf("busy: %d\n%s\n%s", code, so, se)
	}

	// The test binary is a development build: it never installs an update.
	so, se, code = c.run("update")
	if code != exitError || !strings.Contains(se, "development build") {
		t.Fatalf("dev build: %d\n%s\n%s", code, so, se)
	}
	if restarts != 0 {
		t.Fatalf("the service was restarted %d times without an update", restarts)
	}
	if !strings.HasPrefix(paths.Default().LockFile(), filepath.Join(c.dir, "agent")) {
		t.Fatalf("lock outside the development layout: %s", paths.Default().LockFile())
	}
}

func TestUsageNamesTheUpdateCommand(t *testing.T) {
	c := newCLI(t)
	so, _, _ := c.run("help")
	if !strings.Contains(so, "update       Install a newer release") {
		t.Fatalf("usage:\n%s", so)
	}
}
