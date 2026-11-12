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
# A point release of trixie carries a suffix: the version is compared as dpkg prints it.
expect "a point-release live-build" rr_check_snapshot_env "$SNAPSHOT_TIMESTAMP" "$DEBIAN_IMAGE_DIGEST" 1:20250505+deb13u1
refuse "a live-build version with a space" rr_check_snapshot_env "$SNAPSHOT_TIMESTAMP" "$DEBIAN_IMAGE_DIGEST" "1:20250505 x"
refuse "an empty live-build version" rr_check_snapshot_env "$SNAPSHOT_TIMESTAMP" "$DEBIAN_IMAGE_DIGEST" ""

[ "$(rr_epoch_of_snapshot 19700102T000000Z)" = 86400 ] && ok || fail "epoch of 1970-01-02"
[ "$(rr_epoch_of_snapshot 20261020T013000Z)" = "$(date -u -d '2026-10-20 01:30:00' +%s)" ] && ok || fail "epoch of the snapshot"
refuse "a malformed snapshot time" rr_epoch_of_snapshot 20261020

# --- packages.lock -----------------------------------------------------------------

[ "$(rr_lock_count "$WORK/packages.lock")" -gt 0 ] && ok || fail "the committed lock has entries"
expect "every line of the committed lock is <package> <version> <SHA-256>" rr_lock_complete "$WORK/packages.lock"
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
# A lock written by --update-lock names the SHA-256 of every package; "-" (no .deb was
# found) fails the build, and a lock with "-" is never accepted for a comparison.
expect "a complete lock" rr_lock_complete "$FIXTURES/packages.lock"
sed 's/^lvm2 .*/lvm2 2.03.31-2 -/' "$FIXTURES/packages.lock" >"$tmp/lock-dash"
refuse "a lock entry without a SHA-256" rr_lock_complete "$tmp/lock-dash"
says "a lock entry without a SHA-256" "no .deb to hash: lvm2 2.03.31-2"
refuse "a lock with \"-\" in a comparison" rr_lock_compare "$tmp/lock-dash" "$FIXTURES/installed-nodeb.txt"
refuse "a lock with \"-\" counted" rr_lock_count "$tmp/lock-dash"
# shellcheck disable=SC2016 # the hook's literal text
grep -q 'rr_lock_complete "$new" || rr_die' "$WORK/config/hooks/live/0500-restow-lockcheck.hook.chroot" && ok ||
  fail "the lock hook does not refuse an incomplete new lock"
# The .debs of both kinds of name: debootstrap's (no epoch) and apt's (epoch as %3a),
# matched by package, version and architecture as dpkg-deb reads them from the file.
if command -v dpkg-deb >/dev/null 2>&1; then
  mkdeb() { # mkdeb <dir> <file name> <package> <version> <architecture>
    mkdir -p "$tmp/pkg/DEBIAN" "$1"
    printf 'Package: %s\nVersion: %s\nArchitecture: %s\nMaintainer: t <t@example.org>\nDescription: t\n' \
      "$3" "$4" "$5" >"$tmp/pkg/DEBIAN/control"
    dpkg-deb --root-owner-group --build "$tmp/pkg" "$1/$2" >/dev/null
    rm -rf "$tmp/pkg"
  }
  mkdeb "$tmp/bootstrap-debs" base-files_13.8+deb13u7_amd64.deb base-files 13.8+deb13u7 amd64
  mkdeb "$tmp/bootstrap-debs" mawk_1.3.4.20250131-1_amd64.deb mawk 1:1.3.4.20250131-1 amd64
  mkdeb "$tmp/archives" kbd_2.7.1-2_amd64.deb kbd 2.7.1-2 amd64
  mkdeb "$tmp/archives" xkb-data_2.41-1_all.deb xkb-data 2.41-1 all
  rr_deb_sums "$tmp/archives" "$tmp/bootstrap-debs" >"$tmp/sums"
  [ "$(wc -l <"$tmp/sums" | tr -d ' ')" = 4 ] && ok || fail "rr_deb_sums reads every .deb"
  printf '%s\n' 'base-files 13.8+deb13u7 amd64' 'mawk 1:1.3.4.20250131-1 amd64' 'kbd 2.7.1-2 amd64' \
    'xkb-data 2.42-1 all' >"$tmp/installed"
  rr_with_sums "$tmp/installed" "$tmp/sums" >"$tmp/with-sums"
  base_sum=$(sha256sum "$tmp/bootstrap-debs/base-files_13.8+deb13u7_amd64.deb" | cut -d ' ' -f 1)
  grep -qx "base-files 13.8+deb13u7 $base_sum" "$tmp/with-sums" && ok || fail "a debootstrap .deb gives its SHA-256"
  grep -Eqx 'mawk 1:1.3.4.20250131-1 [0-9a-f]{64}' "$tmp/with-sums" && ok || fail "a .deb named without its epoch is found"
  grep -Eqx 'kbd 2.7.1-2 [0-9a-f]{64}' "$tmp/with-sums" && ok || fail "an apt .deb gives its SHA-256"
  # Another version of the package in the cache is not its .deb.
  grep -qx 'xkb-data 2.42-1 -' "$tmp/with-sums" && ok || fail "the .deb of another version counts"
  { echo '# header'; cat "$tmp/with-sums"; } >"$tmp/lock-new"
  refuse "a new lock with a package without .deb" rr_lock_complete "$tmp/lock-new"
