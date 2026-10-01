#!/bin/sh
# Integration tests: the agent against the real restic binary and a real restic
# REST server in append-only mode.
#
#   scripts/integration.sh            run on Linux (in Docker if Go is not installed)
#   scripts/integration.sh --native   run natively on this machine (macOS or Linux):
#                                     the test binary and the agent are cross-compiled
#                                     (in Docker if needed), restic and rest-server are
#                                     the official binaries for this OS.
set -eu

AGENT_DIR=$(cd "$(dirname "$0")/.." && pwd)
# shellcheck source=lib.sh
. "$AGENT_DIR/scripts/lib.sh"

native=0
if [ "${1:-}" = "--native" ]; then
  native=1
  shift
fi

# Docker helper: run a command with Go in the pinned image (module and build caches persist).
in_docker() {
  docker run --rm -v "$AGENT_DIR":/src -w /src \
    -v restow-agent-gomod:/go/pkg/mod -v restow-agent-gocache:/root/.cache/go-build \
    "$@"
}

if [ "$native" = 0 ]; then
  if command -v go >/dev/null 2>&1; then
    exec sh "$AGENT_DIR/scripts/integration-inner.sh" "$@"
  fi
  command -v docker >/dev/null 2>&1 || die "neither go nor docker found"
  in_docker "$GO_IMAGE" sh ./scripts/integration-inner.sh "$@"
  exit 0
fi

# ---- native mode ------------------------------------------------------------
os=$(uname -s | tr '[:upper:]' '[:lower:]')
case "$(uname -m)" in
  arm64 | aarch64) arch=arm64 ;;
  x86_64 | amd64) arch=amd64 ;;
  *) die "unsupported architecture $(uname -m)" ;;
esac
cache="$AGENT_DIR/.cache/native-$os-$arch"
mkdir -p "$cache"

# gorun <args...>: go with GOOS/GOARCH for the target, locally or in Docker.
gorun() {
  if command -v go >/dev/null 2>&1; then
    (cd "$AGENT_DIR" && CGO_ENABLED=0 GOOS="$os" GOARCH="$arch" go "$@")
  else
    in_docker -e CGO_ENABLED=0 -e GOOS="$os" -e GOARCH="$arch" "$GO_IMAGE" go "$@"
  fi
}

# The fetch tool is plain Go and runs for the container's own platform.
fetch() {
  tool="$1"
  dest="$2"
  [ -x "$dest" ] && return 0
  rel="${dest#"$AGENT_DIR"/}"
  if command -v go >/dev/null 2>&1; then
    fetch_tool "$tool" "$os" "$arch" "$dest"
  else
    in_docker "$GO_IMAGE" sh -c "AGENT_DIR=/src; . ./scripts/lib.sh && fetch_tool $tool $os $arch /src/$rel"
  fi
}

fetch restic "$cache/restic"
fetch rest-server "$cache/rest-server"
gorun build -trimpath -buildvcs=false -o "${cache#"$AGENT_DIR"/}/restow-agent" ./cmd/restow-agent
gorun test -c -tags integration -o "${cache#"$AGENT_DIR"/}/integration.test" ./integration

echo "restic:      $("$cache/restic" version)"
echo "restow-agent: $("$cache/restow-agent" version --short)"
cd "$AGENT_DIR/integration"
RESTOW_TEST_RESTIC="$cache/restic" \
RESTOW_TEST_REST_SERVER="$cache/rest-server" \
RESTOW_TEST_AGENT_BIN="$cache/restow-agent" \
  "$cache/integration.test" -test.v -test.count=1 -test.timeout=15m "$@"
