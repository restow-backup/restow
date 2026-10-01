#!/usr/bin/env bash
# Tests of deploy/install/install.sh without root, Docker or network: the pure functions
# (options, preflight decisions, domains, checksums, image names), the generated .env
# (secrets, file mode, nothing overwritten, nothing in the log) and whole dry runs of
# main against stub commands (docker, curl, ss, systemd-detect-virt, ...) that record
# every call and fail on anything that would change the host.
#
#   bash deploy/install/test.sh
#
# Runs with bash 3.2 (macOS) and bash 5 (Linux CI). The VM tests that run the real
# installation are a separate, manual step (docs/CI.md, "Server install script").
# shellcheck disable=SC2016,SC2030,SC2031 # stub scripts and bash -c programs expand at run time; PATH and the options change only inside the subshells of single tests
set -uo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)

# shellcheck source=install.sh
. "$HERE/install.sh"
# install.sh switches on errexit; the tests check every result themselves.
set +eE
trap - ERR

PASSED=0
FAILED=0
TEMP_BASE=${TMPDIR:-/tmp}
TMP_ROOT=$(mktemp -d "${TEMP_BASE%/}/restow-install-test.XXXXXX")
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
    *"$1"*) fail "$3: [$1] must not appear" ;;
    *) pass ;;
  esac
}
# assert_status <expected> <name> <command...>: runs the command in a subshell with the
# installer's shell options.
assert_status() {
  local want=$1 name=$2 got
  shift 2
  (
    set -Eeuo pipefail
    "$@"
  ) >/dev/null 2>&1
  got=$?
  assert_eq "$want" "$got" "$name"
}
file_mode() {
  if stat -c '%a' "$1" >/dev/null 2>&1; then
    stat -c '%a' "$1"
  else
    stat -f '%Lp' "$1"
  fi
}

# ---- Options ---------------------------------------------------------------------------

parsed() {
  (
    set -Eeuo pipefail
    parse_args "$@"
    printf '%s|%s|%s|%s|%s|%s|%s|%s|%s|%s' "$OPT_DOMAIN" "$OPT_EDITION" "$OPT_VERSION" "$OPT_DIR" \
      "$OPT_YES" "$OPT_DRY_RUN" "$OPT_SKIP_SIGNATURES" "$OPT_LOCAL" "$OPT_UPDATER" "$ACTION"
  ) 2>/dev/null
}

assert_eq "|||/opt/restow|0|0|0|0|0|install" "$(parsed)" "defaults"
assert_eq "backup.example.com|community|0.2.0|/srv/restow|1|1|1|0|1|install" \
  "$(parsed --domain HTTPS://Backup.Example.com/ --edition Community --version v0.2.0 --dir /srv/restow/ --yes --dry-run --skip-signature-check --with-updater)" \
  "options are read and normalized"
assert_eq "backup.example.com|full|0.1.1|/opt/rs|1|0|0|0|0|install" \
  "$(parsed --domain=backup.example.com --edition=full --version=0.1.1 --dir=/opt/rs --non-interactive)" \
  "--option=value form"
assert_eq "restow.internal|||/opt/restow|0|0|0|1|0|install" "$(parsed --local --domain restow.internal)" "--local with an internal name"
assert_eq "restow.internal|||/opt/restow|0|0|0|1|0|install" "$(parsed --http-local --domain restow.internal)" "--http-local still works (deprecated alias)"
assert_contains "--http-local is deprecated, use --local" "$( (parse_args --http-local) 2>&1)" "the alias prints a notice"
assert_not_contains "deprecated" "$( (parse_args --local) 2>&1)" "--local prints no notice"
assert_eq "help" "$(parsed --help | cut -d '|' -f 10)" "--help"
assert_eq "upgrade" "$(parsed --upgrade | cut -d '|' -f 10)" "--upgrade"
assert_eq "0" "$(parsed --with-updater --no-updater | cut -d '|' -f 9)" "--no-updater wins when last"
assert_status 2 "--uninstall is refused" parse_args --uninstall
assert_status 2 "unknown option" parse_args --frobnicate
assert_status 2 "--domain without value" parse_args --domain
assert_status 2 "--domain followed by an option" parse_args --domain --yes
assert_status 2 "--domain= empty" parse_args --domain=
assert_status 2 "invalid edition" parse_args --edition enterprise
assert_status 2 "invalid version" parse_args --version 0.1
assert_status 2 "relative dir" parse_args --dir restow
assert_status 2 "system dir" parse_args --dir /etc
assert_status 2 "dir with .." parse_args --dir /opt/../etc/restow
assert_status 2 "dir with a space" parse_args --dir "/opt/my restow"
assert_status 2 "IP as domain" parse_args --domain 192.0.2.10
assert_status 2 "single label domain" parse_args --domain restow
assert_status 2 "internal name without --local" parse_args --domain restow.internal
assert_status 2 "public domain with --local" parse_args --local --domain backup.example.com
assert_status 0 "pre-release version" parse_args --version 0.2.0-rc.1

# ---- Pure helpers ------------------------------------------------------------------------

assert_eq "public" "$(domain_kind backup.example.com)" "domain_kind public"
assert_eq "internal" "$(domain_kind localhost)" "domain_kind localhost"
assert_eq "internal" "$(domain_kind restow.home.arpa)" "domain_kind home.arpa"
assert_eq "internal" "$(domain_kind app.localhost)" "domain_kind .localhost"
assert_eq "ip" "$(domain_kind 10.0.0.1)" "domain_kind IPv4"
assert_eq "ip" "$(domain_kind '[::1]')" "domain_kind IPv6"
assert_eq "invalid" "$(domain_kind 'bad_name.example.com')" "domain_kind underscore"
assert_eq "invalid" "$(domain_kind '-x.example.com')" "domain_kind leading hyphen"
assert_eq "single" "$(domain_kind restow)" "domain_kind single label"
assert_eq "backup.example.com" "$(normalize_domain 'https://BACKUP.example.com./path')" "normalize_domain"

