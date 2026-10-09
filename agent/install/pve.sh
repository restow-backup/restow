#!/bin/sh
# Restow node helper installer for Proxmox VE (8.4 or newer, x86_64).
#
# Run it as root on every node that should back up its guests, exactly as
# Restow shows it (Servers & clients > VMs & containers > Connect Proxmox VE),
# with the node's one-time enrollment token in the environment:
#
#   curl -fsSL 'https://<your instance>/install/pve.sh' | RESTOW_ENROLL_TOKEN='rset_...' sh
#
# Nothing to type. Before it downloads anything it
#   - checks the enrollment token with Restow,
#   - sets up the PVE side (idempotent, cluster-wide): user restow@pve, pool
#     restow-restore, roles RestowBackup and RestowRestore with their ACLs,
#   - creates the node's own API token restow@pve!<node> (privilege separation
#     off; an older token of that name is replaced, PVE cannot show a secret
#     twice). Its secret stays on this node. Instead, an existing API token is
#     used when the admin entered one in Restow for this enrollment token, or
#     when RESTOW_PVE_TOKEN_ID and RESTOW_PVE_TOKEN_SECRET_FILE are set,
#   - checks that the token holds every privilege backups need,
#   - picks the fleecing storage: the node's only thin storage, else local-lvm,
#     local-zfs, else the first thin one (--fleecing-storage=NAME overrides).
#
# Then it downloads restow-pve, restic and the storage plugin shim from your
# Restow instance (or takes them from RESTOW_PVE_LOCAL_DIR), checks the
# maintainer's signature over SHA256SUMS and the SHA-256 of every file before
# anything is executed, installs
#   /opt/restow-pve/bin/restow-pve, /opt/restow-pve/bin/restic
#   /usr/share/perl5/PVE/Storage/Custom/RestowPlugin.pm
#   /usr/share/perl5/PVE/BackupProvider/Plugin/Restow.pm
# (the two Perl modules are a separate work under AGPL-3.0-or-later; the
# license text goes to /opt/restow-pve/RestowPlugin.LICENSE.txt), enrolls the
# node, adds the storage `restow` to the cluster once (content backup, limited
# to the nodes that have the plugin), installs restow-pve.service and restarts
# the PVE daemons so they load the plugin. Running it again repairs or
# upgrades in place and keeps the enrollment.
#
# Options (after `sh -s --`):
#   --fleecing-storage=NAME    the fleecing storage of this node
#   --uninstall                remove restow-pve and the plugin again
set -eu
umask 022

INSTANCE_URL='__RESTOW_URL__'
AGENT_VERSION='__RESTOW_VERSION__'
RELEASE_KEY='__RESTOW_RELEASE_KEY__'
SIG_NAMESPACE=restow-agent-release

ROOT="${RESTOW_INSTALL_ROOT:-}"
SKIP_SERVICE="${RESTOW_SKIP_SERVICE:-}"
ALLOW_HTTP="${RESTOW_ALLOW_INSECURE_HTTP:-}"
ALLOW_UNSIGNED_DEV="${RESTOW_ALLOW_UNSIGNED_DEV:-}"
TRUSTED_SUMS_SHA256="${RESTOW_SHA256SUMS_SHA256:-}"
# A folder with the release files (SHA256SUMS[.sig] and linux-amd64/...), for
# nodes without access to the instance's /install path or for test builds.
LOCAL_DIR="${RESTOW_PVE_LOCAL_DIR:-}"

PREFIX="$ROOT/opt/restow-pve"
BIN_DIR="$PREFIX/bin"
PVE_BIN="$BIN_DIR/restow-pve"
PLUGIN_FILE="$ROOT/usr/share/perl5/PVE/Storage/Custom/RestowPlugin.pm"
PROVIDER_FILE="$ROOT/usr/share/perl5/PVE/BackupProvider/Plugin/Restow.pm"
STATE_FILE="$ROOT/etc/restow-pve/state.json"
RESTORE_POOL=restow-restore
RESTORE_PRIVS="VM.Allocate,VM.Config.Disk,VM.Config.CDROM,VM.Config.CPU,VM.Config.Memory,VM.Config.Network,VM.Config.HWType,VM.Config.Options,VM.Config.Cloudinit,Datastore.AllocateSpace,SDN.Use"

