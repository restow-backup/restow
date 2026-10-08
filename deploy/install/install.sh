#!/usr/bin/env bash
# Restow server installer.
#
# Installs the Restow server, the Docker Compose stack of deploy/release, on a dedicated
# Linux VM: Debian 12 or 13, Ubuntu 22.04, 24.04 or 26.04, amd64 or arm64 (the releases
# Docker's apt repository serves for both architectures). It
#   - checks the machine (root, system, architecture, virtualization, memory, disk, ports
#     80 and 443, outbound HTTPS, clock, DNS of the domain, that the images of the chosen
#     build can be pulled without a login, an earlier installation). The memory check
#     counts what the kernel reserves for kdump, warns below 8 GiB (it counts 7: a VM shows
#     a little less than it is given) and stops only below 3 GiB,
#   - installs Docker Engine and the Compose plugin from Docker's signed apt repository
#     when Docker is missing (never with get.docker.com),
#   - downloads docker-compose.yml and env.example of one pinned release and checks them
#     against the release's SHA256SUMS and that file's keyless cosign signature,
#   - writes .env (mode 0600) with secrets from the kernel's random generator,
#   - pulls the two images of the chosen build, checks their cosign signatures (the
#     release workflow of exactly this version) and starts the stack,
#   - waits until the api is healthy, reads the one-time setup token from its log and
#     prints it with the address to open, on the terminal only (never in the log).
#
# Run without options on a terminal it explains what it will do and asks how Restow is
# reached: public with its own certificate, behind a reverse proxy you already run
# (--behind-proxy), or a local evaluation (--local). With options, or without a
# terminal, it asks nothing it was told.
#
# Recommended use (README.md, "Install with the script"): download, check, then run.
#
#   curl -fsSLO https://github.com/restow-backup/restow/releases/download/v0.3.0/install.sh
#   curl -fsSLO https://github.com/restow-backup/restow/releases/download/v0.3.0/install.sh.sha256
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
DEFAULT_VERSION="0.3.0"

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
# Memory is counted as MemTotal plus the crash-kernel reservation (check_memory). A VM
# with 4 GiB shows less than that: the kernel and firmware keep some, a crashkernel=
# reservation (kdump) another 320 to 512 MB, and ballooning can take more. So a 4 GiB
# machine only warns: the check stops the installation below 3 GiB and recommends 8 GiB
# (7 GiB, because a VM with 8 GiB shows a little less).
MIN_MEMORY_KIB=3145728
RECOMMENDED_MEMORY_KIB=7340032
# The installation directory holds the compose file, .env and the import folder.
MIN_DIR_DISK_KIB=1048576
# Docker's data directory holds the images, the database and, until another storage
# target is added, the local chunk store (a Docker volume).
MIN_DOCKER_DISK_KIB=10485760
RECOMMENDED_DOCKER_DISK_KIB=52428800
HEALTH_TIMEOUT_SECONDS=600
# How long, after the api answers, the installer waits for the setup token in its log.
TOKEN_WAIT_SECONDS=60
# The first release whose edge can serve an encrypted hop to a reverse proxy in front of it
# (RESTOW_EDGE_TLS=internal, the Caddyfile of that release).
PROXY_TLS_MIN_VERSION="0.2.0"
# The first release with the opt-in mounter (compose profile "mounts", docs/MOUNTS.md).
MOUNTER_MIN_VERSION="0.3.0"
DOCS_URL="https://docs.restowbackup.com"
PROXY_DOCS_URL="https://docs.restowbackup.com/administrators/get-started/#behind-a-reverse-proxy"
# Caddy's local root certificate inside the edge container (the caddy-data volume).
EDGE_ROOT_CA_IN_CONTAINER="/data/caddy/pki/authorities/local/root.crt"

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
# Bytes the kernel reserved for the kdump crash kernel; the first file that exists is
# read. Kernels with /sys/kernel/kexec/ deprecate the old name (kept as a link).
KEXEC_CRASH_SIZE_FILES="/sys/kernel/kexec/crash_size /sys/kernel/kexec_crash_size"
LOG_FILE=/var/log/restow-install.log
# The terminal the questions are asked on and the secrets are shown on (never the log).
TTY_IN=/dev/tty
TTY_OUT=/dev/tty
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
OPT_MOUNTER=0
OPT_BEHIND_PROXY=0
# The addresses of the reverse proxy, normalized (/32 or /128 added), separated by spaces.
OPT_PROXY_IPS=""
OPT_PROXY_HOP=""
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
# How Restow is reached: public (own certificate), proxy (behind a reverse proxy) or local.
MODE=""
# proxy mode: https (the edge serves an encrypted hop, the default) or http (opt-in).
PROXY_HOP="https"
TRUSTED_PROXIES=""
# What RESTOW_APP_DOMAIN gets: the domain, or http://<domain> for the unencrypted hop.
APP_DOMAIN_VALUE=""

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
arm64, with 4 GiB of memory (8 GiB recommended) and 10 GiB free for Docker. The memory
check counts what the kernel reserves for kdump; it warns below 7 GiB (a VM shows a little
less than it is given) and stops below 3 GiB.

Run without options on a terminal, it explains what it will do and asks how Restow is
reached: (1) public, with its own certificate; (2) behind a reverse proxy you already run
(Nginx Proxy Manager, Traefik, Caddy, ...); (3) a local evaluation. Options answer those
questions in advance; without a terminal, or with --non-interactive, nothing is asked.

Options:
  --domain NAME            domain name of this server, e.g. backup.example.com. Public
                           installation: it must resolve to this host, with ports 80 and
                           443 reachable from the internet, for the Let's Encrypt
                           certificate. With --behind-proxy: the name your reverse proxy
                           serves. Asked for when missing; required with --non-interactive.
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
  --no-mounter             leave the opt-in mounter off (the default)
  --with-mounter           also start the opt-in mounter (compose profile "mounts"), which
                           adds NFS network shares as storage from the web interface. It
                           mounts the Docker socket: read docs/MOUNTS.md first. With the
                           updater on, it follows every signed update by itself. Needs
                           release ${MOUNTER_MIN_VERSION} or newer.
  --local                  evaluation only: no public domain, no Let's Encrypt. The edge
                           serves https://localhost (or the internal name given with
                           --domain: *.internal, *.home.arpa, *.localhost) over HTTPS
                           with a certificate from Caddy's own local authority, which
                           browsers warn about. Passkeys are not offered. Not for
                           production. (--http-local is a deprecated name for it.)
  --behind-proxy           an installation behind a reverse proxy you already run (Nginx
                           Proxy Manager, Traefik, Caddy, ...), which holds the public name
                           and certificate and forwards to this host. By default the hop
                           is encrypted: forward to https://<this host>:443, where the
                           edge shows a certificate of its own authority (the installer
                           copies its root certificate to <dir>/edge-root-ca.crt, to verify
                           it with). No public DNS record and no inbound port from the
                           internet are needed; this host needs port 443 free. Needs
                           --domain (the name the proxy serves) and --proxy-ip, and release
                           ${PROXY_TLS_MIN_VERSION} or newer.
  --proxy-ip ADDRESS...    the address of the reverse proxy itself, as this host sees it: an
                           IP address, or a network such as 192.168.1.0/29. Repeat the option
                           or separate the addresses with spaces. A bare address gets /32
                           (IPv4) or /128 (IPv6). Written to RESTOW_EDGE_TRUSTED_PROXIES:
                           Restow believes the client address these peers report (audit log,
                           sign-in limits), so list the proxy only, never your whole LAN.
                           Required with --behind-proxy and --non-interactive.
  --proxy-hop https|http   how the proxy reaches this host (default: https). http sends
                           everything, session cookies and passwords included, unencrypted
                           to port 80 of this host: only when the proxy and Restow share a
                           host or an isolated network. Works with any release.
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
# ($TTY_OUT, /dev/tty, never the log) in an interactive run. The setup token is shown the same
# way, with the address to open (print_final_block).

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
# A second line under an error: what to do about it.
hint_line() {
  printf '       hint: %s\n' "$*" >&2
  log_line "hint: $*"
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
  # `curl ... | sudo bash` feeds the script on stdin: questions go to the terminal. It is
  # opened once (file descriptor 3), so a scripted terminal (the tests) is read line by line.
  if (exec <"$TTY_IN") 2>/dev/null; then
    exec 3<"$TTY_IN"
    INTERACTIVE=1
  else
    die "$EXIT_USAGE" "no terminal to ask questions on. Run with --non-interactive and the options you need (at least --domain; --behind-proxy also needs --proxy-ip)."
  fi
}

