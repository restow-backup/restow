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

# The live file system.
xorriso -osirrox on -indev "$iso" -extract /live/filesystem.squashfs "$work/filesystem.squashfs" >/dev/null 2>&1 ||
  rr_die "cannot read /live/filesystem.squashfs from $iso"
unsquashfs -q -d "$work/root" "$work/filesystem.squashfs" >/dev/null
root="$work/root"

# Exactly the firmware packages of the list, and the Intel ice DDP package.
# shellcheck disable=SC2016 # a dpkg-query format, not a shell expansion
chroot "$root" dpkg-query -W -f '${Package}\n' 'firmware-*' >"$work/firmware" 2>/dev/null || true
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

# The keyboard layouts the boot menu offers: ckbcomp writes a keymap loadkeys reads.
for layout in de us ch at fr; do
  chroot "$root" sh -c "ckbcomp '$layout' | loadkeys --parse -" >/dev/null 2>&1 ||
    problem "keyboard layout $layout does not compile (ckbcomp | loadkeys)"
done

# Nothing activates by itself (the files of README.md, "No auto-activation").
grep -q 'auto_activation_volume_list = \[\]' "$root/etc/lvm/lvmlocal.conf" || problem "lvmlocal.conf activates volume groups"
grep -q '^AUTO -all' "$root/etc/mdadm/mdadm.conf" || problem "mdadm.conf assembles arrays"
[ "$(readlink "$root/etc/systemd/system-generators/systemd-gpt-auto-generator")" = /dev/null ] ||
  problem "systemd-gpt-auto-generator is not masked"

# No secrets, nothing of an instance.
sh "$HERE/no-secrets.sh" "$root" || problem "secrets or instance data in the image"

[ "$fail" -eq 0 ] || exit 1
echo "check-image: $iso passes"