PVE_TOKEN_ID="${RESTOW_PVE_TOKEN_ID:-}"
PVE_TOKEN_SECRET=''
if [ -n "${RESTOW_PVE_TOKEN_SECRET_FILE:-}" ]; then
  PVE_TOKEN_SECRET=$(head -n 1 "$RESTOW_PVE_TOKEN_SECRET_FILE" | tr -d '\r\n\t ')
fi
FLEECING="${RESTOW_PVE_FLEECING:-}"
# Where the PVE token came from: env (set on this node), restow (entered in
# Restow for this enrollment) or own (created here for this node).
PVE_TOKEN_SOURCE=''
[ -n "$PVE_TOKEN_ID" ] && [ -n "$PVE_TOKEN_SECRET" ] && PVE_TOKEN_SOURCE='env'

TMP=''
TTY_ECHO_OFF=''
TOKEN=''

usage() {
  cat <<'USAGE'
Usage: RESTOW_ENROLL_TOKEN=<token> pve.sh [--fleecing-storage=NAME] [--uninstall]

  (no option)               install, repair or upgrade restow-pve and enroll this node
  --fleecing-storage=NAME   thin storage of this node for fleecing images (default: picked)
  --uninstall               remove restow-pve, the storage plugin and the node's credentials

Environment:
  RESTOW_ENROLL_TOKEN            the one-time enrollment token (the command in Restow sets it)
  RESTOW_TOKEN_FILE              file with the one-time enrollment token
  RESTOW_PVE_TOKEN_ID            an existing PVE API token to use, e.g. restow@pve!restow
  RESTOW_PVE_TOKEN_SECRET_FILE   file with that token's secret
  RESTOW_PVE_LOCAL_DIR           install from local release files instead of downloading

Without a PVE API token it sets up user restow@pve, its roles and the pool
restow-restore and creates the API token restow@pve!<node name> itself.
USAGE
}

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

# post_json <url> <request file> <response file>: prints the HTTP status.
post_json() {
  if [ -n "$ALLOW_HTTP" ]; then
    curl -sS --connect-timeout 15 --max-time 60 -H 'Content-Type: application/json' \
      --data-binary "@$2" -o "$3" -w '%{http_code}' "$1"
  else
    curl -sS --proto '=https' --tlsv1.2 --connect-timeout 15 --max-time 60 -H 'Content-Type: application/json' \
      --data-binary "@$2" -o "$3" -w '%{http_code}' "$1"
  fi
}

require_root() {
  if [ -z "$ROOT" ] && [ "$(id -u)" -ne 0 ]; then
    die "this installer must run as root on the Proxmox VE node"
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
    trusted_entry "$_walk" || die "$_walk is not owned by root or is writable by group or others ($(mode_of "$_walk"), owner uid $(owner_of "$_walk")). restow-pve runs as root and is only installed where no other user can change it. Fix the folder (or remove it if you did not create it) and run this again."
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
    die "this Restow instance has no release signing key, so restow-pve cannot be verified. Nothing was installed. Update Restow to a release that ships signed agents."
  fi
  if [ ! -s "$2" ]; then
    if is_dev_version && [ -n "$ALLOW_UNSIGNED_DEV" ]; then
      warn "development build $AGENT_VERSION is not signed; the signature is NOT checked (RESTOW_ALLOW_UNSIGNED_DEV)"
      return 0
    fi
    die "release $AGENT_VERSION on this instance is not signed (no SHA256SUMS.sig). Nothing was installed."
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
    *) die "this system can check the release signature neither with ssh-keygen (OpenSSH 8.1 or newer) nor with OpenSSL 3. Install one of them, or check SHA256SUMS.sig on another machine (see docs/PVE.md) and run again with RESTOW_SHA256SUMS_SHA256=<SHA-256 of SHA256SUMS>. Nothing was installed." ;;
  esac
}

# ---- token --------------------------------------------------------------------