# tty_say <text>: a line on the terminal of an interactive run, never in the log.
tty_say() {
  printf '%s\n' "$*" >>"$TTY_OUT"
}

# ask <variable> <question> [default]: sets the caller's variable (no local of that name here).
ask() {
  local ask_reply=""
  if [ -n "${3:-}" ]; then
    printf '%s [%s]: ' "$2" "$3" >>"$TTY_OUT"
  else
    printf '%s: ' "$2" >>"$TTY_OUT"
  fi
  if ! IFS= read -r ask_reply <&3; then
    printf '\n' >>"$TTY_OUT"
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
  printf '%s [y/N] ' "$1" >>"$TTY_OUT"
  if ! IFS= read -r answer <&3; then
    printf '\n' >>"$TTY_OUT"
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

# domain_problem <normalized domain> <local 0|1> [proxy 0|1]: prints what is wrong, nothing if
# fine. Behind a reverse proxy the name is the proxy's to certify, so an internal name is fine.
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
      if [ "$2" != 1 ] && [ "${3:-0}" != 1 ]; then
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

# ---- Reverse proxy addresses -----------------------------------------------------------

# valid_ipv4 <address>: a dotted quad, each part 0 to 255 without a leading zero.
valid_ipv4() {
  local part re='^(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})$'
  [[ $1 =~ $re ]] || return 1
  for part in "${BASH_REMATCH[@]:1:4}"; do
    [ "$part" -le 255 ] || return 1
  done
}

# valid_ipv6 <address>: hex groups of one to four digits, at most one "::", eight groups
# without it. No embedded IPv4 part and no zone, which the edge's address lists do not take.
valid_ipv6() {
  awk -v a="$1" 'BEGIN {
    if (a !~ /^[0-9A-Fa-f:]+$/ || a ~ /:::/ || a ~ /^:[^:]/ || a ~ /[^:]:$/) exit 1
    n = gsub(/::/, "::", a)
    if (n > 1) exit 1
    m = split(a, group, ":")
    count = 0
    for (i = 1; i <= m; i++) if (group[i] != "") { if (length(group[i]) > 4) exit 1; count++ }
    if (n == 1) { if (count > 7) exit 1 } else if (count != 8) exit 1
    exit 0
  }'
}

# proxy_entry_problem <address or network>: prints what is wrong with it, nothing if fine.
proxy_entry_problem() {
  local entry=$1 address prefix="" max not_an_address
  not_an_address="not an IP address or network: $entry"
  address=${entry%%/*}
  if [ "$address" != "$entry" ]; then
    prefix=${entry#*/}
  fi
  case $address in
    *:*)
      max=128
      valid_ipv6 "$address" || {
        echo "$not_an_address"
        return 0
      }
      ;;
    *)
      max=32
      valid_ipv4 "$address" || {
        echo "$not_an_address"
        return 0
      }
      ;;
  esac
  if [ "$address" != "$entry" ]; then
    local re='^[0-9]{1,3}$'
    if ! [[ $prefix =~ $re ]] || [ "$((10#$prefix))" -gt "$max" ]; then
      echo "$not_an_address"
    elif [ "$((10#$prefix))" -eq 0 ]; then
      echo "$entry would trust every address as a proxy"
    fi
  fi
  return 0
}

# normalize_proxy_entry <address or network>: lower case, with /32 or /128 for a bare address.
normalize_proxy_entry() {
  local entry=$1 address prefix=""
  address=${entry%%/*}
  if [ "$address" != "$entry" ]; then
    prefix=$((10#${entry#*/}))
  fi
  address=$(to_lower "$address")
  if [ -z "$prefix" ]; then
    case $address in
      *:*) prefix=128 ;;
      *) prefix=32 ;;
    esac
  fi
  printf '%s/%s' "$address" "$prefix"
}

# proxy_list_problem <addresses separated by spaces or commas>: the first problem, if any.
proxy_list_problem() {
  local item problem list=${1//,/ }
  if [ -z "${list// /}" ]; then
    echo "no address given"
    return 0
  fi
  # shellcheck disable=SC2086 # splitting the list into its addresses is the point
  for item in $list; do
    problem=$(proxy_entry_problem "$item")
    if [ -n "$problem" ]; then
      echo "$problem"
      return 0
    fi
  done
  return 0
}

# proxy_list_normalize <addresses>: the normalized addresses, each once, separated by spaces.
proxy_list_normalize() {
  local item normalized result="" list=${1//,/ }
  # shellcheck disable=SC2086 # splitting the list into its addresses is the point
  for item in $list; do
    normalized=$(normalize_proxy_entry "$item")
    case " $result " in
      *" $normalized "*) ;;
      *) result="${result:+$result }$normalized" ;;
    esac
  done
  printf '%s' "$result"
}

# proxy_entry_range_note <normalized entry>: says so when it covers a wide range (a network, not a machine).
proxy_entry_range_note() {
  local prefix=${1#*/}
  case $1 in
    *:*) [ "$prefix" -ge 64 ] || echo "$1 covers a very wide range" ;;
    *) [ "$prefix" -ge 24 ] || echo "$1 covers more than 254 addresses" ;;
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

# add_proxy_ips <addresses separated by spaces or commas>: into OPT_PROXY_IPS, normalized.
add_proxy_ips() {
  local problem
  problem=$(proxy_list_problem "$1")
  if [ -n "$problem" ]; then
    die "$EXIT_USAGE" "--proxy-ip: $problem (give the address of your reverse proxy, for example 192.168.1.20)"
  fi
  OPT_PROXY_IPS=$(proxy_list_normalize "${OPT_PROXY_IPS:+$OPT_PROXY_IPS }$1")
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
      --no-mounter)
        OPT_MOUNTER=0
        shift
        ;;
      --with-mounter)
        OPT_MOUNTER=1
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
      --behind-proxy)
        OPT_BEHIND_PROXY=1
        shift
        ;;
      --proxy-ip)
        need_value "$1" "${2:-}"
        shift
        # One or more addresses: everything up to the next option.
        while [ $# -gt 0 ] && [ "${1#-}" = "$1" ]; do
          add_proxy_ips "$1"
          shift
        done
        ;;
      --proxy-ip=*)
        need_value --proxy-ip "${1#*=}"
        add_proxy_ips "${1#*=}"
        shift
        ;;
      --proxy-hop)
        need_value "$1" "${2:-}"
        OPT_PROXY_HOP=$2
        shift 2
        ;;
      --proxy-hop=*)
        need_value --proxy-hop "${1#*=}"
        OPT_PROXY_HOP=${1#*=}
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
  if [ -n "$OPT_PROXY_HOP" ]; then
    OPT_PROXY_HOP=$(to_lower "$OPT_PROXY_HOP")
    case $OPT_PROXY_HOP in
      https | http) ;;
      *) die "$EXIT_USAGE" "--proxy-hop must be https or http (found: $OPT_PROXY_HOP)" ;;
    esac
  fi
  if [ "$OPT_BEHIND_PROXY" != 1 ] && { [ -n "$OPT_PROXY_IPS" ] || [ -n "$OPT_PROXY_HOP" ]; }; then
    die "$EXIT_USAGE" "--proxy-ip and --proxy-hop belong to --behind-proxy (see --help)"
  fi
  if [ "$OPT_BEHIND_PROXY" = 1 ] && [ "$OPT_LOCAL" = 1 ]; then
    die "$EXIT_USAGE" "--behind-proxy and --local exclude each other: --local is an evaluation with a certificate of its own, --behind-proxy leaves the certificate to your reverse proxy"
  fi
  if [ -n "$OPT_DOMAIN" ]; then
    OPT_DOMAIN=$(normalize_domain "$OPT_DOMAIN")
    problem=$(domain_problem "$OPT_DOMAIN" "$OPT_LOCAL" "$OPT_BEHIND_PROXY")
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

