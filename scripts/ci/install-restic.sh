#!/bin/sh
# Installs the restic release pinned in agent/tools.env (version and SHA-256 per
# platform) for this machine, for the tests that run restic (the endpoint tests
# of apps/api and apps/worker). The download is verified before anything is
# unpacked; a mismatch fails the script.
#
#   scripts/ci/install-restic.sh [destination directory]
#
# Prints the directory the binary is in. In GitHub Actions the directory is also
# added to PATH. Does nothing (and says so) on a commit that has no agent/tools.env.
set -eu

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
DEST="${1:-${RUNNER_TEMP:-${TMPDIR:-/tmp}}/restic-bin}"

if [ ! -f "$ROOT/agent/tools.env" ]; then
  echo "install-restic: no agent/tools.env in this commit; nothing to install" >&2
  exit 0
fi
# shellcheck source=../../agent/tools.env
. "$ROOT/agent/tools.env"

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) echo "install-restic: unsupported system $(uname -s)" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=amd64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) echo "install-restic: unsupported architecture $(uname -m)" >&2; exit 1 ;;
esac

eval "expected=\${RESTIC_SHA256_${os}_${arch}:-}"
if [ -z "$expected" ]; then
  echo "install-restic: agent/tools.env pins no checksum for restic ${os}/${arch}" >&2
  exit 1
fi

archive="restic_${RESTIC_VERSION}_${os}_${arch}.bz2"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
curl --fail --silent --show-error --location --retry 5 --retry-delay 3 \
  --output "$work/$archive" \
  "https://github.com/restic/restic/releases/download/v${RESTIC_VERSION}/${archive}"

if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$work/$archive" | cut -d ' ' -f 1)
else
  actual=$(shasum -a 256 "$work/$archive" | cut -d ' ' -f 1)
fi
if [ "$actual" != "$expected" ]; then
  echo "install-restic: SHA-256 of $archive is $actual, agent/tools.env pins $expected" >&2
  exit 1
fi

mkdir -p "$DEST"
bzip2 -dc "$work/$archive" > "$DEST/restic"
chmod 0755 "$DEST/restic"
"$DEST/restic" version >&2
if [ -n "${GITHUB_PATH:-}" ]; then
  echo "$DEST" >> "$GITHUB_PATH"
fi
echo "$DEST"