# read_token sets TOKEN from RESTOW_ENROLL_TOKEN, RESTOW_TOKEN_FILE,
# RESTOW_TOKEN or, as a fallback on a terminal, a hidden prompt.
read_token() {
  if [ -n "${RESTOW_ENROLL_TOKEN:-}" ]; then
    TOKEN="$RESTOW_ENROLL_TOKEN"
  elif [ -n "${RESTOW_TOKEN_FILE:-}" ]; then
    [ -f "$RESTOW_TOKEN_FILE" ] || die "RESTOW_TOKEN_FILE $RESTOW_TOKEN_FILE does not exist"
    case "$(mode_of "$RESTOW_TOKEN_FILE")" in
      *00) ;;
      *) warn "$RESTOW_TOKEN_FILE can be read by other users; keep token files at mode 0600 and delete them after use" ;;
    esac
    TOKEN=$(head -n 1 "$RESTOW_TOKEN_FILE")
  elif [ -n "${RESTOW_TOKEN:-}" ]; then
    TOKEN="$RESTOW_TOKEN"
  elif (: </dev/tty) 2>/dev/null; then
    printf 'Paste the enrollment token from Restow (input is hidden): ' >/dev/tty
    if stty -echo </dev/tty 2>/dev/null; then
      TTY_ECHO_OFF=yes
    fi
    IFS= read -r TOKEN </dev/tty || TOKEN=''
    if [ -n "$TTY_ECHO_OFF" ]; then
      stty echo </dev/tty 2>/dev/null || true
      TTY_ECHO_OFF=''
    fi
    printf '\n' >/dev/tty
  fi
  TOKEN=$(printf '%s' "$TOKEN" | tr -d '\r\n\t ')
  unset RESTOW_TOKEN RESTOW_ENROLL_TOKEN
  case "$TOKEN" in
    *[!A-Za-z0-9_-]*) die "the enrollment token contains characters a token from Restow never has; copy the command from Restow again" ;;
  esac
}

# preflight: asks Restow whether the enrollment token is still good (before
# anything on this node changes) and whether the admin entered an existing
# PVE API token for it. The token goes in a request body, never in argv.
preflight() {
  _req="$TMP/preflight.json"
  _out="$TMP/preflight.out"
  (umask 077 && printf '{"token":"%s"}' "$TOKEN" >"$_req")
  _code=$(post_json "$INSTANCE_URL/agent/pve/v1/enroll/preflight" "$_req" "$_out") || _code=000
  rm -f "$_req"
  case "$_code" in
    200) ;;
    401) die "Restow does not accept this enrollment token: it was used for another node, has expired (24 hours) or was revoked. In Restow, use \"Command for another node\" and run the new command." ;;
    429) die "Restow refuses enrollments from this address for a while (too many failed attempts). Try again later." ;;
    000) die "cannot reach $INSTANCE_URL from this node (HTTPS, port 443)" ;;
    *) die "Restow answered $_code when checking the enrollment token: $(head -c 300 "$_out" 2>/dev/null)" ;;
  esac
  grep -q '"expiresAt"' "$_out" || die "unexpected answer from $INSTANCE_URL when checking the enrollment token (is this the address of your Restow instance?)"
  _id=$(sed -n 's/.*"pveTokenId"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$_out")
  _secret=$(sed -n 's/.*"pveTokenSecret"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$_out")
  rm -f "$_out"
  if [ -n "$_id" ] && [ -n "$_secret" ]; then
    if [ "$PVE_TOKEN_SOURCE" = env ]; then
      say "    using the API token from RESTOW_PVE_TOKEN_ID ($PVE_TOKEN_ID), not the one entered in Restow ($_id)"
    else
      PVE_TOKEN_ID="$_id"
      PVE_TOKEN_SECRET="$_secret"
      PVE_TOKEN_SOURCE=restow
    fi
  fi
}

# ---- Proxmox VE --------------------------------------------------------------------

BACKUP_PRIVS="VM.Audit,VM.Backup,Datastore.Audit,Datastore.AllocateSpace,Sys.Audit"

# pveum_q: pveum without the "older storage API" notice an earlier version of
# the Restow plugin makes PVE 9.x print on every call; everything else on
# stderr stays.
pveum_q() {
  _err="$TMP/pveum.err"
  _rc=0
  pveum "$@" 2>"$_err" || _rc=$?
  grep -v 'is implementing an older storage API' "$_err" >&2 || true
  rm -f "$_err"
  return "$_rc"
}

# json_has <json> <key> <value>: the PVE CLI's JSON output holds "key":"value".
json_has() {
  printf '%s' "$1" | grep -Eq "\"$2\"[[:space:]]*:[[:space:]]*\"$3\""
}

# setup_pve: the PVE side of the onboarding (cluster-wide, idempotent): user
# restow@pve, the restore pool, the roles RestowBackup and RestowRestore (their
# privileges set again when they exist) and the ACLs (re-applied harmlessly).
setup_pve() {
  step "Setting up user restow@pve, roles RestowBackup and RestowRestore and the pool $RESTORE_POOL"
  if json_has "$(pveum_q user list --output-format json)" userid 'restow@pve'; then
    say "    user restow@pve: exists"
  else
    pveum_q user add restow@pve --comment "Restow backup" || die "cannot create the user restow@pve"
    say "    user restow@pve: created"
  fi
  if json_has "$(pveum_q pool list --output-format json)" poolid "$RESTORE_POOL"; then
    say "    pool $RESTORE_POOL: exists"
  else
    pveum_q pool add "$RESTORE_POOL" --comment "Guests restored by Restow" || die "cannot create the pool $RESTORE_POOL"
    say "    pool $RESTORE_POOL: created"
  fi
  _roles=$(pveum_q role list --output-format json) || _roles=''

  for _pair in "RestowBackup:$BACKUP_PRIVS" "RestowRestore:$RESTORE_PRIVS"; do
    _role=${_pair%%:*}
    _privs=${_pair#*:}
    if json_has "$_roles" roleid "$_role"; then
      pveum_q role modify "$_role" --privs "$_privs" || die "cannot update the role $_role"
      say "    role $_role: updated"
    else
      pveum_q role add "$_role" --privs "$_privs" || die "cannot create the role $_role"
      say "    role $_role: created"
    fi
  done
  pveum_q acl modify / --users restow@pve --roles RestowBackup || die "cannot grant RestowBackup on /"
  pveum_q acl modify "/pool/$RESTORE_POOL" --users restow@pve --roles RestowRestore || die "cannot grant RestowRestore on /pool/$RESTORE_POOL"
  pveum_q acl modify /storage --users restow@pve --roles RestowRestore || die "cannot grant RestowRestore on /storage"
  pveum_q acl modify /sdn --users restow@pve --roles RestowRestore 2>/dev/null ||
    warn "no /sdn path on this PVE version; restores need SDN.Use only where SDN is in use"
  say "    ACLs: /, /pool/$RESTORE_POOL, /storage, /sdn"
}

# node_token_name: the API token name of this node (PVE: a letter first, then
# letters, digits, '.', '-', '_').
node_token_name() {
  _n=$(hostname -s | tr -c 'A-Za-z0-9._\n-' '-')
  case "$_n" in
    [A-Za-z]?*) printf '%s' "$_n" ;;
    *) printf 'node-%s' "$_n" ;;
  esac
}

