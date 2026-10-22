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
# Follow mode (RESTOW_DEMO_FOLLOW in .env, README "Following the releases"):
# instead of loaded images, the reset pulls the four images of one published
# release from the registry (ghcr.io/restow-backup by default) before it tears
# anything down — the moving tag (`beta`, `latest`) only ever for the demo's
# own seed image, the release that tag names then by its exact version for all
# four — checks that all four carry the same release version label, and runs
# the project from exactly those references. A failed pull or a mix of releases
# stops the reset like a missing image does: the running demo stays as it is.
# Production image names (restow:local, restow-web:local, or a moving tag a
# co-hosted production stack might use) are never pulled or re-tagged
# (security review finding M2).
#
# Fast reset (README, "Fast reset"): a full seed replays 30 days of real
# backups and keeps the demo offline for many minutes. So after a full seed the
# script saves a template — a pg_dump of the database, its roles, and a tar of
# each volume the seed writes (demo-data, demo-mail, demo-agents) — keyed by the
# release and the exact images, in RESTOW_DEMO_TEMPLATE_DIR (two kept). The
# next nights it restores that template instead of seeding: down, restore,
# move every system time forward by the template's age
# (seed/sql/shift-time.sql) so the history still ends today, up — seconds
# instead of minutes. A missing, incomplete or too old template
# (RESTOW_DEMO_TEMPLATE_MAX_AGE_DAYS, default 7), a new release or new images,
# a changed .env, or a restore that fails all lead to the full seed (and a new
# template). `web` still starts only after a successful seed or restore.
#
# Compose files (RESTOW_DEMO_COMPOSE_FILES): the environment of the run wins,
# then .env. Earlier versions of this script read the setting from the
# environment only, so on a host whose .env sets the public override
# (80/443), the demo has so far run with docker-compose.yml alone; such a value
# from .env is used only together with RESTOW_DEMO_PUBLISH_PUBLIC=true, and
# the log says which files the run uses and why.
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

# Which compose files to use, colon-separated, relative to this directory
# (resolve_compose_files below). Default is the base file alone, which
# publishes `web` on the Docker bridge gateway only (co-hosted variant, and the
# recommended starting point everywhere else too); the own-VM variant sets
# RESTOW_DEMO_COMPOSE_FILES=docker-compose.yml:docker-compose.override.public.yml
# and RESTOW_DEMO_PUBLISH_PUBLIC=true in .env to publish 80/443 (see
# docker-compose.override.public.yml and the README, "Option A").
DEFAULT_COMPOSE_FILES=docker-compose.yml
COMPOSE_FILES=""

# The volumes a seed writes (docker-compose.yml), which a template holds: the
# chunk store with the machines' restic repositories, the Dovecot mail store,
# the logins of the simulated machines. Caddy's state is not part of it and
# starts empty after every reset, as before.
TEMPLATE_VOLUMES="demo-data demo-mail demo-agents"
# What a template holds and how; a change here makes every older template unusable.
TEMPLATE_FORMAT=1
# Templates kept: the current one and the one before (a release back, say).
TEMPLATE_KEEP=2
SHIFT_SQL="${COMPOSE_DIR}/seed/sql/shift-time.sql"
OFFLINE_SINCE=""

# compose_args <colon-separated list>: the -f arguments, one per line.
compose_args() {
  list=$1
  old_ifs=$IFS
  IFS=:
  set --
  for f in $list; do
    set -- "$@" -f "${COMPOSE_DIR}/${f}"
  done
  IFS=$old_ifs
  printf '%s\n' "$@"
}

compose() {
  # shellcheck disable=SC2046
  docker compose $(compose_args "${COMPOSE_FILES:-$DEFAULT_COMPOSE_FILES}") --env-file "$ENV_FILE" "$@"
}

# compose_with <colon-separated list> <args>: compose with other files than the resolved ones.
compose_with() {
  with=$1
  shift
  # shellcheck disable=SC2046
  docker compose $(compose_args "$with") --env-file "$ENV_FILE" "$@"
}

log() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1"
}

