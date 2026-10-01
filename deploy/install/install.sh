#!/usr/bin/env bash
# Restow server installer.
#
# Installs the Restow server, the Docker Compose stack of deploy/release, on a dedicated
# Linux VM: Debian 12 or 13, Ubuntu 22.04, 24.04 or 26.04, amd64 or arm64 (the releases
# Docker's apt repository serves for both architectures). It
#   - checks the machine (root, system, architecture, virtualization, memory, disk, ports
#     80 and 443, outbound HTTPS, clock, DNS of the domain, an earlier installation),
#   - installs Docker Engine and the Compose plugin from Docker's signed apt repository
#     when Docker is missing (never with get.docker.com),
#   - downloads docker-compose.yml and env.example of one pinned release and checks them
#     against the release's SHA256SUMS and that file's keyless cosign signature,
#   - writes .env (mode 0600) with secrets from the kernel's random generator,
#   - pulls the two images of the chosen build, checks their cosign signatures (the
#     release workflow of exactly this version) and starts the stack.
#
# Recommended use (README.md, "Install with the script"): download, check, then run.
#
#   curl -fsSLO https://github.com/restow-backup/restow/releases/download/v0.1.0/install.sh
#   curl -fsSLO https://github.com/restow-backup/restow/releases/download/v0.1.0/install.sh.sha256
#   sha256sum -c install.sh.sha256 && sudo bash install.sh
#
# `bash install.sh --help` lists the options and the exit codes. Running it again is
# safe: it never overwrites .env, a secret or data, and it never updates or removes an
# installation (updates: docs/UPDATING.md; removal: README.md, "Removing Restow").
# Log: /var/log/restow-install.log, without secrets.
#
# Everything below is a function; the last line calls main, so a download that was cut
# off half way runs nothing.

if [ -z "${BASH_VERSION:-}" ]; then
  echo "error: run this script with bash: sudo bash install.sh" >&2
  exit 2
fi
set -Eeuo pipefail

# ---- The release this script belongs to ---------------------------------------------
# The release workflow refuses a tag whose version differs from this line
# (.github/workflows/release.yml, job verify).
DEFAULT_VERSION="0.1.0"

RELEASE_REPOSITORY="restow-backup/restow"
RELEASE_URL_DEFAULT="https://github.com/${RELEASE_REPOSITORY}/releases/download"
IMAGE_PREFIX_DEFAULT="ghcr.io/restow-backup"
# Who signs a release (docs/UPDATING.md, "What is verified"): the release workflow run of
# the tag, through GitHub's OIDC issuer.
SIGNER_ISSUER="https://token.actions.githubusercontent.com"
# cosign v3.1.3, the version the release workflow signs with, pinned by digest: the same
# image the opt-in updater verifies with (apps/api/src/updater/signature.ts).
COSIGN_IMAGE="ghcr.io/sigstore/cosign/cosign:v3.1.3@sha256:9e5c2f2edc34351160407ca3416c61855bdf9403c3c5936e0f0be7fc261611b8"
# Docker's apt repository signing key, "Docker Release (CE deb) <docker@docker.com>".
DOCKER_REPO_FINGERPRINT="9DC858229FC7DD38854AE2D88D81803C0EBFCD88"

# ---- Limits -------------------------------------------------------------------------
MIN_DOCKER_VERSION="24.0"
MIN_COMPOSE_VERSION="2.20"
# A VM with 4 GiB reports a little less (the kernel keeps some), hence 3.5 and 7 GiB.
MIN_MEMORY_KIB=3670016
RECOMMENDED_MEMORY_KIB=7340032
# The installation directory holds the compose file, .env and the import folder.
MIN_DIR_DISK_KIB=1048576
# Docker's data directory holds the images, the database and, until another storage
# target is added, the local chunk store (a Docker volume).
MIN_DOCKER_DISK_KIB=10485760
RECOMMENDED_DOCKER_DISK_KIB=52428800
HEALTH_TIMEOUT_SECONDS=600

# ---- Exit codes (also in --help and README.md) -----------------------------------------
EXIT_ERROR=1
EXIT_USAGE=2
EXIT_PREFLIGHT=3
EXIT_DOCKER=4
EXIT_DOWNLOAD=5
EXIT_SIGNATURE=6
EXIT_START=7
EXIT_EXISTING=8
EXIT_ABORTED=10

# ---- Paths (the tests point them at fixtures) -------------------------------------------
OS_RELEASE_FILE=/etc/os-release
MEMINFO_FILE=/proc/meminfo
LOG_FILE=/var/log/restow-install.log
APT_SOURCES_DIR=/etc/apt/sources.list.d
APT_KEYRINGS_DIR=/etc/apt/keyrings

# ---- Options --------------------------------------------------------------------------
OPT_DOMAIN=""
OPT_EDITION=""
OPT_VERSION=""
OPT_DIR="/opt/restow"
OPT_YES=0
OPT_DRY_RUN=0
OPT_SKIP_SIGNATURES=0
OPT_LOCAL=0
OPT_UPDATER=0
ACTION="install"

# ---- State ----------------------------------------------------------------------------
LOG_READY=0
INTERACTIVE=0
WARNINGS=0
PREFLIGHT_FAILED=0
WORK=""
ENV_TMP=""
OS_ID=""
OS_VERSION_ID=""
OS_CODENAME=""
OS_PRETTY=""
ARCH=""
VIRT_CONTAINER=""
DOCKER_STATE=""
DOCKER_COMPOSE_INSTALL=0
EDITION=""
VERSION=""
DOMAIN=""
PUBLIC_URL=""
APP_IMAGE=""
WEB_IMAGE=""
MASTER_KEY_ONCE=""
LOCAL_MODE=0
DOMAIN_PLACEHOLDER=0

VERSION_RE='^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$'
HOSTNAME_RE='^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'
IPV4_RE='^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'
DIR_RE='^/[A-Za-z0-9._/-]+$'
# The keys of .env the installer fills in; every one of them must end up non-empty.
REQUIRED_ENV_NAMES="RESTOW_IMAGE RESTOW_WEB_IMAGE RESTOW_PUBLIC_URL RESTOW_APP_DOMAIN POSTGRES_PASSWORD DATABASE_MIGRATION_URL DATABASE_URL DATABASE_PROVIDER_URL RESTOW_MASTER_KEY BETTER_AUTH_SECRET"

usage() {
  cat <<USAGE
Usage: sudo bash install.sh [options]

Installs the Restow server (the Docker Compose stack of release v${DEFAULT_VERSION}) on this
machine: a dedicated VM with Debian 12 or 13 or Ubuntu 22.04, 24.04 or 26.04, amd64 or
arm64.

Options:
  --domain NAME            domain name of this server, e.g. backup.example.com. It must
                           resolve to this host, with ports 80 and 443 reachable from the
                           internet, for the Let's Encrypt certificate. Asked for when
                           missing; required with --non-interactive.
  --edition full|community the build to install (default: full)
                             full       the Apache-2.0 core plus the Business and Service
                                        Provider modules, locked until a license key is
                                        installed
                             community  the Apache-2.0 core only
  --version X.Y.Z          the release to install (default: ${DEFAULT_VERSION}, the release this
                           script belongs to)
  --dir PATH               installation directory (default: /opt/restow)
  -y, --yes, --non-interactive
                           ask nothing: take the options and the defaults. The master key
                           is then not shown; read it from .env and store it offline.
  --no-updater             leave the opt-in updater off (the default)
  --with-updater           also start the opt-in updater (compose profile "updater"). It
                           mounts the Docker socket: read docs/UPDATING.md first.
  --local                  evaluation only: no public domain, no Let's Encrypt. The edge
                           serves https://localhost (or the internal name given with
                           --domain: *.internal, *.home.arpa, *.localhost) over HTTPS
                           with a certificate from Caddy's own local authority, which
                           browsers warn about. Passkeys are not offered. Not for
                           production. (--http-local is a deprecated name for it.)
  --skip-signature-check   do NOT check the cosign signatures of the release files and
                           images (their checksums are still checked). For tests and
                           unsigned mirrors only, never for production.
  --dry-run                run the checks and print what would be done; change nothing
  --upgrade                print how to update an installation; this script never updates
  -h, --help               show this help

Exit codes:
  0   installed and running, already installed and running, or nothing to do
      (--help, --upgrade, --dry-run)
  1   unexpected error
  2   invalid options, or no terminal for the questions (use --non-interactive)
  3   a preflight check failed; nothing was changed
  4   Docker could not be installed or does not work
  5   a release file or image could not be downloaded, or a release file failed its
      checksum or signature check
  6   an image failed its signature check (the image was removed again)
  7   the stack did not start or did not become healthy
  8   an existing installation or its data is in the way; nothing was changed
  10  aborted at a question
  130 interrupted

Not provided on purpose: --uninstall (README.md, "Removing Restow", has the manual steps).
Log: ${LOG_FILE} (no secrets).
Environment, for tests and mirrors only (each one prints a warning):
  RESTOW_INSTALL_RELEASE_URL   base URL of the release files, read from <base>/v<version>/
                               (default ${RELEASE_URL_DEFAULT})
  RESTOW_INSTALL_IMAGE_PREFIX  registry and owner of the images (default ${IMAGE_PREFIX_DEFAULT})
USAGE
}

# ---- Output and log ------------------------------------------------------------------
# Nothing that is logged or printed carries a secret: the secrets are generated into
# variables, handed to awk through its environment (never a command line) and written
# to .env only. The one exception is the master key, shown once on the terminal
# (/dev/tty, never the log) in an interactive run.

log_line() {
  if [ "$LOG_READY" = 1 ]; then
    printf '%s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" >>"$LOG_FILE" 2>/dev/null || true
  fi
}
say() {
  printf '%s\n' "$*"
  log_line "$*"
}
step() {
  printf '\n==> %s\n' "$*"
  log_line "==> $*"
}
ok() {
  printf '    ok: %s\n' "$*"
  log_line "ok: $*"
}
warn() {
  WARNINGS=$((WARNINGS + 1))
  printf 'warning: %s\n' "$*" >&2
  log_line "warning: $*"
}
error_line() {
  printf 'error: %s\n' "$*" >&2
  log_line "error: $*"
}
die() {
  local code=$1
  shift
  error_line "$*"
  if [ "$LOG_READY" = 1 ]; then
    printf '       log: %s\n' "$LOG_FILE" >&2
  fi
  exit "$code"
}
is_dry() {
  [ "$OPT_DRY_RUN" = 1 ]
}
dry() {
  printf '    [dry-run] would %s\n' "$*"
}

