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
assert_eq "fail" "$(level_verdict 3145727 "$MIN_MEMORY_KIB" "$RECOMMENDED_MEMORY_KIB")" "just under 3 GiB memory"
assert_eq "warn" "$(level_verdict 3145728 "$MIN_MEMORY_KIB" "$RECOMMENDED_MEMORY_KIB")" "exactly 3 GiB memory"
assert_eq "warn" "$(level_verdict 3487712 "$MIN_MEMORY_KIB" "$RECOMMENDED_MEMORY_KIB")" "3.3 GiB visible memory only warns"

# The crash-kernel reservation (kdump, crashkernel= on the kernel command line): the kernel
# reports its size in bytes, and the memory is not part of MemTotal.
KDUMP_FILE="$TMP_ROOT/kexec-crash-size"
KDUMP_OTHER="$TMP_ROOT/kexec-crash-size-old"
KDUMP_NONE="$TMP_ROOT/kexec-crash-size-missing"
# reserved_with <file content or "-" for no file>: crash_reserved_kib against that file.
reserved_with() {
  rm -f "$KDUMP_FILE"
  if [ "$1" != "-" ]; then
    printf '%s' "$1" >"$KDUMP_FILE"
  fi
  KEXEC_CRASH_SIZE_FILES="$KDUMP_FILE" crash_reserved_kib
}
assert_eq "524288" "$(reserved_with "536870912
")" "512 MB reserved: 524288 KiB"
assert_eq "327680" "$(reserved_with "335544320")" "320 MB reserved without a newline"
assert_eq "524288" "$(reserved_with "0536870912")" "a leading zero is no octal number"
assert_eq "0" "$(reserved_with 0)" "nothing reserved"
assert_eq "0" "$(reserved_with -)" "no file"
assert_eq "0" "$(reserved_with "")" "empty file"
assert_eq "0" "$(reserved_with "unknown")" "text instead of a number"
assert_eq "0" "$(reserved_with "-5")" "negative number"
assert_eq "0" "$(reserved_with "99999999999999999999")" "a number too large to be a size"
printf '268435456\n' >"$KDUMP_OTHER"
printf '536870912\n' >"$KDUMP_FILE"
assert_eq "262144" "$(KEXEC_CRASH_SIZE_FILES="$KDUMP_OTHER $KDUMP_FILE" crash_reserved_kib)" "the first file wins"
assert_eq "524288" "$(KEXEC_CRASH_SIZE_FILES="$KDUMP_NONE $KDUMP_FILE" crash_reserved_kib)" "a missing first file falls back to the next"
assert_eq "0" "$(KEXEC_CRASH_SIZE_FILES="$KDUMP_NONE" crash_reserved_kib)" "no file at all"

# memcheck <MemTotal in kB> [<content of the crash size file>]: check_memory against
# fixtures; prints what it says and, last, the number of failed checks and warnings.
memcheck() {
  local meminfo="$TMP_ROOT/memcheck-meminfo" kexec="$TMP_ROOT/memcheck-kexec"
  if [ "$1" = - ]; then
    printf 'MemFree:         1000000 kB\n' >"$meminfo"
  else
    printf 'MemTotal:       %s kB\nMemFree:         1000000 kB\n' "$1" >"$meminfo"
  fi
  rm -f "$kexec"
  if [ $# -ge 2 ]; then
    printf '%s\n' "$2" >"$kexec"
  fi
  (
    MEMINFO_FILE=$meminfo
    KEXEC_CRASH_SIZE_FILES="$TMP_ROOT/memcheck-kexec-missing $kexec"
    PREFLIGHT_FAILED=0
    WARNINGS=0
    LOG_READY=0
    check_memory 2>&1
    printf 'failed=%s warnings=%s\n' "$PREFLIGHT_FAILED" "$WARNINGS"
  )
}

# A VM given 4 GiB with a 512 MB crash-kernel reservation shows 3.3 GiB: it warns, as any
# machine under 7 GiB does, and the installer goes on.
out=$(memcheck 3487712 536870912)
assert_contains "warning: memory 3.3 GiB visible (+0.5 GiB reserved for kdump): Restow runs, 8 GiB are recommended" "$out" "4 GiB VM with kdump warns"
assert_contains "IMPORT_PARSE_WORKERS=1" "$out" "4 GiB VM with kdump: the hint for small hosts"
assert_contains "failed=0 warnings=1" "$out" "4 GiB VM with kdump does not fail"
assert_not_contains "error:" "$out" "4 GiB VM with kdump: no error"
# The same 3.3 GiB without any reservation: the maintainer's report. It must not stop either.
out=$(memcheck 3487712)
assert_contains "warning: memory 3.3 GiB: Restow runs, 8 GiB are recommended" "$out" "3.3 GiB visible without a kdump file warns"
assert_contains "failed=0 warnings=1" "$out" "3.3 GiB visible without a kdump file does not fail"
assert_not_contains "kdump" "$out" "no kdump share is shown when nothing is reserved"
assert_eq "$out" "$(memcheck 3487712 0)" "a kdump file with 0 behaves as no file"
assert_eq "$out" "$(memcheck 3487712 "")" "an empty kdump file behaves as no file"
assert_eq "$out" "$(memcheck 3487712 "not a number")" "an unreadable kdump file behaves as no file"
# A 3 GiB VM shows 2.8 GiB; the reservation Ubuntu makes for it (320 MB) brings it to 3.1.
out=$(memcheck 2900000 335544320)
assert_contains "warning: memory 2.8 GiB visible (+0.3 GiB reserved for kdump)" "$out" "reservation lifts a 3 GiB VM over the limit"
assert_contains "failed=0 warnings=1" "$out" "3 GiB VM with kdump warns"
# Under 3 GiB, with or without kdump, the installer stops and says what to do.
out=$(memcheck 2621440)
assert_contains "error: memory 2.5 GiB: too little for Restow, which needs at least 4 GiB (8 GiB recommended)" "$out" "2.5 GiB fails"
assert_contains "hint: assign at least 4 GiB (8 GiB recommended) to the VM." "$out" "the hint names the size"
assert_contains '"Minimum memory" equal to "Memory"' "$out" "the hint names ballooning"
assert_contains "shut the VM down and start it again" "$out" "the hint says to restart the VM"
assert_contains "free -h" "$out" "the hint names free -h"
assert_contains "failed=1 warnings=0" "$out" "2.5 GiB counts as one failed check"
out=$(memcheck 2000000 335544320)
assert_contains "error: memory 1.9 GiB visible (+0.3 GiB reserved for kdump): too little" "$out" "2 GiB VM with kdump fails and shows the share"
assert_contains "failed=1 warnings=0" "$out" "2 GiB VM with kdump fails"
assert_contains "failed=1" "$(memcheck 3145727)" "one KiB under 3 GiB fails"
assert_contains "failed=0 warnings=1" "$(memcheck 3145728)" "exactly 3 GiB warns"
assert_contains "failed=1" "$(memcheck -)" "unknown memory fails"
assert_contains "memory unknown: too little" "$(memcheck -)" "unknown memory is said so"
# 8 GiB: ok, with a reservation as well. 6.6 GiB visible reaches 7 GiB only with it.
out=$(memcheck 7575712 536870912)
assert_contains "ok: memory 7.2 GiB visible (+0.5 GiB reserved for kdump)" "$out" "8 GiB VM with kdump is ok"
assert_contains "failed=0 warnings=0" "$out" "8 GiB VM with kdump: no warning"
out=$(memcheck 6900000 536870912)
assert_contains "ok: memory 6.6 GiB visible (+0.5 GiB reserved for kdump)" "$out" "the reservation lifts 6.6 GiB to ok"
assert_contains "failed=0 warnings=1" "$(memcheck 6900000)" "6.6 GiB without a reservation warns"
out=$(memcheck 8100000)
assert_contains "ok: memory 7.7 GiB" "$out" "8 GiB VM without kdump is ok"
assert_contains "failed=0 warnings=0" "$out" "8 GiB VM without kdump: no warning"

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

# Fresh secrets every time; no updater image even with --with-updater (the updater pins the
# image it runs itself); keys the template lacks are appended.
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
assert_eq "" "$(env_get "$dir2/.env" RESTOW_UPDATER_IMAGE)" "the updater pins its own image on its first start, the installer leaves it empty"
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
  pull)
    if [ -n "${STUB_PULL_ERROR:-}" ]; then echo "$STUB_PULL_ERROR" >&2; exit 1; fi
    touch "$GATE_STATE/present" "$GATE_STATE/digest"; exit 0 ;;
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

# A pull that fails is explained when the registry says why (the report: packages still private).
STUB_PULL_ERROR="Error response from daemon: error from registry: unauthorized" gate none pull_and_verify "$REF"
assert_eq 5 "$GATE_STATUS" "unauthorized pull: exit code 5"
assert_contains "error: image $REF is not publicly available (401 unauthorized): the release images may not be published yet" "$GATE_OUT" "unauthorized pull: explained"
assert_contains "(docker: Error response from daemon: error from registry: unauthorized)" "$GATE_OUT" "unauthorized pull: docker's own words stay"
assert_contains "Run the installer again once this is fixed" "$GATE_OUT" "unauthorized pull: what to do next"
assert_not_contains "docker run" "$(cat "$GATE_LOG")" "unauthorized pull: no cosign run"
STUB_PULL_ERROR="pull access denied for ghcr.io/restow-backup/restow, repository does not exist or may require 'docker login'" gate none pull_and_verify "$REF"
assert_contains "is not publicly available (401 unauthorized)" "$GATE_OUT" "pull access denied: explained as unauthorized"
STUB_PULL_ERROR="Error response from daemon: manifest unknown" gate none pull_and_verify "$REF"
assert_eq 5 "$GATE_STATUS" "unknown tag: exit code 5"
assert_contains "no image $REF (404 not found): check --version and --edition" "$GATE_OUT" "unknown tag: explained"
STUB_PULL_ERROR="Error response from daemon: Get https://ghcr.io/v2/: net/http: request canceled" gate none pull_and_verify "$REF"
assert_eq 5 "$GATE_STATUS" "other pull failure: exit code 5"
assert_contains "error: could not pull $REF (docker: Error response from daemon: Get https://ghcr.io/v2/: net/http: request canceled)" "$GATE_OUT" "other pull failure: docker's last line"
assert_not_contains "not publicly available" "$GATE_OUT" "other pull failure: no wrong explanation"

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
case "$*" in
  *"/token?"*)
    if [ -n "${STUB_NO_TOKEN:-}" ]; then printf "{}\n%s" "${STUB_TOKEN_CODE:-200}"; else printf "{\"token\":\"stubtoken\"}\n%s" "${STUB_TOKEN_CODE:-200}"; fi ;;
  *restow-web*"/manifests/"*) printf "%s" "${STUB_MANIFEST_CODE_WEB:-${STUB_MANIFEST_CODE:-200}}" ;;
  *"/manifests/"*) printf "%s" "${STUB_MANIFEST_CODE:-200}" ;;
  *) printf 200 ;;