# The last NAME=value line of the env file (plain KEY=value, optionally quoted;
# the file is never sourced, so nothing in it runs).
file_setting() {
  value=""
  if [ -f "$ENV_FILE" ]; then
    value=$(grep "^$1=" "$ENV_FILE" | tail -n 1 | cut -d= -f2- | tr -d '\r')
    case "$value" in
      \"*\")
        value=${value#\"}
        value=${value%\"}
        ;;
      \'*\')
        value=${value#\'}
        value=${value%\'}
        ;;
    esac
  fi
  printf '%s' "$value"
}

# A setting of this script itself: the environment wins, otherwise the env file.
setting() {
  value=$(printenv "$1" 2>/dev/null || true)
  if [ -z "$value" ]; then
    value=$(file_setting "$1")
  fi
  printf '%s' "$value"
}

# The release version an image says it is (the OCI label the release workflow
# sets from the tag; empty for a local build).
image_version() {
  docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.version"}}' "$1" 2>/dev/null || true
}

# matches <extended regex> <value>: the whole value, a single line, matches.
matches() {
  case "$2" in
    *"
"*) return 1 ;;
  esac
  printf '%s\n' "$2" | grep -Eqx "$1"
}

is_release_version() {
  matches '[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?' "$1"
}

pull() {
  if ! docker pull --quiet "$1"; then
    log "follow mode: could not pull $1; nothing was stopped, the demo keeps running the images it has"
    exit 1
  fi
}

# Follow mode: pull the release RESTOW_DEMO_FOLLOW names (a channel tag such as
# `beta` or `latest`, or an exact version such as 0.4.2) and point the compose
# project at it (README, "Following the releases"). Everything here happens
# before the project is touched; any failure exits and leaves it running.
follow_release() {
  follow="$1"
  registry=$(setting RESTOW_DEMO_FOLLOW_REGISTRY)
  registry="${registry:-ghcr.io/restow-backup}"
  if ! matches '[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}' "$follow"; then
    log "follow mode: RESTOW_DEMO_FOLLOW=${follow} is not a tag (a channel such as beta or latest, or a version such as 0.4.2)"
    exit 1
  fi
  if ! matches '[a-z0-9]+([._-][a-z0-9]+)*(:[0-9]+)?(/[a-z0-9]+([._-][a-z0-9]+)*)*' "$registry"; then
    log "follow mode: RESTOW_DEMO_FOLLOW_REGISTRY=${registry} is not a registry path (for example ghcr.io/restow-backup)"
    exit 1
  fi

  # Which release the tag names, read from the demo's own seed image: a moving
  # tag is never pulled for the application images, so a co-hosted production
  # stack that runs restow:beta or restow:latest is never moved by the demo.
  log "follow mode: looking up ${follow} at ${registry}"
  pull "${registry}/restow-demo-seed:${follow}"
  version=$(image_version "${registry}/restow-demo-seed:${follow}")
  if ! is_release_version "$version"; then
    log "follow mode: ${registry}/restow-demo-seed:${follow} carries no release version (org.opencontainers.image.version '${version}'); nothing was stopped"
    exit 1
  fi
  if is_release_version "$follow" && [ "$version" != "$follow" ]; then
    log "follow mode: ${registry}/restow-demo-seed:${follow} says it is ${version}; nothing was stopped"
    exit 1
  fi

  app="${registry}/restow:${version}"
  web="${registry}/restow-web:${version}"
  seed="${registry}/restow-demo-seed:${version}"
  dovecot="${registry}/restow-demo-dovecot:${version}"
  for ref in "$app" "$web" "$seed" "$dovecot"; do
    pull "$ref"
  done

  # All four from the same release, or none: a seed of one release against
  # the api of another is refused, not tried.
  mixed=""
  for ref in "$app" "$web" "$seed" "$dovecot"; do
    actual=$(image_version "$ref")
    if [ "$actual" != "$version" ]; then
      mixed="${mixed} ${ref}=${actual:-none}"
    fi
  done
  if [ -n "$mixed" ]; then
    log "follow mode: the images are not all release ${version}:${mixed}; nothing was stopped"
    exit 1
  fi

  # The shell environment wins over --env-file in docker compose, so these
  # replace whatever RESTOW_DEMO_*_IMAGE .env sets, for this run only.
  RESTOW_DEMO_APP_IMAGE="$app"
  RESTOW_DEMO_WEB_IMAGE="$web"
  RESTOW_DEMO_SEED_IMAGE="$seed"
  RESTOW_DEMO_DOVECOT_IMAGE="$dovecot"
  export RESTOW_DEMO_APP_IMAGE RESTOW_DEMO_WEB_IMAGE RESTOW_DEMO_SEED_IMAGE RESTOW_DEMO_DOVECOT_IMAGE
  FOLLOWED_VERSION="$version"
  log "follow mode: ${follow} is Restow ${version}; using ${app}, ${web}, ${seed}, ${dovecot}"
}

# Which compose files this run uses (RESTOW_DEMO_COMPOSE_FILES; README, "Reset").
# Each entry is a file below this directory; anything else stops the run before
# it touches the project.
check_compose_files() {
  old_ifs=$IFS
  IFS=:
  for f in $1; do
    IFS=$old_ifs
    if ! matches '[A-Za-z0-9._][A-Za-z0-9._/-]*' "$f" || matches '(.*/)?\.\.(/.*)?' "$f" ||
      [ ! -f "${COMPOSE_DIR}/${f}" ]; then
      log "RESTOW_DEMO_COMPOSE_FILES (${2}): ${f} is not a compose file in ${COMPOSE_DIR}; nothing was stopped"
      exit 1
    fi
  done
  IFS=$old_ifs
}

# publishes_everywhere <colon-separated list>: with these files, `web` publishes
# a port without a host address (every interface), as the own-VM override does
# for 80/443. A list compose cannot read counts as publishing everywhere.
publishes_everywhere() {
  web_config=$(compose_with "$1" config --format json web 2>/dev/null) || return 0
  web_config=$(printf '%s' "$web_config" | tr -d ' \t\n')
  published=$(printf '%s' "$web_config" | grep -o '"published":' | wc -l | tr -d ' ')
  bound=0
  for host_ip in $(printf '%s' "$web_config" | grep -o '"host_ip":"[^"]*"' | cut -d'"' -f4); do
    case "$host_ip" in
      0.0.0.0 | :: | "[::]") ;;
      *) bound=$((bound + 1)) ;;
    esac
  done
  [ "$published" -gt "$bound" ]
}

# The environment of the run wins, as it always did. From .env (which earlier
# versions of this script never read for this setting, whatever the README
# said), a list that would publish `web` on every interface is used only with
# RESTOW_DEMO_PUBLISH_PUBLIC=true as well: a co-hosted host that carries the
# own-VM line there has been running without it, and must not start binding
# 80/443 next to its production edge because of an update of this script.
resolve_compose_files() {
  from_env=$(printenv RESTOW_DEMO_COMPOSE_FILES 2>/dev/null || true)
  if [ -n "$from_env" ]; then
    check_compose_files "$from_env" "from the environment"
    COMPOSE_FILES=$from_env
    log "compose files: ${COMPOSE_FILES} (from the environment)"
    return
  fi
  from_file=$(file_setting RESTOW_DEMO_COMPOSE_FILES)
  if [ -z "$from_file" ]; then
    COMPOSE_FILES=$DEFAULT_COMPOSE_FILES
    log "compose files: ${COMPOSE_FILES} (default)"
    return
  fi
  check_compose_files "$from_file" "in ${ENV_FILE}"
  if [ "$from_file" != "$DEFAULT_COMPOSE_FILES" ] && publishes_everywhere "$from_file" &&
    [ "$(setting RESTOW_DEMO_PUBLISH_PUBLIC)" != "true" ]; then
    COMPOSE_FILES=$DEFAULT_COMPOSE_FILES
    log "RESTOW_DEMO_COMPOSE_FILES=${from_file} in ${ENV_FILE} would publish web on every interface (80/443); earlier versions of reset.sh did not read this setting from that file, so this demo has run without it so far and keeps doing so. On the demo's own VM (README, \"Option A\") set RESTOW_DEMO_PUBLISH_PUBLIC=true there as well"
    log "compose files: ${COMPOSE_FILES} (default; the public override in ${ENV_FILE} is not confirmed)"
    return
  fi
  COMPOSE_FILES=$from_file
  log "compose files: ${COMPOSE_FILES} (from ${ENV_FILE})"
}

# Every image the project runs, the seed's included (it sits behind a profile).
check_images() {
  images=$(compose --profile seed --profile template config --images | sort -u)
  missing=""
  for image in $images; do
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

# ---- Templates (README, "Fast reset") -------------------------------------------------

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | cut -d' ' -f1
  else
    shasum -a 256 | cut -d' ' -f1
  fi
}

# meta_value <meta file> <name>
meta_value() {
  grep "^$2=" "$1" 2>/dev/null | tail -n 1 | cut -d= -f2-
}

require_number() {
  if ! matches '[0-9]{1,7}' "$2"; then
    log "$1=$2 is not a whole number; nothing was stopped"
    exit 1
  fi
}

template_settings() {
  TEMPLATES=$(setting RESTOW_DEMO_TEMPLATES)
  TEMPLATES=${TEMPLATES:-true}
  case "$TEMPLATES" in
    true | false) ;;
    *)
      log "RESTOW_DEMO_TEMPLATES=${TEMPLATES} is neither true nor false; nothing was stopped"
      exit 1
      ;;
  esac
  TEMPLATE_DIR=$(setting RESTOW_DEMO_TEMPLATE_DIR)
  TEMPLATE_DIR=${TEMPLATE_DIR:-templates}
  case "$TEMPLATE_DIR" in
    /) log "RESTOW_DEMO_TEMPLATE_DIR must not be /; nothing was stopped" && exit 1 ;;
    /*) ;;
    *) TEMPLATE_DIR="${COMPOSE_DIR}/${TEMPLATE_DIR}" ;;
  esac
  MAX_AGE_DAYS=$(setting RESTOW_DEMO_TEMPLATE_MAX_AGE_DAYS)
  MAX_AGE_DAYS=${MAX_AGE_DAYS:-7}
  require_number RESTOW_DEMO_TEMPLATE_MAX_AGE_DAYS "$MAX_AGE_DAYS"
  MIN_FREE_MB=$(setting RESTOW_DEMO_TEMPLATE_MIN_FREE_MB)
  MIN_FREE_MB=${MIN_FREE_MB:-1024}
  require_number RESTOW_DEMO_TEMPLATE_MIN_FREE_MB "$MIN_FREE_MB"
  QUIET_SECONDS=$(setting RESTOW_DEMO_TEMPLATE_QUIET_SECONDS)
  QUIET_SECONDS=${QUIET_SECONDS:-300}
  require_number RESTOW_DEMO_TEMPLATE_QUIET_SECONDS "$QUIET_SECONDS"
}

# The template this run would restore or save: the release it is (the followed
# one, else the version label of the application image, else "local") and a
# hash of everything its content depends on — the exact image of every service
# (ids, so a rebuilt :local tag counts as new), the env file (passwords, the
# master key, the demo account and the seed settings all live there) and the
# template format.
compute_template_key() {
  app_image=$(setting RESTOW_DEMO_APP_IMAGE)
  version=${FOLLOWED_VERSION:-$(image_version "${app_image:-restow-demo-app:local}")}
  if ! matches '[0-9A-Za-z][0-9A-Za-z._-]{0,63}' "$version"; then
    version=local
  fi
  material="format=${TEMPLATE_FORMAT}"
  image_ids=""
  for image in $images; do
    id=$(docker image inspect --format '{{.Id}}' "$image" 2>/dev/null || true)
    material="${material}
image=${image} ${id}"
    image_ids="${image_ids} ${image}@${id}"
  done
  material="${material}
env=$(sha256 <"$ENV_FILE")"
  TEMPLATE_VERSION=$version
  TEMPLATE_IMAGES=${image_ids# }
  TEMPLATE_KEY="${version}-$(printf '%s\n' "$material" | sha256 | cut -c1-16)"
}

# Is there a template for this key that may be restored? Says why not.
template_usable() {
  dir="${TEMPLATE_DIR}/${TEMPLATE_KEY}"
  if [ ! -f "${dir}/meta" ]; then
    log "no template for ${TEMPLATE_KEY} yet: seeding from scratch, then saving one"
    return 1
  fi
  files="roles.sql database.dump"
  for volume in $TEMPLATE_VOLUMES; do
    files="${files} ${volume}.tar"
  done
  for file in $files; do
    if [ ! -s "${dir}/${file}" ]; then
      log "template ${TEMPLATE_KEY} has no ${file}: seeding from scratch"
      return 1
    fi
  done
  if [ "$(meta_value "${dir}/meta" key)" != "$TEMPLATE_KEY" ] ||
    [ "$(meta_value "${dir}/meta" format)" != "$TEMPLATE_FORMAT" ]; then
    log "template ${TEMPLATE_KEY} does not describe itself as such: seeding from scratch"
    return 1
  fi
  if [ ! -f "$SHIFT_SQL" ]; then
    log "missing ${SHIFT_SQL}: seeding from scratch"
    return 1
  fi
  taken=$(meta_value "${dir}/meta" taken_epoch)
  if ! matches '[0-9]{1,12}(\.[0-9]{1,9})?' "$taken"; then
    log "template ${TEMPLATE_KEY} has no valid time (taken_epoch '${taken}'): seeding from scratch"
    return 1
  fi
  age=$(($(date +%s) - ${taken%%.*}))
  if [ "$age" -lt -3600 ]; then
    log "template ${TEMPLATE_KEY} was taken in the future (a wrong clock?): seeding from scratch"
    return 1
  fi
  if [ "$MAX_AGE_DAYS" -eq 0 ] || [ "$age" -gt $((MAX_AGE_DAYS * 86400)) ]; then
    log "template ${TEMPLATE_KEY} is $((age / 86400)) days old, older than RESTOW_DEMO_TEMPLATE_MAX_AGE_DAYS=${MAX_AGE_DAYS}: seeding from scratch (the machines' snapshot lists show restic's own times, which a restore cannot move)"
    return 1
  fi
  TEMPLATE_TAKEN=$taken
  TEMPLATE_AGE=$age
  return 0
}

# Scripts run inside the containers, with their own environment (POSTGRES_USER and
# POSTGRES_DB of the postgres service); the action is their $0, so each call says
# what it does (in `ps`, in the log, in deploy/demo/test.sh).
# shellcheck disable=SC2016
pg_script() {
  psql='psql -X -q -v ON_ERROR_STOP=1 -U "$POSTGRES_USER"'
  case "$1" in
    now) printf '%s' "${psql} -At -d \"\$POSTGRES_DB\" -c 'select extract(epoch from clock_timestamp())'" ;;
    size) printf '%s' "${psql} -At -d \"\$POSTGRES_DB\" -c 'select pg_database_size(current_database())'" ;;
    # Work in progress: a template is only taken of a quiet demo. A queued job is
    # fine (it is queued in the same database and runs after a restore); one that
    # runs would be cut off halfway, its files half written.
    quiet) printf '%s' "${psql} -At -d \"\$POSTGRES_DB\" -c \"select (select count(*) from jobs where status = 'active') + (select count(*) from endpoint_runs where status = 'running') + (select count(*) from pgboss.job where state = 'active')\"" ;;
    dump) printf '%s' 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' ;;
    # The login roles the migrations created (tenant, installation, auth), not the
    # bootstrap superuser, which every fresh postgres container creates itself.
    roles) printf '%s' 'f=$(mktemp) && pg_dumpall -U "$POSTGRES_USER" --roles-only >"$f" && grep -Ev "^(CREATE|ALTER) ROLE \"?${POSTGRES_USER}\"?[ ;]" "$f"; status=$?; rm -f "$f"; exit "$status"' ;;
    restore-roles) printf '%s' "${psql} -d template1 -f -" ;;
    # Into <db>_next, next to the database the demo still runs on.
    restore-db) printf '%s' 'dropdb -U "$POSTGRES_USER" --maintenance-db=template1 --if-exists --force "${POSTGRES_DB}_next" && createdb -U "$POSTGRES_USER" --maintenance-db=template1 -O "$POSTGRES_USER" "${POSTGRES_DB}_next" && pg_restore -U "$POSTGRES_USER" -d "${POSTGRES_DB}_next" --exit-on-error --single-transaction' ;;
    shift) printf '%s' "PGOPTIONS=\"-c restow_demo.template_epoch=\$1\" ${psql} -d \"\${POSTGRES_DB}_next\" -f -" ;;
    # The restored database replaces the demo's (whose services are stopped by
    # then): two renames, swap_sql below; the old one is dropped once the demo is
    # back (drop-old), so its size never adds to the time offline.
    swap) printf '%s' "PGOPTIONS=\"-c restow_demo.database=\$POSTGRES_DB\" ${psql} -d template1 -f -" ;;
    drop-old) printf '%s' 'dropdb -U "$POSTGRES_USER" --maintenance-db=template1 --if-exists --force "${POSTGRES_DB}_old"' ;;
    drop-next) printf '%s' 'dropdb -U "$POSTGRES_USER" --maintenance-db=template1 --if-exists --force "${POSTGRES_DB}_next"' ;;
  esac
}

# shellcheck disable=SC2016
holder_script() {
  case "$1" in
    tar-create) printf '%s' 'tar --numeric-owner -C "/volumes/$1" -cf - .' ;;
    # Into an emptied volume: nothing of the day before stays.
    tar-extract) printf '%s' 'find "/volumes/$1" -mindepth 1 -delete && tar --numeric-owner -C "/volumes/$1" -xf - ${2:+"$2"}' ;;
    du) printf '%s' 'du -sk /volumes | cut -f1' ;;
  esac
}

# pg_exec <action> [args]: run an action in the postgres container (stdin and stdout pass through).
pg_exec() {
  action=$1
  shift
  compose exec -T postgres sh -c "$(pg_script "$action")" "restow-${action}" "$@"
}

# holder_exec <action> [args]: run an action in the template container.
holder_exec() {
  action=$1
  shift
  compose --profile template exec -T template sh -c "$(holder_script "$action")" "restow-${action}" "$@"
}

holder_up() {
  compose --profile template up -d --no-build --pull never --no-deps template
}

holder_down() {
  compose --profile template rm --stop --force template
}

# prune_templates <keep>: remove all but the newest <keep> templates.
prune_templates() {
  [ -d "$TEMPLATE_DIR" ] || return 0
  for dir in "$TEMPLATE_DIR"/*; do
    [ -f "${dir}/meta" ] || continue
    name=${dir##*/}
    matches '[0-9A-Za-z][0-9A-Za-z._-]*' "$name" || continue
    taken=$(meta_value "${dir}/meta" taken_epoch)
    matches '[0-9]{1,12}(\.[0-9]{1,9})?' "$taken" || taken=0
    printf '%s %s\n' "${taken%%.*}" "$name"
  done | sort -rn | awk -v keep="$1" 'NR > keep { print $2 }' | while read -r name; do
    rm -rf "${TEMPLATE_DIR:?}/${name}"
    log "removed the older template ${name}"
  done
}