# Run a command that changes something; its output goes to the log. Never give it a
# secret as an argument: the arguments are logged (and visible in the process list).
run() {
  local shown="$*"
  if [ "$1" = compose ]; then
    shown="docker compose ${*:2}"
  fi
  if is_dry; then
    dry "run: $shown"
    return 0
  fi
  log_line "run: $shown"
  if [ "$LOG_READY" = 1 ]; then
    "$@" </dev/null >>"$LOG_FILE" 2>&1
  else
    "$@" </dev/null >&2
  fi
}

init_log() {
  if is_dry; then
    return 0
  fi
  if (umask 077 && : >>"$LOG_FILE") 2>/dev/null; then
    chmod 600 "$LOG_FILE" 2>/dev/null || true
    LOG_READY=1
    log_line "---- install.sh (release v${DEFAULT_VERSION}) started with: $*"
  else
    warn "cannot write the log file $LOG_FILE; command output goes to the terminal"
  fi
}

on_error() {
  # Only the main shell reports; a failing command substitution reports through it.
  if [ "${BASH_SUBSHELL:-0}" -eq 0 ]; then
    error_line "unexpected failure (exit code $1, line $2)"
    if [ "$LOG_READY" = 1 ]; then
      printf '       log: %s\n' "$LOG_FILE" >&2
    fi
  fi
}

cleanup() {
  if [ -n "$ENV_TMP" ] && [ -f "$ENV_TMP" ]; then
    rm -f "$ENV_TMP"
  fi
  case $WORK in
    */restow-install.*)
      if [ -d "$WORK" ]; then
        rm -rf "$WORK"
      fi
      ;;
  esac
}

# ---- Questions -------------------------------------------------------------------------

setup_interaction() {
  if [ "$OPT_YES" = 1 ] || is_dry; then
    INTERACTIVE=0
    return 0
  fi
  # `curl ... | sudo bash` feeds the script on stdin: questions go to the terminal.
  if (exec </dev/tty) 2>/dev/null; then
    INTERACTIVE=1
  else
    die "$EXIT_USAGE" "no terminal to ask questions on. Run with --non-interactive and the options you need (at least --domain)."
  fi
}

# ask <variable> <question> [default]: sets the caller's variable (no local of that name here).
ask() {
  local ask_reply=""
  if [ -n "${3:-}" ]; then
    printf '%s [%s]: ' "$2" "$3" >/dev/tty
  else
    printf '%s: ' "$2" >/dev/tty
  fi
  if ! IFS= read -r ask_reply </dev/tty; then
    printf '\n' >/dev/tty
    die "$EXIT_ABORTED" "no answer; nothing was changed"
  fi
  printf -v "$1" '%s' "${ask_reply:-${3:-}}"
}

# confirm <question>: yes only for an explicit yes; --yes answers yes.
confirm() {
  local answer=""
  if [ "$INTERACTIVE" != 1 ]; then
    return 0
  fi
  printf '%s [y/N] ' "$1" >/dev/tty
  if ! IFS= read -r answer </dev/tty; then
    printf '\n' >/dev/tty
    return 1
  fi
  case $answer in
    y | Y | yes | Yes | YES) return 0 ;;
  esac
  return 1
}

# ---- Pure helpers (covered by deploy/install/test.sh) ---------------------------------

to_lower() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]'
}

valid_version() {
  [[ $1 =~ $VERSION_RE ]]
}

# version_ge <have> <need>: dotted numeric versions, a leading v and suffixes ignored.
version_ge() {
  awk -v have="$1" -v need="$2" 'BEGIN {
    sub(/^v/, "", have); sub(/^v/, "", need)
    sub(/[-+~].*$/, "", have); sub(/[-+~].*$/, "", need)
    nh = split(have, h, "."); nn = split(need, n, ".")
    for (i = 1; i <= 3; i++) {
      a = (i <= nh) ? h[i] + 0 : 0
      b = (i <= nn) ? n[i] + 0 : 0
      if (a > b) exit 0
      if (a < b) exit 1
    }
    exit 0
  }'
}

valid_dir() {
  local dir=$1
  [[ $dir =~ $DIR_RE ]] || return 1
  case "$dir/" in
    */../* | */./* | *//*) return 1 ;;
  esac
  # Never a system directory itself: the installer creates and fills it.
  case $dir in
    / | /bin | /boot | /dev | /etc | /home | /lib | /lib64 | /media | /mnt | /opt | /proc | /root | /run | /sbin | /srv | /sys | /tmp | /usr | /var | /var/lib | /var/log | /usr/local)
      return 1
      ;;
  esac
  return 0
}

# normalize_domain <input>: lower case, without scheme, path or trailing dot.
normalize_domain() {
  local domain
  domain=$(to_lower "$1")
  domain=${domain#http://}
  domain=${domain#https://}
  domain=${domain%%/*}
  domain=${domain%.}
  printf '%s' "$domain"
}

# domain_kind <normalized domain>: public | internal | single | ip | invalid
domain_kind() {
  local domain=$1
  if [[ $domain =~ $IPV4_RE ]]; then
    echo ip
    return 0
  fi
  case $domain in
    *:* | *\[*)
      echo ip
      return 0
      ;;
  esac
  if [ -z "$domain" ] || [ "${#domain}" -gt 253 ] || ! [[ $domain =~ $HOSTNAME_RE ]]; then
    echo invalid
    return 0
  fi
  # Names Caddy never asks a public authority for; it issues them from its own.
  case $domain in
    localhost | *.localhost | *.internal | *.home.arpa)
      echo internal
      return 0
      ;;
  esac
  case $domain in
    *.*) echo public ;;
    *) echo single ;;
  esac
  return 0
}

# domain_problem <normalized domain> <local 0|1>: prints what is wrong, nothing if fine.
domain_problem() {
  case "$(domain_kind "$1")" in
    ip)
      echo "use a domain name, not an IP address: the certificate and passkeys need a name"
      ;;
    invalid)
      echo "not a valid domain name: $1"
      ;;
    single)
      echo "not a fully qualified domain name: $1 (for example backup.example.com)"
      ;;
    internal)
      if [ "$2" != 1 ]; then
        echo "$1 is an internal name that gets no public certificate; use a public domain, or --local for an evaluation"
      fi
      ;;
    public)
      if [ "$2" = 1 ]; then
        echo "--local takes localhost or an internal name (*.internal, *.home.arpa, *.localhost), not the public domain $1"
      fi
      ;;
  esac
  return 0
}

os_release_value() {
  local value
  value=$(awk -v key="$2" 'index($0, key "=") == 1 { print substr($0, length(key) + 2); exit }' "$1")
  value=${value#\"}
  value=${value%\"}
  value=${value#\'}
  value=${value%\'}
  printf '%s' "$value"
}

# The releases Docker's apt repository serves for amd64 and arm64 (checked 2026-10-01 on
# https://download.docker.com/linux/{debian,ubuntu}/dists/), with their codenames.
supported_codename() {
  case "$1:$2" in
    debian:12) echo bookworm ;;
    debian:13) echo trixie ;;
    ubuntu:22.04) echo jammy ;;
    ubuntu:24.04) echo noble ;;
    ubuntu:26.04) echo resolute ;;
    *) return 1 ;;
  esac
}

os_supported() {
  supported_codename "$1" "$2" >/dev/null
}

normalize_arch() {
  case $1 in
    x86_64 | amd64) echo amd64 ;;
    aarch64 | arm64) echo arm64 ;;
    *) echo "" ;;
  esac
}

# virt_verdict <container type>: ok | warn | fail ("none" or empty: not a container)
virt_verdict() {
  case $1 in
    "" | none) echo ok ;;
    lxc | lxc-libvirt | openvz | systemd-nspawn) echo warn ;;
    docker | podman | rkt | wsl | proot | pouch) echo fail ;;
    *) echo warn ;;
  esac
}

# level_verdict <value> <minimum> <recommended>: fail | warn | ok
level_verdict() {
  case $1 in
    "" | *[!0-9]*)
      echo fail
      return 0
      ;;
  esac
  if [ "$1" -lt "$2" ]; then
    echo fail
  elif [ "$1" -lt "$3" ]; then
    echo warn
  else
    echo ok
  fi
}

kib_to_gib() {
  awk -v kib="$1" 'BEGIN { printf "%.1f", kib / 1048576 }'
}

# busy_ports <ss -Hltn output> <port...>: the given ports something listens on.
busy_ports() {
  local listening=$1 port found=""
  shift
  for port in "$@"; do
    if printf '%s\n' "$listening" | awk -v port="$port" '{ n = split($4, p, ":"); if (p[n] == port) hit = 1 } END { exit !hit }'; then
      found="$found $port"
    fi
  done
  printf '%s' "${found# }"
}

# dns_verdict <resolved addresses> <addresses of this host>: match | nomatch | loopback | unresolved
dns_verdict() {
  local resolved=$1 own=$2 address remote=""
  if [ -z "${resolved// /}" ]; then
    echo unresolved
    return 0
  fi
  for address in $resolved; do
    case $address in
      127.* | ::1) ;;
      *) remote="$remote $address" ;;
    esac
  done
  if [ -z "$remote" ]; then
    echo loopback
    return 0
  fi
  for address in $remote; do
    case " $own " in
      *" $address "*)
        echo match
        return 0
        ;;
    esac
  done
  echo nomatch
}

# existing_verdict <.env present 0|1> <restow data volumes> <working dirs of restow containers> <dir>
#   fresh | resume | conflict-data | conflict-dir
existing_verdict() {
  local env_present=$1 volumes=$2 dirs=$3 dir=$4 other
  for other in $dirs; do
    if [ "$other" != "$dir" ]; then
      echo conflict-dir
      return 0
    fi
  done
  if [ "$env_present" = 1 ]; then
    echo resume
  elif [ -n "${volumes// /}" ] || [ -n "${dirs// /}" ]; then
    echo conflict-data
  else
    echo fresh
  fi
}

# image_names <edition>: "<application repository> <web repository>" (names only)
image_names() {
  case $1 in
    full) echo "restow restow-web" ;;
    community) echo "restow-community restow-web-community" ;;
    *) return 1 ;;
  esac
}

image_prefix() {
  local prefix=${RESTOW_INSTALL_IMAGE_PREFIX:-$IMAGE_PREFIX_DEFAULT}
  printf '%s' "${prefix%/}"
}

# image_repository <reference>: the reference without tag and digest.
image_repository() {
  local ref=${1%%@*} last
  last=${ref##*/}
  case $last in
    *:*) ref=${ref%:*} ;;
  esac
  printf '%s' "$ref"
}

