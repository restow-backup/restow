#!/bin/sh
# Tests of the Proxmox VE node installer's own logic (install/pve.sh) without
# a PVE node: the installer's functions are loaded (RESTOW_PVE_INSTALLER_FUNCTIONS_ONLY)
# and run against stand-ins for pveum, pvesm, hostname and curl that keep
# their state in a temporary folder. Covered: the PVE side is set up
# idempotently (existing user, pool, roles and ACLs are no error), the node's
# own API token is created and replaced, the token's privileges are checked
# and a missing one names the token, the fleecing storage is picked, the
# enrollment token is checked with Restow before anything else (and never on
# a command line), an existing PVE token entered in Restow is taken over, and
# PVE 9's "older storage API" notice is filtered.
#
# Needs only a POSIX shell (no Go, no Docker, no root).
#
#   scripts/test-pve-install.sh
set -eu

AGENT_DIR=$(cd "$(dirname "$0")/.." && pwd)
WORK=$(mktemp -d)
FAKE_BIN="$WORK/bin"
STATE="$WORK/state"
mkdir -p "$FAKE_BIN" "$STATE"
trap 'rm -rf "$WORK"' EXIT

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}
ok() { printf 'ok: %s\n' "$*"; }

# ---- stand-ins ------------------------------------------------------------------------

cat >"$FAKE_BIN/pveum" <<'FAKE'
#!/bin/sh
# A pveum that keeps users, pools, roles, ACLs and tokens in $FAKE_PVE_STATE.
S="$FAKE_PVE_STATE"
printf '%s\n' "$*" >>"$S/calls"
touch "$S/users" "$S/pools" "$S/roles" "$S/acls" "$S/tokens"
if [ -n "${FAKE_OLD_API_WARNING:-}" ]; then
  echo 'Plugin "PVE::Storage::Custom::RestowPlugin" is implementing an older storage API, an upgrade is recommended' >&2
fi
list() {
  # list <file> <key>: the first field of every line as a JSON array of {key: value}.
  printf '['
  _sep=''
  while IFS=' ' read -r _v _rest; do
    [ -n "$_v" ] || continue
    printf '%s{"%s":"%s"}' "$_sep" "$2" "$_v"
    _sep=,
  done <"$1"
  printf ']\n'
}
case "$1 $2" in
  "user list") list "$S/users" userid ;;
  "user add")
    if grep -qx "$3" "$S/users"; then echo "create user failed: user '$3' already exists" >&2; exit 255; fi
    echo "$3" >>"$S/users" ;;
  "pool list") list "$S/pools" poolid ;;
  "pool add")
    if grep -qx "$3" "$S/pools"; then echo "pool '$3' already exists" >&2; exit 255; fi
    echo "$3" >>"$S/pools" ;;
  "role list") list "$S/roles" roleid ;;
  "role add")
    if grep -q "^$3 " "$S/roles"; then echo "role '$3' already exists" >&2; exit 255; fi
    echo "$3 $5" >>"$S/roles" ;;
  "role modify")
    grep -q "^$3 " "$S/roles" || { echo "role '$3' does not exist" >&2; exit 255; }
    grep -v "^$3 " "$S/roles" >"$S/roles.new" || true
    echo "$3 $5" >>"$S/roles.new"
    mv "$S/roles.new" "$S/roles" ;;
  "acl modify")
    if [ "$3" = /sdn ] && [ -n "${FAKE_NO_SDN:-}" ]; then echo "invalid ACL path '/sdn'" >&2; exit 255; fi
    grep -qx "$3 $5 $7" "$S/acls" || echo "$3 $5 $7" >>"$S/acls" ;;
  "user token")
    case "$3" in
      list)
        grep "^$4!" "$S/tokens" | sed 's/^[^!]*!//' >"$S/tokens.of" || true
        list "$S/tokens.of" tokenid ;;
      add)
        if grep -qx "$4!$5" "$S/tokens"; then echo "Token already exists." >&2; exit 255; fi
        echo "$4!$5" >>"$S/tokens"
        printf '{"full-tokenid":"%s!%s","info":{"privsep":"0"},"value":"0b1e5c2a-0000-4000-8000-%012d"}\n' "$4" "$5" "$(wc -l <"$S/calls")" ;;
      remove)
        grep -vx "$4!$5" "$S/tokens" >"$S/tokens.new" || true
        mv "$S/tokens.new" "$S/tokens" ;;
      permissions)
        if ! grep -qx "$4!$5" "$S/tokens" && [ "$4!$5" != "${FAKE_FOREIGN_TOKEN:-}" ]; then
          echo "no such token '$5' for user '$4'" >&2
          exit 255
        fi
        case "$7" in
          /) cat "$S/perms-root" ;;
          *) cat "$S/perms-pool" ;;
        esac ;;
    esac ;;
  *) echo "fake pveum: unexpected $*" >&2; exit 2 ;;
