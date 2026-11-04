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
#   6. runs the shapes that broke these paths before: a restart of restow-pve
#      during a backup, a container backed up twice in suspend mode, a
#      container restore larger than the restore folder, and the backups of
#      the optional guests below,
#   7. with INTERACTIVE=1 walks through what only Restow can start (boot tests,
#      restores, restore checks, Back up now) and checks on the node what each
#      left behind; the tester answers what Restow shows,
#   8. writes everything into one report file to paste back.
#
# Nothing here deletes or overwrites the test guests themselves; the restored
# guests (also those restored from Restow during INTERACTIVE=1) are removed at
# the end unless KEEP=1.
#
# Required environment:
#   RESTOW_URL       https://<your Restow instance running the 0.5.0 branch>
#   VM_ID            a small test VM (Debian with qemu-guest-agent is best)
#   CT_ID            a small unprivileged test container
#   FLEECING         a thin storage of this node for fleecing (local-lvm, local-zfs, ...)
#   TARGET_STORAGE   where restored guests are allocated (local-lvm, ...)
# For a node that is not enrolled yet:
#   RESTOW_TOKEN_FILE   file with the enrollment token from Restow (Connect Proxmox VE;
#                       the token is the RESTOW_ENROLL_TOKEN value in the command shown)
# Optional:
#   RESTOW_PVE_LOCAL_DIR  install from a local release folder (build-node-tarball.sh)
#                         instead of the instance; with RESTOW_ALLOW_UNSIGNED_DEV=1
#                         for a development build
#   ORACLE=1              also compare restored and original VM disk bit for bit
#                         (needs the test VM stopped: its disk must not change)
#   KEEP=1                keep the restored guests
#   SKIP_INSTALL=1        restow-pve is installed already
#   INTERACTIVE=1         also the steps started in Restow (section 7); needs a terminal
#   WAIT_MINUTES          how long a step started in Restow may take (default 30)
#   CT_RAW_ID             a container with raw lxc.* lines (e.g. lxc.cgroup2.devices.allow,
#                         lxc.mount.entry) and a bind mount point (mpN: /host/path,mp=...)
#   VM_PT_ID              a VM with PCI or USB passthrough (hostpciN or usbN)
#   PROTECTED_ID          a guest with protection 1
# Steps that cannot run (a guest not given, no terminal, a shape the node does not
# show) are counted as SKIP, never as PASS.
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
SKIP=0
RESTORED_VM=''
RESTORED_CT=''
# Guests restored from Restow during section 7, removed at the end unless KEEP=1.
RESTORED_EXTRA=''
# The restore folder before section 6c set a small one (restored at the end).
RESTORE_TMP_BEFORE=''
TINY_TMP=''
WAIT_SECONDS=$((${WAIT_MINUTES:-30} * 60))

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
skip() {
  SKIP=$((SKIP + 1))
  log "SKIP: $*"
}
# reset_restore_tmp: the restore folder as it was before section 6c.
reset_restore_tmp() {
  [ -n "$TINY_TMP" ] || return 0
  /opt/restow-pve/bin/restow-pve config --restore-tmp "${RESTORE_TMP_BEFORE:-/var/tmp/restow-pve}" >/dev/null 2>&1
  umount "$TINY_TMP" >/dev/null 2>&1
  TINY_TMP=''
}
cleanup() {
  reset_restore_tmp
  if [ -z "${KEEP:-}" ]; then
    [ -n "$RESTORED_VM" ] && qm destroy "$RESTORED_VM" --purge >/dev/null 2>&1
    [ -n "$RESTORED_CT" ] && pct destroy "$RESTORED_CT" --purge >/dev/null 2>&1
    for _id in $RESTORED_EXTRA; do
      if [ -f "/etc/pve/qemu-server/$_id.conf" ]; then
        qm destroy "$_id" --purge >/dev/null 2>&1
      else
        pct destroy "$_id" --purge >/dev/null 2>&1
      fi
    done
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

# guests: one line per guest of the cluster, tab-separated: vmid name pool tags status node type.
guests() {
  pvesh get /cluster/resources --type vm --output-format json 2>/dev/null |
    perl -MJSON::PP -0777 -ne 'for my $g (@{ decode_json($_) }) { print join("\t", map { defined($_) && $_ ne "" ? $_ : "-" } @$g{qw(vmid name pool tags status node type)}), "\n" }'
}

# named <name>: the VMID of the guest with that name (status 1 when there is none).
named() {
  guests | awk -F '\t' -v n="$1" '$2 == n { print $1; f = 1 } END { exit !f }'
}
not_named() { ! named "$1" >/dev/null; }

# wait_for <seconds> <command...>: until the command succeeds, every 5 seconds; 1 when the time is up.
wait_for() {
  _left=$1
  shift
  while :; do
    "$@" && return 0
    [ "$_left" -le 0 ] && return 1
    sleep 5
    _left=$((_left - 5))
  done
}

# pool_members: the VMIDs in the pool restow-restore.
pool_members() {
  guests | awk -F '\t' '$3 == "restow-restore" { print $1 }' | sort
}

# new_in_pool <file of pool_members before>: a guest that came into restow-restore since
# (not a temporary guest of a test).
new_in_pool() {
  guests | awk -F '\t' '$3 == "restow-restore" && $2 !~ /^restow-(boottest|restorecheck)-/ { print $1 }' | sort |
    comm -13 "$1" - | head -n 1 | grep .
}

# unlocked <vmid>: its configuration has no lock (the restore ended).
unlocked() {
  if [ -f "/etc/pve/qemu-server/$1.conf" ]; then
    ! qm config "$1" 2>/dev/null | grep -q '^lock:'
  else
    pct config "$1" >/dev/null 2>&1 && ! pct config "$1" 2>/dev/null | grep -q '^lock:'
  fi
}

# no_leftovers <label>: PASS when this node holds no temporary guest of a test and no marker.
no_leftovers() {
  _guests=$(guests | awk -F '\t' -v node="$NODE" '$6 == node && $2 ~ /^restow-(boottest|restorecheck)-/ { printf "%s ", $1 }')
  _markers=$(find /var/lib/restow-pve/tempguests -mindepth 1 -maxdepth 1 -printf '%f ' 2>/dev/null)
  if [ -z "$_guests$_markers" ]; then
    ok "$1: no temporary guest and no marker left"
  else
    bad "$1: left behind: guests ${_guests:-none}, markers ${_markers:-none}"
  fi
}

# journal_since <time>: restow-pve's journal since then, into the report; also prints it.
journal_since() {
  journalctl -u restow-pve --since "$1" --no-pager 2>&1 | redact | tee -a "$REPORT"
}

# step <instruction>: the tester does it in Restow and presses Enter; status 1 on "skip".
step() {
  log ">>> $*"
  printf 'Press Enter once done, or type skip: ' >/dev/tty
  read -r _answer </dev/tty || return 1
  log "(tester: ${_answer:-done})"
  [ "$_answer" != skip ]
}

# answer <question> <expected, an extended regex> <label>: PASS when the tester's answer matches.
answer() {
  printf '%s ' "$1" >/dev/tty
  read -r _answer </dev/tty || _answer=''
  log "$1 -> ${_answer:-<no answer>}"
  case "$_answer" in
    skip) skip "$3 (the tester skipped it)" ;;
    *) if printf '%s' "$_answer" | grep -Eqix "$2"; then ok "$3"; else bad "$3: Restow shows \"$_answer\""; fi ;;
  esac
}

