#!/bin/sh
# Restow agent installer for Linux (systemd).
#
# Run it as shown in the Restow UI (Endpoints > New server / New client):
#
#   curl -fsSL 'https://<your instance>/install/linux.sh' | sudo sh
#
# and paste the one-time enrollment token when it asks (the input is hidden).
# The token never appears on a command line, in the process list or in the
# shell history. For unattended installs, put the token into a file that only
# root can read and pass its path: sudo RESTOW_TOKEN_FILE=/root/restow.token sh
#
# What it does: downloads the agent and restic from your Restow instance,
# checks the maintainer's signature over the release's SHA256SUMS and the
# SHA-256 of both binaries before anything is executed, installs them to the
# root-owned folder /opt/restow-agent/bin (their license notices to
# /opt/restow-agent/THIRD_PARTY_NOTICES.txt), installs and starts the systemd
# service restow-agent.service and enrolls this machine. Running it again
# repairs or upgrades the installation (also an earlier pre-release
# installation below /usr/local, which it moves); nothing is installed twice.
#
# Options (after `sh -s --`):
#   --hooks=off|scripts|any   whether hooks from the Restow server may run here
#                             (default off; see `restow-agent hooks --help`)
#   --uninstall               remove the agent again
#
#   curl -fsSL 'https://<your instance>/install/linux.sh' | sudo sh -s -- --uninstall
#   (or: sudo /opt/restow-agent/bin/restow-agent uninstall)
#
# The instance URL, the agent version and the release signing key below are
# filled in by your Restow instance when it serves this file.
set -eu
# Folders and files this script creates are root's, readable by all, writable by root only.
umask 022

INSTANCE_URL='__RESTOW_URL__'
AGENT_VERSION='__RESTOW_VERSION__'
# Public key the agent releases are signed with (empty: this instance ships
# no release key, then only development builds can be installed).
RELEASE_KEY='__RESTOW_RELEASE_KEY__'
SIG_NAMESPACE=restow-agent-release

# Test knobs (development and CI only): install below a prefix without root and
# without touching systemd; accept a plain http:// instance; accept an unsigned
# development build (never a release version).
ROOT="${RESTOW_INSTALL_ROOT:-}"
SKIP_SERVICE="${RESTOW_SKIP_SERVICE:-}"
ALLOW_HTTP="${RESTOW_ALLOW_INSECURE_HTTP:-}"
ALLOW_UNSIGNED_DEV="${RESTOW_ALLOW_UNSIGNED_DEV:-}"
# Manual alternative for systems without a signature tool: the SHA-256 of a
# SHA256SUMS whose signature you checked on another machine.
TRUSTED_SUMS_SHA256="${RESTOW_SHA256SUMS_SHA256:-}"

OS_NAME=linux
PREFIX="$ROOT/opt/restow-agent"
BIN_DIR="$PREFIX/bin"
AGENT_BIN="$BIN_DIR/restow-agent"
RESTIC_BIN="$BIN_DIR/restic"
# The licenses of the agent, of restic and of the Go modules in restic.
NOTICES_NAME=THIRD_PARTY_NOTICES.txt
NOTICES_FILE="$PREFIX/$NOTICES_NAME"
LINK="$ROOT/usr/local/bin/restow-agent"
LEGACY_AGENT="$ROOT/usr/local/bin/restow-agent"
LEGACY_LIB="$ROOT/usr/local/lib/restow-agent"
if [ -n "${RESTOW_AGENT_DIR:-}" ]; then
  STATE_FILE="$RESTOW_AGENT_DIR/state/state.json"
else
  STATE_FILE=/etc/restow-agent/state.json
fi

TMP=''
TTY_ECHO_OFF=''
TOKEN=''

