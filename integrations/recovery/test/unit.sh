#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
#
# Self-tests of the recovery ISO build that need neither root nor Docker
# (README.md, "Check"): the helpers of lib/functions.sh, the refusals of build.sh,
# the boot menus, the package lists and the unit. The CI job recovery-scripts runs
# it on every change; `sh integrations/recovery/test/unit.sh` runs it anywhere.
#
# Secrets for the negative cases are put together at run time, so that no file of
# the repository carries one (the secret scan of the CI would find it).
# `check && ok || fail` is meant: ok and fail never fail.
# shellcheck disable=SC2015
set -eu

HERE=$(cd "$(dirname "$0")" && pwd -P)
WORK=$(cd "$HERE/.." && pwd -P)
FIXTURES="$HERE/fixtures"
# shellcheck source=../lib/functions.sh
. "$WORK/lib/functions.sh"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
passed=0
failed=0

ok() {
  passed=$((passed + 1))
}

fail() {
  failed=$((failed + 1))
  printf 'not ok: %s\n' "$*"
}

# expect <name> <command...>: the command succeeds.
expect() {
  name="$1"
  shift
  if "$@" >"$tmp/out" 2>&1; then ok; else fail "$name"; sed 's/^/    /' "$tmp/out"; fi
}

# refuse <name> <command...>: the command fails.
refuse() {
  name="$1"
  shift
  if "$@" >"$tmp/out" 2>&1; then fail "$name (it succeeded)"; else ok; fi
}

# says <name> <text>: the output of the last expect/refuse contains the text.
says() {
  if grep -qF -- "$2" "$tmp/out"; then ok; else fail "$1: output lacks '$2'"; sed 's/^/    /' "$tmp/out"; fi
}

# --- versions, snapshot.env, the snapshot time ------------------------------------

expect "a release version" rr_valid_version 0.5.0
expect "a pre-release version" rr_valid_version 0.5.0-alpha.3
refuse "no v prefix" rr_valid_version v0.5.0
refuse "no path" rr_valid_version 0.5.0/../x

# shellcheck source=../snapshot.env
. "$WORK/snapshot.env"
expect "the committed snapshot.env" rr_check_snapshot_env "$SNAPSHOT_TIMESTAMP" "$DEBIAN_IMAGE_DIGEST" "$LIVE_BUILD_VERSION"
refuse "a tag instead of a digest" rr_check_snapshot_env "$SNAPSHOT_TIMESTAMP" debian:trixie "$LIVE_BUILD_VERSION"
refuse "another distribution" rr_check_snapshot_env "$SNAPSHOT_TIMESTAMP" "debian:bookworm@sha256:$(printf '%064d' 0)" "$LIVE_BUILD_VERSION"
refuse "a date instead of a snapshot time" rr_check_snapshot_env 2026-10-20 "$DEBIAN_IMAGE_DIGEST" "$LIVE_BUILD_VERSION"

[ "$(rr_epoch_of_snapshot 19700102T000000Z)" = 86400 ] && ok || fail "epoch of 1970-01-02"
[ "$(rr_epoch_of_snapshot 20261020T013000Z)" = "$(date -u -d '2026-10-20 01:30:00' +%s)" ] && ok || fail "epoch of the snapshot"
refuse "a malformed snapshot time" rr_epoch_of_snapshot 20261020

# --- packages.lock -----------------------------------------------------------------

[ "$(rr_lock_count "$WORK/packages.lock")" = 0 ] && ok || fail "the committed lock has only its header (R14: the first lock comes from CI)"
[ "$(rr_lock_count "$FIXTURES/packages.lock")" = 3 ] && ok || fail "the fixture lock has three entries"
expect "the image equals the lock" rr_lock_compare "$FIXTURES/packages.lock" "$FIXTURES/installed-same.txt"
refuse "another version" rr_lock_compare "$FIXTURES/packages.lock" "$FIXTURES/installed-version.txt"
says "another version" "version differs: kmod 34.2-2 (lock: 34.2-1)"
refuse "another .deb" rr_lock_compare "$FIXTURES/packages.lock" "$FIXTURES/installed-hash.txt"
says "another .deb" "SHA-256 differs: mdadm"
refuse "a package more and one less" rr_lock_compare "$FIXTURES/packages.lock" "$FIXTURES/installed-extra.txt"
says "a package more" "not in packages.lock: nano"
says "a package less" "missing in the image: lvm2"
refuse "no .deb to hash" rr_lock_compare "$FIXTURES/packages.lock" "$FIXTURES/installed-nodeb.txt"
says "no .deb to hash" "no .deb to hash: lvm2"
refuse "a malformed lock" rr_lock_entries "$FIXTURES/packages-malformed.lock"
refuse "Check-Valid-Until=false without a lock" rr_valid_until_allowed "$WORK/packages.lock" no
expect "Check-Valid-Until=false while writing the lock" rr_valid_until_allowed "$WORK/packages.lock" yes
expect "Check-Valid-Until=false with a lock" rr_valid_until_allowed "$FIXTURES/packages.lock" no

