package core

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/restow-backup/restow/agent/internal/buildinfo"
	"github.com/restow-backup/restow/agent/internal/release"
)

// updateHarness serves a signed release 0.2.0 to an agent that runs 0.1.0 from a trusted folder.
func updateHarness(t *testing.T) *harness {
	t.Helper()
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
	h.build()
	return h
}

// `restow-agent update`: the offered release is installed at once, through the signed download.
func TestUpdateNowInstallsTheOfferedRelease(t *testing.T) {
	h := updateHarness(t)
	res, err := h.agent.UpdateNow(context.Background())
	if err != nil || res == nil || res.Version != "0.2.0" {
		t.Fatalf("UpdateNow: %+v %v", res, err)
	}
	b, _ := os.ReadFile(h.exe)
	if !strings.Contains(string(b), "0.2.0") {
		t.Fatalf("binary not replaced: %s", b)
	}
	// The run lock is free again afterwards.
	free := newLockHolder(t, h.layout.LockFile())
	free()
}

// While a backup holds the run lock, nothing is downloaded or replaced.
func TestUpdateNowRefusesWhileARunHoldsTheLock(t *testing.T) {
	h := updateHarness(t)
	other := newLockHolder(t, h.layout.LockFile())
	defer other()
	if _, err := h.agent.UpdateNow(context.Background()); !errors.Is(err, ErrBusy) {
		t.Fatalf("err = %v, want ErrBusy", err)
	}
	b, _ := os.ReadFile(h.exe)
	if !strings.Contains(string(b), "0.1.0") {
		t.Fatalf("binary replaced while a run held the lock: %s", b)
	}
}

// A release that is not newer, or no offer at all, is no update and no error.
func TestUpdateNowWithoutANewerRelease(t *testing.T) {
	h := updateHarness(t)
	buildinfo.Version = "0.2.0"
	if res, err := h.agent.UpdateNow(context.Background()); err != nil || res != nil {
		t.Fatalf("same version: %+v %v", res, err)
	}
	h.srv.Lock()
	h.srv.Update = nil
	h.srv.Unlock()
	buildinfo.Version = "0.1.0"
	if res, err := h.agent.UpdateNow(context.Background()); err != nil || res != nil {
		t.Fatalf("no offer: %+v %v", res, err)
	}
}

// A signature that does not match the compiled-in key stops the update before anything moves.
func TestUpdateNowRefusesAnUnsignedRelease(t *testing.T) {
	h := updateHarness(t)
	other, _, _ := ed25519.GenerateKey(rand.Reader)
	h.agent.d.UpdateKey = release.NewPublicKey(other, "other")
	if res, err := h.agent.UpdateNow(context.Background()); err == nil || res != nil {
		t.Fatalf("UpdateNow with the wrong key: %+v %v", res, err)
	}
	b, _ := os.ReadFile(h.exe)
	if !strings.Contains(string(b), "0.1.0") {
		t.Fatalf("binary replaced although the signature did not verify: %s", b)
	}
}