say() { printf '%s\n' "$*"; }
step() { printf '==> %s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  if [ -n "$TTY_ECHO_OFF" ]; then
    stty echo </dev/tty 2>/dev/null || true
  fi
  if [ -n "$TMP" ] && [ -d "$TMP" ]; then
    rm -rf "$TMP"
  fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM HUP

usage() {
  cat <<'USAGE'
Usage: linux.sh [--hooks=off|scripts|any] [--uninstall]

  (no option)      install, repair or upgrade the Restow agent and enroll this machine
  --hooks=MODE     hooks from the Restow server: off (default), scripts (only scripts
                   in /etc/restow-agent/hooks.d) or any (any command, runs as root)
  --uninstall      remove the agent, its service and its stored credentials

Environment:
  RESTOW_TOKEN_FILE  file with the one-time enrollment token (unattended installs);
                     without it the installer asks for the token
USAGE
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d ' ' -f 1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d ' ' -f 1
  else
    die "neither sha256sum nor shasum is available; cannot verify the download"
  fi
}

fetch() {
  # fetch <url> <file>
  if [ -n "$ALLOW_HTTP" ]; then
    curl -fsSL --retry 3 --retry-delay 2 --connect-timeout 15 --max-time 900 -o "$2" "$1"
  else
    curl -fsSL --proto '=https' --tlsv1.2 --retry 3 --retry-delay 2 --connect-timeout 15 --max-time 900 -o "$2" "$1"
  fi
}

require_root() {
  if [ -z "$ROOT" ] && [ "$(id -u)" -ne 0 ]; then
    die "this installer must run as root. Use: curl -fsSL '<url>' | sudo sh"
  fi
}

# ---- trust: only root may be able to change what root runs ------------------

owner_of() { stat -c %u "$1"; }
mode_of() { stat -c %a "$1"; }

# trusted_entry <path>: owned by root (or by the user running a relocated test
# install) and not writable by group or others.
trusted_entry() {
  _owner=$(owner_of "$1") || return 1
  if [ "$_owner" != 0 ] && [ "$_owner" != "$(id -u)" ]; then
    return 1
  fi
  _mode=$(mode_of "$1") || return 1
  [ $((0$_mode & 022)) -eq 0 ]
}

# check_trusted_dir <dir>: the folder and every folder above it (below ROOT
# in a relocated test install) are trusted; dies otherwise.
check_trusted_dir() {
  _path="$1"
  _walk=''
  _rest="${_path#"$ROOT"}"
  [ -n "$ROOT" ] && _walk="$ROOT"
  if [ -z "$ROOT" ]; then
    trusted_entry / || die "/ is not owned by root or is writable by others; refusing to install"
  fi
  _old_ifs=$IFS
  IFS=/
  set -f
  # shellcheck disable=SC2086
  set -- $_rest
  set +f
  IFS=$_old_ifs
  for _part in "$@"; do
    [ -n "$_part" ] || continue
    _walk="$_walk/$_part"
    [ -e "$_walk" ] || continue
    if [ -L "$_walk" ]; then
      die "$_walk is a symbolic link; the install folder must be a real folder owned by root"
    fi
    trusted_entry "$_walk" || die "$_walk is not owned by root or is writable by group or others ($(mode_of "$_walk"), owner uid $(owner_of "$_walk")). The agent runs as root and is only installed where no other user can change it. Fix the folder (or remove it if you did not create it) and run this again."
  done
}

# make_root_dir <dir>: create a root-owned 0755 folder after checking the chain.
make_root_dir() {
  check_trusted_dir "$1"
  if [ ! -d "$1" ]; then
    mkdir -p "$1"
  fi
  chmod 0755 "$1"
  if [ "$(id -u)" -eq 0 ]; then
    chown 0:0 "$1"
  fi
  check_trusted_dir "$1"
}

# install_file <source> <destination> [mode]: staged under a random name in the
# destination folder (mktemp: a fresh file, never something prepared in its
# place), then renamed over the old file. Mode 0755 unless given.
install_file() {
  _staged=$(mktemp "$(dirname "$2")/.$(basename "$2").new-XXXXXX") || die "cannot create a temporary file in $(dirname "$2")"
  cat "$1" >"$_staged" || {
    rm -f "$_staged"
    die "cannot write $_staged"
  }
  chmod "${3:-0755}" "$_staged"
  if [ "$(id -u)" -eq 0 ]; then
    chown 0:0 "$_staged"
  fi
  mv -f "$_staged" "$2"
}

# ---- release signature ------------------------------------------------------

is_dev_version() {
  case "$AGENT_VERSION" in
    *-dev | *-dev.*) return 0 ;;
  esac
  return 1
}

