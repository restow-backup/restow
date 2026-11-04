# restow-pve: command line, provider protocol and node API

This is the stable interface of `restow-pve` (Apache-2.0), the node helper for
Proxmox VE ([PVE.md](PVE.md)). The storage plugin shim (`integrations/pve/plugin`,
AGPL-3.0-or-later, a separate work) depends only on the provider protocol
below; anything else that speaks it can drive `restow-pve` the same way.
Changes are additive: new fields may appear, existing ones keep their meaning.

## Command line

| Command | Purpose |
| --- | --- |
| `restow-pve provider <verb>` | One call of the storage plugin (below). |
| `restow-pve enroll` | Enroll the node: `--url`, `--pve-token-id`, `--fleecing-storage`, `--node`; secrets only from files or the environment: `RESTOW_TOKEN_FILE` / `RESTOW_TOKEN` / `RESTOW_ENROLL_TOKEN`, `RESTOW_PVE_TOKEN_SECRET_FILE` / `RESTOW_PVE_TOKEN_SECRET`. |
| `restow-pve run` | The service: heartbeat every minute, tasks, inventory every five minutes, caches, self-update. |
| `restow-pve status [--json]` | Local state and the last heartbeat. |
| `restow-pve diagnose [--json]` / `test` | All checks (plugin files, restic, storage.cfg, enrollment, PVE API and version, token privileges, restore pool, fleecing storage, Restow server); `test` exits 1 on any failure. |
| `restow-pve config` | `--allow-restores=true\|false`, `--fleecing-storage`, `--pve-cert-sha256`, `--restore-tmp`, `--boot-tests=true\|false`, `--boot-test-storage`, `--boot-test-bridge` (`-` clears it). |
| `restow-pve update` | Install a newer signed release the instance offers. |
| `restow-pve uninstall --yes` | Remove unit, plugin, state, caches and binaries. |
| `restow-pve serve-restore --volname V --device D --socket S` | The NBD restore server of one disk (started by the provider). It stops with the restore's cleanup, after `--idle` (one hour) without an NBD request, or after `--max-time` (30 days) in any case; it keeps two batches of eight blocks in flight. |
| `restow-pve version [--short]` | Version. |

`RESTOW_PVE_ROOT` prefixes every path (tests, relocated installs).

## Provider protocol

The shim runs `restow-pve provider <verb>`, writes **one JSON object** to stdin
and closes it. `restow-pve` writes **one JSON object** to stdout:

```json
{"ok": true, "result": { ... }}
{"ok": false, "error": "a message for the PVE task log"}
```

and exits 0 or 1. Every line on stderr is a log line for the PVE task log,
prefixed `info: `, `warn: ` or `err: `. Every request carries `storeid` (the PVE
storage id). PVE's hash keys are translated to camelCase; sizes are bytes.

The log function vzdump hands to a backup provider prints to the worker's
stderr only (`PVE::VZDump`: `sub { debugmsg($_[0], $_[1]); }`, without the
guest's log file handle). Those lines show in the PVE task log but never in the
guest's log file, which is what `backup_handle_log_file` passes on and what
Restow keeps as the run's log. Since 0.4.0 `restow-pve` therefore keeps its
lines of a backup itself, in vzdump's format (`YYYY-MM-DD HH:MM:SS INFO: ...`,
local time): the root verbs in `/run/restow-pve/jobs/<storeid>-<vmid>.log`,
`backup-container` (forked, unprivileged) in its run folder, which
`backup-cleanup` folds into the job's log. `backup-handle-log-file` merges
them into the guest's log by time before the upload and removes them. A
warning `backup_container` logs is counted by the forked child only
(`PVE::LXC::Namespaces::run_in_userns` runs it through `PVE::Tools::run_fork`),
so the PVE task does not end "with warnings" for it; the run in Restow says
what is missing instead.

