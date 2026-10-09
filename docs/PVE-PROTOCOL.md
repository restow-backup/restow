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
| `restow-pve config` | `--allow-restores=true\|false`, `--fleecing-storage`, `--pve-cert-sha256`, `--restore-tmp`. |
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
| `POST /heartbeat` | node facts → `{tasks, storageId, usage, update}` |
| `POST /inventory` | `{guests: [...]}` of this node |
| `POST /tasks/:id/result` | `{status: done\|failed, error, result}` |
| `GET /listing` | restore points of the cluster for the plugin |
| `GET /update` | `{version}` of a newer signed release or `""` |
| `POST /runs` | open a backup run → `{runId, guestId, origin}` |
| `POST /runs/:id/incremental` | `{devices: [{device, size}]}` → per disk `mode`, `baseSnapshotId`, `hashesDigest` |
| `PUT /runs/:id/blocks` | one frame of up to 16 blocks (`RSBF`, octet-stream) |
| `POST /runs/:id/commit` | `{commitId, devices?, guestConfig, firewallConfig, resticSnapshotId?, ...}` → `{snapshotId, alreadyCommitted, hashesDigests}` |
| `POST /runs/:id/finish`, `POST /runs/:id/log` | end of the run, PVE task log |
| `POST /runs/:id/restic` | per-run restic credential of a container backup |
| `GET /restore-points?volname=` | a restore point by its PVE volume name |
| `GET /snapshots/:id/disks/:device/hashes` | block hash list (`RSBH`) |
| `GET /snapshots/:id/disks/:device/blocks?from=&count=` | up to 16 blocks of the synthetic full |
| `POST /snapshots/:id/restic` | read credential for a container restore |

`/agent/pve/restic/:guestId/*` is the restic REST v2 backend of a container's
repository, Basic `runId:token`, append-only.