# Until no job and no machine run is going (the scheduler is stopped by then, and
# nothing outside can start one: web is not up), at most RESTOW_DEMO_TEMPLATE_QUIET_SECONDS.
wait_quiet() {
  waited=0
  while :; do
    busy=$(pg_exec quiet </dev/null) || return 1
    if ! matches '[0-9]+' "$busy"; then
      log "could not tell whether jobs are still running ('${busy}')"
      return 1
    fi
    if [ "$busy" -eq 0 ]; then
      return 0
    fi
    if [ "$waited" -ge "$QUIET_SECONDS" ]; then
      log "${busy} jobs or machine runs still going after ${waited} s (RESTOW_DEMO_TEMPLATE_QUIET_SECONDS)"
      return 1
    fi
    sleep 5
    waited=$((waited + 5))
  done
}

# The template itself, with the template container up and api, worker and
# scheduler about to stop. Runs as a condition, so every step checks itself.
snapshot_template() {
  umask 077
  mkdir -p "$TEMPLATE_DIR" || return 1
  rm -rf "${TEMPLATE_DIR:?}"/.partial-* "${TEMPLATE_DIR:?}/${TEMPLATE_KEY}"
  prune_templates $((TEMPLATE_KEEP - 1))

  log "stopping the scheduler, waiting until no job runs, stopping api and worker"
  compose stop scheduler || return 1
  wait_quiet || return 1
  compose stop api worker || return 1

  db_bytes=$(pg_exec size </dev/null) || return 1
  volumes_kb=$(holder_exec du </dev/null) || return 1
  if ! matches '[0-9]+' "$db_bytes" || ! matches '[0-9]+' "$volumes_kb"; then
    log "could not measure the database ('${db_bytes}') or the volumes ('${volumes_kb}')"
    return 1
  fi
  # The dump is smaller than the database (no indexes, compressed); the tars are
  # the size of the volumes. A fifth on top, and RESTOW_DEMO_TEMPLATE_MIN_FREE_MB
  # left free on the disk afterwards.
  need_kb=$(((db_bytes / 1024 + volumes_kb) * 12 / 10 + MIN_FREE_MB * 1024))
  avail_kb=$(df -Pk "$TEMPLATE_DIR" | awk 'NR == 2 { print $4 }')
  if ! matches '[0-9]+' "$avail_kb" || [ "$avail_kb" -lt "$need_kb" ]; then
    log "not enough free space in ${TEMPLATE_DIR}: ${avail_kb:-unknown} KiB free, ${need_kb} KiB needed (the template and RESTOW_DEMO_TEMPLATE_MIN_FREE_MB=${MIN_FREE_MB})"
    return 1
  fi

  partial="${TEMPLATE_DIR}/.partial-${TEMPLATE_KEY}"
  mkdir "$partial" || return 1
  taken=$(pg_exec now </dev/null) || return 1
  if ! matches '[0-9]{1,12}(\.[0-9]{1,9})?' "$taken"; then
    log "could not read the database's clock ('${taken}')"
    return 1
  fi
  pg_exec dump </dev/null >"${partial}/database.dump" || return 1
  pg_exec roles </dev/null >"${partial}/roles.sql" || return 1
  for volume in $TEMPLATE_VOLUMES; do
    holder_exec tar-create "$volume" </dev/null >"${partial}/${volume}.tar" || return 1
  done
  {
    printf 'key=%s\n' "$TEMPLATE_KEY"
    printf 'format=%s\n' "$TEMPLATE_FORMAT"
    printf 'version=%s\n' "$TEMPLATE_VERSION"
    printf 'taken_epoch=%s\n' "$taken"
    printf 'taken_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf 'images=%s\n' "$TEMPLATE_IMAGES"
  } >"${partial}/meta" || return 1
  mv "$partial" "${TEMPLATE_DIR}/${TEMPLATE_KEY}" || return 1
  TEMPLATE_SIZE=$(du -sk "${TEMPLATE_DIR}/${TEMPLATE_KEY}" | cut -f1)
  prune_templates "$TEMPLATE_KEEP"
}

