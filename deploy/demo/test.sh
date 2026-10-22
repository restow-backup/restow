#!/usr/bin/env bash
# Tests of deploy/demo/reset.sh without Docker, network or a demo host: whole runs of
# the script against a stub `docker` that records every call, answers the image
# inspections from the test's settings and fails a pull when told to. Covers the
# default mode (loaded images, no registry at all) and follow mode (README,
# "Following the releases"): what is pulled and in which order, that nothing is
# stopped before every image is there and of one release, and what compose is
# finally pointed at. Then the fast reset (README, "Fast reset"): a template saved
# after a full seed, restored the next time, and every reason to seed from scratch
# instead (a new release, new images, a changed .env, an old or incomplete
# template, a failed restore, too little free space, jobs that do not finish); and
# which compose files a run uses (RESTOW_DEMO_COMPOSE_FILES from the environment
# or .env).
#
#   bash deploy/demo/test.sh
#
# Runs with bash 3.2 (macOS) and bash 5 (Linux CI); reset.sh itself runs under /bin/sh.
# shellcheck disable=SC2016 # the stub is a script of its own and expands at run time
set -uo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
RESET="$HERE/reset.sh"

PASSED=0
FAILED=0
TEMP_BASE=${TMPDIR:-/tmp}
TMP_ROOT=$(mktemp -d "${TEMP_BASE%/}/restow-demo-test.XXXXXX")
trap 'rm -rf "$TMP_ROOT"' EXIT

pass() {
  PASSED=$((PASSED + 1))
}
fail() {
  FAILED=$((FAILED + 1))
  printf 'FAIL: %s\n' "$*" >&2
}
assert_eq() {
  if [ "$1" = "$2" ]; then
    pass
  else
    fail "$3: expected [$1], got [$2]"
  fi
}
assert_contains() {
  case $2 in
    *"$1"*) pass ;;
    *) fail "$3: [$1] not found in output:"$'\n'"$2" ;;
  esac
}
assert_not_contains() {
  case $2 in
    *"$1"*) fail "$3: [$1] must not appear in:"$'\n'"$2" ;;
    *) pass ;;
  esac
}
# assert_before <first> <second> <text> <name>: both appear, the first one earlier.
assert_before() {
  local first second
  first=$(printf '%s\n' "$3" | grep -nF -- "$1" | head -n 1 | cut -d: -f1)
  second=$(printf '%s\n' "$3" | grep -nF -- "$2" | head -n 1 | cut -d: -f1)
  if [ -n "$first" ] && [ -n "$second" ] && [ "$first" -lt "$second" ]; then
    pass
  else
    fail "$4: [$1] (line ${first:-none}) must come before [$2] (line ${second:-none}) in:"$'\n'"$3"
  fi
}

# ---- The stub docker -------------------------------------------------------------------
#
# Settings (environment of the test run):
#   STUB_VERSION        what every image's version label says (default 0.4.3)
#   STUB_VERSION_<n>    the label of images whose reference contains STUB_REF_<n> (n = 1, 2)
#   STUB_PULL_FAIL      a pull of a reference containing this text fails
#   STUB_MISSING        `docker image inspect` of a reference containing this text fails
#   STUB_IMAGE_ID_SUFFIX  appended to every image id (a rebuilt image)
#   STUB_DB_NOW         the database's clock, Unix seconds (default: now)
#   STUB_BUSY           jobs still running (default 0)
#   STUB_EXEC_FAIL      a `compose exec` of this action (restow-<action>) fails
#   STUB_DF_AVAIL_KB    free space `df` reports (default: the real df)
# `compose config --images` prints the images the compose file would resolve: the
# RESTOW_DEMO_*_IMAGE variables of the environment, else those of the env file, else
# the defaults of docker-compose.yml, as docker compose does. `compose exec` answers
# the actions of reset.sh (the restow-<action> argument) and records what a restore
# receives on stdin.

