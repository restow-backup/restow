#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
#
# Builds the Restow recovery ISO (README.md): a Debian 13 live image made with
# live-build from one fixed state of snapshot.debian.org (snapshot.env), with
# exactly the packages of packages.lock, in a container pinned by digest.
#
#   integrations/recovery/build.sh --agent-dist <dir> --version <v> --out <dir>
#                                  [--update-lock] [--sources]
#
#   --agent-dist <dir>  the linux-amd64 folder of the agent build (restow-agent,
#                       restic, THIRD_PARTY_NOTICES.txt): they go into the image
#                       under /usr/lib/restow-recovery/ as programs of their own
#   --version <v>       the release version; restow-agent version --short must say it
#   --out <dir>         where the ISO, its .sha256, the firmware licences (and with
#                       --sources the source bundle) go
#   --update-lock       write packages.lock anew from what the snapshot installs
#                       instead of comparing with it (by hand only; review the diff)
#   --sources           also write the source bundle of every package (sources.sh)
#
# Needs Docker with --privileged (live-build mounts and chroots). The container
# gets only the build variables (--env-file), never the environment of the caller.
set -eu

HERE=$(cd "$(dirname "$0")" && pwd -P)
# shellcheck source=lib/functions.sh
. "$HERE/lib/functions.sh"

usage() {
  awk 'NR > 1 { if ($0 !~ /^#/) exit; sub(/^# ?/, ""); print }' "$0"
}

status=0
rr_parse_build_args "$@" || status=$?
case "$status" in
  0) ;;
  3) usage; exit 0 ;;
  *) usage >&2; exit 2 ;;
esac

# shellcheck source=snapshot.env
. "$HERE/snapshot.env"
rr_check_snapshot_env "$SNAPSHOT_TIMESTAMP" "$DEBIAN_IMAGE_DIGEST" "$LIVE_BUILD_VERSION" || exit 1
epoch=$(rr_epoch_of_snapshot "$SNAPSHOT_TIMESTAMP") || rr_die "cannot read the time $SNAPSHOT_TIMESTAMP"

entries=$(rr_lock_count "$HERE/packages.lock") || rr_die "packages.lock is malformed"
if [ "$entries" -eq 0 ] && [ "$RR_UPDATE_LOCK" != yes ]; then
  rr_die "packages.lock has no entries; create it once with --update-lock and commit it after review"
fi
rr_valid_until_allowed "$HERE/packages.lock" "$RR_UPDATE_LOCK" ||
  rr_die "an old snapshot needs Check-Valid-Until=false, which is allowed only together with the lock"
rr_forbidden_apt "$HERE/config" "$HERE/auto" "$HERE/build-inner.sh" ||
  rr_die "the build configuration turns off apt's signature checks"

for file in restow-agent restic THIRD_PARTY_NOTICES.txt; do
  [ -f "$RR_AGENT_DIST/$file" ] || rr_die "$RR_AGENT_DIST/$file is missing (give the linux-amd64 folder of the agent build)"
done
reported=$("$RR_AGENT_DIST/restow-agent" version --short 2>/dev/null || true)
[ "$reported" = "$RR_VERSION" ] || rr_die "restow-agent reports version '$reported', not $RR_VERSION"
command -v docker >/dev/null 2>&1 || rr_die "docker is needed"

mkdir -p "$RR_OUT"
out=$(cd "$RR_OUT" && pwd -P)
work="$out/build"
rm -rf "$work"
mkdir -p "$work"
umask 022

# The tree live-build works on: the configuration, the hooks' helpers and the
# lock under config/restow/, and the two programs with their notices.
cp -R "$HERE/auto" "$HERE/config" "$work/"
cp "$HERE/build-inner.sh" "$work/"
mkdir -p "$work/config/restow" "$work/config/includes.chroot/usr/lib/restow-recovery" \
  "$work/config/includes.chroot/usr/local/sbin"
cp "$HERE/lib/functions.sh" "$HERE/packages.lock" "$HERE/config/package-lists/firmware.list.chroot" \
  "$work/config/restow/"
for file in restow-agent restic THIRD_PARTY_NOTICES.txt; do
  cp "$RR_AGENT_DIST/$file" "$work/config/includes.chroot/usr/lib/restow-recovery/$file"
done
chmod 0755 "$work/config/includes.chroot/usr/lib/restow-recovery/restow-agent" \
  "$work/config/includes.chroot/usr/lib/restow-recovery/restic"
chmod 0644 "$work/config/includes.chroot/usr/lib/restow-recovery/THIRD_PARTY_NOTICES.txt"
ln -sf /usr/lib/restow-recovery/restow-agent "$work/config/includes.chroot/usr/local/sbin/restow-agent"
# Every file of the tree carries the time of the snapshot.
find "$work" -exec touch -h -d "@$epoch" {} +

env_file="$out/build.env"
cat >"$env_file" <<VARS
SNAPSHOT_TIMESTAMP=$SNAPSHOT_TIMESTAMP
SOURCE_DATE_EPOCH=$epoch
LIVE_BUILD_VERSION=$LIVE_BUILD_VERSION
RESTOW_VERSION=$RR_VERSION
RESTOW_UPDATE_LOCK=$RR_UPDATE_LOCK
TZ=UTC
LC_ALL=C.UTF-8
LANG=C.UTF-8
VARS

echo "Building restow-recovery_${RR_VERSION}_amd64.iso from snapshot $SNAPSHOT_TIMESTAMP in $DEBIAN_IMAGE_DIGEST"
docker run --rm --privileged \
  --hostname restow-recovery-build \
  --env-file "$env_file" \
  --volume "$work:/build" \
  --workdir /build \
  "$DEBIAN_IMAGE_DIGEST" \
  sh /build/build-inner.sh

iso="$out/restow-recovery_${RR_VERSION}_amd64.iso"
mv "$work/live-image-amd64.hybrid.iso" "$iso"
cp "$work/FIRMWARE-LICENSES.txt" "$out/restow-recovery_${RR_VERSION}_FIRMWARE-LICENSES.txt"
if [ "$RR_UPDATE_LOCK" = yes ]; then
  cp "$work/config/restow/packages.lock.new" "$out/packages.lock"
  echo "Wrote $out/packages.lock; review it and copy it to integrations/recovery/packages.lock."
fi
(cd "$out" && sha256sum "$(basename "$iso")" >"$(basename "$iso").sha256")
cat "$iso.sha256"

if [ "$RR_SOURCES" = yes ]; then
  lock="$HERE/packages.lock"
  [ "$RR_UPDATE_LOCK" = yes ] && lock="$out/packages.lock"
  sh "$HERE/sources.sh" --version "$RR_VERSION" --lock "$lock" --out "$out"
fi
