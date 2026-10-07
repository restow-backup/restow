#!/bin/sh
# Restow node helper installer for Proxmox VE (8.4 or newer, x86_64).
#
# Run it as root on every node that should back up its guests, as shown in
# Restow (Inventory > Proxmox VE > Connect):
#
#   curl -fsSL 'https://<your instance>/install/pve.sh' | sh
#
# It asks for the one-time enrollment token (hidden input), the PVE API token
# (`restow@pve!<name>` and its secret, hidden) and the thin storage of this node
# for fleecing images. With --setup-pve-user (first node of a cluster) it
# creates the user restow@pve, the roles, the restore pool and an API token
# itself. Unattended: RESTOW_TOKEN_FILE, RESTOW_PVE_TOKEN_ID,
# RESTOW_PVE_TOKEN_SECRET_FILE and --fleecing-storage=<storage>.
#
# What it does: downloads restow-pve, restic and the storage plugin shim from
# your Restow instance (or takes them from RESTOW_PVE_LOCAL_DIR), checks the
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
#   --setup-pve-user           create user, roles, pool and API token (root@pam)
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

TMP=''
TTY_ECHO_OFF=''
TOKEN=''

usage() {
  cat <<'USAGE'
Usage: pve.sh [--setup-pve-user] [--fleecing-storage=NAME] [--uninstall]

  (no option)               install, repair or upgrade restow-pve and enroll this node
  --setup-pve-user          create user restow@pve, roles, pool restow-restore and an API token
  --fleecing-storage=NAME   thin storage of this node for fleecing images
  --uninstall               remove restow-pve, the storage plugin and the node's credentials

Environment:
  RESTOW_TOKEN_FILE              file with the one-time enrollment token
  RESTOW_PVE_TOKEN_ID            PVE API token id, e.g. restow@pve!restow
  RESTOW_PVE_TOKEN_SECRET_FILE   file with the PVE API token secret
  RESTOW_PVE_LOCAL_DIR           install from local release files instead of downloading
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
    TOKEN=$(printf '%s' "$TOKEN" | tr -d '\r\n\t ')
  fi
  unset RESTOW_TOKEN
}


# ---- Proxmox VE --------------------------------------------------------------------

# ask <prompt> <variable> [hidden]: read a value from the terminal unless set.
ask() {
  eval "_cur=\${$2:-}"
  if [ -n "$_cur" ]; then
    return 0
  fi
  if ! (: </dev/tty) 2>/dev/null; then
    return 0
  fi
  printf '%s' "$1" >/dev/tty
  if [ "${3:-}" = hidden ] && stty -echo </dev/tty 2>/dev/null; then
    TTY_ECHO_OFF=yes
  fi
  IFS= read -r _val </dev/tty || _val=''
  if [ -n "$TTY_ECHO_OFF" ]; then
    stty echo </dev/tty 2>/dev/null || true
    TTY_ECHO_OFF=''
    printf '\n' >/dev/tty
  fi
  _val=$(printf '%s' "$_val" | tr -d '\r\n\t ')
  eval "$2=\$_val"
}

