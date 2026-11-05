#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
#
# E10: Debian 12 with a plain dm-crypt swap (cswap /dev/vdb2 /dev/urandom swap) and a
# data file system on the third disk; the restore puts the disks in another order.
# Disks: serial e2e-src0 (system), e2e-src1 (swap), e2e-src2 (data).
set -eu
HERE=$(cd "$(dirname "$0")" && pwd -P)
# shellcheck source=lib.sh
. "$HERE/lib.sh"
: "${FACTORY_MIRROR:?the Debian mirror of the snapshot}"
factory_prepare
s=$(disk_by_serial e2e-src0)
w=$(disk_by_serial e2e-src1)
x=$(disk_by_serial e2e-src2)
for disk in "$s" "$w" "$x"; do wipefs -a "$disk" >/dev/null; done
printf 'label: dos\n2048,,83,*\n' | sfdisk -q "$s"
printf 'label: dos\n2048,1048576,83\n,2097152,82\n' | sfdisk -q "$w"
printf 'label: dos\n2048,,83\n' | sfdisk -q "$x"
partprobe "$s" "$w" "$x"; udevadm settle
mkfs_ext4 debian12 "$(part "$s" 1)" root
mkfs_ext4 debian12 "$(part "$x" 1)" data
root=/mnt/e2e
mkdir -p "$root" && mount "$(part "$s" 1)" "$root" && mkdir -p "$root/data" && mount "$(part "$x" 1)" "$root/data"
head -c 1048576 /dev/urandom >"$root/data/data-marker"
bootstrap bookworm "$root" "$FACTORY_MIRROR" debian-archive-keyring.gpg linux-image-amd64 grub-pc cryptsetup initramfs-tools
{
  fstab_uuid "$(part "$s" 1)" / ext4 errors=remount-ro 1
  fstab_uuid "$(part "$x" 1)" /data ext4 defaults 2
  echo "/dev/mapper/cswap none swap sw 0 0"
} >"$root/etc/fstab"
# The device name on purpose: the restore must resolve it by the PARTUUID of the layout.
printf 'cswap %s /dev/urandom swap\n' "$(part "$w" 2)" >"$root/etc/crypttab"
chroot_mount "$root"
install_e2e_units "$root" e10-debian12
finish_root "$root"
in_root "$root" update-initramfs -u -k all
in_root "$root" grub-install --target=i386-pc "$s"
printf 'GRUB_CMDLINE_LINUX="console=tty0 console=ttyS0,115200n8"\n' >>"$root/etc/default/grub"
in_root "$root" update-grub
release_all "$root"
say "E10 ready"
