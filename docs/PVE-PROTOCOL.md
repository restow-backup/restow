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
| `restow-pve serve-restore --volname V --device D --socket S` | The NBD restore server of one disk (started by the provider). |
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
| `restore-vm-volume-init` | `volname`, `device` | `{qemuImgPath}`: `nbd+unix:///<device>?socket=<path>` |
| `restore-vm-volume-cleanup` / `restore-vm-cleanup` | `volname`, `device` | `{}` |
| `restore-container-init` | `volname` | `{archiveDirectory}` |
| `restore-container-cleanup` | `volname` | `{}` |
| `storage-status` | | `{total, used, avail, active}` (cache only, never the network) |
| `list-volumes` | `vmid?` | `{volumes: [{volname, vmid, ctime, size, subtype, format}]}` (cache only) |
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
| `POST /heartbeat` | node facts → `{tasks, storageId, usage, update, cancel, queuePaused}`; since 0.4.0 the facts carry `activeRuns`, the run ids of the backups open on the node (never null). While an update pauses new job starts, or the node's queue is paused (`queuePaused`, 0.4.2), the answer holds no backup task. Nodes with boot tests also send `capabilities` (below). Since 0.4.2: `update` is `{version, now}` (`now`: install it once idle, "Update now" or the fleet phase of an update), and `cancel` is `{tasks: [taskId], runs: [{id, vmid, taskId}]}`, what was stopped in the web app (see "Cancel orders"). |
| `POST /inventory` | `{guests: [...]}` of this node |
| `POST /tasks/:id/result` | `{status: done\|failed, error, result}` |
| `GET /listing` | restore points of the cluster for the plugin |
| `GET /update` | `{version}` of a newer signed release or `""` |
| `POST /runs` | open a backup run → `{runId, guestId, origin, progressIntervalSeconds}` (the last since 0.4.0) |
| `POST /runs/:id/incremental` | `{devices: [{device, size}]}` → per disk `mode`, `baseSnapshotId`, `hashesDigest` |
| `PUT /runs/:id/blocks` | one frame of up to 16 blocks (`RSBF`, octet-stream) |
| `POST /runs/:id/commit` | `{commitId, devices?, guestConfig, firewallConfig, resticSnapshotId?, resticUnreadable?, resticUnreadablePaths?, consistency?, ...}` → `{snapshotId, alreadyCommitted, hashesDigests}` |
| `POST /runs/:id/finish`, `POST /runs/:id/log` | end of the run, PVE task log |
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
| `green` | `agent_answered`, `init_running` | the VM's QEMU guest agent answered `qm guest cmd <id> ping`; a container's `pct exec <id> -- cat /proc/1/comm` answered |
| `yellow` | `no_guest_agent`, `init_unknown` | the guest started and kept running for `timeoutSeconds`, nothing inside answered |
| `red` | `restore_failed`, `start_failed`, `guest_stopped` | the restore, the start or the boot failed |
| `skipped` | `memory_limit`, `node_memory`, `storage_space`, `storage_content`, `no_storage`, `backup_running`, `boot_test_running`, `restores_off`, `boot_tests_off` | the node did not run it; `message` says why |

`status: "failed"` means the node could not carry the test out at all (its PVE API failed,
the temporary guest could not be isolated); the server records the outcome `error`. Green,
yellow and red become the restore point's boot test (`pve_snapshots.boot_test`); skipped and
error stay with the run.

What the node does: see PVE.md, "Boot test". It uses the PVE API for the restore (the same
call as a restore task, into the pool `restow-restore`, `start=0`) and `qm`/`pct` as root for
everything else (`config`, `set`, `start`, `status`, `guest cmd ... ping`, `exec`, `stop`,
`destroy`), so the node's API token needs no new privilege.

### A server restart during a backup

The calls of a running backup (`incremental`, the base `hashes`, `blocks`, `commit`,
`finish`) keep trying for five minutes while the server is unreachable (a network
failure, or 502, 503 or 504 from the proxy in front of it), 15 to 30 seconds apart,
after their usual five attempts: an update of Restow restarts the api and applies its
migrations meanwhile (since 0.4.0; before, about 30 seconds in all). An answer of the
server itself ends them as before.

A backup run whose `finish` never arrived is closed by the server once a heartbeat of
its node (from the last 15 minutes) no longer lists it in `activeRuns` and the run is
older than that heartbeat by ten minutes: succeeded when its restore point was
committed, else failed. A node before 0.4.0 sends no list; its runs close after 48
hours as before.

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

## Cancel orders (0.4.2)

A backup stopped in the web app reaches the node with its heartbeat; restow-pve 0.4.2
heartbeats every 15 seconds while a task runs or waits (every minute otherwise).

- `cancel.tasks`: delivered backup tasks with a cancel request. A task still in the
  node's queue is dropped and reported as `failed` (`/tasks/:id/result`); the server
  records it as `cancelled`. The running one: its vzdump task is stopped
  (`DELETE /nodes/{node}/tasks/{upid}` of the local PVE API).
- `cancel.runs`: running backup runs with a cancel request. With `taskId` it is the
  node's running task (as above). Without (a backup started in PVE): the node sends
  SIGTERM to the provider process of that VMID (`/run/restow-pve/providers/<vmid>.pid`,
  checked against `/proc/<pid>/cmdline`), else it stops an active vzdump task whose id
  is the VMID. Each order is acted on once.
- The server refuses `POST /runs` for a task with a cancel request and every call of a
  cancelled run (`incremental`, `blocks`, `commit`, `restic`, the restic repository
  route) with 409, so an older node ends the backup at its next call.
- `finish` with `failed` (and `/tasks/:id/result` with `failed`) after a cancel request
  ends the run and the task as `cancelled`; a run that committed its restore point
  before still ends `succeeded`.