key_line() { printf '%s' "$RELEASE_KEY" | awk '{ print $1 " " $2 }'; }

# key_fingerprint prints the release key's SHA-256 fingerprint as `ssh-keygen -l`
# shows it (compare it with the one published in the release notes).
key_fingerprint() {
  _fp=''
  if command -v ssh-keygen >/dev/null 2>&1; then
    _fp=$(key_line | ssh-keygen -l -f - 2>/dev/null | awk '{ print $2 }') || _fp=''
  fi
  if [ -z "$_fp" ] && command -v openssl >/dev/null 2>&1; then
    _fp="SHA256:$(printf '%s' "$RELEASE_KEY" | awk '{ print $2 }' | openssl base64 -d -A 2>/dev/null |
      openssl dgst -sha256 -binary | openssl base64 -A | tr -d '=')"
  fi
  printf '%s' "${_fp:-$(key_line)}"
}

# verify_with_ssh_keygen <file> <sig>: 0 good, 1 bad signature, 2 tool unusable.
verify_with_ssh_keygen() {
  command -v ssh-keygen >/dev/null 2>&1 || return 2
  printf '%s %s\n' "$SIG_NAMESPACE" "$(key_line)" >"$TMP/allowed_signers"
  if _out=$(ssh-keygen -Y verify -f "$TMP/allowed_signers" -I "$SIG_NAMESPACE" -n "$SIG_NAMESPACE" -s "$2" <"$1" 2>&1); then
    return 0
  fi
  case "$_out" in
    *"illegal option"* | *"unknown option"* | *"usage:"* | *"Usage:"*) return 2 ;;
  esac
  VERIFY_DETAIL="$_out"
  return 1
}

# verify_with_openssl <file> <sig>: the same SSH signature checked with
# OpenSSL 3 (Ed25519 over the SSHSIG structure). 0 good, 1 bad, 2 unusable.
verify_with_openssl() {
  command -v openssl >/dev/null 2>&1 || return 2
  case "$(openssl version 2>/dev/null)" in
    "OpenSSL 3."* | "OpenSSL 4."*) ;;
    *) return 2 ;;
  esac
  _d="$TMP/openssl"
  mkdir -p "$_d"
  printf '%s' "$RELEASE_KEY" | awk '{ print $2 }' | openssl base64 -d -A >"$_d/keyblob" 2>/dev/null || return 1
  [ "$(wc -c <"$_d/keyblob" | tr -d ' ')" = 51 ] || return 1
  { printf '\060\052\060\005\006\003\053\145\160\003\041\000'; tail -c 32 "$_d/keyblob"; } >"$_d/spki.der"
  openssl pkey -pubin -inform DER -in "$_d/spki.der" -out "$_d/pub.pem" 2>/dev/null || return 2
  sed -e '/^-----/d' "$2" | tr -d '\n\r ' | openssl base64 -d -A >"$_d/sigblob" 2>/dev/null || return 1
  tail -c 64 "$_d/sigblob" >"$_d/sig.raw"
  {
    printf 'SSHSIG\000\000\000\024%s\000\000\000\000\000\000\000\006sha512\000\000\000\100' "$SIG_NAMESPACE"
    openssl dgst -sha512 -binary "$1"
  } >"$_d/signed"
  if openssl pkeyutl -verify -pubin -inkey "$_d/pub.pem" -rawin -in "$_d/signed" -sigfile "$_d/sig.raw" >/dev/null 2>&1; then
    return 0
  fi
  VERIFY_DETAIL="OpenSSL: the signature does not match"
  return 1
}

