#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
#
# The source code of the Debian packages in the recovery lab image (licenses/restow-lab-NOTICES.md),
# like the recovery ISO's: the Debian source package of exactly
# every version the image's /usr/share/doc/restow-lab/packages.txt lists, from the snapshot time
# the image was built from, as one tar file and a list of source, version and URL. Both become
# attachments of the release.
#
#   scripts/docker/lab-sources.sh --image <restow-lab image> --version <v> --out <dir>
set -eu

HERE=$(cd "$(dirname "$0")" && pwd -P)
# The lab stage's own pins: its Debian image and its snapshot.debian.org time.
DEBIAN_IMAGE_DIGEST=$(sed -n 's/^ARG LAB_DEBIAN_IMAGE=//p' "$HERE/../../Dockerfile")
SNAPSHOT_TIMESTAMP=$(sed -n 's/^ARG LAB_SNAPSHOT=//p' "$HERE/../../Dockerfile")
if [ -z "$DEBIAN_IMAGE_DIGEST" ] || [ -z "$SNAPSHOT_TIMESTAMP" ]; then
  echo "the Dockerfile names no lab pins" >&2
  exit 1
fi

image=''
version=''
out=''
while [ $# -gt 0 ]; do
  case "$1" in
    --image) image="$2"; shift ;;
    --version) version="$2"; shift ;;
    --out) out="$2"; shift ;;
    -h | --help) awk 'NR > 1 { if ($0 !~ /^#/) exit; sub(/^# ?/, ""); print }' "$0"; exit 0 ;;
    *) echo "unknown argument $1" >&2; exit 2 ;;
  esac
  shift
done
if [ -z "$image" ] || [ -z "$out" ]; then
  echo "--image and --out are needed" >&2
  exit 2
fi
printf '%s' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$' || { echo "--version <v> is needed" >&2; exit 2; }

mkdir -p "$out"
out=$(cd "$out" && pwd -P)
work="$out/lab-sources"
rm -rf "$work"
mkdir -p "$work/src"
# Package, version, source package, source version: what the lab stage installed.
docker run --rm --entrypoint cat "$image" /usr/share/doc/restow-lab/packages.txt >"$work/packages.txt"
[ -s "$work/packages.txt" ] || { echo "$image lists no packages" >&2; exit 1; }
awk '{ print $3, $4 }' "$work/packages.txt" | LC_ALL=C sort -u >"$work/pairs.txt"
cat >"$work/inner.sh" <<'INNER'
set -eu
cd /work
cat >/etc/apt/sources.list <<SOURCES
deb-src http://snapshot.debian.org/archive/debian/$SNAPSHOT_TIMESTAMP/ trixie main
deb-src http://snapshot.debian.org/archive/debian-security/$SNAPSHOT_TIMESTAMP/ trixie-security main
SOURCES
rm -f /etc/apt/sources.list.d/debian.sources
printf 'Acquire::Check-Valid-Until "false";\n' >/etc/apt/apt.conf.d/80-restow-snapshot
apt-get update >/dev/null
: >sources.txt
cd src
while read -r source sversion; do
  apt-get source --download-only "$source=$sversion" >/dev/null
  printf '%s %s http://snapshot.debian.org/package/%s/%s/\n' "$source" "$sversion" "$source" "$(printf '%s' "$sversion" | sed 's/:/%3A/')" >>../sources.txt
done <../pairs.txt
INNER
printf 'SNAPSHOT_TIMESTAMP=%s\n' "$SNAPSHOT_TIMESTAMP" >"$work/env"
docker run --rm --env-file "$work/env" --volume "$work:/work" "$DEBIAN_IMAGE_DIGEST" sh /work/inner.sh

name="restow-lab_${version}_sources.tar"
(cd "$work/src" && LC_ALL=C find . -type f | LC_ALL=C sort |
  tar --create --file "$out/$name" --no-recursion --owner 0 --group 0 --numeric-owner --files-from -)
cp "$work/sources.txt" "$out/restow-lab_${version}_sources.txt"
rm -rf "$work"
echo "Wrote $name and restow-lab_${version}_sources.txt"