# image_tag <reference>: the tag of a reference, empty when it has none.
image_tag() {
  local ref=${1%%@*} last
  last=${ref##*/}
  case $last in
    *:*) printf '%s' "${last##*:}" ;;
  esac
}

# edition_of_image <application image reference>: full | community | unknown
edition_of_image() {
  local name
  name=$(image_repository "$1")
  name=${name##*/}
  case $name in
    restow) echo full ;;
    restow-community) echo community ;;
    *) echo unknown ;;
  esac
}

signer_identity() {
  printf 'https://github.com/%s/.github/workflows/release.yml@refs/tags/v%s' "$RELEASE_REPOSITORY" "$1"
}

release_base_url() {
  local base=${RESTOW_INSTALL_RELEASE_URL:-$RELEASE_URL_DEFAULT}
  printf '%s/v%s' "${base%/}" "$1"
}

# sums_lookup <SHA256SUMS> <file name>: the checksum listed for exactly that name.
sums_lookup() {
  awk -v name="$2" '
    { file = $2; sub(/^\*/, "", file) }
    file == name { sum = $1; count++ }
    END {
      if (count != 1 || sum !~ /^[0-9a-f]+$/ || length(sum) != 64) exit 1
      print sum
    }' "$1"
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{ print $1 }'
  else
    shasum -a 256 "$1" | awk '{ print $1 }'
  fi
}

# env_get <file> <key>: the value of a key in an env file, read without running it.
# Only for values that are not secret (images, addresses, ports).
env_get() {
  local value
  value=$(awk -v key="$2" 'index($0, key "=") == 1 { value = substr($0, length(key) + 2) } END { print value }' "$1")
  value=${value#\"}
  value=${value%\"}
  printf '%s' "$value"
}

# env_missing_keys <file> <key...>: the keys whose last assignment is missing or empty.
env_missing_keys() {
  local file=$1 key missing=""
  shift
  for key in "$@"; do
    if ! awk -v key="$key" 'index($0, key "=") == 1 { value = substr($0, length(key) + 2) } END { exit (value == "") }' "$file"; then
      missing="$missing $key"
    fi
  done
  printf '%s' "${missing# }"
}

random_hex() {
  od -An -N"$1" -tx1 /dev/urandom | tr -d ' \n'
}

random_base64() {
  head -c "$1" /dev/urandom | base64 | tr -d '\n'
}

# render_env <env.example> <key...>: the template with every assignment of the given keys
# set to the value of the environment variable RI_<key>, keys the template lacks appended.
# The values reach awk through its environment, never its command line.
render_env() {
  local template=$1
  shift
  awk -v keys="$*" '
    BEGIN { n = split(keys, list, " "); for (i = 1; i <= n; i++) wanted[list[i]] = 1 }
    {
      eq = index($0, "=")
      if (eq > 1 && substr($0, 1, 1) != "#") {
        name = substr($0, 1, eq - 1)
        if (name in wanted) { print name "=" ENVIRON["RI_" name]; seen[name] = 1; next }
      }
      print
    }
    END {
      header = 0
      for (i = 1; i <= n; i++) {
        if (list[i] in seen) continue
        if (!header) { print ""; print "# --- Set by install.sh (not in the env.example of this release) ---"; header = 1 }
        print list[i] "=" ENVIRON["RI_" list[i]]
      }
    }' "$template"
}

# ---- Options ---------------------------------------------------------------------------

need_value() {
  if [ -z "${2:-}" ] || [ "${2#-}" != "$2" ]; then
    die "$EXIT_USAGE" "$1 needs a value (see --help)"
  fi
}

parse_args() {
  while [ $# -gt 0 ]; do
    case $1 in
      --domain)
        need_value "$1" "${2:-}"
        OPT_DOMAIN=$2
        shift 2
        ;;
      --domain=*)
        need_value --domain "${1#*=}"
        OPT_DOMAIN=${1#*=}
        shift
        ;;
      --edition)
        need_value "$1" "${2:-}"
        OPT_EDITION=$2
        shift 2
        ;;
      --edition=*)
        need_value --edition "${1#*=}"
        OPT_EDITION=${1#*=}
        shift
        ;;
      --version)
        need_value "$1" "${2:-}"
        OPT_VERSION=$2
        shift 2
        ;;
      --version=*)
        need_value --version "${1#*=}"
        OPT_VERSION=${1#*=}
        shift
        ;;
      --dir)
        need_value "$1" "${2:-}"
        OPT_DIR=$2
        shift 2
        ;;
      --dir=*)
        need_value --dir "${1#*=}"
        OPT_DIR=${1#*=}
        shift
        ;;
      -y | --yes | --non-interactive)
        OPT_YES=1
        shift
        ;;
      --no-updater)
        OPT_UPDATER=0
        shift
        ;;
      --with-updater)
        OPT_UPDATER=1
        shift
        ;;
      --local)
        OPT_LOCAL=1
        shift
        ;;
      --http-local)
        printf 'notice: --http-local is deprecated, use --local (same behaviour: HTTPS with the edge'"'"'s own certificate authority)\n' >&2
        OPT_LOCAL=1
        shift
        ;;
      --skip-signature-check)
        OPT_SKIP_SIGNATURES=1
        shift
        ;;
      --dry-run)
        OPT_DRY_RUN=1
        shift
        ;;
      --upgrade)
        ACTION=upgrade
        shift
        ;;
      --uninstall)
        die "$EXIT_USAGE" "--uninstall is not provided on purpose: removing an installation can destroy backups. README.md, \"Removing Restow\", describes the manual steps."
        ;;
      -h | --help)
        ACTION=help
        shift
        ;;
      *)
        die "$EXIT_USAGE" "unknown option: $1 (see --help)"
        ;;
    esac
  done
  validate_options
}

validate_options() {
  local problem
  if [ -n "$OPT_EDITION" ]; then
    OPT_EDITION=$(to_lower "$OPT_EDITION")
    case $OPT_EDITION in
      full | community) ;;
      *) die "$EXIT_USAGE" "--edition must be full or community (found: $OPT_EDITION)" ;;
    esac
  fi
  if [ -n "$OPT_VERSION" ]; then
    OPT_VERSION=${OPT_VERSION#v}
    valid_version "$OPT_VERSION" || die "$EXIT_USAGE" "--version must be a release version such as ${DEFAULT_VERSION} (found: $OPT_VERSION)"
  fi
  if [ "$OPT_DIR" != / ]; then
    OPT_DIR=${OPT_DIR%/}
  fi
  valid_dir "$OPT_DIR" || die "$EXIT_USAGE" "--dir must be an absolute path of letters, digits, '.', '_', '-' and '/', and not a system directory itself (found: $OPT_DIR)"
  if [ -n "$OPT_DOMAIN" ]; then
    OPT_DOMAIN=$(normalize_domain "$OPT_DOMAIN")
    problem=$(domain_problem "$OPT_DOMAIN" "$OPT_LOCAL")
    if [ -n "$problem" ]; then
      die "$EXIT_USAGE" "--domain: $problem"
    fi
  fi
}

# ---- Preflight -------------------------------------------------------------------------

pf_fail() {
  PREFLIGHT_FAILED=$((PREFLIGHT_FAILED + 1))
  error_line "$*"
}

check_root() {
  if [ "$(id -u)" -eq 0 ]; then
    ok "running as root"
  elif is_dry; then
    warn "not running as root: this dry run cannot see everything (for example Docker's volumes)"
  else
    pf_fail "run the installer as root: sudo bash install.sh"
  fi
}

check_tools() {
  local tool missing=""
  for tool in curl awk sed od base64 tr df mktemp; do
    if ! command -v "$tool" >/dev/null 2>&1; then
      missing="$missing $tool"
    fi
  done
  if [ -n "$missing" ]; then
    pf_fail "missing commands:$missing (apt-get install curl ca-certificates coreutils)"
  fi
}

check_os() {
  local reported
  if [ ! -r "$OS_RELEASE_FILE" ]; then
    pf_fail "cannot read $OS_RELEASE_FILE: unsupported operating system"
    return 0
  fi
  OS_ID=$(os_release_value "$OS_RELEASE_FILE" ID)
  OS_VERSION_ID=$(os_release_value "$OS_RELEASE_FILE" VERSION_ID)
  OS_PRETTY=$(os_release_value "$OS_RELEASE_FILE" PRETTY_NAME)
  reported=$(os_release_value "$OS_RELEASE_FILE" VERSION_CODENAME)
  if [ -z "$reported" ]; then
    reported=$(os_release_value "$OS_RELEASE_FILE" UBUNTU_CODENAME)
  fi
  # The suite of Docker's apt repository comes from the supported release, not from
  # whatever the file claims.
  if ! OS_CODENAME=$(supported_codename "$OS_ID" "$OS_VERSION_ID"); then
    OS_CODENAME=""
    pf_fail "unsupported operating system: ${OS_PRETTY:-${OS_ID:-unknown} ${OS_VERSION_ID}}. The installer supports Debian 12 and 13 and Ubuntu 22.04, 24.04 and 26.04 (the releases Docker's apt repository serves for amd64 and arm64); elsewhere install with Docker Compose by hand (README.md, \"Install by hand with Docker Compose\")."
    return 0
  fi
  ok "${OS_PRETTY:-$OS_ID $OS_VERSION_ID}"
  if [ -n "$reported" ] && [ "$reported" != "$OS_CODENAME" ]; then
    warn "$OS_RELEASE_FILE names the codename $reported, expected $OS_CODENAME for $OS_ID $OS_VERSION_ID; Docker's repository is used for $OS_CODENAME"
  fi
}

check_arch() {
  local machine
  machine=$(uname -m)
  ARCH=$(normalize_arch "$machine")
  if [ -n "$ARCH" ]; then
    ok "architecture $ARCH"
  else
    pf_fail "unsupported architecture: $machine (the release images are built for amd64 and arm64)"
  fi
}

detect_container() {
  local environ
  if command -v systemd-detect-virt >/dev/null 2>&1; then
    systemd-detect-virt --container 2>/dev/null || true
    return 0
  fi
  if [ -f /.dockerenv ]; then
    echo docker
    return 0
  fi
  if [ -r /proc/1/environ ]; then
    environ=$(tr '\0' '\n' </proc/1/environ 2>/dev/null || true)
    case $environ in
      *container=lxc*)
        echo lxc
        return 0
        ;;
      *container=*)
        echo unknown-container
        return 0
        ;;
    esac
  fi
  echo none
}