esac'
stub ss 'printf "%s\n" "${STUB_SS:-LISTEN 0 4096 0.0.0.0:22 0.0.0.0:*}"'
stub getent 'echo "203.0.113.10    STREAM backup.example.com"'
stub ip 'echo "2: eth0    inet 203.0.113.10/24 brd 203.0.113.255 scope global eth0"'
stub df 'printf "Filesystem 1024-blocks Used Available Capacity Mounted\n/dev/vda1 104857600 1048576 %s 2%% /\n" "${STUB_DF_AVAIL:-94371840}"'
# No LVM unless a test says so: findmnt names a plain partition, lvs finds no logical volume.
stub findmnt 'echo "findmnt $*" >>"$STUB_LOG"; echo "${STUB_FINDMNT-/dev/vda1}"'
stub lvs 'if [ -n "${STUB_LVS:-}" ]; then echo "  $STUB_LVS"; else echo "  Failed to find logical volume" >&2; exit 5; fi'
stub vgs 'echo "  ${STUB_VG_FREE:-0.00}"'
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
    KEXEC_CRASH_SIZE_FILES=${STUB_KEXEC_FILES:-$TMP_ROOT/no-kexec-crash-size}
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

# lvm_free_hint: the volume group behind the file system has unused space. The stubs stand
# for findmnt, lvs and vgs.
LVM_LV="/dev/mapper/ubuntu--vg-ubuntu--lv"
LVM_HINT="       hint: the volume group ubuntu-vg has 15.0 GiB unused: sudo lvextend -r -l +100%FREE /dev/ubuntu-vg/ubuntu-lv"
# lvm_hint_with <path>: what lvm_free_hint prints (stderr included), with the stubs in the PATH.
lvm_hint_with() {
  (
    PATH="$STUBS:$PATH"
    LOG_READY=0
    LVM_HINT_SHOWN=""
    lvm_free_hint "$1" 2>&1
  )
}
: >"$STUB_LOG"
assert_eq "$LVM_HINT" "$(STUB_FINDMNT=$LVM_LV STUB_LVS="ubuntu-vg ubuntu-lv" STUB_VG_FREE=15728640.00 lvm_hint_with /var/lib/docker)" "unused space in the volume group: hint with the command"
assert_contains "findmnt -n -o SOURCE --target /" "$(cat "$STUB_LOG")" "the file system of the path is looked up (an existing parent of /var/lib/docker)"
assert_eq "$LVM_HINT" "$(STUB_FINDMNT=$LVM_LV STUB_LVS="ubuntu-vg ubuntu-lv" STUB_VG_FREE=15728640,00 lvm_hint_with "$TMP_ROOT/not/yet/there")" "a decimal comma and a path that does not exist yet"
assert_eq "" "$(STUB_FINDMNT=$LVM_LV STUB_LVS="ubuntu-vg ubuntu-lv" STUB_VG_FREE=0.00 lvm_hint_with /var/lib/docker)" "volume group without unused space: no hint"
assert_eq "" "$(STUB_FINDMNT=$LVM_LV STUB_LVS="ubuntu-vg ubuntu-lv" STUB_VG_FREE=524288.00 lvm_hint_with /var/lib/docker)" "half a GiB unused is not worth a hint"
assert_eq "" "$(STUB_FINDMNT=$LVM_LV STUB_LVS="ubuntu-vg ubuntu-lv" STUB_VG_FREE=unknown lvm_hint_with /var/lib/docker)" "unreadable free space: no hint"
assert_eq "" "$(STUB_FINDMNT=/dev/vda1 STUB_VG_FREE=15728640.00 lvm_hint_with /var/lib/docker)" "a plain partition (no logical volume): no hint"
assert_eq "" "$(STUB_FINDMNT='' STUB_LVS="ubuntu-vg ubuntu-lv" STUB_VG_FREE=15728640.00 lvm_hint_with /var/lib/docker)" "no mount found: no hint"
assert_eq "" "$(STUB_FINDMNT=tmpfs STUB_LVS="ubuntu-vg ubuntu-lv" STUB_VG_FREE=15728640.00 lvm_hint_with /var/lib/docker)" "a source that is no device: no hint"
assert_eq "" "$(STUB_FINDMNT=$LVM_LV STUB_LVS="odd;vg ubuntu-lv" STUB_VG_FREE=15728640.00 lvm_hint_with /var/lib/docker)" "a name with odd characters never reaches the hint"
EMPTY_BIN="$TMP_ROOT/empty-bin"
mkdir -p "$EMPTY_BIN"
assert_eq "" "$(STUB_FINDMNT=$LVM_LV STUB_LVS="ubuntu-vg ubuntu-lv" STUB_VG_FREE=15728640.00 PATH="$EMPTY_BIN" lvm_free_hint /var/lib/docker 2>&1)" "no LVM tools installed: silently no hint"
assert_eq "$LVM_HINT" "$( (
  export STUB_FINDMNT=$LVM_LV STUB_LVS="ubuntu-vg ubuntu-lv" STUB_VG_FREE=15728640.00
  PATH="$STUBS:$PATH"
  LOG_READY=0
  LVM_HINT_SHOWN=""
  lvm_free_hint /var/lib/docker
  lvm_free_hint /opt/restow
  lvm_free_hint /srv
) 2>&1)" "the same hint is shown once"

# registry_pull_status and check_images: can the images be pulled without a login? The curl
# stub answers the token request and the manifest request of the registry API.
IMG_APP="ghcr.io/restow-backup/restow-community:0.1.0"
IMG_WEB="ghcr.io/restow-backup/restow-web-community:0.1.0"
# registry_with <reference>: registry_pull_status with the stubs in the PATH.
registry_with() {
  (
    PATH="$STUBS:$PATH"
    registry_pull_status "$1"
  )
}
: >"$STUB_LOG"
assert_eq "public" "$(registry_with "$IMG_APP")" "image that answers 200: public"
assert_contains "%{http_code} https://ghcr.io/token?scope=repository:restow-backup/restow-community:pull" "$(cat "$STUB_LOG")" "an anonymous token is asked for the repository"
assert_not_contains "Authorization" "$(grep "/token?" "$STUB_LOG")" "the token request carries no credentials"
assert_contains "--head -o /dev/null -w %{http_code} -H Authorization: Bearer stubtoken -H Accept: application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json https://ghcr.io/v2/restow-backup/restow-community/manifests/0.1.0" "$(cat "$STUB_LOG")" "the manifest of the tag is asked for, with the token and the manifest types"
assert_eq "unauthorized 401" "$(STUB_MANIFEST_CODE=401 registry_with "$IMG_APP")" "401: unauthorized"
assert_eq "unauthorized 403" "$(STUB_MANIFEST_CODE=403 registry_with "$IMG_APP")" "403: unauthorized"
assert_eq "notfound 404" "$(STUB_MANIFEST_CODE=404 registry_with "$IMG_APP")" "404: not found"
assert_eq "unknown" "$(STUB_MANIFEST_CODE=503 registry_with "$IMG_APP")" "503: unknown"
assert_eq "unknown" "$(STUB_MANIFEST_CODE=000 registry_with "$IMG_APP")" "no answer: unknown"
assert_eq "unknown" "$(STUB_NO_TOKEN=1 registry_with "$IMG_APP")" "no token: unknown"
# ghcr.io: no anonymous token for a private package (401) or a name that does not exist (403).
assert_eq "unauthorized 401" "$(STUB_TOKEN_CODE=401 registry_with "$IMG_APP")" "private package: the token request answers 401"
assert_eq "unauthorized 403" "$(STUB_TOKEN_CODE=403 registry_with "$IMG_APP")" "unknown package: the token request answers 403"
assert_eq "unknown" "$(STUB_TOKEN_CODE=502 registry_with "$IMG_APP")" "token request fails with 502: unknown"
: >"$STUB_LOG"
STUB_TOKEN_CODE=401 registry_with "$IMG_APP" >/dev/null
assert_not_contains "manifests" "$(cat "$STUB_LOG")" "no manifest request when the token is refused"
assert_eq "" "$(image_problem public "$IMG_APP")" "public: nothing to explain"
assert_eq "" "$(image_problem unknown "$IMG_APP")" "unknown: nothing to explain"

