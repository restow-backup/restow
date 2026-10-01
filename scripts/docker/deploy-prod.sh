#!/bin/sh
# The production trees of the application image, shared by the Dockerfile's
# `deploy` (full build) and `deploy-community` stages: one self-contained,
# production-only directory per server role under /prod, pruned of what never
# runs in production, then checked by scripts/docker/check-image-tree.mjs.
# Run from the workspace root after `pnpm -r build`:
#
#   sh scripts/docker/deploy-prod.sh full|community [OUT]     (OUT defaults to /prod)
set -eu

variant="${1:-}"
out="${2:-/prod}"
case "$variant" in
  full | community) ;;
  *)
    echo "usage: sh scripts/docker/deploy-prod.sh full|community [OUT]" >&2
    exit 64
    ;;
esac

# `pnpm deploy --prod` copies the target app plus its built workspace deps and
# production node_modules into an isolated directory, one per role, plus the
# standalone restore tool (restow-restore).
pnpm deploy --filter=@restow/api --prod "$out/api"
pnpm deploy --filter=@restow/worker --prod "$out/worker"
pnpm deploy --filter=@restow/scheduler --prod "$out/scheduler"
pnpm deploy --filter=@restow/cli --prod "$out/cli"

# better-auth lists drizzle-kit and vitest as optional peers and .npmrc installs
# peers automatically, so the deployed trees also carry the test runner, the
# bundlers and their native binaries (esbuild, lightningcss for vite's CSS). None of
# it runs in production. Dropping it makes the image smaller and keeps unpatched Go
# standard libraries out of the vulnerability scan (release smoke check 9). The
# dangling links that remain are never followed: nothing requires these packages at
# run time.
rm -rf \
  "$out"/*/node_modules/.pnpm/@esbuild* "$out"/*/node_modules/.pnpm/esbuild@* \
  "$out"/*/node_modules/.pnpm/@esbuild-kit* "$out"/*/node_modules/.pnpm/tsx@* \
  "$out"/*/node_modules/.pnpm/vite@* "$out"/*/node_modules/.pnpm/vite-node@* \
  "$out"/*/node_modules/.pnpm/vitest@* "$out"/*/node_modules/.pnpm/@vitest* \
  "$out"/*/node_modules/.pnpm/rollup@* "$out"/*/node_modules/.pnpm/@rollup* \
  "$out"/*/node_modules/.pnpm/drizzle-kit@* "$out"/*/node_modules/.pnpm/lightningcss*

# @tutao/oxmsg is a devDependency (tests only) whose license is ambiguous (MIT or
# GPL-3.0). It must never reach the image: the build stops if a deployed tree holds it.
if find "$out" \( -path '*/@tutao/*' -o -name 'oxmsg*' \) | grep -q .; then
  echo "restow: @tutao/oxmsg is in the production trees; it must stay a devDependency" >&2
  exit 1
fi

# No license signing code in either build; no ee/ code in the Community build, and
# the ee/ modules in the api and the worker of the full build (docs/CI.md).
if [ "$variant" = community ]; then
  node scripts/docker/check-image-tree.mjs --variant community "$out"
else
  node scripts/docker/check-image-tree.mjs --variant full "$out"
  node scripts/docker/check-image-tree.mjs --variant full --require-ee "$out/api" "$out/worker"
fi
