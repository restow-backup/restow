//go:build !windows

package pve

import (
	"fmt"
	"testing"
)

func TestTestRestoreMounts(t *testing.T) {
	cases := []struct {
		name    string
		conf    map[string]string
		mounts  map[string]string
		omitted []string
		err     bool
	}{
		{
			name: "volumes only keep PVE's own handling",
			conf: map[string]string{"rootfs": "local-lvm:vm-1-disk-0,size=8G", "mp0": "local-lvm:vm-1-disk-1,mp=/srv,size=4G"},
		},
		{
			name: "a bind mount is left out, volumes are named with their size and options",
			conf: map[string]string{
				"rootfs": "local-lvm:vm-113-disk-0,size=8G",
				"mp0":    "/mnt/paperless,mp=/data",
				"mp1":    "volume=nas:vm-113-disk-1,mp=/var/lib/db,acl=1,backup=1,size=1536M",
				"mp2":    "/dev/sdb1,mp=/mnt/usb",
				"memory": "1024",
			},
			mounts: map[string]string{
				"rootfs": "zfs:8",
				"mp1":    "zfs:2,mp=/var/lib/db,acl=1,backup=1",
			},
			omitted: []string{"mp0 (/mnt/paperless)", "mp2 (/dev/sdb1)"},
		},
		{
			name: "a volume without a size cannot be recreated",
			conf: map[string]string{"rootfs": "local-lvm:vm-1-disk-0", "mp0": "/mnt/host,mp=/host"},
			err:  true,
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			mounts, omitted, err := TestRestoreMounts(c.conf, "zfs")
			if (err != nil) != c.err {
				t.Fatalf("err = %v", err)
			}
			if c.err {
				return
			}
			if fmt.Sprint(mounts) != fmt.Sprint(c.mounts) || fmt.Sprint(omitted) != fmt.Sprint(c.omitted) {
				t.Errorf("got %v %v, want %v %v", mounts, omitted, c.mounts, c.omitted)
			}
		})
	}
}