# imgcheck <application image> <web image> [docker state] [local]: check_images; prints what
# it says and, last, the failed checks and warnings. "local": every image is here already.
imgcheck() {
  (
    PATH="$STUBS:$PATH"
    LOG_READY=0
    PREFLIGHT_FAILED=0
    WARNINGS=0
    APP_IMAGE=$1
    WEB_IMAGE=$2
    DOCKER_STATE=${3:-missing}
    if [ "${4:-}" = local ]; then
      docker() { return 0; }
    fi
    check_images 2>&1
    printf 'failed=%s warnings=%s\n' "$PREFLIGHT_FAILED" "$WARNINGS"
  )
}
: >"$STUB_LOG"
out=$(imgcheck "$IMG_APP" "$IMG_WEB")
assert_contains "ok: $IMG_APP can be pulled without a login" "$out" "public application image: ok"
assert_contains "ok: $IMG_WEB can be pulled without a login" "$out" "public web image: ok"
assert_contains "failed=0 warnings=0" "$out" "public images: nothing failed"
out=$(STUB_TOKEN_CODE=401 imgcheck "$IMG_APP" "$IMG_WEB")
assert_contains "error: image $IMG_APP is not publicly available (401 unauthorized): the release images may not be published yet; nothing was changed" "$out" "private application image: fails with the explanation"
assert_contains "error: image $IMG_WEB is not publicly available (401 unauthorized)" "$out" "private web image: fails too"
assert_contains "failed=2 warnings=0" "$out" "two private images: two failed checks"
out=$(STUB_MANIFEST_CODE=401 imgcheck "$IMG_APP" "$IMG_WEB")
assert_contains "failed=2 warnings=0" "$out" "a manifest request that answers 401 fails as well"
out=$(STUB_MANIFEST_CODE_WEB=403 imgcheck "$IMG_APP" "$IMG_WEB")
assert_contains "ok: $IMG_APP can be pulled without a login" "$out" "only the web image is private: the other is ok"
assert_contains "error: image $IMG_WEB is not publicly available (403 denied)" "$out" "403 is said as denied"
assert_contains "failed=1 warnings=0" "$out" "one private image: one failed check"
out=$(STUB_MANIFEST_CODE=404 imgcheck "ghcr.io/restow-backup/restow-community:9.9.9" "ghcr.io/restow-backup/restow-web-community:9.9.9")
assert_contains "error: no image ghcr.io/restow-backup/restow-community:9.9.9 (404 not found): check --version and --edition; nothing was changed" "$out" "unknown version: fails with the explanation"
assert_contains "failed=2 warnings=0" "$out" "unknown version: two failed checks"
out=$(STUB_MANIFEST_CODE=503 imgcheck "$IMG_APP" "$IMG_WEB")
assert_contains "warning: could not ask ghcr.io whether $IMG_APP can be pulled; the pull may still work" "$out" "registry error: a warning, not a failure"
assert_contains "failed=0 warnings=2" "$out" "registry error: nothing fails"
out=$(STUB_NO_TOKEN=1 imgcheck "$IMG_APP" "$IMG_WEB")
assert_contains "failed=0 warnings=2" "$out" "no token: warnings only"
: >"$STUB_LOG"
out=$(STUB_MANIFEST_CODE=401 imgcheck "localhost:5000/restow/restow-community:0.1.0" "localhost:5000/restow/restow-web-community:0.1.0")
assert_contains "warning: the images come from localhost:5000 (RESTOW_INSTALL_IMAGE_PREFIX): not checked whether they can be pulled" "$out" "another registry: skipped with a warning"
assert_contains "failed=0 warnings=1" "$out" "another registry: never a failure"
assert_not_contains "curl" "$(cat "$STUB_LOG")" "another registry: no request is made"
: >"$STUB_LOG"
out=$(STUB_MANIFEST_CODE=401 imgcheck "$IMG_APP" "$IMG_WEB" ok local)
assert_contains "ok: $IMG_APP is here already" "$out" "an image that is here already is not asked for"
assert_contains "failed=0 warnings=0" "$out" "images here already: nothing fails"
assert_not_contains "curl" "$(cat "$STUB_LOG")" "images here already: no request is made"

dir3="$TMP_ROOT/fresh"
dry_main "$OS_DEBIAN12" "$MEM_8G" --non-interactive --domain backup.example.com --dir "$dir3"
assert_eq 0 "$DRY_STATUS" "fresh dry run exits 0"
assert_contains "Debian GNU/Linux 12 (bookworm)" "$DRY_OUT" "fresh dry run: OS"
assert_contains "virtual machine (kvm)" "$DRY_OUT" "fresh dry run: VM"
assert_contains "backup.example.com resolves to this host" "$DRY_OUT" "fresh dry run: DNS"
assert_contains "ports 80 and 443 are free" "$DRY_OUT" "fresh dry run: ports"
assert_contains "ghcr.io/restow-backup/restow:0.2.1" "$DRY_OUT" "fresh dry run: full build image"
assert_contains "would download SHA256SUMS, SHA256SUMS.sigstore.json, docker-compose.yml and env.example from https://github.com/restow-backup/restow/releases/download/v0.2.1" "$DRY_OUT" "fresh dry run: release files"
assert_contains "signer: https://github.com/restow-backup/restow/.github/workflows/release.yml@refs/tags/v0.2.1" "$DRY_OUT" "fresh dry run: signer"
assert_contains "would write $dir3/.env" "$DRY_OUT" "fresh dry run: .env"
assert_contains "would run: docker pull $COSIGN_IMAGE" "$DRY_OUT" "fresh dry run: cosign"
assert_contains "would run: docker compose up -d" "$DRY_OUT" "fresh dry run: start"
assert_contains "Dry run finished: nothing was changed." "$DRY_OUT" "fresh dry run: end"
assert_status 1 "fresh dry run: no directory created" test -e "$dir3"
no_mutation "fresh dry run"

dry_main "$OS_DEBIAN13" "$MEM_8G" --non-interactive --edition community --dir "$dir3" --domain backup.example.com --skip-signature-check --with-updater
assert_eq 0 "$DRY_STATUS" "Community dry run exits 0"
assert_contains "ghcr.io/restow-backup/restow-community:0.2.1" "$DRY_OUT" "Community dry run: image"
assert_contains "ghcr.io/restow-backup/restow-web-community:0.2.1" "$DRY_OUT" "Community dry run: web image"
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
assert_contains "hint: assign at least 4 GiB (8 GiB recommended) to the VM." "$DRY_OUT" "2 GiB memory: the hint is shown"

# A VM given 4 GiB: 3.3 GiB visible, with a 512 MB crash-kernel reservation (kdump) or
# without one. The installer warns and goes on in both cases.
MEM_4G_KDUMP=$(mem_fixture 3487712)
printf '536870912\n' >"$TMP_ROOT/kexec-512m"
STUB_KEXEC_FILES="$TMP_ROOT/kexec-512m" dry_main "$OS_UBUNTU2604" "$MEM_4G_KDUMP" --yes --domain backup.example.com --dir "$dir3"
assert_eq 0 "$DRY_STATUS" "4 GiB VM with kdump: dry run exits 0"
assert_contains "warning: memory 3.3 GiB visible (+0.5 GiB reserved for kdump): Restow runs" "$DRY_OUT" "4 GiB VM with kdump: warning"
assert_not_contains "error:" "$DRY_OUT" "4 GiB VM with kdump: no error"
dry_main "$OS_UBUNTU2604" "$MEM_4G_KDUMP" --yes --domain backup.example.com --dir "$dir3"
assert_eq 0 "$DRY_STATUS" "3.3 GiB visible without kdump: dry run exits 0"
assert_contains "warning: memory 3.3 GiB: Restow runs" "$DRY_OUT" "3.3 GiB visible without kdump: warning"
MEM_2_5G=$(mem_fixture 2621440)
dry_main "$OS_UBUNTU2604" "$MEM_2_5G" --yes --domain backup.example.com --dir "$dir3"
assert_eq 3 "$DRY_STATUS" "2.5 GiB memory: preflight fails"
STUB_KEXEC_FILES="$TMP_ROOT/kexec-512m" dry_main "$OS_UBUNTU2604" "$MEM_8G" --yes --domain backup.example.com --dir "$dir3"
assert_eq 0 "$DRY_STATUS" "8 GiB VM with kdump: dry run exits 0"
assert_contains "ok: memory 7.7 GiB visible (+0.5 GiB reserved for kdump)" "$DRY_OUT" "8 GiB VM with kdump: ok"

STUB_DOCKER_VERSION=20.10.24 dry_main "$OS_DEBIAN12" "$MEM_8G" --yes --domain backup.example.com --dir "$dir3"
assert_eq 3 "$DRY_STATUS" "Docker 20.10: preflight fails"
assert_contains "Docker Engine 20.10.24 is too old" "$DRY_OUT" "old Docker message"

# The images must be pullable without a login, or the installer stops before it changes anything.
dry_main "$OS_DEBIAN12" "$MEM_8G" --yes --domain backup.example.com --dir "$dir3"
assert_contains "ok: ghcr.io/restow-backup/restow:0.2.1 can be pulled without a login" "$DRY_OUT" "dry run: the full images are checked"
assert_contains "ok: ghcr.io/restow-backup/restow-web:0.2.1 can be pulled without a login" "$DRY_OUT" "dry run: the web image is checked"
dry_main "$OS_DEBIAN12" "$MEM_8G" --yes --edition community --domain backup.example.com --dir "$dir3"
assert_contains "ok: ghcr.io/restow-backup/restow-community:0.2.1 can be pulled without a login" "$DRY_OUT" "dry run: the Community images are checked"
STUB_TOKEN_CODE=401 dry_main "$OS_DEBIAN12" "$MEM_8G" --yes --edition community --domain backup.example.com --dir "$dir3"
assert_eq 3 "$DRY_STATUS" "private images: preflight fails"
assert_contains "error: image ghcr.io/restow-backup/restow-community:0.2.1 is not publicly available (401 unauthorized): the release images may not be published yet; nothing was changed" "$DRY_OUT" "private images: the explanation"
assert_not_contains "Plan" "$DRY_OUT" "private images: stops before the plan"
no_mutation "private images"
STUB_MANIFEST_CODE=404 dry_main "$OS_DEBIAN12" "$MEM_8G" --yes --domain backup.example.com --dir "$dir3" --version 0.9.9
assert_eq 3 "$DRY_STATUS" "unknown version: preflight fails"
assert_contains "error: no image ghcr.io/restow-backup/restow:0.9.9 (404 not found): check --version and --edition" "$DRY_OUT" "unknown version: the explanation"
RESTOW_INSTALL_IMAGE_PREFIX=localhost:5000/restow STUB_MANIFEST_CODE=401 dry_main "$OS_DEBIAN12" "$MEM_8G" --yes --domain backup.example.com --dir "$dir3" --skip-signature-check
assert_eq 0 "$DRY_STATUS" "another registry: dry run exits 0"
assert_contains "not checked whether they can be pulled" "$DRY_OUT" "another registry: skipped with a warning"

STUB_SS="LISTEN 0 511 0.0.0.0:80 0.0.0.0:*" dry_main "$OS_DEBIAN12" "$MEM_8G" --yes --domain backup.example.com --dir "$dir3"
assert_eq 3 "$DRY_STATUS" "port 80 in use: preflight fails"