else
  echo "note: dpkg-deb is missing; the .deb lookup is not tested here"
fi
grep -q 'cache/packages.bootstrap/\*.deb config/restow/bootstrap-debs/' "$WORK/build-inner.sh" && ok ||
  fail "build-inner.sh does not give the lock hook debootstrap's packages"
# shellcheck disable=SC2016 # the hook's literal text
grep -q '"$dir/bootstrap-debs"' "$WORK/config/hooks/live/0500-restow-lockcheck.hook.chroot" && ok ||
  fail "the lock hook does not read debootstrap's packages"
grep '^#' "$WORK/packages.lock" >"$tmp/header-only.lock"
refuse "Check-Valid-Until=false without a lock" rr_valid_until_allowed "$tmp/header-only.lock" no
expect "Check-Valid-Until=false while writing the lock" rr_valid_until_allowed "$WORK/packages.lock" yes
expect "Check-Valid-Until=false with a lock" rr_valid_until_allowed "$FIXTURES/packages.lock" no
# The apt configuration of the build container and of live-build's chroot (rr_apt_conf):
# the option only where it is allowed, retries always, no signature check turned off.
rr_apt_conf "$FIXTURES/packages.lock" no >"$tmp/apt-locked.conf"
rr_apt_conf "$WORK/packages.lock" yes >"$tmp/apt-update-lock.conf"
grep -qx 'Acquire::Check-Valid-Until "false";' "$tmp/apt-locked.conf" && ok || fail "apt.conf with a lock lacks Check-Valid-Until"
grep -qx 'Acquire::Check-Valid-Until "false";' "$tmp/apt-update-lock.conf" && ok || fail "apt.conf while writing the lock lacks Check-Valid-Until"
: >"$tmp/empty.lock"
rr_apt_conf "$tmp/empty.lock" no >"$tmp/apt-nolock.conf"
grep -q 'Check-Valid-Until' "$tmp/apt-nolock.conf" && fail "apt.conf without a lock turns off Check-Valid-Until" || ok
grep -qx 'Acquire::Retries "5";' "$tmp/apt-nolock.conf" && ok || fail "apt.conf without a lock lacks the retries"
expect "the generated apt.conf keeps apt's checks" rr_forbidden_apt "$tmp/apt-locked.conf" "$tmp/apt-update-lock.conf"
# live-build copies config/apt/apt.conf into its chroot (lb chroot_apt, chroot and binary
# stage) and reads no other file name there; build-inner.sh writes exactly that file.
grep -q '^cp /etc/apt/apt.conf.d/80-restow-snapshot config/apt/apt.conf$' "$WORK/build-inner.sh" && ok ||
  fail "build-inner.sh does not give live-build's chroot its apt.conf"
