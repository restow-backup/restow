//go:build !windows

package pve

import (
	"context"
	"encoding/json"
	"fmt"
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
	if got, _ := result["omittedMounts"].([]string); len(got) != 1 || got[0] != "mp0: /mnt/paperless,mp=/data" {
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
	f.initComm, f.systemState = "systemd", "running"
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

// A restore into a new guest of a container with a bind, a device and a volume mount point: PVE
// refuses the token a bind mount point from the backup, so the restore names rootfs and the
// volume mount points itself and leaves the others out, with the commands to put them back.
// Before, only a check did so, and every such restore failed with "only possible for root".
func TestARestoreOfAContainerWithABindMountIntoANewGuest(t *testing.T) {
	const conf = "hostname: paperless\nmemory: 2048\nrootfs: local-lvm:vm-113-disk-0,size=8G\n" +
		"mp0: /mnt/paperless,mp=/data\nmp1: local-lvm:vm-113-disk-1,mp=/opt,backup=1,size=2G\n" +
		"mp2: /dev/sdb1,mp=/mnt/usb\nmp3: local-lvm:vm-113-disk-2,mp=/scratch,backup=0,size=4G\n"
	f := newFakeNode()
	f.restoreConfig = parseConfigText(conf)
	s := restoreService(t, f, "ct", conf)
	result, err := s.task(context.Background(), restoreTaskOf(t, "ct", false))
	if err != nil || f.refusedBind {
		t.Fatalf("restore: %v (%v), refused %v", err, result, f.refusedBind)
	}
	want := map[string]string{"rootfs": "local-lvm:8", "mp1": "local-lvm:2,mp=/opt,backup=1", "mp3": "local-lvm:4,mp=/scratch,backup=0"}
	if fmt.Sprint(f.restoreMounts) != fmt.Sprint(want) {
		t.Fatalf("restore mounts %v, want %v", f.restoreMounts, want)
	}
	omitted, _ := result["omittedMounts"].([]string)
	remount, _ := result["remountCommands"].([]string)
	if fmt.Sprint(omitted) != "[mp0: /mnt/paperless,mp=/data mp2: /dev/sdb1,mp=/mnt/usb]" ||
		fmt.Sprint(remount) != "[pct set 9001 -mp0 /mnt/paperless,mp=/data pct set 9001 -mp2 /dev/sdb1,mp=/mnt/usb]" {
		t.Fatalf("omitted %v, remount %v", omitted, remount)
	}
	if result["madeUnprivileged"] != true {
		t.Fatalf("the privileged original is not named: %v", result)
	}
}

// A ZFS subvolume without quota (size=0T) is restored as one where the target has subvolumes,
// and with a size elsewhere.
func TestAContainerVolumeOfSizeZero(t *testing.T) {
	const conf = "hostname: db\nunprivileged: 1\nrootfs: local-zfs:subvol-105-disk-0,size=0T\nmp0: /mnt/host,mp=/host\n"
	for _, c := range []struct{ storage, typ, want string }{{"local-zfs", "zfspool", "local-zfs:0"}, {"local-lvm", "lvmthin", "local-lvm:12"}} {
		f := newFakeNode()
		f.storages = append(f.storages, Storage{Storage: "local-zfs", Type: "zfspool", Content: "rootdir,images", Active: 1, Avail: 500 << 30})
		f.restoreConfig = parseConfigText(conf)
		s := restoreService(t, f, "ct", conf)
		s.bootTester().Resolve = func(context.Context, string) (*RestorePoint, error) {
			return &RestorePoint{SnapshotID: "s1", Kind: "ct", VMID: 105, GuestConfig: conf, ByteSize: 10 << 30}, nil
		}
		params, _ := json.Marshal(map[string]any{"volname": "backup/ct/105/2030-01-01T00:00:00Z", "kind": "ct",
			"targetStorage": c.storage, "restoreTest": true})
		result, err := s.task(context.Background(), Task{ID: "t", Kind: "restore", Params: params})
		if err != nil || f.restoreMounts["rootfs"] != c.want || result["deleted"] != true {
			t.Fatalf("%s: %v %v, mounts %v", c.typ, result, err, f.restoreMounts)
		}
	}
	// Nothing to size it with: the boot test cannot run, which is an error and never red.
	f := newFakeNode()
	f.restoreConfig = parseConfigText(conf)
	b := newTester(t, f)
	b.Resolve = func(context.Context, string) (*RestorePoint, error) {
		return &RestorePoint{SnapshotID: "s1", Kind: "ct", VMID: 105, GuestConfig: conf}, nil
	}
	res, err := b.Run(context.Background(), BootTestParams{Volname: "backup/ct/105/2030-01-01T00:00:00Z", Kind: "ct", VMID: 105, DataBytes: 1 << 30})
	if err == nil || res.Outcome != "" || !strings.Contains(res.Message, "cannot create a volume without one") {
		t.Fatalf("%+v %v", res, err)
	}
}

func startTaskOf(kind string) Task {
	params, _ := json.Marshal(map[string]any{"volname": "backup/" + kind + "/114/2030-01-01T00:00:00Z", "kind": kind,
		"targetStorage": "local-lvm", "start": true})
	return Task{ID: "t-start", Kind: "restore", Params: params}
}

// "Start after restore": PVE is never asked for start=1 (its start task's failure would not show
// in the restore task, and it needs VM.PowerMgmt); the node starts the copy as root and says
// whether it runs. A start that fails leaves the restore succeeded.
func TestStartAfterRestoreIsVerified(t *testing.T) {
	f := newFakeNode()
	f.restoreConfig = parseConfigText(plainVMConfig)
	s := restoreService(t, f, "vm", plainVMConfig)
	result, err := s.task(context.Background(), startTaskOf("vm"))
	if err != nil || result["started"] != true || f.guests[9001].status != "running" {
		t.Fatalf("%v %v", result, err)
	}
	if !strings.Contains(strings.Join(f.commands, "\n"), "qm start 9001") {
		t.Fatalf("commands %v", f.commands)
	}

	f = newFakeNode()
	f.restoreConfig = parseConfigText(plainVMConfig)
	f.startFails = true
	s = restoreService(t, f, "vm", plainVMConfig)
	result, err = s.task(context.Background(), startTaskOf("vm"))
	if err != nil || result["started"] != false || !strings.Contains(fmt.Sprint(result["startError"]), "QEMU exited") {
		t.Fatalf("%v %v", result, err)
	}
}

// A copy that may not run is not started, with the reason.
func TestStartAfterRestoreIsRefusedWhereTheCopyMayNotRun(t *testing.T) {
	const staticCT = "hostname: dns\nunprivileged: 1\nrootfs: local-lvm:vm-114-disk-0,size=4G\n" +
		"net0: name=eth0,bridge=vmbr0,hwaddr=BC:24:11:00:00:20,ip=192.168.1.20/24,gw=192.168.1.1\n"
	cases := []struct {
		name, kind, conf, reason string
		original                 string // status of CT 114 in the cluster
	}{
		{"a static IP the running original uses", "ct", staticCT, "static_ip", "running"},
		{"mount points left out", "ct", "hostname: x\nunprivileged: 1\nrootfs: local-lvm:vm-114-disk-0,size=4G\nmp0: /mnt/data,mp=/data\n", "omitted_mounts", ""},
		{"host devices of the original", "vm", passthroughVMConfig, "host_devices", ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := newFakeNode()
			f.restoreConfig = parseConfigText(c.conf)
			if c.original != "" {
				f.guests[114] = &fakeGuest{kind: c.kind, node: "pve1", conf: map[string]string{"hostname": "dns"}, status: c.original}
			}
			s := restoreService(t, f, c.kind, c.conf)
			result, err := s.task(context.Background(), startTaskOf(c.kind))
			if err != nil || result["started"] != false || result["startSkipped"] != c.reason || result["startSkippedMessage"] == "" {
				t.Fatalf("%v %v", result, err)
			}
			for _, cmd := range f.commands {
				if strings.Contains(cmd, " start 9001") {
					t.Fatalf("started: %v", f.commands)
				}
			}
		})
	}
	// The original is stopped: the copy with its IP may start.
	f := newFakeNode()
	f.restoreConfig = parseConfigText(staticCT)
	f.guests[114] = &fakeGuest{kind: "ct", node: "pve1", conf: map[string]string{"hostname": "dns"}, status: "stopped"}
	s := restoreService(t, f, "ct", staticCT)
	result, err := s.task(context.Background(), startTaskOf("ct"))
	if err != nil || result["started"] != true {
		t.Fatalf("%v %v", result, err)
	}
	if msg := fmt.Sprint(containerStaticIPs(parseConfigText(staticCT + "net1: name=eth1,bridge=vmbr1,ip=dhcp,ip6=fd00::5/64\n"))); msg != "[192.168.1.20 fd00::5]" {
		t.Fatalf("static IPs %s", msg)
	}
}

// A restore check its target storage cannot take is skipped before a VMID is taken or anything
// restored: the storage is missing, inactive, holds no guests of the kind (an images-only
// storage and a container) or lacks the space. The task is done with result.skipped, no error.
func TestARestoreCheckSkipsATargetStorageThatCannotTakeIt(t *testing.T) {
	const ctConf = "hostname: web\nrootfs: local-lvm:vm-114-disk-0,size=8G\nmp0: local-lvm:vm-114-disk-1,mp=/data,backup=1,size=100G\n"
	no := false
	for _, tc := range []struct {
		name, kind, reason string
		setup              func(f *fakeNode, s *Service)
	}{
		{"storage missing", "vm", "no_storage", func(f *fakeNode, _ *Service) { f.storages[0].Storage = "other" }},
		{"storage inactive", "vm", "storage_inactive", func(f *fakeNode, _ *Service) { f.storages[0].Active = 0 }},
		{"images-only storage and a container", "ct", "storage_content", func(f *fakeNode, _ *Service) { f.storages[0].Content = "images" }},
		{"rootdir-only storage and a VM", "vm", "storage_content", func(f *fakeNode, _ *Service) { f.storages[0].Content = "rootdir,vztmpl" }},
		{"too small for the container's volumes", "ct", "storage_space", func(f *fakeNode, _ *Service) {
			f.storages[0].Type, f.storages[0].Avail = "lvm", 50<<30
		}},
		{"too small for the VM's disks", "vm", "storage_space", func(f *fakeNode, _ *Service) {
			f.storages[0].Type, f.storages[0].Avail = "lvm", 20<<30
		}},
		{"restores switched off", "vm", "restores_off", func(_ *fakeNode, s *Service) { s.State.AllowRestores = &no }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newFakeNode()
			conf := ctConf
			if tc.kind == "vm" {
				conf = "name: db\nmemory: 2048\nscsi0: local-lvm:vm-114-disk-0,size=32G\n"
			}
			f.restoreConfig = parseConfigText(conf)
			s := restoreService(t, f, tc.kind, conf)
			s.BootTests.Resolve = func(_ context.Context, volname string) (*RestorePoint, error) {
				return &RestorePoint{SnapshotID: "s1", Kind: tc.kind, VMID: 114, GuestConfig: conf,
					Devices: []DeviceSize{{Device: "drive-scsi0", Size: 32 << 30}}, ByteSize: 3 << 30}, nil
			}
			tc.setup(f, s)
			result, err := s.task(context.Background(), restoreTaskOf(t, tc.kind, true))
			if err != nil {
				t.Fatalf("a skipped check is no error: %v", err)
			}
			skipped, _ := result["skipped"].(map[string]any)
			if skipped["reason"] != tc.reason || fmt.Sprint(skipped["message"]) == "" {
				t.Fatalf("result = %v, want skipped %s", result, tc.reason)
			}
			if _, ok := result["vmid"]; ok {
				t.Fatalf("a skipped check names a guest: %v", result)
			}
			f.mu.Lock()
			defer f.mu.Unlock()
			if f.nextID != 9001 || len(f.guests) != 0 || f.restoreMounts != nil {
				t.Fatalf("something was restored: nextID %d, guests %v", f.nextID, f.guests)
			}
			if markers := s.BootTests.markers(); len(markers) != 0 {
				t.Fatalf("a temporary guest was marked: %v", markers)
			}
		})
	}
}

