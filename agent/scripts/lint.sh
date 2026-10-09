#!/bin/sh
# ShellCheck for every shell script of the agent (install scripts, build and test
# scripts). Uses the local shellcheck if present, else the official Docker image.
set -eu

AGENT_DIR=$(cd "$(dirname "$0")/.." && pwd)
cd "$AGENT_DIR"

FILES="install/linux.sh install/macos.sh install/pve.sh build.sh scripts/lib.sh scripts/integration.sh scripts/integration-inner.sh scripts/lint.sh scripts/test.sh scripts/test-build.sh scripts/test-install.sh scripts/test-pve-install.sh scripts/pin-tools.sh scripts/test-install-macos.sh scripts/test-systemd.sh"

# shellcheck disable=SC2086
if command -v shellcheck >/dev/null 2>&1; then
  shellcheck -x --source-path=SCRIPTDIR -s sh -S style $FILES
else
  docker run --rm -v "$AGENT_DIR":/mnt -w /mnt koalaman/shellcheck:stable \
    -x --source-path=SCRIPTDIR -s sh -S style $FILES
fi
echo "shellcheck: OK"