grep -q '^rr_apt_conf config/restow/packages.lock ' "$WORK/build-inner.sh" && ok ||
  fail "build-inner.sh does not generate its apt configuration with rr_apt_conf"

# --- package lists -------------------------------------------------------------------

rr_list_packages "$WORK/config/package-lists/firmware.list.chroot" >"$tmp/firmware"
expect "the firmware in the image equals the list" rr_list_compare "$WORK/config/package-lists/firmware.list.chroot" "$tmp/firmware"
{ cat "$tmp/firmware"; echo firmware-iwlwifi; } >"$tmp/firmware-more"
refuse "Wi-Fi firmware in the image" rr_list_compare "$WORK/config/package-lists/firmware.list.chroot" "$tmp/firmware-more"
says "Wi-Fi firmware in the image" "in the image but not listed: firmware-iwlwifi"
grep -v firmware-realtek "$tmp/firmware" >"$tmp/firmware-less"
refuse "firmware missing in the image" rr_list_compare "$WORK/config/package-lists/firmware.list.chroot" "$tmp/firmware-less"
says "firmware missing in the image" "listed but not in the image: firmware-realtek"
# dpkg-query with a pattern also names packages only known from other packages' fields
# (Provides, Recommends, Conflicts) as not-installed: only installed ones count.
printf '%s\n' 'installed firmware-bnx2' 'not-installed firmware-adi' 'not-installed firmware-intel-graphics' \
  'installed firmware-realtek' 'config-files firmware-old' >"$tmp/firmware-status"
[ "$(rr_installed_names "$tmp/firmware-status" | tr '\n' ' ')" = "firmware-bnx2 firmware-realtek " ] && ok ||
  fail "rr_installed_names counts packages that are not installed"
grep -q "db:Status-Status" "$WORK/test/check-image.sh" && ok || fail "check-image.sh counts firmware that is not installed"
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
# Key material is made up at run time (a committed key would trip the CI's secret scan).
body=$(head -c 96 /dev/urandom | base64 | tr -d '\n' | fold -w 64)
pem() { printf '%sBEGIN %s PRIVATE KEY%s\n%s\n%sEND %s PRIVATE KEY%s\n' "$dashes" "$1" "$dashes" "$body" "$dashes" "$1" "$dashes"; }
refuse "a private key" scan_with "$(pem OPENSSH)"
refuse "an RSA private key" scan_with "$(pem RSA)"
refuse "a private key with Windows line ends" scan_with "$(pem EC | sed 's/$/\r/')"
refuse "a private key in JSON" scan_with "{\"key\": \"${dashes}BEGIN PRIVATE KEY${dashes}\\n$(printf '%s' "$body" | tr -d '\n')\\n${dashes}END PRIVATE KEY${dashes}\"}"
expect "the header of a key alone" scan_with "printf(\"${dashes}BEGIN OPENSSH PRIVATE KEY${dashes}\\n\")"
# ELF programs: OpenSSH and GLib carry the PEM headers as format strings, the agent its
# own token prefix and the placeholder of a recovery code; a real key in one still counts.
# elf_with <text>: a program holding the text after a NUL, as strings are stored.
elf_with() {
  rm -rf "$tmp/dirty"
  cp -R "$clean" "$tmp/dirty"
  { printf '\177ELF\002\001\001\000'; printf '%s\000' "$1"; } >"$tmp/dirty/usr/bin/prog"
  rr_no_secrets "$tmp/dirty"
}
mkdir -p "$clean/usr/bin"
# (Command substitution drops NULs: each format string ends with its own line break here.)
expect "PEM headers as format strings in a program" \
  elf_with "$(printf '%sBEGIN OPENSSH PRIVATE KEY%s\n\n%sEND OPENSSH PRIVATE KEY%s\n\n%sBEGIN %%s PRIVATE KEY%s' \
    "$dashes" "$dashes" "$dashes" "$dashes" "$dashes" "$dashes")"
