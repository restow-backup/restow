#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
#
# The source code of every package in the recovery ISO (README.md, "Source code
# of the GPL packages"): the Debian source package of exactly the version in
# packages.lock, from the same snapshot.debian.org time, as one tar file (in
# parts of 1900 MiB when it reaches 2 GiB, the limit of a release attachment)
# and a list of package, version and URL. Both become release attachments.
#
#   integrations/recovery/sources.sh --version <v> --out <dir> [--lock <packages.lock>]
#
# Runs in the same pinned container as build.sh (Docker), so apt resolves the
# sources of that snapshot and nothing else.
set -eu

HERE=$(cd "$(dirname "$0")" && pwd -P)
# shellcheck source=lib/functions.sh
. "$HERE/lib/functions.sh"
# shellcheck source=snapshot.env
. "$HERE/snapshot.env"

version=''
out=''
lock="$HERE/packages.lock"
while [ $# -gt 0 ]; do
  case "$1" in
    --version) version="$2"; shift ;;
    --out) out="$2"; shift ;;
    --lock) lock="$2"; shift ;;
    -h | --help) awk 'NR > 1 { if ($0 !~ /^#/) exit; sub(/^# ?/, ""); print }' "$0"; exit 0 ;;
    *) rr_die "unknown argument $1" ;;
  esac
  shift
done
rr_valid_version "$version" || rr_die "--version <v> is needed"
[ -n "$out" ] || rr_die "--out <dir> is needed"
[ "$(rr_lock_count "$lock")" -gt 0 ] || rr_die "$lock has no entries"
rr_check_snapshot_env "$SNAPSHOT_TIMESTAMP" "$DEBIAN_IMAGE_DIGEST" "$LIVE_BUILD_VERSION" || exit 1
command -v docker >/dev/null 2>&1 || rr_die "docker is needed"

mkdir -p "$out"
out=$(cd "$out" && pwd -P)
work="$out/sources"
rm -rf "$work"
mkdir -p "$work/src"
rr_lock_entries "$lock" | awk '{ print $1, $2 }' >"$work/binaries.txt"
cat >"$work/inner.sh" <<'INNER'
set -eu
cd /work
cat >/etc/apt/sources.list <<SOURCES
deb-src http://snapshot.debian.org/archive/debian/$SNAPSHOT_TIMESTAMP/ trixie main non-free-firmware
deb-src http://snapshot.debian.org/archive/debian-security/$SNAPSHOT_TIMESTAMP/ trixie-security main
deb http://snapshot.debian.org/archive/debian/$SNAPSHOT_TIMESTAMP/ trixie main
SOURCES
rm -f /etc/apt/sources.list.d/debian.sources
printf 'Acquire::Check-Valid-Until "false";\n' >/etc/apt/apt.conf.d/80-restow-snapshot
apt-get update >/dev/null
apt-get install -y --no-install-recommends dpkg-dev >/dev/null
# Binary package -> source package and version (a binNMU or a rebuilt version names its source).
: >sources.txt
while read -r package version; do
  apt-cache show "$package=$version" 2>/dev/null | awk -v p="$package" -v v="$version" '
    /^Source:/ { src = $2; if ($3 ~ /^\(/) { sv = $3; gsub(/[()]/, "", sv) } }
    /^$/ { exit }
    END { if (src == "") src = p; if (sv == "") sv = v; print src, sv }
  '
done <binaries.txt | LC_ALL=C sort -u >pairs.txt
cd src
while read -r source version; do
  apt-get source --download-only "$source=$version" >/dev/null
  printf '%s %s http://snapshot.debian.org/package/%s/%s/\n' "$source" "$version" "$source" "$(printf '%s' "$version" | sed 's/:/%3A/')" >>../sources.txt
done <../pairs.txt
INNER
printf 'SNAPSHOT_TIMESTAMP=%s\n' "$SNAPSHOT_TIMESTAMP" >"$work/env"
docker run --rm --env-file "$work/env" --volume "$work:/work" "$DEBIAN_IMAGE_DIGEST" sh /work/inner.sh

name="restow-recovery_${version}_sources.tar"
epoch=$(rr_epoch_of_snapshot "$SNAPSHOT_TIMESTAMP")
(cd "$work/src" && LC_ALL=C find . -type f | LC_ALL=C sort |
  tar --create --file "$out/$name" --no-recursion --mtime "@$epoch" --owner 0 --group 0 --numeric-owner --files-from -)
cp "$work/sources.txt" "$out/restow-recovery_${version}_sources.txt"
size=$(wc -c <"$out/$name" | tr -d ' ')
if [ "$size" -ge "$RR_SPLIT_LIMIT" ]; then
  split -b 1900M -d -a 3 "$out/$name" "$out/$name.part-"
  rm -f "$out/$name"
fi
rr_part_names "$name" "$size" | while read -r part; do
  [ -f "$out/$part" ] || rr_die "expected $out/$part"
done
echo "Wrote $(rr_part_names "$name" "$size" | tr '\n' ' ')and restow-recovery_${version}_sources.txt"