assert_status 0 "Debian 12" os_supported debian 12
assert_status 0 "Debian 13" os_supported debian 13
assert_status 0 "Ubuntu 22.04" os_supported ubuntu 22.04
assert_status 0 "Ubuntu 24.04" os_supported ubuntu 24.04
assert_status 0 "Ubuntu 26.04" os_supported ubuntu 26.04
assert_status 1 "Ubuntu 25.10 (no LTS)" os_supported ubuntu 25.10
assert_eq "bookworm trixie jammy noble resolute" \
  "$(supported_codename debian 12) $(supported_codename debian 13) $(supported_codename ubuntu 22.04) $(supported_codename ubuntu 24.04) $(supported_codename ubuntu 26.04)" \
  "codenames of Docker's repository suites"
assert_status 1 "Debian 11" os_supported debian 11
assert_status 1 "Ubuntu 20.04" os_supported ubuntu 20.04
assert_status 1 "Fedora" os_supported fedora 40

assert_eq "amd64" "$(normalize_arch x86_64)" "x86_64"
assert_eq "arm64" "$(normalize_arch aarch64)" "aarch64"
assert_eq "arm64" "$(normalize_arch arm64)" "arm64"
assert_eq "" "$(normalize_arch armv7l)" "armv7l unsupported"

assert_eq "ok" "$(virt_verdict none)" "no container"
assert_eq "warn" "$(virt_verdict lxc)" "LXC is best effort"
assert_eq "warn" "$(virt_verdict openvz)" "OpenVZ is best effort"
assert_eq "fail" "$(virt_verdict docker)" "inside Docker"
assert_eq "fail" "$(virt_verdict wsl)" "WSL"

assert_eq "fail" "$(level_verdict 2097152 "$MIN_MEMORY_KIB" "$RECOMMENDED_MEMORY_KIB")" "2 GiB memory"
assert_eq "warn" "$(level_verdict 4005000 "$MIN_MEMORY_KIB" "$RECOMMENDED_MEMORY_KIB")" "4 GiB VM memory"
assert_eq "ok" "$(level_verdict 8050000 "$MIN_MEMORY_KIB" "$RECOMMENDED_MEMORY_KIB")" "8 GiB VM memory"
assert_eq "fail" "$(level_verdict "" 1 2)" "unknown value fails"
assert_eq "fail" "$(level_verdict "12x" 1 2)" "non-numeric value fails"

assert_status 0 "27.5.1 >= 24.0" version_ge 27.5.1 24.0
assert_status 0 "24.0.7 >= 24.0" version_ge 24.0.7 24.0
assert_status 1 "20.10.24+dfsg1 < 24.0" version_ge 20.10.24+dfsg1 24.0
assert_status 0 "v2.29.7 >= 2.20" version_ge v2.29.7 2.20
assert_status 1 "2.19.1 < 2.20" version_ge 2.19.1 2.20
assert_status 1 "empty < 24.0" version_ge "" 24.0

ss_output='LISTEN 0 4096 0.0.0.0:22 0.0.0.0:*
LISTEN 0 4096 [::]:443 [::]:*
LISTEN 0 4096 127.0.0.53%lo:53 0.0.0.0:*
LISTEN 0 4096 *:8080 *:*'
assert_eq "443" "$(busy_ports "$ss_output" 80 443)" "busy_ports finds 443 on IPv6"
assert_eq "" "$(busy_ports "LISTEN 0 4096 0.0.0.0:8443 0.0.0.0:*" 80 443)" "busy_ports ignores other ports"

assert_eq "match" "$(dns_verdict "203.0.113.10 2001:db8::1" "127.0.0.1 203.0.113.10 ::1")" "DNS points here"
assert_eq "nomatch" "$(dns_verdict "198.51.100.7" "127.0.0.1 10.0.0.5")" "DNS points elsewhere (NAT)"
assert_eq "loopback" "$(dns_verdict "127.0.1.1" "127.0.0.1 10.0.0.5")" "DNS only via /etc/hosts"
assert_eq "unresolved" "$(dns_verdict " " "10.0.0.5")" "DNS unresolved"

assert_eq "fresh" "$(existing_verdict 0 "" "" /opt/restow)" "nothing there"
assert_eq "resume" "$(existing_verdict 1 "restow_pgdata " "/opt/restow " /opt/restow)" "our installation"
assert_eq "resume" "$(existing_verdict 1 "" "" /opt/restow)" ".env only (interrupted before start)"
assert_eq "conflict-data" "$(existing_verdict 0 "restow_pgdata " "" /opt/restow)" "volumes without .env"
assert_eq "conflict-data" "$(existing_verdict 0 "" "/opt/restow " /opt/restow)" "containers without .env"
assert_eq "conflict-dir" "$(existing_verdict 1 "" "/srv/restow " /opt/restow)" "installation elsewhere"