# expected_rating <vmid>: what a boot test of the guest proves: green with a QEMU guest agent
# (a VM) or systemd (a container), else yellow.
expected_rating() {
  if [ -f "/etc/pve/qemu-server/$1.conf" ]; then
    if qm config "$1" | grep -Eq '^agent: *(1|enabled=1)'; then echo green; else echo yellow; fi
  elif [ "$(pct exec "$1" -- cat /proc/1/comm 2>/dev/null)" = systemd ]; then
    echo green
  else
    echo yellow
  fi
}

# vzdump_bg <vmid> <log> [mode]: a backup onto the Restow storage in the background; sets BG_PID.
vzdump_bg() {
  log "\$ vzdump $1 --storage $STORAGE_ID --mode ${3:-snapshot} --remove 0 (in the background)"
  vzdump "$1" --storage "$STORAGE_ID" --mode "${3:-snapshot}" --fleecing "enabled=1,storage=$FLEECING" --remove 0 >"$2" 2>&1 &
  BG_PID=$!
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
  if RESTOW_URL="$RESTOW_URL" sh "$WORK/pve.sh" --fleecing-storage="$FLEECING" 2>&1 | redact | tee -a "$REPORT"; then
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

section "5c. A PVE backup job with retention onto the Restow storage stays OK (prune is a no-op)"
before=$(pvesm list "$STORAGE_ID" --vmid "$VM_ID" 2>/dev/null | awk 'NR > 1' | wc -l)
_log="$WORK/vzdump-prune.log"
log "\$ vzdump $VM_ID --storage $STORAGE_ID --mode snapshot --fleecing enabled=1,storage=$FLEECING --remove 1 --prune-backups keep-last=1"
vzdump "$VM_ID" --storage "$STORAGE_ID" --mode snapshot --fleecing "enabled=1,storage=$FLEECING" --remove 1 --prune-backups keep-last=1 >"$_log" 2>&1
rc=$?
redact <"$_log" >>"$REPORT"
if [ "$rc" = 0 ]; then ok "vzdump with retention (prune-backups) succeeded"; else bad "vzdump with retention (prune-backups) failed (exit $rc)"; fi
if grep -q "retention is managed in Restow; PVE's retention settings are ignored" "$_log"; then
  ok "the prune says that retention is managed in Restow"
else
  bad "the prune's line is missing from the task log"
fi
after=$(pvesm list "$STORAGE_ID" --vmid "$VM_ID" 2>/dev/null | awk 'NR > 1' | wc -l)
if [ "$after" -gt "$before" ]; then ok "no restore point was pruned by PVE ($before before, $after after)"; else bad "restore points before $before, after $after"; fi

section "5d. A backup as restow-pve starts it sends no PVE notification (notification-mode legacy-sendmail)"
# The same call restow-pve makes on PVE 8.1 and newer: legacy-sendmail without mailto sends
# nothing. PVE must take the parameter from the node's token; if a version refuses it, report
# the answer (docs/PVE.md, "Notifications of vzdump").
out=$(api POST "/nodes/$NODE/vzdump" -d "vmid=$VM_ID" -d "storage=$STORAGE_ID" -d mode=snapshot -d remove=0 \
  --data-urlencode "fleecing=enabled=1,storage=$FLEECING" -d notification-mode=legacy-sendmail)
log "$out"
upid=$(printf '%s' "$out" | sed -n 's/.*"data":"\(UPID:[^"]*\)".*/\1/p')
if [ -n "$upid" ]; then
  exit_status=$(wait_task "$upid")
  task_log "$upid"
  case "$exit_status" in
    OK) ok "vzdump with notification-mode legacy-sendmail" ;;
    *) bad "vzdump with notification-mode legacy-sendmail ended with $exit_status" ;;
  esac
