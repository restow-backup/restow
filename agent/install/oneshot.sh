#!/bin/sh
# Restow: restore a whole machine onto THIS fresh machine, without an ISO
# (preview; docs/BAREMETAL-ONESHOT.md in the Restow repository).
#
# Run it on the fresh machine in a root shell (sudo -i first), as shown in
# the Restow UI:
#
#   curl -fsSL 'https://<your instance>/install/oneshot.sh' | RESTOW_ONESHOT_CODE='OS-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX' sh
#
# The code comes in the environment, which only root can read, never on a
# command line, which every user of the machine can read (and sudo logs).
# The script takes it out of its environment and hands it to the agent over
# stdin.
#
# What it does: downloads restow-agent from your Restow instance, checks the
# maintainer's signature over the release's SHA256SUMS and the SHA-256 of the
# agent before it runs, and starts `restow-agent oneshot`. That command checks
# this machine, redeems the one-time code, downloads and checks the recovery
# ISO, asks you to confirm the disks, waits for the release in Restow and then
# switches this machine into the recovery environment, which ERASES its disks
# and restores the backup. Nothing is changed before the release; the script
# installs nothing, creates no service and changes no package source.
#
# Options (sh -s -- <options>): --answers <file> (unattended), --lang de|en,
# --keymap us|de|ch|at|fr, --direct (in the provider's rescue system when
# kexec is not possible there: restow-agent and restic restore from the
# rescue system itself; the script then downloads and checks restic too).
#
# Environment: RESTOW_SHA256SUMS_SHA256 (the SHA-256 of a SHA256SUMS whose
# signature you checked elsewhere; then the recovery ISO is checked against
# exactly that list too), RESTOW_CA_FILE (the CA of a private instance).
#
# The instance URL, the agent version and the release signing key below are
# filled in by your Restow instance when it serves this file.
set -eu
umask 077

INSTANCE_URL='__RESTOW_URL__'
AGENT_VERSION='__RESTOW_VERSION__'
RELEASE_KEY='__RESTOW_RELEASE_KEY__'
SIG_NAMESPACE=restow-agent-release

# Test knobs (development and CI only): a plain http:// instance; an unsigned
# development build; a work folder below a given one, without root.
ALLOW_HTTP="${RESTOW_ALLOW_INSECURE_HTTP:-}"
ALLOW_UNSIGNED_DEV="${RESTOW_ALLOW_UNSIGNED_DEV:-}"
TEST_DIR="${RESTOW_ONESHOT_TEST_DIR:-}"
TRUSTED_SUMS_SHA256="${RESTOW_SHA256SUMS_SHA256:-}"
CA_FILE="${RESTOW_CA_FILE:-}"

TMP=''