# --- package lists -------------------------------------------------------------------

rr_list_packages "$WORK/config/package-lists/firmware.list.chroot" >"$tmp/firmware"
expect "the firmware in the image equals the list" rr_list_compare "$WORK/config/package-lists/firmware.list.chroot" "$tmp/firmware"
{ cat "$tmp/firmware"; echo firmware-iwlwifi; } >"$tmp/firmware-more"
refuse "Wi-Fi firmware in the image" rr_list_compare "$WORK/config/package-lists/firmware.list.chroot" "$tmp/firmware-more"
says "Wi-Fi firmware in the image" "in the image but not listed: firmware-iwlwifi"
grep -v firmware-realtek "$tmp/firmware" >"$tmp/firmware-less"
refuse "firmware missing in the image" rr_list_compare "$WORK/config/package-lists/firmware.list.chroot" "$tmp/firmware-less"
says "firmware missing in the image" "listed but not in the image: firmware-realtek"
# firmware.md names exactly the packages of the list (its table, the licence notes).
# shellcheck disable=SC2016 # backticks of the Markdown table, not a command
sed -n 's/^| `\(firmware-[a-z0-9-]*\)` |.*/\1/p' "$WORK/firmware.md" | LC_ALL=C sort -u >"$tmp/firmware-md"
if cmp -s "$tmp/firmware" "$tmp/firmware-md"; then ok; else fail "firmware.md and firmware.list.chroot name other packages"; fi
# The tools of the recovery program (agent/internal/recovery/tools.go names the programs;
# these are their Debian packages) are all in the package list.
rr_list_packages "$WORK/config/package-lists/recovery.list.chroot" >"$tmp/recovery"
for package in util-linux fdisk gdisk parted mdadm lvm2 dmsetup cryptsetup cryptsetup-bin dosfstools \
  e2fsprogs xfsprogs btrfs-progs kbd console-setup pciutils mokutil openssh-server openssh-client \
  udev systemd efibootmgr shim-signed grub-efi-amd64-signed linux-image-amd64 live-boot; do
  grep -qx "$package" "$tmp/recovery" && ok || fail "recovery.list.chroot lacks $package"
done
for package in debootstrap os-prober zfsutils-linux wpasupplicant firmware-amd-graphics; do
  grep -qx "$package" "$tmp/recovery" && fail "recovery.list.chroot must not have $package" || ok
done

# --- forbidden apt options -------------------------------------------------------------

expect "the build configuration keeps apt's checks" rr_forbidden_apt "$WORK/config" "$WORK/auto" "$WORK/build-inner.sh"
mkdir -p "$tmp/apt"
printf 'deb [%s] http://deb.example/ trixie main\n' "trusted=yes" >"$tmp/apt/sources.list"
refuse "trusted=yes" rr_forbidden_apt "$tmp/apt"
printf 'apt-get install %s x\n' "--allow-unauthenticated" >"$tmp/apt/sources.list"
refuse "--allow-unauthenticated" rr_forbidden_apt "$tmp/apt"
printf 'Acquire::%s "true";\n' "AllowInsecureRepositories" >"$tmp/apt/sources.list"
refuse "AllowInsecureRepositories" rr_forbidden_apt "$tmp/apt"

# --- the parts of the source bundle -----------------------------------------------------

