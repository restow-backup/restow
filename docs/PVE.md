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
  The `lost+found` at the root of the container and of each mount point it
  backs up (a volume with `backup=1`, in every backup mode) is left out (on ext4
  it belongs to the host's root, which an unprivileged container's ID map does
  not include). In snapshot mode restic reads PVE's snapshot mount
  (`/mnt/vzsnap0`). In suspend and stop mode, PVE's fallback on storage without
  snapshots (dir, NFS, CIFS, thick LVM), it hands over a copy in a folder that
  is new on every run (`/var/tmp/vzdumptmp<pid>_<vmid>`); `restow-pve` mounts it
  onto `/run/restow-pve/ctroot-<vmid>` in a mount namespace only restic sees, so
  restic finds the last backup as its parent, and compares the copy's files by
  size and modification time (`--ignore-inode --ignore-ctime`). Where PVE's
  user namespace may not make a mount namespace, the task log says so and
  restic reads the whole copy every time, as before. restic keeps its cache per
  container in `/var/cache/restow-pve/ct-<vmid>` (owned by the uid the backup
  runs as), so a backup does not download the repository's index again; with
  less than 1 GB free there it runs without a cache.
  When restic cannot read some files (exit code 3),
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

- **Backup jobs** for VMs and containers live on the same page: the same
  cadences as a mail job (every few hours, daily, on chosen weekdays, monthly
  or a cron expression, in a time zone; not more often than hourly), all guests
  (that are in no other job) or the selected ones, the mode
  (`snapshot`, else `suspend` or `stop`), retention (default 7 daily, 4 weekly,
  6 monthly restore points) and the optional monthly restore check. The worker
  turns a due job into one backup task per guest for the node that hosts it;
  the node starts `vzdump` with the Restow storage and its fleecing storage.
- **Job settings** (`settings` of `POST /api/v1/pve/jobs` and
  `PATCH /api/v1/pve/jobs/:id`): `mode`, `retention` (`keepDaily`,
  `keepWeekly`, `keepMonthly`), `restoreTest` (`enabled`, `targetStorage`) and
  `bootTest` (`schedule`, `maxMemoryMiB`, `timeoutSeconds`). There is no upload
  limit for Proxmox VE backups yet, and the full read comes every 30th backup:
  `bandwidthKbps` and `verifyReadEvery` are refused with 422 ("not supported
  for Proxmox VE jobs yet"). Up to 0.4 they were taken and stored but never
  applied; a job that still holds them no longer shows them, and its next save
  drops them.
- **Backups started in PVE** (the PVE UI or a PVE backup job onto the Restow
  storage) work the same way and show up as runs started in PVE.
- **One vzdump at a time per node.** vzdump holds one lock per node for all its
  backups and waits for it up to `lockwait` (3 hours by default). A Restow
  backup that starts while a PVE backup job runs on the node waits for it; the
  node's log says "waiting for another backup on node ...", the run's log says
  from when it waited, and a lock timeout fails with a message that names the
  other job. Keep the schedules of Restow jobs and PVE backup jobs apart.
- **A guest that migrated** between two inventories is not backed up on its old
  node: vzdump starts nothing there, and the task fails with "guest 101 now
  runs on node pve2; Restow backs it up there after the next inventory" (the
  node sends its inventory at once).
- **Incremental or not.** A VM's dirty bitmap lives in QEMU's memory. After a
  VM stop and start, a `stop` mode backup, a disk resize or move, or a backup of
  a powered-off VM (PVE starts it paused), the whole disk is read again; only
  changed blocks are uploaded all the same. Every 30th backup of a disk is a
  full read on purpose (verify read). The guest list shows "Incremental" or
  "Full read".
- **Unusually large backups** (since 0.5.0): the server measures what a VM backup
  adds to the chunk store (new data after deduplication) before it stores each
  pack, and a container backup's uploads, against the guest's earlier runs. By
  default a run far above the usual goes on with a notice; with the size check
  set to "hold" it is held, and a run that would leave the storage target too
  little free space is always held: the node gets 403 `run-size-held`, vzdump
  fails, and the run ends "Held: this backup is unusually large". A VM's first
  backup, and one after its base restore points are gone or every disk was
  resized, starts a new chain and is never taken as unusually large; a full read
  after a lost dirty bitmap counts only what changed (docs/STORAGE.md,
  "Unusually large runs").
- **Retention** runs on the server only. Removing a restore point in PVE is
  refused by the plugin. PVE's prune (the Retention tab of a PVE backup job onto
  the Restow storage, `pvesm prune-backups`, the storage's Prune dialog) prunes
  nothing: the plugin lists no backups and logs "restow: retention is managed in
  Restow; PVE's retention settings are ignored", so such a job stays OK instead
  of failing each guest after its restore point was committed. Pruning a
  restore point releases exactly the chunk references it holds; the storage
  check's garbage collection reclaims the chunks later. Retention leaves a guest
  alone while a run of it is going (a backup, a restore, a check, a boot test)
  or its node took on a backup of it, and tries again in a later pass.
- **A container's repository** is compared with the guest's restore points
  (since 0.5.0): after a restore point was pruned, and at least once a day. The
  worker lists the restic snapshots (`restic snapshots`) and forgets, then
  prunes, every one no active restore point names: the snapshot of a pruned
  restore point, also one whose forget failed before (a lock, the storage, a
  restart: a later pass does it), and a snapshot no restore point names at all
  (a run that wrote it and never committed: a late cancel, a refused commit,
  vzdump failing after the archive step) once it is six hours old and its
  `run=` tag names no run still going. The restore points and the running runs
  are read in one statement, so a run that commits during the comparison is
  never taken for one that never committed. A snapshot the storage still locks
  stays. Forget and prune wait up to two minutes for another run's lock
  (`--retry-lock`), each within its time limit; on a storage that refuses to
  delete a stale lock (write-once) the comparison forgets and prunes nothing,
  and on a primary whose last test found it write-once (docs/STORAGE.md,
  "Write-once storage") retention is not applied at all: no restore point of a
  VM or container is pruned (each stays restorable; its data stays anyway), no
  comparison runs, and the guest page and the job's retention settings say so,
  nor while the repository has a problem (not complete on the primary, split
  across targets, a failed repair: see "Repository problems"). A
  comparison that did not get through is repeated an hour later, at most ten a
  pass beside the ones a prune asked for. One guest whose retention fails is
  logged and the others go on. A restore point
  pruned while the comparison runs keeps it due, so the next pass (every five
  minutes) forgets that point's snapshot as well.
