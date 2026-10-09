#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
#
# Builds the node side of Restow for Proxmox VE as one tarball, for nodes that
# install from a local folder instead of the instance (and for test builds of
# this branch):
#
#   restow-pve-<version>-linux-amd64.tar.gz
#     restow-pve-<version>/pve.sh                         the installer (agent/install/pve.sh)
#     restow-pve-<version>/pve-host-test.sh               the test run (docs/PVE-HOST-TEST.md)
#     restow-pve-<version>/SHA256SUMS                     over every file below
#     restow-pve-<version>/linux-amd64/restow-pve         the node helper (Apache-2.0)
#     restow-pve-<version>/linux-amd64/restic             the pinned restic
#     restow-pve-<version>/linux-amd64/RestowPlugin.pm    the storage plugin shim (AGPL-3.0-or-later)
#     restow-pve-<version>/linux-amd64/RestowProvider.pm
#     restow-pve-<version>/linux-amd64/RestowPlugin.LICENSE.txt
#     restow-pve-<version>/linux-amd64/THIRD_PARTY_NOTICES.txt
#
# On the node:
#   tar xzf restow-pve-<version>-linux-amd64.tar.gz && cd restow-pve-<version>
#   RESTOW_URL=https://<instance> RESTOW_VERSION=<version> RESTOW_PVE_LOCAL_DIR=$PWD \
#     RESTOW_ALLOW_UNSIGNED_DEV=1 RESTOW_ENROLL_TOKEN='<token from Restow>' sh pve.sh
# (RESTOW_ALLOW_UNSIGNED_DEV only for a development version such as 0.3.0-dev;
# a release is signed by the maintainer: copy SHA256SUMS.sig next to SHA256SUMS.)
#
# Usage: integrations/pve/build-node-tarball.sh [--version 0.3.0-dev] [--out DIR]
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
VERSION=0.3.0-dev
OUT="$REPO/integrations/pve/dist"
while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION="${2:?}"; shift 2 ;;
    --out) OUT="${2:?}"; shift 2 ;;
    -h | --help) sed -n '2,26p' "$0"; exit 0 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
RESTOW_PVE_PLUGIN_DIR="$REPO/integrations/pve/plugin" sh "$REPO/agent/build.sh" \
  --version "$VERSION" --out "$work/dist" --targets linux-amd64
name="restow-pve-$VERSION"
stage="$work/$name"
mkdir -p "$stage/linux-amd64"
for f in restow-pve restic RestowPlugin.pm RestowProvider.pm RestowPlugin.LICENSE.txt THIRD_PARTY_NOTICES.txt; do
  cp "$work/dist/linux-amd64/$f" "$stage/linux-amd64/$f"
done
cp "$REPO/agent/install/pve.sh" "$stage/pve.sh"
cp "$REPO/integrations/pve/test/pve-host-test.sh" "$stage/pve-host-test.sh"
(
  cd "$stage"
  for f in linux-amd64/*; do
    if command -v sha256sum >/dev/null 2>&1; then
      sha256sum "$f"
    else
      shasum -a 256 "$f"
    fi
  done >SHA256SUMS
)
mkdir -p "$OUT"
tar -C "$work" -czf "$OUT/$name-linux-amd64.tar.gz" "$name"
echo "Built $OUT/$name-linux-amd64.tar.gz"