STUB_DF_AVAIL=5000000 dry_main "$OS_DEBIAN12" "$MEM_8G" --yes --domain backup.example.com --dir "$dir3"
assert_eq 3 "$DRY_STATUS" "5 GiB free disk: preflight fails"
assert_not_contains "volume group" "$DRY_OUT" "no LVM: no hint about a volume group"

# Ubuntu Server's default layout: a 30 GB disk, a root logical volume of 15 GB, the rest of
# the volume group unused. The disk check fails or warns, and says how to grow the volume.
export STUB_FINDMNT=$LVM_LV STUB_LVS="ubuntu-vg ubuntu-lv" STUB_VG_FREE=15728640.00
STUB_DF_AVAIL=8100000 dry_main "$OS_UBUNTU2604" "$MEM_8G" --yes --domain backup.example.com --dir "$dir3"
assert_eq 3 "$DRY_STATUS" "7.7 GiB free for Docker: preflight fails"
assert_contains "only 7.7 GiB free for Docker (/var/lib/docker)" "$DRY_OUT" "7.7 GiB free: the message stays"
assert_contains "$LVM_HINT" "$DRY_OUT" "7.7 GiB free on an LV with a free volume group: the hint"
assert_contains "findmnt -n -o SOURCE --target /var" "$(cat "$STUB_LOG")" "the hint looks at Docker's data directory (or its nearest existing parent)"
STUB_DF_AVAIL=20000000 dry_main "$OS_UBUNTU2604" "$MEM_8G" --yes --domain backup.example.com --dir "$dir3"
assert_eq 0 "$DRY_STATUS" "19 GiB free for Docker: warns, installation goes on"
assert_contains "$LVM_HINT" "$DRY_OUT" "19 GiB free on an LV with a free volume group: the hint too"
STUB_DF_AVAIL=500000 dry_main "$OS_UBUNTU2604" "$MEM_8G" --yes --domain backup.example.com --dir "$dir3"
assert_eq 3 "$DRY_STATUS" "under 1 GiB free: preflight fails"
assert_eq 1 "$(printf '%s\n' "$DRY_OUT" | grep -c 'volume group ubuntu-vg')" "both disk checks fail, the hint is shown once"
dry_main "$OS_UBUNTU2604" "$MEM_8G" --yes --domain backup.example.com --dir "$dir3"
assert_eq 0 "$DRY_STATUS" "enough disk: dry run exits 0"
assert_not_contains "volume group" "$DRY_OUT" "enough disk: no hint"
STUB_VG_FREE=0.00 STUB_DF_AVAIL=8100000 dry_main "$OS_UBUNTU2604" "$MEM_8G" --yes --domain backup.example.com --dir "$dir3"
assert_eq 3 "$DRY_STATUS" "7.7 GiB free, volume group full: preflight fails"
assert_not_contains "volume group" "$DRY_OUT" "volume group full: no hint"
unset STUB_FINDMNT STUB_LVS STUB_VG_FREE

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

# ---- Behind a reverse proxy: options and addresses ---------------------------------------

parsed_proxy() {
  (
    set -Eeuo pipefail
    parse_args "$@"
    printf '%s|%s|%s|%s' "$OPT_BEHIND_PROXY" "$OPT_PROXY_IPS" "$OPT_PROXY_HOP" "$OPT_DOMAIN"
  ) 2>/dev/null
}

assert_eq "0|||" "$(parsed_proxy)" "no reverse proxy by default"
assert_eq "1|192.168.1.20/32||backup.example.com" \
  "$(parsed_proxy --behind-proxy --proxy-ip 192.168.1.20 --domain Backup.Example.com)" \
  "--behind-proxy takes a bare address and adds /32"
assert_eq "1|10.0.0.5/32 10.0.0.6/32 10.1.0.0/24||" \
  "$(parsed_proxy --behind-proxy --proxy-ip 10.0.0.5 10.0.0.6 --proxy-ip=10.1.0.0/24)" \
  "--proxy-ip: space-separated, repeated and --option=value"
assert_eq "1|10.0.0.5/32 10.0.0.6/32||" \
  "$(parsed_proxy --behind-proxy --proxy-ip 10.0.0.5,10.0.0.6)" \
  "--proxy-ip: comma-separated"
assert_eq "1|10.0.0.5/32||" \
  "$(parsed_proxy --behind-proxy --proxy-ip 10.0.0.5 10.0.0.5/32 --proxy-ip 10.0.0.5)" \
  "--proxy-ip: an address once"
assert_eq "1|2001:db8::1/128 fd00::/8||" \
  "$(parsed_proxy --behind-proxy --proxy-ip 2001:DB8::1 fd00::/8)" \
  "--proxy-ip: IPv6 gets /128, lower case"
assert_eq "1|10.0.0.5/32|http|" "$(parsed_proxy --behind-proxy --proxy-ip 10.0.0.5 --proxy-hop HTTP)" "--proxy-hop http"
assert_eq "1|10.0.0.5/32|https|" "$(parsed_proxy --behind-proxy --proxy-ip 10.0.0.5 --proxy-hop=https)" "--proxy-hop=https"
assert_eq "1|||" "$(parsed_proxy --behind-proxy)" "--behind-proxy alone parses; the questions or the non-interactive check come later"
assert_status 0 "an internal name behind a proxy" parse_args --behind-proxy --domain restow.home.arpa
assert_status 2 "an internal name is still refused without a proxy" parse_args --domain restow.home.arpa
assert_status 2 "an IP as the name behind a proxy" parse_args --behind-proxy --domain 192.0.2.10
assert_status 2 "a single label behind a proxy" parse_args --behind-proxy --domain restow
assert_status 2 "--proxy-ip without a value" parse_args --behind-proxy --proxy-ip
assert_status 2 "--proxy-ip followed by an option" parse_args --behind-proxy --proxy-ip --yes
assert_status 2 "--proxy-ip with a host name" parse_args --behind-proxy --proxy-ip proxy.lan
assert_status 2 "--proxy-ip with a bad octet" parse_args --behind-proxy --proxy-ip 192.168.1.256
assert_status 2 "--proxy-ip with a leading zero" parse_args --behind-proxy --proxy-ip 192.168.01.5
assert_status 2 "--proxy-ip with a prefix too long" parse_args --behind-proxy --proxy-ip 10.0.0.0/33
assert_status 2 "--proxy-ip that trusts everybody" parse_args --behind-proxy --proxy-ip 0.0.0.0/0
assert_status 2 "--proxy-ip that trusts every IPv6 address" parse_args --behind-proxy --proxy-ip ::/0
assert_status 2 "--proxy-ip without --behind-proxy" parse_args --proxy-ip 10.0.0.5
assert_status 2 "--proxy-hop without --behind-proxy" parse_args --proxy-hop http
assert_status 2 "--proxy-hop with another value" parse_args --behind-proxy --proxy-hop ftp
assert_status 2 "--behind-proxy and --local" parse_args --behind-proxy --local
assert_contains "address of your reverse proxy" "$( (parse_args --behind-proxy --proxy-ip proxy.lan) 2>&1)" "a bad --proxy-ip says what is wanted"

assert_status 0 "IPv4" valid_ipv4 192.168.1.20
assert_status 1 "IPv4 with three parts" valid_ipv4 192.168.1
assert_status 1 "IPv4 with a part over 255" valid_ipv4 1.2.3.256
assert_status 1 "IPv4 with a leading zero" valid_ipv4 1.2.3.04
assert_status 0 "IPv6" valid_ipv6 2001:db8::1
assert_status 0 "IPv6 loopback" valid_ipv6 ::1
assert_status 0 "IPv6 in full" valid_ipv6 2001:0db8:0000:0000:0000:0000:0000:0001
assert_status 1 "IPv6 with two ::" valid_ipv6 2001::db8::1
assert_status 1 "IPv6 with a group of five digits" valid_ipv6 2001:db80a::1
assert_status 1 "IPv6 with too few groups" valid_ipv6 2001:db8:1
assert_status 1 "IPv6 with a stray colon" valid_ipv6 :2001:db8::1
assert_status 1 "IPv6 with a non-hex digit" valid_ipv6 2001:dbg::1
assert_eq "" "$(proxy_entry_problem 192.168.1.0/24)" "a network is fine"
assert_contains "would trust every address" "$(proxy_entry_problem 10.0.0.0/0)" "/0 trusts every address"
assert_eq "192.168.1.20/32" "$(normalize_proxy_entry 192.168.1.20)" "normalize: IPv4"
assert_eq "10.0.0.0/8" "$(normalize_proxy_entry 10.0.0.0/08)" "normalize: a prefix with a leading zero"
assert_eq "fd00::1/128" "$(normalize_proxy_entry FD00::1)" "normalize: IPv6"
assert_eq "10.0.0.5/32 192.168.1.0/24" "$(proxy_list_normalize "10.0.0.5, 192.168.1.0/24 10.0.0.5/32")" "normalize: a list, each once"
assert_eq "" "$(proxy_entry_range_note 10.0.0.5/32)" "a host is no wide range"
assert_eq "" "$(proxy_entry_range_note 192.168.1.0/24)" "a /24 is no wide range"
assert_contains "covers more than 254 addresses" "$(proxy_entry_range_note 10.0.0.0/8)" "a /8 is a wide range"
assert_contains "very wide range" "$(proxy_entry_range_note fd00::/16)" "an IPv6 /16 is a wide range"
assert_eq "" "$(domain_problem restow.home.arpa 0 1)" "an internal name behind a proxy"
assert_contains "internal name" "$(domain_problem restow.home.arpa 0 0)" "an internal name otherwise"
assert_contains "use a domain name" "$(domain_problem 10.0.0.1 0 1)" "an IP behind a proxy"
assert_status 0 "0.2.0 can serve the encrypted hop" version_ge 0.2.0 "$PROXY_TLS_MIN_VERSION"
assert_status 1 "0.1.0 cannot serve the encrypted hop" version_ge 0.1.0 "$PROXY_TLS_MIN_VERSION"
assert_status 0 "a pre-release of 0.2.0 can" version_ge 0.2.0-rc.1 "$PROXY_TLS_MIN_VERSION"

# ---- Behind a reverse proxy: .env ----------------------------------------------------------