assert_eq "restow restow-web" "$(image_names full)" "full build images"
assert_eq "restow-community restow-web-community" "$(image_names community)" "Community build images"
assert_eq "ghcr.io/restow-backup/restow" "$(image_repository ghcr.io/restow-backup/restow:0.1.0)" "image_repository"
assert_eq "localhost:5000/restow-backup/restow" "$(image_repository localhost:5000/restow-backup/restow:0.1.0@sha256:abc)" "image_repository with port and digest"
assert_eq "0.1.0" "$(image_tag ghcr.io/restow-backup/restow:0.1.0)" "image_tag"
assert_eq "" "$(image_tag localhost:5000/restow-backup/restow)" "image_tag without tag"
assert_eq "community" "$(edition_of_image ghcr.io/restow-backup/restow-community:0.1.0)" "edition of a Community image"
assert_eq "full" "$(edition_of_image ghcr.io/restow-backup/restow:0.1.0)" "edition of a full image"
assert_eq "https://github.com/restow-backup/restow/.github/workflows/release.yml@refs/tags/v0.1.0" \
  "$(signer_identity 0.1.0)" "signer identity (docs/UPDATING.md)"
assert_eq "https://github.com/restow-backup/restow/releases/download/v0.1.0" "$(release_base_url 0.1.0)" "release URL"
assert_eq "http://192.0.2.5:8000/rel/v0.1.0" "$(RESTOW_INSTALL_RELEASE_URL=http://192.0.2.5:8000/rel/ release_base_url 0.1.0)" "release URL override"
assert_eq "ghcr.io/restow-backup" "$(image_prefix)" "image prefix"

sums="$TMP_ROOT/SHA256SUMS"
good=$(printf '%064d' 0 | tr 0 a)
other=$(printf '%064d' 0 | tr 0 b)
printf '%s  docker-compose.yml\n%s *env.example\n%s  dup\n%s  dup\nxyz  short\n' "$good" "$other" "$good" "$good" >"$sums"
assert_eq "$good" "$(sums_lookup "$sums" docker-compose.yml)" "sums_lookup"
assert_eq "$other" "$(sums_lookup "$sums" env.example)" "sums_lookup binary marker"
assert_status 1 "sums_lookup missing name" sums_lookup "$sums" install.sh
assert_status 1 "sums_lookup duplicate name" sums_lookup "$sums" dup
assert_status 1 "sums_lookup malformed checksum" sums_lookup "$sums" short

osr="$TMP_ROOT/os-release"
printf 'PRETTY_NAME="Ubuntu 24.04.1 LTS"\nID=ubuntu\nVERSION_ID="24.04"\nVERSION_CODENAME=noble\nID_LIKE=debian\n' >"$osr"
assert_eq "ubuntu|24.04|noble|Ubuntu 24.04.1 LTS" \
  "$(os_release_value "$osr" ID)|$(os_release_value "$osr" VERSION_ID)|$(os_release_value "$osr" VERSION_CODENAME)|$(os_release_value "$osr" PRETTY_NAME)" \
  "os-release is read without running it"

printf 'PRETTY_NAME="Debian GNU/Linux 12"\nID=debian\nVERSION_ID="12"\nVERSION_CODENAME=trixie\n' >"$TMP_ROOT/os-mismatch"
mismatch=$(
  OS_RELEASE_FILE="$TMP_ROOT/os-mismatch"
  check_os 2>&1
  printf '|%s|%s' "$OS_CODENAME" "$PREFLIGHT_FAILED"
)
assert_contains "names the codename trixie, expected bookworm" "$mismatch" "a codename that does not fit the release is reported"
assert_contains "|bookworm|0" "$mismatch" "Docker's suite follows the supported release"

# The cosign image is the one the opt-in updater verifies with.
updater_cosign=$(awk '/export const DEFAULT_COSIGN_IMAGE/ { getline; gsub(/[ ";]/, ""); print }' "$REPO/apps/api/src/updater/signature.ts" 2>/dev/null)
if [ -n "$updater_cosign" ]; then
  assert_eq "$updater_cosign" "$COSIGN_IMAGE" "cosign image pinned like the updater's"
fi
assert_contains "@sha256:" "$COSIGN_IMAGE" "cosign image pinned by digest"
assert_not_contains "set -x" "$(grep -v '^ *#' "$HERE/install.sh")" "no xtrace in the installer"

# ---- .env ------------------------------------------------------------------------------

env_fixture() {
  local dir=$1
  mkdir -p "$dir"
  cp "$REPO/deploy/release/.env.example" "$dir/env.example"
}