# create_node_token: the node's own API token restow@pve!<node>, privilege
# separation off (the user's roles apply). An existing token of that name is
# removed first: PVE shows a secret only once, so it cannot be reused.
create_node_token() {
  _name=$(node_token_name)
  PVE_TOKEN_ID="restow@pve!$_name"
  if json_has "$(pveum_q user token list restow@pve --output-format json)" tokenid "$_name"; then
    pveum_q user token remove restow@pve "$_name" >/dev/null || die "cannot replace the existing API token $PVE_TOKEN_ID"
    say "    API token $PVE_TOKEN_ID: existed, replaced (its old secret stops working)"
  fi
  _json=$(pveum_q user token add restow@pve "$_name" --privsep 0 --comment "Restow node helper on $(hostname -s)" --output-format json) ||
    die "cannot create the API token $PVE_TOKEN_ID"
  PVE_TOKEN_SECRET=$(printf '%s' "$_json" | sed -n 's/.*"value"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
  [ -n "$PVE_TOKEN_SECRET" ] || die "cannot read the secret of the new API token $PVE_TOKEN_ID"
  PVE_TOKEN_SOURCE=own
  say "    API token $PVE_TOKEN_ID: created (its secret stays on this node)"
}

# check_token_privileges: the token holds every privilege backups need on /
# (and, as a warning, what restores need in the restore pool). Checked with
# pveum as root, before anything is downloaded or installed.
check_token_privileges() {
  case "$PVE_TOKEN_ID" in
    *@*!*) ;;
    *) die "'$PVE_TOKEN_ID' is not a PVE API token id (user@realm!name)" ;;
  esac
  _user=${PVE_TOKEN_ID%%!*}
  _tname=${PVE_TOKEN_ID#*!}
  step "Checking the privileges of the API token $PVE_TOKEN_ID"
  _perms=$(pveum_q user token permissions "$_user" "$_tname" --path / --output-format json 2>&1) ||
    die "cannot read the privileges of the API token $PVE_TOKEN_ID: $_perms
Check the token id (user@realm!name) in Restow or in Datacenter > Permissions > API Tokens."
  _missing=''
  for _p in $(printf '%s' "$BACKUP_PRIVS" | tr ',' ' '); do
    printf '%s' "$_perms" | grep -q "\"$_p\"" || _missing="$_missing${_missing:+, }$_p"
  done
  if [ -n "$_missing" ]; then
    die "the API token $PVE_TOKEN_ID lacks $_missing on /. Give it the role RestowBackup on / with privilege separation off (see docs/PVE.md), or let this installer create its own token: run the command from Restow without an existing API token."
  fi
  say "    $BACKUP_PRIVS on /: OK"
  _pool=$(pveum_q user token permissions "$_user" "$_tname" --path "/pool/$RESTORE_POOL" --output-format json 2>/dev/null) || _pool=''
  if printf '%s' "$_pool" | grep -q '"VM.Allocate"'; then
    say "    VM.Allocate on /pool/$RESTORE_POOL: OK"
  else
    warn "the API token $PVE_TOKEN_ID lacks VM.Allocate on /pool/$RESTORE_POOL: backups work, restores from Restow will fail until it has the role RestowRestore there"
  fi
}