[ "$(rr_part_names x.tar 1073741824)" = x.tar ] && ok || fail "1 GiB stays one file"
[ "$(rr_part_names x.tar 2147483647)" = x.tar ] && ok || fail "just below 2 GiB stays one file"
[ "$(rr_part_names x.tar 2147483648 | tr '\n' ' ')" = "x.tar.part-000 x.tar.part-001 " ] && ok || fail "2 GiB is two parts"
[ "$(rr_part_names x.tar 5368709120 | tr '\n' ' ')" = "x.tar.part-000 x.tar.part-001 x.tar.part-002 " ] && ok || fail "5 GiB is three parts"

# --- the scan for secrets ------------------------------------------------------------------

clean="$tmp/clean"
mkdir -p "$clean/etc/ssh" "$clean/usr/lib/restow-recovery" "$clean/usr/share/doc/restow-recovery"
cp "$FIXTURES/clean-config.txt" "$clean/etc/clean.conf"
# The programs of the image may name their project and their own patterns.
printf 'see https://restow.example.com and rset_[A-Za-z0-9] RC-[0-9A-Z]{5}\n' >"$clean/usr/lib/restow-recovery/restow-agent"
expect "a clean image" rr_no_secrets "$clean"
scan_with() {
  rm -rf "$tmp/dirty"
  cp -R "$clean" "$tmp/dirty"
  printf '%s\n' "$1" >"$tmp/dirty/etc/leak"
  rr_no_secrets "$tmp/dirty"
}
dashes=-----
refuse "a private key" scan_with "${dashes}BEGIN OPENSSH PRIVATE KEY${dashes}"
refuse "an RSA private key" scan_with "${dashes}BEGIN RSA PRIVATE KEY${dashes}"
refuse "a rebind token" scan_with "token=rset_$(printf 'A%.0s' 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22)"
refuse "a recovery code" scan_with "RC-0A1B2-C3D4E-F5G6H-J7K8M-N9P0Q"
refuse "an instance address" scan_with "url=https://restow.firma.de/api"
rm -rf "$tmp/dirty" && cp -R "$clean" "$tmp/dirty" && : >"$tmp/dirty/etc/ssh/ssh_host_ed25519_key"
refuse "an SSH host key" rr_no_secrets "$tmp/dirty"
expect "test/no-secrets.sh on a clean image" sh "$HERE/no-secrets.sh" "$clean"
refuse "test/no-secrets.sh on an image with a host key" sh "$HERE/no-secrets.sh" "$tmp/dirty"

# --- build.sh arguments and refusals --------------------------------------------------------

expect "all arguments" rr_parse_build_args --agent-dist /a --version 0.5.0 --out /o --update-lock --sources
[ "$RR_AGENT_DIST $RR_VERSION $RR_OUT $RR_UPDATE_LOCK $RR_SOURCES" = "/a 0.5.0 /o yes yes" ] && ok || fail "parsed values"
rr_parse_build_args --agent-dist /a --version 0.5.0 --out /o >/dev/null 2>&1
[ "$RR_UPDATE_LOCK $RR_SOURCES" = "no no" ] && ok || fail "defaults of the switches"
refuse "no version" rr_parse_build_args --agent-dist /a --out /o
refuse "a bad version" rr_parse_build_args --agent-dist /a --version latest --out /o
refuse "an unknown option" rr_parse_build_args --agent-dist /a --version 0.5.0 --out /o --insecure
refuse "an option without its value" rr_parse_build_args --agent-dist
status=0
rr_parse_build_args --help >/dev/null 2>&1 || status=$?
[ "$status" = 3 ] && ok || fail "--help"
mkdir -p "$tmp/dist"
refuse "build.sh with the header-only lock" sh "$WORK/build.sh" --agent-dist "$tmp/dist" --version 0.5.0 --out "$tmp/out"
says "build.sh with the header-only lock" "packages.lock has no entries"
expect "build.sh --help" sh "$WORK/build.sh" --help
says "build.sh --help" "--update-lock"

# --- boot menus ---------------------------------------------------------------------------