expect "the token prefix and the code placeholder in a program" \
  elf_with "rset_tokenexpectedReconnectinvalidformatRC-XXXXX-XXXXX-XXXXX-XXXXX-XXXXXRC-0A1B2-C3D4E-F5G6H-J7K8M-N9P0Q"
refuse "a private key inside a program" elf_with "$(pem OPENSSH)"
expect "the placeholder of a recovery code in a text" scan_with "Code: RC-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX"
expect "the token prefix in a text" scan_with "a token starts with rset_ and is single use"
refuse "a rebind token" scan_with "token=rset_$(printf 'A%.0s' 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22)"
refuse "a recovery code" scan_with "RC-0A1B2-C3D4E-F5G6H-J7K8M-N9P0Q"
refuse "an instance address" scan_with "url=https://restow.firma.de/api"
rm -rf "$tmp/dirty" && cp -R "$clean" "$tmp/dirty" && : >"$tmp/dirty/etc/ssh/ssh_host_ed25519_key"
refuse "an SSH host key" rr_no_secrets "$tmp/dirty"
expect "test/no-secrets.sh on a clean image" sh "$HERE/no-secrets.sh" "$clean"
refuse "test/no-secrets.sh on an image with a host key" sh "$HERE/no-secrets.sh" "$tmp/dirty"

# --- build leftovers ------------------------------------------------------------------------

built="$tmp/built"
mkdir -p "$built/run/systemd/resolve" "$built/etc/nvme" "$built/var/cache/apt/archives/partial" "$built/usr/bin"
printf 'nameserver 192.0.2.53\nsearch build.example\n' >"$built/run/systemd/resolve/stub-resolv.conf"
: >"$built/run/adduser"
cp "$built/run/systemd/resolve/stub-resolv.conf" "$built/etc/.resolv.conf.systemd-resolved.bak"
printf 'nqn.2014-08.org.nvmexpress:uuid:00000000-0000-4000-8000-000000000000\n' >"$built/etc/nvme/hostnqn"
printf '00000000-0000-4000-8000-000000000000\n' >"$built/etc/nvme/hostid"
: >"$built/etc/nvme/discovery.conf"
: >"$built/var/cache/apt/pkgcache.bin"
: >"$built/var/cache/apt/srcpkgcache.bin"
: >"$built/usr/bin/prog"
refuse "an image with build leftovers" rr_build_leftovers "$built"
[ "$(rr_build_leftovers "$built" | grep -c .)" -eq 9 ] && ok || fail "every leftover is named"
expect "the cleaning" rr_clean_build_leftovers "$built"
expect "an image without build leftovers" rr_build_leftovers "$built"
[ -d "$built/run" ] && [ -f "$built/etc/nvme/discovery.conf" ] && [ -d "$built/var/cache/apt/archives/partial" ] &&
  [ -f "$built/usr/bin/prog" ] && ok || fail "the cleaning keeps /run and everything else"
mkdir -p "$tmp/no-run"
expect "an image without /run" rr_build_leftovers "$tmp/no-run"
refuse "a missing directory" rr_build_leftovers "$tmp/missing"
grep -q '^rr_clean_build_leftovers chroot$' "$HERE/../build-inner.sh" && ok || fail "build-inner.sh cleans the chroot"
[ "$(grep -n '^lb chroot$' "$HERE/../build-inner.sh" | cut -d: -f1)" -lt "$(grep -n '^rr_clean_build_leftovers chroot$' "$HERE/../build-inner.sh" | cut -d: -f1)" ] &&
  [ "$(grep -n '^rr_clean_build_leftovers chroot$' "$HERE/../build-inner.sh" | cut -d: -f1)" -lt "$(grep -n '^lb binary$' "$HERE/../build-inner.sh" | cut -d: -f1)" ] &&
  ok || fail "build-inner.sh cleans between lb chroot and lb binary"

# --- keyboard layouts ----------------------------------------------------------------------