- **Restore check.** The server reads a sample of the data blocks of a restore
  point back and compares them with the SHA-256 in the map (containers: `restic
  check` of 5 %). It checks
  - every new restore point right after its backup: the commit marks it
    (`pve_snapshots.verify_requested_at`, due two minutes after the commit, when
    the node's restic has let go of the repository) and the worker's next PVE
    pass (every five minutes) reads it, at most 20 asked-for checks per pass,
    oldest request first. The installation setting "Check every new restore point right after
    the backup" (Installation → Proxmox VE, owner; `GET/PUT
    /api/v1/settings/pve`, `verifyAfterBackup`) is on by default; switched off,
    a new restore point waits for the weekly check. There is no per-tenant
    override in this release;
  - every guest's newest restore point at least weekly (at most 10 per pass);
  - a restore point an admin asks for: "Check now" on a restore point of the
    guest page checks exactly that one, also an older one; in Recovery
    readiness "Check now" of a guest checks its newest restore point, and
    "Check all unverified" the newest of every guest no check has read and none
    waits for.

  A guest is not checked while a run of it is going (a backup, a restore, a
  boot test) or while its node has taken on a backup of it that has not started
  yet (asked again right before each check); the check waits for a later pass.
  A container check first removes stale lock files from the storage, as
  retention does before `forget`/`prune` (retention then also runs `restic
  unlock`; a check needs none). A lock counts as stale only when both the time
  the storage received it and the time restic wrote into it are more than 30
  minutes old (since 0.5.0), so a storage whose clock lags never has a live lock
  taken away; a lock whose own time could not be read at that moment stays for
  the next pass, and goes unread only once the storage received it more than a
  day ago; when the two differ by more than 30 minutes the worker logs a warning
  about the storage's clock. On a write-once share (a storage that refuses
  deletes) no lock file can ever be removed: the check still runs, the log says
  so once per check, `restic unlock` is not run, and retention leaves
  `forget`/`prune` out for that container. The check then makes sure the
  restore point's restic snapshot is in the repository and carries the tag of
  the restore point's run (a missing or foreign snapshot fails the check, since
  `restic check` alone passes without it; a snapshot list the storage or the
  network did not deliver this time postpones it, while a restic that cannot be
  started or a damaged repository fails it with restic's words), and runs
  `restic check --no-lock`: nothing else writes meanwhile (the server's own
  repository lock and no run of the guest going), so it never waits for a lock
  and leaves none behind. Every restic run of the pass has a time limit (unlock
  2 minutes, the snapshot list and reading a lock's time 10, check 60, forget
  15, prune 60), a pass starts no new check after 20 minutes, and the checks run
  last in the pass, so they never hold up the planning of backups, restore tests
  and boot tests. A restore test or boot test is not planned for a guest whose
  check is due and can run: its run would keep the guest busy from the moment it
  is planned, so it is planned on the next pass, after the check. A check that
  was stopped before it finished (also by its time limit), that could not start
  (its repository password, the tenant's keys or storage), or that an older server's lock
  kept out did not run: nothing is recorded as checked or failed, the previous
  result stands, and it is tried again ten minutes later ("Check postponed" on
  the guest page). After two hours since it was asked for, the restore point
  reads **Could not check**: yellow (attention) in Recovery readiness, never red
  and never green, with what restic or the server said (for a lock: who holds
  it, PID, host, user, when it was created); the weekly clock tries the guest
  again after a day, the next backup's check and "Check now" or "Check all
  unverified" sooner. The postponement lives in `pve_snapshots.verify`
  (`notChecked`: reason `locked`, `interrupted` or `error`, since, attempts, the
  words, `gaveUpAt` once the worker gave up). A check that has been due for more
  than 30 minutes without running reads **Check overdue** in Recovery readiness
  instead of "Check queued", naming the run of the guest still recorded as
  running when one without a sign of life for two hours (no progress report,
  not listed by its node) holds it back. Waiting behind a run that is going (a
  long backup, a boot test) is not overdue: "Check queued" then names that run
  on hover. A restore, restore check or boot test run whose task is over, or a
  restore without a task that cannot read (it never got its restic credential,
  or it belonged to a boot test that has ended), is ended by the worker ten
  minutes on, so it does not keep the guest busy: the same way as every run
  whose result never came (failed, cancelled when it was stopped in the UI, a
  boot test with the outcome `error`; never succeeded), with "The node never
  reported the end of this run; ...". A restore with a credential is not ended
  early: the credential lives as long as its open run, so it may still be
  reading; it ends with its report or after the 48 hours below.

  A red check shows what it found (the restic or read error stored in
  `pve_snapshots.verify`, with the lines of restic's output that explain it)
  under the badge in the guest list, in Recovery readiness and on the guest
  page, the whole text in the tooltip. The footer
  of Recovery readiness names the Microsoft 365 schedule as such and says how
  the guests are checked in a line of its own.

  A job can also restore one guest a month into `restow-restore`, check it and
  delete it again. The worker picks, per job and pass, the guest whose check
  waits longest among those its node can run now: restores allowed on the node,
  the node seen within the last ten minutes, no restore or boot test of the
  guest waiting, no run of it going. A guest passed over is not counted as
  checked; its page says why ("Restore check not possible: restores are
  switched off on node pve2", "Restore check waits: node pve2 has not reported
  lately"). The node looks at the job's target storage before it restores; when
  the storage is missing, inactive, holds no guests of this kind (`images` for a
  VM, `rootdir` for a container: a VM-only NFS storage cannot take a container)
  or lacks the space, it skips the check with the reason. The run then reads
  "Not checked: ..." (grey, neither red nor green: it says nothing about the
  restore point), and the guest is tried again after a day; after further skips
  for the same reason in a row after 2 and 4 days, then every 7 days, until the
  check runs or the reason changes. A job over VMs and
  containers needs a target storage that takes both.
  Such a restore check is green only when the restore ran to
  `OK`, the temporary guest is gone again and nothing was left out. It is amber
  (succeeded, but no full proof) when the run says what it could not cover:
  "Checked without 1 mount point" (a bind or device mount point, whose data is
  not in a PVE backup), "Checked with warnings" (the restore ended `WARNINGS: n`,
  raw `lxc.*` options PVE skipped for the node's token), or "Temporary guest 105
  could not be removed" (restow-pve removes it when its service starts next).
  The run on the guest's page and in its panel lists each line. A failed check
  is red.
- **Warnings of vzdump.** restow-pve asks vzdump for no notes (from 0.4.2), and
  the storage plugin takes a notes update (a PVE backup job with a notes
  template) as a no-op that it logs, instead of an error: such backups used to
  end with "TASK WARNINGS: 1". A backup vzdump ends with warnings while its
  restore point was committed succeeded: the run keeps the warning lines and
  the guest shows "Succeeded with warnings" (amber, not failed, not green).
  Protection of a restore point is still refused in PVE (Restow holds them).
- **Freeze of a VM.** Each VM restore point says whether PVE froze the guest's
  file systems for it (`vmConsistency`, from vzdump's log; restow-pve 0.5.0 and
  newer, an older node records nothing and the list shows nothing): "File
  systems frozen", "Guest stopped", "Crash-consistent" (no agent enabled, or
  the freeze switched off), "Guest agent did not answer" and "Freeze failed"
  (both amber), or "Consistency unknown". None of them is green: a freeze says
  nothing about whether the point restores. A failed freeze, and a thaw that
  failed or was never logged, are warnings of the run, which then shows
  "Succeeded with warnings". The commit records the state; the task log, sent
  after it, completes a state the commit could not read (`unknown`) and adds
  its warnings, but never replaces a recorded state.
- **Notifications of vzdump.** From PVE 8.1 on, vzdump sends a notification
  after every backup (also a successful one) through PVE's notification system,
  which mails root@pam by default. Restow reports every outcome itself, so on
  PVE 8.1 and newer restow-pve starts vzdump with
  `notification-mode=legacy-sendmail` and no `mailto`: PVE sends nothing for a
  backup Restow started. A `mailto` in `/etc/vzdump.conf` still gets its mail
  (the admin's own choice). Backups started in PVE (a PVE backup job, the PVE
  UI) notify as that job says. Should a PVE version refuse the parameter,
  restow-pve starts the backup again without it (the backup does not fail for
  it) and PVE notifies as before; please report that version. To silence
  successful backups on such a version, let the matcher that mails root@pam
  (by default `default-matcher` in `/etc/pve/notifications.cfg`, Datacenter >
  Notifications) leave them out:

  ```
  matcher: default-matcher
          mode all
          match-field exact:type=vzdump
          match-severity info
          invert-match 1
          target mail-to-root
  ```

  This drops the mails of every successful backup on the cluster, also those of
  PVE backup jobs; failed backups are still mailed.
- **Boot test** (off by default): weekly, or after every backup, the guest's
  node boots the newest restore point in isolation and destroys it again; see
  "Boot test" below.
- **Where backups land.** The guest page, its "Back up now" dialog, the job
  dialog and the connect dialog name the tenant's effective primary repository
  (docs/STORAGE.md, "Where backups land"); the installation default on the
  server's local disk is highlighted, and a warning says when backups land on
  the server's own disk.

### Repository problems

`repository_ready_at` only says a container's repository was created once.
Before a backup run gets its restic credential, the run is pinned to the
tenant's primary (docs/STORAGE.md, "Runs and storage changes"), and the server
makes sure the repository is complete there: its `config` and at least one key
(`pve-guests/<guest id>/`, once per run; `features/pve/repository.ts`):

- **There:** the backup runs as always.
- **Not there:** every target of the tenant (copies, retired targets, an old
  location attached read-only) and the installation default (also when it is
  no target of the tenant any more) are searched, and the backup is refused,
  without creating anything, with a problem of its own:
  - `pve-repository-elsewhere`: complete on another target (a retired primary
    after "keep existing backups where they are", the installation default
    after a promotion of 0.4.1). The way out: the repository repair or a
    storage "move" brings it over;
  - `pve-repository-split`: data on the primary without its `config` or keys,
    or parts of it on another target. A backup that ran while the primary
    changed wrote to two targets (the 2026-10-16 field incident). The way out:
    the repository repair, which rebuilds it on the primary where its parts
    allow;
  - `pve-repository-missing`: on no target, while restore points still refer
    to it. The way out: attach an old location that may still hold it and run
    the repository repair, or reset the repository;
  - `pve-repository-repair-failed`: the repository repair could not rebuild
    it (a file could not be copied and verified, or restic found the result not
    sound). Refused even when `config` and a key are on the primary, and not
    cleared by a backup: they may sit next to data that is not whole. The way
    out: attach the missing parts and repair again, or reset the repository.

  The guest records the problem (`pve_guests.repository_problem`) and its page
  explains it with both ways out, until a backup finds the repository again.
  The server's own retention and check of the container search the same
  places (the installation default included, also when it is no target of the
  tenant any more) and refuse with the same problem instead of restic's
  "unable to open config file"; a problem the API recorded that says where the
  repository lies is not replaced by a vaguer one. They also refuse while the
  snapshot of an active restore point lies on another target but not on the
  primary: a prune there would remove data that restore point needs. No
  monthly restore test of the container is planned while the guest records a
  problem (it would read from the first target that holds a config, or from a
  split half); it is planned again once the problem is cleared.
  While a repository repair of the tenant is queued or running, a backup gets
  `409 storage-repair-running` instead of a credential. The
  storage not answering is not "missing": the backup fails with
  `pve-repository-unreachable` instead. Restores of the container read from
  whichever target holds the repository.
- **Nowhere, and no restore point refers to it** (all pruned, or after a
  reset): a new repository is created (a new password, `restic init`, the
  sealed password file next to it) and a **new backup chain** begins. Nothing
  is lost by it. The guest records the chain
  (`pve_guests.repository_chains`, the newest ten) and the audit log
  `pve.repository.reinitialized`.

From 0.4.2 to 0.4.12 the server did not ask: a repository it did not find on
the primary started a new chain at once, and every restore point of the
container became `unavailable`, also when the repository was intact on the
installation default a promotion had dropped. Such chains show in the audit log
as `pve.repository.reinitialized` with `reason: "missing"`. The repository
repair does not bring those restore points back: the primary holds the new
chain, complete, and the old one is no part of it. They stay unavailable; the
old chain can only be restored by hand with restic from the place that still
holds it (attach it read-only so that it is not removed while only it has it;
docs/STORAGE.md, "Repository repair").

A repository is created only on an empty prefix: data left there without a
`config` is refused with `pve-repository-split` (before 0.5.0 `restic init`
failed on it with "repository already contains snapshots" and the node got an
HTTP 500, "get the restic credential of this run"). The repository password is
stored only once `restic init` succeeded, so a failed attempt leaves no secret
behind.

Unavailable restore points can no longer be restored, browsed or checked,
readiness and the overviews no longer count them, and retention leaves them
alone. They say why (`pve_snapshots.unavailable_reason`): a new chain or a
reset (`chain`), or a repository repair that found their data on no target
(`lost`; the guest page says "Repository lost" when the whole repository could
not be opened and a new chain begins, "Repository repaired" when it was rebuilt
and only some restore points' snapshots were missing from it).

**Reset repository** (guest page, danger zone, containers only): for a damaged
repository or one that lies on a target that is gone. It needs the guest's
name typed and a recent sign-in, and is audited (`pve.repository.reset`). Every
restore point of the container becomes unavailable at once; the next backup
moves what is left of the old repository on the primary aside to
`pve-guests/<id>.orphaned-<time>/` (never deleted: it may be half of a split
repository that is still wanted; only an empty repository, `config` and keys
without any data, is removed) and begins a new chain. A retired target is never
touched.

On **write-once storage** (docs/STORAGE.md, "Write-once storage": a target that
takes new files but refuses to delete, overwrite or rename existing ones) the
old repository can be neither moved aside nor removed. When the primary's last
test found it write-once, or when the storage refuses the move or the removal
(EPERM, EACCES, EROFS, S3 AccessDenied, Object Lock), nothing there is touched:
the new chain begins under a fresh prefix next to it,
`pve-guests/<id>.chain-<n>/` (the first `n` from 2 whose folder holds nothing),
and the guest records it (`pve_guests.repository_prefix`; its newest chain
names `prefix` and `previousPrefix`, and the guest page says where the old
chain stays). Audited as `pve.repository.fresh_prefix` with the reason (the
refusal's code, or `write_once`). This is the way out for a container whose
repository on such a share holds data without `config` or keys (refused with
`pve-repository-split` until it is reset): reset it, and its next backup gets a
whole new chain. Every reader opens the recorded prefix: the node's restic
route, the next backups, restores and browsing, the restore check, retention's
comparison, the repository repair's scan, the measurement of the repository's
size, a storage "move", the renewal of immutable backups and the check before
an old location is removed. The old chain stays where it was, readable with its
sealed password file (`restow-repository-password.json` next to it); its
restore points are unavailable, as after any reset.

## Stopping a backup

Since 0.4.2 a backup can be stopped from the web app, without SSH on the node.
Whoever may start a backup may stop one (tenant administrators; provider members
with the operate permission). Every stop asks first and is audited
(`pve.backup.cancelled`, `pve.queue.cancelled`, `pve.queue.paused`,
`pve.queue.resumed`); who asked is kept with the task and the run.

- **Stop** (VMs & containers table, the guest's page, the run drawer). A backup
  that waits for its node (`pending`) is withdrawn at once: the node never sees
  it, and History shows a run "Cancelled by <user>". One the node already got
  (`delivered`) or that runs gets a cancel request; the page shows
  "Cancelling…" until the node has stopped it.
- **How the node stops it.** restow-pve (0.4.2) keeps its heartbeat going while
  a task runs (every 15 seconds) and gets the cancel orders with it
  (`cancel.tasks`, `cancel.runs`). A backup Restow asked for: the node stops its
  vzdump task through the PVE API (`DELETE /nodes/{node}/tasks/{upid}`); vzdump
  ends the guest, removes its snapshot and the fleecing image. A backup started
  in PVE (a PVE backup job of one or several guests): the node ends the provider
  of that guest with SIGTERM, so vzdump goes on with the other guests. A VM's
  provider records itself in `/run/restow-pve/providers/<vmid>.pid`; a container's
  provider runs as the mapped container root and records itself in its run folder
  (`/run/restow-pve/run-<id>/provider-<vmid>.pid`, prepared by root), and counts
  only while it holds that guest's backup open. The node stops a vzdump task
  itself only when it is its own: stopping the task of a PVE backup job (root@pam)
  needs `Sys.Modify`, which the node's token does not hold. When no provider is
  found, the log says that the backup ends at its next upload, which the server
  refuses (below). A restore or restore check that runs (also one the node waits
  for again after a restart) has its restore task stopped: as the node's token,
  or as root (`pvesh`) for a VM restored as root; a check then removes its
  guest. A stopped
  provider asks restic to stop with SIGINT (killed after 15 seconds), so restic
  removes its lock from the container's repository.
- **Older nodes.** The server refuses every upload of a cancelled run (blocks,
  commit, restic), so a node before 0.4.2 ends the backup at its next call.
  The restic credential of a cancelled or ended run still opens the repository
  (config, keys, lock files) and deletes the lock files that run wrote, so
  restic releases its lock on the way out; every other request is refused and
  audited (`pve.node.denied`). Which lock files a run wrote is kept in the API
  process only: after an API restart (an update) a run's lock cannot be told
  apart from another's and stays until it is stale (30 minutes), when the next
  check or retention removes it with `restic unlock`.
- **The end.** The run ends `cancelled`, not `failed`: no failure alert, no
  "Last backup failed", the guest's last backup stays as it was, and the restore
  points are untouched (nothing of the stopped run is committed). A cancelled
  run whose node stays silent for 15 minutes is closed by the worker.
- **Pause queue** (per node, nodes table): no new backup is handed to the node
  until the queue is resumed; a running backup goes on. Scheduled backups wait
  (and expire after 12 hours as usual). "Paused by <user>" shows on the node.
- **Cancel all queued** per node (nodes table) or for the whole tenant (page
  header): withdraws every backup that has not started yet.
- **Start now / Stop a job** (0.4.5, Servers & clients → Jobs): "Start now" queues
  a backup of every guest the job covers, as its schedule would (the schedule does
  not move; guests with a waiting backup, on a node without restow-pve or the
  unconfirmed Restow server VM are skipped and counted). "Stop" withdraws the
  job's queued backups and asks its running ones to stop, as above. Both are
  audited on the job (`pve.job.run_requested`, `pve.job.cancelled`).

API: `POST /api/v1/pve/guests/:id/cancel`, `POST /api/v1/pve/nodes/:id/queue/pause`,
`.../queue/resume`, `.../queue/cancel`, `POST /api/v1/pve/queue/cancel`,
`POST /api/v1/pve/jobs/:id/run`, `POST /api/v1/pve/jobs/:id/cancel`.

## Updates of the node

restow-pve looks for a newer signed release by itself (two minutes after it
starts, then every six hours) and installs it only while nothing works on the
node: no task of the service runs or waits (a backup, a restore, a restore check,
a boot test), no `vzdump` task of PVE runs, and no backup or restore of PVE is
open. Only live work counts: an open backup (its job file in
`/run/restow-pve/jobs` with a running provider of that guest, or while a vzdump
task runs on the node, whose worker process PVE names `task UPID:...:vzdump:...`)
or a restore server that serves a VM disk (`/run/restow-pve/restore/<key>.pid`
naming a running `restow-pve serve-restore`). Logs, sockets and pid files a
finished or interrupted restore left behind do not count, nor does the job file
of a backup whose provider was killed or whose node crashed (it is deleted after
two days); boot tests use the same check.
From that check until the restart the service starts no task (a task handed out
meanwhile runs after the restart, or right away when the update fails). An offer
that waited for work is tried again after 15 minutes, not six hours.
Since 0.4.2 the server can also ask for it now:

- **Update now** on the node (nodes table, next to the version, when a newer
  release is offered): the heartbeat says `update.now`, and the node installs the
  release as soon as it is idle, then restarts. Audit `pve.node.update_requested`.
- **With the server update.** After the server runs a new release, every node
  behind it gets `update.now` while new job starts stay paused (see
  [UPDATING.md](UPDATING.md), "Nodes and agents"). During that pause the nodes
  are idle, so they update at once.
- **By hand**, for a node that was not reachable:
  `/opt/restow-pve/bin/restow-pve update` (as root). Proxmox VE itself (`apt`) is
  never updated by Restow.

After an update restow-pve restarts pvedaemon, pveproxy, pvestatd and
pvescheduler (the running ones, `systemctl reload-or-restart`, as the installer
does) so they load the new storage plugin; `restow-pve update` restarts the
restow-pve service too. A node that a release before 0.4.3 updated restarts the
daemons once by itself (it keeps the hash of the plugin files it restarted them
for in `/var/lib/restow-pve/plugin-loaded`). The inventory (`GET /api/v1/pve`)
reports per node `helperVersion`, `offeredVersion` and `outdated`.

## In the overviews

Guests count everywhere the mailboxes and the machines do, by one rule
(`apps/api/src/features/pve/protection.ts`, `packages/core/src/pve/protection.ts`):

- **Protected** only while present on its node, no VM template, and in an
  enabled PVE job (its own, or the job for all guests while it has none). A
  guest in no enabled job is counted as "in no backup job"; one that left its
  job keeps the rating of its restore points, and keeps the tenant from green.
- **Excluded** guests (see "Excluding a guest") count nowhere: not as
  protected, not in `total`, not as in no job, and they are not rated. The
  counts carry them as `excluded`.
- **Readiness** is the restore check and the boot test of the newest restore
  point (`pveRestorePointRating`, packages/core/src/pve/boot-test.ts): red when
  either failed; by a boot test green only when the restored guest's QEMU guest
  agent answered (a container: systemd reports the system running), yellow when
  the guest only started;
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

VMs & containers show a guest's backups on one line ("First: 32 GB on 3 Oct ·
Last: +210 MB"), the inventory in its row per guest: "First backup: 32 GB on
3 Oct", "Last follow-up: +210 MB" (or "No follow-up backup yet") and "Average
follow-up: +180 MB (last 7 backups)"; on hover the first backup's full time and
what the newest restore point contains. The first backup is the guest's first
ever (also when retention pruned it since), the last follow-up its newest kept
restore point after it (by `sequence`, which `GET /api/v1/pve` sends with
`backups.first` and `backups.last` from 0.5.0 on). All of it comes with the
overview, from one query per figure for all guests. The average covers the
newest 10 kept restore points after the first backup that recorded what they
added; with no such point there is no average. A guest's page states the same
average above its restore points and lists every restore point as first backup,
incremental, or (VM) full read, with what it contains and what it added.

**New data per backup** (a guest's page, above its restore points; a smaller
version in the detail panel of VMs & containers): a bar per backup for the
newest 30 restore points that recorded what they added, oldest left, coloured by
type (first backup, incremental, full read) from the categorical chart palette;
never green, a size proves nothing. A full backup more than four times the
largest follow-up would flatten the others, so the axis then follows the
follow-ups and the full backup is cut at its top; the chart names every bar it
cut with its real size. Screen readers get a sentence (how many backups, the
smallest and largest, the newest), and "Show as table" lists every bar with its
time, type and size. With fewer than two such points there is no chart.

A machine's (endpoint agent's) restore points use the same words: what the
point contains (restic's `total_bytes_processed`) and what it added (`data_added`,
as the agent reported it for the run, else restic's own snapshot summary from
restic 0.17 on). Points without either figure show neither. The machine's
Snapshots tab draws the same "New data per backup" chart over its newest 30
snapshots that carry `data_added` (untyped bars, a machine's restic repository
does not say which snapshot was its first), from the snapshot list the tab loads
anyway.

## Nodes without restow-pve

Every node of a cluster should run restow-pve: a backup of a guest runs on the
node the guest is on. restow-pve from 0.5.0 sends the cluster's whole guest
list (`/cluster/resources`: VMID, node, type) with its inventory. A guest that
moved (HA, a migration) to a node without restow-pve then stays in the list
with that node, reads **Node without restow-pve** (amber, a problem: no backup
can run there) and its page says "Runs on node X, which has no Restow helper";
it counts as unprotected once its backups are overdue, instead of silently
dropping out of every count. A guest is marked "No longer reported" only when
the cluster's list no longer names it. Without the list (an older restow-pve,
or one that could not read it) a node's inventory only speaks for its own
guests, as before: one it no longer lists reads absent.

## A VMID used again

PVE hands out the lowest free VMID (`/cluster/nextid`), which is often the one of a guest
deleted in PVE whose restore points, job and repository Restow still keeps. A copy restored
under it, or the temporary guest of a check or boot test, would take over that guest's
history at the next inventory. So (since 0.5.0) restores, restore checks and boot tests tell
the node to leave such VMIDs alone, a VMID typed into the restore dialog that belongs to such
a guest needs a confirmation, and a different guest that still turns up under it gets a row
of its own. Different means another kind, or, while the old one is absent: a temporary guest
by name or tag, a guest in `restow-restore`, a container with another name (hostname), or a
VM whose SMBIOS UUID and name both differ (a VM without a known UUID: its name). The old guest
stays in the list as "No longer reported", with its restore points.

A restore with "Unique" (`unique=1`, `qmrestore --unique`) gives a VM a new SMBIOS UUID and
new MAC addresses. Restored into the deleted VM's own VMID under its old name, it is the same
guest back: it keeps its row, restore points and job, and its next backup builds on them.
Under another name it is a guest of its own (rename it back before the next inventory to keep
the history). A container keeps its row when it comes back under its hostname.

## Restore

From the guest's page: **Restore as a new guest**, with the target storage,
optionally another node of the cluster, a VMID (else the next free one) and
whether to start it. The restore lands in the pool `restow-restore`; move the
guest out of the pool once you accept it. While it is in that pool and in no
job, a job for "all guests" does not back it up and it counts nowhere as
unprotected or without a job (the list shows "Restored, in restow-restore");
the same holds for a temporary guest of a restore check or boot test that is
still there (tagged `restow-boottest` or `restow-restorecheck`). Put into a job
by hand, it is backed up like any other guest. Restores started from the PVE UI
(storage `restow` > Backups > Restore) work through the same plugin, with the
admin's own PVE permissions.

**Start after restore** never asks PVE for `start=1` (PVE would start the guest in a task of
its own, whose failure the restore does not show, and the start needs `VM.PowerMgmt`). After a
successful restore the node starts the copy as root (`qm start` / `pct start`) and waits up to a
minute until it runs; the result says `started: true`, or `started: false` with the error
(`startError`), and the restore stays successful. The copy is not started, with the reason
(`startSkipped`), when the restore left mount points out (`omitted_mounts`), when it has the
original's host devices (`host_devices`), or when its configuration has a static IP and its
original runs in the cluster or its state cannot be read (`static_ip`): a container's `ip=` /
`ip6=` ("the original CT 113 runs with 192.168.1.20; change the IP, then start it"), a VM's
cloud-init `ipconfigN` with `ip=` / `ip6=` ("the original VM 114 runs with 10.0.0.5; change the
IP (cloud-init ipconfig), then start it"). An address set inside the guest (its own network
configuration, not cloud-init) cannot be seen from the node: such a copy is started, and its
address clashes with the running original's.

The restored guest gets new MAC addresses (PVE's `unique=1`, for VMs and containers); a
container does not start with its node (`onboot 0`, the result says so when the original did).
IP addresses stay the same, in the configuration (a container's `ip=`, a VM's `ipconfigN`) and
inside the guest: change them, or keep the copy off the network, before it runs beside the
original; the restore dialog says so.

A VM whose configuration holds what PVE restores only for root@pam is restored as root with
`qmrestore <storage>:backup/<volume> <vmid> --storage <target> --unique 1 --pool
restow-restore` (never `--force`, never `--start`): PCI passthrough (`hostpciN`, also a mapped
one: a mapping needs `Mapping.Use`, which the node's token does not hold), USB host and mapped
devices (`usbN`, not `spice`), `virtiofsN`, serial and parallel ports on host devices, raw
`args` and a hook script. The node's API token restores everything else; no role is widened. The
result says so (`restoredAsRoot`); a copy restored with host devices (`keptDevices`: they are the
original's, which may use them now) is never started by the restore: check them before you
start it. Restore tests and boot tests of such a VM take the same way; a boot test removes the
devices before the start.

A container is restored with its rootfs and its volume mount points named explicitly (the same
options, each a new volume on the target storage) and without its bind and device mount points
(`mp0: /mnt/paperless,mp=/data`, `mp1: /dev/sdb1,mp=...`): PVE restores those only for root@pam,
not for the node's API token, and their data lives on the host, not in the backup. restow-pve
does not restore such a container as root instead: the copy would get the original's bind
mounts and, once started, write into the original's live data. The result names the left-out
mount points (`omittedMounts`) with the commands to put them back as root
(`pct set <vmid> -mp0 /mnt/paperless,mp=/data`); a bind mount point put back shares the
original's live data, and on another node the host path may not exist. Such a copy is never
started by the restore. A volume without a size (`size=0`, a ZFS or directory subvolume
without a quota) is restored as such where the target storage has subvolumes (zfspool, dir,
btrfs); elsewhere it gets the size the restore point recorded, else the restore point's size
and a fifth; with nothing to size it the restore fails before it starts and names the storage
type. Restow does not restore a restore point of a privileged container (see "Known limits");
should a node be given one anyway, it restores it unprivileged (`madeUnprivileged` in the
result).

A container restore (also a restore check, a boot test and a restore from the PVE UI) unpacks
the restore point with `restic restore --sparse` into a folder of its own below the restore
folder, `/var/tmp/restow-pve` by default, from which PVE copies it into the new volumes; the
folder goes when the restore ends. That folder lies on the node's root file system unless
`restow-pve config --restore-tmp <folder on a data storage>` names another, and it needs the
whole container once. Before restic starts the node checks it: the restore point's size and a
tenth must fit, and 5% of the file system stay free; otherwise the restore fails at once with
"The temporary folder ... has X GB free, the restore needs about Y GB; set restow-pve config
--restore-tmp ...". An unknown size (a server before 0.5.0) or free space is not checked.
`restow-pve diagnose` shows the folder, its free space and whether it is on the root file
system. Every restore gets its own folder (`ct-<hash>-<random>`, the PVE worker that restores
recorded in it), so two restores of one restore point (a boot test beside a restore from the
PVE UI) never touch each other's tree; one whose worker is gone (a crash, a stopped task) is
removed by the next container restore. restic waits up to 15 minutes for the lock the server
holds while it checks or prunes the repository (typically right after a backup); after that the
restore says "the Restow server is checking or pruning this container's repository; try again
in a few minutes". A container restore counts as running work for the self-update and boot
tests.

A restore task that PVE ends with `WARNINGS: n` ran to its end and warned beside it: Restow
shows "Restored with warnings" (amber) with the warning lines, never a plain success and never
a failure. The usual cause is a container with raw `lxc.*` lines (GPU or Coral passthrough with
`lxc.cgroup2.devices.allow` and `lxc.mount.entry`, `/dev/net/tun` for Docker or Tailscale, a
custom `lxc.idmap`): PVE restores those only for root@pam and skips them for the node's API
token. The result names the skipped lines (`skippedLxc`); add them to the restored container as
root (`/etc/pve/lxc/<vmid>.conf`). With a custom `lxc.idmap` the restored container uses the
default map, so files owned by ids outside it cannot be unpacked; the failed restore says so.

A restore is green only when it ran to `OK` with nothing to report. It is amber
when it did, but left something to do, and the run on the guest's page lists
it with what to do:

- **Restored without N mount points**: the bind and device mount points left
  out (above). The run names the lines (`mp0: /mnt/paperless,mp=/data`) and the
  `pct set` commands that put them back as root.
- **Restored with warnings**: the restore task ended `WARNINGS: n` (its warning
  lines), PVE skipped raw `lxc.*` options for the node's token (add them as
  root; a custom `lxc.idmap` among them means the copy uses the default map),
  or the copy uses the same host devices (PCI, USB) as the original (check them
  before both run).
- **Restored, not started**: "Start after the restore" was asked for, but the
  copy did not start (the run says why: `startError` or `startSkipped`).

A copy restored unprivileged from a privileged container, and a container that
no longer starts with its node (`onboot=0`), say so in the run as well, without
turning it amber.

### Temporary guests of restore tests and boot tests

The monthly restore test of a backup job (`restoreTest`) and a boot test restore into the pool
`restow-restore` and remove the guest again. Both share one lifecycle on the node:

- **Marker before the restore.** `/var/lib/restow-pve/tempguests/<vmid>.json` records the
  VMID, the kind, the purpose, the start time, then the UPID of the restore task and the
  guest's creation time. It survives a crash or a reboot of the node.
- **Tag and name right after the restore.** A restore test's guest becomes
  `restow-restorecheck-<vmid of the original>` with the tag `restow-restorecheck`, `onboot 0`
  and `protection 0` (a container gets the name already with the restore); a boot test's guest
  `restow-boottest-<vmid>` with the tag `restow-boottest` (step 4 of the boot test).
- **Removal only with proof.** A guest is removed only when it is on this node and carries the
  tag and the name of a temporary guest in `restow-restore`, or its marker's restore task still
  runs for it, or it has the creation time (a container: the name) the marker recorded. A guest
  in the pool without that proof is never touched (real restores land there too; a VMID may
  have been given to another guest since): its marker is dropped and the log says why. When
  PVE cannot be asked (the node boots, pveproxy restarts, an API error), that proves nothing
  either way: the guest is not touched, its marker stays, and the service tries again.
- **Removal in every case.** Also after a failed restore, a restore with warnings, a wait that
  ended or a cancelled test: a restore task that still runs is stopped first (and waited for, at
  most two minutes), then `qm|pct unlock`, `set --protection 0`, `stop`, and `qm destroy --purge
  1 --destroy-unreferenced-disks 1 --skiplock 1` or `pct destroy --purge 1
  --destroy-unreferenced-disks 1 --force 1`, as root. The node's token stops its own restore
  tasks through the API; a restore task of root@pam (a VM restored as root with `qmrestore`)
  needs `Sys.Modify`, which the token does not hold, so the node stops it as root with `pvesh
  delete /nodes/<node>/tasks/<upid>`. While the task's state is unknown or it cannot be stopped,
  nothing is destroyed under it: the guest stays and is tried again. A removal counts only when
  the guest's configuration is gone afterwards: a restore test then reports `deleted: true`,
  else `deleted: false` with `leftoverVmid`, and the marker stays.
- **Tried again until gone.** Leftovers are removed when the service starts and before every
  boot test; one that could not be decided or removed then is tried again between tasks, after
  a minute and then less often (at most every 30 minutes), until it is gone.
- **Not in the inventory.** The node leaves these guests out of the inventory it sends: those
  tagged and named so, and those in `restow-restore` with the tag, the name or a marker of the
  node (a restore still running). They are no guests of a job, never count as unprotected and
  never take over the row of a deleted guest whose VMID they got. A real restore in
  `restow-restore` has none of them and is reported.
- **Leftovers** go when the service starts (also when boot tests or restores are switched off
  on the node since) and before every boot test: the guests of the markers, and every guest of
  this node in `restow-restore` with the tag and name of a temporary guest. A restore test the
  service waits for again after a restart (PVE-PROTOCOL.md, "Task results") keeps its guest
  until it ends.
- **A VMID taken meanwhile** (two restores that got the same VMID from `/cluster/nextid`) is
  asked for again, up to three times; the other guest is never touched. A restore PVE did not
  run (a VMID taken, a refused call, a mount point that could not be planned) makes a boot test
  end with an error, never red.

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
  replay) would have repaired. Restore the whole VM for that. Which case applies is read from
  vzdump's log of the backup and recorded with the restore point (`vmConsistency`):
  `frozen` (fs-freeze and thaw issued), `stopped` (the guest did not run), `no_agent` (the agent
  is configured but did not answer), `crash_consistent` (no agent enabled, or the freeze
  switched off in its options), `freeze_failed` (the freeze was issued and failed, for example
  a VSS writer error in Windows; a warning in the task log as well) or `unknown` (the log says
  nothing about it; never taken for either). A freeze whose thaw failed or was never logged is
  a warning: check that the guest can write.

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
the master key alone.

A container restore point is a restic snapshot in the guest's repository
(`pve-guests/<guest id>/` of the tenant's primary target), with the repository
password next to it in `restow-repository-password.json`, sealed with the
tenant key as for machines. `restow-restore endpoint-password` opens only the
passwords under `endpoints/` in this release, not those of containers. What the
snapshot holds and what it does not:

- **Files only.** The snapshot is the container's root file system and its
  volume mount points with `backup=1`, as the container sees them. Its `pct`
  configuration and its firewall configuration are not in the snapshot: they
  go to the Restow server with the commit and are kept there with the restore
  point (PVE's "Show configuration" reads them from there). Without the Restow
  server take them from `/etc/pve/lxc/<vmid>.conf` and
  `/etc/pve/firewall/<vmid>.fw` of the cluster, if the original still exists,
  or from your own copy of `/etc/pve`.
- **Container-view owners.** The files belong to the ids inside the container
  (root 0, a user 1000). A `restic restore` as root on the host writes exactly
  those ids. Copied into an unprivileged container as they are, every file
  would be owned by the host's root and read as nobody:nogroup inside. Let PVE
  map the ids instead: restore the snapshot as root into an empty folder, then
  hand it to `pct restore` as a tar stream on stdin (`-`), which PVE unpacks in
  the container's user namespace:

  ```sh
  restic -r <repository> --password-file <file> restore <snapshot id> --target /root/ct-restore
  tar -C /root/ct-restore --numeric-owner -cpf - . | \
    pct restore <new vmid> - --unprivileged 1 --rootfs <storage>:<GiB>
  ```

  Without the configuration in the archive PVE creates the container with
  defaults: set hostname, memory, cores and network afterwards (`pct set`),
  from the configuration above, and add every volume mount point again (its
  files are in the tar stream below the mount path, so give the rootfs room
  for them, or move them onto a new mount point afterwards). A privileged
  container takes `--unprivileged 0`: its ids are the host's. A container with
  a custom `lxc.idmap` is restored with the default map this way; add the
  `lxc.idmap` lines as root afterwards and change the owners of the files of
  the remapped ids to match before it starts.

## The Restow server's own VM

Backing up the VM that runs Restow with Restow itself can deadlock: the backup
freezes or snapshots the server that receives the backup, and restoring it needs
the very server being restored. Back that VM up with PVE's own vzdump to another
storage, and keep Restow's database dumps (docs/DATABASE.md).

- **Found by its SMBIOS UUID.** A VM's configuration carries `smbios1: uuid=...`,
  which the guest sees as `/sys/class/dmi/id/product_uuid`; the API (root in its
  container) reads its own, restow-pve (from 0.4.2) reports every VM's with the
  inventory, and a match marks the guest (`pve_guests.restow_server_detected`).
  `RESTOW_HOST_SMBIOS_UUID` in the api's environment overrides the file, for a
  host that hides `/sys`. Placeholder UUIDs (all zeros) never match.
- **Marked by hand.** Restow in a container (LXC), on another host, or behind a
  node before 0.4.2 is not found: an admin ticks "This is the Restow server" on
  the guest's page (`PUT /api/v1/pve/guests/:id/restow-server`, audited
  `pve.guest.restow_server`).
- **What it changes.** The guest shows "Restow server" in the lists and the job
  editor. A job plans no backup of it, the recommended job leaves it out, and
  "Back up now" and putting it into a job are refused (409
  `urn:restow:problem:pve-restow-server`) until an admin confirms the risk in the
  dialog (`confirmSelfBackup`; audited `pve.guest.self_backup_confirmed`). Taking
  the mark back takes the confirmation back.

## Excluding a guest

Many guests of a cluster are not meant to be backed up (test VMs, a guest backed
up elsewhere). Left in no job, each would count as "in no backup job" and keep
the tenant from green. From 0.4.7 an admin excludes such a guest on purpose:
"Exclude from backup" on the guest's page, or for a selection of guests in the
inventory (`PUT /api/v1/pve/guests/:id/excluded` with `{ "excluded": true }`,
audited `pve.guest.excluded`; `pve_guests.excluded_at` and `excluded_by`).

- **No job backs it up**, not even the job for all guests (`pveGuestCounted` in
  packages/core/src/pve/protection.ts, which every count and the worker's job
  plan read). Its own job stays recorded, so including it again restores what it
  had. Excluding withdraws its queued backups; a running one ends as it would. A
  backup queued in the same moment is withdrawn at the node's next heartbeat,
  before the node gets it.
- **"Back up now" and putting it into a job are refused** (409
  `urn:restow:problem:pve-guest-excluded`) until it is included again.
- **It counts nowhere as unprotected**: not in the overviews, the readiness, the
  warnings, `backup.overdue`, the statistics or the provider view. The guest
  list shows "Excluded" (its own state filter), never a problem.
- **Its restore points stay** and can be restored; retention keeps treating them
  as before.

## On the node

```
restow-pve status            local state and the last heartbeat (--json)
restow-pve diagnose          every check a backup needs, with the findings (--json)
restow-pve test              like diagnose, exit code 0 only when all is in order
restow-pve config --allow-restores=false    refuse restores the server asks for (node's own decision)
restow-pve config --pve-cert-sha256 <sha>   pin a custom pveproxy certificate
restow-pve config --restore-tmp <dir>       where container restores unpack (default /var/tmp/restow-pve,
                                            on the root file system; see "Restore")
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
`/run/restow-pve` (per-job state, `boottest.lock`), `/var/cache/restow-pve`
(the restic cache of each container, `ct-<vmid>`, kept between its backups and
removed when the container is no longer on the node), `journalctl -u restow-pve`.

## Boot test

Proof that a restore point boots, not only that its
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
   exceed the job's limit, the node must have that much available plus 1 GiB (`MemAvailable`,
   plus what the ZFS ARC holds above `zfs_arc_min` on a node with ZFS: it gives that back),
   and the boot test storage must hold what the restore allocates there plus a tenth and 1 GiB:
   on a thin storage (`lvmthin`, `rbd`, `btrfs`, a `zfspool` with `sparse 1`, a container's
   subvolumes on a `zfspool`, a file storage without `preallocation full` or `falloc`) the
   restore point's data, on a thick one (`lvm`, a `zfspool` without `sparse`, whose zvols get a
   refreservation of their full size, a preallocating or unknown storage) the full size of its
   disks (a container: rootfs and volume mount points). The options come from
   `/etc/pve/storage.cfg`, which the service reads as root. A restore that still runs out of
   space (`insufficient free space`, `out of space`, `No space left on device`) skips the test
   (`storage_space`) instead of making it red. The
   storage is the node's own choice (`--boot-test-storage`), by default its fleecing storage: a
   thin, local storage every node with backups has. A VM with raw QEMU `args` that do more than
   tune the CPU, SMBIOS or the clock (`-cpu`, `-smbios`, `-rtc`, `-overcommit`, `-msg`) is not
   booted (`custom_qemu_args`): such arguments can add a host disk, a host device or a network
   (`-drive file=/dev/...`, `-device vfio-pci`, `-netdev user`) that no other key shows, and the
   copy may need them to boot. With `--boot-test-bridge` the bridge must be a Linux bridge whose
   ports are only those of guests (`tap`, `veth`, `fwpr`); a network card, bond, VLAN or tunnel
   on it skips the test (`bridge_not_isolated`). Otherwise the test is skipped with the reason,
   which the guest's page shows.