# check_token_secret: the local PVE API accepts the token's secret (an API
# token entered elsewhere may be mistyped). Only over a certificate signed by
# the cluster CA; with a custom pveproxy certificate restow-pve checks it later.
check_token_secret() {
  _ca=/etc/pve/pve-root-ca.pem
  [ -f "$_ca" ] || return 0
  _hdr="$TMP/pve-auth"
  (umask 077 && printf 'Authorization: PVEAPIToken=%s=%s\n' "$PVE_TOKEN_ID" "$PVE_TOKEN_SECRET" >"$_hdr")
  _code=$(curl -sS --cacert "$_ca" --connect-timeout 5 --max-time 20 -H "@$_hdr" -o /dev/null -w '%{http_code}' \
    https://127.0.0.1:8006/api2/json/version 2>/dev/null) || _code=000
  rm -f "$_hdr"
  case "$_code" in
    200) say "    the PVE API accepts the secret of $PVE_TOKEN_ID" ;;
    401) die "the PVE API does not accept the secret of the API token $PVE_TOKEN_ID (mistyped, expired or deleted)" ;;
    *) say "    the secret of $PVE_TOKEN_ID is checked when this node enrolls" ;;
  esac
}

# thin_storages: active storages of this node fit for fleecing images (thin:
# lvmthin, zfspool, rbd, btrfs; content images).
thin_storages() {
  pvesm status --content images 2>/dev/null | awk 'NR > 1 && $3 == "active" && ($2 == "lvmthin" || $2 == "zfspool" || $2 == "rbd" || $2 == "btrfs") { print $1 }'
}

# pick_fleecing: the only thin storage, else local-lvm, local-zfs, else the
# first thin storage. --fleecing-storage overrides.
pick_fleecing() {
  _thin=$(thin_storages)
  if [ -n "$FLEECING" ]; then
    printf '%s\n' "$_thin" | grep -qx "$FLEECING" ||
      warn "$FLEECING is not an active thin storage with content images on this node (found: $(printf '%s' "$_thin" | tr '\n' ' ')); fleecing may fail or reserve full disk sizes"
    say "Fleecing storage: $FLEECING (--fleecing-storage)"
    return 0
  fi
  [ -n "$_thin" ] || die "this node has no active thin storage with content images (lvmthin, zfspool, rbd or btrfs). PVE backs up VMs through a backup provider only with fleecing: add one, or name another storage with --fleecing-storage=NAME (after sh -s --)."
  if [ "$(printf '%s\n' "$_thin" | wc -l)" -eq 1 ]; then
    FLEECING=$_thin
  elif printf '%s\n' "$_thin" | grep -qx local-lvm; then
    FLEECING=local-lvm
  elif printf '%s\n' "$_thin" | grep -qx local-zfs; then
    FLEECING=local-zfs
  else
    FLEECING=$(printf '%s\n' "$_thin" | head -n 1)
  fi
  say "Fleecing storage: $FLEECING (thin storages on this node: $(printf '%s' "$_thin" | tr '\n' ' ' | sed 's/ $//'); change with --fleecing-storage=NAME)"
}

restart_pve_daemons() {
  step "Restarting the PVE daemons so they load the storage plugin"
  for unit in pvedaemon pveproxy pvestatd pvescheduler; do
    if systemctl is-active --quiet "$unit"; then
      systemctl reload-or-restart "$unit" || warn "could not restart $unit"
    fi
  done
}

