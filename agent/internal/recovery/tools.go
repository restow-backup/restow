package recovery

import (
	"fmt"
	"io"
	"sort"

	"github.com/restow-backup/restow/agent/internal/cmdrun"
)

// Tool is a program of the recovery ISO that recover calls (from the
// plan or for its own operations), with the Debian package that ships it.
// The CI job that builds the ISO runs `restow-agent recover --list-tools`
// and checks every program with command -v (contract C-M4-1).
type Tool struct {
	Program string
	Package string
	Purpose string
}

// Tools is the table of programs (restic is bundled at
// /usr/lib/restow-recovery/restic and not listed; programs of the target
// system run through chroot-exec and are not listed either).
var Tools = []Tool{
	{"bash", "bash", "the shell of the menu"},
	{"blkdiscard", "util-linux", "discard a target disk on request"},
	{"blkid", "util-linux", "signatures and identities"},
	{"blockdev", "util-linux", "flush buffers before the restart"},
	{"btrfs", "btrfs-progs", "subvolumes, quota, swap file offsets"},
	{"chattr", "e2fsprogs", "nodatacow folders and swap files"},
	{"chpasswd", "passwd", "one-time root password for remote access"},
	{"ckbcomp", "console-setup", "keyboard layouts"},
	{"cryptsetup", "cryptsetup-bin", "LUKS"},
	{"dd", "coreutils", "swap files on btrfs"},
	{"dmsetup", "dmsetup", "release device-mapper holders"},
	{"dumpe2fs", "e2fsprogs", "read back ext features"},
	{"e2fsck", "e2fsprogs", "check ext file systems"},
	{"fallocate", "util-linux", "swap files"},
	{"filefrag", "e2fsprogs", "resume offset of swap files"},
	{"findmnt", "util-linux", "check the fstab of the target"},
	{"loadkeys", "kbd", "keyboard layouts"},
	{"lsblk", "util-linux", "block devices"},
	{"lspci", "pciutils", "devices without a driver"},
	{"lvcreate", "lvm2", "logical volumes"},
	{"lvm", "lvm2", "LVM"},
	{"lvs", "lvm2", "check logical volumes"},
	{"mdadm", "mdadm", "md arrays"},
	{"mkfs.btrfs", "btrfs-progs", "btrfs"},
	{"mkfs.ext4", "e2fsprogs", "ext2, ext3, ext4"},
	{"mkfs.vfat", "dosfstools", "ESP"},
	{"mkfs.xfs", "xfsprogs", "XFS"},
	{"mkswap", "util-linux", "swap"},
	{"mokutil", "mokutil", "machine owner keys"},
	{"mount", "mount", "mount the target"},
	{"networkctl", "systemd", "network configuration"},
	{"partprobe", "parted", "reread partition tables"},
	{"pvcreate", "lvm2", "physical volumes"},
	{"pvs", "lvm2", "adoption of volume groups"},
	{"sfdisk", "fdisk", "partition tables"},
	{"sgdisk", "gdisk", "GPT repair"},
	{"ssh-keygen", "openssh-client", "host keys for remote access"},
	{"sshd", "openssh-server", "remote access"},
	{"swapoff", "mount", "release swap areas"},
	{"sync", "coreutils", "flush before the restart"},
	{"systemctl", "systemd", "restart and power off"},
	{"udevadm", "udev", "wait for device links"},
	{"umount", "mount", "unmount"},
	{"vgchange", "lvm2", "activate and deactivate volume groups"},
	{"vgcreate", "lvm2", "volume groups"},
	{"wipefs", "util-linux", "remove signatures"},
	{"xfs_info", "xfsprogs", "read back XFS features"},
}

// Operations are the names in args[0] of a plan step that recover carries
// out itself (baremetal.Step).
var Operations = map[string]bool{
	"release-holders": true, "blkzero": true, "pmbr-boot": true, "fixup": true, "mkdirs": true, "swapfile": true,
	"keyfile": true, "nvram": true, "fallback-path": true, "mok-import": true, "selinux": true, "verify": true,
	"chroot-exec": true,
}

// ListTools writes the table for --list-tools: one line per program,
// sorted, program and package separated by a space.
func ListTools(w io.Writer) error {
	list := append([]Tool(nil), Tools...)
	sort.Slice(list, func(i, j int) bool { return list[i].Program < list[j].Program })
	for _, t := range list {
		if _, err := fmt.Fprintf(w, "%s %s\n", t.Program, t.Package); err != nil {
			return err
		}
	}
	return nil
}

// KnownTool reports whether name is in the table.
func KnownTool(name string) bool {
	for _, t := range Tools {
		if t.Program == name {
			return true
		}
	}
	return false
}

// Resolve finds a program of the table in the root-owned tool directories.
func Resolve(name string) (string, error) {
	if !KnownTool(name) {
		return "", fmt.Errorf("%s is not a tool of the recovery ISO", name)
	}
	return cmdrun.ExecRunner{}.Resolve(name)
}