STUB_BIN="$TMP_ROOT/bin"
mkdir -p "$STUB_BIN"
cat >"$STUB_BIN/docker" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "docker $*" >>"$STUB_CALLS"
label_of() {
  if [ -n "${STUB_REF_1:-}" ] && [[ $1 == *"$STUB_REF_1"* ]]; then
    printf '%s\n' "${STUB_VERSION_1:-}"
  elif [ -n "${STUB_REF_2:-}" ] && [[ $1 == *"$STUB_REF_2"* ]]; then
    printf '%s\n' "${STUB_VERSION_2:-}"
  else
    printf '%s\n' "${STUB_VERSION-0.4.3}"
  fi
}
from_env_file() {
  grep "^$1=" "$STUB_ENV_FILE" 2>/dev/null | tail -n 1 | cut -d= -f2-
}
image_var() {
  local value=${!1:-}
  if [ -z "$value" ]; then
    value=$(from_env_file "$1")
  fi
  printf '%s\n' "${value:-$2}"
}
case "$1" in
  pull)
    ref=${*: -1}
    if [ -n "${STUB_PULL_FAIL:-}" ] && [[ $ref == *"$STUB_PULL_FAIL"* ]]; then
      echo "Error response from daemon: manifest unknown" >&2
      exit 1
    fi
    printf '%s\n' "$ref"
    ;;
  image)
    ref=${*: -1}
    if [ -n "${STUB_MISSING:-}" ] && [[ $ref == *"$STUB_MISSING"* ]]; then
      exit 1
    fi
    if [[ $* == *"{{.Id}}"* ]]; then
      printf 'sha256:%s%s\n' "$(printf '%s' "$ref" | cksum | cut -d' ' -f1)" "${STUB_IMAGE_ID_SUFFIX:-}"
    elif [[ $* == *"--format"* ]]; then
      label_of "$ref"
    fi
    ;;
  compose)
    action=""
    for arg in "$@"; do
      if [ -n "$action" ]; then
        action_args="${action_args:+$action_args }$arg"
      elif [[ $arg == restow-* ]]; then
        action=$arg
        action_args=""
      fi
    done
    if [[ $* == *" exec "* ]]; then
      case $action in
        restow-restore-roles | restow-restore-db | restow-shift | restow-swap | restow-tar-extract)
          printf 'stdin %s %s: %s\n' "$action" "$action_args" "$(head -n 1)" >>"$STUB_CALLS"
          ;;
      esac
      if [ "${STUB_EXEC_FAIL:-}" = "$action" ]; then
        echo "stub docker: $action failed" >&2
        exit 1
      fi
      case $action in
        restow-now) printf '%s\n' "${STUB_DB_NOW:-$(date +%s).250000}" ;;
        restow-size) echo 1048576 ;;
        restow-quiet) printf '%s\n' "${STUB_BUSY:-0}" ;;
        restow-dump) echo "PGDMP stub dump" ;;
        restow-roles) echo "CREATE ROLE restow_app;" ;;
        restow-du) echo 2048 ;;
        restow-tar-create) echo "tar of $action_args" ;;
      esac
    elif [[ $* == *"config --images"* ]]; then
      echo "postgres:16-alpine"
      image_var RESTOW_DEMO_APP_IMAGE restow-demo-app:local
      image_var RESTOW_DEMO_WEB_IMAGE restow-demo-web:local
      image_var RESTOW_DEMO_SEED_IMAGE restow-demo-seed:local
      image_var RESTOW_DEMO_DOVECOT_IMAGE restow-demo-dovecot:local
    elif [[ $* == *"config --format json web"* ]]; then
      if [[ $* == *"docker-compose.override.public.yml"* ]]; then
        echo '{"ports": [{"mode": "ingress", "target": 80, "published": "80"}, {"target": 443, "published": "443"}]}'
      else
        echo '{"ports": [{"host_ip": "172.17.0.1", "target": 80, "published": "8081"}]}'
      fi
    elif [[ $* == *" up "* ]]; then
      files=""
      previous=""
      for arg in "$@"; do
        if [ "$previous" = "-f" ]; then
          files="$files ${arg##*/}"
        fi
        previous=$arg
      done
      printf 'files-at-up%s\n' "$files" >>"$STUB_CALLS"
      # What a container would be created from: the image variables compose sees now.
      {
        printf 'images-at-up app=%s web=%s seed=%s dovecot=%s\n' \
          "$(image_var RESTOW_DEMO_APP_IMAGE restow-demo-app:local)" \
          "$(image_var RESTOW_DEMO_WEB_IMAGE restow-demo-web:local)" \
          "$(image_var RESTOW_DEMO_SEED_IMAGE restow-demo-seed:local)" \
          "$(image_var RESTOW_DEMO_DOVECOT_IMAGE restow-demo-dovecot:local)"
      } >>"$STUB_CALLS"
    fi
    ;;
  *)
    echo "stub docker: unexpected call: $*" >&2
    exit 99
    ;;
esac
STUB
chmod +x "$STUB_BIN/docker"

# `df -Pk <dir>` with STUB_DF_AVAIL_KB free, else the real one.
cat >"$STUB_BIN/df" <<'STUB'
#!/usr/bin/env bash
if [ -n "${STUB_DF_AVAIL_KB:-}" ]; then
  echo "Filesystem 1024-blocks Used Available Capacity Mounted on"
  echo "/dev/stub 100000000 1 ${STUB_DF_AVAIL_KB} 1% /"
  exit 0
fi
exec /bin/df "$@"
STUB
chmod +x "$STUB_BIN/df"

# A minimal env file of the demo; the test adds what it needs.
new_env() {
  local file="$TMP_ROOT/env.$RANDOM$RANDOM"
  {
    echo "RESTOW_DEMO_COMPOSE_FILES=docker-compose.yml"
    echo "POSTGRES_PASSWORD=test"
    for line in "$@"; do
      printf '%s\n' "$line"
    done
  } >"$file"
  printf '%s' "$file"
}