esac
FAKE

cat >"$FAKE_BIN/pvesm" <<'FAKE'
#!/bin/sh
# pvesm status [--content images]: the storages in $FAKE_PVE_STATE/storages.
printf 'Name             Type     Status           Total            Used       Available        %%\n'
cat "$FAKE_PVE_STATE/storages"
FAKE

cat >"$FAKE_BIN/hostname" <<'FAKE'
#!/bin/sh
printf '%s\n' "${FAKE_HOSTNAME:-pve1}"
FAKE

cat >"$FAKE_BIN/curl" <<'FAKE'
#!/bin/sh
# Answers the enrollment preflight: $FAKE_PREFLIGHT_CODE and $FAKE_PREFLIGHT_BODY.
printf '%s\n' "$*" >>"$FAKE_PVE_STATE/curl-argv"
out=''
data=''
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift ;;
    --data-binary) data="$2"; shift ;;
  esac
  shift
done
[ -n "$data" ] && cat "${data#@}" >>"$FAKE_PVE_STATE/curl-bodies"
[ -n "$out" ] && printf '%s' "${FAKE_PREFLIGHT_BODY:-}" >"$out"
printf '%s' "${FAKE_PREFLIGHT_CODE:-200}"
FAKE
chmod 0755 "$FAKE_BIN"/*

PATH="$FAKE_BIN:$PATH"
FAKE_PVE_STATE="$STATE"
export PATH FAKE_PVE_STATE

FULL_ROOT='{"/":{"Datastore.AllocateSpace":1,"Datastore.Audit":1,"Sys.Audit":1,"VM.Audit":1,"VM.Backup":1}}'
printf '%s\n' "$FULL_ROOT" >"$STATE/perms-root"
printf '%s\n' '{"/pool/restow-restore":{"VM.Allocate":1,"VM.Config.Disk":1}}' >"$STATE/perms-pool"

# The installer's functions, not its main.
RESTOW_PVE_INSTALLER_FUNCTIONS_ONLY=1
# shellcheck source=../install/pve.sh
. "$AGENT_DIR/install/pve.sh"
set +e
TMP="$WORK/tmp"
mkdir -p "$TMP"
INSTANCE_URL=https://restow.test.example

# run <name> <function> [args]: runs the function in a subshell, its output in
# $WORK/<name>.out and, when it succeeded, the variables it sets in
# $WORK/<name>.vars (PVE token id|secret|source|fleecing|enrollment token).
run() {
  RUN_VARS="$WORK/$1.vars"
  RUN_OUT="$WORK/$1.out"
  shift
  (
    set -eu
    "$@"
    printf '%s|%s|%s|%s|%s\n' "$PVE_TOKEN_ID" "$PVE_TOKEN_SECRET" "$PVE_TOKEN_SOURCE" "$FLEECING" "$TOKEN" >"$RUN_VARS"
  ) >"$RUN_OUT" 2>&1
}
# field <name> <n>: field n of what run <name> recorded.
field() { cut -d '|' -f "$2" "$WORK/$1.vars"; }

# ---- the PVE side, twice ----------------------------------------------------------------

run setup1 setup_pve || {
  cat "$WORK/setup1.out"
  fail "first setup_pve failed"
}
grep -qx 'restow@pve' "$STATE/users" || fail "user restow@pve not created"
grep -qx 'restow-restore' "$STATE/pools" || fail "pool not created"
grep -qx "RestowBackup VM.Audit,VM.Backup,Datastore.Audit,Datastore.AllocateSpace,Sys.Audit" "$STATE/roles" || fail "RestowBackup privileges"
grep -qx "RestowRestore $RESTORE_PRIVS" "$STATE/roles" || fail "RestowRestore privileges"
for acl in "/ restow@pve RestowBackup" "/pool/restow-restore restow@pve RestowRestore" \
  "/storage restow@pve RestowRestore" "/sdn restow@pve RestowRestore"; do
  grep -qx "$acl" "$STATE/acls" || fail "ACL $acl missing"
done
ok "the PVE side is set up: user, pool, both roles with their privileges, four ACLs"

# A role changed by hand gets its privileges back; existing objects are no error.
grep -v '^RestowBackup ' "$STATE/roles" >"$STATE/roles.x"
echo "RestowBackup VM.Audit" >>"$STATE/roles.x"
mv "$STATE/roles.x" "$STATE/roles"
FAKE_NO_SDN=1
export FAKE_NO_SDN
run setup2 setup_pve || {
  cat "$WORK/setup2.out"
  fail "second setup_pve failed"
}
unset FAKE_NO_SDN
grep -q 'user restow@pve: exists' "$WORK/setup2.out" || fail "existing user not reported"
grep -q 'role RestowBackup: updated' "$WORK/setup2.out" || fail "existing role not updated"
grep -qx "RestowBackup VM.Audit,VM.Backup,Datastore.Audit,Datastore.AllocateSpace,Sys.Audit" "$STATE/roles" || fail "role privileges not restored"
grep -q 'no /sdn path' "$WORK/setup2.out" || fail "missing /sdn is not a warning"
[ "$(grep -c '^user add' "$STATE/calls")" -eq 1 ] || fail "user add ran again"
ok "running it again: existing user and pool are fine, roles updated, a missing /sdn only warns"

# ---- the node's own API token -------------------------------------------------------------

FAKE_HOSTNAME=pve1
export FAKE_HOSTNAME
run token1 create_node_token || fail "create_node_token: $(cat "$WORK/token1.out")"
[ "$(field token1 1)" = 'restow@pve!pve1' ] || fail "token id $(field token1 1)"
secret=$(field token1 2)
[ -n "$secret" ] || fail "no token secret"
[ "$(field token1 3)" = own ] || fail "token source $(field token1 3)"
grep -q 'token add restow@pve pve1 --privsep 0' "$STATE/calls" || fail "token not created with privilege separation off"
run token2 create_node_token || fail "create_node_token again: $(cat "$WORK/token2.out")"
grep -q 'existed, replaced' "$WORK/token2.out" || fail "existing token not replaced"
[ "$(field token2 2)" != "$secret" ] || fail "the replaced token kept its secret"
[ "$(grep -c '^restow@pve!pve1$' "$STATE/tokens")" -eq 1 ] || fail "token listed twice"
ok "the node's own token restow@pve!pve1 is created (privsep 0) and replaced on a second run"

[ "$(FAKE_HOSTNAME=1node && export FAKE_HOSTNAME && node_token_name)" = node-1node ] || fail "token name for a host name starting with a digit"
[ "$(FAKE_HOSTNAME='pve-a' && export FAKE_HOSTNAME && node_token_name)" = 'pve-a' ] || fail "token name pve-a"
ok "token names PVE accepts for every host name"

# ---- privileges ------------------------------------------------------------------------------

PVE_TOKEN_ID='restow@pve!pve1'
run privs-ok check_token_privileges || fail "full privileges refused: $(cat "$WORK/privs-ok.out")"
printf '%s\n' '{"/":{"VM.Audit":1,"Sys.Audit":1}}' >"$STATE/perms-root"
if run privs-missing check_token_privileges; then fail "missing privileges accepted"; fi
grep -q 'the API token restow@pve!pve1 lacks VM.Backup, Datastore.Audit, Datastore.AllocateSpace on /' "$WORK/privs-missing.out" ||
  fail "missing privileges message: $(cat "$WORK/privs-missing.out")"
printf '%s\n' "$FULL_ROOT" >"$STATE/perms-root"
PVE_TOKEN_ID='root@pam!restow'
if run privs-unknown check_token_privileges; then fail "unknown token accepted"; fi
grep -q 'cannot read the privileges of the API token root@pam!restow' "$WORK/privs-unknown.out" || fail "unknown token message: $(cat "$WORK/privs-unknown.out")"
PVE_TOKEN_ID='restow@pve!pve1'
printf '%s\n' '{}' >"$STATE/perms-pool"
run privs-pool check_token_privileges || fail "a token without restore privileges must still back up"
grep -q 'lacks VM.Allocate on /pool/restow-restore' "$WORK/privs-pool.out" || fail "missing restore privileges not warned"
ok "privileges checked before anything is installed; errors name the token"

# ---- fleecing storage ------------------------------------------------------------------------

pick() {
  printf '%s' "$1" >"$STATE/storages"
  FLEECING="${2:-}"
  run fleecing pick_fleecing || return 1
  field fleecing 4
}
line() { printf '%-16s %-8s %-8s 100 10 90 10.00%%\n' "$1" "$2" "${3:-active}"; }
[ "$(pick "$(line local dir)
$(line tank zfspool)
")" = tank ] || fail "the only thin storage"
[ "$(pick "$(line ceph rbd)
$(line local-lvm lvmthin)
")" = local-lvm ] || fail "local-lvm preferred"
[ "$(pick "$(line ceph rbd)
$(line local-zfs zfspool)
")" = local-zfs ] || fail "local-zfs preferred"
[ "$(pick "$(line ssd lvmthin)
$(line ceph rbd)
$(line off lvmthin inactive)
")" = ssd ] || fail "first thin storage"
[ "$(pick "$(line ssd lvmthin)
" other)" = other ] || fail "--fleecing-storage overrides"
grep -q 'not an active thin storage' "$WORK/fleecing.out" || fail "an unknown --fleecing-storage is not warned about"
if pick "$(line local dir)
" >/dev/null; then fail "no thin storage accepted"; fi
grep -q 'no active thin storage' "$WORK/fleecing.out" || fail "no thin storage message"
ok "fleecing storage: the only one, local-lvm, local-zfs, the first; override; none fails"

# ---- enrollment token and preflight ------------------------------------------------------------

TOKEN_VALUE='rset_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcde'
RESTOW_ENROLL_TOKEN="$TOKEN_VALUE"
export RESTOW_ENROLL_TOKEN
run read1 read_token || fail "read_token from RESTOW_ENROLL_TOKEN"
[ "$(field read1 5)" = "$TOKEN_VALUE" ] || fail "token from RESTOW_ENROLL_TOKEN"
RESTOW_ENROLL_TOKEN='rset_x; rm -rf /'
if run read2 read_token; then fail "a token with shell characters accepted"; fi
unset RESTOW_ENROLL_TOKEN
ok "the enrollment token comes from RESTOW_ENROLL_TOKEN"

TOKEN="$TOKEN_VALUE"
PVE_TOKEN_ID=''
PVE_TOKEN_SECRET=''
PVE_TOKEN_SOURCE=''
FAKE_PREFLIGHT_CODE=200
# shellcheck disable=SC2089,SC2090 # JSON for the stand-in curl, not words for the shell
FAKE_PREFLIGHT_BODY='{"expiresAt":"2026-10-10T10:00:00.000Z","pveTokenId":null,"pveTokenSecret":null}'
# shellcheck disable=SC2090
export FAKE_PREFLIGHT_CODE FAKE_PREFLIGHT_BODY
run pre1 preflight || fail "preflight: $(cat "$WORK/pre1.out")"
[ "$(field pre1 1)|$(field pre1 3)" = '|' ] || fail "no PVE token expected"
grep -q "/agent/pve/v1/enroll/preflight" "$STATE/curl-argv" || fail "preflight URL"
if grep -q "$TOKEN_VALUE" "$STATE/curl-argv"; then fail "the enrollment token appeared on curl's command line"; fi
grep -q "\"token\":\"$TOKEN_VALUE\"" "$STATE/curl-bodies" || fail "the enrollment token is not in the request body"
[ -z "$(find "$TMP" -name 'preflight*')" ] || fail "the request file was left behind"

FAKE_PREFLIGHT_BODY='{"expiresAt":"2026-10-10T10:00:00.000Z","pveTokenId":"backup@pve!restow","pveTokenSecret":"9f1c2d3e-aaaa-4bbb-8ccc-0123456789ab"}'
run pre2 preflight || fail "preflight with a PVE token"
[ "$(field pre2 1)|$(field pre2 2)|$(field pre2 3)" = 'backup@pve!restow|9f1c2d3e-aaaa-4bbb-8ccc-0123456789ab|restow' ] ||
  fail "PVE token from Restow: $(cat "$WORK/pre2.vars")"

PVE_TOKEN_ID='local@pve!x'
PVE_TOKEN_SECRET='local-secret-0000000'
PVE_TOKEN_SOURCE='env'
run pre3 preflight || fail "preflight with a local token"
[ "$(field pre3 1)|$(field pre3 3)" = 'local@pve!x|env' ] || fail "the token set on the node wins"

FAKE_PREFLIGHT_BODY='<html>proxy login</html>'
if run pre-html preflight; then fail "an answer that is not from Restow accepted"; fi
grep -q 'unexpected answer' "$WORK/pre-html.out" || fail "message for an answer that is not from Restow"
for code in 401 429 000 500; do
  FAKE_PREFLIGHT_CODE=$code
  if run pre-$code preflight; then fail "preflight $code accepted"; fi
done
grep -q 'used for another node, has expired' "$WORK/pre-401.out" || fail "401 message"
grep -q 'Command for another node' "$WORK/pre-401.out" || fail "401 points to the next command"
grep -q 'cannot reach' "$WORK/pre-000.out" || fail "unreachable message"
FAKE_PREFLIGHT_CODE=200
ok "the enrollment token is checked first, in the body; a PVE token entered in Restow is taken over"

# ---- PVE 9's notice about the older storage API -----------------------------------------------

FAKE_OLD_API_WARNING=1
export FAKE_OLD_API_WARNING
pveum_q pool list --output-format json >"$WORK/q.out" 2>"$WORK/q.err" || fail "pveum_q"
if grep -q 'older storage API' "$WORK/q.err"; then fail "the older storage API notice was not filtered"; fi
grep -q 'restow-restore' "$WORK/q.out" || fail "pveum_q output"
if pveum_q bogus thing 2>"$WORK/q2.err"; then fail "pveum_q hid a failure"; fi
grep -q 'unexpected bogus' "$WORK/q2.err" || fail "pveum_q hid other errors"
unset FAKE_OLD_API_WARNING
ok "pveum's older-storage-API notice is filtered, other errors stay"

echo "test-pve-install: OK"