dir1="$TMP_ROOT/install1"
env_fixture "$dir1"
log="$TMP_ROOT/install1.log"
: >"$log"
(
  set -Eeuo pipefail
  OPT_DIR=$dir1 OPT_UPDATER=0 LOG_FILE=$log LOG_READY=1
  APP_IMAGE=ghcr.io/restow-backup/restow:0.1.0 WEB_IMAGE=ghcr.io/restow-backup/restow-web:0.1.0
  DOMAIN=backup.example.com PUBLIC_URL=https://backup.example.com
  write_env
  # What the next step shows once; the test compares it with the file.
  printf '%s' "$MASTER_KEY_ONCE" >"$TMP_ROOT/master1"
) >"$TMP_ROOT/write1.out" 2>&1
assert_eq 0 "$?" "write_env succeeds"
env1="$dir1/.env"
assert_eq "600" "$(file_mode "$env1")" ".env mode 0600"
assert_eq "ghcr.io/restow-backup/restow:0.1.0" "$(env_get "$env1" RESTOW_IMAGE)" "RESTOW_IMAGE"
assert_eq "ghcr.io/restow-backup/restow-web:0.1.0" "$(env_get "$env1" RESTOW_WEB_IMAGE)" "RESTOW_WEB_IMAGE"
assert_eq "https://backup.example.com" "$(env_get "$env1" RESTOW_PUBLIC_URL)" "RESTOW_PUBLIC_URL"
assert_eq "backup.example.com" "$(env_get "$env1" RESTOW_APP_DOMAIN)" "RESTOW_APP_DOMAIN"
assert_eq "$dir1" "$(env_get "$env1" RESTOW_PROJECT_DIR)" "RESTOW_PROJECT_DIR"
assert_eq "" "$(env_get "$env1" RESTOW_UPDATER_IMAGE)" "updater image stays empty without --with-updater"
assert_eq "local" "$(env_get "$env1" STORAGE_TARGET)" "template values kept"
# shellcheck disable=SC2086 # a list of key names
assert_eq "" "$(env_missing_keys "$env1" $REQUIRED_ENV_NAMES)" "every required key set"
pg=$(env_get "$env1" POSTGRES_PASSWORD)
master=$(env_get "$env1" RESTOW_MASTER_KEY)
auth=$(env_get "$env1" BETTER_AUTH_SECRET)
app_url=$(env_get "$env1" DATABASE_URL)
provider_url=$(env_get "$env1" DATABASE_PROVIDER_URL)
assert_status 0 "database password: 32 hex" bash -c '[[ $1 =~ ^[0-9a-f]{32}$ ]]' _ "$pg"
assert_status 0 "master key: 32 bytes base64" bash -c '[[ $1 =~ ^[A-Za-z0-9+/]{43}=$ ]]' _ "$master"
assert_status 0 "auth secret: 32 bytes base64" bash -c '[[ $1 =~ ^[A-Za-z0-9+/]{43}=$ ]]' _ "$auth"
assert_eq "postgres://restow:${pg}@postgres:5432/restow" "$(env_get "$env1" DATABASE_MIGRATION_URL)" "migration URL uses POSTGRES_PASSWORD"
assert_contains "postgres://restow_app:" "$app_url" "application role URL"
assert_contains "postgres://restow_provider:" "$provider_url" "installation role URL"
app_pw=${app_url#postgres://restow_app:}
app_pw=${app_pw%%@*}
provider_pw=${provider_url#postgres://restow_provider:}
provider_pw=${provider_pw%%@*}
if [ "$pg" != "$app_pw" ] && [ "$app_pw" != "$provider_pw" ] && [ "$pg" != "$provider_pw" ] && [ "$master" != "$auth" ]; then
  pass
else
  fail "the generated secrets must differ from each other"
fi
assert_eq "$master" "$(cat "$TMP_ROOT/master1")" "the key shown once is the key in .env"
# Every line that is not one of the set keys is the template's, unchanged and in order.
# shellcheck disable=SC2086 # a list of key names
set_keys_re="^($(printf '%s|' $REQUIRED_ENV_NAMES RESTOW_PROJECT_DIR | sed 's/|$//'))="
assert_eq "$(grep -v -E "$set_keys_re" "$dir1/env.example")" "$(grep -v -E "$set_keys_re" "$env1")" "the rest of env.example is kept"
assert_eq "$(wc -l <"$dir1/env.example")" "$(wc -l <"$env1")" "no line added or lost"
log_and_output="$(cat "$log" "$TMP_ROOT/write1.out")"
for secret in "$pg" "$app_pw" "$provider_pw" "$master" "$auth"; do
  assert_not_contains "$secret" "$log_and_output" "no secret in the log or the output"
done
assert_eq "" "$(find "$dir1" -name '.env.install.*')" "no temporary file left"

# A second run never overwrites .env.
before=$(sha256_of "$env1")
assert_status 8 "write_env refuses an existing .env" bash -c '
  . "$1"; set +eE; trap - ERR
  OPT_DIR=$2 APP_IMAGE=a:1 WEB_IMAGE=b:1 DOMAIN=x.example.com PUBLIC_URL=https://x.example.com
  set -Eeuo pipefail
  write_env' _ "$HERE/install.sh" "$dir1"
assert_eq "$before" "$(sha256_of "$env1")" ".env unchanged after a second run"

# Fresh secrets every time; the updater image only with --with-updater; keys the template
# lacks are appended.
dir2="$TMP_ROOT/install2"
env_fixture "$dir2"
grep -v '^RESTOW_PROJECT_DIR=' "$dir2/env.example" >"$dir2/env.tmp" && mv "$dir2/env.tmp" "$dir2/env.example"
(
  set -Eeuo pipefail
  OPT_DIR=$dir2 OPT_UPDATER=1
  APP_IMAGE=ghcr.io/restow-backup/restow-community:0.1.0 WEB_IMAGE=ghcr.io/restow-backup/restow-web-community:0.1.0
  DOMAIN=backup.example.com PUBLIC_URL=https://backup.example.com
  write_env
) >/dev/null 2>&1
assert_eq 0 "$?" "write_env with the updater"
assert_eq "ghcr.io/restow-backup/restow-community:0.1.0" "$(env_get "$dir2/.env" RESTOW_UPDATER_IMAGE)" "updater image = the application image of the same build"
assert_eq "$dir2" "$(env_get "$dir2/.env" RESTOW_PROJECT_DIR)" "a key the template lacks is appended"
if [ "$(env_get "$dir2/.env" POSTGRES_PASSWORD)" != "$pg" ] && [ "$(env_get "$dir2/.env" RESTOW_MASTER_KEY)" != "$master" ]; then
  pass
else
  fail "two installations must not share secrets"
fi

# The master key is not printed in a non-interactive run.
shown=$(
  OPT_DIR=$dir1 INTERACTIVE=0 MASTER_KEY_ONCE=$master
  show_master_key 2>&1
)
assert_not_contains "$master" "$shown" "non-interactive run does not print the master key"
assert_contains "grep '^RESTOW_MASTER_KEY=' $dir1/.env" "$shown" "non-interactive run says where the key is"

# ---- The checksum and signature gates, against a stateful docker stub ----------------------

GATE_STUBS="$TMP_ROOT/gate-stubs"
GATE_STATE="$TMP_ROOT/gate-state"
GATE_LOG="$TMP_ROOT/gate-calls.log"
mkdir -p "$GATE_STUBS" "$GATE_STATE"
export GATE_STATE GATE_LOG
DIGEST="sha256:$(printf '%064d' 0 | tr 0 c)"
export DIGEST
cat >"$GATE_STUBS/docker" <<'STUB'
#!/bin/sh
echo "docker $*" >>"$GATE_LOG"
case "$1 $2" in
  "image inspect")
    if [ "$3" = --format ]; then
      [ -f "$GATE_STATE/digest" ] && echo "ghcr.io/restow-backup/restow@$DIGEST"
      exit 0
    fi
    [ -f "$GATE_STATE/present" ]
    exit $?
    ;;
  "image rm") rm -f "$GATE_STATE/present" "$GATE_STATE/digest"; exit 0 ;;