# After a successful full seed: save the template the next resets restore. A
# failure here costs the next night a full seed, never this one its demo.
save_template() {
  log "saving template ${TEMPLATE_KEY} for the next resets in ${TEMPLATE_DIR}"
  started=$(date +%s)
  # Holds demo-data while api and worker are stopped (a tmpfs volume nobody mounts is gone).
  if ! holder_up; then
    log "the template container did not start; no template saved, the next reset seeds from scratch again"
    return 0
  fi
  if snapshot_template; then
    log "template ${TEMPLATE_KEY} saved in $(($(date +%s) - started)) s (${TEMPLATE_SIZE} KiB)"
  else
    rm -rf "${TEMPLATE_DIR:?}"/.partial-*
    log "no template saved; the next reset seeds from scratch again"
  fi
  log "starting api, worker and scheduler again"
  if ! compose up -d --no-build --pull never --wait api worker scheduler; then
    log "api, worker or scheduler did not come back after the template was saved; web stays down"
    exit 1
  fi
  holder_down || true
}

# The roles of a template, safe to apply to a cluster that has them already (the
# demo's postgres keeps running across a restore): each CREATE ROLE only where the
# role is missing; the ALTER ROLE after it sets attributes and password either way.
# shellcheck disable=SC2016
idempotent_roles() {
  sed -E 's/^CREATE ROLE (.+);$/DO $restow$ BEGIN CREATE ROLE \1; EXCEPTION WHEN duplicate_object THEN NULL; END $restow$;/'
}

