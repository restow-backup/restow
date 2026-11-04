//go:build !windows

package pve

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// ctRestoreProvider is a provider whose server answers a container restore point of byteSize
// and whose restic (a script) unpacks one file into --target, or exits with exitCode.
func ctRestoreProvider(t *testing.T, byteSize uint64, exitCode int) *Provider {
	t.Helper()
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := strings.TrimPrefix(r.URL.Path, "/agent/pve/v1")
		w.Header().Set("content-type", "application/json")
		switch {
		case path == "/restore-points":
			_ = json.NewEncoder(w).Encode(map[string]any{"snapshotId": "s1", "kind": "ct", "vmid": 200,
				"resticSnapshotId": "abc123", "byteSize": byteSize})
		case path == "/snapshots/s1/restic":
			_ = json.NewEncoder(w).Encode(map[string]any{"repositoryUrl": "https://restow/r", "username": "u", "password": "p", "repositoryPassword": "x"})
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(ts.Close)
	srv, err := NewServer(ts.URL, "node-1", "secret", true)
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	script := filepath.Join(root, "restic")
	body := fmt.Sprintf("#!/bin/sh\necho \"$@\" >> %s\nwhile [ $# -gt 0 ]; do [ \"$1\" = --target ] && t=$2; shift; done\n", filepath.Join(root, "args"))
	if exitCode != 0 {
		body += fmt.Sprintf("echo 'unable to create lock in backend: repository is already locked exclusively by PID 1 on restow' >&2\nexit %d\n", exitCode)
	} else {
		body += "mkdir -p \"$t/etc\" && echo db01 > \"$t/etc/hostname\"\n"
	}
	if err := os.WriteFile(script, []byte(body), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("RESTOW_PVE_RESTIC", script)
	var log bytes.Buffer
	return &Provider{Layout: Layout{RunDir: filepath.Join(root, "run"), RestoreTmp: filepath.Join(root, "tmp")},
		state: &State{}, server: srv, Log: &log}
}

func withStatfs(t *testing.T, total, avail uint64, err error) {
	t.Helper()
	old := statfs
	statfs = func(string) (uint64, uint64, error) { return total, avail, err }
	t.Cleanup(func() { statfs = old })
}

func archiveDir(t *testing.T, p *Provider, req ProviderRequest) string {
	t.Helper()
	res, err := p.restoreContainerInit(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	dir, _ := res.(map[string]any)["archiveDirectory"].(string)
	if dir == "" {
		t.Fatalf("no archive directory: %v", res)
	}
	return dir
}

func TestContainerRestoreArgs(t *testing.T) {
	got := strings.Join(containerRestoreArgs("abc123", "/var/tmp/restow-pve/ct-x/root"), " ")
	for _, want := range []string{"restore abc123 --target /var/tmp/restow-pve/ct-x/root", "--no-cache", "--sparse", "--retry-lock 15m"} {
		if !strings.Contains(got, want) {
			t.Fatalf("args %q lack %q", got, want)
		}
	}
}

func TestRestoreSpaceCheck(t *testing.T) {
	// 100 GB file system with 40 GB free, a restore point of 150 GB: refused, naming the way out.
	withStatfs(t, 100e9, 40e9, nil)
	if _, err := restoreSpaceCheck("/var/tmp/restow-pve", 150e9); err == nil || !strings.Contains(err.Error(), "restow-pve config --restore-tmp") ||
		!strings.Contains(err.Error(), "40.0 GB free") || !strings.Contains(err.Error(), "165.0 GB") {
		t.Fatalf("refusal: %v", err)
	}
	// 30 GB fit into 40 GB free, but would leave less than 5% of the file system: refused.
	if _, err := restoreSpaceCheck("/var/tmp/restow-pve", 33e9); err == nil {
		t.Fatal("the reserve of the file system is not kept")
	}
	if note, err := restoreSpaceCheck("/var/tmp/restow-pve", 20e9); err != nil || !strings.Contains(note, "40.0 GB free") {
		t.Fatalf("pass: %q %v", note, err)
	}
	// Unknown is no refusal.
	if _, err := restoreSpaceCheck("/var/tmp/restow-pve", 0); err != nil {
		t.Fatal(err)
	}
	withStatfs(t, 0, 0, errors.New("no such file system"))
	if _, err := restoreSpaceCheck("/var/tmp/restow-pve", 150e9); err != nil {
		t.Fatal(err)
	}
}

func TestContainerRestoreRefusedWithoutSpace(t *testing.T) {
	p := ctRestoreProvider(t, 300e9, 0)
	withStatfs(t, 100e9, 60e9, nil)
	_, err := p.restoreContainerInit(context.Background(), ProviderRequest{Volname: "backup/ct/200/2030-01-01T00:00:00Z"})
	if err == nil || !strings.Contains(err.Error(), "--restore-tmp") {
		t.Fatalf("%v", err)
	}
	if entries, _ := os.ReadDir(p.Layout.RestoreTmp); len(entries) != 0 {
		t.Fatalf("left %v", entries)
	}
}

// Two restores of one restore point get a folder each; the cleanup of one removes its own only.
func TestConcurrentContainerRestoresKeepTheirFolders(t *testing.T) {
	p := ctRestoreProvider(t, 1e9, 0)
	withStatfs(t, 100e9, 60e9, nil)
	req := ProviderRequest{Volname: "backup/ct/200/2030-01-01T00:00:00Z"}
	a := archiveDir(t, p, req)
	b := archiveDir(t, p, req)
	if a == b || filepath.Dir(filepath.Dir(a)) != p.Layout.RestoreTmp || !strings.HasPrefix(filepath.Base(filepath.Dir(a)), "ct-") {
		t.Fatalf("folders %s and %s", a, b)
	}
	for _, d := range []string{a, b} {
		if _, err := os.Stat(filepath.Join(d, "etc", "hostname")); err != nil {
			t.Fatalf("not unpacked into %s: %v", d, err)
		}
		if _, err := os.Stat(filepath.Join(d, "owner")); err == nil {
			t.Fatal("the owner file is part of the archive directory")
		}
	}
	if !busy(p.Layout) {
		t.Fatal("a running container restore does not count as busy")
	}
	if err := p.restoreContainerCleanup(ProviderRequest{Volname: req.Volname, Directory: a}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Dir(a)); !os.IsNotExist(err) {
		t.Fatal("the first restore's folder is left")
	}
	if _, err := os.Stat(filepath.Join(b, "etc", "hostname")); err != nil {
		t.Fatalf("the second restore's tree is gone: %v", err)
	}
	// A directory that is no restore folder is refused, and nothing is removed.
	for _, bad := range []string{"/", p.Layout.RestoreTmp, filepath.Join(p.Layout.RestoreTmp, "..", "x", "root"), filepath.Dir(b), filepath.Join(p.Layout.RestoreTmp, "other", "root")} {
		if err := p.restoreContainerCleanup(ProviderRequest{Volname: req.Volname, Directory: bad}); err == nil {
			t.Fatalf("cleanup of %s accepted", bad)
		}
	}
	// A shim before 0.5.0 names no directory: the folders this worker owns go.
	if err := p.restoreContainerCleanup(ProviderRequest{Volname: req.Volname}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Dir(b)); !os.IsNotExist(err) {
		t.Fatal("the worker's folder is left")
	}
	args, _ := os.ReadFile(filepath.Join(filepath.Dir(os.Getenv("RESTOW_PVE_RESTIC")), "args"))
	if !strings.Contains(string(args), "--sparse") || !strings.Contains(string(args), "--retry-lock 15m") {
		t.Fatalf("restic args %s", args)
	}
}

// A folder whose owner is gone is swept by the next init; a live one is kept.
func TestContainerRestoreSweepsAbandonedFolders(t *testing.T) {
	p := ctRestoreProvider(t, 1e9, 0)
	withStatfs(t, 100e9, 60e9, nil)
	base := p.Layout.RestoreTmp
	mk := func(name, owner string, age time.Duration) string {
		dir := filepath.Join(base, name)
		if err := os.MkdirAll(filepath.Join(dir, "root"), 0o700); err != nil {
			t.Fatal(err)
		}
		if owner != "" {
			_ = os.WriteFile(filepath.Join(dir, "owner"), []byte(owner), 0o600)
		}
		old := time.Now().Add(-age)
		_ = os.Chtimes(dir, old, old)
		return dir
	}
	self := strconv.Itoa(os.Getpid()) + " " + processStart(os.Getpid())
	dead := mk("ct-aaaa-dead", "999999999 12345", time.Minute)
	reused := mk("ct-aaaa-reused", strconv.Itoa(os.Getpid())+" 1", time.Minute)
	live := mk("ct-aaaa-live", self, 72*time.Hour)
	legacyOld := mk("ct-backup_ct_200_old", "", 72*time.Hour)
	legacyNew := mk("ct-backup_ct_200_new", "", time.Hour)
	other := mk("unrelated", "", 72*time.Hour)
	if _, err := p.restoreContainerInit(context.Background(), ProviderRequest{Volname: "backup/ct/200/x"}); err != nil {
		t.Fatal(err)
	}
	for _, gone := range []string{dead, reused, legacyOld} {
		if _, err := os.Stat(gone); !os.IsNotExist(err) {
			t.Errorf("%s kept", gone)
		}
	}
	for _, kept := range []string{live, legacyNew, other} {
		if _, err := os.Stat(kept); err != nil {
			t.Errorf("%s removed", kept)
		}
	}
}

func TestContainerRestoreWhileTheRepositoryIsLocked(t *testing.T) {
	p := ctRestoreProvider(t, 1e9, resticLockedExit)
	withStatfs(t, 100e9, 60e9, nil)
	_, err := p.restoreContainerInit(context.Background(), ProviderRequest{Volname: "backup/ct/200/x"})
	if err == nil || !strings.Contains(err.Error(), "checking or pruning this container's repository; try again in a few minutes") {
		t.Fatalf("%v", err)
	}
	if entries, _ := os.ReadDir(p.Layout.RestoreTmp); len(entries) != 0 {
		t.Fatalf("left %v", entries)
	}
}