detect_vm() {
  if command -v systemd-detect-virt >/dev/null 2>&1; then
    systemd-detect-virt --vm 2>/dev/null || true
  else
    echo unknown
  fi
}

check_virtualization() {
  local vm
  VIRT_CONTAINER=$(detect_container)
  case "$(virt_verdict "$VIRT_CONTAINER")" in
    fail)
      pf_fail "this is a $VIRT_CONTAINER container: the installer does not run inside Docker, Podman or WSL. Use a dedicated VM."
      return 0
      ;;
    warn)
      case $VIRT_CONTAINER in
        lxc | lxc-libvirt)
          warn "this is an LXC container. Docker in LXC is best effort: the container needs nesting and keyctl (Proxmox: Options > Features > nesting=1, keyctl=1; an unprivileged container is safer), and some kernels and AppArmor profiles still break it. A dedicated VM is the recommended platform."
          ;;
        openvz)
          warn "this is an OpenVZ container. Docker rarely works there (it needs a recent kernel with overlay and cgroup support from the host). Best effort only; a dedicated VM is the recommended platform."
          ;;
        *)
          warn "this is a container ($VIRT_CONTAINER). Docker in a container is best effort; a dedicated VM is the recommended platform."
          ;;
      esac
      return 0
      ;;
  esac
  vm=$(detect_vm)
  case $vm in
    none) ok "physical machine (no hypervisor found); keep it apart from the hardware of the systems it backs up" ;;
    unknown | "") warn "could not tell whether this is a VM (no systemd-detect-virt)" ;;
    *) ok "virtual machine ($vm)" ;;
  esac
}

check_memory() {
  local kib label=unknown
  kib=$(awk '/^MemTotal:/ { print $2 }' "$MEMINFO_FILE" 2>/dev/null || true)
  if [ -n "$kib" ]; then
    label="$(kib_to_gib "$kib") GiB"
  fi
  case "$(level_verdict "$kib" "$MIN_MEMORY_KIB" "$RECOMMENDED_MEMORY_KIB")" in
    ok) ok "memory $label" ;;
    warn) warn "memory $label: it runs, 8 GiB are recommended (mail parsing runs in helper processes of up to 512 MB each; set IMPORT_PARSE_WORKERS=1 and PREVIEW_PARSE_WORKERS=1 in .env on a small host)" ;;
    fail) pf_fail "memory $label: Restow needs at least 4 GiB (8 GiB recommended)" ;;
  esac
}

check_time_sync() {
  local synced=""
  if command -v timedatectl >/dev/null 2>&1; then
    synced=$(timedatectl show -p NTPSynchronized --value 2>/dev/null || true)
  fi
  case $synced in
    yes) ok "clock synchronised" ;;
    no) warn "the clock is not synchronised: certificates, signature checks and authenticator codes need the right time. Turn on NTP: timedatectl set-ntp true" ;;
    *) warn "could not check the clock synchronisation (timedatectl)" ;;
  esac
}

dpkg_installed() {
  local status
  # shellcheck disable=SC2016 # ${Status} is dpkg-query's format, not a shell expansion
  status=$(dpkg-query -W -f='${Status}' "$1" 2>/dev/null || true)
  [ "$status" = "install ok installed" ]
}

docker_state() {
  local path
  path=$(command -v docker 2>/dev/null || true)
  if [ -z "$path" ]; then
    echo missing
  elif [ "${path#/snap/}" != "$path" ]; then
    echo snap
  elif docker info >/dev/null 2>&1; then
    echo ok
  else
    echo no-daemon
  fi
}

docker_server_version() {
  docker version --format '{{.Server.Version}}' 2>/dev/null || true
}

compose_version() {
  docker compose version --short 2>/dev/null || true
}

# Checks a running Docker; prints why it does not fit, nothing when it does.
docker_version_problem() {
  local server compose
  server=$(docker_server_version)
  if ! version_ge "$server" "$MIN_DOCKER_VERSION"; then
    echo "Docker Engine ${server:-unknown} is too old (at least $MIN_DOCKER_VERSION). Update it from Docker's apt repository (https://docs.docker.com/engine/install/), or remove it and run the installer again."
    return 0
  fi
  compose=$(compose_version)
  if [ -z "$compose" ]; then
    if dpkg_installed docker-ce; then
      return 0
    fi
    echo "the Docker Compose plugin (docker compose) is missing. Install docker-compose-plugin from Docker's apt repository, or the package docker-compose-v2 of your distribution."
    return 0
  fi
  if ! version_ge "$compose" "$MIN_COMPOSE_VERSION"; then
    echo "Docker Compose $compose is too old (at least $MIN_COMPOSE_VERSION)."
  fi
  return 0
}

conflicting_packages() {
  local package found=""
  for package in docker.io docker-doc docker-compose docker-compose-v2 podman-docker containerd runc; do
    if dpkg_installed "$package"; then
      found="$found $package"
    fi
  done
  printf '%s' "${found# }"
}

check_docker() {
  local problem conflicts
  DOCKER_STATE=$(docker_state)
  case $DOCKER_STATE in
    missing)
      conflicts=$(conflicting_packages)
      if [ -n "$conflicts" ]; then
        pf_fail "Docker is not installed, but packages that conflict with Docker's own are: $conflicts. Remove them (apt-get remove $conflicts) or install Docker yourself, then run the installer again."
      else
        ok "Docker is not installed yet: it will be installed from Docker's apt repository"
      fi
      ;;
    snap)
      pf_fail "Docker from snap is not supported (its confinement keeps it from mounting $OPT_DIR). Remove it (snap remove docker) and run the installer again; it installs Docker from Docker's apt repository."
      ;;
    no-daemon)
      warn "Docker is installed but does not answer; the installer will try to start it"
      ;;
    ok)
      problem=$(docker_version_problem)
      if [ -n "$problem" ]; then
        pf_fail "$problem"
      elif [ -z "$(compose_version)" ]; then
        DOCKER_COMPOSE_INSTALL=1
        ok "Docker $(docker_server_version); the Compose plugin will be installed"
      else
        ok "Docker $(docker_server_version), Compose $(compose_version)"
      fi
      ;;
  esac
}

# reachable <url>: any HTTP answer counts; only a failed connection does not.
reachable() {
  local code
  code=$(curl -sS -o /dev/null --max-time 10 -w '%{http_code}' "$1" 2>/dev/null || true)
  [ -n "$code" ] && [ "$code" != 000 ]
}

url_origin() {
  printf '%s' "$1" | sed -E 's#^([a-zA-Z]+://[^/]+).*$#\1#'
}

check_network() {
  local release_origin image_origin url
  release_origin=$(url_origin "${RESTOW_INSTALL_RELEASE_URL:-$RELEASE_URL_DEFAULT}")
  image_origin="https://$(image_prefix | sed 's#/.*$##')"
  for url in "$release_origin/" "https://ghcr.io/v2/" "https://registry-1.docker.io/v2/"; do
    if reachable "$url"; then
      ok "outbound HTTPS to $(url_origin "$url")"
    else
      pf_fail "no outbound HTTPS connection to $(url_origin "$url") (release files and images come from there; check the firewall and the proxy)"
    fi
  done
  if [ -n "${RESTOW_INSTALL_IMAGE_PREFIX:-}" ] && [ "$image_origin" != "https://ghcr.io" ]; then
    if reachable "$image_origin/v2/"; then
      ok "outbound HTTPS to $image_origin"
    else
      warn "no HTTPS answer from $image_origin (RESTOW_INSTALL_IMAGE_PREFIX); fine when its images are loaded on this host already"
    fi
  fi
  if [ "$DOCKER_STATE" = missing ]; then
    if reachable "https://download.docker.com/"; then
      ok "outbound HTTPS to https://download.docker.com"
    else
      pf_fail "no outbound HTTPS connection to https://download.docker.com (Docker's apt repository)"
    fi
  fi
  if [ "$OPT_SKIP_SIGNATURES" != 1 ]; then
    if reachable "https://tuf-repo-cdn.sigstore.dev/"; then
      ok "outbound HTTPS to https://tuf-repo-cdn.sigstore.dev (signature checks)"
    else
      pf_fail "no outbound HTTPS connection to https://tuf-repo-cdn.sigstore.dev, which the signature checks need (Sigstore's trust root)"
    fi
  fi
}

# Available KiB on the file system that holds <path> (or its nearest existing parent).
avail_kib() {
  local path=$1
  while [ ! -e "$path" ] && [ "$path" != / ]; do
    path=$(dirname "$path")
  done
  df -Pk "$path" 2>/dev/null | awk 'NR == 2 { print $4 }'
}

check_disk() {
  local kib root
  kib=$(avail_kib "$OPT_DIR")
  case "$(level_verdict "$kib" "$MIN_DIR_DISK_KIB" "$MIN_DIR_DISK_KIB")" in
    ok) ok "$(kib_to_gib "$kib") GiB free for $OPT_DIR" ;;
    *) pf_fail "only ${kib:-0} KiB free for $OPT_DIR (at least 1 GiB)" ;;
  esac
  root=""
  if [ "$DOCKER_STATE" = ok ]; then
    root=$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || true)
  fi
  root=${root:-/var/lib/docker}
  kib=$(avail_kib "$root")
  case "$(level_verdict "$kib" "$MIN_DOCKER_DISK_KIB" "$RECOMMENDED_DOCKER_DISK_KIB")" in
    ok) ok "$(kib_to_gib "$kib") GiB free for Docker ($root)" ;;
    warn) warn "$(kib_to_gib "$kib") GiB free for Docker ($root). It is enough to start; but until you add another storage target the backups go into a Docker volume there. 50 GiB or more are recommended, or an off-site target (S3 with Object Lock)." ;;
    fail) pf_fail "only $(kib_to_gib "${kib:-0}") GiB free for Docker ($root): at least 10 GiB are needed for the images and the database" ;;
  esac
}

check_ports() {
  local listening busy
  if ! command -v ss >/dev/null 2>&1; then
    warn "cannot check whether ports 80 and 443 are free (no ss)"
    return 0
  fi
  listening=$(ss -Hltn 2>/dev/null || true)
  busy=$(busy_ports "$listening" 80 443)
  if [ -n "$busy" ]; then
    pf_fail "port(s) $busy already in use on this host; the Caddy edge needs 80 and 443. See what listens: ss -ltnp"
  else
    ok "ports 80 and 443 are free"
  fi
}