# setup_pve_user: the PVE side of the onboarding, once per cluster (idempotent):
# user restow@pve, restore pool, two roles, the ACLs and an API token whose
# secret is captured for this node.
setup_pve_user() {
  step "Setting up user restow@pve, roles, the pool $RESTORE_POOL and an API token"
  pveum user add restow@pve --comment "Restow backup" 2>/dev/null || say "    user restow@pve exists"
  pveum pool add "$RESTORE_POOL" --comment "Guests restored by Restow" 2>/dev/null || say "    pool $RESTORE_POOL exists"
  pveum role add RestowBackup --privs "VM.Audit,VM.Backup,Datastore.Audit,Datastore.AllocateSpace,Sys.Audit" 2>/dev/null ||
    pveum role modify RestowBackup --privs "VM.Audit,VM.Backup,Datastore.Audit,Datastore.AllocateSpace,Sys.Audit"
  pveum role add RestowRestore --privs "$RESTORE_PRIVS" 2>/dev/null || pveum role modify RestowRestore --privs "$RESTORE_PRIVS"
  pveum acl modify / --users restow@pve --roles RestowBackup
  pveum acl modify "/pool/$RESTORE_POOL" --users restow@pve --roles RestowRestore
  pveum acl modify /storage --users restow@pve --roles RestowRestore
  pveum acl modify /sdn --users restow@pve --roles RestowRestore 2>/dev/null || warn "no /sdn path on this PVE version; bridges need SDN.Use only on 8.x with SDN"
  if [ -z "$PVE_TOKEN_SECRET" ]; then
    _name="restow-$(hostname -s)"
    pveum user token remove restow@pve "$_name" >/dev/null 2>&1 || true
    _json=$(pveum user token add restow@pve "$_name" --privsep 0 --output-format json) || die "cannot create the API token"
    PVE_TOKEN_ID="restow@pve!$_name"
    PVE_TOKEN_SECRET=$(printf '%s' "$_json" | sed -n 's/.*"value"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
    [ -n "$PVE_TOKEN_SECRET" ] || die "cannot read the secret of the new API token"
    say "    API token $PVE_TOKEN_ID created (its secret stays on this node)"
  fi
}

# thin_storages: active local storages fit for fleecing images (thin: lvmthin, zfspool, rbd, btrfs).
thin_storages() {
  pvesm status 2>/dev/null | awk 'NR > 1 && $3 == "active" && ($2 == "lvmthin" || $2 == "zfspool" || $2 == "rbd" || $2 == "btrfs") { print $1 }'
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
  [ -z "$SKIP_SERVICE" ] && systemctl daemon-reload 2>/dev/null || true
  [ -z "$SKIP_SERVICE" ] && restart_pve_daemons
  say "Removed restow-pve and the storage plugin. Backups stay in Restow."
  say "Remove the storage when no node uses it any more: pvesm remove <storage id>"
}

main() {
  action=install
  SETUP_PVE_USER=''
  while [ $# -gt 0 ]; do
    case "$1" in
      --uninstall) action=uninstall ;;
      --setup-pve-user) SETUP_PVE_USER=yes ;;
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

  enrolled=no
  [ -f "$STATE_FILE" ] && enrolled=yes
  if [ "$enrolled" = no ]; then
    read_token
    [ -n "$TOKEN" ] || die "this node is not enrolled and no enrollment token was given. Create one in Restow (Inventory > Proxmox VE > Connect) and run this again."
    [ -n "$SETUP_PVE_USER" ] && [ -z "$ROOT" ] && setup_pve_user
    ask "PVE API token id (e.g. restow@pve!restow): " PVE_TOKEN_ID
    ask "PVE API token secret (input is hidden): " PVE_TOKEN_SECRET hidden
    [ -n "$PVE_TOKEN_ID" ] && [ -n "$PVE_TOKEN_SECRET" ] || die "the PVE API token is needed (RESTOW_PVE_TOKEN_ID and RESTOW_PVE_TOKEN_SECRET_FILE, or --setup-pve-user)"
    if [ -z "$FLEECING" ] && [ -z "$ROOT" ]; then
      suggestions=$(thin_storages | tr '\n' ' ')
      say "Thin storages on this node for fleecing images: ${suggestions:-none found}"
      ask "Fleecing storage for this node: " FLEECING
    fi
    [ -n "$FLEECING" ] || die "a fleecing storage is required: PVE backs up VMs through the backup provider only with fleecing"
  fi

  say "Restow node helper for Proxmox VE"
  say "Instance: $INSTANCE_URL"
  say "Version:  $AGENT_VERSION"
  say ""

  # ---- download (or take a local copy) and verify ------------------------------------
  TMP=$(mktemp -d)
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
      die "enrollment failed (see above). Create a new token in Restow and run this again."
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
  say "Next: the guests of this node appear in Restow (Inventory > Proxmox VE) within a minute."
  say "      Put them into a backup job there; nothing is backed up before."
  say "Logs:   journalctl -u restow-pve"
  say "Remove: sh pve.sh --uninstall   (or: $PVE_BIN uninstall --yes)"
}

main "$@"