3. **Restore** through the normal restore path (the PVE API, a new VMID from the cluster, the
   pool `restow-restore`, no start; the original guest is never touched). A failing restore is
   red; a restore that ends with warnings (`WARNINGS: n`, for example the skipped raw `lxc.*`
   lines of a container) goes on to the boot, and the result carries the warnings. A container
   is restored as every container restore is (see "Restore": rootfs and volume mount points
   named, bind and device mount points left out); the log names what was left out.
4. **Isolate before the start.** The temporary guest gets the tag `restow-boottest` and the
   name `restow-boottest-<vmid>`; every NIC `link_down=1` (or the isolated bridge the node
   names with `--boot-test-bridge`; a container loses its interfaces); PCI and USB passthrough,
   host serial and parallel ports, virtiofs, `ivshmem`, `audio0`, `rng0` (the host's random
   source), `hugepages`, `keephugepages` and the NUMA binding `numaN` (the running original holds
   those pages; the copy runs on normal memory), a container's device and bind mounts and the
   hook script are removed; ISO drives are emptied; `onboot 0`, `protection 0`; the QEMU guest
   agent device is switched on so an installed agent can answer. The configuration is read
   back; a guest with a NIC still connected, or with any of these keys (or a raw
   `lxc.net`, `lxc.mount.entry` or `lxc.hook` line) left, is never started. A restored disk on
   a host path (`scsi1: /dev/disk/by-id/...`) skips the test (`host_disk`): the copy would open
   the original's device.
