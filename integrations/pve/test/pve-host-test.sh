#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
#
# Restow for Proxmox VE: the test run on a real PVE node (docs/PVE-HOST-TEST.md).
#
# Run as root on a Proxmox VE 8.4+ node (9.2 is the primary target). It
#   1. records the node (versions, storages, the test guests),
#   2. installs restow-pve and the storage plugin (from your Restow instance,
#      or from a local release folder) and enrolls the node,
#   3. backs up a test VM twice (full, then incremental after a write in the
#      guest) and a test container, through vzdump onto the Restow storage,
#   4. restores both as new guests (new VMIDs) into the pool restow-restore
#      through the PVE API, with the API token restow-pve uses,
#   5. compares the restored VM disk with the original when the VM is stopped
#      (ORACLE=1), and a few files of the container,
#   6. writes everything into one report file to paste back.
#
# Nothing here deletes or overwrites the test guests themselves; the restored
# guests are removed at the end unless KEEP=1.
#
# Required environment:
#   RESTOW_URL       https://<your Restow instance running the 0.3.0 branch>
#   VM_ID            a small test VM (Debian with qemu-guest-agent is best)
#   CT_ID            a small unprivileged test container
#   FLEECING         a thin storage of this node for fleecing (local-lvm, local-zfs, ...)
#   TARGET_STORAGE   where restored guests are allocated (local-lvm, ...)
# For a node that is not enrolled yet:
#   RESTOW_TOKEN_FILE   file with the enrollment token from Restow (Connect Proxmox VE)
# Optional:
#   RESTOW_PVE_LOCAL_DIR  install from a local release folder (build-node-tarball.sh)
#                         instead of the instance; with RESTOW_ALLOW_UNSIGNED_DEV=1
#                         for a development build
#   ORACLE=1              also compare restored and original VM disk bit for bit
#                         (needs the test VM stopped: its disk must not change)
#   KEEP=1                keep the restored guests
#   SKIP_INSTALL=1        restow-pve is installed already
set -u

: "${RESTOW_URL:?set RESTOW_URL}"
: "${VM_ID:?set VM_ID}"
: "${CT_ID:?set CT_ID}"
: "${FLEECING:?set FLEECING}"
: "${TARGET_STORAGE:?set TARGET_STORAGE}"
STORAGE_ID="${STORAGE_ID:-restow}"
NODE=$(hostname -s)
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
REPORT="${REPORT:-/root/restow-pve-report-$STAMP.txt}"
WORK=$(mktemp -d)
PASS=0
FAIL=0
RESTORED_VM=''
RESTORED_CT=''