own_addresses() {
  if command -v ip >/dev/null 2>&1; then
    ip -o addr show 2>/dev/null | awk '{ split($4, a, "/"); print a[1] }' | tr '\n' ' '
  elif command -v hostname >/dev/null 2>&1; then
    hostname -I 2>/dev/null || true
  fi
}

check_dns() {
  local resolved own
  resolved=$(getent ahosts "$DOMAIN" 2>/dev/null | awk '{ print $1 }' | sort -u | tr '\n' ' ' || true)
  own=$(own_addresses || true)
  case "$(dns_verdict "$resolved" "$own")" in
    match)
      ok "$DOMAIN resolves to this host (${resolved% })"
      ;;
    nomatch)
      warn "$DOMAIN resolves to ${resolved% }, not to an address of this host. That is fine when a router or firewall forwards ports 80 and 443 to this machine; otherwise Caddy cannot get the Let's Encrypt certificate."
      ;;
    loopback)
      warn "$DOMAIN resolves only to a loopback address here (probably /etc/hosts). Public DNS must point it to this server for the Let's Encrypt certificate."
      ;;
    unresolved)
      warn "$DOMAIN does not resolve (yet). Create its A or AAAA record for this server; Caddy keeps trying for the certificate until it does."
      ;;
  esac
}

# ---- An earlier installation --------------------------------------------------------------

EXISTING_ENV=0
EXISTING_VOLUMES=""
EXISTING_DIRS=""

detect_existing() {
  EXISTING_ENV=0
  if [ -f "$OPT_DIR/.env" ]; then
    EXISTING_ENV=1
  fi
  EXISTING_VOLUMES=""
  EXISTING_DIRS=""
  if [ "$DOCKER_STATE" = ok ]; then
    # The compose file names its project "restow"; these are its volumes with data.
    EXISTING_VOLUMES=$(docker volume ls -q 2>/dev/null | awk '$0 == "restow_pgdata" || $0 == "restow_restow-data" { printf "%s ", $0 }' || true)
    EXISTING_DIRS=$(docker ps -a --filter label=com.docker.compose.project=restow --format '{{.Label "com.docker.compose.project.working_dir"}}' 2>/dev/null | sort -u | tr '\n' ' ' || true)
  fi
}

# ---- Docker ---------------------------------------------------------------------------

# A new VM often runs apt-daily or unattended-upgrades in its first minutes. apt-get waits
# for the dpkg lock they hold (DPkg::Lock::Timeout) instead of failing at once.
apt_get() {
  run env DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l apt-get -q -y \
    -o DPkg::Lock::Timeout=600 \
    -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold "$@"
}

# `apt-get update` does not wait for the lock of the package lists (DPkg::Lock::Timeout
# does not cover it), which apt-daily holds while it refreshes them: try again for about
# two minutes.
APT_UPDATE_ATTEMPTS=12
APT_UPDATE_PAUSE=10
apt_update() {
  local attempt=1
  while ! apt_get update; do
    if [ "$attempt" -ge "$APT_UPDATE_ATTEMPTS" ]; then
      return 1
    fi
    say "    apt-get update failed (attempt $attempt of $APT_UPDATE_ATTEMPTS; another apt run may hold its lock), trying again in $APT_UPDATE_PAUSE s"
    attempt=$((attempt + 1))
    sleep "$APT_UPDATE_PAUSE"
  done
}

docker_apt_source_present() {
  grep -rqs 'download\.docker\.com' "$APT_SOURCES_DIR" /etc/apt/sources.list 2>/dev/null
}

install_docker() {
  local key="$WORK/docker.asc" fingerprint primaries
  say "    installing Docker Engine and the Compose plugin from Docker's apt repository"
  if is_dry; then
    dry "apt-get install ca-certificates curl gpg"
    dry "download https://download.docker.com/linux/$OS_ID/gpg and check its fingerprint $DOCKER_REPO_FINGERPRINT"
    dry "install it as $APT_KEYRINGS_DIR/docker.asc and add $APT_SOURCES_DIR/docker.sources ($OS_ID $OS_CODENAME stable, $ARCH)"
    dry "apt-get install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin"
    dry "systemctl enable --now docker"
    return 0
  fi
  apt_update || die "$EXIT_DOCKER" "apt-get update failed"
  apt_get install --no-install-recommends ca-certificates curl gpg || die "$EXIT_DOCKER" "could not install ca-certificates, curl and gpg"
  curl -fsSL --proto '=https' --tlsv1.2 --retry 3 -o "$key" "https://download.docker.com/linux/$OS_ID/gpg" ||
    die "$EXIT_DOCKER" "could not download Docker's apt signing key"
  mkdir -m 700 "$WORK/gnupg"
  primaries=$(GNUPGHOME="$WORK/gnupg" gpg --batch --show-keys --with-colons "$key" 2>/dev/null | awk -F: '$1 == "pub" { n++ } END { print n + 0 }' || true)
  fingerprint=$(GNUPGHOME="$WORK/gnupg" gpg --batch --show-keys --with-colons "$key" 2>/dev/null | awk -F: '$1 == "fpr" { print $10; exit }' || true)
  if [ "$primaries" != 1 ] || [ "$fingerprint" != "$DOCKER_REPO_FINGERPRINT" ]; then
    die "$EXIT_DOCKER" "Docker's apt signing key has an unexpected fingerprint (${fingerprint:-none}, expected $DOCKER_REPO_FINGERPRINT); refusing it"
  fi
  ok "Docker's apt signing key ($DOCKER_REPO_FINGERPRINT)"
  run install -m 0755 -d "$APT_KEYRINGS_DIR" || die "$EXIT_DOCKER" "could not create $APT_KEYRINGS_DIR"
  run install -m 0644 "$key" "$APT_KEYRINGS_DIR/docker.asc" || die "$EXIT_DOCKER" "could not install the key"
  if docker_apt_source_present; then
    say "    an apt source for download.docker.com exists already; keeping it"
  else
    printf 'Types: deb\nURIs: https://download.docker.com/linux/%s\nSuites: %s\nComponents: stable\nArchitectures: %s\nSigned-By: %s/docker.asc\n' \
      "$OS_ID" "$OS_CODENAME" "$ARCH" "$APT_KEYRINGS_DIR" >"$WORK/docker.sources"
    run install -m 0644 "$WORK/docker.sources" "$APT_SOURCES_DIR/docker.sources" || die "$EXIT_DOCKER" "could not add $APT_SOURCES_DIR/docker.sources"
  fi
  apt_update || die "$EXIT_DOCKER" "apt-get update failed after adding Docker's repository"
  apt_get install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin ||
    die "$EXIT_DOCKER" "installing Docker failed"
  if command -v systemctl >/dev/null 2>&1; then
    run systemctl enable --now docker || true
  fi
}

wait_for_docker() {
  local i
  for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
    if docker info >/dev/null 2>&1; then
      return 0
    fi
    log_line "waiting for the Docker daemon ($i)"
    sleep 2
  done
  return 1
}

ensure_docker() {
  local problem
  step "Docker"
  case $DOCKER_STATE in
    missing)
      install_docker
      ;;
    no-daemon)
      if command -v systemctl >/dev/null 2>&1; then
        run systemctl start docker || true
      fi
      ;;
  esac
  if [ "$DOCKER_COMPOSE_INSTALL" = 1 ]; then
    apt_get install docker-compose-plugin || die "$EXIT_DOCKER" "could not install docker-compose-plugin"
  fi
  if is_dry; then
    if [ "$DOCKER_STATE" = ok ] && [ "$DOCKER_COMPOSE_INSTALL" != 1 ]; then
      dry "use the installed Docker as it is"
    fi
    return 0
  fi
  if ! wait_for_docker; then
    case $VIRT_CONTAINER in
      lxc | lxc-libvirt | openvz)
        die "$EXIT_DOCKER" "Docker does not start in this container. LXC needs nesting=1 and keyctl=1 (Proxmox: Options > Features); see: systemctl status docker, journalctl -u docker"
        ;;
    esac
    die "$EXIT_DOCKER" "Docker does not answer (docker info). See: systemctl status docker, journalctl -u docker"
  fi
  problem=$(docker_version_problem)
  if [ -n "$problem" ]; then
    die "$EXIT_DOCKER" "$problem"
  fi
  if [ -z "$(compose_version)" ]; then
    die "$EXIT_DOCKER" "the Docker Compose plugin does not answer (docker compose version)"
  fi
  DOCKER_STATE=ok
  ok "Docker $(docker_server_version), Compose $(compose_version)"
}

# ---- Signatures ------------------------------------------------------------------------
# cosign runs from its official image pinned by digest, as the opt-in updater runs it:
# short-lived, read-only, without capabilities. Nothing is installed on the host.

cosign_container() {
  docker run --rm --read-only --tmpfs /tmp:rw,size=64m --env HOME=/tmp \
    --cap-drop ALL --security-opt no-new-privileges:true "$@"
}

prepare_cosign() {
  if [ "$OPT_SKIP_SIGNATURES" = 1 ]; then
    return 0
  fi
  step "Signature checks"
  run docker pull "$COSIGN_IMAGE" || die "$EXIT_DOWNLOAD" "could not pull the cosign image $COSIGN_IMAGE"
  if ! is_dry; then
    ok "cosign (pinned by digest)"
  fi
}

# ---- Release files ------------------------------------------------------------------------

fetch() {
  local proto='=https'
  case $1 in
    http://*) proto='=http,https' ;;
  esac
  curl -fsSL --proto "$proto" --proto-redir "$proto" --retry 3 --retry-delay 2 \
    --connect-timeout 20 --max-time 300 -o "$2" "$1"
}

