#!/bin/sh
# Restow public demo — build every image the demo compose project runs, on a
# workstation or CI runner, and save them to one tarball with a SHA-256
# checksum (deploy/demo/README.md, "Images"). The host that serves the demo
# never builds anything: it verifies the checksum, `docker load`s the
# tarball and runs deploy/demo/reset.sh, which uses `up --no-build`.
#
# Builds, from the repository Dockerfile and deploy/demo/dovecot, for
# linux/amd64 by default (docker buildx, loaded into the local image store):
#
#   variable                   what (Dockerfile target)         default tag
#   RESTOW_DEMO_APP_IMAGE      api/worker/scheduler (runtime)   restow-demo-app:local
#   RESTOW_DEMO_WEB_IMAGE      Caddy edge + SPA (web)           restow-demo-web:local
#   RESTOW_DEMO_SEED_IMAGE     demo seed (demo-seed)            restow-demo-seed:local
#   RESTOW_DEMO_DOVECOT_IMAGE  Dovecot (deploy/demo/dovecot)    restow-demo-dovecot:local
#
# The first two are built from the same repository Dockerfile targets as the
# product images (`runtime`/`web`), but default to their own, demo-only
# tags, deliberately distinct from the repository root docker-compose.yml's
# restow:local/restow-web:local (security review finding M2): on a host that
# also runs production, `docker load` of this tarball must never re-tag, and
# so on its next `docker compose up -d`, silently recreate, that host's
# production containers from a demo build — which may be from an unreleased
# commit or a `-dirty` working tree, and whose api image runs migrations
# automatically on start. Reusing the exact production images is an explicit
# opt-in, not the default: set RESTOW_DEMO_APP_IMAGE=restow:local and
# RESTOW_DEMO_WEB_IMAGE=restow-web:local (in the environment here and in
# deploy/demo/.env on the host) only when both are built from the exact
# release production runs. --skip-app-images builds and saves only the two
# demo images, for a host that already has the product images of the same
# release.
#
# Other settings (environment):
#   RESTOW_DEMO_PLATFORM     target platform (default linux/amd64)
#   RESTOW_DEMO_IMAGES_DIR   where the tarball goes (default deploy/demo/images, gitignored)
#   RESTOW_VERSION           release tag baked into the app image (default: empty, a local build)
#
# Usage: deploy/demo/build-images.sh [--skip-app-images]
set -eu

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "${SCRIPT_DIR}/../.." && pwd)"

PLATFORM="${RESTOW_DEMO_PLATFORM:-linux/amd64}"
APP_IMAGE="${RESTOW_DEMO_APP_IMAGE:-restow-demo-app:local}"
WEB_IMAGE="${RESTOW_DEMO_WEB_IMAGE:-restow-demo-web:local}"
SEED_IMAGE="${RESTOW_DEMO_SEED_IMAGE:-restow-demo-seed:local}"
DOVECOT_IMAGE="${RESTOW_DEMO_DOVECOT_IMAGE:-restow-demo-dovecot:local}"
OUT_DIR="${RESTOW_DEMO_IMAGES_DIR:-${SCRIPT_DIR}/images}"

skip_app_images=false
for arg in "$@"; do
  case "$arg" in
    --skip-app-images) skip_app_images=true ;;
    -h | --help)
      sed -n '2,/^set -eu$/p' "$0" | sed -e '/^set -eu$/d' -e 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "build-images: unknown argument: $arg (see --help)" >&2
      exit 64
      ;;
  esac
done

log() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1"
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

# One image, for exactly one platform, straight into the local image store.
# No provenance/SBOM attestations: they would turn the image into a manifest
# list that older Docker Engines on the target host cannot always `docker load`.
build() {
  tag="$1"
  shift
  log "building ${tag} (${PLATFORM})"
  docker buildx build \
    --platform "$PLATFORM" \
    --provenance=false \
    --sbom=false \
    --load \
    --tag "$tag" \
    "$@"
}

version="$(sed -n 's/^  "version": "\([^"]*\)",$/\1/p' "${REPO_ROOT}/package.json")"
revision="$(git -C "$REPO_ROOT" rev-parse --short=12 HEAD)"
if [ -n "$(git -C "$REPO_ROOT" status --porcelain)" ]; then
  # Built from uncommitted changes (tracked or new files; the build context
  # holds both): say so in the file name, never pass it off as the commit it
  # started from.
  revision="${revision}-dirty"
fi
platform_slug="$(printf '%s' "$PLATFORM" | tr '/' '-')"
name="restow-demo-images-${version}-${revision}-${platform_slug}"
if [ "$skip_app_images" = true ]; then
  name="${name}-demo-only"
fi

if [ "$skip_app_images" = true ]; then
  images="${SEED_IMAGE} ${DOVECOT_IMAGE}"
else
  images="${APP_IMAGE} ${WEB_IMAGE} ${SEED_IMAGE} ${DOVECOT_IMAGE}"
  build "$APP_IMAGE" --target runtime --build-arg "RESTOW_VERSION=${RESTOW_VERSION:-}" "$REPO_ROOT"
  build "$WEB_IMAGE" --target web "$REPO_ROOT"
fi
build "$SEED_IMAGE" --target demo-seed "$REPO_ROOT"
build "$DOVECOT_IMAGE" "${SCRIPT_DIR}/dovecot"

# A wrong platform would only surface on the host, as "exec format error" in
# the middle of a reset; catch it here instead.
for image in $images; do
  actual="$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$image")"
  if [ "$actual" != "$PLATFORM" ]; then
    echo "build-images: ${image} is ${actual}, expected ${PLATFORM}" >&2
    exit 1
  fi
done

mkdir -p "$OUT_DIR"
tarball="${OUT_DIR}/${name}.tar.gz"
rm -f "${OUT_DIR}/${name}.tar" "$tarball" "${tarball}.sha256"
log "saving ${images} to ${tarball}"
# Two steps rather than a pipe, so a failing `docker save` stops the script
# instead of leaving a truncated tarball behind (POSIX sh has no pipefail).
# shellcheck disable=SC2086
docker save --output "${OUT_DIR}/${name}.tar" $images
gzip "${OUT_DIR}/${name}.tar"

# `sha256sum -c` format with the bare file name, so the check works from
# whatever directory both files are copied to.
checksum="$(sha256_of "$tarball")"
printf '%s  %s\n' "$checksum" "${name}.tar.gz" >"${tarball}.sha256"

log "done"
echo
echo "  images:   ${images}"
echo "  tarball:  ${tarball} ($(du -h "$tarball" | cut -f1))"
echo "  sha256:   ${checksum}"
echo "  checksum: ${tarball}.sha256"
echo
echo "On the demo host, in the directory both files were copied to:"
echo "  sha256sum -c ${name}.tar.gz.sha256 && docker load -i ${name}.tar.gz"
echo "then run deploy/demo/reset.sh."