# verify_release <SHA256SUMS> <SHA256SUMS.sig>: dies unless the file is signed
# with the release key (or explicitly pinned, or a development build allowed).
verify_release() {
  if [ -n "$TRUSTED_SUMS_SHA256" ]; then
    _have=$(sha256_of "$1")
    [ "$_have" = "$TRUSTED_SUMS_SHA256" ] || die "SHA256SUMS hashes to $_have, not to the value in RESTOW_SHA256SUMS_SHA256. Nothing was installed."
    say "    SHA256SUMS: matches the SHA-256 you verified (RESTOW_SHA256SUMS_SHA256)"
    return 0
  fi
  if [ -z "$RELEASE_KEY" ]; then
    if is_dev_version && [ -n "$ALLOW_UNSIGNED_DEV" ]; then
      warn "development build $AGENT_VERSION: the release signature is NOT checked (RESTOW_ALLOW_UNSIGNED_DEV)"
      return 0
    fi
    die "this Restow instance has no release signing key, so the agent cannot be verified. Nothing was installed. Update Restow to a release that ships signed agents."
  fi
  if [ ! -s "$2" ]; then
    if is_dev_version && [ -n "$ALLOW_UNSIGNED_DEV" ]; then
      warn "development build $AGENT_VERSION is not signed; the signature is NOT checked (RESTOW_ALLOW_UNSIGNED_DEV)"
      return 0
    fi
    die "agent $AGENT_VERSION on this instance is not signed (no SHA256SUMS.sig). Nothing was installed."
  fi
  VERIFY_DETAIL=''
  _rc=0
  verify_with_ssh_keygen "$1" "$2" || _rc=$?
  if [ "$_rc" -eq 2 ]; then
    _rc=0
    verify_with_openssl "$1" "$2" || _rc=$?
  fi
  case "$_rc" in
    0) say "    signature: OK (release key $(key_fingerprint))" ;;
    1) die "the release signature does not match ($VERIFY_DETAIL). The files may have been changed. Nothing was installed." ;;
    *) die "this system can check the release signature neither with ssh-keygen (OpenSSH 8.1 or newer) nor with OpenSSL 3. Install one of them, or check SHA256SUMS.sig on another machine (see the Restow agent documentation) and run again with RESTOW_SHA256SUMS_SHA256=<SHA-256 of SHA256SUMS>. Nothing was installed." ;;
  esac
}

# ---- token --------------------------------------------------------------------

# read_token sets TOKEN from RESTOW_TOKEN_FILE, RESTOW_TOKEN or a hidden prompt.
read_token() {
  if [ -n "${RESTOW_TOKEN_FILE:-}" ]; then
    [ -f "$RESTOW_TOKEN_FILE" ] || die "RESTOW_TOKEN_FILE $RESTOW_TOKEN_FILE does not exist"
    case "$(mode_of "$RESTOW_TOKEN_FILE")" in
      *00) ;;
      *) warn "$RESTOW_TOKEN_FILE can be read by other users; keep token files at mode 0600 and delete them after use" ;;
    esac
    TOKEN=$(head -n 1 "$RESTOW_TOKEN_FILE" | tr -d '\r\n\t ')
  elif [ -n "${RESTOW_TOKEN:-}" ]; then
    TOKEN="$RESTOW_TOKEN"
  elif (: </dev/tty) 2>/dev/null; then
    printf 'Paste the enrollment token from the Restow UI (input is hidden): ' >/dev/tty
    if stty -echo </dev/tty 2>/dev/null; then
      TTY_ECHO_OFF=yes
    fi
    IFS= read -r TOKEN </dev/tty || TOKEN=''
    if [ -n "$TTY_ECHO_OFF" ]; then
      stty echo </dev/tty 2>/dev/null || true
      TTY_ECHO_OFF=''
    fi
    printf '\n' >/dev/tty
    TOKEN=$(printf '%s' "$TOKEN" | tr -d '\r\n\t ')
  fi
  unset RESTOW_TOKEN
}

# ---- legacy (an earlier pre-release installation below /usr/local) -------------

has_legacy() {
  if [ -f "$LEGACY_AGENT" ] && [ ! -L "$LEGACY_AGENT" ]; then
    return 0
  fi
  [ -e "$LEGACY_LIB" ]
}