write_unit() {
  _unit="$ROOT/etc/systemd/system/restow-pve.service"
  _staged=$(mktemp "$(dirname "$_unit")/.restow-pve.service.XXXXXX")
  cat >"$_staged" <<UNIT
[Unit]
Description=Restow node helper for Proxmox VE
Documentation=https://docs.restowbackup.com/
After=network-online.target pve-cluster.service
Wants=network-online.target

[Service]
Type=simple
ExecStart=$PVE_BIN run
Restart=always
RestartSec=10
NoNewPrivileges=yes
ProtectHome=read-only
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
UNIT
  chmod 0644 "$_staged"
  mv -f "$_staged" "$_unit"
  systemctl daemon-reload
}

uninstall() {
  if [ -x "$PVE_BIN" ]; then
    systemctl disable --now restow-pve.service 2>/dev/null || true
    "$PVE_BIN" uninstall --yes || true
  else
    rm -f "$ROOT/etc/systemd/system/restow-pve.service" "$PLUGIN_FILE" "$PROVIDER_FILE"
    rm -rf "$PREFIX" "$ROOT/etc/restow-pve" "$ROOT/var/lib/restow-pve"
  fi
  if [ -z "$SKIP_SERVICE" ]; then systemctl daemon-reload 2>/dev/null || true; fi
  [ -z "$SKIP_SERVICE" ] && restart_pve_daemons
  say "Removed restow-pve and the storage plugin. Backups stay in Restow."
  say "Remove the storage when no node uses it any more: pvesm remove <storage id>"
}