say() { printf '%s\n' "$*"; }
step() { printf '==> %s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

# shellcheck disable=SC2317,SC2329 # run by the EXIT trap (SC2317 for older ShellCheck)
cleanup() {
  if [ -n "$TMP" ] && [ -d "$TMP" ]; then
    rm -rf "$TMP"
  fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM HUP

fetch() {
  # fetch <url> <file>
  if [ -n "$CA_FILE" ]; then
    set -- "$1" "$2" --cacert "$CA_FILE"
  fi
  if [ -n "$ALLOW_HTTP" ]; then
    curl -fsSL --retry 3 --retry-delay 2 --connect-timeout 15 --max-time 900 -o "$2" "$@"
  else
    curl -fsSL --proto '=https' --tlsv1.2 --retry 3 --retry-delay 2 --connect-timeout 15 --max-time 900 -o "$2" "$@"
  fi
}

# ---- shared with linux.sh (a test keeps the copies equal) --------------------

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d ' ' -f 1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d ' ' -f 1
  else
    die "neither sha256sum nor shasum is available; cannot verify the download"
  fi
}

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

# ---- end of the part shared with linux.sh ------------------------------------

# work_dir <base>: a fresh folder of root's, 0700.
work_dir() {
  mktemp -d "$1/restow-oneshot.XXXXXX" 2>/dev/null
}

main() {
  CODE="${RESTOW_ONESHOT_CODE:-}"
  unset RESTOW_ONESHOT_CODE
  DIRECT=''
  for _arg in "$@"; do
    case "$_arg" in
      --direct) DIRECT=yes ;;
      # The agent's flag parser also takes these forms; only the exact one
      # makes this script download and check restic.
      -direct | -direct=* | --direct=*) die "write the option exactly as --direct" ;;
      -restic | -restic=* | --restic | --restic=*) die "--restic is set by this script (with --direct)" ;;
      [Oo][Ss]-*) die "the code does not belong on the command line, where every user of this machine can read it. Copy the command from Restow again: curl -fsSL '<instance>/install/oneshot.sh' | RESTOW_ONESHOT_CODE='OS-...' sh" ;;
    esac
  done
  [ -n "$CODE" ] || die "no code: run the command from Restow in a root shell (sudo -i first): curl -fsSL '<instance>/install/oneshot.sh' | RESTOW_ONESHOT_CODE='OS-...' sh"
  case "$CODE" in
    [Oo][Ss]-*) ;;
    *) die "RESTOW_ONESHOT_CODE must be the one-time code from Restow (OS-...)" ;;
  esac
  case "$CODE" in
    *[!0-9A-Za-z-]*) die "the code has characters that do not belong in it; copy the command from Restow again" ;;
  esac

  [ "$(uname -s)" = "Linux" ] || die "a restore without an ISO runs on Linux only"
  case "$(uname -m)" in
    x86_64 | amd64) ;;
    *) die "this machine is not x86_64 ($(uname -m)); use the recovery ISO" ;;
  esac
  if [ -z "$TEST_DIR" ] && [ "$(id -u)" -ne 0 ]; then
    die "run this as root (sudo -i, then paste the command again)"
  fi

  case "$INSTANCE_URL" in
    *__RESTOW_*)
      INSTANCE_URL="${RESTOW_URL:-}"
      [ -n "$INSTANCE_URL" ] || die "this file has not been prepared by your Restow instance. Copy the command from Restow."
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
  if [ -n "$CA_FILE" ] && [ ! -r "$CA_FILE" ]; then
    die "RESTOW_CA_FILE ($CA_FILE) cannot be read"
  fi
  command -v curl >/dev/null 2>&1 || die "curl is required"

  # /run is a tmpfs; where it does not allow running programs, /var/tmp.
  bases="/run /var/tmp"
  [ -z "$TEST_DIR" ] || bases="$TEST_DIR"
  for base in $bases; do
    TMP=$(work_dir "$base") || TMP=''
    [ -n "$TMP" ] && break
  done
  [ -n "$TMP" ] || die "cannot create a work folder in $bases"

  say "Restow: restore onto this machine without an ISO"
  say "Instance: $INSTANCE_URL"
  say "Version:  $AGENT_VERSION"
  say ""
  base_url="$INSTANCE_URL/install/agent/$AGENT_VERSION"
  step "Downloading restow-agent from your Restow instance"
  fetch "$base_url/SHA256SUMS" "$TMP/SHA256SUMS" || die "cannot download $base_url/SHA256SUMS. Check that this machine can reach $INSTANCE_URL over HTTPS."
  fetch "$base_url/SHA256SUMS.sig" "$TMP/SHA256SUMS.sig" 2>/dev/null || : >"$TMP/SHA256SUMS.sig"
  fetch "$base_url/linux-amd64/restow-agent" "$TMP/restow-agent" || die "cannot download the agent from $base_url/linux-amd64/restow-agent"
  files=restow-agent
  if [ -n "$DIRECT" ]; then
    fetch "$base_url/linux-amd64/restic" "$TMP/restic" || die "cannot download restic from $base_url/linux-amd64/restic"
    files="restow-agent restic"
  fi

  step "Verifying the release signature and the SHA-256 checksum"
  verify_release "$TMP/SHA256SUMS" "$TMP/SHA256SUMS.sig"
  for name in $files; do
    sum=$(awk -v n="linux-amd64/$name" '$2 == n || $2 == "*" n { print $1 }' "$TMP/SHA256SUMS")
    [ -n "$sum" ] || die "SHA256SUMS has no entry for linux-amd64/$name"
    actual=$(sha256_of "$TMP/$name")
    [ "$sum" = "$actual" ] || die "checksum mismatch for $name (expected $sum, got $actual). Nothing was changed."
    say "    $name: OK"
    chmod 0700 "$TMP/$name"
  done
  if ! reported=$("$TMP/restow-agent" version --short 2>/dev/null); then
    # The folder does not allow running programs (noexec): once more below /var/tmp.
    [ -z "$TEST_DIR" ] || die "the downloaded agent does not run"
    moved=$(work_dir /var/tmp) || die "the downloaded agent cannot run in $TMP, and /var/tmp has no room for it"
    for name in SHA256SUMS $files; do
      cp "$TMP/$name" "$moved/$name"
    done
    rm -rf "$TMP"
    TMP=$moved
    for name in $files; do
      sum=$(awk -v n="linux-amd64/$name" '$2 == n || $2 == "*" n { print $1 }' "$TMP/SHA256SUMS")
      [ "$(sha256_of "$TMP/$name")" = "$sum" ] || die "the copy of $name changed"
      chmod 0700 "$TMP/$name"
    done
    reported=$("$TMP/restow-agent" version --short 2>/dev/null) || die "the downloaded agent does not run on this machine"
  fi
  [ "$reported" = "$AGENT_VERSION" ] || die "the downloaded agent reports version '$reported', expected '$AGENT_VERSION'. Nothing was changed."

  say ""
  if [ -n "$CA_FILE" ]; then
    export RESTOW_CA_FILE="$CA_FILE"
  fi
  if [ -n "$TRUSTED_SUMS_SHA256" ]; then
    export RESTOW_SHA256SUMS_SHA256="$TRUSTED_SUMS_SHA256"
  fi
  # The code goes over stdin, never into the process list; the agent asks
  # its questions on the terminal.
  if [ -n "$DIRECT" ]; then
    set -- "$@" --restic "$TMP/restic"
  fi
  rc=0
  printf '%s\n' "$CODE" | "$TMP/restow-agent" oneshot --instance "$INSTANCE_URL" --code-stdin "$@" || rc=$?
  exit "$rc"
}

main "$@"