remove_legacy() {
  if [ -f "$LEGACY_AGENT" ] && [ ! -L "$LEGACY_AGENT" ]; then
    rm -f "$LEGACY_AGENT"
    say "    removed $LEGACY_AGENT (location of an earlier pre-release installation)"
  fi
  rm -f "$LEGACY_AGENT.prev" "$(dirname "$LEGACY_AGENT")/.restow-agent.new" "$LEGACY_LIB/restic" "$LEGACY_LIB/.restic.new"
  if [ -d "$LEGACY_LIB" ] && rmdir "$LEGACY_LIB" 2>/dev/null; then
    say "    removed $LEGACY_LIB (location of an earlier pre-release installation)"
  fi
}

# make_link: /usr/local/bin/restow-agent for administrators, only where that
# folder belongs to root (a link in a user's folder could be swapped and run with sudo).
make_link() {
  if [ -e "$LINK" ] || [ -L "$LINK" ]; then
    return 0
  fi
  _ldir=$(dirname "$LINK")
  [ -d "$_ldir" ] || return 0
  if (check_trusted_dir "$_ldir") >/dev/null 2>&1; then
    ln -s "$AGENT_BIN" "$LINK" && say "    $LINK -> $AGENT_BIN"
  fi
}

stop_service() {
  [ -z "$SKIP_SERVICE" ] || return 0
  systemctl stop restow-agent.service >/dev/null 2>&1 || true
}

uninstall() {
  step "Removing the Restow agent"
  if [ -x "$AGENT_BIN" ] && (check_trusted_dir "$BIN_DIR") >/dev/null 2>&1; then
    "$AGENT_BIN" uninstall --yes
  else
    # The binary is missing (or not trustworthy): remove by hand, never run it.
    if [ -z "$SKIP_SERVICE" ] && command -v systemctl >/dev/null 2>&1; then
      systemctl stop restow-agent.service >/dev/null 2>&1 || true
      systemctl disable restow-agent.service >/dev/null 2>&1 || true
      rm -f /etc/systemd/system/restow-agent.service
      systemctl daemon-reload >/dev/null 2>&1 || true
    fi
    rm -rf /etc/restow-agent /var/lib/restow-agent /var/log/restow-agent
  fi
  # The same result in a relocated (test) layout and for the leftovers of an
  # earlier pre-release installation.
  rm -f "$AGENT_BIN" "$AGENT_BIN.prev" "$RESTIC_BIN" "$NOTICES_FILE"
  rmdir "$BIN_DIR" "$PREFIX" 2>/dev/null || true
  if [ -L "$LINK" ]; then
    rm -f "$LINK"
  fi
  remove_legacy
  say ""
  say "The agent was removed from this machine. Backups stay on your Restow instance."
  say "Revoke this endpoint in the Restow UI (Endpoints) to finish the removal there."
}