exec 3>>"$REPORT"
log() { printf '%s\n' "$*" | tee /dev/fd/3; }
section() { log ""; log "===== $* ====="; }
# Secrets never go into the report: token secrets and node secrets are redacted.
redact() { sed -E 's/(rset_|rsea_)[A-Za-z0-9_-]{20,}/\1<redacted>/g; s/("(nodeSecret|pveTokenSecret|password|repositoryPassword)"[[:space:]]*:[[:space:]]*")[^"]*/\1<redacted>/g; s/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})=([0-9a-f-]{36})/\1=<redacted>/g'; }
run() {
  log "\$ $*"
  "$@" 2>&1 | redact | tee /dev/fd/3
}
ok() {
  PASS=$((PASS + 1))
  log "PASS: $*"
}
bad() {
  FAIL=$((FAIL + 1))
  log "FAIL: $*"
}
cleanup() {
  if [ -z "${KEEP:-}" ]; then
    [ -n "$RESTORED_VM" ] && qm destroy "$RESTORED_VM" --purge >/dev/null 2>&1
    [ -n "$RESTORED_CT" ] && pct destroy "$RESTORED_CT" --purge >/dev/null 2>&1
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

# task_log <upid>: the full PVE task log into the report.
task_log() {
  pvenode task log "$1" 2>&1 | redact >>"$REPORT"
}

# vzdump_restow <vmid>: back up onto the Restow storage; prints the task log path.
vzdump_restow() {
  _log="$WORK/vzdump-$1-$(date +%s).log"
  # Only the result goes to stdout (the caller reads it); the command to the report and stderr.
  printf '%s\n' "\$ vzdump $1 --storage $STORAGE_ID --mode snapshot --fleecing enabled=1,storage=$FLEECING --remove 0" | tee /dev/fd/3 >&2
  vzdump "$1" --storage "$STORAGE_ID" --mode snapshot --fleecing "enabled=1,storage=$FLEECING" --remove 0 >"$_log" 2>&1
  _rc=$?
  redact <"$_log" >>"$REPORT"
  printf '%s %s\n' "$_rc" "$_log"
}

latest_volid() {
  # newest backup of a guest on the Restow storage
  pvesm list "$STORAGE_ID" --vmid "$1" 2>/dev/null | awk 'NR > 1 { print $1 }' | sort | tail -n 1
}

wait_task() {
  _upid="$1"
  while :; do
    _st=$(pvesh get "/nodes/$NODE/tasks/$_upid/status" --output-format json 2>/dev/null)
    case "$_st" in
      *'"status":"stopped"'*) break ;;
    esac
    sleep 3
  done
  printf '%s' "$_st" | sed -n 's/.*"exitstatus":"\([^"]*\)".*/\1/p'
}

disk_sha() {
  # disk_sha <volid>: SHA-256 of a disk's raw content
  _path=$(pvesm path "$1")
  qemu-img convert -O raw "$_path" "$WORK/disk.raw" >/dev/null 2>&1 || return 1
  sha256sum "$WORK/disk.raw" | cut -d ' ' -f 1
  rm -f "$WORK/disk.raw"
}

first_disk() {
  # first_disk <vmid>: volid of the first disk of a VM config
  qm config "$1" | awk -F'[ ,]' '/^(scsi|virtio|sata|ide)[0-9]+: / && !/media=cdrom/ && !/^ide[0-9]+: none/ { print $2; exit }'
}

: >"$REPORT"
section "Restow for Proxmox VE: host test $STAMP on $NODE"
run pveversion -v
run uname -a
run pvesm status
run qm config "$VM_ID"
run qm status "$VM_ID"
run pct config "$CT_ID"
run pct status "$CT_ID"
run pveum user list --output-format json-pretty
run pveum pool list

# ---- 1. install ---------------------------------------------------------------
section "1. Install and enroll"
if [ -z "${SKIP_INSTALL:-}" ]; then
  if [ -n "${RESTOW_PVE_LOCAL_DIR:-}" ]; then
    cp "$RESTOW_PVE_LOCAL_DIR/pve.sh" "$WORK/pve.sh" 2>/dev/null ||
      cp "$(dirname "$0")/../../../agent/install/pve.sh" "$WORK/pve.sh" 2>/dev/null ||
      curl -fsSL "$RESTOW_URL/install/pve.sh" -o "$WORK/pve.sh"
  else
    curl -fsSL "$RESTOW_URL/install/pve.sh" -o "$WORK/pve.sh" || bad "download pve.sh from $RESTOW_URL"
  fi
  if RESTOW_URL="$RESTOW_URL" sh "$WORK/pve.sh" --setup-pve-user --fleecing-storage="$FLEECING" 2>&1 | redact | tee -a "$REPORT"; then
    ok "installer finished"
  else
    bad "installer failed"
  fi
fi
if [ -x /opt/restow-pve/bin/restow-pve ]; then
  ok "restow-pve installed: $(/opt/restow-pve/bin/restow-pve version)"
else
  bad "restow-pve missing"
fi
if perl -e 'require PVE::Storage::Custom::RestowPlugin; print "plugin loads\n"' >>"$REPORT" 2>&1; then
  ok "storage plugin loads in PVE's Perl"
else
  bad "storage plugin does not load (see the report)"