else
  bad "PVE refused notification-mode legacy-sendmail: $out"
fi
log "check root@pam's mailbox (and the notification targets): no mail for this backup expected"

# ---- 6. shapes that broke these paths before ----------------------------------------
section "6a. A restart of restow-pve during a backup leaves the backup alone"
# The backup runs in vzdump's provider process, not in the service: the service may restart
# (an update, systemctl restart) at any time.
_log="$WORK/vzdump-restart.log"
vzdump_bg "$VM_ID" "$_log"
sleep 5
restarted=''
if kill -0 "$BG_PID" 2>/dev/null; then
  run systemctl restart restow-pve
  restarted=1
fi
wait "$BG_PID"
rc=$?
redact <"$_log" >>"$REPORT"
if [ -z "$restarted" ]; then
  skip "the backup ended within 5 s, before the restart (a larger VM shows it)"
elif [ "$rc" = 0 ]; then
  ok "the backup across a restart of restow-pve ended OK"
else
  bad "the backup across a restart of restow-pve failed (exit $rc)"
fi
if systemctl is-active --quiet restow-pve; then ok "restow-pve runs again after the restart"; else bad "restow-pve does not run after the restart"; fi

section "6b. Container $CT_ID backed up twice in suspend mode (the second finds its parent)"
# In suspend mode PVE hands over a copy in a new folder each time; restow-pve backs it up
# through a stable folder, so restic finds the first backup as the parent.
suspend_ok=1
for n in 1 2; do
  _log="$WORK/vzdump-suspend-$n.log"
  vzdump_bg "$CT_ID" "$_log" suspend
  wait "$BG_PID"
  rc=$?
  redact <"$_log" >>"$REPORT"
  if [ "$rc" = 0 ]; then ok "suspend-mode backup $n of the container"; else bad "suspend-mode backup $n of the container (exit $rc)"; suspend_ok=''; fi
