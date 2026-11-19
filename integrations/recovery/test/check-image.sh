#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
#
# The image checks of the CI job recovery-iso (README.md, "Check"):
#   test/check-image.sh <iso> <version>
# Needs root (unsquashfs into a chroot), squashfs-tools, xorriso and 7z or
# bsdtar to read the ISO. Writes nothing outside a temporary folder.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd -P)
# shellcheck source=../lib/functions.sh
. "$HERE/../lib/functions.sh"

[ $# -eq 2 ] || { echo "usage: $0 <iso> <version>" >&2; exit 2; }
iso="$1"
version="$2"
[ -f "$iso" ] || rr_die "$iso does not exist"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
fail=0
problem() {
  printf 'FAIL: %s\n' "$*"
  fail=1
}

# Size below 900 MiB.
size=$(wc -c <"$iso" | tr -d ' ')
[ "$size" -lt $((900 * 1024 * 1024)) ] || problem "the ISO has $size bytes, more than 900 MiB"

# BIOS and UEFI boot entries.
report=$(xorriso -indev "$iso" -report_el_torito plain 2>/dev/null || true)
printf '%s\n' "$report" | grep -q 'El Torito boot img :   1  BIOS' || problem "no BIOS El Torito boot entry"
printf '%s\n' "$report" | grep -q 'El Torito boot img :   2  UEFI' || problem "no UEFI El Torito boot entry"

# The BIOS menu starts its default entry on its own (isolinux.cfg; live-build's own waits forever).
xorriso -osirrox on -indev "$iso" -extract /isolinux/isolinux.cfg "$work/isolinux.cfg" >/dev/null 2>&1 ||
  problem "cannot read /isolinux/isolinux.cfg from $iso"
if [ -f "$work/isolinux.cfg" ]; then
  [ "$(grep -E '^[[:space:]]*timeout ' "$work/isolinux.cfg")" = 'timeout 100' ] ||
    problem "the BIOS boot menu has no time limit of 10 seconds: $(grep -E '^[[:space:]]*timeout ' "$work/isolinux.cfg" | tr '\n' ' ')"
fi

# The live file system.
xorriso -osirrox on -indev "$iso" -extract /live/filesystem.squashfs "$work/filesystem.squashfs" >/dev/null 2>&1 ||
  rr_die "cannot read /live/filesystem.squashfs from $iso"
unsquashfs -q -d "$work/root" "$work/filesystem.squashfs" >/dev/null
root="$work/root"

# Exactly the firmware packages of the list, and the Intel ice DDP package. Installed
# ones only: with a pattern, dpkg-query also names packages it knows only from other
# packages' Provides, Recommends or Conflicts (firmware-adi, firmware-intel-graphics, ...).
# shellcheck disable=SC2016 # a dpkg-query format, not a shell expansion
chroot "$root" dpkg-query -W -f '${db:Status-Status} ${Package}\n' 'firmware-*' >"$work/firmware-status" 2>/dev/null || true
rr_installed_names "$work/firmware-status" >"$work/firmware"
rr_list_compare "$HERE/../config/package-lists/firmware.list.chroot" "$work/firmware" ||
  problem "the firmware packages of the image differ from firmware.list.chroot"
[ -f "$root/lib/firmware/intel/ice/ddp/ice.pkg" ] || [ -f "$root/usr/lib/firmware/intel/ice/ddp/ice.pkg" ] ||
  problem "intel/ice/ddp/ice.pkg is missing (firmware.md, the package name of trixie)"

# The recovery program and its version.
agent="/usr/lib/restow-recovery/restow-agent"
[ -x "$root$agent" ] || rr_die "$agent is missing in the image"
have=$(chroot "$root" "$agent" version --short 2>/dev/null || true)
[ "$have" = "$version" ] || problem "restow-agent version --short says '$have', not $version"
[ -x "$root/usr/lib/restow-recovery/restic" ] || problem "restic is missing in the image"
[ -f "$root/usr/lib/restow-recovery/THIRD_PARTY_NOTICES.txt" ] || problem "THIRD_PARTY_NOTICES.txt is missing"
[ -f "$root/usr/share/doc/restow-recovery/FIRMWARE-LICENSES.txt" ] || problem "FIRMWARE-LICENSES.txt is missing"

# Every program the recovery program calls (its own table, so the list cannot age).
chroot "$root" "$agent" recover --list-tools >"$work/tools" || problem "restow-agent recover --list-tools failed"
while read -r program package; do
  [ -n "$program" ] || continue
  chroot "$root" sh -c "command -v '$program'" >/dev/null 2>&1 ||
    problem "$program (from $package) is not in the image"
done <"$work/tools"

# The keyboard layouts the boot menu offers compile with the image's own ckbcomp and
# loadkeys (rr_keymap_compiles; the chroot has no console, loadkeys gets none).
mkdir -p "$root/tmp"
cp "$HERE/../lib/functions.sh" "$root/tmp/rr-functions.sh"
for layout in de us ch at fr; do
  # shellcheck disable=SC2016 # $1 is expanded by the image's shell
  chroot "$root" /bin/sh -c '. /tmp/rr-functions.sh && rr_keymap_compiles "$1"' sh "$layout" >/dev/null 2>&1 ||
    problem "keyboard layout $layout does not compile (ckbcomp | loadkeys)"
done
rm -f "$root/tmp/rr-functions.sh"

# Nothing activates by itself (the files of README.md, "No auto-activation").
grep -q 'auto_activation_volume_list = \[\]' "$root/etc/lvm/lvmlocal.conf" || problem "lvmlocal.conf activates volume groups"
grep -q '^AUTO -all' "$root/etc/mdadm/mdadm.conf" || problem "mdadm.conf assembles arrays"
[ "$(readlink "$root/etc/systemd/system-generators/systemd-gpt-auto-generator")" = /dev/null ] ||
  problem "systemd-gpt-auto-generator is not masked"

# efivarfs in the initramfs on every build host (hooks/zz-restow-efivarfs; mdadm's hook adds it
# only on a host started with UEFI, and the build hosts must agree bit for bit): the module once,
# as the last line of conf/modules, and the hook's mark, unpacked with the image's own
# unmkinitramfs.
initrd=''
for file in "$root"/boot/initrd.img-*; do
  [ -f "$file" ] && initrd="/boot/${file##*/}"
done
rm -rf "$root/tmp/restow-initrd"
if [ -n "$initrd" ] && chroot "$root" unmkinitramfs "$initrd" /tmp/restow-initrd >/dev/null 2>&1; then
  found=0
  for modules in $(find "$root/tmp/restow-initrd" -path '*conf/modules' | LC_ALL=C sort); do
    found=1
    if [ "$(tail -n 1 "$modules")" != efivarfs ] || [ "$(grep -cx efivarfs "$modules")" != 1 ]; then
      problem "${modules#"$root/tmp/restow-initrd/"} of the initramfs does not end with efivarfs once: $(tr '\n' ' ' <"$modules")"
    fi
  done
  [ "$found" = 1 ] || problem "the initramfs has no conf/modules"
  find "$root/tmp/restow-initrd" -path '*etc/restow-efivarfs' | grep -q . ||
    problem "the initramfs was made without hooks/zz-restow-efivarfs (no etc/restow-efivarfs)"
  find "$root/tmp/restow-initrd" -name 'efivarfs.ko*' | grep -q . || problem "the initramfs has no efivarfs module"
else
  problem "cannot unpack the initramfs ${initrd:-(none in /boot)}"
fi
rm -rf "$root/tmp/restow-initrd"

# Nothing of the build: the two builds of one version are equal bit for bit.
leftovers=$(rr_build_leftovers "$root") ||
  problem "build leftovers in the image: $(echo "$leftovers" | tr '\n' ' ')"

# No secrets, nothing of an instance.
sh "$HERE/no-secrets.sh" "$root" || problem "secrets or instance data in the image"

[ "$fail" -eq 0 ] || exit 1
echo "check-image: $iso passes"
