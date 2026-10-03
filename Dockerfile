# syntax=docker/dockerfile:1

# Restow — one image, three server roles (api | worker | scheduler) selected at
# start via the ROLE environment variable. The React dev server (@restow/web) is
# not part of this runtime image; docker-compose runs it from the `build` stage.
#
# Two builds of the same workspace (docs/CI.md, "Two build targets"):
#   full       targets `runtime` and `web`: the Apache-2.0 core plus the Business
#              and Service Provider modules under ee/, which stay locked until a
#              license key is installed (ee/README.md)
#   community  targets `runtime-community` and `web-community`: the Apache-2.0
#              core alone; scripts/docker/strip-ee.mjs empties the three ee/
#              loaders and removes ee/ before anything is compiled, and the build
#              stops if any ee/ code reaches the image
#
# Build model (pnpm workspace, Node 22 LTS):
#   base            -> Node + pnpm via corepack
#   install         -> the whole workspace and `pnpm install` (shared by both builds)
#   build           -> `pnpm -r build` (all packages/apps compiled; the modules
#                      under ee/ are compiled into the apps that load them:
#                      apps/api and apps/worker emit them into their own dist,
#                      apps/web bundles them, see ee/README.md)
#   build-community -> ee/ stripped (scripts/docker/strip-ee.mjs), then `pnpm -r build`
#   deploy, deploy-community
#                   -> scripts/docker/deploy-prod.sh: `pnpm deploy` produces a
#                      self-contained, prod-only tree per role (plus the standalone
#                      restore tool, restow-restore), checked by
#                      scripts/docker/check-image-tree.mjs
#   runtime-base    -> lean image, no dev tooling, ROLE picks the process to run
#   runtime, runtime-community
#                   -> runtime-base plus the /prod tree of their build, labels, ENV
#   web-base        -> Caddy and the Caddyfile
#   web, web-community
#                   -> web-base plus the web interface of their build
#
# The endpoint agent (agent/, Go) and restic reach the runtime image through
# two stages that run on the BUILD platform, so a multi-arch build compiles and
# unpacks natively instead of under emulation:
#   agent-build -> agent/build.sh cross-compiles the agent for every target
#                  (linux and darwin, amd64 and arm64) in the golang image (Go is
#                  used nowhere else) and fetches the restic release pinned in
#                  agent/tools.env for the same targets, verifying every archive
#                  against its pinned SHA-256. A release build takes the agent
#                  the release workflow built and the maintainer signed instead
#                  (agent/prebuilt/, see agent/README.md "Release signing"), after
#                  checking the signature against agent/release-signing.pub
#   agent-dist  -> lays the result out as /srv/agent/<version>/<os>-<arch>/ with
#                  a SHA256SUMS file per directory, next to the install scripts
#                  (/srv/agent/install); the api serves them, so an instance
#                  never depends on the vendor's site
# The server itself runs restic from /usr/local/bin/restic.

# Go toolchain of the agent build: the image agent/tools.env names (GO_IMAGE).
ARG GO_IMAGE=golang:1.27

########################################
# base — Node 22 + pinned pnpm
########################################
FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true
# Pin pnpm to the version declared in package.json (packageManager) so the image
# never fetches a different pnpm at build or run time.
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /app

########################################
# install — the whole workspace with every dependency (shared by both builds)
########################################
FROM base AS install
# Copy the whole workspace, ee/ included (the .dockerignore keeps node_modules,
# dist, secrets and local volumes out of the build context).
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile

########################################
# build — the full build: the core and the ee/ modules, compiled
########################################
FROM install AS build
# The product name the static maintenance page is written with (apps/web
# vite/maintenance-page). Empty builds the default name; the running services
# read RESTOW_PRODUCT_NAME at runtime, this only reaches the page that cannot.
ARG RESTOW_PRODUCT_NAME=
RUN pnpm -r build && \
    node scripts/docker/check-image-tree.mjs --variant full apps/web/dist

########################################
# build-community — the Community build: the core without ee/, compiled
########################################
# strip-ee.mjs replaces the three loaders (apps/api/src/ee.ts, apps/worker/src/ee.ts,
# apps/web/src/features/ee.ts) with empty modules, drops the Tailwind @source line
# for ee/ from apps/web/src/index.css and deletes ee/; it refuses a tree in which a
# loader is missing or any other core file reaches ee/. The installed dependencies
# of ee/ stay in the store; no core package depends on them, so nothing of them is
# deployed. The build then stops if ee/ still exists or the web bundle holds ee/ code.
FROM install AS build-community
RUN node scripts/docker/strip-ee.mjs && \
    test ! -e ee