# crash_reserved_kib: KiB the kernel set aside for the kdump crash kernel (crashkernel= on
# its command line), 0 when nothing is reserved or no file tells. The files hold bytes. That
# memory is not part of MemTotal, but it is memory assigned to this machine.
crash_reserved_kib() {
  local file bytes
  for file in $KEXEC_CRASH_SIZE_FILES; do
    bytes=$(awk 'NR == 1 { print $1; exit }' "$file" 2>/dev/null || true)
    case $bytes in
      "" | *[!0-9]* | ????????????????*) ;; # empty, not a number, or 16 digits and more
      *)
        echo $((10#$bytes / 1024))
        return 0
        ;;
    esac
  done
  echo 0
}

# memory_label <MemTotal KiB> <reserved KiB>: what to show for the memory.
memory_label() {
  case $1 in
    "" | *[!0-9]*)
      printf 'unknown'
      return 0
      ;;
  esac
  if [ "$2" -gt 0 ]; then
    printf '%s GiB visible (+%s GiB reserved for kdump)' "$(kib_to_gib "$1")" "$(kib_to_gib "$2")"
  else
    printf '%s GiB' "$(kib_to_gib "$1")"
  fi
}

check_memory() {
  local kib reserved total="" label
  kib=$(awk '/^MemTotal:/ { print $2 }' "$MEMINFO_FILE" 2>/dev/null || true)
  reserved=$(crash_reserved_kib)
  case $kib in
    "" | *[!0-9]*) ;;
    *) total=$((kib + reserved)) ;;
  esac
  label=$(memory_label "$kib" "$reserved")
  case "$(level_verdict "$total" "$MIN_MEMORY_KIB" "$RECOMMENDED_MEMORY_KIB")" in
    ok) ok "memory $label" ;;
    warn) warn "memory $label: Restow runs, 8 GiB are recommended (mail parsing runs in helper processes of up to 512 MB each; set IMPORT_PARSE_WORKERS=1 and PREVIEW_PARSE_WORKERS=1 in .env on a small host)" ;;
    fail)
      pf_fail "memory $label: too little for Restow, which needs at least 4 GiB (8 GiB recommended)"
      hint_line "assign at least 4 GiB (8 GiB recommended) to the VM. Proxmox with ballooning: set \"Minimum memory\" equal to \"Memory\". After a change shut the VM down and start it again; check with: free -h"
      ;;
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

# What a registry accepts as a manifest of a multi-architecture image or of a single one.
REGISTRY_MANIFEST_ACCEPT="application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json"

# registry_pull_status <reference>: asks the registry of an image, as the Docker client does
# for an anonymous pull and without Docker (it may not be installed yet): an anonymous
# bearer token for the repository, then the manifest of the tag. Prints one line:
# public | unauthorized <code> | notfound 404 | unknown (the registry could not be asked, or
# answered something else). ghcr.io (checked 2026-10-02) hands the token out only for a
# public package: the token request itself answers 401 for a private one and 403 for a name
# that does not exist, and the manifest request answers 404 for a tag that does not exist.
registry_pull_status() {
  local ref=$1 repo host path tag answer code token
  repo=$(image_repository "$ref")
  tag=$(image_tag "$ref")
  host=${repo%%/*}
  path=${repo#*/}
  # The body, a line break and the HTTP status.
  answer=$(curl -sS --proto '=https' --tlsv1.2 --max-time 10 -w '\n%{http_code}' \
    "https://$host/token?scope=repository:$path:pull" 2>/dev/null || true)
  code=${answer##*$'\n'}
  case $code in
    401 | 403)
      echo "unauthorized $code"
      return 0
      ;;
    200) ;;
    *)
      echo unknown
      return 0
      ;;
  esac
  token=$(printf '%s\n' "$answer" | sed -n 's#.*"token"[[:space:]]*:[[:space:]]*"\([A-Za-z0-9._~+/=-]*\)".*#\1#p' | head -n 1 || true)
  if [ -z "$token" ]; then
    echo unknown
    return 0
  fi
  code=$(curl -sS --proto '=https' --tlsv1.2 --max-time 10 --head -o /dev/null -w '%{http_code}' \
    -H "Authorization: Bearer $token" -H "Accept: $REGISTRY_MANIFEST_ACCEPT" \
    "https://$host/v2/$path/manifests/$tag" 2>/dev/null || true)
  case $code in
    200) echo public ;;
    401 | 403) echo "unauthorized $code" ;;
    404) echo "notfound 404" ;;
    *) echo unknown ;;
  esac
}

# image_problem <status from registry_pull_status or a pull failure> <reference>: the same
# plain explanation for both, empty when the status says nothing is wrong.
image_problem() {
  case $1 in
    "unauthorized 403") echo "image $2 is not publicly available (403 denied): the release images may not be published yet" ;;
    unauthorized*) echo "image $2 is not publicly available (401 unauthorized): the release images may not be published yet" ;;
    notfound*) echo "no image $2 (404 not found): check --version and --edition" ;;
  esac
}

