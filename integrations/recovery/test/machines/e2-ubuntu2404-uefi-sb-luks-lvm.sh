#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
#
# E2: Ubuntu 24.04, UEFI with Secure Boot, GPT, ESP, /boot, LUKS2 with LVM (root,
# swap, home), shim, netplan with macaddress. Disk: serial e2e-src0.
#   FACTORY_MIRROR=<Ubuntu archive> FACTORY_PASSPHRASE=<passphrase> sh e2-...sh
set -eu
HERE=$(cd "$(dirname "$0")" && pwd -P)
# shellcheck source=lib.sh
. "$HERE/lib.sh"
: "${FACTORY_MIRROR:?the Ubuntu archive}" "${FACTORY_PASSPHRASE:?the LUKS passphrase of the test machine}"
factory_prepare
d=$(disk_by_serial e2e-src0)
wipefs -a "$d" >/dev/null
sgdisk -Z -n 1:2048:+512M -t 1:EF00 -n 2:0:+1G -t 2:8300 -n 3:0:0 -t 3:8309 "$d" >/dev/null
partprobe "$d"; udevadm settle
mkfs.vfat -F 32 -n ESP "$(part "$d" 1)" >/dev/null
mkfs_ext4 ubuntu2404 "$(part "$d" 2)" boot
printf '%s' "$FACTORY_PASSPHRASE" | cryptsetup luksFormat --type luks2 --batch-mode --key-file - "$(part "$d" 3)"
printf '%s' "$FACTORY_PASSPHRASE" | cryptsetup open --key-file - "$(part "$d" 3)" cryptroot
pvcreate -q /dev/mapper/cryptroot && vgcreate -q vg0 /dev/mapper/cryptroot
lvcreate -q -L 6G -n root vg0 && lvcreate -q -L 1G -n swap vg0 && lvcreate -q -l 100%FREE -n home vg0
mkfs_ext4 ubuntu2404 /dev/vg0/root root
mkfs_ext4 ubuntu2404 /dev/vg0/home home
mkswap -q /dev/vg0/swap
root=/mnt/e2e
mkdir -p "$root" && mount /dev/vg0/root "$root"
mkdir -p "$root/boot" "$root/home" && mount "$(part "$d" 2)" "$root/boot" && mount /dev/vg0/home "$root/home"
mkdir -p "$root/boot/efi" && mount "$(part "$d" 1)" "$root/boot/efi"
bootstrap noble "$root" "$FACTORY_MIRROR" ubuntu-archive-keyring.gpg linux-image-generic grub-efi-amd64-signed shim-signed   cryptsetup cryptsetup-initramfs lvm2 initramfs-tools netplan.io
{
  fstab_uuid /dev/vg0/root / ext4 errors=remount-ro 1
  fstab_uuid "$(part "$d" 2)" /boot ext4 defaults 2
  fstab_uuid "$(part "$d" 1)" /boot/efi vfat umask=0077 1
  fstab_uuid /dev/vg0/home /home ext4 defaults 2
  echo "/dev/vg0/swap none swap sw 0 0"
} >"$root/etc/fstab"
printf 'cryptroot UUID=%s none luks,discard\n' "$(blkid -s UUID -o value "$(part "$d" 3)")" >"$root/etc/crypttab"
mac=$(cat /sys/class/net/*/address | grep -v '^00:00:00' | head -n 1)
mkdir -p "$root/etc/netplan"
printf 'network:\n  version: 2\n  ethernets:\n    lan:\n      match:\n        macaddress: "%s"\n      dhcp4: true\n' "$mac" >"$root/etc/netplan/50-e2e.yaml"
chmod 0600 "$root/etc/netplan/50-e2e.yaml"
chroot_mount "$root"
install_e2e_units "$root" e2-ubuntu2404
finish_root "$root"
in_root "$root" update-initramfs -u -k all
in_root "$root" grub-install --target=x86_64-efi --efi-directory=/boot/efi --uefi-secure-boot --no-nvram
printf 'GRUB_CMDLINE_LINUX="console=tty0 console=ttyS0,115200n8"\n' >>"$root/etc/default/grub"
in_root "$root" update-grub
# The red boot probe (scripts/recovery-e2e P2): a GRUB default that starts the emergency target,
# written after update-grub. The machine itself starts as before; the GRUB configuration the
# restore writes starts the emergency target, and the probe must say so.
if [ "${FACTORY_PROBE_EMERGENCY:-}" = 1 ]; then
  printf 'GRUB_CMDLINE_LINUX_DEFAULT="systemd.unit=emergency.target"\n' >>"$root/etc/default/grub"
fi
release_all "$root"
say "E2 ready"