# run_reset <env file> [VAR=value ...]: runs reset.sh with the stub; sets STATUS, CALLS
# and LOG. The variables a test passes reach the script and the stub. Templates go to
# $TEMPLATES when a test sets it, else to a fresh directory of their own.
TEMPLATES=""
run_reset() {
  local env_file=$1
  shift
  local calls="$TMP_ROOT/calls.$RANDOM$RANDOM" log="$TMP_ROOT/log.$RANDOM$RANDOM"
  local templates=${TEMPLATES:-$TMP_ROOT/templates.$RANDOM$RANDOM}
  : >"$calls"
  env -u RESTOW_DEMO_FOLLOW -u RESTOW_DEMO_FOLLOW_REGISTRY \
    -u RESTOW_DEMO_APP_IMAGE -u RESTOW_DEMO_WEB_IMAGE \
    -u RESTOW_DEMO_SEED_IMAGE -u RESTOW_DEMO_DOVECOT_IMAGE \
    -u RESTOW_DEMO_COMPOSE_FILES -u RESTOW_DEMO_PUBLISH_PUBLIC \
    -u RESTOW_DEMO_TEMPLATES -u RESTOW_DEMO_TEMPLATE_MAX_AGE_DAYS \
    -u RESTOW_DEMO_TEMPLATE_MIN_FREE_MB -u RESTOW_DEMO_TEMPLATE_QUIET_SECONDS \
    PATH="$STUB_BIN:$PATH" \
    STUB_CALLS="$calls" STUB_ENV_FILE="$env_file" \
    RESTOW_DEMO_ENV_FILE="$env_file" RESTOW_DEMO_RESET_LOG="$log" \
    RESTOW_DEMO_TEMPLATE_DIR="$templates" \
    "$@" sh "$RESET" >/dev/null 2>&1
  STATUS=$?
  CALLS=$(cat "$calls")
  LOG=$(cat "$log" 2>/dev/null)
}

GHCR=ghcr.io/restow-backup

# ---- Default mode: loaded images, nothing pulled -----------------------------------------

run_reset "$(new_env)"
assert_eq 0 "$STATUS" "default mode: the reset succeeds"
assert_not_contains "docker pull" "$CALLS" "default mode: nothing is pulled"
assert_contains "compose" "$CALLS" "default mode: compose runs"
assert_contains "images-at-up app=restow-demo-app:local web=restow-demo-web:local seed=restow-demo-seed:local dovecot=restow-demo-dovecot:local" \
  "$CALLS" "default mode: the loaded demo images"
assert_contains "reset complete" "$LOG" "default mode: logged as complete"
assert_not_contains "follow mode" "$LOG" "default mode: no follow mode in the log"
assert_not_contains "now runs Restow" "$LOG" "default mode: no followed version claimed"

# An empty RESTOW_DEMO_FOLLOW (as .env.example ships it) is the default mode.
run_reset "$(new_env "RESTOW_DEMO_FOLLOW=")"
assert_eq 0 "$STATUS" "empty RESTOW_DEMO_FOLLOW: the reset succeeds"
assert_not_contains "docker pull" "$CALLS" "empty RESTOW_DEMO_FOLLOW: nothing is pulled"

# A missing loaded image still stops the default mode before anything is torn down.
run_reset "$(new_env)" STUB_MISSING=restow-demo-seed:local
assert_eq 1 "$STATUS" "default mode, missing image: the reset fails"
assert_not_contains "down --volumes" "$CALLS" "default mode, missing image: nothing torn down"
assert_contains "missing images: restow-demo-seed:local" "$LOG" "default mode, missing image: logged"

# ---- Follow mode: a channel ---------------------------------------------------------------

run_reset "$(new_env "RESTOW_DEMO_FOLLOW=beta")"
assert_eq 0 "$STATUS" "follow beta: the reset succeeds"
assert_contains "docker pull --quiet $GHCR/restow-demo-seed:beta" "$CALLS" "follow beta: the channel is looked up on the seed image"
for ref in restow:0.4.3 restow-web:0.4.3 restow-demo-seed:0.4.3 restow-demo-dovecot:0.4.3; do
  assert_contains "docker pull --quiet $GHCR/$ref" "$CALLS" "follow beta: pulls $ref by its exact version"
done
assert_not_contains "restow:beta" "$CALLS" "follow beta: the moving tag is never pulled for the application image"
assert_not_contains "restow-web:beta" "$CALLS" "follow beta: the moving tag is never pulled for the web image"
assert_not_contains "docker tag" "$CALLS" "follow beta: nothing is re-tagged"
assert_not_contains "restow:local" "$CALLS" "follow beta: production image names are not touched"
assert_before "docker pull --quiet $GHCR/restow-demo-seed:beta" "docker pull --quiet $GHCR/restow:0.4.3" "$CALLS" \
  "follow beta: the channel is resolved first"
assert_before "docker pull --quiet $GHCR/restow-demo-dovecot:0.4.3" "down --volumes" "$CALLS" \
  "follow beta: every pull happens before the project is torn down"
assert_contains "images-at-up app=$GHCR/restow:0.4.3 web=$GHCR/restow-web:0.4.3 seed=$GHCR/restow-demo-seed:0.4.3 dovecot=$GHCR/restow-demo-dovecot:0.4.3" \
  "$CALLS" "follow beta: compose runs the pulled release by its exact version"