main() {
  action=install
  while [ $# -gt 0 ]; do
    case "$1" in
      --uninstall) action=uninstall ;;
      # Earlier releases asked for it; the PVE side is always set up now.
      --setup-pve-user) ;;
      --fleecing-storage=*) FLEECING="${1#--fleecing-storage=}" ;;
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
  [ "$(uname -s)" = "Linux" ] || die "this installer is for Proxmox VE nodes (Linux)"
  require_root
  if [ "$action" = uninstall ]; then
    uninstall
    exit 0
  fi

  case "$INSTANCE_URL" in
    *__RESTOW_*)
      INSTANCE_URL="${RESTOW_URL:-}"
      [ -n "$INSTANCE_URL" ] || die "this file has not been prepared by your Restow instance. Download it from https://<your instance>/install/pve.sh"
      ;;
  esac
  case "$AGENT_VERSION" in
    *__RESTOW_*) AGENT_VERSION="${RESTOW_VERSION:-}" ;;
  esac
  case "$RELEASE_KEY" in
    *__RESTOW_*) RELEASE_KEY="${RESTOW_RELEASE_KEY:-}" ;;
  esac
  [ -n "$AGENT_VERSION" ] || die "unknown release version"
  INSTANCE_URL="${INSTANCE_URL%/}"
  case "$INSTANCE_URL" in
    https://*) ;;
    http://*) [ -n "$ALLOW_HTTP" ] || die "the instance URL must start with https:// ($INSTANCE_URL)" ;;
    *) die "the instance URL must start with https:// ($INSTANCE_URL)" ;;
  esac
  case "$AGENT_VERSION" in
    *[!0-9A-Za-z.+-]*) die "invalid release version" ;;
  esac

  # ---- this must be a Proxmox VE 8.4+ node on x86_64 -------------------------------
  [ "$(uname -m)" = x86_64 ] || die "restow-pve supports x86_64 Proxmox VE nodes only"
  if [ -z "$ROOT" ]; then
    command -v pveversion >/dev/null 2>&1 || die "pveversion not found: this is not a Proxmox VE node"
    pve=$(pveversion | sed -n 's|^pve-manager/\([0-9][0-9]*\.[0-9][0-9]*\).*|\1|p')
    major=${pve%%.*}
    minor=${pve#*.}
    if [ -z "$pve" ] || [ "$major" -lt 8 ] || { [ "$major" -eq 8 ] && [ "$minor" -lt 4 ]; }; then
      die "Proxmox VE ${pve:-unknown} is too old: the backup provider interface needs 8.4 or newer"
    fi
    say "Proxmox VE $pve"
  fi
  command -v curl >/dev/null 2>&1 || die "curl is required"
  check_trusted_dir "$BIN_DIR"

  say "Restow node helper for Proxmox VE"
  say "Instance: $INSTANCE_URL"
  say "Version:  $AGENT_VERSION"
  say ""

  TMP=$(mktemp -d)
  enrolled=no
  [ -f "$STATE_FILE" ] && enrolled=yes
  if [ "$enrolled" = no ]; then
    read_token
    [ -n "$TOKEN" ] || die "this node is not enrolled and no enrollment token was given. In Restow (Servers & clients > VMs & containers > Connect Proxmox VE), copy the command for this node and run it here."
    step "Checking the enrollment token with $INSTANCE_URL"
    preflight
    say "    enrollment token: OK"
    if [ -z "$ROOT" ]; then
      command -v pveum >/dev/null 2>&1 || die "pveum not found: this is not a Proxmox VE node"
      case "$PVE_TOKEN_SOURCE" in
        env) say "Using the API token $PVE_TOKEN_ID (RESTOW_PVE_TOKEN_ID)" ;;
        restow) say "Using the API token $PVE_TOKEN_ID entered in Restow for this node" ;;
        *)
          setup_pve
          create_node_token
          ;;
      esac
      check_token_privileges
      [ "$PVE_TOKEN_SOURCE" = own ] || check_token_secret
      pick_fleecing
    fi
    if [ -z "$PVE_TOKEN_ID" ] || [ -z "$PVE_TOKEN_SECRET" ]; then
      die "no PVE API token (set RESTOW_PVE_TOKEN_ID and RESTOW_PVE_TOKEN_SECRET_FILE)"
    fi
    [ -n "$FLEECING" ] || die "a fleecing storage is required: PVE backs up VMs through the backup provider only with fleecing (--fleecing-storage=NAME)"
  fi

  # ---- download (or take a local copy) and verify ------------------------------------
  target=linux-amd64
  files="restow-pve restic RestowPlugin.pm RestowProvider.pm RestowPlugin.LICENSE.txt THIRD_PARTY_NOTICES.txt"
  if [ -n "$LOCAL_DIR" ]; then
    step "Using the release files in $LOCAL_DIR"
    cp "$LOCAL_DIR/SHA256SUMS" "$TMP/SHA256SUMS" || die "$LOCAL_DIR/SHA256SUMS is missing"
    cp "$LOCAL_DIR/SHA256SUMS.sig" "$TMP/SHA256SUMS.sig" 2>/dev/null || : >"$TMP/SHA256SUMS.sig"
    for name in $files; do
      cp "$LOCAL_DIR/$target/$name" "$TMP/$name" || die "$LOCAL_DIR/$target/$name is missing"
    done
  else
    base="$INSTANCE_URL/install/agent/$AGENT_VERSION"
    step "Downloading restow-pve, restic and the storage plugin from your Restow instance"
    fetch "$base/SHA256SUMS" "$TMP/SHA256SUMS" || die "cannot download $base/SHA256SUMS"
    fetch "$base/SHA256SUMS.sig" "$TMP/SHA256SUMS.sig" 2>/dev/null || : >"$TMP/SHA256SUMS.sig"
    for name in $files; do
      fetch "$base/$target/$name" "$TMP/$name" || die "cannot download $base/$target/$name (does this release ship restow-pve?)"
    done
  fi
  step "Verifying the release signature and the SHA-256 checksums"
  verify_release "$TMP/SHA256SUMS" "$TMP/SHA256SUMS.sig"
  for name in $files; do
    expected=$(awk -v n="$target/$name" '$2 == n || $2 == "*" n { print $1 }' "$TMP/SHA256SUMS")
    [ -n "$expected" ] || die "SHA256SUMS has no entry for $target/$name"
    actual=$(sha256_of "$TMP/$name")
    [ "$expected" = "$actual" ] || die "checksum mismatch for $name (expected $expected, got $actual). Nothing was installed."
    say "    $name: OK"
  done
  chmod 0755 "$TMP/restow-pve" "$TMP/restic"
  reported=$("$TMP/restow-pve" version --short 2>/dev/null || true)
  [ "$reported" = "$AGENT_VERSION" ] || die "the downloaded restow-pve reports version '$reported', expected '$AGENT_VERSION'. Nothing was installed."

  # ---- install --------------------------------------------------------------------------
  if [ -x "$PVE_BIN" ] && [ -z "$SKIP_SERVICE" ]; then
    systemctl stop restow-pve.service 2>/dev/null || true
  fi
  step "Installing"
  make_root_dir "$PREFIX"
  make_root_dir "$BIN_DIR"
  install_file "$TMP/restic" "$BIN_DIR/restic"
  install_file "$TMP/restow-pve" "$PVE_BIN"
  install_file "$TMP/THIRD_PARTY_NOTICES.txt" "$PREFIX/THIRD_PARTY_NOTICES.txt" 0644
  install_file "$TMP/RestowPlugin.LICENSE.txt" "$PREFIX/RestowPlugin.LICENSE.txt" 0644
  mkdir -p "$(dirname "$PLUGIN_FILE")" "$(dirname "$PROVIDER_FILE")"
  install_file "$TMP/RestowProvider.pm" "$PROVIDER_FILE" 0644
  install_file "$TMP/RestowPlugin.pm" "$PLUGIN_FILE" 0644
  say "    $PVE_BIN, $BIN_DIR/restic"
  say "    $PLUGIN_FILE, $PROVIDER_FILE (AGPL-3.0-or-later, $PREFIX/RestowPlugin.LICENSE.txt)"
  if command -v perl >/dev/null 2>&1 && [ -z "$ROOT" ]; then
    perl -I/usr/share/perl5 -e 'require PVE::Storage::Custom::RestowPlugin; 1' ||
      die "the storage plugin does not load in this PVE's Perl; see the error above. Remove it with: sh pve.sh --uninstall"
  fi

  # ---- enroll ------------------------------------------------------------------------------
  if [ "$enrolled" = yes ]; then
    step "This node is already enrolled; keeping the existing enrollment"
  else
    step "Enrolling this node"
    _secret_file="$TMP/pve-token"
    (umask 077 && printf '%s' "$PVE_TOKEN_SECRET" >"$_secret_file")
    enroll_flags=''
    [ -n "$ALLOW_HTTP" ] && enroll_flags='--allow-insecure-http'
    # shellcheck disable=SC2086
    RESTOW_PVE_ROOT="$ROOT" RESTOW_TOKEN="$TOKEN" RESTOW_URL="$INSTANCE_URL" RESTOW_PVE_TOKEN_SECRET_FILE="$_secret_file" \
      "$PVE_BIN" enroll --pve-token-id "$PVE_TOKEN_ID" --fleecing-storage "$FLEECING" $enroll_flags || {
      rm -f "$_secret_file"
      die "enrollment failed (see above). Run this command again; if Restow says the token was used or expired, use \"Command for another node\" in Restow."
    }
    rm -f "$_secret_file"
  fi
  TOKEN=''
  PVE_TOKEN_SECRET=''

  # ---- the storage, once per cluster --------------------------------------------------------
  storage_id=$(RESTOW_PVE_ROOT="$ROOT" "$PVE_BIN" status --json 2>/dev/null | sed -n 's/.*"storageId":"\([^"]*\)".*/\1/p')
  storage_id="${storage_id:-restow}"
  if [ -z "$ROOT" ]; then
    if grep -q "^restow: $storage_id\$" /etc/pve/storage.cfg 2>/dev/null; then
      _nodes=$(pvesh get "/storage/$storage_id" --output-format json 2>/dev/null | sed -n 's/.*"nodes":"\([^"]*\)".*/\1/p')
      if [ -n "$_nodes" ]; then
        case ",$_nodes," in
          *",$(hostname -s),"*) ;;
          *) pvesm set "$storage_id" --nodes "$_nodes,$(hostname -s)" && say "    storage $storage_id now also on $(hostname -s)" ;;
        esac
      fi
    else
      step "Adding the storage $storage_id (type restow, content backup) to the cluster"
      pvesm add restow "$storage_id" --content backup --nodes "$(hostname -s)" || warn "could not add the storage; add it by hand: pvesm add restow $storage_id --content backup --nodes $(hostname -s)"
    fi
  fi

  # ---- start ------------------------------------------------------------------------------------
  if [ -z "$SKIP_SERVICE" ]; then
    step "Installing and starting restow-pve.service"
    write_unit
    systemctl enable --now restow-pve.service
    systemctl restart restow-pve.service
    restart_pve_daemons
  fi

  say ""
  say "Done. restow-pve $AGENT_VERSION is installed on this node."
  say ""
  "$PVE_BIN" diagnose || true
  say ""
  say "Next: the guests of this node appear in Restow (Servers & clients > VMs & containers) within a minute."
  say "      Put them into a backup job there; nothing is backed up before."
  say "Logs:   journalctl -u restow-pve"
  say "Remove: sh pve.sh --uninstall   (or: $PVE_BIN uninstall --yes)"
}

# Tests load the functions without running the installer (agent/scripts/test-pve-install.sh).
if [ "${RESTOW_PVE_INSTALLER_FUNCTIONS_ONLY:-}" != 1 ]; then
  main "$@"
fi