// A storage that takes the check: the restore runs. A thin storage counts the restore point's
// data, a thick one the full disks; a restore into a new guest is never skipped by this check.
func TestARestoreCheckRunsOnAStorageThatTakesIt(t *testing.T) {
	const conf = "hostname: web\nrootfs: local-lvm:vm-114-disk-0,size=8G\n"
	f := newFakeNode()
	f.restoreConfig = parseConfigText(conf)
	f.storages[0].Avail = 6 << 30 // thin: 3 GiB of data and the margin fit, the 8 GiB volume would not
	s := restoreService(t, f, "ct", conf)
	s.BootTests.Resolve = func(_ context.Context, volname string) (*RestorePoint, error) {
		return &RestorePoint{SnapshotID: "s1", Kind: "ct", VMID: 114, GuestConfig: conf, ByteSize: 3 << 30}, nil
	}
	result, err := s.task(context.Background(), restoreTaskOf(t, "ct", true))
	if err != nil || result["skipped"] != nil || result["deleted"] != true {
		t.Fatalf("check: %v (%v)", err, result)
	}
	// A restore into a new guest on an inactive storage is no check: PVE's refusal says why.
	f.storages[0].Active = 0
	result, _ = s.task(context.Background(), restoreTaskOf(t, "ct", false))
	if result["skipped"] != nil {
		t.Fatalf("a restore into a new guest was skipped: %v", result)
	}
}