# check_images: before anything is changed, each image of the chosen build can be pulled
# without a login. A release whose packages are still private, or a version or build that
# does not exist, stops here and not half way through the installation.
check_images() {
  local ref status problem host
  host=${APP_IMAGE%%/*}
  if [ "$host" != ghcr.io ]; then
    warn "the images come from $host (RESTOW_INSTALL_IMAGE_PREFIX): not checked whether they can be pulled; fine when they are loaded on this host already"
    return 0
  fi
  for ref in "$APP_IMAGE" "$WEB_IMAGE"; do
    if [ "$DOCKER_STATE" = ok ] && docker image inspect "$ref" >/dev/null 2>&1; then
      ok "$ref is here already"
      continue
    fi
    status=$(registry_pull_status "$ref")
    problem=$(image_problem "$status" "$ref")
    if [ -n "$problem" ]; then
      pf_fail "$problem; nothing was changed"
    elif [ "$status" = public ]; then
      ok "$ref can be pulled without a login"
    else
      warn "could not ask $host whether $ref can be pulled; the pull may still work"
    fi
  done
}

# Available KiB on the file system that holds <path> (or its nearest existing parent).
avail_kib() {
  local path=$1
  while [ ! -e "$path" ] && [ "$path" != / ]; do
    path=$(dirname "$path")
  done
  df -Pk "$path" 2>/dev/null | awk 'NR == 2 { print $4 }'
}

# Ubuntu Server's installer often gives the root logical volume only part of its volume
# group, so a 32 GB disk can leave 15 GB for / and the rest unused. lvm_free_hint <path>
# says so, with the command that grows the volume, when <path> lives on a logical volume
# whose volume group has LVM_HINT_MIN_KIB or more unused. It prints nothing otherwise,
# and nothing when the LVM tools are missing or may not be used (not root). Once per hint.
LVM_HINT_MIN_KIB=1048576
LVM_HINT_SHOWN=""
lvm_free_hint() {
  local path=$1 device names vg lv free_kib hint
  command -v findmnt >/dev/null 2>&1 || return 0
  command -v lvs >/dev/null 2>&1 || return 0
  command -v vgs >/dev/null 2>&1 || return 0
  while [ ! -e "$path" ] && [ "$path" != / ]; do
    path=$(dirname "$path")
  done
  device=$(findmnt -n -o SOURCE --target "$path" 2>/dev/null || true)
  case $device in
    /dev/*) ;;
    *) return 0 ;;
  esac
  names=$(LC_ALL=C lvs --noheadings -o vg_name,lv_name "$device" 2>/dev/null | awk 'NR == 1 { print $1, $2 }' || true)
  vg=${names%% *}
  lv=${names#* }
  if [ -z "$vg" ] || [ "$lv" = "$names" ]; then
    return 0
  fi
  case $vg$lv in
    *[!A-Za-z0-9+_.-]*) return 0 ;;
  esac
  # --units k: KiB; the number may carry a decimal point or comma.
  free_kib=$(LC_ALL=C vgs --noheadings --units k --nosuffix -o vg_free "$vg" 2>/dev/null | awk 'NR == 1 { sub(/[.,].*$/, "", $1); print $1 }' || true)
  case $free_kib in
    "" | *[!0-9]*) return 0 ;;
  esac
  if [ "$free_kib" -lt "$LVM_HINT_MIN_KIB" ]; then
    return 0
  fi
  hint="the volume group $vg has $(kib_to_gib "$free_kib") GiB unused: sudo lvextend -r -l +100%FREE /dev/$vg/$lv"
  if [ "$hint" != "$LVM_HINT_SHOWN" ]; then
    LVM_HINT_SHOWN=$hint
    hint_line "$hint"
  fi
}

check_disk() {
  local kib root
  kib=$(avail_kib "$OPT_DIR")
  case "$(level_verdict "$kib" "$MIN_DIR_DISK_KIB" "$MIN_DIR_DISK_KIB")" in
    ok) ok "$(kib_to_gib "$kib") GiB free for $OPT_DIR" ;;
    *)
      pf_fail "only ${kib:-0} KiB free for $OPT_DIR (at least 1 GiB)"
      lvm_free_hint "$OPT_DIR"
      ;;
  esac
  root=""
  if [ "$DOCKER_STATE" = ok ]; then
    root=$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || true)
  fi
  root=${root:-/var/lib/docker}
  kib=$(avail_kib "$root")
  case "$(level_verdict "$kib" "$MIN_DOCKER_DISK_KIB" "$RECOMMENDED_DOCKER_DISK_KIB")" in
    ok) ok "$(kib_to_gib "$kib") GiB free for Docker ($root)" ;;
    warn)
      warn "$(kib_to_gib "$kib") GiB free for Docker ($root). It is enough to start; but until you add another storage target the backups go into a Docker volume there. 50 GiB or more are recommended, or an off-site target (S3 with Object Lock)."
      lvm_free_hint "$root"
      ;;
    fail)
      pf_fail "only $(kib_to_gib "${kib:-0}") GiB free for Docker ($root): at least 10 GiB are needed for the images and the database"
      lvm_free_hint "$root"
      ;;
  esac
}

# edge_port: the one host port the Caddy edge needs behind a reverse proxy: 443 for the
# encrypted hop, 80 for the plain one. The other is published on this host's loopback
# interface only (write_env), so nothing else on the machine can be in its way.
edge_port() {
  if [ "$PROXY_HOP" = http ]; then
    echo 80
  else
    echo 443
  fi
}

check_ports() {
  local listening busy port
  if [ "$MODE" = proxy ]; then
    port=$(edge_port)
    if ! command -v ss >/dev/null 2>&1; then
      warn "cannot check whether port $port is free (no ss)"
      return 0
    fi
    listening=$(ss -Hltn 2>/dev/null || true)
    busy=$(busy_ports "$listening" "$port")
    if [ -n "$busy" ]; then
      pf_fail "port $port already in use on this host; the Caddy edge needs it, your reverse proxy forwards to it. See what listens: ss -ltnp"
    else
      ok "port $port is free (your reverse proxy forwards to it)"
    fi
    return 0
  fi
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

# lan_address: the IPv4 address of this host that other machines reach it at (the one its
# default route leaves from), else the first address of an interface that is neither
# loopback, link-local nor Docker's default bridge. Nothing when there is none.
lan_address() {
  local address="" candidate
  if command -v ip >/dev/null 2>&1; then
    address=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{ for (i = 1; i < NF; i++) if ($i == "src") { print $(i + 1); exit } }' || true)
  fi
  if [ -z "$address" ]; then
    for candidate in $(own_addresses || true); do
      case $candidate in
        127.* | 169.254.* | 172.17.* | *:*) continue ;;
      esac
      if valid_ipv4 "$candidate"; then
        address=$candidate
        break
      fi
    done
  fi
  printf '%s' "$address"
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
  local target="$OPT_DIR/.env" keys pg_password app_password provider_password auth_secret problem missing value
  step "Configuration ($target)"
  if [ -e "$target" ]; then
    die "$EXIT_EXISTING" "$target exists; the installer never overwrites it"
  fi
  if is_dry; then
    dry "write $target from env.example (mode 0600): images, address, three database passwords, RESTOW_MASTER_KEY and BETTER_AUTH_SECRET, newly generated"
    if [ "$MODE" = proxy ]; then
      dry "set RESTOW_APP_DOMAIN=${APP_DOMAIN_VALUE:-$DOMAIN}, RESTOW_PUBLIC_URL=$PUBLIC_URL, RESTOW_EDGE_TRUSTED_PROXIES=$TRUSTED_PROXIES$([ "$PROXY_HOP" = http ] || printf ', RESTOW_EDGE_TLS=internal')"
    fi
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
  if [ "${MODE:-}" = proxy ]; then
    # Behind a reverse proxy: the proxies whose client address is believed and, for the
    # encrypted hop, the edge's own certificate authority. The host port the edge does not
    # need is published on this host's loopback interface, on a port Docker picks ("127.0.0.1:"),
    # so it cannot be in the way of anything else and is not reachable from the network.
    keys="$keys RESTOW_EDGE_TRUSTED_PROXIES"
    if [ "${PROXY_HOP:-https}" = http ]; then
      keys="$keys RESTOW_HTTPS_PORT"
    else
      keys="$keys RESTOW_EDGE_TLS RESTOW_HTTP_PORT"
    fi
  fi
  # RESTOW_UPDATER_IMAGE stays empty, also with --with-updater: the updater is the application
  # image, and on its first start it pins the image it runs into .env by digest (stronger than
  # the tag this script knows), then moves itself after every update from a signed release.
  # RESTOW_MOUNTER_IMAGE stays empty with --with-mounter for the same reason; the updater
  # moves the mounter along with it.
  ENV_TMP="$OPT_DIR/.env.install.$$"
  # shellcheck disable=SC2086 # $keys is a list of key names
  if ! (
    umask 077
    export RI_RESTOW_IMAGE="$APP_IMAGE" RI_RESTOW_WEB_IMAGE="$WEB_IMAGE"
    export RI_RESTOW_PUBLIC_URL="$PUBLIC_URL" RI_RESTOW_APP_DOMAIN="${APP_DOMAIN_VALUE:-$DOMAIN}"
    export RI_RESTOW_EDGE_TRUSTED_PROXIES="${TRUSTED_PROXIES:-}" RI_RESTOW_EDGE_TLS=internal
    export RI_RESTOW_HTTP_PORT="127.0.0.1:" RI_RESTOW_HTTPS_PORT="127.0.0.1:"
    export RI_POSTGRES_PASSWORD="$pg_password"
    export RI_DATABASE_MIGRATION_URL="postgres://restow:${pg_password}@postgres:5432/restow"
    export RI_DATABASE_URL="postgres://restow_app:${app_password}@postgres:5432/restow"
    export RI_DATABASE_PROVIDER_URL="postgres://restow_provider:${provider_password}@postgres:5432/restow"
    export RI_RESTOW_MASTER_KEY="$MASTER_KEY_ONCE" RI_BETTER_AUTH_SECRET="$auth_secret"
    export RI_RESTOW_PROJECT_DIR="$OPT_DIR"
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
  } >>"$TTY_OUT"
  MASTER_KEY_ONCE=""
  while :; do
    printf 'Type "yes" once the key is stored offline: ' >>"$TTY_OUT"
    if ! IFS= read -r answer <&3; then
      printf '\n' >>"$TTY_OUT"
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

# pull_image <reference>: docker pull. A failure is explained as the preflight explains it
# when Docker's answer says why (unauthorized, not found); otherwise with Docker's last line.
pull_image() {
  local ref=$1 output status="" problem lower last
  log_line "run: docker pull $ref"
  if output=$(docker pull "$ref" </dev/null 2>&1); then
    log_line "$output"
    return 0
  fi
  log_line "$output"
  if [ "$LOG_READY" != 1 ]; then
    printf '%s\n' "$output" >&2
  fi
  lower=$(to_lower "$output")
  case $lower in
    *"manifest unknown"* | *"not found"* | *"name unknown"*) status="notfound 404" ;;
    *unauthorized* | *denied* | *"docker login"*) status="unauthorized 401" ;;
  esac
  last=$(printf '%s\n' "$output" | awk 'NF { line = $0 } END { print line }')
  problem=$(image_problem "$status" "$ref")
  if [ -n "$problem" ]; then
    die "$EXIT_DOWNLOAD" "$problem${last:+ (docker: $last)}. Run the installer again once this is fixed: it keeps the .env it wrote."
  fi
  die "$EXIT_DOWNLOAD" "could not pull $ref${last:+ (docker: $last)}"
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
    pull_image "$ref"
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

# start_stack <with updater 0|1> <pull postgres 0|1> [with mounter 0|1]
start_stack() {
  local updater=$1 pull_postgres=$2 mounter=${3:-0}
  step "Starting the stack"
  # --quiet: the full output would print the secrets of .env.
  run compose config --quiet ||
    die "$EXIT_START" "docker compose rejects $OPT_DIR/.env or docker-compose.yml (check with: cd $OPT_DIR && docker compose config --quiet)"
  # Only PostgreSQL is pulled here, and only on a new installation: the two Restow
  # images are the verified local ones, and `up` pulls no image that is present.
  if [ "$pull_postgres" = 1 ]; then
    run compose pull postgres || die "$EXIT_DOWNLOAD" "could not pull the PostgreSQL image"
  fi
  # The opt-in services start with their compose profiles: "updater" and "mounts".
  set --
  if [ "$updater" = 1 ]; then
    set -- "$@" --profile updater
  fi
  if [ "$mounter" = 1 ]; then
    set -- "$@" --profile mounts
  fi
  run compose "$@" up -d || die "$EXIT_START" "docker compose up failed (cd $OPT_DIR && docker compose ps)"
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

# check_edge: the web edge answers (warning only). In the modes with a certificate of the
# edge's own authority (--local, --behind-proxy) it is not checked against the system's roots.
check_edge() {
  local domain=$1 code i url
  case $MODE:$PROXY_HOP in
    proxy:http) url="http://$domain/" ;;
    *) url="https://$domain/" ;;
  esac
  if is_dry; then
    dry "check that $url answers through the Caddy edge"
    return 0
  fi
  for i in 1 2 3 4 5 6 7 8 9; do
    if [ "$MODE" = proxy ] && [ "$PROXY_HOP" = http ]; then
      code=$(curl -sS -o /dev/null --max-time 10 -w '%{http_code}' --resolve "$domain:80:127.0.0.1" "$url" 2>/dev/null || true)
    elif [ "$MODE" = proxy ] || [ "$LOCAL_MODE" = 1 ]; then
      code=$(curl -ksS -o /dev/null --max-time 10 -w '%{http_code}' --resolve "$domain:443:127.0.0.1" "$url" 2>/dev/null || true)
    else
      code=$(curl -sS -o /dev/null --max-time 10 -w '%{http_code}' --resolve "$domain:443:127.0.0.1" "$url" 2>/dev/null || true)
    fi
    case $code in
      2?? | 3??)
        if [ "$MODE" = proxy ]; then
          ok "$url answers on this host (the edge your reverse proxy forwards to)"
        else
          ok "https://$domain answers (edge and certificate)"
        fi
        return 0
        ;;
    esac
    log_line "edge check $i: HTTP ${code:-none}"
    sleep 10
  done
  if [ "$MODE" = proxy ]; then
    warn "$url does not answer on this host yet. See: cd $OPT_DIR && docker compose logs caddy"
  elif [ "$LOCAL_MODE" = 1 ]; then
    warn "https://$domain does not answer yet. See: cd $OPT_DIR && docker compose logs caddy"
  else
    warn "https://$domain does not answer with a valid certificate yet. Caddy keeps trying; it needs the DNS record and ports 80 and 443 reachable from the internet. See: cd $OPT_DIR && docker compose logs caddy"
  fi
}

# export_edge_root_ca: the root certificate of the edge's own authority, copied out of the
# caddy-data volume to <dir>/edge-root-ca.crt (a public certificate, mode 0644). The reverse
# proxy can verify the edge with it; nothing requires it. An existing file is kept.
export_edge_root_ca() {
  local target="$OPT_DIR/edge-root-ca.crt" tmp i
  if is_dry; then
    dry "copy the root certificate of the edge's own authority to $target (to verify the edge with)"
    return 0
  fi
  if [ -s "$target" ]; then
    ok "$target is here already"
    return 0
  fi
  tmp="$WORK/edge-root-ca.crt"
  for i in 1 2 3 4 5; do
    if compose cp "caddy:$EDGE_ROOT_CA_IN_CONTAINER" "$tmp" >/dev/null 2>&1 && grep -q 'BEGIN CERTIFICATE' "$tmp" 2>/dev/null; then
      if run install -m 0644 "$tmp" "$target"; then
        ok "root certificate of the edge's own authority: $target"
        return 0
      fi
    fi
    log_line "root certificate export $i: not there yet"
    sleep 3
  done
  warn "could not copy the root certificate of the edge. Your reverse proxy works without it unless you want it to verify the edge. Copy it later: cd $OPT_DIR && docker compose cp caddy:$EDGE_ROOT_CA_IN_CONTAINER edge-root-ca.crt"
}

# ---- The setup token --------------------------------------------------------------------

TOKEN_POLL_SECONDS=2
TOKEN_STATE=""
TOKEN_VALUE=""

# read_setup_token: the newest setup token in the log of the api, empty when there is none.
# The token is a secret: it goes to a variable and to the terminal, never to the install log.
read_setup_token() {
  compose logs --no-color api 2>/dev/null |
    sed -n 's/^.*SETUP TOKEN:[[:space:]]*\([A-HJKMNP-TV-Z2-9]\{5\}\(-[A-HJKMNP-TV-Z2-9]\{5\}\)\{3\}\).*$/\1/p' |
    tail -n 1 || true
}

# wait_for_setup_token: the api prints the token a moment after it starts to answer.
wait_for_setup_token() {
  local token="" waited=0
  while :; do
    token=$(read_setup_token)
    if [ -n "$token" ] || [ "$waited" -ge "$TOKEN_WAIT_SECONDS" ]; then
      break
    fi
    sleep "$TOKEN_POLL_SECONDS"
    waited=$((waited + 2))
  done
  printf '%s' "$token"
}

# setup_configured: the setup wizard has been finished (the api says so; no token is needed).
setup_configured() {
  local port
  port=$(env_get "$OPT_DIR/.env" RESTOW_API_PORT 2>/dev/null || true)
  curl -fsS --max-time 5 "http://127.0.0.1:${port:-3000}/api/v1/setup/state" 2>/dev/null | grep -q '"configured":true'
}

stdout_is_tty() {
  [ -t 1 ]
}

# secret_sink: where a secret may be shown. The terminal of an interactive run (written to
# it directly, so a pipe or tee in front of the script never carries it), the standard output
# when that is a terminal; nothing otherwise (a provisioning run whose output is collected).
secret_sink() {
  if [ "$INTERACTIVE" = 1 ]; then
    printf '%s' "$TTY_OUT"
  elif stdout_is_tty; then
    printf '%s' /dev/stdout
  fi
}

# resolve_setup_token: sets TOKEN_STATE and TOKEN_VALUE.
#   done         the setup wizard has been finished: there is no token any more
#   environment  RESTOW_SETUP_TOKEN in .env is the token; it is not shown
#   shown        read from the api log, to be shown on the terminal
#   hidden       read, but there is no terminal to show it on
#   missing      the api log has no token (yet)
resolve_setup_token() {
  local sink
  TOKEN_STATE=""
  TOKEN_VALUE=""
  if setup_configured; then
    TOKEN_STATE="done"
    return 0
  fi
  if [ -n "$(env_get "$OPT_DIR/.env" RESTOW_SETUP_TOKEN 2>/dev/null || true)" ]; then
    TOKEN_STATE=environment
    return 0
  fi
  TOKEN_VALUE=$(wait_for_setup_token)
  if [ -z "$TOKEN_VALUE" ]; then
    TOKEN_STATE=missing
    return 0
  fi
  sink=$(secret_sink)
  if [ -z "$sink" ]; then
    TOKEN_VALUE=""
    TOKEN_STATE=hidden
  else
    TOKEN_STATE=shown
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

# edge_target: where the reverse proxy forwards to: this host's address on the network and the
# edge's port.
edge_target() {
  local host
  host=$(lan_address)
  host=${host:-"<this host's IP address>"}
  if [ "$PROXY_HOP" = http ]; then
    printf 'http://%s:80' "$host"
  else
    printf 'https://%s:443' "$host"
  fi
}

# The longer list: above the box, so that the address and the token are what stays on screen.
print_next_steps() {
  say ""
  say "Next steps"
  say "  In the setup wizard (open the address in the box below):"
  say "   1. Choose the language, English or Deutsch."
  say "   2. Enter the setup token from the box. It proves that you operate this server."
  say "   3. Accept the operator notice, say how Restow is reached, name your organisation and"
  say "      create the first administrator."
  say "   4. Set up the notification mail, or skip it: it can be set up later under"
  say "      Installation > Notification mail (without it Restow sends no alert mails)."
  say "  After the wizard:"
  say "   5. Add a storage target off this machine (menu: Repositories). The default one is a"
  say "      Docker volume on this VM; S3-compatible object storage with Object Lock is"
  say "      recommended, never only the hardware of the systems you protect."
  say "   6. Run the first backup, then check that a restore works."
  say "  On this server:"
  say "   7. Master key: RESTOW_MASTER_KEY in $OPT_DIR/.env must be stored offline, apart from"
  say "      this server and the storage, before the first real backup. Without it no backup"
  say "      can be read again."
  case $MODE in
    proxy)
      say "   8. Firewall: let only your reverse proxy reach port $(edge_port). Docker publishes it on"
      say "      every interface, past ufw: $PROXY_DOCS_URL"
      say "      SSH only from your admin networks; 25 only if you receive Exchange Online journal mail."
      ;;
    *)
      say "   8. Firewall: open 80 and 443 (certificate and web interface), SSH only from your"
      say "      admin networks; 25 only if you receive Exchange Online journal mail."
      ;;
  esac
  say "   9. Updates: this installer never updates. Read the release notes, then follow"
  say "      docs/UPDATING.md (https://github.com/restow-backup/restow/blob/main/docs/UPDATING.md)."
  if [ "$OPT_UPDATER" = 1 ]; then
    say "      The opt-in updater runs: install updates under Installation > Updates. It runs the"
    say "      application image ($APP_IMAGE), pins it by digest in .env on its first start"
    say "      (RESTOW_UPDATER_IMAGE) and moves itself after each signed update. Nothing to edit."
  else
    say "      To install updates from the web interface later, start the opt-in updater once:"
    say "      cd $OPT_DIR && docker compose --profile updater up -d   (no .env change needed; it"
    say "      runs the application image and mounts the Docker socket: read docs/UPDATING.md)."
  fi
  if [ "$OPT_MOUNTER" = 1 ]; then
    say "      The opt-in mounter runs: add NFS network shares under Installation > Mounts."
    if [ "$OPT_UPDATER" = 1 ]; then
      say "      It moves to the verified image of each signed update the updater installs."
    else
      say "      Without the updater it stays on its image; after an update, empty"
      say "      RESTOW_MOUNTER_IMAGE in .env and run: cd $OPT_DIR && docker compose --profile mounts up -d mounter"
    fi
  fi
  say "  10. Back up $OPT_DIR/.env with the master key's offline copy, and the VM itself."
  say "  Documentation: $DOCS_URL"
}

# final_block_lines <token state> <token>: the box the installer ends with, on stdout. The
# state is one of those of resolve_setup_token; the token only matters for "shown".
final_block_lines() {
  local state=$1 token=$2 rule indent="                  " read_again lan
  rule="======================================================================"
  read_again="cd $OPT_DIR && sudo docker compose logs api | grep 'SETUP TOKEN'"
  printf '\n  %s\n' "$rule"
  printf '    Restow is running.\n'
  case $MODE in
    proxy)
      printf '    Open:         %s  (served by your reverse proxy)\n' "$PUBLIC_URL"
      if [ "$PROXY_HOP" = http ]; then
        printf '%sYour proxy must forward to %s (not 3000). That hop is not encrypted.\n' "$indent" "$(edge_target)"
      else
        printf '%sYour proxy must forward to %s (not 80, not 3000)\n' "$indent" "$(edge_target)"
      fi
      ;;
    local)
      printf '    Open:         %s  (the browser warns about the certificate)\n' "$PUBLIC_URL"
      if [ "$DOMAIN" = localhost ]; then
        printf '%sThis machine only. For others: --local --domain restow.internal, pointed here.\n' "$indent"
      else
        lan=$(lan_address)
        printf '%sOther machines: point %s at %s in DNS or the hosts file.\n' "$indent" "$DOMAIN" "${lan:-this machine}"
      fi
      ;;
    *)
      printf '    Open:         %s\n' "$PUBLIC_URL"
      ;;
  esac
  case $state in
    shown) printf '    Setup token:  %s\n' "$token" ;;
    hidden) printf '    Setup token:  not shown in this run (no terminal). Read it as below.\n' ;;
    missing) printf '    Setup token:  not in the api log yet. Read it as below.\n' ;;
    environment) printf '    Setup token:  the value of RESTOW_SETUP_TOKEN in %s/.env\n' "$OPT_DIR" ;;
    done) printf '    Setup:        complete, no token needed.\n' ;;
  esac
  printf '  %s\n' "$rule"
  case $state in
    shown | hidden | missing)
      printf '  The token proves you operate this server and works until the setup is done.\n'
      printf '  Read it again: %s\n' "$read_again"
      ;;
    environment)
      printf '  The token proves you operate this server and works until the setup is done.\n'
      ;;
  esac
}

# print_final_block: the last thing the installer prints. The log gets the box without the
# token; the token itself goes to the terminal only (secret_sink), never through say or log_line.
print_final_block() {
  local sink line
  final_block_lines "$TOKEN_STATE" "(shown on the terminal only)" | while IFS= read -r line; do
    log_line "$line"
  done
  if [ "$TOKEN_STATE" = shown ]; then
    sink=$(secret_sink)
    final_block_lines shown "$TOKEN_VALUE" >>"$sink"
  else
    final_block_lines "$TOKEN_STATE" ""
  fi
  TOKEN_VALUE=""
}

print_summary() {
  say ""
  say "Restow $VERSION ($(edition_label "$EDITION")) is installed in $OPT_DIR (.env with the secrets, mode 0600)."
  say "Log: $LOG_FILE"
  if [ "$WARNINGS" -gt 0 ]; then
    say "Warnings: $WARNINGS (see above and in the log)"
  fi
  resolve_setup_token
  print_next_steps
  print_final_block
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

# print_intro: what is about to happen, on a terminal, before any question.
print_intro() {
  {
    printf '\n'
    printf 'This installs the Restow server on this machine with Docker Compose. It will:\n'
    printf '  - check the machine (system, memory, disk, network) and change nothing yet,\n'
    printf '  - ask how Restow is reached and which build you want, show a plan and wait for\n'
    printf '    your confirmation,\n'
    printf '  - install Docker if it is missing, download the release and check its signatures,\n'
    printf '    write the configuration with newly generated secrets, pull the images, start Restow,\n'
    printf '  - show you the address to open and the one-time setup token for the setup wizard.\n'
    printf 'It takes about 10 to 20 minutes, most of it downloads. You need root (sudo), outbound\n'
    printf 'HTTPS from this machine and, for options 1 and 2 below, a domain name for Restow.\n'
    printf 'Stop at any question with Ctrl+C: nothing is changed before you confirm the plan.\n'
  } >>"$TTY_OUT"
}

# mode_is_open: whether the operator has still to say how Restow is reached (a terminal, and
# neither --local, --behind-proxy nor --domain, which each answer it).
mode_is_open() {
  [ "$INTERACTIVE" = 1 ] && [ "$OPT_LOCAL" != 1 ] && [ "$OPT_BEHIND_PROXY" != 1 ] && [ -z "$OPT_DOMAIN" ]
}

# ask_mode: the three ways to reach Restow. Sets OPT_BEHIND_PROXY or OPT_LOCAL for 2 and 3.
ask_mode() {
  local answer
  {
    printf '\nHow will people reach Restow?\n'
    printf '  1) Public, with its own certificate\n'
    printf '       Needs a domain that points at this server and ports 80 and 443 open to the internet.\n'
    printf '  2) Behind a reverse proxy you already run (Nginx Proxy Manager, Traefik, Caddy, ...)\n'
    printf '       The proxy handles the public address and TLS and forwards to this server, encrypted.\n'
    printf '  3) Local evaluation (--local)\n'
    printf '       No domain, no real certificate: https://localhost, to try Restow out.\n'
  } >>"$TTY_OUT"
  while :; do
    ask answer "Choose 1, 2 or 3" 1
    case $answer in
      1) ;;
      2) OPT_BEHIND_PROXY=1 ;;
      3) OPT_LOCAL=1 ;;
      *)
        tty_say "Please answer 1, 2 or 3."
        continue
        ;;
    esac
    break
  done
}

# ask_proxy_ips: the address of the reverse proxy, with what it is and is not.
ask_proxy_ips() {
  local answer problem
  {
    printf '\nWhich address does your reverse proxy connect from?\n'
    printf '  Enter the address of the proxy server itself, as this machine sees it (for example\n'
    printf '  192.168.1.20), not your whole network: Restow believes the client address that a\n'
    printf '  listed proxy reports (audit log, sign-in limits). Several proxies: separate them with spaces.\n'
  } >>"$TTY_OUT"
  while :; do
    ask answer "Address of your reverse proxy"
    problem=$(proxy_list_problem "$answer")
    if [ -z "$problem" ]; then
      OPT_PROXY_IPS=$(proxy_list_normalize "$answer")
      return 0
    fi
    tty_say "$problem (an IP address such as 192.168.1.20, or a network such as 192.168.1.0/29)"
  done
}

# proxy_version_problem <version>: says why this release cannot serve the encrypted hop, if so.
proxy_version_problem() {
  if [ "${OPT_PROXY_HOP:-https}" != http ] && ! version_ge "$1" "$PROXY_TLS_MIN_VERSION"; then
    echo "--behind-proxy needs release $PROXY_TLS_MIN_VERSION or newer: the edge of $1 cannot serve an encrypted hop to a reverse proxy. Install $PROXY_TLS_MIN_VERSION or newer (--version), or use --proxy-hop http (the hop is then not encrypted; see --help)."
  fi
}

# mounter_version_problem <version>: says why this release cannot start the mounter, if so.
mounter_version_problem() {
  if [ "$OPT_MOUNTER" = 1 ] && ! version_ge "$1" "$MOUNTER_MIN_VERSION"; then
    echo "--with-mounter needs release $MOUNTER_MIN_VERSION or newer: $1 has no mounter. Install $MOUNTER_MIN_VERSION or newer (--version), or leave --with-mounter out."
  fi
}

# require_mounter_release: --with-mounter on a release without the mounter stops before any
# check. An installation that exists is only checked and started (like --with-updater).
require_mounter_release() {
  local problem
  if [ "$OPT_MOUNTER" != 1 ] || [ -f "$OPT_DIR/.env" ]; then
    return 0
  fi
  problem=$(mounter_version_problem "${OPT_VERSION:-$DEFAULT_VERSION}")
  if [ -n "$problem" ]; then
    die "$EXIT_USAGE" "$problem"
  fi
}

# require_proxy_options: --behind-proxy without a terminal has to bring its answers, and a
# release that is too old stops before any check. Asked of a terminal later, in collect_configuration.
require_proxy_options() {
  local problem
  # An installation that exists is only checked and started: resume_existing compares the flags with it.
  if [ "$OPT_BEHIND_PROXY" != 1 ] || [ -f "$OPT_DIR/.env" ]; then
    return 0
  fi
  problem=$(proxy_version_problem "${OPT_VERSION:-$DEFAULT_VERSION}")
  if [ -n "$problem" ]; then
    die "$EXIT_USAGE" "$problem"
  fi
  if [ "$INTERACTIVE" = 1 ] || is_dry; then
    return 0
  fi
  if [ -z "$OPT_DOMAIN" ]; then
    die "$EXIT_USAGE" "--domain is required with --behind-proxy and --non-interactive: the name your reverse proxy serves (for example backup.example.com)"
  fi
  if [ -z "$OPT_PROXY_IPS" ]; then
    die "$EXIT_USAGE" "--proxy-ip is required with --behind-proxy and --non-interactive: the address of your reverse proxy, as this host sees it (for example --proxy-ip 192.168.1.20). It is the proxy's own address, not your LAN: Restow believes the client address these peers report."
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
Or switch on the opt-in updater once, with no change to .env (docs/UPDATING.md, "The opt-in
updater"): cd $OPT_DIR && docker compose --profile updater up -d
It runs the application image (there is no separate updater image), rewrites RESTOW_IMAGE and
RESTOW_WEB_IMAGE itself and moves itself to every signed release it installs.
UPGRADE
}

collect_configuration() {
  local problem answer
  VERSION=${OPT_VERSION:-$DEFAULT_VERSION}
  DOMAIN=$OPT_DOMAIN
  EDITION=$OPT_EDITION
  if mode_is_open; then
    ask_mode
  fi
  if [ "$OPT_LOCAL" = 1 ]; then
    MODE=local
  elif [ "$OPT_BEHIND_PROXY" = 1 ]; then
    MODE=proxy
  else
    MODE=public
  fi
  if [ -z "$DOMAIN" ]; then
    if [ "$OPT_LOCAL" = 1 ]; then
      DOMAIN=localhost
    elif [ "$INTERACTIVE" = 1 ]; then
      while :; do
        if [ "$MODE" = proxy ]; then
          ask answer "Domain name your reverse proxy serves (for example backup.example.com)"
        else
          ask answer "Domain name of this server (for example backup.example.com)"
        fi
        answer=$(normalize_domain "$answer")
        problem=$(domain_problem "$answer" 0 "$OPT_BEHIND_PROXY")
        if [ -n "$answer" ] && [ -z "$problem" ]; then
          DOMAIN=$answer
          break
        fi
        tty_say "${problem:-a domain name is needed}"
      done
    elif is_dry; then
      DOMAIN="backup.example.com"
      DOMAIN_PLACEHOLDER=1
      say "    (dry run without --domain: backup.example.com stands in for it, its DNS is not checked)"
    elif [ "$MODE" = proxy ]; then
      die "$EXIT_USAGE" "--domain is required with --behind-proxy and --non-interactive: the name your reverse proxy serves"
    else
      die "$EXIT_USAGE" "--domain is required with --non-interactive (or --local for an evaluation)"
    fi
  fi
  if [ "$MODE" = proxy ]; then
    collect_proxy_configuration
  fi
  if [ -z "$EDITION" ]; then
    EDITION=full
    if [ "$INTERACTIVE" = 1 ]; then
      {
        printf '\nWhich build?\n'
        printf '  full       the Apache-2.0 core plus the Business and Service Provider modules,\n'
        printf '             locked until a license key is installed (take it if you may want them)\n'
        printf '  community  the Apache-2.0 core only\n'
      } >>"$TTY_OUT"
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

# collect_proxy_configuration: behind a reverse proxy, which proxies are trusted and how the
# proxy reaches this host. The domain is known.
collect_proxy_configuration() {
  local problem entry note
  PROXY_HOP=${OPT_PROXY_HOP:-https}
  problem=$(proxy_version_problem "$VERSION")
  if [ -n "$problem" ]; then
    die "$EXIT_USAGE" "$problem"
  fi
  if [ -z "$OPT_PROXY_IPS" ]; then
    if [ "$INTERACTIVE" = 1 ]; then
      ask_proxy_ips
    elif is_dry; then
      OPT_PROXY_IPS="192.0.2.1/32"
      say "    (dry run without --proxy-ip: 192.0.2.1/32 stands in for it)"
    else
      die "$EXIT_USAGE" "--proxy-ip is required with --behind-proxy and --non-interactive"
    fi
  fi
  TRUSTED_PROXIES=$OPT_PROXY_IPS
  for entry in $TRUSTED_PROXIES; do
    note=$(proxy_entry_range_note "$entry")
    if [ -n "$note" ]; then
      warn "$note, and Restow believes the client address every one of them reports. List the proxy itself, not a network of machines."
    fi
  done
  if [ "$PROXY_HOP" = http ]; then
    APP_DOMAIN_VALUE="http://$DOMAIN"
    warn "--proxy-hop http: the connection between your reverse proxy and this host is NOT encrypted. Session cookies, passwords and restored data cross it in clear text, and port 80 of this host is open to the whole network. Use it only when the proxy and Restow share a host or an isolated network."
  else
    APP_DOMAIN_VALUE=$DOMAIN
  fi
}

show_plan() {
  local docker_action updater mounter signatures address
  case $DOCKER_STATE in
    missing) docker_action="install Docker Engine and the Compose plugin (Docker's apt repository)" ;;
    *) docker_action="use the installed Docker" ;;
  esac
  if [ "$DOCKER_COMPOSE_INSTALL" = 1 ]; then
    docker_action="use the installed Docker, add the Compose plugin"
  fi
  if [ "$OPT_UPDATER" = 1 ]; then
    updater="on: the application image in the updater role, pinned by digest on its first start (mounts the Docker socket; docs/UPDATING.md)"
  else
    updater="off (opt-in later, docs/UPDATING.md)"
  fi
  if [ "$OPT_MOUNTER" = 1 ]; then
    if [ "$OPT_UPDATER" = 1 ]; then
      mounter="on: the application image in the mounter role, moved along with every signed update (mounts the Docker socket; docs/MOUNTS.md)"
    else
      mounter="on: the application image in the mounter role, pinned by digest on its first start (mounts the Docker socket; docs/MOUNTS.md)"
    fi
  else
    mounter="off (opt-in later, docs/MOUNTS.md)"
  fi
  if [ "$OPT_SKIP_SIGNATURES" = 1 ]; then
    signatures="NOT checked (--skip-signature-check)"
  else
    signatures="checked with cosign (release workflow of v$VERSION)"
  fi
  case $MODE in
    local) address="$PUBLIC_URL (evaluation: the edge's own certificate authority)" ;;
    proxy) address="$PUBLIC_URL (served by your reverse proxy)" ;;
    *) address="$PUBLIC_URL (Let's Encrypt certificate)" ;;
  esac
  step "Plan"
  say "    Release      v$VERSION, $(edition_label "$EDITION")"
  say "    Images       $APP_IMAGE"
  say "                 $WEB_IMAGE"
  say "    Address      $address"
  if [ "$MODE" = proxy ]; then
    if [ "$PROXY_HOP" = http ]; then
      say "    TLS          at your reverse proxy: forward to $(edge_target) (not 3000). That hop is NOT encrypted."
    else
      say "    TLS          at your reverse proxy: forward to $(edge_target) (not 80, not 3000)"
      say "                 The hop is encrypted; the edge shows a certificate of its own authority."
    fi
    say "    Proxy        $TRUSTED_PROXIES (its client address is believed: X-Forwarded-For)"
    say "    HSTS         off here; leave it to your reverse proxy"
  fi
  say "    Directory    $OPT_DIR"
  say "    Docker       $docker_action"
  say "    Signatures   $signatures"
  say "    Updater      $updater"
  say "    Mounter      $mounter"
  if [ "$WARNINGS" -gt 0 ]; then
    say "    Warnings     $WARNINGS (see above)"
  fi
}

install_fresh() {
  collect_configuration
  step "Checking the target"
  check_ports
  check_disk
  if [ "$MODE" = public ] && [ "$DOMAIN_PLACEHOLDER" != 1 ]; then
    check_dns
  elif [ "$MODE" = proxy ]; then
    say "    note: $DOMAIN points at your reverse proxy, not at this server. Its DNS record and its certificate"
    say "    are the proxy's job here, so they are not checked."
  fi
  check_images
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
  start_stack "$OPT_UPDATER" 1 "$OPT_MOUNTER"
  wait_healthy
  check_edge "$DOMAIN"
  if [ "$MODE" = proxy ] && [ "$PROXY_HOP" = https ]; then
    export_edge_root_ca
  fi
  if is_dry; then
    say ""
    say "Dry run finished: nothing was changed."
    return 0
  fi
  log_line "installation finished: v$VERSION $EDITION in $OPT_DIR"
  print_summary
}

resume_existing() {
  local env="$OPT_DIR/.env" missing current_domain web_version app_domain
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
  app_domain=$(env_get "$env" RESTOW_APP_DOMAIN)
  PUBLIC_URL=$(env_get "$env" RESTOW_PUBLIC_URL)
  # How this installation is reached, from what the installation wrote (or the operator did).
  case $app_domain in
    http://*)
      MODE=proxy
      PROXY_HOP=http
      DOMAIN=${app_domain#http://}
      ;;
    *)
      DOMAIN=$app_domain
      if [ "$(env_get "$env" RESTOW_EDGE_TLS)" = internal ]; then
        MODE=proxy
        PROXY_HOP=https
      elif [ "$(domain_kind "$DOMAIN")" = internal ]; then
        MODE=local
        LOCAL_MODE=1
      else
        MODE=public
      fi
      ;;
  esac
  TRUSTED_PROXIES=$(env_get "$env" RESTOW_EDGE_TRUSTED_PROXIES)
  current_domain=$DOMAIN
  if [ -n "$OPT_VERSION" ] && [ "$OPT_VERSION" != "$VERSION" ]; then
    die "$EXIT_EXISTING" "this installation runs ${VERSION:-an unknown version}, not $OPT_VERSION. The installer does not update; follow docs/UPDATING.md (bash install.sh --upgrade)."
  fi
  if [ -n "$OPT_EDITION" ] && [ "$OPT_EDITION" != "$EDITION" ]; then
    die "$EXIT_EXISTING" "this installation runs the $(edition_label "$EDITION"). To switch builds, change RESTOW_IMAGE and RESTOW_WEB_IMAGE in $env yourself (deploy/release/README.md)."
  fi
  if [ -n "$OPT_DOMAIN" ] && [ "$OPT_DOMAIN" != "$current_domain" ]; then
    die "$EXIT_EXISTING" "this installation serves $current_domain. To change the domain, edit RESTOW_APP_DOMAIN and RESTOW_PUBLIC_URL in $env yourself."
  fi
  if [ "$OPT_BEHIND_PROXY" = 1 ] && [ "$MODE" != proxy ]; then
    die "$EXIT_EXISTING" "this installation was not set up behind a reverse proxy. The installer never changes .env; the settings for a reverse proxy are in $PROXY_DOCS_URL."
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
  if [ "$MODE" = proxy ] && [ "$PROXY_HOP" = https ]; then
    export_edge_root_ca
  fi
  if is_dry; then
    say ""
    say "Dry run finished: nothing was changed."
    return 0
  fi
  log_line "existing installation checked and running: $APP_IMAGE in $OPT_DIR"
  print_summary
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
  require_proxy_options
  require_mounter_release
  banner
  # A first run on a terminal explains itself before it asks anything; an installation that
  # exists already is only checked and started, so it needs no introduction.
  if mode_is_open && [ ! -f "$OPT_DIR/.env" ]; then
    print_intro
  fi
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
