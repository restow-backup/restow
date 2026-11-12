//go:build !windows

package pve

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestProviderUploadsItsOwnLinesWithTheTaskLog(t *testing.T) {
	size := uint64(8 * mib)
	f := &fakeRestow{commits: map[string]string{}, mode: "new"}
	p := testProvider(t, f, &memSource{data: disk(int(size))})
	if _, err := runVMBackup(t, p, size, ""); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if _, err := p.Handle(ctx, "backup-cleanup", ProviderRequest{StoreID: "restow", VMID: 101, Success: true}); err != nil {
		t.Fatal(err)
	}
	// vzdump's own log of the guest: what PVE hands to backup_handle_log_file.
	tmplog := filepath.Join(t.TempDir(), "qemu-101.log")
	stamp := p.clock().Format(taskLogStamp)
	early := time.Unix(1_789_999_000, 0).Format(taskLogStamp)
	late := time.Unix(1_790_001_000, 0).Format(taskLogStamp)
	pveLog := early + " INFO: Starting Backup of VM 101 (qemu)\n" + late + " INFO: Finished Backup of VM 101 (00:00:05)\n"
	if err := os.WriteFile(tmplog, []byte(pveLog), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := p.Handle(ctx, "backup-handle-log-file", ProviderRequest{StoreID: "restow", VMID: 101, LogFile: tmplog}); err != nil {
		t.Fatal(err)
	}
	if len(f.logs) != 1 {
		t.Fatalf("logs %v", f.logs)
	}
	lines := strings.Split(strings.TrimSpace(f.logs[0]), "\n")
	if !strings.Contains(lines[0], "Starting Backup") || !strings.Contains(lines[len(lines)-1], "Finished Backup") {
		t.Fatalf("restow-pve's lines must fall between vzdump's by time:\n%s", f.logs[0])
	}
	for _, want := range []string{stamp + " INFO: Restow run run-1", "INFO: drive-scsi0: 0 GiB, bitmap mode new", "INFO: restore point snap-"} {
		if !strings.Contains(f.logs[0], want) {
			t.Errorf("the run's log lacks %q:\n%s", want, f.logs[0])
		}
	}
	if _, err := os.Stat(p.Layout.jobLogFile("restow", 101)); !os.IsNotExist(err) {
		t.Fatalf("the job's log must be gone after the upload: %v", err)
	}
}

func TestContainerBackupKeepsItsLinesInTheRunFolder(t *testing.T) {
	p, req, _, runDir := fakeContainerBackup(t, ctSummary, "", 0)
	if _, err := p.backupContainer(context.Background(), req); err != nil {
		t.Fatal(err)
	}
	kept, err := os.ReadFile(ctTaskLog(runDir))
	if err != nil || !strings.Contains(string(kept), "INFO: restic snapshot aaaaaaaa") {
		t.Fatalf("the run folder keeps the call's log lines: %q, %v", kept, err)
	}
}

func TestMergeTaskLogByTime(t *testing.T) {
	pve := "2026-10-15 10:00:00 INFO: Starting Backup of VM 200 (lxc)\n" +
		"2026-10-15 10:00:05 INFO: creating Restow archive\n" +
		"  a continuation without a time\n" +
		"2026-10-15 10:03:00 INFO: Finished Backup of VM 200 (00:03:00)\n"
	ours := "2026-10-15 10:00:01 INFO: Restow run r\n" +
		"2026-10-15 10:00:05 WARN: could not read /secret\n" +
		"2026-10-15 10:02:59 INFO: restore point s committed\n"
	got := string(MergeTaskLog([]byte(pve), []byte(ours)))
	want := "2026-10-15 10:00:00 INFO: Starting Backup of VM 200 (lxc)\n" +
		"2026-10-15 10:00:01 INFO: Restow run r\n" +
		"2026-10-15 10:00:05 INFO: creating Restow archive\n" +
		"  a continuation without a time\n" +
		"2026-10-15 10:00:05 WARN: could not read /secret\n" +
		"2026-10-15 10:02:59 INFO: restore point s committed\n" +
		"2026-10-15 10:03:00 INFO: Finished Backup of VM 200 (00:03:00)\n"
	if got != want {
		t.Fatalf("merged:\n%s\nwant:\n%s", got, want)
	}
	if string(MergeTaskLog([]byte(pve), nil)) != pve {
		t.Fatal("without lines of its own the log stays as it is")
	}
	if got := string(tailBytes([]byte("aaa\nbbb\nccc\n"), 6)); got != "ccc\n" {
		t.Fatalf("tail %q", got)
	}
}

func vzdumpFixture(t *testing.T, name string) []string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	return strings.Split(strings.TrimRight(string(data), "\n"), "\n")
}

