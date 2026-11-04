//go:build !windows

package pve

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

// The restore check of a container with a bind mount point names rootfs and the volume
// mount points itself: PVE refuses a token's restore of a bind mount point taken from the
// backup ("restoring 'mp0' to bind mount is only possible for root").
func TestRestoreCheckOfAContainerLeavesItsBindMountOut(t *testing.T) {
	const guestConfig = "hostname: paperless\nmemory: 2048\nrootfs: local-lvm:vm-113-disk-0,size=8G\n" +
		"mp0: /mnt/paperless,mp=/data\nmp1: local-lvm:vm-113-disk-1,mp=/opt,backup=1,size=2G\n"
	f := newFakeNode()
	f.restoreConfig = parseConfigText(guestConfig)
	s := restoreService(t, f, "ct", guestConfig)
	params, _ := json.Marshal(map[string]any{"volname": "backup/ct/113/2026-11-02T08:19:26Z", "kind": "ct",
		"targetVmid": 124, "targetStorage": "local-lvm", "restoreTest": true})
	result, err := s.task(context.Background(), Task{ID: "t1", Kind: "restore", Params: params})
	if err != nil {
		t.Fatalf("restore check: %v (%v)", err, result)
	}
	if f.refusedBind {
		t.Fatal("PVE was asked for the bind mount point")
	}
	if f.restoreMounts["rootfs"] != "local-lvm:8" || f.restoreMounts["mp1"] != "local-lvm:2,mp=/opt,backup=1" {
		t.Errorf("restore mounts = %v", f.restoreMounts)
	}
	if _, ok := f.restoreMounts["mp0"]; ok {
		t.Errorf("the bind mount was passed on: %v", f.restoreMounts)
	}
	if got, _ := result["omittedMounts"].([]string); len(got) != 1 || got[0] != "mp0 (/mnt/paperless)" {
		t.Errorf("omittedMounts = %v", result["omittedMounts"])
	}
	if result["deleted"] != true || len(f.guests) != 0 {
		t.Errorf("deleted = %v, guests %v", result["deleted"], f.guests)
	}
}

// A container with GPU and TUN passthrough through raw lxc.* keys: PVE restores those only for
// root@pam, skips them for the node's token and ends the restore "WARNINGS: 1". The container is
// there, so the restore succeeded, with the warnings and the skipped lines.
const lxcGuestConfig = "arch: amd64\nhostname: jellyfin\nmemory: 2048\nonboot: 1\nunprivileged: 1\n" +
	"rootfs: local-lvm:vm-114-disk-0,size=8G\nnet0: name=eth0,bridge=vmbr0,ip=dhcp\n" +
	"lxc.cgroup2.devices.allow: c 226:* rwm\nlxc.mount.entry: /dev/dri dev/dri none bind,optional,create=dir\n" +
	"lxc.cgroup2.devices.allow: c 10:200 rwm\n"

const lxcRestoreLog = "extracting archive 'restow:backup/ct/114/2030-01-01T00:00:00Z'\n" +
	"skipping custom lxc options, restore manually as root:\n" +
	"WARN: lxc.cgroup2.devices.allow: c 226:* rwm\n" +
	"TASK WARNINGS: 1\n"

// restoreService is a node whose restore tasks run against the fake node f; the restore point
// has the configuration conf.
func restoreService(t *testing.T, f *fakeNode, kind, conf string) *Service {
	t.Helper()
	b := newTester(t, f)
	b.Resolve = func(_ context.Context, volname string) (*RestorePoint, error) {
		return &RestorePoint{SnapshotID: "s1", Kind: kind, VMID: 114, GuestConfig: conf}, nil
	}
	b.Logf = t.Logf
	return &Service{Layout: b.Layout, State: b.State, BootTests: b, Cmd: f, Logf: t.Logf}
}

func restoreTaskOf(t *testing.T, kind string, check bool) Task {
	t.Helper()
	params, _ := json.Marshal(map[string]any{"volname": "backup/" + kind + "/114/2030-01-01T00:00:00Z", "kind": kind,
		"targetStorage": "local-lvm", "restoreTest": check})
	return Task{ID: "t-restore", Kind: "restore", Params: params}
}

