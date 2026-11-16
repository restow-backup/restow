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
	"sync"
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

// fakeWorker makes pid a PVE worker in a fake process table: its title is "task <upid>".
func fakeWorker(t *testing.T, pid int, upid string) {
	t.Helper()
	root := t.TempDir()
	old, oldOwner := procRoot, restoreOwner
	procRoot, restoreOwner = root, func() int { return pid }
	t.Cleanup(func() { procRoot, restoreOwner = old, oldOwner })
	dir := filepath.Join(root, strconv.Itoa(pid))
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	stat := fmt.Sprintf("%d (task UPID:pve1) S 1 %d %d 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 777 0 0", pid, pid, pid)
	_ = os.WriteFile(filepath.Join(dir, "stat"), []byte(stat), 0o600)
	_ = os.WriteFile(filepath.Join(dir, "cmdline"), []byte("task "+upid+"\x00\x00"), 0o600)
}

// restoreEndNode is the Restow server and the PVE API of the restore-end path: the restic
// credential names run-1, the PVE task answers status, and restore-end calls are kept.
type restoreEndNode struct {
	mu     sync.Mutex
	status []map[string]any // answered in turn; the last one again and again
	ends   map[string]map[string]any
	srv    *Server
	pve    *PVEAPI
}

func newRestoreEndNode(t *testing.T, status ...map[string]any) *restoreEndNode {
	t.Helper()
	f := &restoreEndNode{status: status, ends: map[string]map[string]any{}}
	restow := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := strings.TrimPrefix(r.URL.Path, "/agent/pve/v1")
		w.Header().Set("content-type", "application/json")
		switch {
		case path == "/restore-points":
			_ = json.NewEncoder(w).Encode(map[string]any{"snapshotId": "s1", "kind": "ct", "vmid": 200,
				"resticSnapshotId": "abc123", "byteSize": 1e9})
		case path == "/snapshots/s1/restic":
			_ = json.NewEncoder(w).Encode(map[string]any{"repositoryUrl": "https://restow/r", "username": "u",
				"password": "p", "repositoryPassword": "x", "runId": "3f1c1f2e-1111-4222-8333-444455556666"})
		case strings.HasSuffix(path, "/restore-end"):
			var in map[string]any
			_ = json.NewDecoder(r.Body).Decode(&in)
			f.mu.Lock()
			f.ends[strings.TrimSuffix(strings.TrimPrefix(path, "/runs/"), "/restore-end")] = in
			f.mu.Unlock()
			w.WriteHeader(http.StatusNoContent)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(restow.Close)
	pveSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		answer := func(v any) { _ = json.NewEncoder(w).Encode(map[string]any{"data": v}) }
		switch {
		case strings.HasSuffix(r.URL.Path, "/status"):
			st := f.status[0]
			if len(f.status) > 1 {
				f.status = f.status[1:]
			}
			if st == nil {
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			answer(st)
		case strings.HasSuffix(r.URL.Path, "/log"):
			answer([]map[string]string{{"t": "extracting archive"}, {"t": "WARN: lxc.cgroup2.devices.allow: c 226:* rwm"}, {"t": "TASK WARNINGS: 1"}})
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(pveSrv.Close)
	var err error
	if f.srv, err = NewServer(restow.URL, "node-1", "secret", true); err != nil {
		t.Fatal(err)
	}
	f.srv.Attempts = 1
	if f.pve, err = NewPVEAPI(pveSrv.URL, "restow@pve!t", "x", "", ""); err != nil {
		t.Fatal(err)
	}
	return f
}

func (f *restoreEndNode) end(id string) map[string]any {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.ends[id]
}

const restoreEndRun = "3f1c1f2e-1111-4222-8333-444455556666"
const restoreUPID = "UPID:pve1:00001092:00000309:6730A000:vzrestore:124:root@pam:"

// A container restore started in the PVE UI reports its end: init keeps the run and the PVE
// worker's task, cleanup leaves a record, and the service reports the task's exit status once
// PVE's task has ended (WARNINGS: n a success with warnings), then drops the record.
func TestAContainerRestoreStartedInPVEReportsItsEnd(t *testing.T) {
	f := newRestoreEndNode(t, map[string]any{"status": "running"},
		map[string]any{"status": "stopped", "exitstatus": "WARNINGS: 1"})
	p := ctRestoreProvider(t, 1e9, 0)
	p.server = f.srv
	data := t.TempDir()
	p.Layout.DataDir = data
	withStatfs(t, 100e9, 60e9, nil)
	fakeWorker(t, 4242, restoreUPID)
	req := ProviderRequest{Volname: "backup/ct/200/2030-01-01T00:00:00Z"}
	dir := archiveDir(t, p, req)
	var kept restoreRun
	if err := readJSON(filepath.Join(filepath.Dir(dir), "run.json"), &kept); err != nil {
		t.Fatal(err)
	}
	if kept.RunID != restoreEndRun || kept.UPID != restoreUPID || kept.WorkerPID != 4242 || kept.Volname != req.Volname {
		t.Fatalf("run.json = %+v", kept)
	}
	if _, err := os.Stat(filepath.Join(dir, "run.json")); err == nil {
		t.Fatal("run.json is part of the archive directory")
	}
	if err := p.restoreContainerCleanup(ProviderRequest{Volname: req.Volname, Directory: dir}); err != nil {
		t.Fatal(err)
	}
	record := filepath.Join(data, "restore-ends", restoreEndRun+".json")
	if _, err := os.Stat(record); err != nil {
		t.Fatalf("cleanup left no record: %v", err)
	}
	s := &Service{Layout: Layout{DataDir: data}, State: &State{NodeName: "pve1"}, Server: f.srv, PVE: f.pve,
		Logf: func(format string, a ...any) { t.Logf(format, a...) }}
	// PVE's task still runs: nothing is reported yet.
	s.reportRestoreEnds(context.Background())
	if f.end(restoreEndRun) != nil {
		t.Fatal("reported while the task runs")
	}
	if _, err := os.Stat(record); err != nil {
		t.Fatal("the record went while the task runs")
	}
	s.reportRestoreEnds(context.Background())
	got := f.end(restoreEndRun)
	if got["status"] != "warnings" || got["exitStatus"] != "WARNINGS: 1" {
		t.Fatalf("restore-end = %v", got)
	}
	if w, _ := got["warnings"].([]any); len(w) != 1 || !strings.Contains(fmt.Sprint(w[0]), "lxc.cgroup2") {
		t.Fatalf("warnings = %v", got["warnings"])
	}
	if _, err := os.Stat(record); !os.IsNotExist(err) {
		t.Fatal("the record is kept after the report")
	}
}

// The exit status decides: OK succeeded, WARNINGS: n a success with warnings, anything else
// failed (never green without OK).
func TestRestoreEndOfAnExitStatus(t *testing.T) {
	if e := restoreEndOf("OK", ""); e.Status != "succeeded" || e.Error != "" {
		t.Fatalf("OK: %+v", e)
	}
	if e := restoreEndOf("WARNINGS: 2", "WARN: a\nWARN: b"); e.Status != "warnings" || len(e.Warnings) != 2 {
		t.Fatalf("WARNINGS: %+v", e)
	}
	for _, exit := range []string{"unable to restore CT 124 - command 'rsync' failed: exit code 23", "interrupted by signal", "", "unexpected status"} {
		if e := restoreEndOf(exit, "rsync: write failed"); e.Status != "failed" || !strings.Contains(e.Error, "restore ended with") {
			t.Fatalf("%q: %+v", exit, e)
		}
	}
}

// A restore whose worker died (a crash, a killed task) leaves its record through the sweep of
// the next restore; a record older than 48 hours and one of a task PVE does not know are
// dropped unreported; a restore without a run (an older server) leaves no record.
func TestRestoreEndRecordsOfAbandonedAndOldRestores(t *testing.T) {
	f := newRestoreEndNode(t, nil)
	p := ctRestoreProvider(t, 1e9, 0)
	data := t.TempDir()
	p.Layout.DataDir = data
	withStatfs(t, 100e9, 60e9, nil)
	// An abandoned folder of a restore whose worker is gone.
	dead := filepath.Join(p.Layout.RestoreTmp, "ct-aaaa-dead")
	if err := os.MkdirAll(filepath.Join(dead, "root"), 0o700); err != nil {
		t.Fatal(err)
	}
	_ = os.WriteFile(filepath.Join(dead, "owner"), []byte("999999999 12345"), 0o600)
	if err := writeJSONAtomic(filepath.Join(dead, "run.json"), restoreRun{RunID: restoreEndRun, UPID: restoreUPID,
		At: time.Now().UTC().Format(time.RFC3339)}, 0o600); err != nil {
		t.Fatal(err)
	}
	// This init's server names no run (ctRestoreProvider's).
	if _, err := p.restoreContainerInit(context.Background(), ProviderRequest{Volname: "backup/ct/200/x"}); err != nil {
		t.Fatal(err)
	}
	entries, _ := os.ReadDir(filepath.Join(data, "restore-ends"))
	if len(entries) != 1 || entries[0].Name() != restoreEndRun+".json" {
		t.Fatalf("records = %v", entries)
	}
	old := "aaaaaaaa-1111-4222-8333-444455556666"
	if err := writeJSONAtomic(filepath.Join(data, "restore-ends", old+".json"), restoreRun{RunID: old, UPID: restoreUPID,
		At: time.Now().Add(-49 * time.Hour).UTC().Format(time.RFC3339)}, 0o600); err != nil {
		t.Fatal(err)
	}
	s := &Service{Layout: Layout{DataDir: data}, State: &State{NodeName: "pve1"}, Server: f.srv, PVE: f.pve,
		Logf: func(format string, a ...any) { t.Logf(format, a...) }}
	// PVE answers 400 for the task (it does not know it): dropped, never reported.
	s.reportRestoreEnds(context.Background())
	if f.end(restoreEndRun) != nil || f.end(old) != nil {
		t.Fatal("an end was reported without PVE's exit status")
	}
	if entries, _ := os.ReadDir(filepath.Join(data, "restore-ends")); len(entries) != 0 {
		t.Fatalf("records left: %v", entries)
	}
}
