#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
#
# E1: Debian 12, BIOS, MBR, mdadm RAID1 of two disks with ext4 / and /boot, a swap
# partition, initramfs-tools. Disks: serial e2e-src0 and e2e-src1.
#   FACTORY_MIRROR=<snapshot.debian.org URL of bookworm> sh e1-debian12-bios-md.sh
set -eu
HERE=$(cd "$(dirname "$0")" && pwd -P)
# shellcheck source=lib.sh
. "$HERE/lib.sh"
: "${FACTORY_MIRROR:?the Debian mirror of the snapshot}"
factory_prepare
a=$(disk_by_serial e2e-src0)
b=$(disk_by_serial e2e-src1)
for disk in "$a" "$b"; do
  wipefs -a "$disk" >/dev/null
  printf 'label: dos\nunit: sectors\n2048,1048576,fd,*\n,4194304,82\n,,fd\n' | sfdisk -q "$disk"
done
partprobe "$a" "$b"; udevadm settle
mdadm --create /dev/md0 --run --level=1 --raid-devices=2 --metadata=1.2 "$(part "$a" 1)" "$(part "$b" 1)"
mdadm --create /dev/md1 --run --level=1 --raid-devices=2 --metadata=1.2 "$(part "$a" 3)" "$(part "$b" 3)"
mkfs_ext4 debian12 /dev/md0 boot
mkfs_ext4 debian12 /dev/md1 root
mkswap -q "$(part "$a" 2)"
root=/mnt/e2e
mkdir -p "$root" && mount /dev/md1 "$root" && mkdir -p "$root/boot" && mount /dev/md0 "$root/boot"
bootstrap bookworm "$root" "$FACTORY_MIRROR" debian-archive-keyring.gpg linux-image-amd64 grub-pc mdadm initramfs-tools
{
  fstab_uuid /dev/md1 / ext4 errors=remount-ro 1
  fstab_uuid /dev/md0 /boot ext4 defaults 2
  fstab_uuid "$(part "$a" 2)" none swap sw 0
} >"$root/etc/fstab"
mdadm --detail --scan >"$root/etc/mdadm/mdadm.conf"
chroot_mount "$root"
install_e2e_units "$root" e1-debian12
finish_root "$root"
in_root "$root" update-initramfs -u -k all
for disk in "$a" "$b"; do in_root "$root" grub-install --target=i386-pc "$disk"; done
printf 'GRUB_CMDLINE_LINUX="console=tty0 console=ttyS0,115200n8"\nGRUB_TERMINAL="console serial"\n' >>"$root/etc/default/grub"
in_root "$root" update-grub
release_all "$root"
say "E1 ready"
