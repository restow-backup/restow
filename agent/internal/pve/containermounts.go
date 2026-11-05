//go:build !windows

package pve

import (
	"context"
	"fmt"
	"sort"
	"strconv"
	"strings"
)

// The mount points of a container restore (a restore into a new guest, a restore test, a boot
// test).
//
// Restored without rootfs or mpN, a container gets the mount points of its backup (PVE's
// "storage only" mode). For a bind or device mount point PVE then refuses anyone but root@pam
// ("restoring 'mp0' to bind mount is only possible for root"), and the node restores with its
// API token. The data of a bind or device mount point lives on the host and is not part of the
// backup anyway. Every container restore therefore names rootfs and the volume mount points
// itself, each a new volume on the target storage with its own options; PVE then takes no mount
// point from the backup, and the bind and device mount points are left out. restow-pve never
// runs `pct restore` as root instead: the copy would get the original's bind mounts and, once
// started, write into the original's live data.

// mountSizing is what sizes a volume whose configuration has no size (size=0: a ZFS or
// directory subvolume without a quota).
type mountSizing struct {
	// StorageType is the type of the target storage ("zfspool", "lvmthin", ...; "" unknown).
	StorageType string
	// DeviceSizes are the sizes the restore point recorded per mount point (rootfs, mpN).
	DeviceSizes map[string]uint64
	// FallbackBytes is the restore point's size, the last resort.
	FallbackBytes uint64
}

// subvolumeStorages create a volume of size 0: a subvolume without a quota.
var subvolumeStorages = map[string]bool{"zfspool": true, "dir": true, "btrfs": true}

// RestoreMounts returns the rootfs and mpN parameters of a restore of the container
// configuration conf onto storage, and the configuration lines of the mount points it leaves
// out (bind and device mount points). An error means a volume can be given no size on that
// storage; nothing was restored then.
func RestoreMounts(conf map[string]string, storage string, sz mountSizing) (mounts map[string]string, omitted []string, err error) {
	keys := make([]string, 0, len(conf))
	for k := range conf {
		if mpKeyRE.MatchString(k) {
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)
	if len(keys) == 0 {
		return nil, nil, nil
	}
	mounts = map[string]string{}
	for _, k := range keys {
		v := conf[k]
		if k != "rootfs" && !isVolumeMount(v) {
			omitted = append(omitted, k+": "+v)
			continue
		}
		size, err := volumeSize(k, v, storage, sz)
		if err != nil {
			return nil, omitted, err
		}
		parts := []string{storage + ":" + size}
		for _, opt := range mountOptions(v) {
			key, _, _ := strings.Cut(opt, "=")
			if key == "size" || key == "volume" {
				continue
			}
			parts = append(parts, opt)
		}
		mounts[k] = strings.Join(parts, ",")
	}
	return mounts, omitted, nil
}

// volumeSize is the size in GiB a restore asks for a volume mount point.
func volumeSize(key, value, storage string, sz mountSizing) (string, error) {
	if size := ParseDiskSize(value); size > 0 {
		return strconv.FormatUint(gibUp(size), 10), nil
	}
	// No size, or size=0: a subvolume without a quota where the storage has subvolumes.
	if subvolumeStorages[sz.StorageType] {
		return "0", nil
	}
	if size := sz.DeviceSizes[key]; size > 0 {
		return strconv.FormatUint(gibUp(size), 10), nil
	}
	if sz.FallbackBytes > 0 {
		// The restore point's data and a fifth more.
		return strconv.FormatUint(gibUp(sz.FallbackBytes+sz.FallbackBytes/5), 10), nil
	}
	kind := sz.StorageType
	if kind == "" {
		kind = "of unknown type"
	}
	return "", fmt.Errorf("%s has no size, and the storage %s (%s) cannot create a volume without one (size 0 needs zfspool, dir or btrfs)", key, storage, kind)
}

func gibUp(bytes uint64) uint64 { return (bytes + 1<<30 - 1) >> 30 }

// mountSizing reads what sizes a container's volumes without a size on storage: its type, and
// the sizes the restore point knows.
func (b *BootTester) mountSizing(ctx context.Context, storage string, rp *RestorePoint) mountSizing {
	sz := mountSizing{DeviceSizes: map[string]uint64{}}
	if list, err := b.PVE.Storages(ctx, b.State.NodeName); err == nil {
		for _, st := range list {
			if st.Storage == storage {
				sz.StorageType = st.Type
			}
		}
	}
	if rp != nil {
		sz.FallbackBytes = rp.ByteSize
		for _, d := range rp.Devices {
			sz.DeviceSizes[d.Device] = d.Size
		}
	}
	return sz
}

// remountCommands are the commands that put left-out mount points back (as root). Re-adding a
// bind mount point makes the copy share the original's live data, and on another node the host
// path may not exist.
func remountCommands(vmid int, omitted []string) []string {
	var out []string
	for _, line := range omitted {
		key, value, ok := strings.Cut(line, ": ")
		if ok {
			out = append(out, fmt.Sprintf("pct set %d -%s %s", vmid, key, value))
		}
	}
	return out
}

// mountVolume is the volume part of a mount point ("local-lvm:vm-1-disk-1", "/srv/data").
func mountVolume(value string) string {
	for i, part := range strings.Split(value, ",") {
		part = strings.TrimSpace(part)
		if after, ok := strings.CutPrefix(part, "volume="); ok {
			return after
		}
		if i == 0 && !strings.Contains(part, "=") {
			return part
		}
	}
	return ""
}

// mountOptions are the options of a mount point, without its leading volume.
func mountOptions(value string) []string {
	var out []string
	for i, part := range strings.Split(value, ",") {
		part = strings.TrimSpace(part)
		if part == "" || (i == 0 && !strings.Contains(part, "=")) {
			continue
		}
		out = append(out, part)
	}
	return out
}

// isVolumeMount: a storage volume; a bind or device mount point names an absolute host path.
func isVolumeMount(value string) bool {
	return !strings.HasPrefix(mountVolume(value), "/")
}

// lxcOptions are the raw lxc.* lines of a container configuration. PVE restores them only for
// root@pam: the token's restore skips them with "skipping custom lxc options, restore manually
// as root" and ends "WARNINGS: 1" (GPU or TUN passthrough, a custom idmap).
type lxcOptions struct {
	Lines []string
	// IDMap: a custom lxc.idmap among them. The restored container uses the default map, so
	// its files belong to the ids of that map.
	IDMap bool
}

// rawLxcOptions reads the lxc.* lines of a configuration text up to its first snapshot section
// (they may repeat, so parseConfigText's map does not hold them).
func rawLxcOptions(text string) lxcOptions {
	var out lxcOptions
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "[") {
			break
		}
		if !strings.HasPrefix(line, "lxc.") {
			continue
		}
		out.Lines = append(out.Lines, line)
		if strings.HasPrefix(line, "lxc.idmap") {
			out.IDMap = true
		}
	}
	return out
}
