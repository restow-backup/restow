# Proxmox VE: VMs and containers

Restow backs up virtual machines and LXC containers of Proxmox VE (PVE) 8.4 or
newer through PVE's own backup provider interface. PVE 9.x is the primary
target; 8.4 works on a best-effort basis. The design and its evidence are in
[PROXMOX.md](PROXMOX.md); this page describes what is implemented (release
0.3.0, phase 1) and how to run it. The test run on a real node is in
[PVE-HOST-TEST.md](PVE-HOST-TEST.md), the helper's protocol in
[PVE-PROTOCOL.md](PVE-PROTOCOL.md).

## How it fits together

```
PVE node                                                 Restow instance
  vzdump / qmrestore / pct restore (PVE)                   /agent/pve/v1/*        restow-pve API
    PVE::Storage::Custom::RestowPlugin   (Perl shim) ---->  /agent/pve/restic/*   container repositories
    PVE::BackupProvider::Plugin::Restow  (Perl shim)        /api/v1/pve/*         web app
      exec restow-pve provider <verb>  (JSON stdin/stdout)  /install/pve.sh       node installer
  restow-pve run  (systemd: heartbeat, tasks, inventory)    worker: jobs, retention, verify
  local PVE API (127.0.0.1:8006, API token on the node)     chunk store (VM disks), restic (CTs)
```

- **Outbound only.** The node calls Restow; Restow never calls PVE. Restow queues
  tasks (back up, restore); `restow-pve` runs them through the local PVE API with
  an API token that stays on the node.
- **VMs** go through the `nbd` mechanism: PVE exports a point-in-time snapshot of
  every disk plus the dirty bitmap. `restow-pve` reads only the dirty 4 MiB blocks
  (all blocks on the first backup and after the bitmap was lost), skips zero
  blocks and blocks whose SHA-256 did not change, uploads the rest and discards
  every handled block in the export (so the fleecing image stays small). The
  server checks each block's SHA-256, chunks, encrypts and packs it with the
  tenant key and keeps a block map per disk. Every restore point holds the full
  map of every disk (a synthetic full): any restore point can be restored or
  removed on its own.
