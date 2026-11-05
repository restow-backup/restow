#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
#
# The part of build.sh that runs inside the pinned debian:trixie container, in
# /build (the tree build.sh prepared). It installs live-build from the snapshot,
# checks its version, and runs lb config (auto/config) and lb build. apt checks
# the signatures of the snapshot with the debian-archive-keyring of the image;
# the old Release files need Check-Valid-Until=false, which build.sh allows only
# together with packages.lock.
set -eu
umask 022
cd /build

: "${SNAPSHOT_TIMESTAMP:?}" "${SOURCE_DATE_EPOCH:?}" "${LIVE_BUILD_VERSION:?}" "${RESTOW_VERSION:?}"
export SNAPSHOT_TIMESTAMP SOURCE_DATE_EPOCH RESTOW_VERSION RESTOW_UPDATE_LOCK

rm -f /etc/apt/sources.list.d/debian.sources
cat >/etc/apt/sources.list <<SOURCES
deb http://snapshot.debian.org/archive/debian/$SNAPSHOT_TIMESTAMP/ trixie main
deb http://snapshot.debian.org/archive/debian-security/$SNAPSHOT_TIMESTAMP/ trixie-security main
SOURCES
cat >/etc/apt/apt.conf.d/80-restow-snapshot <<'CONF'
Acquire::Check-Valid-Until "false";
Acquire::Retries "5";
APT::Install-Recommends "false";
CONF
apt-get update
apt-get install -y --no-install-recommends "live-build=$LIVE_BUILD_VERSION" xorriso squashfs-tools
installed=$(dpkg-query -W -f '${Version}' live-build)
[ "$installed" = "$LIVE_BUILD_VERSION" ] || {
  echo "error: live-build $installed, snapshot.env names $LIVE_BUILD_VERSION" >&2
  exit 1
}

# The same apt options inside the image's chroot (the lock covers what it installs).
mkdir -p config/apt
cp /etc/apt/apt.conf.d/80-restow-snapshot config/apt/restow-snapshot.conf

lb config
lb build

[ -f live-image-amd64.hybrid.iso ] || { echo "error: lb build wrote no ISO" >&2; exit 1; }
cp chroot/usr/share/doc/restow-recovery/FIRMWARE-LICENSES.txt FIRMWARE-LICENSES.txt
# The ISO carries the snapshot's time, not the time of the build.
touch -d "@$SOURCE_DATE_EPOCH" live-image-amd64.hybrid.iso FIRMWARE-LICENSES.txt
