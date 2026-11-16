#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
#
# E9: a system disk (serial e2e-src0) plus a data RAID5 of three disks (e2e-data0,
# e2e-data1, e2e-data2) with LVM on it. The restore keeps the data array (adopt) and
# finds the old system disk still connected (an identity conflict).
set -eu
HERE=$(cd "$(dirname "$0")" && pwd -P)
# shellcheck source=lib.sh
. "$HERE/lib.sh"
: "${FACTORY_MIRROR:?the Debian mirror of the snapshot}"
factory_prepare
s=$(disk_by_serial e2e-src0)
wipefs -a "$s" >/dev/null
sgdisk -Z -n 1:2048:+1M -t 1:EF02 -n 2:0:0 -t 2:8300 "$s" >/dev/null
data=''
for serial in e2e-data0 e2e-data1 e2e-data2; do
  disk=$(disk_by_serial "$serial")
  wipefs -a "$disk" >/dev/null
  data="$data $disk"
done
partprobe "$s"; udevadm settle
# shellcheck disable=SC2086 # three disk names
mdadm --create /dev/md0 --run --level=5 --raid-devices=3 --metadata=1.2 $data
pvcreate -q /dev/md0 && vgcreate -q data /dev/md0 && lvcreate -q -l 100%FREE -n srv data
mkfs_ext4 debian12 /dev/data/srv srv
mkfs_ext4 debian12 "$(part "$s" 2)" root
root=/mnt/e2e
mkdir -p "$root" && mount "$(part "$s" 2)" "$root" && mkdir -p "$root/srv" && mount /dev/data/srv "$root/srv"
head -c 1048576 /dev/urandom >"$root/srv/data-marker"
bootstrap bookworm "$root" "$FACTORY_MIRROR" debian-archive-keyring.gpg linux-image-amd64 grub-pc mdadm lvm2 initramfs-tools
{
  fstab_uuid "$(part "$s" 2)" / ext4 errors=remount-ro 1
  fstab_uuid /dev/data/srv /srv ext4 defaults 2
} >"$root/etc/fstab"
mdadm --detail --scan >"$root/etc/mdadm/mdadm.conf"
chroot_mount "$root"
install_e2e_units "$root" e9-debian12
finish_root "$root"
in_root "$root" update-initramfs -u -k all
in_root "$root" grub-install --target=i386-pc "$s"
printf 'GRUB_CMDLINE_LINUX="console=tty0 console=ttyS0,115200n8"\n' >>"$root/etc/default/grub"
in_root "$root" update-grub
release_all "$root"
say "E9 ready"