func TestVzdumpLockStateOfRealTaskLogs(t *testing.T) {
	for name, want := range map[string][2]bool{
		// waiting, begun
		"vzdump-lockwait.log":     {true, false},
		"vzdump-lockwait-got.log": {false, true},
		"vzdump-locktimeout.log":  {true, false},
		"vzdump-nolock.log":       {false, true},
	} {
		tail := strings.Join(vzdumpFixture(t, name), "\n")
		if got := [2]bool{vzdumpLockState(tail), vzdumpBackupBegun(tail)}; got != want {
			t.Errorf("%s: waiting, begun = %v, want %v", name, got, want)
		}
	}
	if err := lockTimeoutError("can't acquire lock '/var/run/vzdump.lock' - got timeout", "pve1"); err == nil ||
		!strings.Contains(err.Error(), "another Proxmox VE backup job held the backup lock of node pve1") ||
		!strings.Contains(err.Error(), "Move the schedule") {
		t.Fatalf("lock timeout: %v", err)
	}
	if lockTimeoutError("job errors", "pve1") != nil {
		t.Fatal("another exit status is no lock timeout")
	}
}

// A Restow backup that waits for a PVE backup job's lock says so while it waits, and the lock
// timeout names the cause.
func TestBackupWaitingForThePVEBackupJobsLock(t *testing.T) {
	oldPoll, oldLock := backupTaskPoll, lockWaitPoll
	backupTaskPoll, lockWaitPoll = 5*time.Millisecond, 10*time.Millisecond
	t.Cleanup(func() { backupTaskPoll, lockWaitPoll = oldPoll, oldLock })
	vz := &fakeVzdump{runningPolls: 40, exit: "can't acquire lock '/var/run/vzdump.lock' - got timeout",
		log: vzdumpFixture(t, "vzdump-locktimeout.log")}
	s := newTaskService(t, vz, &fakeResults{})
	var mu sync.Mutex
	var logs []string
	s.Logf = func(f string, a ...any) { mu.Lock(); logs = append(logs, fmt.Sprintf(f, a...)); mu.Unlock() }
	_, err := s.task(context.Background(), backupTask("t1"))
	if err == nil || !strings.Contains(err.Error(), "another Proxmox VE backup job held the backup lock of node pve1") {
		t.Fatalf("err = %v", err)
	}
	mu.Lock()
	joined := strings.Join(logs, "\n")
	mu.Unlock()
	if strings.Count(joined, "backup of 101: waiting for another backup on node pve1 (a Proxmox VE backup job holds vzdump's lock)") != 1 {
		t.Fatalf("log %q", joined)
	}
	if _, err := os.Stat(s.Layout.lockWaitNote(101)); !os.IsNotExist(err) {
		t.Fatalf("the note of a backup that never got the lock stayed: %v", err)
	}
}

// The run opens only once vzdump has the lock: backup_init puts the wait into the run's log.
func TestBackupInitLogsTheLockWait(t *testing.T) {
	f := &fakeRestow{commits: map[string]string{}}
	p := testProvider(t, f, &memSource{})
	since := p.clock().Add(-95 * time.Minute)
	_ = os.MkdirAll(filepath.Dir(p.Layout.lockWaitNote(101)), 0o700)
	if err := os.WriteFile(p.Layout.lockWaitNote(101), []byte(since.UTC().Format(time.RFC3339)), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := p.Handle(context.Background(), "backup-init", ProviderRequest{StoreID: "restow", VMID: 101, VMType: "qemu"}); err != nil {
		t.Fatal(err)
	}
	log, _ := os.ReadFile(p.Layout.jobLogFile("restow", 101))
	want := "INFO: this backup waited from " + since.Local().Format(taskLogStamp) + " for another backup on this node (a Proxmox VE backup job) to release vzdump's lock"
	if !strings.Contains(string(log), want) {
		t.Fatalf("job log %q lacks %q", log, want)
	}
	if _, err := os.Stat(p.Layout.lockWaitNote(101)); !os.IsNotExist(err) {
		t.Fatal("the note was not taken")
	}
	// An old note says nothing.
	_ = os.WriteFile(p.Layout.lockWaitNote(101), []byte(p.clock().Add(-5*time.Hour).UTC().Format(time.RFC3339)), 0o600)
	if _, err := p.Handle(context.Background(), "backup-init", ProviderRequest{StoreID: "restow", VMID: 101, VMType: "qemu"}); err != nil {
		t.Fatal(err)
	}
	if log, _ := os.ReadFile(p.Layout.jobLogFile("restow", 101)); strings.Contains(string(log), "waited") {
		t.Fatalf("a stale note was logged: %q", log)
	}
}
