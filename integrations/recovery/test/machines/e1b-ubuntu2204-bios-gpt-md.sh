#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
#
# E1b: Ubuntu 22.04, BIOS, GPT with a BIOS boot partition on each disk, mdadm RAID1.
# Disks: serial e2e-src0 and e2e-src1. FACTORY_MIRROR is Ubuntu's archive (or a mirror).
set -eu
HERE=$(cd "$(dirname "$0")" && pwd -P)
# shellcheck source=lib.sh
. "$HERE/lib.sh"
: "${FACTORY_MIRROR:?the Ubuntu archive}"
factory_prepare
a=$(disk_by_serial e2e-src0)
b=$(disk_by_serial e2e-src1)
for disk in "$a" "$b"; do
  wipefs -a "$disk" >/dev/null
  sgdisk -Z -n 1:2048:+1M -t 1:EF02 -n 2:0:0 -t 2:FD00 "$disk" >/dev/null
done
partprobe "$a" "$b"; udevadm settle
mdadm --create /dev/md0 --run --level=1 --raid-devices=2 --metadata=1.2 "$(part "$a" 2)" "$(part "$b" 2)"
mkfs_ext4 ubuntu2204 /dev/md0 root
root=/mnt/e2e
mkdir -p "$root" && mount /dev/md0 "$root"
bootstrap jammy "$root" "$FACTORY_MIRROR" ubuntu-archive-keyring.gpg linux-image-generic grub-pc mdadm initramfs-tools
fstab_uuid /dev/md0 / ext4 errors=remount-ro 1 >"$root/etc/fstab"
mdadm --detail --scan >"$root/etc/mdadm/mdadm.conf"
chroot_mount "$root"
install_e2e_units "$root" e1b-ubuntu2204
finish_root "$root"
in_root "$root" update-initramfs -u -k all
for disk in "$a" "$b"; do in_root "$root" grub-install --target=i386-pc "$disk"; done
printf 'GRUB_CMDLINE_LINUX="console=tty0 console=ttyS0,115200n8"\n' >>"$root/etc/default/grub"
in_root "$root" update-grub
release_all "$root"
say "E1b ready"