assert_contains "follow mode: beta is Restow 0.4.3" "$LOG" "follow beta: the release is logged"
assert_contains "reset complete; the demo now runs Restow 0.4.3 (following beta)" "$LOG" "follow beta: the version is logged at the end"

# The setting may come from the environment too (it wins over .env), quoted values work.
run_reset "$(new_env "RESTOW_DEMO_FOLLOW=0.4.1")" RESTOW_DEMO_FOLLOW=latest
assert_eq 0 "$STATUS" "environment wins: the reset succeeds"
assert_contains "docker pull --quiet $GHCR/restow-demo-seed:latest" "$CALLS" "environment wins: latest is looked up"
assert_not_contains "0.4.1" "$CALLS" "environment wins: the .env value is not used"

run_reset "$(new_env 'RESTOW_DEMO_FOLLOW="beta"')"
assert_eq 0 "$STATUS" "quoted value: the reset succeeds"
assert_contains "docker pull --quiet $GHCR/restow-demo-seed:beta" "$CALLS" "quoted value: the quotes are not part of the tag"

# Image variables in .env do not win over follow mode.
run_reset "$(new_env "RESTOW_DEMO_FOLLOW=beta" "RESTOW_DEMO_APP_IMAGE=restow:local" "RESTOW_DEMO_WEB_IMAGE=restow-web:local")"
assert_eq 0 "$STATUS" "follow with image variables in .env: the reset succeeds"
assert_contains "images-at-up app=$GHCR/restow:0.4.3 web=$GHCR/restow-web:0.4.3" "$CALLS" \
  "follow with image variables in .env: the followed release is used"

# Another registry.
run_reset "$(new_env "RESTOW_DEMO_FOLLOW=beta" "RESTOW_DEMO_FOLLOW_REGISTRY=registry.example.org:5000/mirror/restow-backup")"
assert_eq 0 "$STATUS" "own registry: the reset succeeds"
assert_contains "docker pull --quiet registry.example.org:5000/mirror/restow-backup/restow:0.4.3" "$CALLS" "own registry: pulled from there"
assert_not_contains "ghcr.io" "$CALLS" "own registry: ghcr.io is not asked"

# ---- Follow mode: an exact version ---------------------------------------------------------

run_reset "$(new_env "RESTOW_DEMO_FOLLOW=0.4.2")" STUB_VERSION=0.4.2
assert_eq 0 "$STATUS" "follow 0.4.2: the reset succeeds"
assert_contains "images-at-up app=$GHCR/restow:0.4.2" "$CALLS" "follow 0.4.2: that release runs"
assert_contains "now runs Restow 0.4.2 (following 0.4.2)" "$LOG" "follow 0.4.2: logged"

run_reset "$(new_env "RESTOW_DEMO_FOLLOW=0.4.2")" STUB_VERSION=0.4.3
assert_eq 1 "$STATUS" "follow 0.4.2, image says 0.4.3: refused"
assert_not_contains "down --volumes" "$CALLS" "follow 0.4.2, image says 0.4.3: nothing torn down"
assert_contains "says it is 0.4.3" "$LOG" "follow 0.4.2, image says 0.4.3: logged"

# ---- Follow mode: failures leave the running demo alone ------------------------------------

for broken in restow-demo-seed:beta restow:0.4.3 restow-web:0.4.3 restow-demo-dovecot:0.4.3; do
  run_reset "$(new_env "RESTOW_DEMO_FOLLOW=beta")" STUB_PULL_FAIL="$broken"
  assert_eq 1 "$STATUS" "pull of $broken fails: the reset fails"
  assert_not_contains "compose" "$CALLS" "pull of $broken fails: compose is not even asked"
  assert_contains "could not pull $GHCR/$broken; nothing was stopped" "$LOG" "pull of $broken fails: logged"
  assert_not_contains "reset complete" "$LOG" "pull of $broken fails: not complete"
done

# A mix of releases is refused, whichever image is the odd one out.
for odd in restow:0.4.3 restow-web:0.4.3 restow-demo-dovecot:0.4.3; do
  run_reset "$(new_env "RESTOW_DEMO_FOLLOW=beta")" STUB_REF_1="$odd" STUB_VERSION_1=0.4.2
  assert_eq 1 "$STATUS" "$odd is 0.4.2: refused"
  assert_not_contains "down --volumes" "$CALLS" "$odd is 0.4.2: nothing torn down"
  assert_contains "the images are not all release 0.4.3: $GHCR/$odd=0.4.2; nothing was stopped" "$LOG" "$odd is 0.4.2: logged"
done

# An image without a version label (a local build pushed by hand) counts as a mix too.
run_reset "$(new_env "RESTOW_DEMO_FOLLOW=beta")" STUB_REF_1=restow-web:0.4.3 STUB_VERSION_1=
assert_eq 1 "$STATUS" "web without a version label: refused"
assert_contains "$GHCR/restow-web:0.4.3=none" "$LOG" "web without a version label: logged"

