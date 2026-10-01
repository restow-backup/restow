#!/bin/sh
# Unit tests and static checks: gofmt, go vet for all four release targets, the
# tests with the race detector, the build.sh test (scripts/test-build.sh, needs
# neither Go nor Docker) and ShellCheck. Uses the local Go toolchain if present,
# else the pinned golang Docker image.
#
#   scripts/test.sh
#
# The integration tests are separate: scripts/integration.sh
set -eu

AGENT_DIR=$(cd "$(dirname "$0")/.." && pwd)
cd "$AGENT_DIR"

if [ "${1:-}" != "--inner" ]; then
  # shellcheck source=lib.sh
  . "$AGENT_DIR/scripts/lib.sh"
  if command -v go >/dev/null 2>&1; then
    sh "$0" --inner
  else
    command -v docker >/dev/null 2>&1 || die "neither go nor docker found"
    docker run --rm -v "$AGENT_DIR":/src -w /src \
      -v restow-agent-gomod:/go/pkg/mod -v restow-agent-gocache:/root/.cache/go-build \
      "$GO_IMAGE" sh scripts/test.sh --inner
  fi
  "$AGENT_DIR/scripts/test-build.sh"
  "$AGENT_DIR/scripts/lint.sh"
  exit 0
fi

echo "== gofmt"
unformatted=$(gofmt -l .)
if [ -n "$unformatted" ]; then
  echo "not formatted:" >&2
  echo "$unformatted" >&2
  exit 1
fi

echo "== go vet (linux and darwin, amd64 and arm64, integration tag)"
for target in linux/amd64 linux/arm64 darwin/amd64 darwin/arm64; do
  CGO_ENABLED=0 GOOS="${target%/*}" GOARCH="${target#*/}" go vet ./...
  CGO_ENABLED=0 GOOS="${target%/*}" GOARCH="${target#*/}" go vet -tags integration ./integration/
done

echo "== go test"
if command -v gcc >/dev/null 2>&1; then
  CGO_ENABLED=1 go test -race -count=1 ./...
else
  echo "(gcc not found: running without the race detector)"
  CGO_ENABLED=0 go test -count=1 ./...
fi