fetch_release_files() {
  local base dir name
  base=$(release_base_url "$VERSION")
  step "Release files of v$VERSION"
  if is_dry; then
    dry "download SHA256SUMS, SHA256SUMS.sigstore.json, docker-compose.yml and env.example from $base"
    if [ "$OPT_SKIP_SIGNATURES" = 1 ]; then
      dry "check docker-compose.yml and env.example against SHA256SUMS (signature NOT checked)"
    else
      dry "check the cosign signature of SHA256SUMS (signer: $(signer_identity "$VERSION")), then docker-compose.yml and env.example against it"
    fi
    return 0
  fi
  dir="$WORK/release"
  mkdir -p "$dir"
  for name in SHA256SUMS docker-compose.yml env.example; do
    fetch "$base/$name" "$dir/$name" || die "$EXIT_DOWNLOAD" "could not download $base/$name"
  done
  if [ "$OPT_SKIP_SIGNATURES" != 1 ]; then
    fetch "$base/SHA256SUMS.sigstore.json" "$dir/SHA256SUMS.sigstore.json" ||
      die "$EXIT_DOWNLOAD" "could not download $base/SHA256SUMS.sigstore.json, the signature of SHA256SUMS"
  fi
  # Public files; the cosign container (not root) reads them through a read-only mount.
  chmod 755 "$WORK" "$dir"
  chmod 644 "$dir"/*
  ok "downloaded from $base"
}

verify_release_files() {
  local dir="$WORK/release" name expected actual
  if is_dry; then
    return 0
  fi
  if [ "$OPT_SKIP_SIGNATURES" = 1 ]; then
    warn "NOT checking the signature of SHA256SUMS (--skip-signature-check)"
  else
    run cosign_container --volume "$dir:/release:ro" "$COSIGN_IMAGE" verify-blob \
      --bundle /release/SHA256SUMS.sigstore.json \
      --certificate-identity "$(signer_identity "$VERSION")" \
      --certificate-oidc-issuer "$SIGNER_ISSUER" /release/SHA256SUMS ||
      die "$EXIT_DOWNLOAD" "SHA256SUMS of v$VERSION carries no valid signature of the release workflow of v$VERSION; refusing the release files"
    ok "SHA256SUMS is signed by the release workflow of v$VERSION"
  fi
  for name in docker-compose.yml env.example; do
    expected=$(sums_lookup "$dir/SHA256SUMS" "$name" || true)
    [ -n "$expected" ] || die "$EXIT_DOWNLOAD" "SHA256SUMS of v$VERSION lists no single checksum for $name"
    actual=$(sha256_of "$dir/$name")
    if [ "$actual" != "$expected" ]; then
      die "$EXIT_DOWNLOAD" "$name does not match SHA256SUMS (expected $expected, got $actual); refusing it"
    fi
    ok "$name matches SHA256SUMS"
  done
}

install_files() {
  local name target
  step "Installation directory $OPT_DIR"
  if is_dry; then
    dry "create $OPT_DIR (0755) with docker-compose.yml and env.example of the release (0644), import/ (0755) and journal-tls/ (0700)"
    return 0
  fi
  if [ ! -d "$OPT_DIR" ]; then
    run install -d -m 0755 "$OPT_DIR" || die "$EXIT_ERROR" "could not create $OPT_DIR"
  fi
  for name in docker-compose.yml env.example; do
    target="$OPT_DIR/$name"
    if [ -e "$target" ]; then
      if cmp -s "$WORK/release/$name" "$target"; then
        ok "$target is the release file already"
      else
        die "$EXIT_EXISTING" "$target exists and differs from the release file; the installer does not overwrite it. Move it away, or install into another --dir."
      fi
    else
      run install -m 0644 "$WORK/release/$name" "$target" || die "$EXIT_ERROR" "could not write $target"
      ok "$target"
    fi
  done
  if [ ! -d "$OPT_DIR/import" ]; then
    run install -d -m 0755 "$OPT_DIR/import" || die "$EXIT_ERROR" "could not create $OPT_DIR/import"
  fi
  if [ ! -d "$OPT_DIR/journal-tls" ]; then
    run install -d -m 0700 "$OPT_DIR/journal-tls" || die "$EXIT_ERROR" "could not create $OPT_DIR/journal-tls"
  fi
}

# ---- .env ------------------------------------------------------------------------------

write_env() {
  local target="$OPT_DIR/.env" keys pg_password app_password provider_password auth_secret updater_image="" problem missing value
  step "Configuration ($target)"
  if [ -e "$target" ]; then
    die "$EXIT_EXISTING" "$target exists; the installer never overwrites it"
  fi
  if is_dry; then
    dry "write $target from env.example (mode 0600): images, address, three database passwords, RESTOW_MASTER_KEY and BETTER_AUTH_SECRET, newly generated"
    return 0
  fi
  pg_password=$(random_hex 16)
  app_password=$(random_hex 16)
  provider_password=$(random_hex 16)
  auth_secret=$(random_base64 32)
  MASTER_KEY_ONCE=$(random_base64 32)
  problem=""
  for value in "$pg_password" "$app_password" "$provider_password"; do
    [[ $value =~ ^[0-9a-f]{32}$ ]] || problem="a database password"
  done
  for value in "$auth_secret" "$MASTER_KEY_ONCE"; do
    [[ $value =~ ^[A-Za-z0-9+/]{43}=$ ]] || problem="a 32-byte key"
  done
  if [ -n "$problem" ] || [ "$pg_password" = "$app_password" ] || [ "$app_password" = "$provider_password" ] || [ "$auth_secret" = "$MASTER_KEY_ONCE" ]; then
    die "$EXIT_ERROR" "generating ${problem:-the secrets} from /dev/urandom failed"
  fi
  keys="$REQUIRED_ENV_NAMES RESTOW_PROJECT_DIR"
  if [ "$OPT_UPDATER" = 1 ]; then
    keys="$keys RESTOW_UPDATER_IMAGE"
    updater_image=$APP_IMAGE
  fi
  ENV_TMP="$OPT_DIR/.env.install.$$"
  # shellcheck disable=SC2086 # $keys is a list of key names
  if ! (
    umask 077
    export RI_RESTOW_IMAGE="$APP_IMAGE" RI_RESTOW_WEB_IMAGE="$WEB_IMAGE"
    export RI_RESTOW_PUBLIC_URL="$PUBLIC_URL" RI_RESTOW_APP_DOMAIN="$DOMAIN"
    export RI_POSTGRES_PASSWORD="$pg_password"
    export RI_DATABASE_MIGRATION_URL="postgres://restow:${pg_password}@postgres:5432/restow"
    export RI_DATABASE_URL="postgres://restow_app:${app_password}@postgres:5432/restow"
    export RI_DATABASE_PROVIDER_URL="postgres://restow_provider:${provider_password}@postgres:5432/restow"
    export RI_RESTOW_MASTER_KEY="$MASTER_KEY_ONCE" RI_BETTER_AUTH_SECRET="$auth_secret"
    export RI_RESTOW_PROJECT_DIR="$OPT_DIR" RI_RESTOW_UPDATER_IMAGE="$updater_image"
    render_env "$OPT_DIR/env.example" $keys >"$ENV_TMP"
  ); then
    die "$EXIT_ERROR" "could not write the configuration"
  fi
  chmod 600 "$ENV_TMP"
  # shellcheck disable=SC2086 # a list of key names
  missing=$(env_missing_keys "$ENV_TMP" $REQUIRED_ENV_NAMES)
  if [ -n "$missing" ]; then
    die "$EXIT_ERROR" "the generated configuration lacks: $missing"
  fi
  # A hard link never replaces an existing file: .env is created once, completely, or not.
  if ! ln "$ENV_TMP" "$target" 2>/dev/null; then
    die "$EXIT_EXISTING" "$target appeared meanwhile; the installer never overwrites it"
  fi
  rm -f "$ENV_TMP"
  ENV_TMP=""
  ok "$target written (mode 0600, owner $(id -un)); the secrets are in no log"
}

show_master_key() {
  local answer=""
  if is_dry; then
    dry "show RESTOW_MASTER_KEY once on the terminal (interactive runs only) and ask to confirm it is stored offline"
    return 0
  fi
  if [ "$INTERACTIVE" != 1 ]; then
    say "    RESTOW_MASTER_KEY is in $OPT_DIR/.env and was not shown (non-interactive run)."
    say "    Copy it to an offline place now: sudo grep '^RESTOW_MASTER_KEY=' $OPT_DIR/.env"
    MASTER_KEY_ONCE=""
    return 0
  fi
  {
    printf '\n'
    printf '  ======================================================================\n'
    printf '  RESTOW_MASTER_KEY (shown this once; it is not in the log)\n\n'
    printf '      %s\n\n' "$MASTER_KEY_ONCE"
    printf '  It wraps the key of every tenant. Without it NO backup can ever be\n'
    printf '  read again, and whoever holds it and the storage can read them all.\n'
    printf '  Store it offline now, apart from this server and from the storage:\n'
    printf '  a password manager entry, a printed copy in a safe.\n'
    printf '  It also stays in %s/.env (mode 0600).\n' "$OPT_DIR"
    printf '  ======================================================================\n\n'
  } >/dev/tty
  MASTER_KEY_ONCE=""
  while :; do
    printf 'Type "yes" once the key is stored offline: ' >/dev/tty
    if ! IFS= read -r answer </dev/tty; then
      printf '\n' >/dev/tty
      die "$EXIT_ABORTED" "aborted; .env is written. Run the installer again to continue (the key is not shown again: read it from $OPT_DIR/.env)."
    fi
    if [ "$answer" = yes ]; then
      break
    fi
  done
  log_line "the operator confirmed that the master key is stored offline"
}

# ---- Images -------------------------------------------------------------------------------

# image_repo_digest <reference>: the registry digest of the local image of that repository.
image_repo_digest() {
  local repo
  repo=$(image_repository "$1")
  docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$1" 2>/dev/null |
    awk -v repo="$repo" 'index($0, repo "@sha256:") == 1 { print substr($0, length(repo) + 2); exit }' || true
}

# pull_and_verify <reference>: pull it unless it is here already, then check the signature
# of exactly the digest that is here. Nothing runs before the check; a failed check
# removes the image again. An image that is here already is not pulled again, so a
# repeated run never changes what runs.
pull_and_verify() {
  local ref=$1 version repo digest
  version=$(image_tag "$ref")
  repo=$(image_repository "$ref")
  if is_dry; then
    dry "pull $ref (unless it is here already)"
    if [ "$OPT_SKIP_SIGNATURES" = 1 ]; then
      dry "NOT check the signature of $ref (--skip-signature-check)"
    else
      dry "check the cosign signature of its registry digest (signer: $(signer_identity "$version"))"
    fi
    return 0
  fi
  if docker image inspect "$ref" >/dev/null 2>&1; then
    digest=$(image_repo_digest "$ref")
    if [ "$OPT_SKIP_SIGNATURES" = 1 ]; then
      warn "NOT checking the signature of $ref${digest:+ ($digest)}, which is here already (--skip-signature-check)"
      return 0
    fi
    if [ -z "$digest" ]; then
      die "$EXIT_SIGNATURE" "$ref is on this host but was not pulled from $repo (no registry digest), so its signature cannot be checked. Remove it (docker image rm $ref) and run the installer again."
    fi
    ok "$ref is here already ($digest)"
  else
    run docker pull "$ref" || die "$EXIT_DOWNLOAD" "could not pull $ref"
    digest=$(image_repo_digest "$ref")
    if [ "$OPT_SKIP_SIGNATURES" = 1 ]; then
      warn "NOT checking the signature of $ref${digest:+ ($digest)} (--skip-signature-check)"
      return 0
    fi
    if [ -z "$digest" ]; then
      die "$EXIT_SIGNATURE" "could not read the registry digest of $ref"
    fi
  fi
  if ! valid_version "$version"; then
    run docker image rm "$ref" || true
    die "$EXIT_SIGNATURE" "$ref has no release version tag, so no release signature can match it. For an image built elsewhere use --skip-signature-check."
  fi
  if run cosign_container "$COSIGN_IMAGE" verify \
    --certificate-identity "$(signer_identity "$version")" \
    --certificate-oidc-issuer "$SIGNER_ISSUER" "$repo@$digest"; then
    ok "$ref ($digest) is signed by the release workflow of v$version"
  elif run docker image rm "$ref"; then
    die "$EXIT_SIGNATURE" "$ref ($digest) carries no valid signature of the release workflow of v$version. The image was removed again; nothing was started."
  else
    die "$EXIT_SIGNATURE" "$ref ($digest) carries no valid signature of the release workflow of v$version, and it is in use: stop the stack (cd $OPT_DIR && docker compose down), remove the image (docker image rm $ref) and find out where it came from."
  fi
}

pull_images() {
  step "Images"
  pull_and_verify "$APP_IMAGE"
  pull_and_verify "$WEB_IMAGE"
}

# ---- Start --------------------------------------------------------------------------------

compose() {
  docker compose -f "$OPT_DIR/docker-compose.yml" "$@"
}

# start_stack <with updater 0|1> <pull postgres 0|1>
start_stack() {
  local updater=$1 pull_postgres=$2
  step "Starting the stack"
  # --quiet: the full output would print the secrets of .env.
  run compose config --quiet ||
    die "$EXIT_START" "docker compose rejects $OPT_DIR/.env or docker-compose.yml (check with: cd $OPT_DIR && docker compose config --quiet)"
  # Only PostgreSQL is pulled here, and only on a new installation: the two Restow
  # images are the verified local ones, and `up` pulls no image that is present.
  if [ "$pull_postgres" = 1 ]; then
    run compose pull postgres || die "$EXIT_DOWNLOAD" "could not pull the PostgreSQL image"
  fi
  if [ "$updater" = 1 ]; then
    run compose --profile updater up -d || die "$EXIT_START" "docker compose up failed (cd $OPT_DIR && docker compose ps)"
  else
    run compose up -d || die "$EXIT_START" "docker compose up failed (cd $OPT_DIR && docker compose ps)"
  fi
}

wait_healthy() {
  local port url deadline
  port=$(env_get "$OPT_DIR/.env" RESTOW_API_PORT 2>/dev/null || true)
  url="http://127.0.0.1:${port:-3000}/healthz"
  if is_dry; then
    dry "wait up to $HEALTH_TIMEOUT_SECONDS s for $url (the first start applies the database migrations)"
    return 0
  fi
  say "    waiting for $url (the first start applies the database migrations)"
  deadline=$(($(date +%s) + HEALTH_TIMEOUT_SECONDS))
  while :; do
    if curl -fsS --max-time 5 -o /dev/null "$url" 2>/dev/null; then
      ok "the api answers $url"
      break
    fi
    if [ "$(date +%s)" -ge "$deadline" ]; then
      # Only the status goes to the log: the api's own log carries the setup token.
      run compose ps || true
      die "$EXIT_START" "the api did not become healthy within $HEALTH_TIMEOUT_SECONDS s. See: cd $OPT_DIR && docker compose ps && docker compose logs api"
    fi
    sleep 5
  done
  if run compose ps --status running --services; then
    log_line "running services listed above"
  fi
}

# check_edge: the web edge answers on 443 with a certificate (warning only).
check_edge() {
  local domain=$1 code i
  if is_dry; then
    dry "check that https://$domain answers through the Caddy edge"
    return 0
  fi
  for i in 1 2 3 4 5 6 7 8 9; do
    if [ "$LOCAL_MODE" = 1 ]; then
      code=$(curl -ksS -o /dev/null --max-time 10 -w '%{http_code}' --resolve "$domain:443:127.0.0.1" "https://$domain/" 2>/dev/null || true)
    else
      code=$(curl -sS -o /dev/null --max-time 10 -w '%{http_code}' --resolve "$domain:443:127.0.0.1" "https://$domain/" 2>/dev/null || true)
    fi
    case $code in
      2?? | 3??)
        ok "https://$domain answers (edge and certificate)"
        return 0
        ;;
    esac
    log_line "edge check $i: HTTP ${code:-none}"
    sleep 10
  done
  if [ "$LOCAL_MODE" = 1 ]; then
    warn "https://$domain does not answer yet. See: cd $OPT_DIR && docker compose logs caddy"
  else
    warn "https://$domain does not answer with a valid certificate yet. Caddy keeps trying; it needs the DNS record and ports 80 and 443 reachable from the internet. See: cd $OPT_DIR && docker compose logs caddy"
  fi
}

# ---- Summary ------------------------------------------------------------------------------

edition_label() {
  case $1 in
    full) echo "full build" ;;
    community) echo "Community build" ;;
    *) echo "build unknown" ;;
  esac
}

print_next_steps() {
  cat <<NEXT

Next steps
  1. Master key: RESTOW_MASTER_KEY in $OPT_DIR/.env must be stored offline, apart from
     this server and the storage, before the first real backup. Without it no backup
     can be read again.
  2. Repositories: the default repository is a Docker volume on this VM. Add an off-site
     one (Admin > Repositories): S3-compatible object storage with Object Lock is recommended,
     never only the hardware of the systems you protect.
  3. Firewall: open 80 and 443 (certificate and web interface), SSH only from your
     admin networks; 25 only if you receive Exchange Online journal mail.
  4. Updates: this installer never updates. Read the release notes, then follow
     docs/UPDATING.md (https://github.com/restow-backup/restow/blob/main/docs/UPDATING.md).
  5. Back up $OPT_DIR/.env with the master key's offline copy, and the VM itself.
NEXT
}

print_summary() {
  local setup_url=$1
  say ""
  say "Restow $VERSION ($(edition_label "$EDITION")) is running."
  say ""
  say "  Setup:        $setup_url"
  say "  Setup token:  cd $OPT_DIR && sudo docker compose logs api | grep 'SETUP TOKEN'"
  say "                (printed by the api until the setup wizard is finished)"
  say "  Directory:    $OPT_DIR (.env with the secrets, mode 0600)"
  say "  Log:          $LOG_FILE"
  if [ "$LOCAL_MODE" = 1 ]; then
    say "  Note:         evaluation mode, not for production. The browser warns about the"
    say "                certificate of the edge's own authority; passkeys are not offered,"
    say "                the first administrator signs in with a password and an"
    say "                authenticator app. https://localhost opens on this machine only;"
    say "                from another one use an internal name (--domain restow.internal)"
    say "                that your DNS or hosts file points to this machine."
  fi
  if [ "$WARNINGS" -gt 0 ]; then
    say "  Warnings:     $WARNINGS (see above and in the log)"
  fi
  print_next_steps
}

# ---- Flows --------------------------------------------------------------------------------

banner() {
  say "Restow server installer (release v${DEFAULT_VERSION})"
  if ! is_dry && [ "$LOG_READY" = 1 ]; then
    say "Log: $LOG_FILE"
  fi
  if is_dry; then
    say "Dry run: checks only, nothing is changed."
  fi
}

warn_overrides() {
  if [ -n "${RESTOW_INSTALL_RELEASE_URL:-}" ]; then
    warn "RESTOW_INSTALL_RELEASE_URL is set: release files come from $RESTOW_INSTALL_RELEASE_URL instead of GitHub (tests and mirrors only)"
  fi
  if [ -n "${RESTOW_INSTALL_IMAGE_PREFIX:-}" ]; then
    warn "RESTOW_INSTALL_IMAGE_PREFIX is set: images come from $RESTOW_INSTALL_IMAGE_PREFIX instead of $IMAGE_PREFIX_DEFAULT (tests and mirrors only)"
  fi
  if [ "$OPT_SKIP_SIGNATURES" = 1 ]; then
    {
      printf '\n'
      printf '  !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n'
      printf '  !!  --skip-signature-check: the cosign signatures of the release   !!\n'
      printf '  !!  files and images are NOT checked. Whoever controls the         !!\n'
      printf '  !!  download path can run code on this host with every secret.     !!\n'
      printf '  !!  Only for tests and unsigned mirrors; never for production.     !!\n'
      printf '  !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n\n'
    } >&2
    log_line "warning: --skip-signature-check given: signatures are not checked"
    WARNINGS=$((WARNINGS + 1))
  fi
}

print_upgrade_info() {
  local current=""
  if [ -f "$OPT_DIR/.env" ]; then
    current=$(env_get "$OPT_DIR/.env" RESTOW_IMAGE 2>/dev/null || true)
  fi
  cat <<UPGRADE
This installer does not update an installation, on purpose: an update starts with the
release notes and a database backup, and some need manual steps.
${current:+
Installed in $OPT_DIR: $current
}
Follow docs/UPDATING.md:
  https://github.com/restow-backup/restow/blob/main/docs/UPDATING.md
In short: read the release notes of every version in between; back up the database
(docker compose exec -T postgres pg_dump -U restow -Fc restow > restow-\$(date +%F).dump);
check the new images' signatures (cosign verify, see docs/UPDATING.md); change
RESTOW_IMAGE and RESTOW_WEB_IMAGE in .env; docker compose pull && docker compose up -d.
Or switch on the opt-in updater (docs/UPDATING.md, "The opt-in updater").
UPGRADE
}

collect_configuration() {
  local problem answer
  VERSION=${OPT_VERSION:-$DEFAULT_VERSION}
  DOMAIN=$OPT_DOMAIN
  EDITION=$OPT_EDITION
  if [ -z "$DOMAIN" ]; then
    if [ "$OPT_LOCAL" = 1 ]; then
      DOMAIN=localhost
    elif [ "$INTERACTIVE" = 1 ]; then
      while :; do
        ask answer "Domain name of this server (for example backup.example.com)"
        answer=$(normalize_domain "$answer")
        problem=$(domain_problem "$answer" 0)
        if [ -n "$answer" ] && [ -z "$problem" ]; then
          DOMAIN=$answer
          break
        fi
        printf '%s\n' "${problem:-a domain name is needed}" >/dev/tty
      done
    elif is_dry; then
      DOMAIN="backup.example.com"
      DOMAIN_PLACEHOLDER=1
      say "    (dry run without --domain: backup.example.com stands in for it, its DNS is not checked)"
    else
      die "$EXIT_USAGE" "--domain is required with --non-interactive (or --local for an evaluation)"
    fi
  fi
  if [ -z "$EDITION" ]; then
    EDITION=full
    if [ "$INTERACTIVE" = 1 ]; then
      {
        printf '\nWhich build?\n'
        printf '  full       the Apache-2.0 core plus the Business and Service Provider modules,\n'
        printf '             locked until a license key is installed (take it if you may want them)\n'
        printf '  community  the Apache-2.0 core only\n'
      } >/dev/tty
      while :; do
        ask answer "Build (full or community)" full
        answer=$(to_lower "$answer")
        case $answer in
          full | community)
            EDITION=$answer
            break
            ;;
        esac
      done
    fi
  fi
  PUBLIC_URL="https://$DOMAIN"
  LOCAL_MODE=$OPT_LOCAL
  local names app_name web_name prefix
  names=$(image_names "$EDITION")
  app_name=${names% *}
  web_name=${names#* }
  prefix=$(image_prefix)
  APP_IMAGE="$prefix/$app_name:$VERSION"
  WEB_IMAGE="$prefix/$web_name:$VERSION"
}

show_plan() {
  local docker_action updater signatures address
  case $DOCKER_STATE in
    missing) docker_action="install Docker Engine and the Compose plugin (Docker's apt repository)" ;;
    *) docker_action="use the installed Docker" ;;
  esac
  if [ "$DOCKER_COMPOSE_INSTALL" = 1 ]; then
    docker_action="use the installed Docker, add the Compose plugin"
  fi
  if [ "$OPT_UPDATER" = 1 ]; then
    updater="on (mounts the Docker socket; docs/UPDATING.md)"
  else
    updater="off (opt-in later, docs/UPDATING.md)"
  fi
  if [ "$OPT_SKIP_SIGNATURES" = 1 ]; then
    signatures="NOT checked (--skip-signature-check)"
  else
    signatures="checked with cosign (release workflow of v$VERSION)"
  fi
  if [ "$OPT_LOCAL" = 1 ]; then
    address="$PUBLIC_URL (evaluation: the edge's own certificate authority)"
  else
    address="$PUBLIC_URL (Let's Encrypt certificate)"
  fi
  step "Plan"
  say "    Release      v$VERSION, $(edition_label "$EDITION")"
  say "    Images       $APP_IMAGE"
  say "                 $WEB_IMAGE"
  say "    Address      $address"
  say "    Directory    $OPT_DIR"
  say "    Docker       $docker_action"
  say "    Signatures   $signatures"
  say "    Updater      $updater"
  if [ "$WARNINGS" -gt 0 ]; then
    say "    Warnings     $WARNINGS (see above)"
  fi
}

install_fresh() {
  collect_configuration
  step "Checking the target"
  check_ports
  check_disk
  if [ "$OPT_LOCAL" != 1 ] && [ "$DOMAIN_PLACEHOLDER" != 1 ]; then
    check_dns
  fi
  if [ "$PREFLIGHT_FAILED" -gt 0 ]; then
    die "$EXIT_PREFLIGHT" "$PREFLIGHT_FAILED check(s) failed (see above); nothing was changed"
  fi
  show_plan
  if ! confirm "Install Restow with this plan?"; then
    die "$EXIT_ABORTED" "aborted; nothing was changed"
  fi
  ensure_docker
  if [ "$DOCKER_STATE" = ok ]; then
    # Docker may have been stopped at the first look: check its volumes once more before
    # new secrets are made for them.
    detect_existing
    if [ "$(existing_verdict "$EXISTING_ENV" "$EXISTING_VOLUMES" "$EXISTING_DIRS" "$OPT_DIR")" != fresh ]; then
      die "$EXIT_EXISTING" "Docker holds data or containers of an earlier Restow installation (${EXISTING_VOLUMES}${EXISTING_DIRS}); nothing was written. See README.md, \"Removing Restow\", or put its .env back into $OPT_DIR."
    fi
  fi
  prepare_cosign
  fetch_release_files
  verify_release_files
  install_files
  write_env
  show_master_key
  pull_images
  start_stack "$OPT_UPDATER" 1
  wait_healthy
  check_edge "$DOMAIN"
  if is_dry; then
    say ""
    say "Dry run finished: nothing was changed."
    return 0
  fi
  log_line "installation finished: v$VERSION $EDITION in $OPT_DIR"
  print_summary "$PUBLIC_URL"
}

resume_existing() {
  local env="$OPT_DIR/.env" missing current_domain web_version
  step "Existing installation in $OPT_DIR"
  say "    $env exists: nothing in $OPT_DIR is changed; the installer checks the images and makes sure the stack runs."
  if [ ! -f "$OPT_DIR/docker-compose.yml" ]; then
    die "$EXIT_EXISTING" "$env exists but $OPT_DIR/docker-compose.yml does not. Put back the docker-compose.yml of your release (release assets) and run the installer again."
  fi
  APP_IMAGE=$(env_get "$env" RESTOW_IMAGE)
  WEB_IMAGE=$(env_get "$env" RESTOW_WEB_IMAGE)
  # shellcheck disable=SC2086 # a list of key names
  missing=$(env_missing_keys "$env" $REQUIRED_ENV_NAMES)
  if [ -n "$missing" ]; then
    die "$EXIT_EXISTING" "$env lacks values for: $missing. Complete it by hand (the comments in the file say how); the installer never rewrites .env."
  fi
  VERSION=$(image_tag "$APP_IMAGE")
  EDITION=$(edition_of_image "$APP_IMAGE")
  DOMAIN=$(env_get "$env" RESTOW_APP_DOMAIN)
  PUBLIC_URL=$(env_get "$env" RESTOW_PUBLIC_URL)
  current_domain=$DOMAIN
  if [ "$(domain_kind "$DOMAIN")" = internal ]; then
    LOCAL_MODE=1
  fi
  if [ -n "$OPT_VERSION" ] && [ "$OPT_VERSION" != "$VERSION" ]; then
    die "$EXIT_EXISTING" "this installation runs ${VERSION:-an unknown version}, not $OPT_VERSION. The installer does not update; follow docs/UPDATING.md (bash install.sh --upgrade)."
  fi
  if [ -n "$OPT_EDITION" ] && [ "$OPT_EDITION" != "$EDITION" ]; then
    die "$EXIT_EXISTING" "this installation runs the $(edition_label "$EDITION"). To switch builds, change RESTOW_IMAGE and RESTOW_WEB_IMAGE in $env yourself (deploy/release/README.md)."
  fi
  if [ -n "$OPT_DOMAIN" ] && [ "$OPT_DOMAIN" != "$current_domain" ]; then
    die "$EXIT_EXISTING" "this installation serves $current_domain. To change the domain, edit RESTOW_APP_DOMAIN and RESTOW_PUBLIC_URL in $env yourself."
  fi
  web_version=$(image_tag "$WEB_IMAGE")
  if [ "$web_version" != "$VERSION" ]; then
    warn "RESTOW_IMAGE ($VERSION) and RESTOW_WEB_IMAGE (${web_version:-no tag}) name different versions"
  fi
  if [ -n "$(find "$env" -prune \( -perm -040 -o -perm -004 -o -perm -020 -o -perm -002 \) 2>/dev/null)" ]; then
    warn "$env can be read or written by others; it holds the secrets: chmod 600 $env"
  fi
  say "    Release      ${VERSION:-unknown}, $(edition_label "$EDITION")"
  say "    Images       $APP_IMAGE"
  say "                 $WEB_IMAGE"
  if ! confirm "Check the images and start the stack?"; then
    die "$EXIT_ABORTED" "aborted; nothing was changed"
  fi
  ensure_docker
  prepare_cosign
  step "Images"
  pull_and_verify "$APP_IMAGE"
  pull_and_verify "$WEB_IMAGE"
  start_stack 0 0
  wait_healthy
  if [ -n "$DOMAIN" ]; then
    check_edge "$DOMAIN"
  fi
  if is_dry; then
    say ""
    say "Dry run finished: nothing was changed."
    return 0
  fi
  log_line "existing installation checked and running: $APP_IMAGE in $OPT_DIR"
  print_summary "${PUBLIC_URL:-https://$DOMAIN}"
}

main() {
  parse_args "$@"
  case $ACTION in
    help)
      usage
      return 0
      ;;
    upgrade)
      print_upgrade_info
      return 0
      ;;
  esac
  umask 022
  trap 'on_error "$?" "$LINENO"' ERR
  trap cleanup EXIT
  trap 'exit 130' INT TERM HUP
  init_log "$@"
  setup_interaction
  banner
  warn_overrides
  local temp_base=${TMPDIR:-/tmp}
  WORK=$(mktemp -d "${temp_base%/}/restow-install.XXXXXX")

  step "Checking this machine"
  check_root
  check_tools
  check_os
  check_arch
  check_virtualization
  check_memory
  check_time_sync
  check_docker
  check_network
  if [ "$PREFLIGHT_FAILED" -gt 0 ]; then
    die "$EXIT_PREFLIGHT" "$PREFLIGHT_FAILED check(s) failed (see above); nothing was changed"
  fi

  detect_existing
  case "$(existing_verdict "$EXISTING_ENV" "$EXISTING_VOLUMES" "$EXISTING_DIRS" "$OPT_DIR")" in
    resume)
      resume_existing
      ;;
    conflict-dir)
      die "$EXIT_EXISTING" "a Restow installation already runs from ${EXISTING_DIRS% } (Docker Compose project \"restow\"). One host runs one installation; use that directory (--dir) or remove it first (README.md, \"Removing Restow\")."
      ;;
    conflict-data)
      die "$EXIT_EXISTING" "Docker holds data of an earlier Restow installation (${EXISTING_VOLUMES}${EXISTING_DIRS}) but $OPT_DIR/.env is missing. New secrets would not match it, and a new master key cannot read its backups. Put the old .env back into $OPT_DIR and run the installer again, or remove the old data deliberately (README.md, \"Removing Restow\")."
      ;;
    *)
      install_fresh
      ;;
  esac
}

if [ -z "${BASH_SOURCE[0]:-}" ] || [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
