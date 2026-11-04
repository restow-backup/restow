//go:build !windows

package pve

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A storage.cfg as PVE writes it (pvesm add ...; the GUI's "Thin provision" writes sparse 1).
const storageCfg = `dir: local
	path /var/lib/vz
	content iso,vztmpl,backup

lvmthin: local-lvm
	thinpool data
	vgname pve
	content rootdir,images

lvm: thick-lvm
	vgname data
	content images,rootdir
	shared 0

zfspool: local-zfs
	pool rpool/data
	content images,rootdir

zfspool: tank-thin
	pool tank/vm
	sparse 1
	content images,rootdir

dir: big
	path /mnt/big
	content images
	preallocation full
`

func writeStorageCfg(t *testing.T, b *BootTester) {
	t.Helper()
	b.StorageConfig = filepath.Join(t.TempDir(), "storage.cfg")
	if err := os.WriteFile(b.StorageConfig, []byte(storageCfg), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestReadStorageOptions(t *testing.T) {
	path := filepath.Join(t.TempDir(), "storage.cfg")
	if err := os.WriteFile(path, []byte(storageCfg), 0o644); err != nil {
		t.Fatal(err)
	}
	for id, want := range map[string]storageOptions{
		"local-zfs": {Known: true},
		"tank-thin": {Known: true, Sparse: true},
		"big":       {Known: true, Preallocation: "full"},
		"local":     {Known: true},
		"missing":   {},
	} {
		if got := readStorageOptions(path, id); got != want {
			t.Errorf("%s: %+v, want %+v", id, got, want)
		}
	}
	if got := readStorageOptions(filepath.Join(t.TempDir(), "none"), "local"); got.Known {
		t.Errorf("a missing file: %+v", got)
	}
}

// A VM with a 500 GiB disk holding 40 GiB of data, on a storage with 100 GiB free.
func TestBootTestSpaceCheckCountsWhatTheStorageAllocates(t *testing.T) {
	cases := []struct {
		storage, typ string
		ok           bool
	}{
		{"thick-lvm", "lvm", false},
		{"local-zfs", "zfspool", false},
		{"tank-thin", "zfspool", true},
		{"local-lvm", "lvmthin", true},
		{"ceph", "rbd", true},
		{"local", "dir", true},
		{"big", "dir", false},
		{"unknown-dir", "dir", false},
		{"odd", "iscsidirect", false},
	}
	for _, c := range cases {
		t.Run(c.storage, func(t *testing.T) {
			f := newFakeNode()
			f.restoreConfig = parseConfigText(vmConfig)
			f.agentAfter = 1
			f.storages = []Storage{{Storage: c.storage, Type: c.typ, Content: "images,rootdir", Active: 1, Avail: 100 << 30}}
			b := newTester(t, f)
			writeStorageCfg(t, b)
			b.State.BootTestStorage = c.storage
			p := vmParams()
			p.DiskBytes, p.DataBytes = 500<<30, 40<<30
			res, err := b.Run(context.Background(), p)
			if err != nil {
				t.Fatal(err)
			}
			if c.ok != (res.Outcome == "green") || (!c.ok && (res.Outcome != "skipped" || res.Reason != "storage_space")) {
				t.Fatalf("%+v", res)
			}
		})
	}
}

// A container's need comes from its rootfs and volume mount points (bind mounts are not
// restored); a zfspool gives it subvolumes, which reserve nothing.
func TestBootTestSpaceCheckOfAContainer(t *testing.T) {
	for typ, ok := range map[string]bool{"lvm": false, "zfspool": true, "lvmthin": true} {
		f := newFakeNode()
		f.restoreConfig = map[string]string{
			"hostname": "files", "memory": "1024", "rootfs": "store:vm-200-disk-0,size=200G",
			"mp0": "store:vm-200-disk-1,mp=/srv,size=300G", "mp1": "/mnt/huge,mp=/huge",
		}
		f.initComm, f.systemState = "systemd", "running"
		f.storages = []Storage{{Storage: "store", Type: typ, Content: "images,rootdir", Active: 1, Avail: 100 << 30}}
		b := newTester(t, f)
		writeStorageCfg(t, b)
		b.State.BootTestStorage = "store"
		p := BootTestParams{Volname: "backup/ct/200/2030-01-01T00:00:00Z", Kind: "ct", VMID: 200, DataBytes: 10 << 30}
		res, err := b.Run(context.Background(), p)
		if err != nil {
			t.Fatal(err)
		}
		if ok == (res.Outcome == "skipped") || (!ok && res.Reason != "storage_space") {
			t.Fatalf("%s: %+v", typ, res)
		}
	}
	if got := containerVolumeBytes(map[string]string{"rootfs": "s:1,size=8G", "mp0": "s:2,mp=/a,size=2G", "mp1": "/host,mp=/b,size=99G"}); got != 10<<30 {
		t.Fatalf("volume bytes %d", got)
	}
}

// A restore that ran out of space says nothing about the restore point: skipped, never red.
func TestBootTestRestoreOutOfSpaceIsSkipped(t *testing.T) {
	for _, tail := range []string{
		"  Volume group \"pve\" has insufficient free space (1024 extents): 128000 required.\nTASK ERROR: lvcreate 'pve/vm-9001-disk-0' error",
		"zfs error: cannot create 'rpool/data/vm-9001-disk-0': out of space",
		"tar: ./var/lib/mysql/ibdata1: Cannot write: No space left on device",
	} {
		f := newFakeNode()
		f.restoreConfig = parseConfigText(vmConfig)
		f.restoreExit = "unable to restore VM 9001 - command failed"
		f.taskLog = tail
		b := newTester(t, f)
		res, err := b.Run(context.Background(), vmParams())
		if err != nil || res.Outcome != "skipped" || res.Reason != "storage_space" || !res.CleanedUp {
			t.Fatalf("%q: %+v %v", tail, res, err)
		}
		if !strings.Contains(res.Message, "ran out of space") {
			t.Fatalf("message %q", res.Message)
		}
	}
}