done
if [ -z "$suspend_ok" ]; then
  skip "the stable folder of a suspend-mode backup (a backup failed)"
elif grep -q "restic finds no earlier backup of this copy" "$WORK/vzdump-suspend-2.log"; then
  bad "the second suspend-mode backup was read in full: no stable folder (see its log)"
else
  ok "the second suspend-mode backup ran through the stable folder (its parent is the first)"
fi
log "In Restow, the second suspend-mode run of CT $CT_ID shows few new or changed files, not all of them."

section "6c. A container restore larger than the restore folder is refused at once, with what to do"
CT_SIZE_VOL=$(latest_volid "$CT_ID")
if [ -n "$CT_SIZE_VOL" ] && command -v mount >/dev/null; then
  RESTORE_TMP_BEFORE=$(sed -n 's/.*"restoreTmpDir": *"\([^"]*\)".*/\1/p' /etc/restow-pve/state.json)
  TINY_TMP="$WORK/tiny-restore-folder"
  mkdir -p "$TINY_TMP"
  if mount -t tmpfs -o size=16m restow-host-test "$TINY_TMP"; then
    run /opt/restow-pve/bin/restow-pve config --restore-tmp "$TINY_TMP"
    TOO_BIG_CT=$(pvesh get /cluster/nextid)
    out=$(api POST "/nodes/$NODE/lxc" -d "vmid=$TOO_BIG_CT" --data-urlencode "ostemplate=$CT_SIZE_VOL" -d restore=1 -d unprivileged=1 -d "storage=$TARGET_STORAGE" -d pool=restow-restore)
    log "$out"
    upid=$(printf '%s' "$out" | sed -n 's/.*"data":"\([^"]*\)".*/\1/p')
    if [ -n "$upid" ]; then
      exit_status=$(wait_task "$upid")
      task_log "$upid"
      if [ "$exit_status" = OK ] || printf '%s' "$exit_status" | grep -q '^WARNINGS'; then
        bad "a container restore into a 16 MB restore folder ended with $exit_status"
      elif pvenode task log "$upid" 2>/dev/null | grep -q "free, the restore needs about .*restow-pve config --restore-tmp"; then
        ok "the restore was refused with the free space, the need and restow-pve config --restore-tmp"
      else
        bad "the restore failed without the space message (exit status: $exit_status)"
      fi
    else
      bad "PVE did not start the container restore: $out"
    fi
    # Only a guest the refused restore left in restow-restore (PVE removes it on failure).
    if pool_members | grep -qx "$TOO_BIG_CT"; then pct destroy "$TOO_BIG_CT" --purge >/dev/null 2>&1; fi
    reset_restore_tmp
  else
    skip "no tmpfs for a small restore folder"
    TINY_TMP=''
  fi
