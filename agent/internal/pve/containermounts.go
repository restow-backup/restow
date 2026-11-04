//go:build !windows

package pve

import (
	"fmt"
	"sort"
	"strings"
)

// Restore checks and boot tests of containers with a bind or device mount point.
//
// Restored without rootfs or mpN, a container gets the mount points of its backup
// (PVE's "storage only" mode). For a bind or device mount point PVE then refuses
// anyone but root@pam ("restoring 'mp0' to bind mount is only possible for root"),
// and the node restores with its API token, so every check of such a container
// failed. The data of a bind or device mount point lives on the host and is not part
// of the backup anyway. A check therefore names rootfs and the volume mount points
// itself, each a new volume of the same size on the check's storage with its own
// options; PVE then takes no mount point from the backup, and the bind and device
// mount points are left out of the temporary container.

// TestRestoreMounts returns the rootfs and mpN parameters of a check's restore of the
// container configuration conf onto storage, and the mount points it leaves out.
// mounts is nil when conf has no bind or device mount point: the restore then keeps
// PVE's own handling. An error means a volume of conf has no size to recreate it with.
func TestRestoreMounts(conf map[string]string, storage string) (mounts map[string]string, omitted []string, err error) {
	keys := make([]string, 0, len(conf))
	for k := range conf {
		if mpKeyRE.MatchString(k) {
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)
	for _, k := range keys {
		if k != "rootfs" && !isVolumeMount(conf[k]) {
			omitted = append(omitted, fmt.Sprintf("%s (%s)", k, mountVolume(conf[k])))
		}
	}
	if len(omitted) == 0 {
		return nil, nil, nil
	}
	mounts = map[string]string{}
	for _, k := range keys {
		v := conf[k]
		if k != "rootfs" && !isVolumeMount(v) {
			continue
		}
		size := ParseDiskSize(v)
		if size == 0 {
			return nil, omitted, fmt.Errorf("%s has no size to recreate it with", k)
		}
		gib := (size + 1<<30 - 1) >> 30
		parts := []string{fmt.Sprintf("%s:%d", storage, gib)}
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
