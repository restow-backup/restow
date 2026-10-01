#!/bin/sh
# Runs the integration tests on the machine this script runs on. Needs a Go
# toolchain. Used by integration.sh (inside Docker) and directly in CI.
#
# Downloads restic and rest-server with SHA-256 verification (pins in
# tools.env), builds the agent binary and runs `go test -tags integration`.
set -eu

AGENT_DIR=$(cd "$(dirname "$0")/.." && pwd)
# shellcheck source=lib.sh
. "$AGENT_DIR/scripts/lib.sh"

os=$(go env GOHOSTOS)
arch=$(go env GOHOSTARCH)
tools="$AGENT_DIR/.cache/tools/$os-$arch"
mkdir -p "$tools"
[ -x "$tools/restic" ] || fetch_tool restic "$os" "$arch" "$tools/restic"
[ -x "$tools/rest-server" ] || fetch_tool rest-server "$os" "$arch" "$tools/rest-server"

cd "$AGENT_DIR"
CGO_ENABLED=0 go build -trimpath -buildvcs=false -o "$AGENT_DIR/.cache/restow-agent-$os-$arch" ./cmd/restow-agent

echo "restic:      $("$tools/restic" version)"
echo "rest-server: $("$tools/rest-server" --version 2>&1 | head -1)"

RESTOW_TEST_RESTIC="$tools/restic" \
RESTOW_TEST_REST_SERVER="$tools/rest-server" \
RESTOW_TEST_AGENT_BIN="$AGENT_DIR/.cache/restow-agent-$os-$arch" \
  go test -tags integration -count=1 -timeout 15m -v ./integration/... "$@"