# rr_keymap_compiles with stand-ins: ckbcomp knows "de", loadkeys refuses to run without
# --bkeymap (it would need a console, and a chroot has none) and fails on a bad keymap.
mkdir -p "$tmp/kbin"
cat >"$tmp/kbin/ckbcomp" <<'STUB'
#!/bin/sh
case "$1" in
  de) printf 'keymaps 0-127\nkeycode 30 = +a\n' ;;
  empty) : ;;
  broken) printf 'keycode 30 = nonsense\n' ;;
  *) echo "Can not find file symbols/$1" >&2; exit 2 ;;
esac
STUB
cat >"$tmp/kbin/loadkeys" <<'STUB'
#!/bin/sh
case " $* " in *" --bkeymap "*) ;; *) echo "Couldn't get a file descriptor referring to the console." >&2; exit 1 ;; esac
case " $* " in *" --unicode "*) ;; *) echo "not the Unicode console" >&2; exit 1 ;; esac
! grep -q nonsense
STUB
chmod 0755 "$tmp/kbin/ckbcomp" "$tmp/kbin/loadkeys"
# keymap_with <layout>: rr_keymap_compiles in a shell that finds only the stand-ins.
keymap_with() {
  # shellcheck disable=SC2016 # $1 and $2 are expanded by the inner shell
  env PATH="$tmp/kbin:$PATH" sh -c '. "$1" && rr_keymap_compiles "$2"' sh "$WORK/lib/functions.sh" "$1"
}
expect "a layout that compiles" keymap_with de
refuse "an unknown layout" keymap_with xx
refuse "an empty keymap" keymap_with empty
refuse "a keymap loadkeys rejects" keymap_with broken
grep -q 'rr_keymap_compiles "[$]1"' "$WORK/test/check-image.sh" && ok || fail "check-image.sh does not use rr_keymap_compiles"

# --- build.sh arguments and refusals --------------------------------------------------------

expect "all arguments" rr_parse_build_args --agent-dist /a --version 0.5.0 --out /o --update-lock --sources
[ "$RR_AGENT_DIST $RR_VERSION $RR_OUT $RR_UPDATE_LOCK $RR_SOURCES" = "/a 0.5.0 /o yes yes" ] && ok || fail "parsed values"
rr_parse_build_args --agent-dist /a --version 0.5.0 --out /o >/dev/null 2>&1
[ "$RR_UPDATE_LOCK $RR_SOURCES" = "no no" ] && ok || fail "defaults of the switches"
refuse "no version" rr_parse_build_args --agent-dist /a --out /o
refuse "a bad version" rr_parse_build_args --agent-dist /a --version latest --out /o
refuse "an unknown option" rr_parse_build_args --agent-dist /a --version 0.5.0 --out /o --insecure
refuse "an option without its value" rr_parse_build_args --agent-dist
# Rebuilds of a release's ISO (docs/BAREMETAL.md 26.13).
expect "a rebuild" rr_parse_build_args --agent-dist /a --version 0.5.0 --out /o --rebuild 2
[ "$RR_REBUILD" = 2 ] && ok || fail "parsed rebuild number"
[ "$(rr_iso_version "$RR_VERSION" "$RR_REBUILD")" = 0.5.0.2 ] && ok || fail "the file name version of a rebuild"
rr_parse_build_args --agent-dist /a --version 0.5.0 --out /o >/dev/null 2>&1
[ "$RR_REBUILD" = "" ] && [ "$(rr_iso_version "$RR_VERSION" "$RR_REBUILD")" = 0.5.0 ] && ok ||
  fail "the release's own ISO has no rebuild number"
