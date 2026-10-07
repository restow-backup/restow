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

## Requirements

- PVE 8.4 or newer on x86_64 (`pveversion`), with QEMU reporting
  `backup-access-api` (a VM started before the QEMU upgrade needs one restart).
- A **thin** storage on every node for fleecing images (`local-lvm`,
  `local-zfs`, Ceph RBD, Btrfs): PVE backs up VMs through a provider only with
  fleecing.
- The node reaches the Restow instance over HTTPS (port 443).

## Onboarding

In Restow: **Servers & endpoints > VMs & containers > Connect Proxmox VE**. It
creates a one-time enrollment token (24 hours) and shows:

1. **Once per cluster**, as root on any node: the user `restow@pve`, the roles
   `RestowBackup` (`VM.Audit, VM.Backup, Datastore.Audit, Datastore.AllocateSpace, Sys.Audit`
   on `/`) and `RestowRestore` (`VM.Allocate` and the `VM.Config.*` privileges a
   restore needs, on `/pool/restow-restore`; `Datastore.AllocateSpace` on
   `/storage`; `SDN.Use` on `/sdn`), the pool `restow-restore` and an API token.
   The installer does this itself with `--setup-pve-user`.
2. **On every node**, as root:

   ```sh
   curl -fsSL 'https://<instance>/install/pve.sh' | sh
   # first node of a cluster, with the PVE side of step 1:
   curl -fsSL 'https://<instance>/install/pve.sh' | sh -s -- --setup-pve-user
   ```

   The script checks the maintainer's signature over the release and every file,
   installs `/opt/restow-pve/bin/{restow-pve,restic}`, the shim
   (`/usr/share/perl5/PVE/Storage/Custom/RestowPlugin.pm`,
   `/usr/share/perl5/PVE/BackupProvider/Plugin/Restow.pm`, license in
   `/opt/restow-pve/RestowPlugin.LICENSE.txt`), asks for the enrollment token,
   the API token and the fleecing storage (hidden input), enrolls the node,
   adds the storage `restow` to the cluster once (content `backup`, limited to
   the nodes with the plugin), starts `restow-pve.service` and restarts
   `pvedaemon`, `pveproxy`, `pvestatd` and `pvescheduler`.
   Unattended: `RESTOW_TOKEN_FILE`, `RESTOW_PVE_TOKEN_ID`,
   `RESTOW_PVE_TOKEN_SECRET_FILE`, `--fleecing-storage=<storage>`.

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

## In the overviews

Guests count everywhere the mailboxes and the machines do, by one rule
(`apps/api/src/features/pve/protection.ts`, `packages/core/src/pve/protection.ts`):

- **Protected** only while present on its node, no VM template, and in an
  enabled PVE job (its own, or the job for all guests while it has none). A
  guest in no enabled job is counted as "in no backup job"; one that left its
  job keeps the rating of its restore points, and keeps the tenant from green.
- **Readiness** is the restore check of the newest restore point: green when
  the sample read back matched, red when it did not, unverified until a check
  ran, no backup without a restore point.
- **Failed**: the newest finished backup run of a protected guest failed.
- **Overdue** (`backup.overdue`, the last-backup card, the provider view): no
  successful backup for longer than the enabled PVE jobs' schedules allow.

So the Status tab, Recovery readiness (a row per guest), GET /status
(`guests`), the provider view (`guests`, `guestsWithoutJob`, `guestsFailed`,
alerts `guest_backup_failed` and `guests_without_job`), the warnings page (failed
guest backups apart, with a link to the guests) and the statistics (readiness
series and backup outcomes) all agree. "Nothing protected" is said only when a
tenant has no object, no machine and no guest.

## Restore

From the guest's page: **Restore as a new guest**, with the target storage,
optionally another node of the cluster, a VMID (else the next free one) and
whether to start it. The restore lands in the pool `restow-restore`; move the
guest out of the pool once you accept it. Restores started from the PVE UI
(storage `restow` > Backups > Restore) work through the same plugin, with the
admin's own PVE permissions.

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
restow-pve update            install a newer release the instance offers
restow-pve uninstall --yes   remove helper, plugin and credentials (backups stay in Restow)
```

Files: `/etc/restow-pve/state.json` (node secret and API token, root 0600, local
disk), `/var/lib/restow-pve` (block hash caches, journal, the caches the plugin
reads), `/run/restow-pve` (per-job state), `journalctl -u restow-pve`.

## Security

- The PVE API token never leaves the node; the token can create (and delete)
  guests only in `restow-restore` and never restores over an existing guest.
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
refuses it; restore by hand as unprivileged), single-file restore from VM
images, S3 Object Lock for VM data, more than one tenant per cluster, PVE on
arm64. Jobs for VMs and containers are kept apart from the mail and machine
jobs (`pve_jobs`) in this release.