| Verb (PVE method) | Request fields | Result |
| --- | --- | --- |
| `job-init` (`job_init`) | `startTime` | `{}` |
| `job-cleanup` | | `{}` |
| `backup-init` | `vmid`, `vmtype` (`qemu`/`lxc`), `startTime` | `{archiveName}`, e.g. `vm/101/2026-10-03T22:00:00Z` |
| `backup-get-mechanism` | `vmid`, `vmtype` | `{mechanism}`: `nbd` or `directory` |
| `backup-vm-query-incremental` | `vmid`, `volumes: {device: {size}}` | `{devices: {device: "use"\|"new"}}` |
| `backup-vm` | `vmid`, `guestConfig`, `volumes: {device: {size, bitmapMode, nbdPath, bitmapName, nbdExport?}}`, `info: {bandwidthLimit, firewallConfig}` | `{snapshotId}`; returns only after the restore point is committed |
| `backup-container-prepare` | `vmid`, `info: {directory, sources, backupUserId}` | `{}` (runs as root) |
| `backup-container` | `vmid`, `guestConfig`, `excludePatterns`, `info` | `{}` (runs as the mapped container root) |
| `backup-cleanup` | `vmid`, `vmtype`, `success`, `info: {error}` | `{stats: {archiveSize}}` |
| `backup-handle-log-file` | `vmid`, `logFile` | `{}` |
| `restore-get-mechanism` | `volname` | `{mechanism: "qemu-img"\|"directory", vmtype}` |
| `archive-get-guest-config` / `archive-get-firewall-config` | `volname` | `{config}` (firewall: string or null) |
| `restore-vm-init` | `volname` | `{devices: {device: {size}}}` |
| `restore-vm-volume-init` | `volname`, `device` | `{qemuImgPath}`: `nbd+unix:///<device>?socket=<path>`; since 0.5.0 the server belongs to the calling PVE worker (`/run/restow-pve/restore/<hash>-<worker pid>-<device>.*`), so two restores of one restore point get one each, and an init stops another worker's server only when that worker is gone |
| `restore-vm-volume-cleanup` / `restore-vm-cleanup` | `volname`, `device` | `{}`; stops only the calling worker's servers (and those a restow-pve before 0.5.0 started) |
| `restore-container-init` | `volname` | `{archiveDirectory}`: `<restore folder>/ct-<hash>-<random>/root`, one per call (since 0.5.0); refused when the restore folder lacks the space |
| `restore-container-cleanup` | `volname`, `directory` (the `archiveDirectory` of its init, since 0.5.0) | `{}`; removes that folder only (it must lie below the restore folder); without `directory` the folders of the volname that the calling PVE worker owns |
| `storage-status` | | `{total, used, avail, active}` (cache only, never the network) |
| `list-volumes` | `vmid?` | `{volumes: [{volname, vmid, ctime, size, subtype, format}]}`. Without `vmid` from the cluster's listing the service keeps (`cache/volumes.json`, every page of `GET /listing` since 0.5.0). With `vmid` (a guest's Backup tab) since 0.5.0 from `GET /listing?vmid=` with a 5 s limit, kept in `cache/volumes-<vmid>.json`; without the server from the newer of that file and the cluster's listing |
| `volume-size` | `volname` | `{size}` (since 0.5.0, PVE's `volume_size_info`): from `GET /restore-points?volname=` with a 5 s limit (`byteSize`, or the disks' sizes from an older server); without the server from the node's listings. "not found in Restow" when the server does not know it |
| `activate-storage` | | `{}` |

Volume names are `backup/<vm|ct>/<vmid>/<UTC time>`.

State that crosses calls is kept under `/run/restow-pve` (`jobs/<storeid>-<vmid>.json`,
0600); a container backup gets a run folder owned by the mapped root uid with
the per-run restic credential (0400), because PVE runs `backup_container` forked
and unprivileged.

### Rules the VM backup keeps

1. `backup-vm` returns only after the server committed the restore point; on
   success PVE clears the bitmap.
2. Anything failing before the commit fails the call; QEMU then merges the
   bitmap back.
3. The commit carries a commit id chosen and stored before it is sent; a retry
   gets "already committed" with the same restore point. When the outcome
   cannot be learned, the call fails; the next backup then reads the whole disk.
4. `use` is answered only when the server's newest restore point of the disk
   was written through the same storage id with the same size and this node's
   journal ends at that restore point, and not on every 30th backup.
5. A block is discarded (NBD TRIM) only after the server acknowledged it.

## Node API (`/agent/pve/v1`)