else
  skip "no container restore point, or no mount"
fi

section "6d. Backups of the optional guests (CT_RAW_ID, VM_PT_ID, PROTECTED_ID)"
for g in "${CT_RAW_ID:-}" "${VM_PT_ID:-}" "${PROTECTED_ID:-}"; do
  [ -n "$g" ] || continue
  if [ -f "/etc/pve/qemu-server/$g.conf" ]; then run qm config "$g"; else run pct config "$g"; fi
  # shellcheck disable=SC2046 # the exit code and the log path, split on purpose
  set -- $(vzdump_restow "$g")
  if [ "$1" = 0 ]; then ok "backup of guest $g"; else bad "backup of guest $g (exit $1)"; fi
done
[ -n "${CT_RAW_ID:-}${VM_PT_ID:-}${PROTECTED_ID:-}" ] || skip "no CT_RAW_ID, VM_PT_ID or PROTECTED_ID given"

# ---- 7. started in Restow (INTERACTIVE=1) ---------------------------------------------
# Boot tests, restores from Restow, restore checks and "Back up now" start in Restow; the
# script says what to press, then checks on the node what the step did and left behind, and
# asks what Restow shows. Without INTERACTIVE=1 (or without a terminal) every step is a SKIP.
interactive=''
if [ -n "${INTERACTIVE:-}" ] && [ -r /dev/tty ] && [ -w /dev/tty ]; then interactive=1; fi

# boot_test <vmid> <label>: one boot test started in Restow, checked on the node.
boot_test() {
  _since=$(date '+%Y-%m-%d %H:%M:%S')
  _want=$(expected_rating "$1")
  if ! step "In Restow, open guest $1, choose its newest restore point and press 'Boot test now' ($2)."; then
    skip "$2"
    return 1
  fi
  if wait_for "$WAIT_SECONDS" named "restow-boottest-$1" >/dev/null; then
    ok "$2: the temporary guest restow-boottest-$1 came up"
  else
    bad "$2: no temporary guest restow-boottest-$1 within ${WAIT_MINUTES:-30} minutes"
  fi
  if wait_for "$WAIT_SECONDS" not_named "restow-boottest-$1"; then ok "$2: the temporary guest is gone"; else bad "$2: the temporary guest is still there"; fi
  wait_for 120 test ! -e /var/lib/restow-pve/boottest/current.json || bad "$2: boottest/current.json stays"
  no_leftovers "$2"
  journal_since "$_since" >/dev/null
  answer "What does Restow show for this boot test (green, yellow, red, skipped)?" "$_want" "$2: rated $_want"
}

# restore_from_restow <vmid> <label> [start]: a restore as a new guest started in Restow; sets
# NEW_GUEST to the restored guest once its restore ended.
restore_from_restow() {
  NEW_GUEST=''
  _since=$(date '+%Y-%m-%d %H:%M:%S')
  pool_members >"$WORK/pool-before"
  _how="no start"
  [ -n "${3:-}" ] && _how="with 'Start after the restore'"
  if ! step "In Restow, on guest $1: 'Restore as a new guest', target storage $TARGET_STORAGE, $_how ($2)."; then
    skip "$2"
    return 1
  fi
  if NEW_GUEST=$(wait_for "$WAIT_SECONDS" new_in_pool "$WORK/pool-before"); then
    RESTORED_EXTRA="$RESTORED_EXTRA $NEW_GUEST"
    log "restored as $NEW_GUEST"
  else
    bad "$2: no new guest in restow-restore within ${WAIT_MINUTES:-30} minutes"
    return 1
  fi
  if wait_for "$WAIT_SECONDS" unlocked "$NEW_GUEST"; then ok "$2: the restore of $NEW_GUEST ended"; else bad "$2: $NEW_GUEST stays locked"; fi
  # The node starts a copy only after the restore; give it its minute.
  [ -n "${3:-}" ] && sleep 70
  journal_since "$_since" >"$WORK/journal-step"
  if [ -f "/etc/pve/qemu-server/$NEW_GUEST.conf" ]; then run qm config "$NEW_GUEST"; else run pct config "$NEW_GUEST"; fi
  return 0
}