5. **Boot and wait.** `qm start`, then every five seconds `qm guest cmd <id> ping`: green as
   soon as the agent answers (proof the operating system came up). `qm status --verbose` is
   read beside it: a VM that stops on its own, or whose QEMU status turns `guest-panicked` or
   `internal-error`, is red; `io-error` (its disks on the boot test storage, for example a full
   thin pool) skips the test. One that keeps running without an answer until the wait is over
   is yellow: when the test switched the agent on, "started, no answer" (install the QEMU guest
   agent for proof); when the guest has the agent enabled itself, "the agent did not answer
   within N s" (the guest probably did not finish booting); a paused VM is yellow too. A start
   that fails because the node cannot allocate the memory (hugepages, a memory backend) is
   skipped (`node_resources`), not red. A container's PID 1 is read from the host (`lxc-info -n
   <id> -p -H`, then `/proc/<pid>/comm` and `exe`; `pct exec -- cat /proc/1/comm` only as
   fallback, so OCI and minimal images need no `cat`). With systemd the node asks
   `systemctl is-system-running` until the wait is over: `running` is green; `degraded` is
   green when only units that need the network failed (`networking`, `ifup@*`,
   `ifupdown-wait-online`, `systemd-networkd-wait-online`, `NetworkManager-wait-online`; the
   test takes the network away), else yellow with the failed units; `maintenance` (emergency or
   rescue mode) is red; still starting at the end of the wait is yellow. Another init (OpenRC,
   an application) that keeps running is yellow: Restow cannot ask it whether the boot
   finished.
6. **Destroy in every case**, with proof that the guest is the test's own, and leftovers when
   the service starts and before every boot test: see "Temporary guests of restore tests and
   boot tests" above.

The result (outcome, reason, boot time, duration, the node's log of the test) is kept with the
run and, when it rates (green, yellow, red), with the restore point. A red boot test raises
`boot_test.failed`, a yellow one `boot_test.unproven` (notification catalog, group
recoverability).

A test skipped for a reason that passes (a backup or another boot test ran on the node, its
memory or the storage's space was short at that moment) and a test the node could not carry
out at all are tried again on a later pass: 30 minutes after the attempt, then 1, 2 and 4
hours, at most 6, five attempts per restore point (the next restore point starts anew). With
the weekly schedule the retries come within the week; the week's test comes as usual. A
reason that stays (the guest needs more memory than the job allows, the storage takes no
guests of its kind, restores or boot tests are off on the node) is not retried; the run on
the guest's page says why. When no boot test of a guest came to a result for longer than its
schedule allows (two days after every backup, eight days weekly), `boot_test.skipped`
(warning, group recoverability, "No boot test result") is raised once with the last reason,
but only once the newest restore point is no longer being tried (a reason that stays, or its
five attempts are used up) or the skips themselves have gone on that long: a first
`backup_running` of a new restore point whose retry is due in 30 minutes raises nothing, even
when the last result is old by the rhythm of the backups. It comes again only after a boot
test came to a result in between. `qm` and `pct` run as root, as the service does; the node's
API token needs no new privilege.

Not part of the test: a check of ports or applications inside the isolated network, a
screenshot or serial console heuristic, Windows without the guest agent (yellow at best), and
guests that need passthrough hardware to boot (a VM with PCI or USB passthrough, a device
mapping or virtiofs is restored as root, and these are removed before its start, so a guest
that needs them to boot may fail the test), and VMs with raw QEMU `args` beyond CPU, SMBIOS and
clock tuning (skipped).

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
restore (PVE refuses it for providers), restoring the bind and device mount
points of a container (put them back by hand, see "Restore"), restoring restore
points of privileged containers (Restow restores containers only as
unprivileged, and files with ids above 65535 and device nodes would not
restore; restore such a point by hand). Whether a restore point is of a
privileged container is read from its own configuration (`unprivileged: 1` or
not), not from what the guest is now; the restore, the monthly restore check
and the boot test pass it over, and the guest's page says "Not checked:
privileged container". Not possible either: restoring single files back into
a running guest (they are browsed and downloaded as a ZIP, see "Files of a
container" and "Files of a VM"), files of VMs on btrfs, ZFS, ReFS, LVM thin or
RAID volumes, BitLocker or LUKS, NTFS-compressed or EFS files (see "Files of a
VM"), log replay of XFS and NTFS for crash-consistent VM restore points, boot
tests on nodes before the release with boot tests and boot tests with
application checks or port checks (see "Boot test"), more than one tenant
per cluster, PVE on arm64. Jobs for VMs and containers are kept apart from the mail and machine
jobs (`pve_jobs`) in this release.