# The channel's seed image must name a release.
run_reset "$(new_env "RESTOW_DEMO_FOLLOW=beta")" STUB_VERSION=
assert_eq 1 "$STATUS" "seed without a version label: refused"
assert_not_contains "restow:" "$CALLS" "seed without a version label: nothing else is pulled"
assert_contains "carries no release version" "$LOG" "seed without a version label: logged"

for label in '0.4.3;x' $'0.4.3\n0.4.4' 'v0.4.3'; do
  run_reset "$(new_env "RESTOW_DEMO_FOLLOW=beta")" STUB_VERSION="$label"
  assert_eq 1 "$STATUS" "seed with the version label [$label]: refused"
  assert_contains "carries no release version" "$LOG" "seed with the version label [$label]: logged"
done

# Settings that are not a tag or a registry path are refused before anything is pulled.
for value in 'beta;reboot' 'be ta' '-beta' 'ghcr.io/x/restow:beta' $'beta\nlatest'; do
  run_reset "$(new_env)" RESTOW_DEMO_FOLLOW="$value"
  assert_eq 1 "$STATUS" "RESTOW_DEMO_FOLLOW=$value: refused"
  assert_not_contains "docker" "$CALLS" "RESTOW_DEMO_FOLLOW=$value: docker is not asked"
  assert_contains "is not a tag" "$LOG" "RESTOW_DEMO_FOLLOW=$value: logged"
done
for value in 'GHCR.io/x' 'ghcr.io/x;y' 'ghcr.io/x/'; do
  run_reset "$(new_env "RESTOW_DEMO_FOLLOW=beta")" RESTOW_DEMO_FOLLOW_REGISTRY="$value"
  assert_eq 1 "$STATUS" "RESTOW_DEMO_FOLLOW_REGISTRY=$value: refused"
  assert_not_contains "docker" "$CALLS" "RESTOW_DEMO_FOLLOW_REGISTRY=$value: docker is not asked"
done

# A missing env file stops follow mode as well, before anything is pulled.
run_reset "$TMP_ROOT/no-such-env" RESTOW_DEMO_FOLLOW=beta
assert_eq 1 "$STATUS" "missing env file: refused"
assert_not_contains "docker" "$CALLS" "missing env file: docker is not asked"

# ---- Fast reset: templates ---------------------------------------------------------------

# template_dirs: the names of the saved templates, sorted, one line.
template_dirs() {
  local dir names=""
  for dir in "$TEMPLATES"/*; do
    if [ -f "$dir/meta" ]; then
      names="$names ${dir##*/}"
    fi
  done
  printf '%s' "${names# }"
}
NOW=$(date +%s)

TEMPLATES="$TMP_ROOT/templates-fast"
ENV_FAST=$(new_env)

# The first reset seeds and saves a template.
run_reset "$ENV_FAST" STUB_DB_NOW="$((NOW - 300)).5"
assert_eq 0 "$STATUS" "first reset: succeeds"
assert_contains "run --rm --pull never seed" "$CALLS" "first reset: seeds"
FIRST=$(template_dirs)
assert_contains "0.4.3-" "$FIRST" "first reset: a template of release 0.4.3 is saved"
assert_eq "PGDMP stub dump" "$(cat "$TEMPLATES/$FIRST/database.dump")" "first reset: the database dump is saved"
assert_eq "CREATE ROLE restow_app;" "$(cat "$TEMPLATES/$FIRST/roles.sql")" "first reset: the roles are saved"
for volume in demo-data demo-mail demo-agents; do
  assert_eq "tar of $volume" "$(cat "$TEMPLATES/$FIRST/$volume.tar")" "first reset: volume $volume is saved"
done
assert_contains "taken_epoch=$((NOW - 300)).5" "$(cat "$TEMPLATES/$FIRST/meta")" "first reset: the database's clock is the template's time"
assert_contains "key=$FIRST" "$(cat "$TEMPLATES/$FIRST/meta")" "first reset: the meta file names its key"
assert_eq "$TEMPLATES" "$(find "$TEMPLATES" -maxdepth 0 -perm 0700)" "first reset: the template directory is private"
assert_eq "$TEMPLATES/$FIRST/database.dump" "$(find "$TEMPLATES/$FIRST/database.dump" -perm 0600)" "first reset: the dump is private"
assert_before "run --rm --pull never seed" "--profile template up -d --no-build --pull never --no-deps template" "$CALLS" \
  "first reset: the template container starts after the seed"
assert_before "--profile template up -d --no-build --pull never --no-deps template" "stop api worker" "$CALLS" \
  "first reset: the template container holds the volumes before api and worker stop"
assert_before "stop scheduler" "restow-quiet" "$CALLS" "first reset: the scheduler stops before the wait for quiet"
assert_before "restow-quiet" "stop api worker" "$CALLS" "first reset: api and worker stop once nothing runs"
assert_before "stop api worker" "restow-dump" "$CALLS" "first reset: the dump is taken of a stopped installation"
assert_before "restow-tar-create demo-agents" "up -d --no-build --pull never --wait api worker scheduler" "$CALLS" \
  "first reset: api, worker and scheduler start again after the template"