# proxy_env <hop> <dir>: write_env in proxy mode; the .env is left in <dir>.
proxy_env() {
  env_fixture "$2"
  (
    set -Eeuo pipefail
    OPT_DIR=$2 OPT_UPDATER=0 LOG_READY=0
    APP_IMAGE=ghcr.io/restow-backup/restow:0.2.0 WEB_IMAGE=ghcr.io/restow-backup/restow-web:0.2.0
    DOMAIN=backup.example.com PUBLIC_URL=https://backup.example.com
    MODE=proxy PROXY_HOP=$1 TRUSTED_PROXIES="192.168.1.20/32 10.0.0.0/29"
    if [ "$1" = http ]; then APP_DOMAIN_VALUE=http://backup.example.com; else APP_DOMAIN_VALUE=backup.example.com; fi
    write_env
  ) >/dev/null 2>&1
}

dir_https="$TMP_ROOT/proxy-https"
proxy_env https "$dir_https"
assert_eq 0 "$?" "write_env behind a proxy (encrypted hop)"
env_https="$dir_https/.env"
assert_eq "backup.example.com" "$(env_get "$env_https" RESTOW_APP_DOMAIN)" "https hop: RESTOW_APP_DOMAIN is the domain, no scheme"
assert_eq "https://backup.example.com" "$(env_get "$env_https" RESTOW_PUBLIC_URL)" "https hop: RESTOW_PUBLIC_URL"
assert_eq "internal" "$(env_get "$env_https" RESTOW_EDGE_TLS)" "https hop: the edge uses its own authority"
assert_eq "192.168.1.20/32 10.0.0.0/29" "$(env_get "$env_https" RESTOW_EDGE_TRUSTED_PROXIES)" "https hop: the trusted proxies"
assert_eq "127.0.0.1:" "$(env_get "$env_https" RESTOW_HTTP_PORT)" "https hop: port 80 is published on the loopback only, on a port Docker picks"
assert_eq "" "$(env_get "$env_https" RESTOW_HTTPS_PORT)" "https hop: port 443 keeps its default"
assert_eq "" "$(env_get "$env_https" RESTOW_EDGE_HSTS)" "https hop: HSTS stays off"
assert_eq "600" "$(file_mode "$env_https")" "https hop: .env mode 0600"
# shellcheck disable=SC2086 # a list of key names
assert_eq "" "$(env_missing_keys "$env_https" $REQUIRED_ENV_NAMES)" "https hop: every required key set"

dir_http="$TMP_ROOT/proxy-http"
proxy_env http "$dir_http"
env_http="$dir_http/.env"
assert_eq "http://backup.example.com" "$(env_get "$env_http" RESTOW_APP_DOMAIN)" "http hop: RESTOW_APP_DOMAIN carries http://"
assert_eq "https://backup.example.com" "$(env_get "$env_http" RESTOW_PUBLIC_URL)" "http hop: the browser still sees https"
assert_eq "" "$(env_get "$env_http" RESTOW_EDGE_TLS)" "http hop: no certificate authority of the edge"
assert_eq "192.168.1.20/32 10.0.0.0/29" "$(env_get "$env_http" RESTOW_EDGE_TRUSTED_PROXIES)" "http hop: the trusted proxies"
assert_eq "127.0.0.1:" "$(env_get "$env_http" RESTOW_HTTPS_PORT)" "http hop: port 443 is published on the loopback only"
assert_eq "" "$(env_get "$env_http" RESTOW_HTTP_PORT)" "http hop: port 80 keeps its default"
assert_eq "" "$(env_get "$env_http" RESTOW_EDGE_HSTS)" "http hop: HSTS stays off"

# The public mode writes none of it: the .env of dir1 above is the unchanged result.
assert_eq "" "$(env_get "$env1" RESTOW_EDGE_TLS)$(env_get "$env1" RESTOW_EDGE_TRUSTED_PROXIES)$(env_get "$env1" RESTOW_HTTP_PORT)$(env_get "$env1" RESTOW_HTTPS_PORT)" "a public installation sets none of the proxy keys"

# A release whose env.example lacks the keys gets them appended (the 0.1.0 template has no RESTOW_EDGE_TLS).
dir_old="$TMP_ROOT/proxy-old-template"
env_fixture "$dir_old"
grep -v '^RESTOW_EDGE_TLS=' "$dir_old/env.example" >"$dir_old/env.tmp" && mv "$dir_old/env.tmp" "$dir_old/env.example"
(
  set -Eeuo pipefail
  OPT_DIR=$dir_old OPT_UPDATER=0 LOG_READY=0
  APP_IMAGE=a:0.2.0 WEB_IMAGE=b:0.2.0 DOMAIN=backup.example.com PUBLIC_URL=https://backup.example.com
  MODE=proxy PROXY_HOP=https TRUSTED_PROXIES=10.0.0.5/32 APP_DOMAIN_VALUE=backup.example.com
  write_env
) >/dev/null 2>&1
assert_eq "internal" "$(env_get "$dir_old/.env" RESTOW_EDGE_TLS)" "a key the template lacks is appended"

# ---- Behind a reverse proxy: ports ----------------------------------------------------------

# portcheck <hop> <ss output>: check_ports in proxy mode against the ss stub.
portcheck() {
  (
    PATH="$STUBS:$PATH"
    LOG_READY=0 PREFLIGHT_FAILED=0 WARNINGS=0 MODE=proxy PROXY_HOP=$1
    STUB_SS=$2
    export STUB_SS
    check_ports 2>&1
    printf 'failed=%s warnings=%s\n' "$PREFLIGHT_FAILED" "$WARNINGS"
  )
}
BUSY_80="LISTEN 0 511 0.0.0.0:80 0.0.0.0:*"
BUSY_443="LISTEN 0 511 0.0.0.0:443 0.0.0.0:*"
out=$(portcheck https "$BUSY_80")
assert_contains "ok: port 443 is free (your reverse proxy forwards to it)" "$out" "encrypted hop: only 443 is needed"
assert_contains "failed=0" "$out" "encrypted hop: a busy port 80 does not matter"
out=$(portcheck https "$BUSY_443")
assert_contains "error: port 443 already in use on this host; the Caddy edge needs it, your reverse proxy forwards to it" "$out" "encrypted hop: a busy 443 fails"
assert_contains "failed=1" "$out" "encrypted hop: a busy 443 is one failed check"
out=$(portcheck http "$BUSY_443")
assert_contains "ok: port 80 is free (your reverse proxy forwards to it)" "$out" "plain hop: only 80 is needed"
assert_contains "failed=0" "$out" "plain hop: a busy port 443 does not matter"
out=$(portcheck http "$BUSY_80")
assert_contains "error: port 80 already in use on this host" "$out" "plain hop: a busy 80 fails"
out=$( (
  PATH="$EMPTY_BIN"
  LOG_READY=0 PREFLIGHT_FAILED=0 WARNINGS=0 MODE=proxy PROXY_HOP=https
  check_ports 2>&1
  printf 'failed=%s warnings=%s\n' "$PREFLIGHT_FAILED" "$WARNINGS"
) )
assert_contains "cannot check whether port 443 is free (no ss)" "$out" "no ss: a warning that names the one port"

# ---- Behind a reverse proxy: dry runs ---------------------------------------------------------

PROXY_ARGS=(--behind-proxy --domain backup.example.com --proxy-ip 192.168.1.20 --version 0.2.0 --non-interactive --dir "$dir3")
dry_main "$OS_DEBIAN12" "$MEM_8G" "${PROXY_ARGS[@]}"
assert_eq 0 "$DRY_STATUS" "behind a proxy: dry run exits 0"
assert_contains "ok: port 443 is free (your reverse proxy forwards to it)" "$DRY_OUT" "behind a proxy: the port check asks for 443 only"
assert_not_contains "ports 80 and 443 are free" "$DRY_OUT" "behind a proxy: not the public port check"
assert_not_contains "resolves to this host" "$DRY_OUT" "behind a proxy: no DNS check"
assert_not_contains "does not resolve" "$DRY_OUT" "behind a proxy: no DNS warning"
assert_contains "note: backup.example.com points at your reverse proxy, not at this server" "$DRY_OUT" "behind a proxy: a note instead of the DNS check"
assert_contains "Address      https://backup.example.com (served by your reverse proxy)" "$DRY_OUT" "behind a proxy: the plan names the address"
assert_contains "TLS          at your reverse proxy: forward to https://203.0.113.10:443 (not 80, not 3000)" "$DRY_OUT" "behind a proxy: the plan says where to forward to"
assert_contains "Proxy        192.168.1.20/32 (its client address is believed: X-Forwarded-For)" "$DRY_OUT" "behind a proxy: the plan names the trusted proxy"
assert_contains "HSTS         off here; leave it to your reverse proxy" "$DRY_OUT" "behind a proxy: HSTS is off"
assert_contains "would set RESTOW_APP_DOMAIN=backup.example.com, RESTOW_PUBLIC_URL=https://backup.example.com, RESTOW_EDGE_TRUSTED_PROXIES=192.168.1.20/32, RESTOW_EDGE_TLS=internal" "$DRY_OUT" "behind a proxy: the values the .env gets"
assert_contains "would check that https://backup.example.com/ answers through the Caddy edge" "$DRY_OUT" "behind a proxy: the edge is checked on its own name"
assert_contains "would copy the root certificate of the edge's own authority to $dir3/edge-root-ca.crt" "$DRY_OUT" "behind a proxy: the root certificate is exported"
assert_not_contains "NOT encrypted" "$DRY_OUT" "behind a proxy: the encrypted hop warns of nothing"
no_mutation "behind a proxy dry run"

dry_main "$OS_DEBIAN12" "$MEM_8G" --behind-proxy --domain backup.example.com --proxy-ip 192.168.1.20 --proxy-hop http --non-interactive --dir "$dir3"
assert_eq 0 "$DRY_STATUS" "behind a proxy, plain hop: dry run exits 0 with the default release"
assert_contains "ok: port 80 is free (your reverse proxy forwards to it)" "$DRY_OUT" "plain hop: the port check asks for 80 only"
assert_contains "TLS          at your reverse proxy: forward to http://203.0.113.10:80 (not 3000). That hop is NOT encrypted." "$DRY_OUT" "plain hop: the plan says so"
assert_contains "warning: --proxy-hop http: the connection between your reverse proxy and this host is NOT encrypted" "$DRY_OUT" "plain hop: a warning"
assert_contains "would set RESTOW_APP_DOMAIN=http://backup.example.com, RESTOW_PUBLIC_URL=https://backup.example.com, RESTOW_EDGE_TRUSTED_PROXIES=192.168.1.20/32" "$DRY_OUT" "plain hop: the values the .env gets"
assert_not_contains "RESTOW_EDGE_TLS=internal" "$DRY_OUT" "plain hop: no authority of the edge"
assert_contains "would check that http://backup.example.com/ answers through the Caddy edge" "$DRY_OUT" "plain hop: the edge is checked on port 80"
assert_not_contains "root certificate" "$DRY_OUT" "plain hop: no root certificate to export"
no_mutation "plain hop dry run"