esac
case "$1" in
  pull) touch "$GATE_STATE/present" "$GATE_STATE/digest"; exit 0 ;;
  run) exit "${STUB_COSIGN_EXIT:-0}" ;;
esac
exit 1
STUB
chmod 755 "$GATE_STUBS/docker"

# gate <state: none|pulled|local> <command...>: runs it with the stub and a fresh state.
GATE_OUT=""
GATE_STATUS=0
gate() {
  rm -f "$GATE_STATE"/* "$GATE_LOG"
  : >"$GATE_LOG"
  case $1 in
    pulled) touch "$GATE_STATE/present" "$GATE_STATE/digest" ;;
    local) touch "$GATE_STATE/present" ;;
  esac
  shift
  GATE_OUT=$(
    PATH="$GATE_STUBS:$PATH"
    set -Eeuo pipefail
    "$@" 2>&1
  )
  GATE_STATUS=$?
}
REF=ghcr.io/restow-backup/restow:0.1.0
IDENTITY="--certificate-identity https://github.com/restow-backup/restow/.github/workflows/release.yml@refs/tags/v0.1.0"

gate none pull_and_verify "$REF"
assert_eq 0 "$GATE_STATUS" "signed image: accepted"
assert_contains "docker pull $REF" "$(cat "$GATE_LOG")" "missing image is pulled"
assert_contains "$COSIGN_IMAGE verify $IDENTITY --certificate-oidc-issuer https://token.actions.githubusercontent.com ghcr.io/restow-backup/restow@$DIGEST" \
  "$(cat "$GATE_LOG")" "the pulled digest is verified for exactly this release"
assert_contains "--read-only" "$(cat "$GATE_LOG")" "cosign runs read-only"
assert_contains "--cap-drop ALL" "$(cat "$GATE_LOG")" "cosign runs without capabilities"

STUB_COSIGN_EXIT=1 gate none pull_and_verify "$REF"
assert_eq 6 "$GATE_STATUS" "unsigned image: refused with exit code 6"
assert_contains "docker image rm $REF" "$(cat "$GATE_LOG")" "unsigned image is removed again"
assert_contains "carries no valid signature" "$GATE_OUT" "unsigned image message"

gate pulled pull_and_verify "$REF"
assert_eq 0 "$GATE_STATUS" "image here already: verified, not pulled"
assert_not_contains "docker pull" "$(cat "$GATE_LOG")" "an image that is here is not pulled again"

gate local pull_and_verify "$REF"
assert_eq 6 "$GATE_STATUS" "local image without registry digest: refused"
assert_not_contains "docker run" "$(cat "$GATE_LOG")" "no cosign without a digest"

OPT_SKIP_SIGNATURES=1 gate local pull_and_verify "$REF"
assert_eq 0 "$GATE_STATUS" "--skip-signature-check accepts a local image"
assert_contains "NOT checking the signature" "$GATE_OUT" "and says so"

gate none pull_and_verify "localhost:5000/restow-backup/restow"
assert_eq 6 "$GATE_STATUS" "image without a version tag: refused"

# Release files: SHA256SUMS signature first, then the checksums.
stage_release() {
  WORK="$TMP_ROOT/work-$1"
  mkdir -p "$WORK/release"
  printf 'services: {}\n' >"$WORK/release/docker-compose.yml"
  printf 'RESTOW_IMAGE=\n' >"$WORK/release/env.example"
  (cd "$WORK/release" && for f in docker-compose.yml env.example; do printf '%s  %s\n' "$(sha256_of "$f")" "$f"; done >SHA256SUMS)
  printf '{}' >"$WORK/release/SHA256SUMS.sigstore.json"
}
stage_release good
VERSION=0.1.0 WORK="$TMP_ROOT/work-good" gate none verify_release_files
assert_eq 0 "$GATE_STATUS" "signed and matching release files: accepted"
assert_contains "verify-blob --bundle /release/SHA256SUMS.sigstore.json $IDENTITY" "$(cat "$GATE_LOG")" "SHA256SUMS signature checked for this release"
assert_contains "$TMP_ROOT/work-good/release:/release:ro" "$(cat "$GATE_LOG")" "release files mounted read-only"

STUB_COSIGN_EXIT=1 VERSION=0.1.0 WORK="$TMP_ROOT/work-good" gate none verify_release_files
assert_eq 5 "$GATE_STATUS" "unsigned SHA256SUMS: refused with exit code 5"

stage_release tampered
printf 'services: {evil: {}}\n' >"$TMP_ROOT/work-tampered/release/docker-compose.yml"
VERSION=0.1.0 WORK="$TMP_ROOT/work-tampered" gate none verify_release_files
assert_eq 5 "$GATE_STATUS" "tampered docker-compose.yml: refused with exit code 5"
assert_contains "docker-compose.yml does not match SHA256SUMS" "$GATE_OUT" "tampered file message"

OPT_SKIP_SIGNATURES=1 VERSION=0.1.0 WORK="$TMP_ROOT/work-tampered" gate none verify_release_files
assert_eq 5 "$GATE_STATUS" "--skip-signature-check still checks the checksums"
WORK=""

# ---- apt on a new VM: another apt run (apt-daily, unattended-upgrades) holds its locks -------

APT_STUBS="$TMP_ROOT/apt-stubs"
APT_LOG="$TMP_ROOT/apt-calls.log"
APT_COUNT="$TMP_ROOT/apt-count"
mkdir -p "$APT_STUBS"
export APT_LOG APT_COUNT
# apt-get fails STUB_APT_FAILURES times (a held lock), then succeeds.
cat >"$APT_STUBS/apt-get" <<'STUB'
#!/bin/sh
echo "apt-get $*" >>"$APT_LOG"
n=$(($(cat "$APT_COUNT" 2>/dev/null || echo 0) + 1))
echo "$n" >"$APT_COUNT"
[ "$n" -gt "${STUB_APT_FAILURES:-0}" ]
STUB
chmod 755 "$APT_STUBS/apt-get"

# apt_try <failures before success> <command...>: runs it with the stub, without pauses.
APT_OUT=""
APT_STATUS=0
apt_try() {
  rm -f "$APT_COUNT"
  : >"$APT_LOG"
  APT_OUT=$(
    PATH="$APT_STUBS:$PATH"
    STUB_APT_FAILURES=$1
    export STUB_APT_FAILURES
    APT_UPDATE_PAUSE=0
    shift
    set -Eeuo pipefail
    "$@" 2>&1
  )
  APT_STATUS=$?
}

apt_try 0 apt_get install gpg
assert_eq 0 "$APT_STATUS" "apt_get runs apt-get"
assert_contains "-o DPkg::Lock::Timeout=600" "$(cat "$APT_LOG")" "apt-get waits for the dpkg lock of another apt run"

apt_try 2 apt_update
assert_eq 0 "$APT_STATUS" "apt-get update held up twice: tried again, then done"
assert_eq 3 "$(grep -c ' update$' "$APT_LOG")" "apt-get update ran three times"
assert_contains "apt-get update failed (attempt 1 of 12; another apt run may hold its lock), trying again" "$APT_OUT" "the retry is shown"

apt_try 99 apt_update
assert_eq 1 "$APT_STATUS" "apt-get update failing for good: gives up"
assert_eq 12 "$(grep -c ' update$' "$APT_LOG")" "apt-get update gives up after 12 attempts"

# ---- Dry runs of main against stub commands ------------------------------------------------

STUBS="$TMP_ROOT/stubs"
STUB_LOG="$TMP_ROOT/stub-calls.log"
mkdir -p "$STUBS"
export STUB_LOG

stub() {
  printf '#!/bin/sh\n%s\n' "$2" >"$STUBS/$1"
  chmod 755 "$STUBS/$1"
}
# Read-only answers; anything that would change the host is recorded as MUTATING.
stub docker '
echo "docker $*" >>"$STUB_LOG"
case "$*" in
  "info --format {{.DockerRootDir}}") echo /var/lib/docker ;;
  info) exit 0 ;;
  "version --format {{.Server.Version}}") echo "${STUB_DOCKER_VERSION:-27.5.1}" ;;
  "compose version --short") echo 2.29.7 ;;
  "volume ls -q") printf "%s" "${STUB_VOLUMES:-}" | tr " " "\n" ;;
  "ps -a --filter"*) printf "%s" "${STUB_PROJECT_DIRS:-}" | tr " " "\n" ;;
  "image inspect"*) exit 1 ;;
  *) echo "MUTATING docker $*" >>"$STUB_LOG"; exit 1 ;;
esac'
stub systemd-detect-virt '
case "$1" in
  --container) echo "${STUB_CONTAINER:-none}"; [ "${STUB_CONTAINER:-none}" != none ] ;;
  --vm) echo kvm ;;
esac'
stub timedatectl 'echo yes'
stub curl '
echo "curl $*" >>"$STUB_LOG"
for arg in "$@"; do
  case "$arg" in -o) out=1 ;; *) if [ "${out:-}" = 1 ] && [ "$arg" != /dev/null ]; then echo "MUTATING curl $*" >>"$STUB_LOG"; exit 1; fi; out=0 ;; esac
done
printf 200'
stub ss 'printf "%s\n" "${STUB_SS:-LISTEN 0 4096 0.0.0.0:22 0.0.0.0:*}"'
stub getent 'echo "203.0.113.10    STREAM backup.example.com"'
stub ip 'echo "2: eth0    inet 203.0.113.10/24 brd 203.0.113.255 scope global eth0"'
stub df 'printf "Filesystem 1024-blocks Used Available Capacity Mounted\n/dev/vda1 104857600 1048576 %s 2%% /\n" "${STUB_DF_AVAIL:-94371840}"'
stub dpkg-query 'exit 1'
for command in apt-get systemctl gpg install ln chmod; do
  stub "$command" "echo \"MUTATING $command \$*\" >>\"\$STUB_LOG\"; exit 1"
done

os_fixture() {
  case $1 in
    debian12) printf 'PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\nID=debian\nVERSION_ID="12"\nVERSION_CODENAME=bookworm\n' ;;
    debian13) printf 'PRETTY_NAME="Debian GNU/Linux 13 (trixie)"\nID=debian\nVERSION_ID="13"\nVERSION_CODENAME=trixie\n' ;;
    ubuntu2004) printf 'PRETTY_NAME="Ubuntu 20.04.6 LTS"\nID=ubuntu\nVERSION_ID="20.04"\nVERSION_CODENAME=focal\n' ;;
    ubuntu2604) printf 'PRETTY_NAME="Ubuntu 26.04 LTS"\nID=ubuntu\nVERSION_ID="26.04"\nVERSION_CODENAME=resolute\nUBUNTU_CODENAME=resolute\n' ;;
  esac >"$TMP_ROOT/os-$1"
  printf '%s' "$TMP_ROOT/os-$1"
}
mem_fixture() {
  printf 'MemTotal:       %s kB\nMemFree:         1000000 kB\n' "$1" >"$TMP_ROOT/meminfo-$1"
  printf '%s' "$TMP_ROOT/meminfo-$1"
}
OS_DEBIAN12=$(os_fixture debian12)
OS_DEBIAN13=$(os_fixture debian13)
OS_UBUNTU2004=$(os_fixture ubuntu2004)
OS_UBUNTU2604=$(os_fixture ubuntu2604)
MEM_8G=$(mem_fixture 8100000)
MEM_2G=$(mem_fixture 2000000)

DRY_OUT=""
DRY_STATUS=0
# dry_main <os-release> <meminfo> <main arguments...>; environment STUB_* shapes the stubs.
dry_main() {
  local os=$1 mem=$2
  shift 2
  : >"$STUB_LOG"
  DRY_OUT=$(
    PATH="$STUBS:$PATH"
    OS_RELEASE_FILE=$os
    MEMINFO_FILE=$mem
    if [ -n "${STUB_DOCKER_MISSING:-}" ]; then
      docker_state() { echo missing; }
    fi
    set -Eeuo pipefail
    main --dry-run "$@" 2>&1
  )
  DRY_STATUS=$?
}
no_mutation() {
  assert_not_contains "MUTATING" "$(cat "$STUB_LOG")" "$1: nothing on the host changed"
}

dir3="$TMP_ROOT/fresh"
dry_main "$OS_DEBIAN12" "$MEM_8G" --non-interactive --domain backup.example.com --dir "$dir3"
assert_eq 0 "$DRY_STATUS" "fresh dry run exits 0"
assert_contains "Debian GNU/Linux 12 (bookworm)" "$DRY_OUT" "fresh dry run: OS"
assert_contains "virtual machine (kvm)" "$DRY_OUT" "fresh dry run: VM"
assert_contains "backup.example.com resolves to this host" "$DRY_OUT" "fresh dry run: DNS"
assert_contains "ports 80 and 443 are free" "$DRY_OUT" "fresh dry run: ports"
assert_contains "ghcr.io/restow-backup/restow:0.1.0" "$DRY_OUT" "fresh dry run: full build image"
assert_contains "would download SHA256SUMS, SHA256SUMS.sigstore.json, docker-compose.yml and env.example from https://github.com/restow-backup/restow/releases/download/v0.1.0" "$DRY_OUT" "fresh dry run: release files"
assert_contains "signer: https://github.com/restow-backup/restow/.github/workflows/release.yml@refs/tags/v0.1.0" "$DRY_OUT" "fresh dry run: signer"
assert_contains "would write $dir3/.env" "$DRY_OUT" "fresh dry run: .env"
assert_contains "would run: docker pull $COSIGN_IMAGE" "$DRY_OUT" "fresh dry run: cosign"
assert_contains "would run: docker compose up -d" "$DRY_OUT" "fresh dry run: start"
assert_contains "Dry run finished: nothing was changed." "$DRY_OUT" "fresh dry run: end"
assert_status 1 "fresh dry run: no directory created" test -e "$dir3"
no_mutation "fresh dry run"

dry_main "$OS_DEBIAN13" "$MEM_8G" --non-interactive --edition community --dir "$dir3" --domain backup.example.com --skip-signature-check --with-updater
assert_eq 0 "$DRY_STATUS" "Community dry run exits 0"
assert_contains "ghcr.io/restow-backup/restow-community:0.1.0" "$DRY_OUT" "Community dry run: image"
assert_contains "ghcr.io/restow-backup/restow-web-community:0.1.0" "$DRY_OUT" "Community dry run: web image"
assert_contains "--skip-signature-check: the cosign signatures" "$DRY_OUT" "loud warning for --skip-signature-check"
assert_contains "NOT check the signature" "$DRY_OUT" "signatures skipped"
assert_not_contains "docker pull $COSIGN_IMAGE" "$DRY_OUT" "no cosign without signature checks"
assert_contains "would run: docker compose --profile updater up -d" "$DRY_OUT" "updater started on request"
no_mutation "Community dry run"

STUB_DOCKER_MISSING=1 dry_main "$OS_DEBIAN12" "$MEM_8G" --yes --domain backup.example.com --dir "$dir3"
assert_eq 0 "$DRY_STATUS" "dry run without Docker exits 0"
assert_contains "would download https://download.docker.com/linux/debian/gpg and check its fingerprint $DOCKER_REPO_FINGERPRINT" "$DRY_OUT" "Docker from its apt repository"
assert_contains "bookworm stable" "$DRY_OUT" "Docker repository suite"
assert_not_contains "get.docker.com" "$DRY_OUT" "never get.docker.com"
no_mutation "dry run without Docker"

dry_main "$OS_DEBIAN12" "$MEM_8G" --yes --local --dir "$dir3"
assert_eq 0 "$DRY_STATUS" "evaluation dry run exits 0"
assert_contains "https://localhost (evaluation" "$DRY_OUT" "evaluation address"
assert_not_contains "resolves to this host" "$DRY_OUT" "no DNS check for an evaluation"

dry_main "$OS_DEBIAN12" "$MEM_8G" --yes --dir "$dir3"
assert_eq 0 "$DRY_STATUS" "dry run without --domain exits 0"
assert_contains "backup.example.com stands in for it" "$DRY_OUT" "placeholder domain in a dry run"
assert_not_contains "resolves to this host" "$DRY_OUT" "no DNS check for the placeholder"

STUB_CONTAINER=lxc dry_main "$OS_DEBIAN12" "$MEM_8G" --yes --domain backup.example.com --dir "$dir3"
assert_eq 0 "$DRY_STATUS" "LXC dry run continues"
assert_contains "LXC container. Docker in LXC is best effort" "$DRY_OUT" "LXC warning"
assert_contains "nesting=1, keyctl=1" "$DRY_OUT" "LXC warning names nesting and keyctl"

STUB_CONTAINER=docker dry_main "$OS_DEBIAN12" "$MEM_8G" --yes --domain backup.example.com --dir "$dir3"
assert_eq 3 "$DRY_STATUS" "inside a Docker container: preflight fails"

STUB_DOCKER_MISSING=1 dry_main "$OS_UBUNTU2604" "$MEM_8G" --yes --domain backup.example.com --dir "$dir3"
assert_eq 0 "$DRY_STATUS" "Ubuntu 26.04 dry run exits 0"
assert_contains "ok: Ubuntu 26.04 LTS" "$DRY_OUT" "Ubuntu 26.04 accepted"
assert_contains "https://download.docker.com/linux/ubuntu/gpg" "$DRY_OUT" "Ubuntu repository of Docker"
assert_contains "ubuntu resolute stable" "$DRY_OUT" "Docker repository suite for 26.04"
no_mutation "Ubuntu 26.04 dry run"

dry_main "$OS_UBUNTU2004" "$MEM_8G" --yes --domain backup.example.com --dir "$dir3"
assert_eq 3 "$DRY_STATUS" "Ubuntu 20.04: preflight fails"
assert_contains "unsupported operating system: Ubuntu 20.04.6 LTS" "$DRY_OUT" "unsupported OS message"
assert_contains "Ubuntu 22.04, 24.04 and 26.04" "$DRY_OUT" "the message lists the supported releases"

dry_main "$OS_DEBIAN12" "$MEM_2G" --yes --domain backup.example.com --dir "$dir3"
assert_eq 3 "$DRY_STATUS" "2 GiB memory: preflight fails"

STUB_DOCKER_VERSION=20.10.24 dry_main "$OS_DEBIAN12" "$MEM_8G" --yes --domain backup.example.com --dir "$dir3"
assert_eq 3 "$DRY_STATUS" "Docker 20.10: preflight fails"
assert_contains "Docker Engine 20.10.24 is too old" "$DRY_OUT" "old Docker message"

STUB_SS="LISTEN 0 511 0.0.0.0:80 0.0.0.0:*" dry_main "$OS_DEBIAN12" "$MEM_8G" --yes --domain backup.example.com --dir "$dir3"
assert_eq 3 "$DRY_STATUS" "port 80 in use: preflight fails"

STUB_DF_AVAIL=5000000 dry_main "$OS_DEBIAN12" "$MEM_8G" --yes --domain backup.example.com --dir "$dir3"
assert_eq 3 "$DRY_STATUS" "5 GiB free disk: preflight fails"

STUB_VOLUMES="restow_pgdata restow_caddy-data" dry_main "$OS_DEBIAN12" "$MEM_8G" --yes --domain backup.example.com --dir "$dir3"
assert_eq 8 "$DRY_STATUS" "data volumes without .env: refused"
assert_contains "restow_pgdata" "$DRY_OUT" "names the volume"

STUB_PROJECT_DIRS="/srv/other" dry_main "$OS_DEBIAN12" "$MEM_8G" --yes --domain backup.example.com --dir "$dir3"
assert_eq 8 "$DRY_STATUS" "an installation in another directory: refused"

# An existing installation (the .env of the unit test above): checked, never rewritten.
before=$(sha256_of "$env1")
cp "$REPO/deploy/release/docker-compose.yml" "$dir1/docker-compose.yml"
STUB_VOLUMES="restow_pgdata" STUB_PROJECT_DIRS="$dir1" dry_main "$OS_DEBIAN12" "$MEM_8G" --yes --dir "$dir1"
assert_eq 0 "$DRY_STATUS" "re-run on an installation exits 0"
assert_contains "Existing installation in $dir1" "$DRY_OUT" "re-run detects the installation"
assert_contains "would pull ghcr.io/restow-backup/restow:0.1.0" "$DRY_OUT" "re-run checks the images of .env"
assert_not_contains "would write" "$DRY_OUT" "re-run writes no .env"
assert_not_contains "compose pull postgres" "$DRY_OUT" "re-run does not pull PostgreSQL again"
assert_eq "$before" "$(sha256_of "$env1")" "re-run leaves .env unchanged"
no_mutation "re-run"

dry_main "$OS_DEBIAN12" "$MEM_8G" --yes --dir "$dir1" --version 0.2.0
assert_eq 8 "$DRY_STATUS" "re-run with another version: refused (no updates)"
assert_contains "docs/UPDATING.md" "$DRY_OUT" "points to docs/UPDATING.md"

dry_main "$OS_DEBIAN12" "$MEM_8G" --yes --dir "$dir1" --edition community
assert_eq 8 "$DRY_STATUS" "re-run with another build: refused"

printf '\n%s passed, %s failed\n' "$PASSED" "$FAILED"
[ "$FAILED" -eq 0 ]