swap_sql() {
  cat <<'SQL'
-- deploy/demo/reset.sh: the restored database (<db>_next) becomes the demo's.
DO $swap$
DECLARE
  db text := current_setting('restow_demo.database');
BEGIN
  PERFORM pg_terminate_backend(pid, 5000) FROM pg_stat_activity
   WHERE datname IN (db, db || '_next') AND pid <> pg_backend_pid();
  IF EXISTS (SELECT 1 FROM pg_database WHERE datname = db) THEN
    EXECUTE format('ALTER DATABASE %I RENAME TO %I', db, db || '_old');
  END IF;
  EXECUTE format('ALTER DATABASE %I RENAME TO %I', db || '_next', db);
END
$swap$;
SQL
}

# Restore the template instead of seeding. Runs as a condition: any failing step
# returns, and the caller seeds from scratch instead (which tears everything down).
#
# Everything that can happen while the demo still runs happens first: the
# template's database is restored next to the demo's (<db>_next) and moved
# forward in time there. Only then does the demo go offline: its services stop,
# the restored database replaces the old one, the volumes are refilled from the
# template, the services start again. postgres itself keeps running; its other
# state (the roles, which the template brings along) is not something a visitor
# can touch, nor is Caddy's, which keeps its certificate this way.
restore_template() {
  dir="${TEMPLATE_DIR}/${TEMPLATE_KEY}"
  log "preparing the restore while the demo still runs: database roles, pg_restore into a second database, time shift"
  compose up -d --no-build --pull never --wait postgres || return 1
  pg_exec drop-old </dev/null || return 1
  idempotent_roles <"${dir}/roles.sql" | pg_exec restore-roles || return 1
  pg_exec restore-db <"${dir}/database.dump" || return 1
  pg_exec shift "$TEMPLATE_TAKEN" <"$SHIFT_SQL" || return 1

  log "taking the demo offline: stopping its services"
  if [ -z "$OFFLINE_SINCE" ]; then
    OFFLINE_SINCE=$(date +%s)
  fi
  compose stop --timeout 10 web agent-sim api worker scheduler dovecot || return 1
  log "replacing the database with the restored one"
  swap_sql | pg_exec swap || return 1
  # Holds the tmpfs volumes from here until the services mount them again.
  holder_up || return 1
  log "restoring the volumes (${TEMPLATE_VOLUMES})"
  for volume in $TEMPLATE_VOLUMES; do
    # The storage's files get the time of the restore as their modification
    # time: the server dates a machine's snapshot by the earlier of the run's end
    # (moved forward with the database) and when its file was stored, so the
    # files must not look older than the moved runs. The other volumes keep
    # theirs (Dovecot reads a mail's arrival from its file).
    touch=""
    if [ "$volume" = demo-data ]; then
      touch=-m
    fi
    holder_exec tar-extract "$volume" ${touch:+"$touch"} <"${dir}/${volume}.tar" || return 1
  done
  log "starting dovecot, api, worker and scheduler"
  compose up -d --no-build --pull never --wait dovecot api worker scheduler || return 1
  # They hold the volumes now.
  holder_down || true
  # The demo's database of the day before, now that nothing waits for it.
  if ! pg_exec drop-old </dev/null; then
    log "could not drop the database of the day before (<db>_old); the next restore drops it first"
  fi
  return 0
}