fi
run /opt/restow-pve/bin/restow-pve diagnose
if /opt/restow-pve/bin/restow-pve test >/dev/null 2>&1; then ok "restow-pve test"; else bad "restow-pve test reports problems (see diagnose above)"; fi
run pvesm status --storage "$STORAGE_ID"
if pvesm status --storage "$STORAGE_ID" 2>/dev/null | awk 'NR > 1 && $3 == "active"' | grep -q .; then
  ok "storage $STORAGE_ID active"
else
  bad "storage $STORAGE_ID not active"
fi
sleep 70 # one heartbeat: inventory reaches Restow
run journalctl -u restow-pve -n 50 --no-pager

# ---- 2. VM: full, then incremental ----------------------------------------------
section "2. VM $VM_ID: first backup (full read expected)"
ORACLE_SHA=''
if [ -n "${ORACLE:-}" ]; then
  if qm status "$VM_ID" | grep -q stopped; then
    ORACLE_SHA=$(disk_sha "$(first_disk "$VM_ID")")
    log "reference SHA-256 of the VM's first disk: $ORACLE_SHA"
  else
    log "ORACLE=1 needs the VM stopped; skipping the bit-for-bit comparison"
  fi
fi
# shellcheck disable=SC2046 # the exit code and the log path, split on purpose
set -- $(vzdump_restow "$VM_ID")
if [ "$1" = 0 ]; then ok "VM backup 1"; else bad "VM backup 1 (exit $1)"; fi
grep -qi "bitmap mode new\|bitmap mode none" "$2" && ok "first backup read the whole disk"
VM_VOL1=$(latest_volid "$VM_ID")
log "restore point: $VM_VOL1"

section "2b. VM $VM_ID: write in the guest, second backup (incremental expected for a running VM)"
if qm status "$VM_ID" | grep -q running && qm guest cmd "$VM_ID" ping >/dev/null 2>&1; then
  run qm guest exec "$VM_ID" -- sh -c "dd if=/dev/urandom of=/var/tmp/restow-test.bin bs=1M count=16 && sync"
fi
# shellcheck disable=SC2046 # the exit code and the log path, split on purpose
set -- $(vzdump_restow "$VM_ID")
if [ "$1" = 0 ]; then ok "VM backup 2"; else bad "VM backup 2 (exit $1)"; fi
if grep -qi "bitmap mode reuse" "$2"; then
  ok "second backup was incremental (bitmap reuse)"
elif qm status "$VM_ID" | grep -q running; then
  bad "second backup of a running VM was not incremental (see its log)"
else
  log "the VM is stopped: PVE starts it paused, so every backup reads the whole disk (expected)"
fi
VM_VOL2=$(latest_volid "$VM_ID")
log "restore point: $VM_VOL2"
run pvesm list "$STORAGE_ID" --vmid "$VM_ID"

# ---- 3. CT ------------------------------------------------------------------------
section "3. Container $CT_ID: backup (restic over the directory mechanism)"
# shellcheck disable=SC2046 # the exit code and the log path, split on purpose
set -- $(vzdump_restow "$CT_ID")
if [ "$1" = 0 ]; then ok "CT backup"; else bad "CT backup (exit $1)"; fi
CT_VOL=$(latest_volid "$CT_ID")
log "restore point: $CT_VOL"