STUB_SS="$BUSY_80" dry_main "$OS_DEBIAN12" "$MEM_8G" "${PROXY_ARGS[@]}"
assert_eq 0 "$DRY_STATUS" "behind a proxy: a busy port 80 does not stop the encrypted hop"
STUB_SS="$BUSY_443" dry_main "$OS_DEBIAN12" "$MEM_8G" "${PROXY_ARGS[@]}"
assert_eq 3 "$DRY_STATUS" "behind a proxy: a busy port 443 stops the encrypted hop"
STUB_SS="$BUSY_443" dry_main "$OS_DEBIAN12" "$MEM_8G" --behind-proxy --domain backup.example.com --proxy-ip 192.168.1.20 --proxy-hop http --dir "$dir3"
assert_eq 0 "$DRY_STATUS" "plain hop: a busy port 443 does not matter"
STUB_SS="$BUSY_80" dry_main "$OS_DEBIAN12" "$MEM_8G" --behind-proxy --domain backup.example.com --proxy-ip 192.168.1.20 --proxy-hop http --dir "$dir3"
assert_eq 3 "$DRY_STATUS" "plain hop: a busy port 80 stops it"

dry_main "$OS_DEBIAN12" "$MEM_8G" --behind-proxy --domain backup.example.com --proxy-ip 192.168.1.20 --non-interactive --version 0.1.0 --dir "$dir3"
assert_eq 2 "$DRY_STATUS" "behind a proxy with an old release (older than $PROXY_TLS_MIN_VERSION): refused"
assert_contains "--behind-proxy needs release $PROXY_TLS_MIN_VERSION or newer" "$DRY_OUT" "behind a proxy: the old release is said to be the problem"
assert_contains "--proxy-hop http" "$DRY_OUT" "behind a proxy: and the way out is named"

dry_main "$OS_DEBIAN12" "$MEM_8G" --behind-proxy --version 0.2.0 --dir "$dir3"
assert_eq 0 "$DRY_STATUS" "behind a proxy, dry run without domain and address: placeholders"
assert_contains "backup.example.com stands in for it" "$DRY_OUT" "behind a proxy: the placeholder domain"
assert_contains "192.0.2.1/32 stands in for it" "$DRY_OUT" "behind a proxy: the placeholder address"

dry_main "$OS_DEBIAN12" "$MEM_8G" --behind-proxy --domain backup.example.com --proxy-ip 10.0.0.0/8 --version 0.2.0 --dir "$dir3"
assert_eq 0 "$DRY_STATUS" "behind a proxy: a wide range only warns"
assert_contains "warning: 10.0.0.0/8 covers more than 254 addresses" "$DRY_OUT" "behind a proxy: the wide range is named"

# Without a terminal and without --dry-run: the answers have to come with the options.
nodry_main() {
  (
    PATH="$STUBS:$PATH"
    OS_RELEASE_FILE=$OS_DEBIAN12
    MEMINFO_FILE=$MEM_8G
    LOG_FILE="$TMP_ROOT/nodry.log"
    set -Eeuo pipefail
    main --non-interactive "$@" 2>&1
  )
  return $?
}
out=$(nodry_main --behind-proxy --domain backup.example.com --version 0.2.0 --dir "$dir3")
assert_eq 2 "$?" "behind a proxy without a terminal and without --proxy-ip: usage error"
assert_contains "error: --proxy-ip is required with --behind-proxy and --non-interactive" "$out" "the error names the option"
assert_contains "the address of your reverse proxy, as this host sees it" "$out" "and says what it is"
assert_contains "not your LAN" "$out" "and what it is not"
assert_not_contains "Checking this machine" "$out" "and stops before any check"
out=$(nodry_main --behind-proxy --proxy-ip 192.168.1.20 --version 0.2.0 --dir "$dir3")
assert_eq 2 "$?" "behind a proxy without a terminal and without --domain: usage error"
assert_contains "error: --domain is required with --behind-proxy and --non-interactive" "$out" "the error names the domain"
out=$(nodry_main --behind-proxy --domain backup.example.com --proxy-ip 192.168.1.20 --version 0.1.0 --dir "$dir3")
assert_eq 2 "$?" "behind a proxy with an old release and the encrypted hop: usage error before any check"
assert_contains "--behind-proxy needs release" "$out" "the error names the release"

# ---- The whole installation against stubs: the dialogue, the final block, the log ----------
# Real install, ln and chmod in a directory of the test; docker, curl and the rest are stubs
# that answer like the real thing would and record every call.

E2E_STUBS="$TMP_ROOT/e2e-stubs"
E2E_LOG="$TMP_ROOT/e2e-calls.log"
E2E_RELEASE="$TMP_ROOT/e2e-release"
E2E_TOKEN="K7PQX-3MZRA-T9WHE-2BNCV" # gitleaks:allow (made-up test token)
E2E_OLD_TOKEN="AAAAA-BBBBB-CCCCC-DDDDD"
mkdir -p "$E2E_STUBS" "$E2E_RELEASE"
export E2E_LOG E2E_RELEASE E2E_TOKEN E2E_OLD_TOKEN
for stub_name in systemd-detect-virt timedatectl ss getent ip df findmnt lvs vgs dpkg-query; do
  cp "$STUBS/$stub_name" "$E2E_STUBS/$stub_name"
done
cat >"$E2E_STUBS/id" <<'STUB'
#!/bin/sh
case "$1" in -u) echo 0 ;; -un) echo root ;; *) echo "uid=0(root) gid=0(root)" ;; esac
STUB
printf '#!/bin/sh\nexit 0\n' >"$E2E_STUBS/sleep"
cat >"$E2E_STUBS/curl" <<'STUB'
#!/bin/sh
echo "curl $*" >>"$E2E_LOG"
out=""; code=0; url=""; prev=""
for arg in "$@"; do
  case "$prev" in -o) out=$arg ;; -w) code=1 ;; esac
  prev=$arg
  url=$arg
done
case "$url" in
  */token\?*) printf '{"token":"stubtoken"}\n200'; exit 0 ;;
  */manifests/*) printf 200; exit 0 ;;
  */api/v1/setup/state)
    if [ -n "${E2E_CONFIGURED:-}" ]; then printf '{"configured":true}'; else printf '{"configured":false}'; fi
    exit 0 ;;
esac
if [ -n "$out" ] && [ "$out" != /dev/null ]; then
  cp "$E2E_RELEASE/${url##*/}" "$out" || exit 22
  exit 0
fi
if [ "$code" = 1 ]; then printf 200; fi
exit 0
STUB
cat >"$E2E_STUBS/docker" <<'STUB'
#!/bin/sh
echo "docker $*" >>"$E2E_LOG"
case "$*" in
  "info --format {{.DockerRootDir}}") echo /var/lib/docker ;;
  info) exit 0 ;;
  "version --format {{.Server.Version}}") echo 27.5.1 ;;
  "compose version --short") echo 2.29.7 ;;
  "volume ls -q") exit 0 ;;
  "ps -a --filter"*) exit 0 ;;
  "image inspect"*) exit 1 ;;
  "pull "*) exit 0 ;;
  compose\ -f\ *\ logs\ *)
    if [ -n "${E2E_NO_TOKEN:-}" ]; then
      echo "api-1  | Restow listening on :3000"
    else
      printf 'api-1  | ====\napi-1  |     SETUP TOKEN: %s\napi-1  | ====\napi-1  | restarted\napi-1  |     SETUP TOKEN: %s\n' "$E2E_OLD_TOKEN" "$E2E_TOKEN"
    fi ;;
  compose\ -f\ *\ cp\ *)
    for dest; do :; done
    printf -- '-----BEGIN CERTIFICATE-----\nMIIBstub\n-----END CERTIFICATE-----\n' >"$dest" ;;
  compose\ -f\ *) exit 0 ;;
  *) echo "UNEXPECTED docker $*" >>"$E2E_LOG"; exit 1 ;;
