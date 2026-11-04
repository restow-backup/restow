//go:build !windows

package pve

import (
	"bufio"
	"os"
	"strings"
)

// What a restore takes of a storage. A thin storage (lvmthin, rbd, a sparse zfspool, a file
// storage without full preallocation) gets only the restore point's data written; a thick one
// allocates every disk in full when the restore creates it: a logical volume of type lvm, a
// zvol of a zfspool without `sparse` (it gets a refreservation of its whole size), a raw file
// with `preallocation full` or `falloc`. The boot test checks its storage with this, and a
// restore check can do the same.

// storageOptions are the options of one storage in /etc/pve/storage.cfg that decide whether
// it is thin. The node's API token may not read them (GET /storage/{id} needs
// Datastore.Allocate), the service as root reads the file.
type storageOptions struct {
	Known         bool
	Sparse        bool
	Preallocation string
}

// pveStorageConfig is the cluster's storage configuration (tests point it elsewhere).
const pveStorageConfig = "/etc/pve/storage.cfg"

// readStorageOptions reads the options of the storage id from a storage.cfg.
func readStorageOptions(path, id string) storageOptions {
	f, err := os.Open(path)
	if err != nil {
		return storageOptions{}
	}
	defer f.Close()
	var out storageOptions
	in := false
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := sc.Text()
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		if line[0] != ' ' && line[0] != '\t' {
			// "zfspool: local-zfs" starts a section.
			_, name, ok := strings.Cut(trimmed, ":")
			in = ok && strings.TrimSpace(name) == id
			if in {
				out.Known = true
			}
			continue
		}
		if !in {
			continue
		}
		key, value, _ := strings.Cut(trimmed, " ")
		value = strings.TrimSpace(value)
		switch key {
		case "sparse":
			out.Sparse = value == "" || value == "1"
		case "preallocation":
			out.Preallocation = value
		}
	}
	return out
}

func (b *BootTester) storageOptions(id string) storageOptions {
	path := b.StorageConfig
	if path == "" {
		path = pveStorageConfig
	}
	return readStorageOptions(path, id)
}

// RestoreSpaceNeed is what a restore of a guest of kind with data bytes of stored data and
// disks bytes of disks takes of the storage st, and on what it is based (for the log and the
// skip text). Unknown: the disks in full.
func RestoreSpaceNeed(kind string, st Storage, opts storageOptions, data, disks uint64) (uint64, string) {
	thick := func() (uint64, string) {
		if disks == 0 {
			return data, "the restore point's data; the size of its disks is not known"
		}
		return disks, "the full size of the disks, as " + st.Type + " allocates them"
	}
	thin := func() (uint64, string) {
		if data == 0 {
			if disks == 0 {
				return 0, "nothing known of the restore point's size"
			}
			return disks, "the full size of the disks; the restore point's data is not known"
		}
		return data, "the restore point's data on a thin storage"
	}
	switch st.Type {
	case "lvmthin", "rbd", "btrfs", "cephfs":
		return thin()
	case "zfspool", "zfs":
		// A container's subvolume has a refquota, which reserves nothing; a VM's zvol is
		// reserved in full unless the storage is sparse.
		if kind == "ct" || opts.Sparse {
			return thin()
		}
	case "dir", "nfs", "cifs", "glusterfs":
		// Raw and qcow2 files are created without preallocation by default (PVE's default
		// "metadata" is "off" for raw); unknown options count as preallocated.
		if opts.Known && opts.Preallocation != "full" && opts.Preallocation != "falloc" {
			return thin()
		}
	}
	// lvm, a zvol without sparse, a preallocating or unknown storage.
	return thick()
}

// containerVolumeBytes is the size of a container's rootfs and volume mount points from its
// configuration (bind and device mount points are not restored; size=0 counts nothing).
func containerVolumeBytes(conf map[string]string) uint64 {
	var sum uint64
	for k, v := range conf {
		if mpKeyRE.MatchString(k) && (k == "rootfs" || isVolumeMount(v)) {
			sum += ParseDiskSize(v)
		}
	}
	return sum
}