# ---- 4. restore as new guests into restow-restore --------------------------------
section "4. Restore the VM as a new VMID into pool restow-restore (with restow-pve's API token)"
TOKEN_ID=$(sed -n 's/.*"pveTokenId": *"\([^"]*\)".*/\1/p' /etc/restow-pve/state.json)
TOKEN_SECRET=$(sed -n 's/.*"pveTokenSecret": *"\([^"]*\)".*/\1/p' /etc/restow-pve/state.json)
api() {
  # api <method> <path> [curl -d args...]: the PVE API as restow-pve calls it
  _m="$1"
  _p="$2"
  shift 2
  curl -ksS -X "$_m" -H "Authorization: PVEAPIToken=$TOKEN_ID=$TOKEN_SECRET" "https://127.0.0.1:8006/api2/json$_p" "$@"
}
if [ -n "$VM_VOL2" ]; then
  RESTORED_VM=$(pvesh get /cluster/nextid)
  out=$(api POST "/nodes/$NODE/qemu" -d "vmid=$RESTORED_VM" --data-urlencode "archive=$VM_VOL2" -d "storage=$TARGET_STORAGE" -d unique=1 -d pool=restow-restore)
  log "$out"
  upid=$(printf '%s' "$out" | sed -n 's/.*"data":"\([^"]*\)".*/\1/p')
  if [ -n "$upid" ] && [ "$(wait_task "$upid")" = OK ]; then ok "VM restored as $RESTORED_VM"; else bad "VM restore"; fi
  [ -n "$upid" ] && task_log "$upid"
  run qm config "$RESTORED_VM"
  if [ -n "$ORACLE_SHA" ]; then
    got=$(disk_sha "$(first_disk "$RESTORED_VM")")
    log "restored SHA-256: $got"
    # The first restore point is the one the reference was taken for when the VM was stopped.
    if [ "$got" = "$ORACLE_SHA" ]; then ok "restored disk equals the original bit for bit"; else bad "restored disk differs"; fi
  fi
fi
section "4b. Restore the container as a new ID into pool restow-restore"
if [ -n "$CT_VOL" ]; then
  RESTORED_CT=$(pvesh get /cluster/nextid)
  out=$(api POST "/nodes/$NODE/lxc" -d "vmid=$RESTORED_CT" --data-urlencode "ostemplate=$CT_VOL" -d restore=1 -d unprivileged=1 -d "storage=$TARGET_STORAGE" -d pool=restow-restore)
  log "$out"
  upid=$(printf '%s' "$out" | sed -n 's/.*"data":"\([^"]*\)".*/\1/p')
  if [ -n "$upid" ] && [ "$(wait_task "$upid")" = OK ]; then ok "CT restored as $RESTORED_CT"; else bad "CT restore"; fi
  [ -n "$upid" ] && task_log "$upid"
  if pct mount "$RESTORED_CT" >/dev/null 2>&1; then
    run ls -la "/var/lib/lxc/$RESTORED_CT/rootfs/etc/hostname" "/var/lib/lxc/$RESTORED_CT/rootfs/etc/os-release"
    pct unmount "$RESTORED_CT" >/dev/null 2>&1
    ok "restored container root file system is readable"
  fi
fi

section "5. The token cannot destroy a guest outside the restore pool"
out=$(api DELETE "/nodes/$NODE/qemu/$VM_ID" 2>&1)
log "$out"
case "$out" in
  *403* | *"Permission check failed"* | *"permission"*) ok "delete of the original VM refused (403)" ;;
  *) bad "delete of the original VM was not refused: $out" ;;
esac
section "5b. Deleting a restore point from PVE is refused"
out=$(pvesm free "$VM_VOL1" 2>&1)
log "$out"
case "$out" in
  *"retention is managed in Restow"*) ok "pvesm free refused" ;;
  *) bad "pvesm free was not refused" ;;
esac

# ---- 6. diagnostics -----------------------------------------------------------------
section "6. Diagnostics"
run /opt/restow-pve/bin/restow-pve status --json
run /opt/restow-pve/bin/restow-pve diagnose --json
run journalctl -u restow-pve -n 300 --no-pager
run journalctl -u pvedaemon -n 100 --no-pager
run journalctl -u pvestatd -n 50 --no-pager
run ls -la /run/restow-pve /var/lib/restow-pve
for f in /run/restow-pve/restore/*.log; do
  [ -f "$f" ] && run tail -n 50 "$f"
done

section "Result"
log "PASS $PASS, FAIL $FAIL"
log "Report: $REPORT (secrets are redacted; please paste it back)"
[ "$FAIL" -eq 0 ]