func TestARestoreEndingWithWarningsSucceedsWithThem(t *testing.T) {
	for _, check := range []bool{false, true} {
		f := newFakeNode()
		f.restoreConfig = parseConfigText(lxcGuestConfig)
		f.restoreExit, f.taskLog = "WARNINGS: 1", lxcRestoreLog
		s := restoreService(t, f, "ct", lxcGuestConfig)
		result, err := s.task(context.Background(), restoreTaskOf(t, "ct", check))
		if err != nil {
			t.Fatalf("check %v: %v (%v)", check, err, result)
		}
		w, _ := result["warnings"].([]string)
		if len(w) != 1 || !strings.Contains(w[0], "lxc.cgroup2.devices.allow") {
			t.Fatalf("check %v: warnings %v", check, result["warnings"])
		}
		lxc, _ := result["skippedLxc"].([]string)
		if len(lxc) != 3 || lxc[1] != "lxc.mount.entry: /dev/dri dev/dri none bind,optional,create=dir" {
			t.Fatalf("check %v: skippedLxc %v", check, result["skippedLxc"])
		}
		if check {
			if result["deleted"] != true || len(f.guests) != 0 {
				t.Fatalf("the check's guest is left: %v %v", result, f.guests)
			}
		} else if len(f.guests) != 1 || result["onbootCleared"] != true {
			t.Fatalf("restored guests: %v, result %v", f.guests, result)
		}
	}
}

func TestARestoreEndingWithAnErrorStillFails(t *testing.T) {
	f := newFakeNode()
	f.restoreConfig = parseConfigText(lxcGuestConfig + "lxc.idmap: u 0 100000 65536\n")
	f.restoreExit = "unable to restore CT 9001 - command 'tar' failed: exit code 2"
	f.taskLog = "tar: ./home/x: Cannot change ownership to uid 200000, gid 200000: Invalid argument\n"
	s := restoreService(t, f, "ct", lxcGuestConfig+"lxc.idmap: u 0 100000 65536\n")
	_, err := s.task(context.Background(), restoreTaskOf(t, "ct", false))
	if err == nil || !strings.Contains(err.Error(), "Cannot change ownership") || !strings.Contains(err.Error(), "custom lxc.idmap") {
		t.Fatalf("err = %v", err)
	}
	// "WARNINGS" without a count is no warning status of PVE.
	f = newFakeNode()
	f.restoreConfig = parseConfigText(lxcGuestConfig)
	f.restoreExit = "WARNINGS"
	s = restoreService(t, f, "ct", lxcGuestConfig)
	if _, err := s.task(context.Background(), restoreTaskOf(t, "ct", false)); err == nil {
		t.Fatal("a restore ending \"WARNINGS\" succeeded")
	}
}

// The boot test of such a container goes on after the restore's warnings: never red for them.
func TestABootTestGoesOnAfterARestoreWithWarnings(t *testing.T) {
	f := newFakeNode()
	f.restoreConfig = parseConfigText(lxcGuestConfig)
	f.restoreExit, f.taskLog = "WARNINGS: 1", lxcRestoreLog
	f.initComm = "systemd"
	b := newTester(t, f)
	b.Resolve = func(context.Context, string) (*RestorePoint, error) {
		return &RestorePoint{SnapshotID: "s1", Kind: "ct", VMID: 114, GuestConfig: lxcGuestConfig}, nil
	}
	res, err := b.Run(context.Background(), BootTestParams{Volname: "backup/ct/114/2030-01-01T00:00:00Z", Kind: "ct", VMID: 114, DataBytes: 1 << 30})
	if err != nil || res.Outcome != "green" || !res.CleanedUp {
		t.Fatalf("%+v %v", res, err)
	}
	if len(res.Warnings) != 1 || len(res.SkippedLxc) != 3 {
		t.Fatalf("warnings %v, skipped %v", res.Warnings, res.SkippedLxc)
	}
	// A restore that ended with an error is red as before.
	f.restoreExit = "unable to restore CT 9002 - command 'tar' failed"
	res, err = b.Run(context.Background(), BootTestParams{Volname: "backup/ct/114/2030-01-01T00:00:00Z", Kind: "ct", VMID: 114, DataBytes: 1 << 30})
	if err != nil || res.Outcome != "red" || res.Reason != "restore_failed" {
		t.Fatalf("%+v %v", res, err)
	}
}