assert_before "up -d --no-build --pull never --wait api worker scheduler" "rm --stop --force template" "$CALLS" \
  "first reset: the template container goes once the services hold the volumes again"
assert_before "rm --stop --force template" "--wait web" "$CALLS" "first reset: web starts last"
assert_contains "template $FIRST saved" "$LOG" "first reset: logged"
assert_contains "seeded from scratch; the demo was offline for" "$LOG" "first reset: the time offline is logged"

# The second reset restores it instead of seeding.
run_reset "$ENV_FAST"
assert_eq 0 "$STATUS" "restore: succeeds"
assert_not_contains "run --rm --pull never seed" "$CALLS" "restore: no seed"
assert_not_contains "restow-dump" "$CALLS" "restore: no new template"
assert_contains 'stdin restow-restore-roles : DO $restow$ BEGIN CREATE ROLE restow_app; EXCEPTION WHEN duplicate_object THEN NULL; END $restow$;' \
  "$CALLS" "restore: the roles are restored, where missing"
assert_contains "stdin restow-restore-db : PGDMP stub dump" "$CALLS" "restore: the dump is restored"
assert_contains "stdin restow-shift $((NOW - 300)).5: -- Restow public demo: make a restored template look as fresh as a new seed" \
  "$CALLS" "restore: the time shift runs with the template's time"
assert_contains "stdin restow-tar-extract demo-data -m: tar of demo-data" "$CALLS" \
  "restore: the storage gets the time of the restore as its files' time"
assert_contains "stdin restow-tar-extract demo-mail: tar of demo-mail" "$CALLS" "restore: the mail keeps its files' times"
assert_contains "stdin restow-tar-extract demo-agents: tar of demo-agents" "$CALLS" "restore: the agent logins are restored"
assert_contains "stdin restow-swap : -- deploy/demo/reset.sh: the restored database (<db>_next) becomes the demo's." \
  "$CALLS" "restore: the restored database replaces the demo's"
assert_not_contains "down --volumes" "$CALLS" "restore: nothing torn down (postgres and Caddy keep running)"
assert_before "--wait postgres" "restow-restore-roles" "$CALLS" "restore: postgres runs first"
assert_before "restow-restore-roles" "restow-restore-db" "$CALLS" "restore: roles before the database"
assert_before "restow-restore-db" "restow-shift" "$CALLS" "restore: the shift after the database"
assert_before "restow-shift" "stop --timeout 10 web agent-sim api worker scheduler dovecot" "$CALLS" \
  "restore: database and shift are ready before the demo goes offline"
assert_before "stop --timeout 10 web agent-sim api worker scheduler dovecot" "restow-swap" "$CALLS" \
  "restore: the database is replaced once the services are stopped"
assert_before "restow-swap" "--profile template up -d --no-build --pull never --no-deps template" "$CALLS" \
  "restore: then the template container"
assert_before "--no-deps template" "restow-tar-extract demo-data" "$CALLS" "restore: the template container holds the volumes"
assert_before "restow-tar-extract demo-agents" "--wait dovecot api worker scheduler" "$CALLS" "restore: the volumes before the services"
assert_before "--wait dovecot api worker scheduler" "rm --stop --force template" "$CALLS" \
  "restore: the template container goes once the services hold the volumes"
assert_before "restow-drop-old" "restow-restore-db" "$CALLS" "restore: a leftover old database goes first"
LAST_DROP=$(printf '%s\n' "$CALLS" | grep -nF restow-drop-old | tail -n 1 | cut -d: -f1)
HOLDER_GONE=$(printf '%s\n' "$CALLS" | grep -nF "rm --stop --force template" | head -n 1 | cut -d: -f1)
if [ "${LAST_DROP:-0}" -gt "${HOLDER_GONE:-0}" ] && [ "$(printf '%s\n' "$CALLS" | grep -cF restow-drop-old)" -eq 2 ]; then
  pass
else
  fail "restore: the old database goes once the services run (drop at line ${LAST_DROP:-none}, services up by line ${HOLDER_GONE:-none})"
fi
assert_before "rm --stop --force template" "--wait web" "$CALLS" "restore: web starts last"
assert_contains "restored from template $FIRST; the demo was offline for" "$LOG" "restore: logged"
assert_contains "reset complete" "$LOG" "restore: complete"

# A changed .env (a password, the demo account, a seed setting) needs a new seed.
run_reset "$(new_env "RESTOW_DEMO_HISTORY_DAYS=14")" STUB_DB_NOW="$((NOW - 200))"
assert_contains "run --rm --pull never seed" "$CALLS" "changed .env: seeds"
assert_contains "no template for 0.4.3-" "$LOG" "changed .env: logged"