teardown() {
  log "stopping the project and removing its volumes (database, mail, storage, Caddy state)"
  if [ -z "$OFFLINE_SINCE" ]; then
    OFFLINE_SINCE=$(date +%s)
  fi
  compose --profile seed --profile template down --volumes --remove-orphans --timeout 10
}

full_seed() {
  teardown

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

  if [ "$TEMPLATES" = "true" ]; then
    save_template
  fi
}

run() {
  {
    log "reset starting"

    if [ ! -f "$ENV_FILE" ]; then
      log "missing ${ENV_FILE}; copy .env.example to .env and fill it in first"
      exit 1
    fi

    resolve_compose_files
    template_settings

    FOLLOWED_VERSION=""
    follow=$(setting RESTOW_DEMO_FOLLOW)
    if [ -n "$follow" ]; then
      follow_release "$follow"
    fi

    check_images
    check_bind_address

    restored=""
    if [ "$TEMPLATES" = "true" ]; then
      compute_template_key
      if template_usable; then
        log "restoring template ${TEMPLATE_KEY} (taken $((TEMPLATE_AGE / 3600)) h ago) instead of seeding"
        if restore_template; then
          restored=yes
        else
          log "restoring template ${TEMPLATE_KEY} failed; removing it and seeding from scratch"
          pg_exec drop-next </dev/null >/dev/null 2>&1 || true
          holder_down >/dev/null 2>&1 || true
          rm -rf "${TEMPLATE_DIR:?}/${TEMPLATE_KEY}"
        fi
      fi
    else
      log "templates are off (RESTOW_DEMO_TEMPLATES=false): seeding from scratch"
    fi
    if [ -z "$restored" ]; then
      full_seed
    fi

    log "starting the heartbeat sidecar of the simulated machines"
    # Not fatal: without it the demo is complete, only the machines would show as offline.
    if ! compose up -d --no-build --pull never agent-sim; then
      log "agent-sim did not start; the simulated machines will show as offline"
    fi

    log "starting web (now reachable)"
    compose up -d --no-build --pull never --wait web

    how="seeded from scratch"
    if [ -n "$restored" ]; then
      how="restored from template ${TEMPLATE_KEY}"
    fi
    log "${how}; the demo was offline for $(($(date +%s) - OFFLINE_SINCE)) s"
    if [ -n "$FOLLOWED_VERSION" ]; then
      log "reset complete; the demo now runs Restow ${FOLLOWED_VERSION} (following ${follow})"
    else
      log "reset complete"
    fi
  } >>"$LOG_FILE" 2>&1
}

run
