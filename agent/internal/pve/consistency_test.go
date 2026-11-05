//go:build !windows

package pve

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const agentOnConfig = "agent: 1\nscsi0: local-lvm:vm-101-disk-0,size=32G\n"

// Golden: vzdump's log of a VM's backup for every way the guest agent's freeze goes.
func TestVMConsistencyFromVzdumpLogs(t *testing.T) {
	for _, tc := range []struct {
		file, config, state, remark string
		warnings                    int
	}{
		{"vzdump-vm-frozen.log", agentOnConfig, "frozen", "", 0},
		{"vzdump-vm-noagent.log", agentOnConfig, "no_agent", "configured but did not answer", 0},
		{"vzdump-vm-freezedisabled.log", "agent: enabled=1,freeze-fs=0\n", "crash_consistent", "switched off", 0},
		{"vzdump-vm-agentoff.log", "scsi0: local-lvm:vm-101-disk-0\n", "crash_consistent", "no guest agent enabled", 0},
		{"vzdump-vm-agentoff.log", "agent: 0\n", "crash_consistent", "no guest agent enabled", 0},
		{"vzdump-vm-agentoff.log", "agent: enabled=1,freeze-fs=0\n", "crash_consistent", "switched off", 0},
		{"vzdump-vm-freezefailed.log", agentOnConfig, "freeze_failed", "'guest-fsfreeze-freeze' failed - got timeout", 0},
		{"vzdump-vm-nothaw.log", agentOnConfig, "frozen", "logged no thaw", 1},
		{"vzdump-vm-stopped.log", agentOnConfig, "stopped", "", 0},
		// An agent that is on and no line about it: never claimed either way.
		{"vzdump-vm-agentoff.log", agentOnConfig, "unknown", "", 0},
	} {
		data, err := os.ReadFile(filepath.Join("testdata", tc.file))
		if err != nil {
			t.Fatal(err)
		}
		c := ClassifyVMConsistency(string(data), tc.config)
		if c.State != tc.state || len(c.Warnings) != tc.warnings ||
			(tc.remark == "" && c.Remark() != "") || !strings.Contains(c.Remark(), tc.remark) {
			t.Errorf("%s with %q: %+v (remark %q)", tc.file, tc.config, c, c.Remark())
		}
	}
	if c := ClassifyVMConsistency("", agentOnConfig); c.State != "unknown" {
		t.Errorf("no log: %+v", c)
	}
}

// A failed freeze ends the task "OK" or with warnings; its ERROR line is one of the warnings.
func TestAFailedFreezeIsAWarningOfTheTask(t *testing.T) {
	data, _ := os.ReadFile(filepath.Join("testdata", "vzdump-vm-freezefailed.log"))
	var tail []string
	for _, line := range strings.Split(string(data), "\n") {
		// The task log of the PVE API has no time stamps.
		if len(line) > len(taskLogStamp) {
			tail = append(tail, line[len(taskLogStamp)+1:])
		}
	}
	got := WarningLines(strings.Join(tail, "\n"), 10)
	if len(got) != 1 || !strings.Contains(got[0], "guest-fsfreeze-freeze") {
		t.Fatalf("warnings %q", got)
	}
}

// backup_vm sends the consistency with the commit (from vzdump's log of the running backup), and
// backup_handle_log_file with the run's log (from the whole log).
func TestVMBackupRecordsItsConsistency(t *testing.T) {
	dir := t.TempDir()
	old := vzdumpLogDir
	vzdumpLogDir = dir
	t.Cleanup(func() { vzdumpLogDir = old })
	data, _ := os.ReadFile(filepath.Join("testdata", "vzdump-vm-freezefailed.log"))
	logFile := filepath.Join(dir, "qemu-101.log")
	if err := os.WriteFile(logFile, data, 0o600); err != nil {
		t.Fatal(err)
	}
	size := uint64(4 * mib)
	f := &fakeRestow{commits: map[string]string{}, mode: "new"}
	p := testProvider(t, f, &memSource{data: disk(int(size))})
	var log strings.Builder
	p.Log = &log
	ctx := context.Background()
	if _, err := p.Handle(ctx, "backup-init", ProviderRequest{StoreID: "restow", VMID: 101, VMType: "qemu"}); err != nil {
		t.Fatal(err)
	}
	if _, err := p.Handle(ctx, "backup-vm", ProviderRequest{StoreID: "restow", VMID: 101, GuestConfig: agentOnConfig,
		Volumes: map[string]ProviderVolume{"drive-scsi0": {Size: size, BitmapMode: "new", NBDPath: "/x"}}}); err != nil {
		t.Fatal(err)
	}
	c := f.lastCommit.VMConsistency
	if c == nil || c.State != "freeze_failed" || !strings.Contains(f.lastCommit.ConsistencyRemark, "crash-consistent") {
		t.Fatalf("commit %+v", f.lastCommit)
	}
	if !strings.Contains(log.String(), "warn: the guest agent could not freeze the file systems") {
		t.Fatalf("task log %q", log.String())
	}
	if _, err := p.Handle(ctx, "backup-cleanup", ProviderRequest{StoreID: "restow", VMID: 101, Success: true}); err != nil {
		t.Fatal(err)
	}
	if _, err := p.Handle(ctx, "backup-handle-log-file", ProviderRequest{StoreID: "restow", VMID: 101, LogFile: logFile}); err != nil {
		t.Fatal(err)
	}
	if f.logConsistency == nil || f.logConsistency.State != "freeze_failed" {
		t.Fatalf("log upload consistency %+v", f.logConsistency)
	}
}

// The log of the running backup is the file the vzdump worker (the provider's parent) holds
// open; vzdump's log folder is only the fallback, and an old file there counts for nothing.
func TestVzdumpGuestLogOfTheRunningBackup(t *testing.T) {
	old := vzdumpLogDir
	vzdumpLogDir = t.TempDir()
	t.Cleanup(func() { vzdumpLogDir = old })
	elsewhere := filepath.Join(t.TempDir(), "qemu-101.log")
	if err := os.WriteFile(elsewhere, []byte("INFO: issuing guest-agent 'fs-freeze' command\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	fakeProcFDs(t, os.Getppid(), "task UPID:pve1:vzdump::root@pam:\x00", "/dev/null", elsewhere)
	if got := vzdumpGuestLog(101); !strings.Contains(got, "fs-freeze") {
		t.Fatalf("log %q", got)
	}
	if got := vzdumpGuestLog(102); got != "" {
		t.Fatalf("another guest's log: %q", got)
	}
	stale := filepath.Join(vzdumpLogDir, "qemu-102.log")
	_ = os.WriteFile(stale, []byte("INFO: issuing guest-agent 'fs-freeze' command\n"), 0o600)
	past := time.Now().Add(-2 * time.Hour)
	_ = os.Chtimes(stale, past, past)
	if got := vzdumpGuestLog(102); got != "" {
		t.Fatalf("a log of an earlier backup counted: %q", got)
	}
}