HTTPS, JSON (`application/problem+json` on errors), HTTP Basic `nodeId:nodeSecret`
except enrollment. Binary formats are defined in
`packages/core/src/pve/formats.ts` and `agent/internal/pve/formats.go`
(golden files in `agent/internal/pve/testdata`).

| Route | Purpose |
| --- | --- |
| `POST /enroll/preflight` | `{token}` → `{expiresAt, pveTokenId, pveTokenSecret}`: the installer's check before it changes anything. 401 when the token is unknown, used, revoked or expired. `pveTokenId`/`pveTokenSecret` are the existing PVE API token an admin gave for this enrollment, else `null`. Does not use the token up. |
| `POST /enroll` | `{token, clusterName, clusterFingerprint, nodeName, pveVersion, helperVersion, fleecingStorage}` → `{nodeId, nodeSecret, clusterId, storageId, createdCluster}` |
| `POST /heartbeat` | node facts → `{tasks, storageId, usage, update, cancel, queuePaused}`; since 0.4.0 the facts carry `activeRuns`, the run ids of the backups open on the node (never null). While an update pauses new job starts, or the node's queue is paused (`queuePaused`, 0.4.2), the answer holds no backup task. Nodes with boot tests also send `capabilities` (below). Since 0.4.2: `update` is `{version, now}` (`now`: install it once idle, "Update now" or the fleet phase of an update), and `cancel` is `{tasks: [taskId], runs: [{id, vmid, taskId}]}`, what was stopped in the web app (see "Cancel orders"). Since 0.5.0 the facts carry `heldTasks: {current?, queued: [taskId]}`: the task the node works on (absent when none), those waiting in its queue in their order and those whose result it keeps to send again (never null, at most 64; also a task it waits for again after a restart), so the server does not expire a task the node still holds. |
| `POST /inventory` | `{guests: [...]}` of this node; since 0.4.2 a VM carries `smbiosUuid` (the `uuid` of its `smbios1`), which finds the Restow server's own VM (PVE.md) |
| `POST /tasks/:id/result` | `{status: done\|failed, error, result}`; see "Task results" |
| `GET /listing` | restore points of the cluster for the plugin |
| `GET /update` | `{version}` of a newer signed release or `""` |
| `POST /runs` | open a backup run → `{runId, guestId, origin, progressIntervalSeconds}` (the last since 0.4.0) |
| `POST /runs/:id/incremental` | `{devices: [{device, size}]}` → per disk `mode`, `baseSnapshotId`, `hashesDigest` |
| `PUT /runs/:id/blocks` | one frame of up to 16 blocks (`RSBF`, octet-stream) |
| `POST /runs/:id/commit` | `{commitId, devices?, guestConfig, firewallConfig, resticSnapshotId?, resticUnreadable?, resticUnreadablePaths?, consistency?, vmConsistency?, ...}` → `{snapshotId, alreadyCommitted, hashesDigests}`. `consistency` is one line on what the restore point lacks (a container's unreadable items; a VM's missing freeze). `vmConsistency` (VMs, 0.5.0) is `{state, detail?, warnings?}` with `state` one of `frozen`, `stopped`, `no_agent`, `crash_consistent`, `freeze_failed`, `unknown`, from vzdump's log of the running backup. |
| `POST /runs/:id/finish`, `POST /runs/:id/log` | end of the run; PVE task log `{log, vmConsistency?}` (VMs, 0.5.0: the same classification read from the whole log, which `backup_handle_log_file` gets after the commit, for the server where the commit's said `unknown`; an older server ignores both) |
| `POST /runs/:id/progress` | `{bytesDone, bytesTotal?, bytesUploaded?}` → 204: how far a running backup is (since 0.4.0). Basic `nodeId:nodeSecret`, or the run's restic credential `runId:token` (the unprivileged container backup has no node secret). Reports closer than 2 s are dropped; 409 once the run ended. |
| `POST /runs/:id/restic` | per-run restic credential of a container backup; since 0.4.0 also `{progressUrl, progressIntervalSeconds}` |
| `GET /restore-points?volname=` | a restore point by its PVE volume name |
| `GET /snapshots/:id/disks/:device/hashes` | block hash list (`RSBH`) |
| `GET /snapshots/:id/disks/:device/blocks?from=&count=` | up to 16 blocks of the synthetic full |
| `POST /snapshots/:id/restic` | read credential for a container restore |

`/agent/pve/restic/:guestId/*` is the restic REST v2 backend of a container's
repository, Basic `runId:token`, append-only.

### Capabilities and task kinds

The original task kinds are `backup`, `restore` and `refresh_inventory`; every node runs them.
A newer kind goes only to a node that announced it: the heartbeat carries
`capabilities`, a list of kind names (never null; `[]` when the node offers none). The
server keeps the list of the latest heartbeat in the node's facts and

- hands a task of such a kind only to a node whose latest heartbeat listed it: a node
  that does not send the field (any `restow-pve` before boot tests) never gets one;
- fails a queued task of such a kind, instead of delivering it, when the node's heartbeat
  no longer lists it (an older helper reinstalled, or the node switched it off), with
  "The node does not run boot tests ...";
- offers the feature in the web app only for guests whose node announced it.

An older server ignores the field (the heartbeat schema drops unknown keys), so a newer
node talks to it as before. Capabilities so far:

| Capability | Task kind | Since |
| --- | --- | --- |
| `boot_test` | `boot_test` | the release after 0.4.0 |

The VM file restore needs no capability: the server reads the disks from its own chunk
store (PVE.md, "Files of a VM"); nothing of it runs on the node.

### Task `boot_test`

`params`: `{volname, kind: "vm"|"ct", vmid, maxMemoryMiB, timeoutSeconds, dataBytes,
diskBytes, snapshotId, jobId?}`. `vmid` is the guest's own VMID (names and logs only; it is
never touched), `dataBytes` what the restore writes (a VM's stored non-zero blocks), `diskBytes`
the size of all disks.

The node answers with the usual `POST /tasks/:id/result`. `status: "done"` for every test
that came to an outcome, with `result`:

```json
{"outcome": "green", "reason": "agent_answered", "message": "...", "durationMs": 95000,
 "bootSeconds": 41.5, "guestAgent": true, "tempVmid": 9001, "storage": "local-lvm",
 "cleanedUp": true, "log": "12:00:01 restoring to the temporary vm 9001 on local-lvm\n..."}
```

| `outcome` | `reason` (examples) | Meaning |
| --- | --- | --- |
| `green` | `agent_answered`, `system_running` (before 0.5.0 `init_running`) | the VM's QEMU guest agent answered `qm guest cmd <id> ping`; a systemd container's `systemctl is-system-running` said `running`, or `degraded` with only network units failed (the test takes the network away) |
| `yellow` | `no_guest_agent`, `agent_not_answering`, `guest_paused`, `system_degraded`, `system_starting`, `system_unknown`, `init_running_unverified`, `init_unknown` | the guest started and kept running for `timeoutSeconds` without proof: no agent answer (`no_guest_agent` when the test switched the agent on, `agent_not_answering` when the guest has it enabled), a paused VM, a container with failed units (listed), still starting, whose systemd could not be asked, with another init than systemd, or whose init could not be read |
| `red` | `restore_failed`, `start_failed`, `guest_stopped`, `guest_panicked`, `guest_internal_error`, `system_maintenance` | the restore, the start or the boot failed (a panic, an internal error of the virtual CPU, a container in emergency or rescue mode) |
| `skipped` | `memory_limit`, `node_memory`, `storage_space`, `storage_content`, `no_storage`, `backup_running`, `boot_test_running`, `restores_off`, `boot_tests_off`; since 0.5.0 also `custom_qemu_args` (raw QEMU `args` beyond `-cpu`, `-smbios`, `-rtc`), `host_disk` (a restored disk on a host path), `bridge_not_isolated` (`--boot-test-bridge` has a port that is no guest's), `node_resources` (the start failed for want of node memory), `storage_io_error` (the VM was paused by an I/O error of the boot test storage) | the node did not run it, or did not start the copy; `message` says why |

`status: "failed"` means the node could not carry the test out at all (its PVE API failed,
the temporary guest could not be isolated); the server records the outcome `error`. Green,
yellow and red become the restore point's boot test (`pve_snapshots.boot_test`); skipped and
error stay with the run.

What the node does: see PVE.md, "Boot test". It restores as a restore task does (the PVE API
into the pool `restow-restore`, `start=0`; a VM with what PVE restores only for root@pam through
`qmrestore` as root) and uses `qm`/`pct` as root for everything else (`config`, `set`, `start`,
`status --verbose`, `guest cmd ... ping`, `exec`, `unlock`, `stop`, `destroy`, and `lxc-info`
for a container's PID 1), so the node's API token
needs no new privilege.

### Task `restore`

`params`: `{volname, kind: "vm"|"ct", targetVmid?, targetStorage, pool?, start, restoreTest}`.
A restore into a new guest, or with `restoreTest` a restore check: the guest is restored into
the pool `restow-restore` and removed again. The result carries `vmid` and `upid` (the PVE
restore task), and:

| Field | Meaning |
| --- | --- |
| `warnings` | the restore task ended `WARNINGS: n` (since 0.5.0): it ran to its end and warned beside it; the warning lines of its log (at most ten). The task is `done`; the server shows "Restored with warnings" (amber). Any other exit status but `OK` fails the task. |
| `skippedLxc` | the raw `lxc.*` lines of the container's backup (GPU or TUN passthrough, a custom idmap). PVE restores them only for root@pam and skips them for the node's token ("skipping custom lxc options, restore manually as root"); add them as root. `customIdmap: true` when an `lxc.idmap` is among them: the restored container uses the default map, so its files belong to the ids of that map. |
| `omittedMounts` | the bind and device mount points the restore left out, as configuration lines (`mp0: /mnt/paperless,mp=/data`; before 0.5.0 a check only, as `mp0 (/mnt/paperless)`). Every container restore names rootfs and its volume mount points itself, so PVE takes none from the backup. |
| `remountCommands` | a restore into a new guest: the commands that put the left-out mount points back as root (`pct set <vmid> -mp0 /mnt/paperless,mp=/data`). A bind mount point put back shares the original's live data; on another node the host path may not exist. |
| `madeUnprivileged` | the container was privileged and is restored unprivileged. |
| `restoredAsRoot` | a VM with PCI or USB passthrough, a device mapping, virtiofs, host serial or parallel ports, raw `args` or a hook script, which PVE restores only for root@pam: restored with `qmrestore ... --unique 1 --pool restow-restore` as root (since 0.5.0; `upid` is root's task). |
| `started`, `startError`, `startSkipped`, `startSkippedMessage` | a restore into a new guest with `start` (since 0.5.0): PVE is never asked for `start=1`; the node starts the copy as root after the restore and waits until it runs. `started: true`; or `started: false` with `startError` (the restore still succeeded); or `started: false` with `startSkipped` = `omitted_mounts`, `host_devices` or `static_ip` (a static IP in the configuration, a container's `ip=`/`ip6=` or a VM's cloud-init `ipconfigN`, while the original runs or its state is unknown; an address set inside the guest is not seen) and an English `startSkippedMessage`. |
| `keptDevices` | a restore into a new guest restored as root: the keys that bind the copy to host devices of the original (`hostpci0`, `usb0`, ...). The copy is not started by the restore. |
| `onbootCleared` | the container started with its node; the copy does not (`onboot=0`). |
| `disks`, `deleted`, `leftoverVmid` | a check: the disks of the restored guest, and whether it was removed. `deleted: true` only once its configuration is gone (since 0.5.0); `deleted: false` with `leftoverVmid` when it is still there (the node removes it when its service starts; the server shows it amber). The check's guest is removed on every way out, also when the restore failed. |

A boot test's result carries `warnings` and `skippedLxc` the same way; a restore with warnings
goes on to the boot and is never red for the warnings alone.

### A server restart during a backup or restore

The calls of a running backup (`incremental`, the base `hashes`, `blocks`, `commit`,
`finish`) keep trying for five minutes while the server is unreachable (a network
failure, or 502, 503 or 504 from the proxy in front of it), 15 to 30 seconds apart,
after their usual five attempts: an update of Restow restarts the api and applies its
migrations meanwhile (since 0.4.0; before, about 30 seconds in all). An answer of the
server itself ends them as before. Since 0.5.0 the calls of a restore do the same: the
lookup of the restore point (`GET /restore-points`), a VM disk's block reads
(`GET /snapshots/:id/disks/:device/blocks`, which a VM restore and a VM boot test make for
hours) and a container's restic credential (`POST /snapshots/:id/restic`). A block read that
still fails fails only the reads waiting for it; the restore server fetches those blocks again
(three attempts in all) and goes on serving.

A backup run whose `finish` never arrived is closed by the server once a heartbeat of
its node (from the last 15 minutes) no longer lists it in `activeRuns` and the run is
older than that heartbeat by ten minutes: succeeded when its restore point was
committed, else failed. A node before 0.4.0 sends no list; its runs close after 48
hours as before.

### Task results

A backup task's result carries `result.upid` and, since 0.4.2, `result.exitStatus`
(vzdump's) and `result.warnings`. vzdump ending with `WARNINGS: n` finished the
backup and warned about something beside it: the node reports the task `done` with
the warning lines of the task log (at most ten). The server decides by the run:
committed, it succeeded and keeps the warnings (`stats.warnings`, "Succeeded with
warnings"); without a restore point it failed. A node before 0.4.2 reported such a
task `failed` with `vzdump ended with "WARNINGS: ..."`; the server takes that the
same way.

Results are idempotent and may come late. The server answers 204 for every task of
the node, also one closed meanwhile (the run's `finish` closes its task, the worker
closes a run its node no longer lists, a task expires), and settles what the late
result can still say: an open run ends as the task says; a committed run that was
closed as failed succeeds when the task is reported `done` (the old message becomes
a warning); warnings are added once. A committed restore point is never failed by
a task: a task that fails or expires leaves its committed runs succeeded, and a task
whose run is still open does not expire. 404 only for a task the node never had.

A backup or restore task waits for its PVE task (vzdump, qmrestore, vzrestore) through
`GET /nodes/{node}/tasks/{upid}/status`. Since 0.5.0 a PVE API that does not answer (no
connection, a timeout, 5xx including pveproxy's 595 and 596: pveproxy restarts during an upgrade
of pve-manager or a certificate renewal) is asked again with a growing pause (up to 30 seconds)
for up to ten minutes of failures in a row; then the task fails with "the PVE API did not answer
for 10 min; task <upid> may still run". An answer of PVE itself (401, 403, 404, another 4xx)
ends the wait at once. Before, the first failed call failed the task, and the server closed the
healthy backup's run.

When restow-pve stops while a PVE task of its own runs (`systemctl restart restow-pve`, the
installer, a self-update, a reboot), it reports no result: the stop says nothing about the task.
The node keeps the task it waits for (`{taskId, kind, params, upid, vmid, startedAt}`, for a
restore also the target VMID and what the restore left out) in
`/var/lib/restow-pve/inflight.json` from the moment PVE started it, and waits for it again when
the service starts; the result then says how the task really ended. A task that had not started
its PVE task yet is delivered again by the server (after 30 minutes, as any delivered task
without a result). A restore restow-pve runs as root (`qmrestore`, see `restoredAsRoot`) is a
child of the service and ends with it (PVE then ends its task "interrupted by signal"); the wait
after the restart reports that, and a restore test's guest is removed as after any failed
restore. Every `qm` and `pct` call has a deadline (60 seconds for `config`, `set`,
`status`, `guest cmd`, `exec`; five minutes for `start`, `stop`, `destroy`, `unlock`), and a boot
test's start and boot together at most twice its wait plus five minutes.

The node (since 0.4.2) keeps a result the server could not take (unreachable, 5xx)
in `/var/lib/restow-pve/pending-results.json` (at most 100) and sends the kept ones
again before every heartbeat, oldest first; a refusal (4xx) ends the attempts. A
task the server delivers again while its result is kept is not run a second time.

### Progress and compatibility

A node reports progress only when the server asked for it: `progressIntervalSeconds`
in the answer of `POST /runs` (VMs) and `progressUrl` in the run's restic
credential (containers). A server before 0.4.0 sends neither, so a newer node
never calls a route the server does not know; a node before 0.4.0 does not
report, and its runs show no progress. Reports are best effort: one attempt
with a short timeout, failures are ignored, and the first 404 or 409 stops
them for the run. A VM reports the bytes read of its disks (the changed
blocks only when the bitmap is reused) and the bytes uploaded; a container
forwards restic's `status` lines (`bytes_done`, `total_bytes`).

## The end of a container restore (0.5.0)

`POST /snapshots/:id/restic` names the run a container restore reads for (`runId`). A
restore started in the PVE UI has no task whose result would end that run, and the provider
is gone before PVE's restore task ends, so the node reports it with
`POST /runs/:id/restore-end`:

- `restore-container-init` keeps `{runId, volname, upid, workerPid, at}` in `run.json` of its
  restore folder (beside `owner`, outside the archive directory). The UPID is the PVE task of
  the worker that restores, read from its process title (`task UPID:...`, the provider's
  parent or an ancestor of it); without one nothing is kept.
- `restore-container-cleanup`, and the sweep of a folder whose worker is gone, turn it into
  `/var/lib/restow-pve/restore-ends/<run id>.json` before they remove the folder.
- After every heartbeat the service reads PVE's status of each recorded task. Once it has
  stopped it sends `{status, exitStatus, warnings?, error?}`: `succeeded` for `OK`, `warnings`
  for `WARNINGS: n` (with the warning lines of the task log), `failed` for anything else (with
  the end of the log), and drops the record; a refusal (4xx) drops it as well, a server that
  does not answer gets it again after the next heartbeat. A record of a task PVE does not know
  and one older than 48 hours are dropped unreported.

A run that belongs to a task (a restore, a restore check or a boot test) is ended by the
task's result; its `restore-end` changes nothing. A server before 0.5.0 sends no `runId`, and
nothing is recorded.

## Cancel orders (0.4.2)

A backup stopped in the web app reaches the node with its heartbeat; restow-pve 0.4.2
heartbeats every 15 seconds while a task runs or waits (every minute otherwise).

- `cancel.tasks`: delivered tasks with a cancel request. A task still in the node's queue
  is dropped and reported as `failed` (`/tasks/:id/result`); the server records it as
  `cancelled`. A task in the same answer's `tasks` never enters the queue and is reported
  so as well (0.5.0). The running one: its vzdump task is stopped (`DELETE
  /nodes/{node}/tasks/{upid}` of the local PVE API). Since 0.5.0 a running restore or
  restore check has its restore task stopped the same way; a restore task of root@pam (a VM
  the node restored as root) is stopped as root (`pvesh delete /nodes/{node}/tasks/{upid}`),
  since the node's token may not stop another user's task. The task then ends `failed`
  with "cancelled in Restow: ..." and a check still removes its guest. A queued backup or
  restore whose PVE task already runs (one the node waits for again after a restart, 0.5.0)
  stays queued: when the node takes it up it stops that PVE task and reports how it ended.
- `cancel.runs`: running backup runs with a cancel request. With `taskId` it is the
  node's running task (as above). Without (a backup started in PVE, also a vzdump task
  of several guests, whose task id is empty): the node sends SIGTERM to the provider
  process of that VMID. A VM's provider (root) records its pid in
  `/run/restow-pve/providers/<vmid>.pid`, checked against `/proc/<pid>/cmdline`. A
  container's provider runs as the mapped container root, which cannot write there:
  `backup-container-prepare` (root) creates `/run/restow-pve/run-<id>/provider-<vmid>.pid`
  in the run folder it hands to that uid, and the record counts only for a
  `restow-pve provider backup-container` process that holds the guest's pointer file
  (`/run/restow-pve/ct-<storeid>-<vmid>.json`, root's) open, so a record written by
  another container's provider (the same uid) never stops the wrong backup. Else it
  stops an active vzdump task whose id is the VMID only when the node's own token
  started it (another user's task needs `Sys.Modify` on the node, which the role does
  not hold). Each order is acted on once.
- The server refuses `POST /runs` for a task with a cancel request and every call of a
  cancelled run (`incremental`, `blocks`, `commit`, `restic`, the restic repository
  route) with 409, so an older node ends the backup at its next call.
- `finish` with `failed` (and `/tasks/:id/result` with `failed`) after a cancel request
  ends the run and the task as `cancelled`; a run that committed its restore point
  before still ends `succeeded`.

