#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
#
# E7: Debian 12, LUKS1 with an encrypted /boot (GRUB unlocks it; the passphrase is
# typed through QMP send-key), BIOS with GPT and a BIOS boot partition. The
# passphrase has z, y and - in it (keyboard layouts). Disk: serial e2e-src0.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd -P)
# shellcheck source=lib.sh
. "$HERE/lib.sh"
: "${FACTORY_MIRROR:?the Debian mirror of the snapshot}" "${FACTORY_PASSPHRASE:?the LUKS passphrase}"
case "$FACTORY_PASSPHRASE" in *z*y*-* | *y*z*-* | *-*z*y* | *-*y*z* | *z*-*y* | *y*-*z*) ;; *) fdie "E7 needs a passphrase with z, y and -" ;; esac
factory_prepare
d=$(disk_by_serial e2e-src0)
wipefs -a "$d" >/dev/null
sgdisk -Z -n 1:2048:+1M -t 1:EF02 -n 2:0:0 -t 2:8309 "$d" >/dev/null
partprobe "$d"; udevadm settle
printf '%s' "$FACTORY_PASSPHRASE" | cryptsetup luksFormat --type luks1 --batch-mode --key-file - "$(part "$d" 2)"
printf '%s' "$FACTORY_PASSPHRASE" | cryptsetup open --key-file - "$(part "$d" 2)" cryptroot
mkfs_ext4 debian12 /dev/mapper/cryptroot root
root=/mnt/e2e
mkdir -p "$root" && mount /dev/mapper/cryptroot "$root"
bootstrap bookworm "$root" "$FACTORY_MIRROR" debian-archive-keyring.gpg linux-image-amd64 grub-pc cryptsetup cryptsetup-initramfs initramfs-tools
fstab_uuid /dev/mapper/cryptroot / ext4 errors=remount-ro 1 >"$root/etc/fstab"
printf 'cryptroot UUID=%s none luks\n' "$(blkid -s UUID -o value "$(part "$d" 2)")" >"$root/etc/crypttab"
chroot_mount "$root"
install_e2e_units "$root" e7-debian12
finish_root "$root"
printf 'GRUB_ENABLE_CRYPTODISK=y\nGRUB_CMDLINE_LINUX="console=tty0 console=ttyS0,115200n8"\nGRUB_TERMINAL="console serial"\n' >>"$root/etc/default/grub"
in_root "$root" update-initramfs -u -k all
in_root "$root" grub-install --target=i386-pc "$d"
in_root "$root" update-grub
release_all "$root"
say "E7 ready"
