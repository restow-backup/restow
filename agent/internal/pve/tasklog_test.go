package pve

import (
	"context"
	"os"
	"path/filepath"
	"strings"
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