# A new release needs a new seed; the template of the old one stays (two are kept).
TEMPLATES="$TMP_ROOT/templates-versions"
run_reset "$ENV_FAST" STUB_DB_NOW="$((NOW - 300))"
V1=$(template_dirs)
run_reset "$ENV_FAST" STUB_VERSION=0.4.4 STUB_DB_NOW="$((NOW - 200))"
assert_contains "run --rm --pull never seed" "$CALLS" "new release: seeds"
assert_contains "0.4.4-" "$(template_dirs)" "new release: its template is saved"
assert_contains "$V1" "$(template_dirs)" "new release: the previous template is kept"
V2=$(template_dirs | tr ' ' '\n' | grep '^0.4.4-')
# Rebuilt images of the same release are new images.
run_reset "$ENV_FAST" STUB_VERSION=0.4.4 STUB_IMAGE_ID_SUFFIX=rebuilt STUB_DB_NOW="$((NOW - 100))"
assert_contains "run --rm --pull never seed" "$CALLS" "rebuilt images: seed"
assert_eq 2 "$(template_dirs | wc -w | tr -d ' ')" "rebuilt images: two templates are kept"
assert_not_contains "$V1" "$(template_dirs)" "rebuilt images: the oldest template is removed"
assert_contains "$V2" "$(template_dirs)" "rebuilt images: the one before stays"
assert_contains "removed the older template $V1" "$LOG" "rebuilt images: the removal is logged"
# And back to the images before: the template kept for them is restored.
run_reset "$ENV_FAST" STUB_VERSION=0.4.4
assert_not_contains "run --rm --pull never seed" "$CALLS" "back to the kept template: restored"
assert_contains "restored from template $V2" "$LOG" "back to the kept template: logged"

# A template older than RESTOW_DEMO_TEMPLATE_MAX_AGE_DAYS (default 7) is not restored.
TEMPLATES="$TMP_ROOT/templates-old"
run_reset "$ENV_FAST" STUB_DB_NOW="$((NOW - 8 * 86400))"
OLD=$(template_dirs)
run_reset "$ENV_FAST" RESTOW_DEMO_TEMPLATE_MAX_AGE_DAYS=10
assert_not_contains "run --rm --pull never seed" "$CALLS" "8 days old, 10 allowed: restored"
assert_contains "stdin restow-shift $((NOW - 8 * 86400)):" "$CALLS" "8 days old, 10 allowed: shifted by its age"
run_reset "$ENV_FAST" STUB_DB_NOW="$NOW"
assert_contains "run --rm --pull never seed" "$CALLS" "8 days old: seeds"
assert_contains "template $OLD is 8 days old, older than RESTOW_DEMO_TEMPLATE_MAX_AGE_DAYS=7" "$LOG" "8 days old: logged"
assert_contains "template $OLD saved" "$LOG" "8 days old: replaced by a new one"
assert_contains "taken_epoch=$NOW" "$(cat "$TEMPLATES/$OLD/meta")" "8 days old: the new one is of today"
assert_eq "$OLD" "$(template_dirs)" "8 days old: one template, not two"
run_reset "$ENV_FAST" RESTOW_DEMO_TEMPLATE_MAX_AGE_DAYS=0
assert_contains "run --rm --pull never seed" "$CALLS" "max age 0: always seeds"

# An incomplete template is not restored.
TEMPLATES="$TMP_ROOT/templates-incomplete"
run_reset "$ENV_FAST"
: >"$TEMPLATES/$(template_dirs)/demo-mail.tar"
run_reset "$ENV_FAST"
assert_contains "run --rm --pull never seed" "$CALLS" "incomplete template: seeds"
assert_contains "has no demo-mail.tar" "$LOG" "incomplete template: logged"

# A restore that fails seeds from scratch: the demo still comes up, with a new template.
for step in restow-restore-roles restow-restore-db restow-shift restow-swap restow-tar-extract; do
  TEMPLATES="$TMP_ROOT/templates-fail-$step"
  run_reset "$ENV_FAST"
  BROKEN=$(template_dirs)
  run_reset "$ENV_FAST" STUB_EXEC_FAIL="$step"
  assert_eq 0 "$STATUS" "$step fails: the reset still succeeds"
  assert_before "$step" "run --rm --pull never seed" "$CALLS" "$step fails: seeds after it"
  assert_contains "restoring template $BROKEN failed; removing it and seeding from scratch" "$LOG" "$step fails: logged"
  assert_contains "template $BROKEN saved" "$LOG" "$step fails: a new template is saved"
  assert_contains "--wait web" "$CALLS" "$step fails: web starts"
done

# Not enough free space: no template, the demo runs anyway.
TEMPLATES="$TMP_ROOT/templates-full"
run_reset "$ENV_FAST" STUB_DF_AVAIL_KB=500000
assert_eq 0 "$STATUS" "no space: the reset succeeds"
assert_eq "" "$(template_dirs)" "no space: no template"
assert_not_contains "restow-dump" "$CALLS" "no space: nothing dumped"
assert_contains "not enough free space" "$LOG" "no space: logged"
assert_contains "RESTOW_DEMO_TEMPLATE_MIN_FREE_MB=1024" "$LOG" "no space: names the setting"
assert_before "not enough free space" "starting api, worker and scheduler again" "$LOG" "no space: the services come back"
assert_contains "--wait web" "$CALLS" "no space: web starts"
run_reset "$ENV_FAST" STUB_DF_AVAIL_KB=500000 RESTOW_DEMO_TEMPLATE_MIN_FREE_MB=100
assert_contains "saved" "$LOG" "no space, smaller reserve: saved"