[ "$(rr_iso_version 0.5.0-alpha.3 1)" = 0.5.0-alpha.3.1 ] && ok || fail "a rebuild of a pre-release"
refuse "rebuild 0" rr_parse_build_args --agent-dist /a --version 0.5.0 --out /o --rebuild 0
refuse "a rebuild with a leading zero" rr_parse_build_args --agent-dist /a --version 0.5.0 --out /o --rebuild 01
refuse "rebuild 1000" rr_parse_build_args --agent-dist /a --version 0.5.0 --out /o --rebuild 1000
refuse "a rebuild that is no number" rr_parse_build_args --agent-dist /a --version 0.5.0 --out /o --rebuild 1a
refuse "a rebuild with --update-lock" rr_parse_build_args --agent-dist /a --version 0.5.0 --out /o --rebuild 1 --update-lock
status=0
rr_parse_build_args --help >/dev/null 2>&1 || status=$?
[ "$status" = 3 ] && ok || fail "--help"
mkdir -p "$tmp/dist"
# A copy of the build tree with only the lock's header: build.sh refuses before anything else.
mkdir -p "$tmp/tree"
cp -R "$WORK/." "$tmp/tree/"
cp "$tmp/header-only.lock" "$tmp/tree/packages.lock"
refuse "build.sh with the header-only lock" sh "$tmp/tree/build.sh" --agent-dist "$tmp/dist" --version 0.5.0 --out "$tmp/out"
says "build.sh with the header-only lock" "packages.lock has no entries"
# With the committed lock it gets past the lock and asks for the agent build.
refuse "build.sh without the agent build" sh "$WORK/build.sh" --agent-dist "$tmp/dist" --version 0.5.0 --out "$tmp/out"
says "build.sh without the agent build" "restow-agent is missing"
expect "build.sh --help" sh "$WORK/build.sh" --help
says "build.sh --help" "--update-lock"
# The lock hook runs in live-build's chroot without the build's environment: update-lock
# mode reaches it only as the file build.sh leaves next to the lock.
hook="$WORK/config/hooks/live/0500-restow-lockcheck.hook.chroot"
# shellcheck disable=SC2016 # the literal text of the hook, not an expansion
expect "the lock hook reads update-lock mode from a file" grep -q 'if \[ -f "\$dir/update-lock" \]' "$hook"
refuse "the lock hook does not rely on the environment" grep -q 'RESTOW_UPDATE_LOCK' "$hook"
expect "build.sh leaves the update-lock file for the hook" grep -q 'config/restow/update-lock' "$WORK/build.sh"
# shellcheck disable=SC2016 # the literal text of the hook, not an expansion
refuse "the lock hook never writes into live-build's read-only config" grep -q '>"\$dir/packages.lock.new"' "$hook"
expect "build-inner.sh copies the new lock out of the chroot" grep -q 'chroot/var/lib/restow-recovery/packages.lock.new config/restow/packages.lock.new' "$WORK/build-inner.sh"

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
grep -qx 'AUTO -all' "$WORK/config/includes.chroot/usr/lib/restow-recovery/mdadm.conf" && ok || fail "mdadm.conf"
# live-build's hook 8040-remove-mdadm-configuration deletes /etc/mdadm/mdadm.conf, so the
# include there would be gone; the live hook (after it) installs the file.
[ ! -e "$WORK/config/includes.chroot/etc/mdadm/mdadm.conf" ] && ok ||
  fail "an mdadm.conf under includes.chroot/etc is deleted by live-build's hook 8040"
grep -qx 'install -D -m 0644 /usr/lib/restow-recovery/mdadm.conf /etc/mdadm/mdadm.conf' \
  "$WORK/config/hooks/live/0100-restow-mask.hook.chroot" && ok || fail "the mask hook does not install mdadm.conf"
for rules in 64-md-raid-assembly.rules 64-btrfs.rules; do
  # Only comments: an empty rule file masks the packaged one.
  grep -v '^#' "$WORK/config/includes.chroot/etc/udev/rules.d/$rules" | grep -q . && fail "$rules has rules" || ok
done
grep -q 'systemd-gpt-auto-generator' "$WORK/config/hooks/live/0100-restow-mask.hook.chroot" && ok || fail "gpt-auto masked"
grep -q 'enable restow-recover.service' "$WORK/config/hooks/live/0100-restow-mask.hook.chroot" && ok || fail "the unit enabled"
grep -q 'ssh_host_' "$WORK/config/hooks/live/9900-restow-clean.hook.chroot" && ok || fail "host keys removed"

printf '%s passed, %s failed\n' "$passed" "$failed"
[ "$failed" -eq 0 ]