# restore_check <vmid> <label> <expected rating>: the monthly restore check of a job, which
# Restow plans for a guest that had none in the last 30 days.
restore_check() {
  _since=$(date '+%Y-%m-%d %H:%M:%S')
  if ! step "In Restow, put guest $1 into a backup job of its own with 'Monthly restore check' on (storage $TARGET_STORAGE); Restow plans the check within about five minutes ($2)."; then
    skip "$2"
    return 1
  fi
  if wait_for "$WAIT_SECONDS" named "restow-restorecheck-$1" >/dev/null; then
    ok "$2: the temporary guest restow-restorecheck-$1 came up"
  else
    log "$2: no temporary guest restow-restorecheck-$1 seen (a restore that fails early creates none)"
  fi
  wait_for "$WAIT_SECONDS" not_named "restow-restorecheck-$1" || bad "$2: the temporary guest restow-restorecheck-$1 stays"
  # The check ends after its guest is gone; then nothing of it may be left.
  sleep 30
  no_leftovers "$2"
  journal_since "$_since" >/dev/null
  answer "What does Restow show for this restore check (green, yellow, red, skipped)?" "$3" "$2: rated $3"
}

# active_vzdump <vmid>: the UPID of a running vzdump task of the guest on this node.
active_vzdump() {
  pvesh get "/nodes/$NODE/tasks" --source active --typefilter vzdump --vmid "$1" --output-format json 2>/dev/null |
    perl -MJSON::PP -0777 -ne 'my $t = decode_json($_); exit 1 if !@$t; print $t->[0]{upid}, "\n"'
}

if [ -z "$interactive" ]; then
  section "7. Steps started in Restow"
  skip "boot tests, restores from Restow, restore checks and Back up now (run with INTERACTIVE=1 in a terminal)"