- **Containers** go through the `directory` mechanism: `restow-pve` runs restic
  over the directory PVE prepares, into one restic repository per guest
  (`pve-guests/<guest id>/` in the tenant's primary storage target). The node
  gets a credential per run that expires with the run and only adds data.
  The `lost+found` at the root of the container and of each mount point is left
  out (on ext4 it belongs to the host's root, which an unprivileged container's
  ID map does not include). When restic cannot read some files (exit code 3),
  the restore point is kept; the run records how many there were and the
  first of them. VMs & containers then shows "Last backup incomplete" instead
  of "succeeded", the restore point carries "N items not readable", and the
  run "Succeeded with gaps". The PVE task log of the whole job names the
  missing items; PVE's per-guest log (the one notifications show) may not.
- **Restore** creates a new guest with a new VMID in the pool `restow-restore`
  through PVE's own restore. For a VM, `restow-pve` serves each disk to
  `qemu-img convert` over NBD; for a container it unpacks the restic snapshot
  into a temporary folder that PVE copies into the new root file system. The
  original guest is never touched.

## Components and licenses

| Part | Where | License |
| --- | --- | --- |
| `restow-pve` (Go, standard library only) | `agent/cmd/restow-pve`, `agent/internal/pve`, `agent/internal/nbd` | Apache-2.0 |
| Storage plugin shim (Perl) | `integrations/pve/plugin` | AGPL-3.0-or-later, a separate work |
| Server side, worker, web app | `apps/api/src/features/pve`, `apps/worker/src/pve`, `apps/web/src/features/pve`, `packages/core/src/pve`, `packages/db/src/schema/pve.ts` | Apache-2.0 |
| Node installer | `agent/install/pve.sh` | Apache-2.0 |

The shim derives from `PVE::Storage::Plugin` and `PVE::BackupProvider::Plugin::Base`,
which are AGPL-3+, so it is a separate work under AGPL-3.0-or-later with its own
`LICENSE`. It only receives PVE's calls and runs `restow-pve provider <verb>` with
JSON on stdin and stdout; it holds no Restow logic.
`scripts/ci/check-separate-works.mjs` (part of `pnpm lint` and CI) keeps it so:
SPDX headers and license text present, no core code inside, referenced only
where `scripts/ci/license-policy.json` (`separateWorks`) allows, copied
nowhere. Its tests: `prove integrations/pve/plugin/t/`.
Its `api()` answers PVE's storage API version (`APIVER`) for every version it
was checked against (11 of PVE 8.4 up to 16, see the comment in
`RestowPlugin.pm`), so PVE 9.x does not warn about "an older storage API" on
every `pveum` or `pvesm` call; a newer PVE gets 16, which it accepts (with
that warning) while its `APIAGE` still covers 16.

## Requirements

- PVE 8.4 or newer on x86_64 (`pveversion`), with QEMU reporting
  `backup-access-api` (a VM started before the QEMU upgrade needs one restart).
- A **thin** storage on every node for fleecing images (`local-lvm`,
  `local-zfs`, Ceph RBD, Btrfs): PVE backs up VMs through a provider only with
  fleecing.
- The node reaches the Restow instance over HTTPS (port 443).

## Onboarding

In Restow: **Servers & clients > VMs & containers > Connect Proxmox VE >
Create command**. Restow shows one command for one node, with that node's
one-time enrollment token (24 hours, single use) in it. Run it as root on the
node:

```sh
curl -fsSL 'https://<instance>/install/pve.sh' | RESTOW_ENROLL_TOKEN='rset_…' sh
```

The token goes to the installer through its environment, not its arguments
(it may land in root's shell history; it is useless once the node enrolled).
**Command for another node** in the same dialog creates the next command; every
node needs its own. Connect the nodes one after another.

Nothing to type. The installer, before it downloads anything:

1. checks the enrollment token with Restow (`POST /agent/pve/v1/enroll/preflight`)
   and stops at once if it was used, revoked or has expired;
2. sets up the PVE side, cluster-wide and idempotent (existing objects are
   fine, a second run repairs): the user `restow@pve`, the pool
   `restow-restore`, the roles `RestowBackup`
   (`VM.Audit, VM.Backup, Datastore.Audit, Datastore.AllocateSpace, Sys.Audit`
   on `/`) and `RestowRestore` (`VM.Allocate` and the `VM.Config.*` privileges
   a restore needs, on `/pool/restow-restore`; `Datastore.AllocateSpace` on
   `/storage`; `SDN.Use` on `/sdn`). Existing roles get exactly these
   privileges again (`pveum role modify`), the ACLs are applied again;
3. creates the node's own API token `restow@pve!<node name>` with privilege
   separation off. A token of that name from an earlier install is removed
   and created again: PVE shows a secret only once. The secret stays on the
   node;
4. checks the token's privileges (`pveum user token permissions`) and stops
   with the token id and the missing privileges if one is missing;
5. picks the fleecing storage: the node's only active thin storage with
   content `images` (`lvmthin`, `zfspool`, `rbd`, `btrfs`), else `local-lvm`,
   else `local-zfs`, else the first thin one, and says which;
   `--fleecing-storage=<storage>` (after `sh -s --`) overrides it. Without a
   thin storage it stops.

Then it checks the maintainer's signature over the release and every file,
installs `/opt/restow-pve/bin/{restow-pve,restic}`, the shim
(`/usr/share/perl5/PVE/Storage/Custom/RestowPlugin.pm`,
`/usr/share/perl5/PVE/BackupProvider/Plugin/Restow.pm`, license in
`/opt/restow-pve/RestowPlugin.LICENSE.txt`), enrolls the node (restow-pve
checks the token against the local PVE API once more), adds the storage
`restow` to the cluster once (content `backup`, limited to the nodes with the
plugin), starts `restow-pve.service` and restarts `pvedaemon`, `pveproxy`,
`pvestatd` and `pvescheduler`. Running it again on an enrolled node upgrades
or repairs it and keeps the enrollment.

**An existing PVE API token instead** (optional, for rules that require a
token you created yourself): open **Use an existing PVE API token instead** in
the dialog and enter the token id (`user@realm!name`; Restow expects
`restow@pve` but accepts another user) and its secret. The token needs
privilege separation off and the roles above. The installer then skips steps 2
and 3, still checks the privileges, and checks the secret against the local
PVE API. See Security for how Restow keeps that token.

**Unattended** (scripts, configuration management): `RESTOW_ENROLL_TOKEN` or
`RESTOW_TOKEN_FILE` for the enrollment token; `RESTOW_PVE_TOKEN_ID` with
`RESTOW_PVE_TOKEN_SECRET_FILE` for an existing PVE API token set on the node
itself; `--fleecing-storage=<storage>`. Without an enrollment token and on a
terminal the installer asks for it (hidden input).

**Manual reference.** What step 2 and 3 do, as commands (as root on any node;
`<node>` is the node name):

```sh
pveum user add restow@pve --comment "Restow backup"
pveum pool add restow-restore --comment "Guests restored by Restow"
pveum role add RestowBackup --privs "VM.Audit,VM.Backup,Datastore.Audit,Datastore.AllocateSpace,Sys.Audit"
pveum role add RestowRestore --privs "VM.Allocate,VM.Config.Disk,VM.Config.CDROM,VM.Config.CPU,VM.Config.Memory,VM.Config.Network,VM.Config.HWType,VM.Config.Options,VM.Config.Cloudinit,Datastore.AllocateSpace,SDN.Use"
pveum acl modify / --users restow@pve --roles RestowBackup
pveum acl modify /pool/restow-restore --users restow@pve --roles RestowRestore
pveum acl modify /storage --users restow@pve --roles RestowRestore
pveum acl modify /sdn --users restow@pve --roles RestowRestore
pveum user token add restow@pve <node> --privsep 0
```

The guests appear within a minute. **Nothing is backed up before a guest is in a
backup job** (the same rule as for machines).

A cluster belongs to one tenant in this release (the cluster CA fingerprint is
unique per installation).

## Jobs, backups, retention

- **Backup jobs** for VMs and containers live on the same page: a daily time,
  all guests (that are in no other job) or the selected ones, the mode
  (`snapshot`, else `suspend` or `stop`), retention (default 7 daily, 4 weekly,
  6 monthly restore points) and the optional monthly restore check. The worker
  turns a due job into one backup task per guest for the node that hosts it;
  the node starts `vzdump` with the Restow storage and its fleecing storage.
- **Backups started in PVE** (the PVE UI or a PVE backup job onto the Restow
  storage) work the same way and show up as runs started in PVE.
- **Incremental or not.** A VM's dirty bitmap lives in QEMU's memory. After a
  VM stop and start, a `stop` mode backup, a disk resize or move, or a backup of
  a powered-off VM (PVE starts it paused), the whole disk is read again; only
  changed blocks are uploaded all the same. Every 30th backup of a disk is a
  full read on purpose (verify read). The guest list shows "Incremental" or
  "Full read".
- **Retention** runs on the server only. PVE's "remove" and prune are refused
  by the plugin. Pruning a restore point releases exactly the chunk references
  it holds; the storage check's garbage collection reclaims the chunks later.
- **Restore check.** Weekly, the server reads a sample of the data blocks of
  every guest's newest restore point back and compares them with the SHA-256 in
  the map (containers: `restic check` of 5 %). A job can also restore one guest
  a month into `restow-restore`, check it and delete it again.
- **Boot test** (off by default): weekly, or after every backup, the guest's
  node boots the newest restore point in isolation and destroys it again; see
  "Boot test" below.

## In the overviews

Guests count everywhere the mailboxes and the machines do, by one rule
(`apps/api/src/features/pve/protection.ts`, `packages/core/src/pve/protection.ts`):

- **Protected** only while present on its node, no VM template, and in an
  enabled PVE job (its own, or the job for all guests while it has none). A
  guest in no enabled job is counted as "in no backup job"; one that left its
  job keeps the rating of its restore points, and keeps the tenant from green.
- **Readiness** is the restore check and the boot test of the newest restore
  point (`pveRestorePointRating`, packages/core/src/pve/boot-test.ts): red when
  either failed; by a boot test green only when the restored guest's QEMU guest
  agent answered (a container: its init runs), yellow when the VM only started;
  without a boot test the read-back decides (green when the sample matched);
  unverified until a check ran, no backup without a restore point. The readiness
  row says which check decided.
- **Failed**: the newest finished backup run of a protected guest failed.
- **Overdue** (`backup.overdue`, the last-backup card, the provider view): no
  successful backup for longer than the enabled PVE jobs' schedules allow.

So the Status tab, Recovery readiness (a row per guest), GET /status
(`guests`), the provider view (`guests`, `guestsWithoutJob`, `guestsFailed`,
alerts `guest_backup_failed` and `guests_without_job`), the warnings page (failed
guest backups apart, with a link to the guests) and the statistics (readiness
series and backup outcomes) all agree. "Nothing protected" is said only when a
tenant has no object, no machine and no guest.

### Sizes

Three numbers describe a guest and its backups, and they mean different things:

- **Disk** (VMs & containers): the disk size configured in PVE. What is
  allocated, not what is in use.
- **In the backup / Contains**: everything a restore point restores. For a
  container that is all files restic read (restic's `total_bytes_processed`,
  also what PVE's task log reports as "Size"); for a VM the size of its disks.
  Every restore point is complete on its own, so this is about the same for
  each point of a guest.
- **New**: what a run added to the repository after deduplication: restic's
  `data_added` for a container, the uploaded blocks for a VM. The first backup
  stores (nearly) everything, later ones only what changed.

VMs & containers and the inventory show the newest restore point ("9.4 GB in
the backup, +2.5 MB new in the last run") and, on hover, the first backup and
what a follow-up backup adds on average. The average covers the newest 10 kept
restore points after the first backup that recorded what they added; with no
such point there is no average. A guest's page states the same average above
its restore points and lists every restore point as first backup, incremental,
or (VM) full read, with what it contains and what it added.

A machine's (endpoint agent's) restore points use the same words: what the
point contains (restic's `total_bytes_processed`) and what it added (`data_added`,
as the agent reported it for the run, else restic's own snapshot summary from
restic 0.17 on). Points without either figure show neither.

## Restore

From the guest's page: **Restore as a new guest**, with the target storage,
optionally another node of the cluster, a VMID (else the next free one) and
whether to start it. The restore lands in the pool `restow-restore`; move the
guest out of the pool once you accept it. Restores started from the PVE UI
(storage `restow` > Backups > Restore) work through the same plugin, with the
admin's own PVE permissions.

### Files of a container

**Servers & clients › File restore** lists every container with a restore
point in its own group, *Proxmox VE containers*, next to the machines: whether
a job backed it up or someone did by hand, from Restow or from PVE. Choose a
container, then a restore point on the timeline, and browse its folders; tick
files and folders and download them as one ZIP. The guest's page links there
from every container restore point (*Browse files*).

- **Paths are the container's own.** The node backs a container up with
  sources relative to the folder vzdump mounts it in, so `/opt/paperless/...`
  in the browser is `/opt/paperless/...` in the container, never the
  temporary folder of the backup. The top of the browser says what the
  restore point contains: the whole container (`/`) and every volume mount
  point vzdump includes (`backup=1`; bind and device mounts are not in a
  vzdump backup).
- **On the server.** The API reads the container's restic repository
  (`pve-guests/<guest id>/`) itself, with the guest's repository password from
  the secret store; the password never reaches the browser. The ZIP is
  streamed from `restic dump` without being held in memory or on disk.
- **Who and what is recorded.** Tenant admins, restore operators
  (`tenant_restore`) and provider members from technician on, as for a
  machine's files. A restore operator reads the overview and a guest with its
  restore points (`GET /api/v1/pve`, `GET /api/v1/pve/guests/:id`), browses and
  downloads; everything else (jobs, backing up, verify and boot tests,
  restoring a guest as a whole, nodes and tokens) stays with the admins. Every
  folder page read and every download started is in the audit log
  (`pve.snapshot.browsed`, `pve.snapshot.downloaded`). A prepared download can
  be started once, within ten minutes, by the person who prepared it.
- **Beside the server's own work.** A read never runs beside retention (restic
  forget and prune) or the weekly check of the same repository; it waits two
  seconds and then answers "busy, try again". A running backup does not block
  it.
- **Files are downloaded, not put back.** Restoring single files into the
  running container is not part of this release; restore the whole container
  as a new guest for that, or copy the files from the ZIP.

### Files of a VM

The file restore page lists the VMs with a restore point in a group of their own,
*Proxmox VE VMs*, and the guest's page links there (*Browse files*). The same timeline,
folder list and ZIP download as for a container; the same routes, roles and audit actions
(`pve.snapshot.browsed`, `pve.snapshot.downloaded`, with `kind: "vm"`).

- **What the top shows.** One folder per readable file system of the VM's disks, named
  after where it lies: `scsi0` (a disk without a partition table), `scsi0-p2` (partition 2
  of scsi0, GPT or MBR with logical partitions), `vg0-root` (logical volume `root` of the
  LVM volume group `vg0`, assembled from the VM's disks). The EFI variables and TPM state
  disks are left out. What cannot be read is named with the reason (btrfs, swap, BitLocker,
  a thin or RAID logical volume, no known file system).
- **Readable:** ext2, ext3, ext4 (extents and block maps, hashed folders, small inline
  files; the jbd2 journal is replayed in memory, so committed transactions of a running VM
  are there), XFS (v4 and v5), NTFS (fragmented files, large folders, long names), FAT12/16/32
  (the EFI partition). Not readable: btrfs, ZFS, ReFS, LVM thin, RAID, striped, cache and
  snapshot volumes, BitLocker and LUKS, NTFS-compressed and EFS files, deduplicated files and
  other reparse points (listed, never followed), symbolic links (listed, not followed). A file
  that cannot be read does not break a download: it is named with the reason in
  `_not-restored.txt` inside the ZIP.
- **How it is read.** On the Restow server, never on the PVE node and never by mounting.
  The API reads the restore point's disks from their block maps in the tenant's chunk store
  (each 4 MiB block proven against its SHA-256, 16 blocks cached per request) and hands the
  bytes to a reader in a throwaway child process (`packages/core/src/pve/guestfs`): user-space
  parsers of the partition tables, LVM, ext, XFS, NTFS and FAT, written for this. One child per
  folder page or download; it is killed afterwards.
- **Consistency.** A restore point is crash-consistent unless PVE froze the guest's file
  systems through the QEMU guest agent (then it is consistent). ext journals are replayed in
  memory; the XFS log and NTFS's `$LogFile` are not, so a crash-consistent XFS or NTFS restore
  point can lack the last seconds of writes, or show a damaged folder that a mount (with log
  replay) would have repaired. Restore the whole VM for that.

#### Threat model of the VM file restore

A guest's file systems are attacker-controlled input: whoever controls a VM can write any
byte to its disks, and the backup carries those bytes into Restow. File system drivers are a
known attack surface (kernel CVEs from crafted ext4, XFS, NTFS and btrfs images are
frequent), which is why this design never lets guest data reach a kernel driver:

| Threat | Mitigation |
| --- | --- |
| A crafted file system exploits a kernel driver (privilege escalation on the Restow host or the PVE node) | Nothing is mounted anywhere, neither on the node (`qemu-nbd`/loop) nor in a container (a container shares the host kernel, so mounting there would not isolate a driver bug). All parsing is in user space, in JavaScript (memory-safe: no buffer overflow, every read bounds-checked). |
| A crafted structure makes the reader loop, recurse or allocate without end (denial of service of the API) | The reader runs in its own process with a 256 MiB heap; each operation has a 60 s deadline; a folder page may read at most 2 GiB of the disks; folders, extents, runs, attribute lists, LVM text, path depth and ZIP entries have fixed limits; loops in cluster chains and partition chains are detected. A child that exceeds a limit is killed; the request answers with an error. |
| A bug in V8 or Node lets crafted data run code in the reader | The child runs under Node's permission model: it may read only its own code (`--allow-fs-read` of its folder), may not start processes or workers, cannot build code from strings, and has an empty environment: no database address, no secret, no tenant key, no storage credential. It receives disk bytes only by asking its parent, which serves reads only within the restore point's disks. Network access is not blocked by Node 22's permission model; with no credential, the child could at most reach services that need none (see the residual risks). |
| Path tricks in names (`..`, `\`, drive letters, control characters) escape the ZIP when extracted | Every ZIP entry name goes through `safeEntryName` (the same as for machines and containers); `..` is refused as a path component. |
| A crafted restore point leaks another tenant's data | The disk reader is built from the restore point's own block maps with the tenant's keys, inside the tenant's transaction (Row Level Security); the child cannot name another disk. |
| Damaged or tampered backup data shows as a wrong file | Every block is checked against the SHA-256 in its map before the reader sees it; a mismatch is a read error. |

Residual risks, stated plainly: a V8/Node sandbox escape plus a network service reachable
from the API container that needs no credential; denial of service within the limits (a
browse can keep one CPU busy for up to 60 s per request; requests share the per-tenant gate of
the restic reads). A micro-VM per request (what Proxmox's own file restore does) would remove
the first; it needs KVM on the Restow server and is not part of this release.

**Without Restow:** `restow-restore` (packages/cli) writes a VM restore point's
disks as sparse raw images (`disks/<device>.raw`) from the storage target and
the master key alone. Container restore points are plain restic repositories.

## On the node

```
restow-pve status            local state and the last heartbeat (--json)
restow-pve diagnose          every check a backup needs, with the findings (--json)
restow-pve test              like diagnose, exit code 0 only when all is in order
restow-pve config --allow-restores=false    refuse restores the server asks for (node's own decision)
restow-pve config --pve-cert-sha256 <sha>   pin a custom pveproxy certificate
restow-pve config --boot-tests=false        do not run boot tests (the node stops announcing them)
restow-pve config --boot-test-storage <id>  storage for the temporary guests (default: the fleecing storage)
restow-pve config --boot-test-bridge <br>   connect the NICs of boot tests to this isolated bridge
                                            instead of link_down=1 ('-' clears it)
restow-pve update            install a newer release the instance offers
restow-pve uninstall --yes   remove helper, plugin and credentials (backups stay in Restow)
```

Files: `/etc/restow-pve/state.json` (node secret and API token, root 0600, local
disk), `/var/lib/restow-pve` (block hash caches, journal, the caches the plugin
reads; `boottest/current.json` names the temporary guest of a running boot test),
`/run/restow-pve` (per-job state, `boottest.lock`), `journalctl -u restow-pve`.

## Boot test

The counterpart of a SureBackup: proof that a restore point boots, not only that its
bytes are intact. Off by default; a backup job turns it on (*Boot test*: weekly on the
newest restore point, or after every backup) with a memory limit (default 8 GiB) and the wait
for the guest agent (default five minutes). *Boot test now* on a restore point asks for one by
hand. Only nodes whose `restow-pve` announces the capability get one (PVE-PROTOCOL.md,
"Capabilities"); the guest's page says when its node cannot.

What the guest's node does:

1. **One at a time, never beside a backup.** A lock file allows one boot test per node; the
   server plans at most one per node, and holds it back while the node reports a running
   backup. The node checks again: a Restow backup or restore in progress, or any running
   `vzdump` task of PVE, skips the test ("A backup runs on this node").
2. **Resources first.** The guest's memory (from the restore point's configuration) must not
   exceed the job's limit, the node must have that much available plus 1 GiB (`MemAvailable`),
   and the boot test storage must hold the restore point's data plus a tenth and 1 GiB. The
   storage is the node's own choice (`--boot-test-storage`), by default its fleecing storage: a
   thin, local storage every node with backups has. Otherwise the test is skipped with the
   reason, which the guest's page shows.
3. **Restore** through the normal restore path (the PVE API, a new VMID from the cluster, the
   pool `restow-restore`, no start; the original guest is never touched). A failing restore is
   red.
4. **Isolate before the start.** The temporary guest gets the tag `restow-boottest` and the
   name `restow-boottest-<vmid>`; every NIC `link_down=1` (or the isolated bridge the node
   names with `--boot-test-bridge`; a container loses its interfaces); PCI and USB passthrough,
   host serial and parallel ports, virtiofs, a container's device and bind mounts and the hook
   script are removed; ISO drives are emptied; `onboot 0`, `protection 0`; the QEMU guest agent
   device is switched on so an installed agent can answer. The configuration is read back; a
   guest with a NIC still connected is never started.
5. **Boot and wait.** `qm start`, then every five seconds `qm guest cmd <id> ping`: green as
   soon as the agent answers (proof the operating system came up). A VM that stops on its own
   is red; one that keeps running without an answer until the wait is over is yellow
   ("started, no answer": install the QEMU guest agent for proof). A container is green once
   `pct exec <id> -- cat /proc/1/comm` shows its init.
6. **Destroy in every case** (`qm stop`, `qm destroy --purge --destroy-unreferenced-disks`).
   A marker file under `/var/lib/restow-pve/boottest` records the temporary guest with the
   UPID of its restore task before it exists; when the service starts, and before every boot
   test, a leftover is destroyed: the marker's guest (only when the UPID proves this node
   restored it), and every guest of this node in `restow-restore` that carries both the tag
   and the name.

The result (outcome, reason, boot time, duration, the node's log of the test) is kept with the
run and, when it rates (green, yellow, red), with the restore point. A red boot test raises
`boot_test.failed`, a yellow one `boot_test.unproven` (notification catalog, group
recoverability). `qm` and `pct` run as root, as the service does; the node's API token needs
no new privilege.

Not part of the test: a check of ports or applications inside the isolated network, a
screenshot or serial console heuristic, Windows without the guest agent (yellow at best), and
guests that need passthrough hardware to boot (removed for the test, so they may fail it).

## Security

- **Default: the PVE API token never leaves the node.** The installer creates
  it on the node and keeps its secret in the node's state file; Restow never
  receives it. The token can create (and delete) guests only in
  `restow-restore` and never restores over an existing guest.
- **Optional: an existing PVE API token entered in Restow.** Then the token
  does pass through Restow, once: it is sealed with the tenant key in the
  secret store (AES-256-GCM, like storage credentials), bound to that one
  enrollment token, handed over only to the holder of the enrollment token
  (the installer's preflight, over HTTPS) and deleted as soon as the node
  enrolled with it; the worker deletes it when the enrollment token was
  revoked or expired (24 hours), whichever comes first. The audit log records
  the token id, never the secret. While it is stored, whoever controls the
  Restow server and its master key could read it.
- **The enrollment token** is single use, valid for 24 hours, stored only as
  its SHA-256, and goes to the installer through the environment, not its
  arguments. Failed attempts per address are limited.
- The node authenticates with its own secret (only its SHA-256 is stored).
  It may open runs only for guests of its own cluster, append to its own open
  runs, commit once, and read restore points of its own cluster; it cannot
  delete or change a restore point.
- The tenant key stays on the server: blocks are encrypted there (server-side
  ingest). A compromised node can read and add backups of its own cluster, not
  delete them.

## Known limits of this release

Not possible: backing up VM templates (PVE disables fleecing for them), live
restore (PVE refuses it for providers), restoring privileged containers (PVE
refuses it; restore by hand as unprivileged), restoring single files back into
a running guest (they are browsed and downloaded as a ZIP, see "Files of a
container" and "Files of a VM"), files of VMs on btrfs, ZFS, ReFS, LVM thin or
RAID volumes, BitLocker or LUKS, NTFS-compressed or EFS files (see "Files of a
VM"), log replay of XFS and NTFS for crash-consistent VM restore points, boot
tests on nodes before the release with boot tests and boot tests with
application checks or port checks (see "Boot test"), more than one tenant
per cluster, PVE on arm64. Jobs for VMs and containers are kept apart from the mail and machine
jobs (`pve_jobs`) in this release.
