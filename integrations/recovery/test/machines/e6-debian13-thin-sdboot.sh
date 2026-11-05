#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
#
# E6: Debian 13, UEFI without Secure Boot, LVM thin, systemd-boot set up by hand.
# Disk: serial e2e-src0.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd -P)
# shellcheck source=lib.sh
. "$HERE/lib.sh"
: "${FACTORY_MIRROR:?the Debian mirror of the snapshot}"
factory_prepare
d=$(disk_by_serial e2e-src0)
wipefs -a "$d" >/dev/null
sgdisk -Z -n 1:2048:+1G -t 1:EF00 -n 2:0:0 -t 2:8E00 "$d" >/dev/null
partprobe "$d"; udevadm settle
mkfs.vfat -F 32 -n ESP "$(part "$d" 1)" >/dev/null
pvcreate -q "$(part "$d" 2)" && vgcreate -q vg0 "$(part "$d" 2)"
lvcreate -q --type thin-pool -l 90%FREE -n pool vg0
lvcreate -q -V 8G --thinpool vg0/pool -n root
mkfs_ext4 debian13 /dev/vg0/root root
root=/mnt/e2e
mkdir -p "$root" && mount /dev/vg0/root "$root" && mkdir -p "$root/boot/efi" && mount "$(part "$d" 1)" "$root/boot/efi"
bootstrap trixie "$root" "$FACTORY_MIRROR" debian-archive-keyring.gpg linux-image-amd64 systemd-boot lvm2 thin-provisioning-tools initramfs-tools
{
  fstab_uuid /dev/vg0/root / ext4 errors=remount-ro 1
  fstab_uuid "$(part "$d" 1)" /boot/efi vfat umask=0077 1
} >"$root/etc/fstab"
chroot_mount "$root"
install_e2e_units "$root" e6-debian13
finish_root "$root"
printf 'root=UUID=%s ro console=tty0 console=ttyS0,115200n8\n' "$(blkid -s UUID -o value /dev/vg0/root)" >"$root/etc/kernel/cmdline"
in_root "$root" bootctl --esp-path=/boot/efi install --no-variables
in_root "$root" update-initramfs -u -k all
release_all "$root"
say "E6 ready"