main() {
  action=install
  HOOKS=''
  while [ $# -gt 0 ]; do
    case "$1" in
      --uninstall) action=uninstall ;;
      --hooks=*) HOOKS="${1#--hooks=}" ;;
      --hooks)
        [ $# -ge 2 ] || die "--hooks needs a value: off, scripts or any"
        HOOKS="$2"
        shift
        ;;
      -h | --help)
        usage
        exit 0
        ;;
      *)
        usage >&2
        die "unknown option: $1"
        ;;
    esac
    shift
  done
  case "$HOOKS" in
    '' | off | scripts | any) ;;
    *) die "--hooks must be off, scripts or any" ;;
  esac

  [ "$(uname -s)" = "Linux" ] || die "this installer is for Linux; use macos.sh on macOS"
  require_root

  if [ "$action" = uninstall ]; then
    uninstall
    exit 0
  fi

  # ---- checks before anything is downloaded or changed --------------------
  case "$INSTANCE_URL" in
    *__RESTOW_*)
      # Not served by a Restow instance (the placeholders are still there).
      INSTANCE_URL="${RESTOW_URL:-}"
      [ -n "$INSTANCE_URL" ] || die "this file has not been prepared by your Restow instance. Download it from https://<your instance>/install/linux.sh"
      ;;
  esac
  case "$AGENT_VERSION" in
    *__RESTOW_*) AGENT_VERSION="${RESTOW_VERSION:-}" ;;
  esac
  case "$RELEASE_KEY" in
    *__RESTOW_*) RELEASE_KEY="${RESTOW_RELEASE_KEY:-}" ;;
  esac
  [ -n "$AGENT_VERSION" ] || die "unknown agent version"
  INSTANCE_URL="${INSTANCE_URL%/}"
  case "$INSTANCE_URL" in
    https://*) ;;
    http://*) [ -n "$ALLOW_HTTP" ] || die "the instance URL must start with https:// ($INSTANCE_URL)" ;;
    *) die "the instance URL must start with https:// ($INSTANCE_URL)" ;;
  esac
  case "$AGENT_VERSION" in
    *[!0-9A-Za-z.+-]*) die "invalid agent version" ;;
  esac
  case "$RELEASE_KEY" in
    '' | 'ssh-ed25519 '*) ;;
    *) die "the release signing key of this instance is not an ssh-ed25519 key" ;;
  esac

  if [ -z "$SKIP_SERVICE" ] && [ ! -d /run/systemd/system ]; then
    die "this Linux system does not run systemd. The Restow agent supports systemd only."
  fi
  command -v curl >/dev/null 2>&1 || die "curl is required"

  machine=$(uname -m)
  case "$machine" in
    x86_64 | amd64) arch=amd64 ;;
    aarch64 | arm64) arch=arm64 ;;
    *) die "unsupported CPU architecture: $machine (supported: x86_64, aarch64)" ;;
  esac
  target="$OS_NAME-$arch"

  # The install folder must be root's alone before anything is downloaded.
  check_trusted_dir "$BIN_DIR"

  enrolled=no
  [ -f "$STATE_FILE" ] && enrolled=yes
  if [ "$enrolled" = no ]; then
    read_token
    [ -n "$TOKEN" ] || die "this machine is not enrolled and no enrollment token was given. Create a server or client in the Restow UI (Endpoints), run the command shown there and paste the token when asked (or set RESTOW_TOKEN_FILE)."
  else
    unset RESTOW_TOKEN
  fi

  say "Restow agent installer for Linux ($arch)"
  say "Instance: $INSTANCE_URL"
  say "Version:  $AGENT_VERSION"
  say ""

  # ---- download and verify (nothing is executed before this passed) ---------
  TMP=$(mktemp -d)
  base="$INSTANCE_URL/install/agent/$AGENT_VERSION"
  step "Downloading the agent and restic from your Restow instance"
  fetch "$base/SHA256SUMS" "$TMP/SHA256SUMS" || die "cannot download $base/SHA256SUMS. Check that this machine can reach $INSTANCE_URL over HTTPS and that the instance provides agent version $AGENT_VERSION."
  fetch "$base/SHA256SUMS.sig" "$TMP/SHA256SUMS.sig" 2>/dev/null || : >"$TMP/SHA256SUMS.sig"
  fetch "$base/$target/restow-agent" "$TMP/restow-agent" || die "cannot download the agent from $base/$target/restow-agent"
  fetch "$base/$target/restic" "$TMP/restic" || die "cannot download restic from $base/$target/restic"
  # The license notices: part of every release built since they exist, checked like the binaries.
  files="restow-agent restic"
  if awk -v n="$target/$NOTICES_NAME" '$2 == n || $2 == "*" n { found = 1 } END { exit !found }' "$TMP/SHA256SUMS"; then
    fetch "$base/$target/$NOTICES_NAME" "$TMP/$NOTICES_NAME" || die "cannot download the license notices from $base/$target/$NOTICES_NAME"
    files="$files $NOTICES_NAME"
  fi

  step "Verifying the release signature and the SHA-256 checksums"
  verify_release "$TMP/SHA256SUMS" "$TMP/SHA256SUMS.sig"
  for name in $files; do
    expected=$(awk -v n="$target/$name" '$2 == n || $2 == "*" n { print $1 }' "$TMP/SHA256SUMS")
    [ -n "$expected" ] || die "SHA256SUMS has no entry for $target/$name"
    actual=$(sha256_of "$TMP/$name")
    if [ "$expected" != "$actual" ]; then
      die "checksum mismatch for $name (expected $expected, got $actual). Nothing was installed."
    fi
    say "    $name: OK"
  done
  chmod 0755 "$TMP/restow-agent" "$TMP/restic"
  reported=$("$TMP/restow-agent" version --short 2>/dev/null || true)
  [ "$reported" = "$AGENT_VERSION" ] || die "the downloaded agent reports version '$reported', expected '$AGENT_VERSION'. Nothing was installed."

  # ---- install ---------------------------------------------------------------
  legacy=no
  has_legacy && legacy=yes
  if [ -x "$AGENT_BIN" ]; then
    old=unknown
    if trusted_entry "$AGENT_BIN"; then
      old=$("$AGENT_BIN" version --short 2>/dev/null || echo unknown)
    fi
    step "Existing installation found (version $old): repairing/upgrading"
    stop_service
  elif [ "$legacy" = yes ]; then
    step "Found an earlier pre-release installation below /usr/local: moving it to $PREFIX"
    stop_service
  else
    step "Installing"
  fi
  make_root_dir "$PREFIX"
  make_root_dir "$BIN_DIR"
  install_file "$TMP/restic" "$RESTIC_BIN"
  install_file "$TMP/restow-agent" "$AGENT_BIN"
  say "    $AGENT_BIN"
  say "    $RESTIC_BIN"
  if [ -f "$TMP/$NOTICES_NAME" ]; then
    install_file "$TMP/$NOTICES_NAME" "$NOTICES_FILE" 0644
    say "    $NOTICES_FILE (licenses of the agent, restic and the software in restic)"
  else
    warn "agent $AGENT_VERSION comes without its license notices ($NOTICES_NAME); they are in THIRD_PARTY_NOTICES.md of your Restow release"
  fi

  if [ -n "$ROOT" ]; then
    RESTOW_RESTIC_PATH="$RESTIC_BIN"
    export RESTOW_RESTIC_PATH
  fi

  if [ -z "$SKIP_SERVICE" ]; then
    step "Installing the systemd service restow-agent.service"
    "$AGENT_BIN" service install
  fi
  if [ "$legacy" = yes ]; then
    remove_legacy
  fi
  make_link

  # ---- enroll ----------------------------------------------------------------
  if [ "$enrolled" = yes ]; then
    step "This machine is already enrolled; keeping the existing enrollment"
    if [ -n "$HOOKS" ]; then
      "$AGENT_BIN" hooks "$HOOKS" >/dev/null
      say "    hooks from the Restow server: $HOOKS"
    fi
  else
    step "Enrolling this machine"
    enroll_flags=''
    [ -n "$ALLOW_HTTP" ] && enroll_flags='--allow-insecure-http'
    [ -n "$HOOKS" ] && enroll_flags="$enroll_flags --hooks=$HOOKS"
    # The token goes to the agent through the environment of this one command.
    # shellcheck disable=SC2086
    RESTOW_TOKEN="$TOKEN" RESTOW_URL="$INSTANCE_URL" "$AGENT_BIN" enroll $enroll_flags || {
      say ""
      say "The agent is installed but not enrolled. Create a new token in the Restow UI"
      say "(the old one may have expired or been used) and run the install command again."
      exit 1
    }
  fi
  TOKEN=''

  # ---- start -------------------------------------------------------------------
  if [ -z "$SKIP_SERVICE" ]; then
    step "Starting the service"
    "$AGENT_BIN" service restart
  fi

  say ""
  say "Done. The Restow agent $AGENT_VERSION is installed and enrolled."
  say ""
  "$AGENT_BIN" status || true
  say ""
  say "Next: the first backup runs at the time set in the Restow UI (you can start one there with 'Back up now')."
  say "Hooks:   whether hooks from the Restow server may run here: sudo $AGENT_BIN hooks --help"
  say "Logs:    journalctl -u restow-agent   and   /var/log/restow-agent/agent.log"
  say "Remove:  sudo $AGENT_BIN uninstall"
}

main "$@"