else
  section "7a. Boot test of VM $VM_ID twice in a row on this node"
  boot_test "$VM_ID" "boot test 1 of VM $VM_ID" && boot_test "$VM_ID" "boot test 2 of VM $VM_ID (right after the first)"

  section "7b. Restore of VM $VM_ID from Restow; the node is idle again afterwards"
  if restore_from_restow "$VM_ID" "restore of VM $VM_ID"; then
    servers=$(find /run/restow-pve/restore -mindepth 1 -maxdepth 1 -printf '%f ' 2>/dev/null)
    if [ -z "$servers" ]; then
      ok "no restore server is left in /run/restow-pve/restore"
    else
      bad "restore servers are left: $servers"
    fi
    _since=$(date '+%Y-%m-%d %H:%M:%S')
    _version=$(/opt/restow-pve/bin/restow-pve version --short)
    if step "If Restow offers this node a newer release, press 'Update now' on the node; else type skip."; then
      # shellcheck disable=SC2016 # expanded by the inner shell
      if wait_for 600 sh -c '[ "$(/opt/restow-pve/bin/restow-pve version --short)" != "$1" ]' _ "$_version"; then
        ok "the node updated right after the restore ($_version -> $(/opt/restow-pve/bin/restow-pve version --short))"
      else
        bad "the node did not update within 10 minutes after the restore (busy?)"
      fi
      journal_since "$_since" >/dev/null
    else
      skip "Update now after a restore"
    fi
  fi

  section "7c. Restore checks: one that passes (VM $VM_ID), one that fails (CT $CT_ID)"
  restore_check "$VM_ID" "restore check of VM $VM_ID" green
  RESTORE_TMP_BEFORE=$(sed -n 's/.*"restoreTmpDir": *"\([^"]*\)".*/\1/p' /etc/restow-pve/state.json)
  TINY_TMP="$WORK/tiny-restore-folder"
  mkdir -p "$TINY_TMP"
  if mount -t tmpfs -o size=16m restow-host-test "$TINY_TMP"; then
    run /opt/restow-pve/bin/restow-pve config --restore-tmp "$TINY_TMP"
    # A container restore into a 16 MB restore folder is refused: the check must not be green.
    restore_check "$CT_ID" "restore check of CT $CT_ID that fails (16 MB restore folder)" "red|failed"
    reset_restore_tmp
  else
    skip "a restore check that fails (no tmpfs for a small restore folder)"
    TINY_TMP=''
  fi

  section "7d. Container with raw lxc.* lines and a bind mount (CT_RAW_ID)"
  if [ -z "${CT_RAW_ID:-}" ]; then
    skip "no CT_RAW_ID given"
  else
    if restore_from_restow "$CT_RAW_ID" "restore of CT $CT_RAW_ID"; then
      if pct config "$NEW_GUEST" | grep -Eq '^lxc\.|^mp[0-9]+: /'; then
        bad "the restored container has raw lxc.* lines or a bind mount (only root may set them)"
      else
        ok "the restored container has no raw lxc.* line and no bind mount"
      fi
      if grep -q "PVE restores raw LXC options only for root@pam" "$WORK/journal-step"; then ok "the node names the skipped lxc.* lines"; else bad "the node's log does not name the skipped lxc.* lines"; fi
      answer "Does Restow show the restore amber ('Restored with warnings') with the skipped lxc.* lines and the left-out mount point (yes/no)?" yes "restore of CT $CT_RAW_ID amber with what to put back"
    fi
    restore_check "$CT_RAW_ID" "restore check of CT $CT_RAW_ID" yellow
    boot_test "$CT_RAW_ID" "boot test of CT $CT_RAW_ID"
  fi

  section "7e. VM with PCI or USB passthrough (VM_PT_ID): restored as root, never started"
  if [ -z "${VM_PT_ID:-}" ]; then
    skip "no VM_PT_ID given"
  else
    if restore_from_restow "$VM_PT_ID" "restore of VM $VM_PT_ID" start; then
      if grep -q "which PVE restores only for root@pam: restoring as root" "$WORK/journal-step"; then ok "the VM was restored as root"; else bad "the node's log does not say the VM was restored as root"; fi
      if qm config "$NEW_GUEST" | grep -Eq '^(hostpci|usb)[0-9]+:'; then ok "the copy keeps the original's devices"; else bad "the copy lost the original's devices"; fi
      if qm status "$NEW_GUEST" | grep -q stopped; then ok "the copy with the original's devices was not started"; else bad "the copy with the original's devices runs"; fi
    fi
    # During its boot test the temporary guest has no passthrough left.
    ( wait_for "$WAIT_SECONDS" named "restow-boottest-$VM_PT_ID" >/dev/null &&
      sleep 20 && qm config "$(named "restow-boottest-$VM_PT_ID")" >"$WORK/pt-boottest.conf" 2>&1 ) &
    watcher=$!
    if boot_test "$VM_PT_ID" "boot test of VM $VM_PT_ID"; then
      wait "$watcher"
    else
      kill "$watcher" 2>/dev/null
    fi
    if [ ! -s "$WORK/pt-boottest.conf" ]; then
      skip "the boot test guest of VM $VM_PT_ID was not seen"
    elif grep -Eq '^(hostpci|usb)[0-9]+:' "$WORK/pt-boottest.conf"; then
      bad "the boot test guest of VM $VM_PT_ID had passthrough devices"
    else
      ok "the boot test guest of VM $VM_PT_ID ran without passthrough devices"
    fi
  fi

  section "7f. Protected guest (PROTECTED_ID): its restore check removes the protected copy"
  if [ -z "${PROTECTED_ID:-}" ]; then
    skip "no PROTECTED_ID given"
  else
    restore_check "$PROTECTED_ID" "restore check of protected guest $PROTECTED_ID" green
  fi

  section "7g. Restart of restow-pve during a boot test"
  _since=$(date '+%Y-%m-%d %H:%M:%S')
  if step "In Restow, press 'Boot test now' on the newest restore point of VM $VM_ID; the script restarts restow-pve once its temporary guest runs."; then
    if wait_for "$WAIT_SECONDS" named "restow-boottest-$VM_ID" >/dev/null; then
      run systemctl restart restow-pve
      if wait_for 600 not_named "restow-boottest-$VM_ID"; then ok "the restarted service removed the boot test's guest"; else bad "the boot test's guest stays after the restart"; fi
      no_leftovers "boot test with a restart"
      journal_since "$_since" >/dev/null
      answer "What does Restow show for this boot test after a few minutes (green, yellow, red, skipped, failed)?" "failed|error|red|skipped" "a boot test cut by a restart is never green"
    else
      bad "no temporary guest restow-boottest-$VM_ID within ${WAIT_MINUTES:-30} minutes"
    fi
  else
    skip "restart during a boot test"
  fi

  section "7h. Restart of restow-pve during a backup started in Restow; no PVE notification"
  _since=$(date '+%Y-%m-%d %H:%M:%S')
  if step "In Restow, press 'Back up now' on VM $VM_ID; the script restarts restow-pve while vzdump runs."; then
    if upid=$(wait_for 600 active_vzdump "$VM_ID"); then
      run systemctl restart restow-pve
      exit_status=$(wait_task "$upid")
      task_log "$upid"
      if [ "$exit_status" = OK ]; then ok "the backup across the restart ended OK"; else bad "the backup across the restart ended with $exit_status"; fi
      sleep 70
      if journal_since "$_since" | grep -q "waiting again for"; then ok "the restarted service waited for the backup again"; else bad "the restarted service did not wait for the backup again"; fi
      answer "Does Restow show this run as succeeded, once (yes/no)?" yes "the backup across a restart succeeded in Restow"
      answer "Did root@pam's mailbox or a PVE notification target get a message for this backup (no/yes)?" no "a backup from Restow sends no PVE notification"
    else
      bad "no vzdump of VM $VM_ID started within 10 minutes"
    fi
  else
    skip "restart during a backup started in Restow"
  fi

  section "7i. Restore with start of a container whose original runs with a static IP"
  if pct status "$CT_ID" | grep -q running && pct config "$CT_ID" | grep -Eq '^net[0-9]+:.*ip=[0-9]'; then
    if restore_from_restow "$CT_ID" "restore of CT $CT_ID with start" start; then
      if pct status "$NEW_GUEST" | grep -q stopped; then ok "the copy was not started beside its running original"; else bad "the copy runs beside its original with the same IP"; fi
      if grep -q "is not started" "$WORK/journal-step"; then ok "the node says why the copy is not started"; else bad "the node's log does not say why the copy is not started"; fi
      answer "Does Restow show the restore amber with 'the original CT $CT_ID runs with <IP>' (yes/no)?" yes "restore with start of a CT beside its original: amber, not started"
    fi
  else
    skip "CT $CT_ID does not run with a static IP"
  fi
fi

# ---- 8. diagnostics -----------------------------------------------------------------
section "8. Diagnostics"
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
log "PASS $PASS, FAIL $FAIL, SKIP $SKIP"
log "Report: $REPORT (secrets are redacted; please paste it back)"
[ "$FAIL" -eq 0 ]
