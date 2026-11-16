//go:build !windows

package pve

import (
	"fmt"
	"strings"
	"testing"
)

func TestRestoreMounts(t *testing.T) {
	zfs := mountSizing{StorageType: "zfspool"}
	lvm := mountSizing{StorageType: "lvmthin"}
	cases := []struct {
		name    string
		conf    map[string]string
		sizing  mountSizing
		mounts  map[string]string
		omitted []string
		err     string
	}{
		{
			name:   "volumes are named with their size and options",
			conf:   map[string]string{"rootfs": "local-lvm:vm-1-disk-0,size=8G", "mp0": "local-lvm:vm-1-disk-1,mp=/srv,size=4G"},
			sizing: zfs,
			mounts: map[string]string{"rootfs": "zfs:8", "mp0": "zfs:4,mp=/srv"},
		},
		{
			name: "bind and device mount points are left out with their lines",
			conf: map[string]string{
				"rootfs": "local-lvm:vm-113-disk-0,size=8G",
				"mp0":    "/mnt/paperless,mp=/data",
				"mp1":    "volume=nas:vm-113-disk-1,mp=/var/lib/db,acl=1,backup=1,size=1536M",
				"mp2":    "/dev/sdb1,mp=/mnt/usb",
				"mp3":    "local-lvm:vm-113-disk-2,mp=/scratch,backup=0,size=20G",
				"memory": "1024",
			},
			sizing: zfs,
			mounts: map[string]string{
				"rootfs": "zfs:8",
				"mp1":    "zfs:2,mp=/var/lib/db,acl=1,backup=1",
				"mp3":    "zfs:20,mp=/scratch,backup=0",
			},
			omitted: []string{"mp0: /mnt/paperless,mp=/data", "mp2: /dev/sdb1,mp=/mnt/usb"},
		},
		{
			name:    "size 0 (a subvolume without quota) onto a storage with subvolumes",
			conf:    map[string]string{"rootfs": "local-zfs:subvol-105-disk-0,size=0T", "mp0": "/mnt/host,mp=/host"},
			sizing:  zfs,
			mounts:  map[string]string{"rootfs": "zfs:0"},
			omitted: []string{"mp0: /mnt/host,mp=/host"},
		},
		{
			name:   "size 0 onto LVM thin: the size the restore point recorded",
			conf:   map[string]string{"rootfs": "local-zfs:subvol-105-disk-0,size=0T"},
			sizing: mountSizing{StorageType: "lvmthin", DeviceSizes: map[string]uint64{"rootfs": 12 << 30}, FallbackBytes: 3 << 30},
			mounts: map[string]string{"rootfs": "zfs:12"},
		},
		{
			name:   "size 0 onto LVM thin: the restore point's size and a fifth",
			conf:   map[string]string{"rootfs": "local-zfs:subvol-105-disk-0,size=0T", "mp0": "local-zfs:subvol-105-disk-1,mp=/data"},
			sizing: mountSizing{StorageType: "lvmthin", FallbackBytes: 10 << 30},
			mounts: map[string]string{"rootfs": "zfs:12", "mp0": "zfs:12,mp=/data"},
		},
		{
			name:   "no size and nothing known",
			conf:   map[string]string{"rootfs": "local-zfs:subvol-105-disk-0"},
			sizing: lvm,
			err:    "rootfs has no size, and the storage zfs (lvmthin) cannot create a volume without one",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			mounts, omitted, err := RestoreMounts(c.conf, "zfs", c.sizing)
			if c.err != "" {
				if err == nil || !strings.Contains(err.Error(), c.err) {
					t.Fatalf("err = %v", err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if fmt.Sprint(mounts) != fmt.Sprint(c.mounts) || fmt.Sprint(omitted) != fmt.Sprint(c.omitted) {
				t.Errorf("got %v %v, want %v %v", mounts, omitted, c.mounts, c.omitted)
			}
		})
	}
	if got := remountCommands(124, []string{"mp0: /mnt/paperless,mp=/data"}); len(got) != 1 || got[0] != "pct set 124 -mp0 /mnt/paperless,mp=/data" {
		t.Fatalf("remount %v", got)
	}
}