# Jobs that do not finish: no template of a busy demo.
TEMPLATES="$TMP_ROOT/templates-busy"
run_reset "$ENV_FAST" STUB_BUSY=2 RESTOW_DEMO_TEMPLATE_QUIET_SECONDS=0
assert_eq 0 "$STATUS" "busy: the reset succeeds"
assert_eq "" "$(template_dirs)" "busy: no template"
assert_not_contains "stop api worker" "$CALLS" "busy: api and worker keep running"
assert_contains "2 jobs or machine runs still going" "$LOG" "busy: logged"

# Templates off.
TEMPLATES="$TMP_ROOT/templates-off"
run_reset "$(new_env "RESTOW_DEMO_TEMPLATES=false")"
assert_eq 0 "$STATUS" "templates off: the reset succeeds"
assert_not_contains "--no-deps template" "$CALLS" "templates off: no template container"
assert_eq "" "$(template_dirs)" "templates off: no template"
assert_contains "templates are off" "$LOG" "templates off: logged"

for setting in RESTOW_DEMO_TEMPLATES=yes RESTOW_DEMO_TEMPLATE_MAX_AGE_DAYS=7d RESTOW_DEMO_TEMPLATE_MIN_FREE_MB=-1; do
  run_reset "$(new_env "$setting")"
  assert_eq 1 "$STATUS" "$setting: refused"
  assert_not_contains "docker" "$CALLS" "$setting: docker is not asked"
done

# Follow mode: the template is the followed release's.
TEMPLATES="$TMP_ROOT/templates-follow"
run_reset "$(new_env "RESTOW_DEMO_FOLLOW=beta")" STUB_VERSION=0.4.5
assert_contains "0.4.5-" "$(template_dirs)" "follow: the template is named after the followed release"
TEMPLATES=""

# ---- Compose files ------------------------------------------------------------------------

run_reset "$(new_env)"
assert_contains "compose files: docker-compose.yml (from " "$LOG" "compose files: the .env value is logged"
assert_contains "files-at-up docker-compose.yml"$'\n' "$CALLS"$'\n' "compose files: the base file alone"

run_reset "$(new_env)" RESTOW_DEMO_COMPOSE_FILES=docker-compose.yml:docker-compose.override.public.yml
assert_eq 0 "$STATUS" "public override from the environment: the reset succeeds"
assert_contains "files-at-up docker-compose.yml docker-compose.override.public.yml" "$CALLS" "public override from the environment: used, as before"
assert_contains "(from the environment)" "$LOG" "public override from the environment: logged"

# The public override in .env: never read before, so it needs a confirmation now.
PUBLIC_LINE=RESTOW_DEMO_COMPOSE_FILES=docker-compose.yml:docker-compose.override.public.yml
run_reset "$(new_env "$PUBLIC_LINE")"
assert_eq 0 "$STATUS" "public override in .env alone: the reset succeeds"
assert_not_contains "files-at-up docker-compose.yml docker-compose.override.public.yml" "$CALLS" \
  "public override in .env alone: 80/443 are not published"
assert_contains "files-at-up docker-compose.yml" "$CALLS" "public override in .env alone: the base file as before"
assert_contains "would publish web on every interface" "$LOG" "public override in .env alone: logged"
assert_contains "RESTOW_DEMO_PUBLISH_PUBLIC=true" "$LOG" "public override in .env alone: says how to confirm"

run_reset "$(new_env "$PUBLIC_LINE" "RESTOW_DEMO_PUBLISH_PUBLIC=true")"
assert_eq 0 "$STATUS" "public override in .env, confirmed: the reset succeeds"
assert_contains "files-at-up docker-compose.yml docker-compose.override.public.yml" "$CALLS" "public override in .env, confirmed: used"
assert_contains "compose files: docker-compose.yml:docker-compose.override.public.yml (from " "$LOG" "public override in .env, confirmed: logged"

# A list without the public override is used from .env as it is.
run_reset "$(new_env "RESTOW_DEMO_COMPOSE_FILES=docker-compose.yml:docker-compose.yml")"
assert_contains "compose files: docker-compose.yml:docker-compose.yml (from " "$LOG" "other list in .env: used"

for value in ../docker-compose.yml /etc/passwd missing.yml 'docker-compose.yml:sub/../../x.yml'; do
  run_reset "$(new_env "RESTOW_DEMO_COMPOSE_FILES=$value")"
  assert_eq 1 "$STATUS" "RESTOW_DEMO_COMPOSE_FILES=$value: refused"
  assert_not_contains "down" "$CALLS" "RESTOW_DEMO_COMPOSE_FILES=$value: nothing stopped"
  assert_contains "is not a compose file" "$LOG" "RESTOW_DEMO_COMPOSE_FILES=$value: logged"
done

printf 'deploy/demo/test.sh: %d passed, %d failed\n' "$PASSED" "$FAILED"
[ "$FAILED" -eq 0 ]