esac
STUB
chmod 755 "$E2E_STUBS"/*
cp "$REPO/deploy/release/docker-compose.yml" "$E2E_RELEASE/docker-compose.yml"
cp "$REPO/deploy/release/.env.example" "$E2E_RELEASE/env.example"
(cd "$E2E_RELEASE" && for f in docker-compose.yml env.example; do printf '%s  %s\n' "$(sha256_of "$f")" "$f"; done >SHA256SUMS)

E2E_STATUS=0
E2E_N=0
# e2e_main <file with the answers, or - for a run without a terminal> <output file> <main arguments...>
# Everything the installer prints, on stdout and on the terminal, lands in the output file in
# the order it was printed. The install log of the run is $E2E_INSTALL_LOG.
e2e_main() {
  local answers=$1 out=$2
  shift 2
  E2E_N=$((E2E_N + 1))
  E2E_INSTALL_LOG="$TMP_ROOT/e2e-install-$E2E_N.log"
  : >"$out"
  (
    PATH="$E2E_STUBS:$PATH"
    OS_RELEASE_FILE=$OS_UBUNTU2604
    MEMINFO_FILE=$MEM_8G
    KEXEC_CRASH_SIZE_FILES="$TMP_ROOT/no-kexec-crash-size"
    LOG_FILE=$E2E_INSTALL_LOG
    RESTOW_INSTALL_RELEASE_URL=http://release.test/rel
    TOKEN_WAIT_SECONDS=0
    TOKEN_POLL_SECONDS=0
    if [ "$answers" != - ]; then
      TTY_IN=$answers
      TTY_OUT=$out
    fi
    if [ -n "${E2E_STDOUT_TTY:-}" ]; then
      stdout_is_tty() { return 0; }
    fi
    set -Eeuo pipefail
    main "$@" >>"$out" 2>&1
  )
  E2E_STATUS=$?
}
answers_file() {
  local file="$TMP_ROOT/answers-$E2E_N-$1"
  shift
  printf '%s\n' "$@" >"$file"
  printf '%s' "$file"
}
# line_number <text> <file>: the first line that contains the text (0 when none).
line_number() {
  awk -v t="$1" 'index($0, t) { print NR; found = 1; exit } END { if (!found) print 0 }' "$2"
}

# --- Option 2, behind a reverse proxy, the whole dialogue and the installation ---------------
e2e_dir="$TMP_ROOT/e2e-proxy"
e2e_out="$TMP_ROOT/e2e-proxy.out"
e2e_main "$(answers_file proxy 2 backup.example.com 192.168.1.20 "" y yes)" "$e2e_out" \
  --version 0.2.0 --skip-signature-check --dir "$e2e_dir"
assert_eq 0 "$E2E_STATUS" "interactive installation behind a proxy: exit 0"
out=$(cat "$e2e_out")
assert_contains "This installs the Restow server on this machine with Docker Compose." "$out" "interactive: the intro comes first"
assert_contains "It takes about 10 to 20 minutes" "$out" "interactive: the intro says how long"
assert_contains "You need root (sudo), outbound" "$out" "interactive: the intro says what is needed"
assert_contains "How will people reach Restow?" "$out" "interactive: the question for the mode"
assert_contains "  1) Public, with its own certificate" "$out" "interactive: option 1"
assert_contains "Needs a domain that points at this server and ports 80 and 443 open to the internet." "$out" "interactive: what option 1 needs"
assert_contains "  2) Behind a reverse proxy you already run (Nginx Proxy Manager, Traefik, Caddy, ...)" "$out" "interactive: option 2"
assert_contains "The proxy handles the public address and TLS and forwards to this server, encrypted." "$out" "interactive: option 2 says the hop is encrypted"
assert_contains "  3) Local evaluation (--local)" "$out" "interactive: option 3"
assert_contains "Choose 1, 2 or 3 [1]: " "$out" "interactive: the prompt with its default"
assert_contains "Domain name your reverse proxy serves (for example backup.example.com): " "$out" "interactive: the domain, asked for the proxy"
assert_contains "Enter the address of the proxy server itself, as this machine sees it" "$out" "interactive: the proxy address is explained"
assert_contains "not your whole network" "$out" "interactive: and it is not the LAN"
assert_contains "Address of your reverse proxy: " "$out" "interactive: the prompt for the address"
assert_lt() { if [ "$1" -lt "$2" ] && [ "$1" -gt 0 ]; then pass; else fail "$3: line $1 is not before line $2 (0 = missing)"; fi; }
assert_lt "$(line_number 'This installs the Restow server' "$e2e_out")" "$(line_number 'Checking this machine' "$e2e_out")" "the intro comes before the checks"
assert_lt "$(line_number 'This installs the Restow server' "$e2e_out")" "$(line_number 'How will people reach Restow?' "$e2e_out")" "the intro comes before the question"
assert_contains "Address      https://backup.example.com (served by your reverse proxy)" "$out" "plan: address"
assert_contains "TLS          at your reverse proxy: forward to https://203.0.113.10:443 (not 80, not 3000)
                 The hop is encrypted; the edge shows a certificate of its own authority." "$out" "plan: where the proxy forwards to, and that the hop is encrypted"
assert_contains "ok: port 443 is free (your reverse proxy forwards to it)" "$out" "port check"
assert_not_contains "does not resolve" "$out" "no DNS warning behind a proxy"
assert_contains "ok: root certificate of the edge's own authority: $e2e_dir/edge-root-ca.crt" "$out" "the root certificate is exported"
assert_status 0 "the exported root certificate is a certificate" grep -q 'BEGIN CERTIFICATE' "$e2e_dir/edge-root-ca.crt"
assert_eq "644" "$(file_mode "$e2e_dir/edge-root-ca.crt")" "the root certificate is public: mode 0644"
assert_contains "compose -f $e2e_dir/docker-compose.yml cp caddy:/data/caddy/pki/authorities/local/root.crt" "$(cat "$E2E_LOG")" "it comes out of the caddy-data volume"
assert_eq "backup.example.com" "$(env_get "$e2e_dir/.env" RESTOW_APP_DOMAIN)" "installed: RESTOW_APP_DOMAIN"
assert_eq "https://backup.example.com" "$(env_get "$e2e_dir/.env" RESTOW_PUBLIC_URL)" "installed: RESTOW_PUBLIC_URL"
assert_eq "192.168.1.20/32" "$(env_get "$e2e_dir/.env" RESTOW_EDGE_TRUSTED_PROXIES)" "installed: the trusted proxy"
assert_eq "internal" "$(env_get "$e2e_dir/.env" RESTOW_EDGE_TLS)" "installed: the edge's own authority"
assert_eq "127.0.0.1:" "$(env_get "$e2e_dir/.env" RESTOW_HTTP_PORT)" "installed: port 80 on the loopback only"
# The last thing printed: the longer list first, then the box, then at most two short lines.
last_lines=$(tail -n 12 "$e2e_out")
assert_lt "$(line_number 'Next steps' "$e2e_out")" "$(line_number 'Restow is running.' "$e2e_out")" "the next steps come above the box"
assert_lt "$(line_number 'Documentation: https://docs.restowbackup.com' "$e2e_out")" "$(line_number 'Restow is running.' "$e2e_out")" "the documentation link is above the box"
assert_contains "    Restow is running.
    Open:         https://backup.example.com  (served by your reverse proxy)
                  Your proxy must forward to https://203.0.113.10:443 (not 80, not 3000)
    Setup token:  $E2E_TOKEN
  ======================================================================
  The token proves you operate this server and works until the setup is done.
  Read it again: cd $e2e_dir && sudo docker compose logs api | grep 'SETUP TOKEN'" "$last_lines" "the box: address, where to forward to, the token"
assert_eq "  Read it again: cd $e2e_dir && sudo docker compose logs api | grep 'SETUP TOKEN'" "$(tail -n 1 "$e2e_out")" "nothing is printed after the box and its two lines"
assert_not_contains "$E2E_OLD_TOKEN" "$out" "the token of an earlier start is not the one shown"
assert_contains "Installation > Notification mail" "$out" "the next steps say where the mail is set up later"
# The token and the secrets are on the terminal, never in the install log.
install_log=$(cat "$E2E_INSTALL_LOG")
assert_not_contains "$E2E_TOKEN" "$install_log" "the setup token is not in the install log"
assert_not_contains "$E2E_OLD_TOKEN" "$install_log" "no setup token at all is in the install log"
assert_not_contains "$(env_get "$e2e_dir/.env" RESTOW_MASTER_KEY)" "$install_log" "the master key is not in the install log"
assert_not_contains "$(env_get "$e2e_dir/.env" POSTGRES_PASSWORD)" "$install_log" "no database password is in the install log"
assert_contains "Restow is running." "$install_log" "the log has the box without the token"
assert_contains "Open:         https://backup.example.com" "$install_log" "the log has the address"
assert_contains "(shown on the terminal only)" "$install_log" "the log says where the token went"
assert_contains "docker compose -f $e2e_dir/docker-compose.yml logs" "$(cat "$E2E_LOG")" "the token was read from the api log"

# --- Option 1, public ------------------------------------------------------------------------
e2e_out="$TMP_ROOT/e2e-public.out"
e2e_main "$(answers_file public 1 backup.example.com "" y yes)" "$e2e_out" --skip-signature-check --dir "$TMP_ROOT/e2e-public"
assert_eq 0 "$E2E_STATUS" "interactive public installation: exit 0"
out=$(cat "$e2e_out")
assert_contains "Domain name of this server (for example backup.example.com): " "$out" "public: the domain question as ever"
assert_contains "ok: ports 80 and 443 are free" "$out" "public: both ports are checked"
assert_contains "backup.example.com resolves to this host" "$out" "public: the DNS check runs"
assert_contains "Address      https://backup.example.com (Let's Encrypt certificate)" "$out" "public: the plan"
assert_contains "    Restow is running.
    Open:         https://backup.example.com
    Setup token:  $E2E_TOKEN
  ======================================================================" "$(tail -n 8 "$e2e_out")" "public: the box has the address and the token, no proxy line"
assert_not_contains "Your proxy must forward" "$out" "public: no word of a proxy"
assert_eq "" "$(env_get "$TMP_ROOT/e2e-public/.env" RESTOW_EDGE_TLS)$(env_get "$TMP_ROOT/e2e-public/.env" RESTOW_EDGE_TRUSTED_PROXIES)" "public: the .env has no proxy keys"
assert_not_contains "$E2E_TOKEN" "$(cat "$E2E_INSTALL_LOG")" "public: the token is not in the install log"
assert_status 1 "public: no root certificate is exported" test -e "$TMP_ROOT/e2e-public/edge-root-ca.crt"

# --- Option 3, local ---------------------------------------------------------------------------
e2e_out="$TMP_ROOT/e2e-local.out"
e2e_main "$(answers_file local 3 "" y yes)" "$e2e_out" --skip-signature-check --dir "$TMP_ROOT/e2e-local"
assert_eq 0 "$E2E_STATUS" "interactive local installation: exit 0"
out=$(cat "$e2e_out")
assert_not_contains "Domain name of this server" "$out" "local: no domain is asked for"
assert_contains "Address      https://localhost (evaluation: the edge's own certificate authority)" "$out" "local: the plan"
assert_contains "    Restow is running.
    Open:         https://localhost  (the browser warns about the certificate)
                  This machine only. For others: --local --domain restow.internal, pointed here.
    Setup token:  $E2E_TOKEN
  ======================================================================" "$(tail -n 9 "$e2e_out")" "local: the box has the exact URL and how to reach it from elsewhere"
assert_not_contains "$E2E_TOKEN" "$(cat "$E2E_INSTALL_LOG")" "local: the token is not in the install log"
# An internal name says how other machines reach it.
e2e_out="$TMP_ROOT/e2e-local-name.out"
e2e_main "$(answers_file localname "" y yes)" "$e2e_out" --local --domain restow.internal --skip-signature-check --dir "$TMP_ROOT/e2e-local-name"
assert_eq 0 "$E2E_STATUS" "local with an internal name: exit 0"
assert_contains "    Open:         https://restow.internal  (the browser warns about the certificate)
                  Other machines: point restow.internal at 203.0.113.10 in DNS or the hosts file." "$(tail -n 9 "$e2e_out")" "local: the box names the address to point the name at"
assert_not_contains "How will people reach Restow?" "$(cat "$e2e_out")" "--local answers the question in advance"

# --- Flags answer the question in advance; the intro is for a first run without them ------------
e2e_out="$TMP_ROOT/e2e-flags.out"
e2e_main "$(answers_file flags "" y yes)" "$e2e_out" --domain backup.example.com --skip-signature-check --dir "$TMP_ROOT/e2e-flags"
assert_eq 0 "$E2E_STATUS" "interactive with --domain: exit 0, as before"
out=$(cat "$e2e_out")
assert_not_contains "How will people reach Restow?" "$out" "--domain: the mode is not asked"
assert_not_contains "This installs the Restow server on this machine" "$out" "--domain: no intro"
assert_contains "Which build?" "$out" "--domain: the build is still asked"
e2e_out="$TMP_ROOT/e2e-flags-proxy.out"
e2e_main "$(answers_file flagsproxy 192.168.1.20 "" y yes)" "$e2e_out" --behind-proxy --domain backup.example.com --version 0.2.0 --skip-signature-check --dir "$TMP_ROOT/e2e-flags-proxy"
assert_eq 0 "$E2E_STATUS" "interactive with --behind-proxy and --domain: only the proxy address is asked"
out=$(cat "$e2e_out")
assert_not_contains "How will people reach Restow?" "$out" "--behind-proxy: the mode is not asked"
assert_contains "Address of your reverse proxy: " "$out" "--behind-proxy: the address is"

# --- Mistakes in the dialogue are explained and asked again ------------------------------------
e2e_out="$TMP_ROOT/e2e-mistakes.out"
e2e_main "$(answers_file mistakes 7 2 192.168.1.9 restow backup.example.com proxy.lan 300.1.1.1 "" 192.168.1.20 "" n)" "$e2e_out" --version 0.2.0 --skip-signature-check --dir "$TMP_ROOT/e2e-mistakes"
assert_eq 10 "$E2E_STATUS" "answering no at the plan: exit 10, nothing installed"
out=$(cat "$e2e_out")
assert_contains "Please answer 1, 2 or 3." "$out" "a wrong menu answer is explained"
assert_contains "use a domain name, not an IP address" "$out" "an IP address as the name is explained"
assert_contains "not a fully qualified domain name: restow" "$out" "a single label as the name is explained"
assert_contains "not an IP address or network: proxy.lan (an IP address such as 192.168.1.20, or a network such as 192.168.1.0/29)" "$out" "a host name as the proxy is explained"
assert_contains "not an IP address or network: 300.1.1.1" "$out" "a bad address as the proxy is explained"
assert_contains "error: aborted; nothing was changed" "$out" "no at the plan stops before any change"
assert_status 1 "no .env after a no" test -e "$TMP_ROOT/e2e-mistakes/.env"

# --- A run without a terminal ----------------------------------------------------------------------
# Output that is collected (a provisioning run) never gets the token, only how to read it.
e2e_dir="$TMP_ROOT/e2e-batch"
e2e_out="$TMP_ROOT/e2e-batch.out"
e2e_main - "$e2e_out" --yes --behind-proxy --domain backup.example.com --proxy-ip 192.168.1.20 --proxy-hop http --skip-signature-check --dir "$e2e_dir"
assert_eq 0 "$E2E_STATUS" "non-interactive installation behind a proxy, plain hop: exit 0"
out=$(cat "$e2e_out")
assert_not_contains "$E2E_TOKEN" "$out" "no terminal: the token is not printed to collected output"
assert_contains "    Setup token:  not shown in this run (no terminal). Read it as below." "$out" "no terminal: the box says so"
assert_contains "Read it again: cd $e2e_dir && sudo docker compose logs api | grep 'SETUP TOKEN'" "$out" "no terminal: and how to read it"
assert_contains "                  Your proxy must forward to http://203.0.113.10:80 (not 3000). That hop is not encrypted." "$out" "plain hop: the box says where to forward to, and that it is not encrypted"
assert_contains "RESTOW_MASTER_KEY is in $e2e_dir/.env and was not shown (non-interactive run)." "$out" "no terminal: the master key is not shown, as before"
assert_not_contains "$E2E_TOKEN" "$(cat "$E2E_INSTALL_LOG")" "no terminal: the token is not in the install log"
assert_eq "http://backup.example.com" "$(env_get "$e2e_dir/.env" RESTOW_APP_DOMAIN)" "plain hop installed: RESTOW_APP_DOMAIN"
assert_eq "" "$(env_get "$e2e_dir/.env" RESTOW_EDGE_TLS)" "plain hop installed: no authority of the edge"
assert_eq "127.0.0.1:" "$(env_get "$e2e_dir/.env" RESTOW_HTTPS_PORT)" "plain hop installed: port 443 on the loopback only"
assert_status 1 "plain hop: no root certificate is exported" test -e "$e2e_dir/edge-root-ca.crt"
assert_contains "warning: --proxy-hop http: the connection between your reverse proxy and this host is NOT encrypted" "$out" "plain hop: warned in the run"
# With the standard output on a terminal, the token is shown there.
e2e_out="$TMP_ROOT/e2e-batch-tty.out"
E2E_STDOUT_TTY=1 e2e_main - "$e2e_out" --yes --domain backup.example.com --skip-signature-check --dir "$TMP_ROOT/e2e-batch-tty"
assert_eq 0 "$E2E_STATUS" "non-interactive installation on a terminal: exit 0"
assert_contains "    Setup token:  $E2E_TOKEN" "$(tail -n 8 "$e2e_out")" "standard output on a terminal: the token is shown"
assert_not_contains "$E2E_TOKEN" "$(cat "$E2E_INSTALL_LOG")" "standard output on a terminal: still not in the install log"

# --- The token cannot be read ---------------------------------------------------------------------
e2e_out="$TMP_ROOT/e2e-notoken.out"
E2E_NO_TOKEN=1 e2e_main "$(answers_file notoken 1 backup.example.com "" y yes)" "$e2e_out" --skip-signature-check --dir "$TMP_ROOT/e2e-notoken"
assert_eq 0 "$E2E_STATUS" "no token in the api log: the installation is still complete (exit 0)"
assert_eq "    Restow is running.
    Open:         https://backup.example.com
    Setup token:  not in the api log yet. Read it as below.
  ======================================================================
  The token proves you operate this server and works until the setup is done.
  Read it again: cd $TMP_ROOT/e2e-notoken && sudo docker compose logs api | grep 'SETUP TOKEN'" "$(tail -n 7 "$e2e_out" | tail -n +2)" "no token: the box says so and gives the command"
assert_not_contains "K7PQX" "$(cat "$e2e_out")" "no token: nothing invented"

# --- Running it again: the same box for an installation that exists ----------------------------------
e2e_out="$TMP_ROOT/e2e-again.out"
e2e_dir="$TMP_ROOT/e2e-proxy"
e2e_main - "$e2e_out" --yes --skip-signature-check --dir "$e2e_dir"
assert_eq 0 "$E2E_STATUS" "running it again on a proxy installation: exit 0"
out=$(cat "$e2e_out")
assert_contains "Existing installation in $e2e_dir" "$out" "again: the installation is found"
assert_not_contains "This installs the Restow server on this machine" "$out" "again: no intro"
assert_not_contains "How will people reach Restow?" "$out" "again: no question"
assert_contains "Your proxy must forward to https://203.0.113.10:443 (not 80, not 3000)" "$out" "again: the mode is read from .env"
assert_contains "ok: $e2e_dir/edge-root-ca.crt is here already" "$out" "again: the exported certificate is kept"
assert_not_contains "Setup token:  $E2E_TOKEN" "$out" "again, without a terminal: the token is not printed"
assert_not_contains "$E2E_TOKEN" "$(cat "$E2E_INSTALL_LOG")" "again: the token is not in the install log"
e2e_out="$TMP_ROOT/e2e-again-done.out"
E2E_CONFIGURED=1 e2e_main - "$e2e_out" --yes --skip-signature-check --dir "$e2e_dir"
assert_eq 0 "$E2E_STATUS" "running it again after the setup: exit 0"
assert_contains "    Setup:        complete, no token needed." "$(cat "$e2e_out")" "after the setup: no token, and the box says so"
assert_not_contains "Read it again" "$(cat "$e2e_out")" "after the setup: nothing to read again"
e2e_out="$TMP_ROOT/e2e-again-flag.out"
e2e_main - "$e2e_out" --yes --behind-proxy --skip-signature-check --dir "$TMP_ROOT/e2e-public"
assert_eq 8 "$E2E_STATUS" "--behind-proxy on a public installation: refused, nothing changed"
assert_contains "this installation was not set up behind a reverse proxy" "$(cat "$e2e_out")" "the refusal says why"

# The setup token of .env (RESTOW_SETUP_TOKEN) is the operator's own and is not printed.
dir_env_token="$TMP_ROOT/e2e-env-token"
mkdir -p "$dir_env_token"
printf 'RESTOW_SETUP_TOKEN=0123456789abcdef0123\n' >"$dir_env_token/.env" # gitleaks:allow (made-up test token)
out=$( (
  PATH="$E2E_STUBS:$PATH"
  OPT_DIR=$dir_env_token MODE=public PUBLIC_URL=https://backup.example.com DOMAIN=backup.example.com INTERACTIVE=0
  LOG_READY=0
  resolve_setup_token
  final_block_lines "$TOKEN_STATE" "$TOKEN_VALUE"
) )
assert_contains "Setup token:  the value of RESTOW_SETUP_TOKEN in $dir_env_token/.env" "$out" "RESTOW_SETUP_TOKEN: named, not printed"
assert_not_contains "0123456789abcdef0123" "$out" "RESTOW_SETUP_TOKEN: never printed"

printf '\n%s passed, %s failed\n' "$PASSED" "$FAILED"
[ "$FAILED" -eq 0 ]