grub_pc="$WORK/config/bootloaders/grub-pc/grub.cfg"
grub_efi="$WORK/config/bootloaders/grub-efi/grub.cfg"
isolinux="$WORK/config/bootloaders/isolinux/live.cfg.in"
cmp -s "$grub_pc" "$grub_efi" && ok || fail "grub-pc and grub-efi menus differ"
grep -q '^serial --unit=0 --speed=115200$' "$grub_pc" && ok || fail "GRUB serial console"
grep -q '^terminal_output gfxterm serial$' "$grub_pc" && ok || fail "GRUB terminal on screen and serial"
grep -q '^set timeout=10$' "$grub_pc" && ok || fail "default after 10 seconds"
[ "$(grep -m 1 '^menuentry' "$grub_pc")" = 'menuentry "Restow Recovery" {' ] && ok || fail "the default entry is Restow Recovery"
grep -m 1 'linux @KERNEL_LIVE@' "$grub_pc" | grep -q 'restow.keymap=us' && ok || fail "the default layout is us"
# Every live entry keeps connected disks inactive; all but "with graphics drivers" block the GPU drivers.
awk '/^[[:space:]]*menuentry/ { title = $0 } /linux @KERNEL_LIVE@/ { print title "\t" $0 }' "$grub_pc" >"$tmp/entries"
while IFS="$(printf '\t')" read -r title line; do
  case "$line" in *noswap*nopersistence*) ok ;; *) fail "$title: no noswap nopersistence" ;; esac
  case "$title" in
    *"with graphics drivers"*) case "$line" in *modprobe.blacklist*) fail "$title: blocks the GPU drivers" ;; *) ok ;; esac ;;
    *) case "$line" in *modprobe.blacklist=amdgpu,radeon,nouveau,xe*) ok ;; *) fail "$title: GPU drivers not blocked" ;; esac ;;
  esac
done <"$tmp/entries"
for layout in de us ch at fr; do
  grep -q "restow.keymap=$layout" "$grub_pc" && ok || fail "GRUB layout $layout"
  grep -q "restow.keymap=$layout" "$isolinux" && ok || fail "syslinux layout $layout"
done
grep -q 'restow.console=ttyS0' "$grub_pc" && grep -q 'restow.console=ttyS1' "$grub_pc" && ok || fail "serial console entries"
grep -q 'verify-checksums' "$grub_pc" && grep -q 'verify-checksums' "$isolinux" && ok || fail "Check medium"
grep -q 'restow.answers=media' "$grub_pc" && grep -q 'restow.answers=media' "$isolinux" && ok || fail "unattended from the medium"
[ "$(grep -c 'linux @KERNEL_LIVE@' "$grub_pc")" = "$(grep -c 'linux @LINUX@' "$isolinux")" ] && ok || fail "GRUB and syslinux have other entries"
grep -q 'modprobe.blacklist' "$WORK/auto/config" && fail "auto/config must leave the block list to the menu entries" || ok

# --- the unit, no auto-activation ---------------------------------------------------------------

unit="$WORK/config/includes.chroot/etc/systemd/system/restow-recover.service"
grep -qx 'ExecStart=/usr/lib/restow-recovery/restow-agent recover --console /dev/tty1' "$unit" && ok || fail "ExecStart of the unit"
grep -qx 'Restart=on-failure' "$unit" && ok || fail "Restart of the unit"
grep -qx 'Conflicts=getty@tty1.service' "$unit" && ok || fail "the unit owns tty1"
grep -q '^After=systemd-networkd.service' "$unit" && ok || fail "the unit starts after the network"
grep -q 'auto_activation_volume_list = \[\]' "$WORK/config/includes.chroot/etc/lvm/lvmlocal.conf" && ok || fail "lvmlocal.conf"
grep -q 'event_activation = 0' "$WORK/config/includes.chroot/etc/lvm/lvmlocal.conf" && ok || fail "event activation"
grep -qx 'AUTO -all' "$WORK/config/includes.chroot/etc/mdadm/mdadm.conf" && ok || fail "mdadm.conf"
for rules in 64-md-raid-assembly.rules 64-btrfs.rules; do
  # Only comments: an empty rule file masks the packaged one.
  grep -v '^#' "$WORK/config/includes.chroot/etc/udev/rules.d/$rules" | grep -q . && fail "$rules has rules" || ok
done
grep -q 'systemd-gpt-auto-generator' "$WORK/config/hooks/live/0100-restow-mask.hook.chroot" && ok || fail "gpt-auto masked"
grep -q 'enable restow-recover.service' "$WORK/config/hooks/live/0100-restow-mask.hook.chroot" && ok || fail "the unit enabled"
grep -q 'ssh_host_' "$WORK/config/hooks/live/9900-restow-clean.hook.chroot" && ok || fail "host keys removed"

printf '%s passed, %s failed\n' "$passed" "$failed"
[ "$failed" -eq 0 ]
