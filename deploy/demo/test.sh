#!/usr/bin/env bash
# Tests of deploy/demo/reset.sh without Docker, network or a demo host: whole runs of
# the script against a stub `docker` that records every call, answers the image
# inspections from the test's settings and fails a pull when told to. Covers the
# default mode (loaded images, no registry at all) and follow mode (README,
# "Following the releases"): what is pulled and in which order, that nothing is
# stopped before every image is there and of one release, and what compose is
# finally pointed at.
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
# `compose config --images` prints the images the compose file would resolve: the
# RESTOW_DEMO_*_IMAGE variables of the environment, else those of the env file, else
# the defaults of docker-compose.yml, as docker compose does.

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
    if [[ $* == *"--format"* ]]; then
      label_of "$ref"
    fi
    ;;
  compose)
    if [[ $* == *"config --images"* ]]; then
      echo "postgres:16-alpine"
      image_var RESTOW_DEMO_APP_IMAGE restow-demo-app:local
      image_var RESTOW_DEMO_WEB_IMAGE restow-demo-web:local
      image_var RESTOW_DEMO_SEED_IMAGE restow-demo-seed:local
      image_var RESTOW_DEMO_DOVECOT_IMAGE restow-demo-dovecot:local
    elif [[ $* == *"config --format json web"* ]]; then
      echo '{"ports": [{"host_ip": "172.17.0.1", "target": 80, "published": "8081"}]}'
    elif [[ $* == *" up "* ]]; then
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
# and LOG. The variables a test passes reach the script and the stub.
run_reset() {
  local env_file=$1
  shift
  local calls="$TMP_ROOT/calls.$RANDOM$RANDOM" log="$TMP_ROOT/log.$RANDOM$RANDOM"
  : >"$calls"
  env -u RESTOW_DEMO_FOLLOW -u RESTOW_DEMO_FOLLOW_REGISTRY \
    -u RESTOW_DEMO_APP_IMAGE -u RESTOW_DEMO_WEB_IMAGE \
    -u RESTOW_DEMO_SEED_IMAGE -u RESTOW_DEMO_DOVECOT_IMAGE \
    PATH="$STUB_BIN:$PATH" \
    STUB_CALLS="$calls" STUB_ENV_FILE="$env_file" \
    RESTOW_DEMO_ENV_FILE="$env_file" RESTOW_DEMO_RESET_LOG="$log" \
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

printf 'deploy/demo/test.sh: %d passed, %d failed\n' "$PASSED" "$FAILED"
[ "$FAILED" -eq 0 ]
