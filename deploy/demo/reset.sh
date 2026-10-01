#!/bin/sh
# Restow public demo — nightly reset (03:00 Europe/Berlin via
# deploy/demo/systemd; deploy/demo/README.md, "Reset").
#
# Idempotent and safe to run by hand any time: tears the whole demo compose
# project down INCLUDING ITS VOLUMES (database, mail, chunk store, Caddy
# state — everything a visitor could have touched), brings everything back up
# EXCEPT `web`, runs the seed (deploy/demo/seed: synthetic mail, the demo
# tenants, sources, schedules, first backups + verification), and only then
# starts `web` — the one container anything outside this compose project can
# reach. If the seed fails, `web` is left down: an unconfigured or
# half-seeded installation is never published (security review finding 1).
# The seed also backs up two simulated machines with real restic (README,
# "Simulated machines"); the heartbeat sidecar `agent-sim` that keeps them
# online starts after the seed, together with `web`.
#
# Never builds anything. Every image comes prebuilt from
# deploy/demo/build-images.sh (run on a workstation or CI runner, then
# `docker load`ed here); a missing image stops the reset before anything is
# torn down, so a failed image transfer never takes a running demo offline.
# It also refuses to publish `web` on a wildcard address (0.0.0.0 or ::):
# the base compose file binds it to the Docker bridge gateway only.
#
# Logs to $RESTOW_DEMO_RESET_LOG (a plain file, append-only) so a failed run
# is visible without journalctl.
set -eu

COMPOSE_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
# The compose services read `env_file: .env` next to the compose file, so a different
# RESTOW_DEMO_ENV_FILE only changes the file the variables of the compose file itself
# (images, bind address, passwords) are read from; a test run that wants a different
# environment links or copies it to deploy/demo/.env as well.
ENV_FILE="${RESTOW_DEMO_ENV_FILE:-${COMPOSE_DIR}/.env}"
LOG_FILE="${RESTOW_DEMO_RESET_LOG:-/var/log/restow-demo-reset.log}"

# Which compose files to use, colon-separated, relative to this directory.
# Default is the base file alone, which publishes `web` on the Docker bridge
# gateway only (co-hosted variant, and the recommended starting point
# everywhere else too); the own-VM variant sets
# RESTOW_DEMO_COMPOSE_FILES=docker-compose.yml:docker-compose.override.public.yml
# in .env to publish 80/443 (see docker-compose.override.public.yml and the
# README, "Option A").
compose_files() {
  files="${RESTOW_DEMO_COMPOSE_FILES:-docker-compose.yml}"
  old_ifs=$IFS
  IFS=:
  set --
  for f in $files; do
    set -- "$@" -f "${COMPOSE_DIR}/${f}"
  done
  IFS=$old_ifs
  printf '%s\n' "$@"
}

compose() {
  # shellcheck disable=SC2046
  docker compose $(compose_files) --env-file "$ENV_FILE" "$@"
}

log() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1"
}

# Every image the project runs, the seed's included (it sits behind a profile).
check_images() {
  images=$(compose --profile seed config --images)
  missing=""
  for image in $(printf '%s\n' "$images" | sort -u); do
    if ! docker image inspect "$image" >/dev/null 2>&1; then
      missing="${missing} ${image}"
    fi
  done
  if [ -n "$missing" ]; then
    log "missing images:${missing}"
    log "this script never builds: run deploy/demo/build-images.sh on a build machine, copy the tarball and its .sha256 file here, check it with 'sha256sum -c <tarball>.sha256' and load it with 'docker load -i <tarball>'; postgres:16-alpine comes from 'docker pull postgres:16-alpine'"
    exit 1
  fi
}

# `web` must never listen on every interface. The base file always sets a
# host address (RESTOW_DEMO_BIND_ADDRESS, default 172.17.0.1); only the
# own-VM override publishes 80/443 without one, which is its explicit purpose.
check_bind_address() {
  web_config=$(compose config --format json web)
  for host_ip in $(printf '%s' "$web_config" | tr -d ' \t\n' |
    grep -o '"host_ip":"[^"]*"' | cut -d'"' -f4); do
    case "$host_ip" in
      0.0.0.0 | :: | "[::]")
        log "refusing to publish web on ${host_ip} (every interface); set RESTOW_DEMO_BIND_ADDRESS to the Docker bridge gateway (default 172.17.0.1)"
        exit 1
        ;;
    esac
  done
}

run() {
  {
    log "reset starting"

    if [ ! -f "$ENV_FILE" ]; then
      log "missing ${ENV_FILE}; copy .env.example to .env and fill it in first"
      exit 1
    fi

    check_images
    check_bind_address

    log "stopping the project and removing its volumes (database, mail, storage, Caddy state)"
    compose down --volumes --remove-orphans

    log "starting everything except web from the prebuilt images"
    compose up -d --no-build --pull never --wait postgres dovecot api worker scheduler

    log "running the seed (synthetic mail, tenants, sources, schedules, first backups + verify, simulated machines, mail archive)"
    if compose run --rm --pull never seed; then
      log "seed completed"
    else
      log "seed failed; web stays down so nothing unconfigured or half-seeded is published"
      compose stop web >/dev/null 2>&1 || true
      exit 1
    fi

    log "starting the heartbeat sidecar of the simulated machines"
    # Not fatal: without it the demo is complete, only the machines would show as offline.
    if ! compose up -d --no-build --pull never agent-sim; then
      log "agent-sim did not start; the simulated machines will show as offline"
    fi

    log "starting web (now reachable)"
    compose up -d --no-build --pull never --wait web

    log "reset complete"
  } >>"$LOG_FILE" 2>&1
}

run