ARG RESTOW_PRODUCT_NAME=
RUN pnpm -r build && \
    node scripts/docker/check-image-tree.mjs --variant community apps/web/dist

########################################
# deploy — self-contained, production-only tree for each server role (full build)
########################################
FROM build AS deploy
RUN sh scripts/docker/deploy-prod.sh full /prod

########################################
# deploy-community — the same for the Community build
########################################
# check-image-tree.mjs (run by deploy-prod.sh) stops the build when /prod holds
# any ee/ code: a dist/ee directory, an @restow/ee-* package, an import or source
# path into ee/.
FROM build-community AS deploy-community
RUN sh scripts/docker/deploy-prod.sh community /prod

########################################
# agent-build — the endpoint agent and restic for every target
########################################
# Runs on the build platform and cross-compiles, so a multi-arch build does not
# compile under emulation. agent/build.sh owns the list of targets, the build
# flags and the restic pin (agent/tools.env: version and the SHA-256 of every
# archive; a mismatch fails the build). `COPY agent*/` copies the folder when it
# exists and nothing when it does not, so the image still builds on a commit
# that has no agent yet (CI); the release workflow refuses such a commit.
FROM --platform=$BUILDPLATFORM ${GO_IMAGE} AS agent-build
ARG RESTOW_VERSION=
ARG RESTOW_REVISION=
ARG RESTOW_CREATED=
WORKDIR /src
COPY agent*/ /src/agent/
RUN --mount=type=cache,id=go-mod,target=/go/pkg/mod \
    --mount=type=cache,id=go-build,target=/root/.cache/go-build \
    set -eu; \
    mkdir -p /out /install; \
    if [ -f /src/agent/prebuilt/VERSION ]; then \
      cd /src/agent/prebuilt; \
      version="${RESTOW_VERSION#v}"; \
      [ "$(cat VERSION)" = "${version}" ] || { echo "restow: agent/prebuilt is version $(cat VERSION), the image ${version}" >&2; exit 1; }; \
      [ -f SHA256SUMS.sig ] || { echo "restow: agent/prebuilt/SHA256SUMS is not signed" >&2; exit 1; }; \
      printf 'restow-agent-release %s\n' "$(grep '^ssh-ed25519 ' /src/agent/release-signing.pub | cut -d ' ' -f 1-2)" > /tmp/allowed_signers; \
      ssh-keygen -Y verify -f /tmp/allowed_signers -I restow-agent-release -n restow-agent-release -s SHA256SUMS.sig < SHA256SUMS; \
      sha256sum -c SHA256SUMS; \
      chmod 0755 ./*/restow-agent ./*/restic; \
      cp -R . /out/; \
      cp /src/agent/install/*.sh /src/agent/release-signing.pub /install/; \
    elif [ -f /src/agent/build.sh ]; then \
      cd /src/agent; \
      set -- --out /out; \
      if [ -n "${RESTOW_VERSION}" ]; then set -- "$@" --version "${RESTOW_VERSION#v}"; fi; \
      if [ -n "${RESTOW_CREATED}" ]; then export SOURCE_DATE_EPOCH="$(date -d "${RESTOW_CREATED}" +%s)"; fi; \
      export RESTOW_COMMIT="$(printf '%.7s' "${RESTOW_REVISION:-unknown}")"; \
      sh ./build.sh "$@"; \
      cp install/*.sh release-signing.pub /install/; \
    else \
      echo "restow: no agent/ in the build context, the image ships without agent binaries" >&2; \
    fi

########################################
# agent-dist — /srv/agent/<version>/<os>-<arch>/ and the server's restic
########################################
# One directory per agent target: restow-agent, restic, THIRD_PARTY_NOTICES.txt
# (the licenses the installers put next to the binaries) and the SHA256SUMS over
# them, plus SHA256SUMS over all targets with the maintainer's signature
# (SHA256SUMS.sig, release builds; agents and installers verify it), VERSION and
# RESTIC_VERSION in the version folder, and the install scripts with the release
# signing public key in /srv/agent/install. Assembled here as
# a rootfs tree and copied into the runtime image in one step. The server's
# restic is a link to the copy for the image's own architecture.
FROM --platform=$BUILDPLATFORM alpine:3.24 AS agent-dist
ARG RESTOW_VERSION=
ARG TARGETARCH
COPY --from=agent-build /out /agent
COPY --from=agent-build /install /install
RUN set -eu; \
    version="${RESTOW_VERSION#v}"; version="${version:-0.0.0-dev}"; \
    root="/rootfs/srv/agent"; \
    mkdir -p "${root}/${version}" "${root}/install" /rootfs/usr/local/bin; \
    for dir in /agent/*/; do \
      [ -d "$dir" ] || continue; \
      target="$(basename "$dir")"; \
      mkdir -p "${root}/${version}/${target}"; \
      cp "$dir"restow-agent "$dir"restic "$dir"THIRD_PARTY_NOTICES.txt "$dir"SHA256SUMS "${root}/${version}/${target}/"; \
    done; \
    for file in SHA256SUMS SHA256SUMS.sig VERSION RESTIC_VERSION; do \
      [ ! -f "/agent/${file}" ] || cp "/agent/${file}" "${root}/${version}/${file}"; \
    done; \
    cp /install/*.sh "${root}/install/" 2>/dev/null || true; \
    cp /install/release-signing.pub "${root}/install/" 2>/dev/null || true; \
    if [ -f "${root}/${version}/linux-${TARGETARCH}/restic" ]; then \
      ln -s "/srv/agent/${version}/linux-${TARGETARCH}/restic" /rootfs/usr/local/bin/restic; \
    fi; \
    find /rootfs \( -type f -o -type l \) | sort

########################################
# demo-seed — the public demo's seed (deploy/demo/README.md)
########################################
# The seed (deploy/demo/seed) runs from the build stage's workspace, as the
# unprivileged `node` user, and plays the Restow agent for two simulated
# machines, so it needs the very restic the product ships: the binary the
# agent build stage fetched at the pinned version (agent/tools.env) after
# checking its SHA-256 for this image's architecture, the same file the runtime
# image links as /usr/local/bin/restic. Nothing is downloaded when the seed
# runs: the demo's internal network has no route to the internet. Only the
# demo's compose project and deploy/demo/build-images.sh use this target.
FROM build AS demo-seed
ARG TARGETARCH
COPY --from=agent-build /out/linux-${TARGETARCH}/restic /usr/local/bin/restic
# The license texts every image of the release carries (runtime-base below).
COPY LICENSE NOTICE THIRD_PARTY_NOTICES.md licenses/ /usr/share/doc/restow/
# The logins of the simulated machines go to a named volume the heartbeat
# sidecar mounts too; a volume takes this directory's owner when it is first
# mounted. The machines' own folders are tmpfs mounts of the compose file.
RUN install -d -o 1000 -g 1000 /var/demo/agents

########################################
# runtime-base — lean image shared by both builds' runtime targets
########################################
# Everything of the application image except the /prod tree, its labels and the
# build's ENV, which the two final stages below add.
FROM base AS runtime-base
ENV NODE_ENV=production \
    ROLE=api
WORKDIR /prod
# The server's restic (/usr/local/bin/restic) and the agent downloads the api
# serves from /srv/agent/<version>/<os>-<arch>/ (see agent-dist above).
COPY --from=agent-dist /rootfs/ /
# The license texts, in every image of the release: the core's license (Apache-2.0)
# and its NOTICE, the third-party notices, and the texts of licenses/: restic's
# (BSD-2-Clause asks for its notice to accompany the binary), Go's (the runtime linked
# into restow-agent and restic), msgreader's (Apache-2.0, the MSG reader),
# shadcn/ui's (MIT, the web primitives) and, in restic-deps/, the license and NOTICE
# files of the Go modules compiled into restic. All of them are in THIRD_PARTY_NOTICES.md.
COPY LICENSE NOTICE THIRD_PARTY_NOTICES.md licenses/ /usr/share/doc/restow/

# The server-side import folder (docs/IMPORT.md): the compose files mount the operator's
# directory here, read-only, in the api and the worker.
RUN install -d -m 0755 /var/lib/restow/import

# Entrypoint: select the process role from $ROLE (default: api) and run the
# matching workspace. Written into the image (no extra repo file) via heredoc.
COPY <<'EOF' /usr/local/bin/restow-entrypoint
#!/bin/sh
set -eu
ROLE="${ROLE:-api}"
case "$ROLE" in
  api|worker|scheduler|updater|mounter) ;;
  *)
    echo "restow: unknown ROLE '$ROLE' (expected: api | worker | scheduler | updater | mounter)" >&2
    exit 64
    ;;
esac
# The opt-in updater (compose profile `updater`, docs/UPDATING.md) ships inside the api
# package: it needs no database access and no migrations, and gets a process of its own.
if [ "$ROLE" = updater ]; then
  echo "restow: starting role 'updater'" >&2
  exec node /prod/api/dist/apps/api/src/updater/main.js
fi
# The opt-in mounter (compose profile `mounts`, docs/MOUNTS.md) adds NFS shares as Docker
# volumes; like the updater it lives in the api package and needs no database access.
if [ "$ROLE" = mounter ]; then
  echo "restow: starting role 'mounter'" >&2
  exec node /prod/api/dist/apps/api/src/mounter/main.js
fi
DIR="/prod/$ROLE"
# The api role applies database migrations (Drizzle migrations + RLS + the
# application and installation roles) as the database owner
# (DATABASE_MIGRATION_URL) before it serves. Idempotent; single-instance deploys
# only (a dedicated migrate job is the pattern once the api scales horizontally).
if [ "$ROLE" = api ]; then
  echo "restow: applying database migrations" >&2
  ( cd "$DIR" && node -e "import('@restow/db/migrate').then(m=>m.migrateFromEnvironment()).then(()=>process.exit(0)).catch(e=>{console.error(e.message);process.exit(1)})" ) || { echo "restow: migrations failed" >&2; exit 1; }
fi
echo "restow: starting role '$ROLE'" >&2
# Prefer the app's own "start" script (a plain `node ...` command; the runtime image has
# no pnpm); fall back to the built entrypoint. exec: the node process is the container's
# main process and receives the stop signal itself.
START="$(node -p "((require('$DIR/package.json').scripts) || {}).start || ''" 2>/dev/null || true)"
if [ -n "$START" ]; then
  cd "$DIR" && exec sh -c "exec $START"
else
  exec node "$DIR/dist/index.js"
fi
EOF
RUN chmod +x /usr/local/bin/restow-entrypoint

# The standalone restore tool (packages/cli): a restore from the storage format
# alone, with no server and no database. Run it from this image with
# `docker run --rm --entrypoint restow-restore -v <storage>:/data:ro <image> restore ...`.
COPY <<'EOF' /usr/local/bin/restow-restore
#!/bin/sh
exec node /prod/cli/dist/restow-restore.js "$@"
EOF
RUN chmod +x /usr/local/bin/restow-restore

# Maintenance commands for the operator (apps/api/src/cli), run in the api container
# with its configuration: `docker compose exec api restow help`, for example
# `docker compose exec api restow admin recover --email owner@example.com` when the
# last owner lost their passkey, authenticator app or password.
COPY <<'EOF' /usr/local/bin/restow
#!/bin/sh
exec node /prod/api/dist/apps/api/src/cli/bin.js "$@"
EOF
RUN chmod +x /usr/local/bin/restow

# The package managers of the Node image (npm, yarn, corepack and the pnpm it
# fetched) build the image but run nothing here: the entrypoint starts each role
# with node. They stay in the lower layers of the Node base image, but no longer
# in the file system, so the vulnerability scan (release smoke check 9) does not
# report the packages they bundle.
RUN rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx \
    /usr/local/bin/corepack /usr/local/bin/pnpm /usr/local/bin/pnpx \
    /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-v* /root/.cache/node /pnpm

# API serves HTTP on 3000 (health: /healthz, /readyz). Worker and scheduler
# expose no ports. The archive journal SMTP receiver (api role) listens on a
# configurable port (JOURNAL_SMTP_PORT) — publish it from compose when needed.
EXPOSE 3000
ENTRYPOINT ["/usr/local/bin/restow-entrypoint"]
LABEL org.opencontainers.image.vendor="IT Systeme Flores UG (haftungsbeschraenkt)" \
      org.opencontainers.image.source="https://github.com/restow-backup/restow" \
      org.opencontainers.image.documentation="https://github.com/restow-backup/restow/blob/main/README.md"

########################################
# runtime-community — the application image of the Community build
########################################
# Published as ghcr.io/restow-backup/restow-community (docs/CI.md). RESTOW_IMAGE_VARIANT
# tells the update check and the opt-in updater to stay on the Community images.
FROM runtime-base AS runtime-community
COPY --from=deploy-community /prod /prod
# Release tag and commit of this build (CI: --build-arg RESTOW_VERSION=0.2.1). GET
# /api/v1/status reports them and the opt-in update check compares against the
# version; empty for local builds. Declared last so a new version does not rebuild
# the layers above it.
ARG RESTOW_VERSION=
ARG RESTOW_REVISION=
ARG RESTOW_CREATED=
ENV RESTOW_VERSION=${RESTOW_VERSION} \
    RESTOW_REVISION=${RESTOW_REVISION} \
    RESTOW_IMAGE_VARIANT=community
LABEL org.opencontainers.image.title="Restow Community" \
      org.opencontainers.image.description="Self-hosted backup and archive for Microsoft 365 and IMAP: the api, worker and scheduler roles of one image (Community build: the Apache-2.0 core without the Business and Service Provider modules)" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.version="${RESTOW_VERSION}" \
      org.opencontainers.image.revision="${RESTOW_REVISION}" \
      org.opencontainers.image.created="${RESTOW_CREATED}"

########################################
# runtime — the application image of the full build
########################################
# Published as ghcr.io/restow-backup/restow: the core plus the Business and Service
# Provider modules, locked until a license key is installed.
FROM runtime-base AS runtime
COPY --from=deploy /prod /prod
# The license of the Business and Service Provider modules this build contains.
COPY ee/LICENSE /usr/share/doc/restow/ee-LICENSE
ARG RESTOW_VERSION=
ARG RESTOW_REVISION=
ARG RESTOW_CREATED=
ENV RESTOW_VERSION=${RESTOW_VERSION} \
    RESTOW_REVISION=${RESTOW_REVISION} \
    RESTOW_IMAGE_VARIANT=full
LABEL org.opencontainers.image.title="Restow" \
      org.opencontainers.image.description="Self-hosted backup and archive for Microsoft 365 and IMAP: the api, worker and scheduler roles of one image" \
      org.opencontainers.image.licenses="Apache-2.0 AND LicenseRef-Restow-Enterprise" \
      org.opencontainers.image.version="${RESTOW_VERSION}" \
      org.opencontainers.image.revision="${RESTOW_REVISION}" \
      org.opencontainers.image.created="${RESTOW_CREATED}"

########################################
# web-base — Caddy: serves the built SPA, terminates TLS and proxies /api to the api service
########################################
FROM caddy:2-alpine AS web-base
COPY Caddyfile /etc/caddy/Caddyfile
COPY LICENSE NOTICE THIRD_PARTY_NOTICES.md licenses/ /usr/share/doc/restow/
# The third-party notices as plain text for the browser (the settings' About box
# links to it); the Caddyfile serves /licenses/* as static files.
COPY THIRD_PARTY_NOTICES.md /srv/licenses/THIRD_PARTY_NOTICES.txt
LABEL org.opencontainers.image.vendor="IT Systeme Flores UG (haftungsbeschraenkt)" \
      org.opencontainers.image.source="https://github.com/restow-backup/restow" \
      org.opencontainers.image.documentation="https://github.com/restow-backup/restow/blob/main/README.md"

########################################
# web-community — the web edge of the Community build (ghcr.io/restow-backup/restow-web-community)
########################################
FROM web-base AS web-community
COPY --from=build-community /app/apps/web/dist /srv
ARG RESTOW_VERSION=
ARG RESTOW_REVISION=
ARG RESTOW_CREATED=
LABEL org.opencontainers.image.title="Restow Community web edge" \
      org.opencontainers.image.description="Caddy edge of Restow: the built web interface, TLS and the /api reverse proxy (Community build: the Apache-2.0 core without the Business and Service Provider modules)" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.version="${RESTOW_VERSION}" \
      org.opencontainers.image.revision="${RESTOW_REVISION}" \
      org.opencontainers.image.created="${RESTOW_CREATED}"

########################################
# web — the web edge of the full build (ghcr.io/restow-backup/restow-web)
########################################
# Kept the last stage: a build without --target builds this one, as before.
FROM web-base AS web
COPY --from=build /app/apps/web/dist /srv
COPY ee/LICENSE /usr/share/doc/restow/ee-LICENSE
ARG RESTOW_VERSION=
ARG RESTOW_REVISION=
ARG RESTOW_CREATED=
LABEL org.opencontainers.image.title="Restow web edge" \
      org.opencontainers.image.description="Caddy edge of Restow: the built web interface, TLS and the /api reverse proxy" \
      org.opencontainers.image.licenses="Apache-2.0 AND LicenseRef-Restow-Enterprise" \
      org.opencontainers.image.version="${RESTOW_VERSION}" \
      org.opencontainers.image.revision="${RESTOW_REVISION}" \
      org.opencontainers.image.created="${RESTOW_CREATED}"
