# Storage: targets, copies, and replacing the primary

This document is for operators (self-hosting admins and service providers running
Restow for their customers). It covers how a tenant's chunk store is organized across
storage targets, and specifically how to replace a tenant's primary storage target
with a new one — locally, or moving to S3, or the other way round — without losing
access to existing backups at any point. Background and the chunk-store format itself
are in `docs/ARCHITECTURE.md` ("Chunk-Store / Backends"); this document only covers
the storage-target lifecycle.

The web interface calls a storage target a **repository** (German: Repository, plural
Repositories; docs/GLOSSARY.md): the menu entry Repositories opens the section of the
tenant's page that lists them. The code, the API (`/api/v1/storage`) and this document
keep the technical name storage target.

## Targets and roles

A tenant's chunk store (packs, manifests, wrapped keys) lives on one or more
**storage targets**, each a mounted filesystem path (a Docker volume or an NFS
share) or an S3-compatible bucket (Hetzner Object Storage, AWS S3, Wasabi, Backblaze
B2, Garage — not MinIO, which is no longer open source). An NFS share can be added from
the web interface with the opt-in mounter (Installation > Default repository & network shares, `docs/MOUNTS.md`); it
then appears in the api and the worker at `/mnt/restow/<name>`. The path field of a
"directory" target (and of the installation default storage) also takes an NFS address
such as `nas.local:/volume1/restow` or `nfs://192.168.1.10/export/backup`: the form offers
to mount it right there and then fills in `/mnt/restow/<name>` (`docs/MOUNTS.md`, "From
the storage form"). Every target has a role:

- **primary** — receives every new backup first. A tenant has at most one. A tenant
  with no primary target of its own uses the installation's default storage as its
  primary (see "Installation default" below: the default a provider owner saved under
  Installation → Default repository & network shares, otherwise the environment's `STORAGE_TARGET` /
  `STORAGE_LOCAL_PATH` / `S3_*` settings), so a fresh install works out of the box
  with a single container plus Postgres.
- **copy** — receives every new backup too, in addition to the primary. For the chunk
  store (mail, Microsoft 365, the archive, VM disks) that happens with the write itself;
  data written before the copy existed is mirrored onto it, verified by hash, during the
  weekly scrub. The restic repositories of machines, containers and file shares are copied
  to every copy as well, after each backup run and once a day (since 0.5.0, "restic
  repositories on copies" below; before, a copy never received them, and servers,
  containers and file shares had no second copy inside Restow). Any number of copies is
  allowed; a copy can later be promoted to primary
  (`POST /storage/targets/:id/promote`) once it is proven complete. A promotion copies
  nothing: it is refused while the tenant has any restic repository (a container's, a
  machine's, revoked ones included, or a file share's: a copy holds repository *copies*,
  whose restore points have other ids than the ones the database records, see below) or a
  backup run is running (`storage-switch-blocked-by-runs`). The old primary becomes a
  copy; when it is the installation default, a placeholder row keeps it attached
  read-only (`previous`). Before 0.5.0 nothing did, and the installation default dropped
  out of every list of the tenant's targets (the 0.4.1 field incident, "Runs and storage
  changes" below).
- **previous** — a retired primary, left behind by a storage migration (see below), or an
  old location an admin attached read-only ("Attach an old location read-only" in the
  add-target dialog, for example a restored copy of an earlier primary for the
  repository repair, "Repository repair" below).
  Never written to again. Kept until an admin explicitly removes it (the data itself
  is never deleted automatically — only the target's registration with Restow is),
  and an admin cannot remove it while it still holds backup data no other target
  has (see "Removing an old location" below). Read from as a fallback, never
  written to: the API's own read paths for a tenant's backup content (mail previews
  and attachments, and the lookup that finds an already-built download archive), the
  worker's `restore` and `verify` queues, and the worker's `backup` queue (to find the
  last snapshot's manifest for an object it already protects, so an incremental run
  still dedupes and carries unchanged items forward) all fall through to it, in order,
  when the current primary and copies do not have an object a snapshot needs
  (`withReadOnlyFallback`, `packages/core/src/storage/copy.ts`). Archive jobs and
  scrub never read it (see "Known limitations" for the scrub gap this leaves).

The Repositories section of a tenant's page (`/tenants/<tenant>/storage`, also opened by the menu entry Repositories; the earlier address `/repositories` leads there) lists every target with its role,
health (the result of its last test), and — for S3 targets — whether the bucket
enforces Object Lock (WORM), which matters for the GoBD archive layer
(`docs/ARCHIVE.md`). Whether the backup data itself is locked is a setting of each
repository ("Immutable backups" below); local and NFS targets are shown as having no
hardware WORM, and offer only a deletion delay enforced by Restow itself.

## Encrypted transport (HTTPS)

An S3 target sends its access keys (as signatures) and every pack to the storage
service, so its endpoint must be `https://`. Since 0.4.0 a new or changed endpoint
over plain `http://` is refused with the reason `endpoint_insecure` ("only HTTPS"):
creating a target, changing a target's location, testing settings from the form, and
saving the installation default in the web UI. One exception needs no setting:
`http://` to the machine itself (`localhost`, `127.0.0.1`, `[::1]`), where nothing
crosses a network.

**Existing endpoints keep working.** Before 0.4.0, provider admins could save `http://`
to any host, and `S3_ENDPOINT` accepted it too. Refusing those on an upgrade would stop
every backup to them, so addressing that was already saved is read as before: backups,
restores, tests, copies and migrations away from it keep working. Instead:

- the repository's card on the tenant's storage page shows, in red, that it uses
  plain HTTP and should move to HTTPS (`insecureEndpoint` in the API's `s3` block);
- Installation → Default repository shows the same for a saved default and for
  `S3_ENDPOINT` from the environment (`insecureEndpoint` of the view);
- every test of it carries the warning `insecure_endpoint`;
- a name-only edit still works, but a location change must use `https://`. Switch the
  storage service to HTTPS (Garage, for example, behind a reverse proxy with a
  certificate) and change the endpoint; if the service and bucket stay the same, this
  is an ordinary edit, not a migration.

`S3_ENDPOINT` in the environment is the operator's existing configuration and stays
accepted with `http://`; the page asks to change it and restart.

**Test and development setups** whose object store sits on a compose network
(`http://garage:3900`) set `S3_ALLOW_INSECURE=true` in `.env` (api and worker). It
accepts `http://` to any host and removes the "should move to HTTPS" notices; tests
still carry the `insecure_endpoint` warning. The release smoke sets it
(`scripts/smoke/lib/stack.mjs`). Never set it in production. Tenant admins are still
limited to public HTTPS endpoints regardless (`apps/api/src/features/storage/endpoint-policy.ts`).

## Installation default

The installation default is the storage every tenant without a primary target of its
own writes to. It is one location for the whole installation, shown under
Installation → Default repository & network shares (`/installation/default-storage`).

### Where it comes from

1. **Saved in the web UI.** A provider owner can set it on that page: a directory on
   the server, or an S3-compatible bucket, with the same fields as a tenant's storage
   target (path; or provider preset, bucket, prefix, endpoint, region, addressing
   style, access key pair). It is stored as one JSON document sealed in the secret
   store (`secrets` row without tenant, kind `default_storage`, AES-256-GCM with the
   installation secrets key derived from `RESTOW_MASTER_KEY`, bound to its row id),
   the same mechanism as the Microsoft 365 app registration. No table or migration is
   involved. The access key pair is write-only, like a tenant target's: the page only
   ever gets back the last four characters of the key id, and saving without a new
   pair keeps the stored one as long as the endpoint stays the same.
2. **The environment.** Without a saved default, `STORAGE_TARGET`,
   `STORAGE_LOCAL_PATH` and `S3_*` apply exactly as before. An installation that never
   saves one behaves as in earlier releases.

When both exist, the saved default wins, and the page says so (it also shows what
the environment describes, which applies again once the saved default is removed with
"Use the server environment again"). `STORAGE_COPY_LOCAL_PATH`, the mounted share every
default write is also copied to, always comes from the environment: it is part of
the server, not a setting.

### One resolver for the api and the worker

Every place that needs the default resolves it through one resolver
(`InstallationDefaultResolver`, `packages/core/src/storage/installation-default.ts`),
never from `process.env` directly: in the api through `apps/api/src/lib/installation-default.ts`
(restore downloads, mail previews, imports, agent repositories, the storage page, the
dashboard, the archive journal receiver), in the worker through
`apps/worker/src/default-storage.ts` (the per-tenant storage cache and the storage
migration's source). The scheduler does not touch storage. Answers are cached for 30
seconds; a save or removal in the api process drops its own cache immediately. Each
answer carries a generation (`environment`, or the saved row's id and update time).
Before a job on a queue that writes to storage uses a tenant's cached storage, the
worker reads the current generation afresh (one cheap query on the installation
pool) and reloads the tenant when its cached default is older, the same way it
already re-checks a "keep" switch (`resolveStorageForJob`). So no job writes to a
default that was changed after the worker cached it.

### Changing it without orphaning data

Pointing the default somewhere else would leave every tenant's data behind on the
old location, since nothing moves it. `PUT` and `DELETE /api/v1/settings/default-storage`
therefore refuse (`409`, `urn:restow:problem:settings-default-storage-in-use`, with
the tenants named in `blockers`) while any tenant

- has no primary target of its own and keeps backups (packs) or agent repositories
  on the default (`data`),
- has a retired default attached as its read-only `previous` target, left by a
  "keep" replacement (`previous`; the placeholder row of kind `installation_default`
  always opens to the *current* default, so moving it would cut those older backups
  off),
- is moving off the default in an unfinished storage migration (`migration`), or
- has no primary target of its own and a job on a queue that writes to storage
  queued or running (`active_job`).

The page lists the same tenants with their reasons before anyone tries. They need a
storage target of their own first (Repositories → Add repository → Replace the primary with
"move existing backups", or a copy promoted once complete); then the default is free
to move. A change that keeps the location (the key pair, the region, the addressing
style; the same path, or the same endpoint, bucket and prefix) is always possible. A
fresh installation without tenant data can change the default freely. The check runs
twice: before the probe, and again inside the saving transaction under an advisory
lock, so a tenant that wrote its first pack in between still blocks the change.

When the current default is not usable at all (an invalid environment, or a saved
document the master key no longer opens), the check is skipped: nothing can be read
from or written to it as it stands, and the operator is repairing it. Enter the same
location again in that case.

While restore mode is on ([Restore mode and progress
markers](#restore-mode-and-progress-markers)), a change or removal that moves a usable
default's location is refused (`409`, `urn:restow:problem:restore-mode`) even when the
database knows no tenant data on it: the restored database may not know data written there
after the dump.

Before saving, the new location is probed exactly like a tenant target (write, read,
list and delete a small object below `installation/probes/`, Object Lock detection);
a directory must already exist. A failing probe refuses the change (`422`,
`urn:restow:problem:settings-default-storage-unreachable`, with the probe) and nothing
is saved; the page shows the probe either way. Removing the saved default probes the
environment's location first, and is refused when the environment describes no
usable storage (`409`, `...-environment-invalid`).

Saving and removing are for the provider owner only (`own()` in
`apps/api/src/lib/provider-access.ts`) and need a recent sign-in
(`apps/api/src/lib/recent-sign-in.ts`), like the other settings that affect the host.
Every save and removal is written to the installation audit chain
(`settings.default_storage.saved` / `.removed`, with the old and new location, the
probe outcome and whether the key pair changed, never the key pair itself). A save's
probe counts as the default's newest test.

### On a tenant's storage page

The installation default is always shown as an explicit choice. While the tenant has
no primary target of its own, it is the selected primary ("Selected: new backups of
this tenant go here"). Once the tenant has a primary of its own, the default is shown
as not in use. Going back to it is offered ("Use installation default") while that
primary holds no data yet: the primary is removed and the default applies again,
under the same rules as removing a primary (`primary_holds_data` refuses it once data
exists). Going back from a primary that already holds backups is not supported in
this release (see "Known limitations").

### Tenant separation on a shared default

All tenants on the default share one location; nothing in it is separated by
location. Separation is the key layout and the per-tenant keys:

- every chunk-store key lives below `tenants/<tenant id>/` (`tenantPrefix`,
  `packages/core/src/engine/layout.ts`, which refuses ids with characters outside
  `[A-Za-z0-9._-]`, so no id can escape or nest into another's prefix; the trailing
  slash keeps an id that is a prefix of another id apart), staging and exports too;
  agent repositories live below `endpoints/<endpoint id>/`, and an endpoint belongs to
  exactly one tenant;
- every pack, manifest and staged or exported file is sealed with the tenant's own
  data key (DEK), and the DEK is stored only wrapped with the master key
  (`tenants/<tenant id>/keys/<version>`). Bytes read from another tenant's prefix do
  not open with a different tenant's key;
- a tenant's storage is resolved inside its own tenant-pinned transaction (Row Level
  Security), and every read and write goes through keys built from that tenant's id.

`packages/core/src/storage/installation-default.test.ts` checks that two tenants on
the default resolve to the same backend but disjoint prefixes, and that one tenant's
DEK does not open another's sealed content. Changing the default does not change any
of this: the change only decides where the shared location is.

## Other data on a target, and its budgets

Besides the chunk store, a tenant's primary target holds three more kinds of data,
each with a budget so that one machine or one tenant cannot fill a target that other
tenants share:

- `endpoints/<endpoint id>/`: the restic repository of each server or client backed up
  by the Restow agent (`docs/AGENT.md`), and next to it
  `restow-repository-password.json`, the repository password sealed with the tenant
  key, so that the master key and the storage alone open it
  (`restow-restore endpoint-password`, see `packages/cli/README.md`). Each repository
  may take `RESTOW_ENDPOINT_QUOTA_GIB` (default 2048 GiB = 2 TiB, an administrator can
  set another value per machine), all repositories of a tenant together
  `RESTOW_ENDPOINT_TENANT_QUOTA_GIB` (default 20480 GiB = 20 TiB); `0` switches a budget
  off. An upload beyond a budget is refused, restores keep working, and the alert
  `endpoint.storage_quota` warns at 90 percent.
- `tenants/<tenant id>/staging/`: mail file uploads, sealed with the tenant key, until
  their import has ended (`docs/IMPORT.md`). All uploads of a tenant may declare
  `IMPORT_MAX_STAGING_BYTES` together (default 100 GiB); a new upload that does not fit
  is refused before its first byte. The server import folder does not use staging.
- `tenants/<tenant id>/exports/`: finished EML and MBOX exports, sealed, until they
  expire (`EXPORT_TTL_HOURS`, default 24). Unexpired exports of a tenant may take
  `EXPORT_MAX_TENANT_BYTES` together (default 50 GiB).

The daily retention run removes what is left of failed or cancelled exports and every
staging or export area that no database row knows any more. Do not keep files of your
own under these prefixes. In restore mode (after restoring a database dump, see
[Restore mode and progress markers](#restore-mode-and-progress-markers)) it removes
nothing: an area without a row may belong to an upload or export made after the dump.

`tenants/<tenant id>/progress/` holds the tenant's progress markers (see the same
section): small objects that record how far the database had come. They are never copied
by the copy mirror or a storage migration and never counted as data.

## Restore mode and progress markers

After a database dump is restored (a rollback with migrations, see
[UPDATING.md](UPDATING.md#rollback), or a move to a new host from an online dump), the
database knows less than the storage: backups, checkpoints, keys and holds made after the
dump are in storage but not in the database. Every pass that decides by the database what
may go would delete them. Restore mode prevents that.

### What restore mode does

While it is on, for the whole installation:

- **Nothing is deleted.** Refused are the orphan sweep and garbage collection of the
  storage check, the release of superseded packs, abandoned checkpoints, snapshot
  retention, the clean-up of staging areas, archive retention (no item row, no
  chunk reference and no sealed record goes; records queued for deletion stay queued), restic forget
  and prune of machines, file shares and Proxmox VE containers (including the comparison
  that forgets restic snapshots no restore point names, and retention on their repository
  copies on copy targets, while the copying itself goes on), the removal of a machine's
  backups, the purge of a file share, repository repairs, a container's repository reset,
  the pruning of old progress markers, the removal of a storage target and the replacement
  of the primary (also pointing a local or S3 primary at another location with `PATCH
  /api/v1/storage/targets/:id`, and moving or removing the installation default when that
  moves its location; repairing a default that is not usable stays possible). Each refusal is
  logged (`deletion held: restore mode`) and counted on the Restore mode page. The api answers
  such an action with 409 `urn:restow:problem:restore-mode`. Snapshot and Proxmox VE retention
  take the permit before they change anything in the database and stop the run at the first
  refusal, so a restore point due when restore mode comes on mid-run stays active with its
  chunk references.
- **Jobs from before the restore are held.** Every job created before the hold point is
  cancelled with the explanation `job.restore_mode_hold` instead of being run or resumed
  (a backup from the dump could otherwise continue a checkpoint the restored index does not
  know, a restore could write into a mailbox again). The same holds for what is not a queued
  job: file share runs (a restore into a share, a mirror copy) are cancelled instead of
  started, and the tasks machines and Proxmox VE nodes fetch with their heartbeat (a restore
  over a guest, an uninstall) are cancelled instead of handed out or handed out again. When the
  api cannot read the restore mode and never read it (or the guard has seen it on since),
  the heartbeat answers 503 `urn:restow:problem:restore-mode-unknown` and hands out nothing; a
  restore mode last seen on keeps its hold point. A job from before the hold point that is
  already waiting for a tenant slot or running when restore mode comes on is stopped by the
  worker within a few seconds and ends cancelled (`job.restore_mode_hold`), without a retry.
  Start a job again if it is still needed. A held job's cursor entries go with it (a restore's
  record of what it restored); a held archive backfill is queued again by the next capture
  pass and continues from the stream's own position. The hold point is the moment restore mode was switched on by
  hand; for a detection it is the start of the processes that run on the restored database (the
  earliest start among the scheduler and workers that beat in `service_heartbeats`, and the
  detecting process), never the moment of the detection, so backups the scheduler queued on its
  first tick still run.
- **New backups and checks run as usual.** They only add data. A container whose repository
  the restored database does not consider ready begins its new chain under a fresh prefix,
  as on write-once storage, so nothing is moved aside. A file share whose repository is in
  storage but whose password the restored database lacks (its first backup ran after the dump)
  begins a new repository under a fresh prefix too; the old one and its sealed password stay.
- **Immutable backups stay locked.** The Object Lock renewal renews every pack the target
  lists, not only the catalogued ones, so packs written after the dump keep their lock.

The storage backends themselves refuse a delete outside a registered deletion pass while
restore mode is on, so a pass that forgot to ask cannot delete either. Restic lock files,
probe objects and objects an operation wrote itself may always go, and so may the scope a row
owns under its own fresh id: an EML or MBOX export starting its own file over (only its own
leftover segments, and only when there are some) and a failed enrollment removing the
repository it began under its new machine id. Neither restore mode nor a copy target that
cannot be compared with the database holds these.

### Switching it on

- **With the command line, before the worker starts** (the rollback procedure):
  `docker compose run --rm --no-deps --entrypoint restow api restore-mode on --reason "..."`.
- **By a restore from a dump** in the setup wizard or with `install.sh --restore` (source
  `setup`, [DATABASE.md](DATABASE.md#restore-an-installation-from-a-dump)): `restow restore
  prepare` switches it on in the restored database as the first thing it writes there, before
  the master key and the storage are checked and long before the restored database goes live.
  Installation › Restore mode then lists what to check, the users, the address and the mail
  settings included.
- **By itself.** Every storage target carries progress markers:

  ```
  tenants/<tenant id>/progress/<floor(seq / 1000), 12 digits>/<seq, 20 digits>.json
  ```

  Before the first write of a tenant's data to a target, and again at most once a minute
  while data is written, the writer takes the next value of the tenant's counter in the
  database (`storage_progress`, committed on its own) and only then writes a new marker
  object and the data. A marker is never overwritten, so write-once targets work; the newest
  wins. The marker names the installation (the id of its settings row) and the value.

  At its start, before it takes any job, and before every deletion pass (at most every ten
  minutes per tenant) the worker lists the markers and the wrapped keys of each primary and
  copy target first and reads the database's value afterwards. On a healthy installation
  every marker it saw was committed before that read, so none is above it. A marker of this
  installation above the database's value, or a key version in storage above the database's
  newest, means the database is older than its storage: restore mode comes on, the alert
  `installation.restore_mode` is raised (bell, the provider's notification recipients, and
  e-mail and webhooks per the notification rules), the audit entry `installation.restore_mode.detected` is written and the deletion
  is refused. A target that cannot be read refuses deletions for that tenant this time
  without switching restore mode on.

  Every process (the worker and the api) compares a tenant's targets once before it takes the
  first value for that tenant: an allocation raises the database's value, and after a few of
  them a comparison could no longer see storage that is only a few values ahead. A writer that
  finds the value it was given already taken by a marker of this installation has proof by
  itself that the storage is ahead (the value was handed out before, in the timeline the
  database lost): restore mode comes on at once, with that value as the storage's and the one
  below as the database's, and the value is lifted above the storage's.

  It does not trigger on a fresh installation or an upgrade from before 0.5.0 (no markers
  yet), on a copy that is being filled or a promoted copy and a new primary after a storage
  migration (markers are never copied, a target only holds markers written to it since), on
  storage copied by hand with rsync (its markers are at most the database's value), or after
  a database move with the stack stopped. Markers of another installation (a second
  installation pointed at the same storage) only give a warning. It does trigger, on
  purpose, for an online dump used for a host move (writes after the dump), for a failover
  to an asynchronous replica that lags, and for a second installation restored from the same
  dump that writes to the same storage. Writes in the last minute before a dump may carry no
  marker yet: the command line step of the rollback closes that window.
- **In the web interface.** A provider owner can also switch it on under Installation, Restore
  mode (**Switch restore mode on**, with a reason and a recent sign-in; the audit entry is
  `installation.restore_mode.started`). Jobs created before that moment are held. After a
  rollback the command line step stays first: it runs before the worker and the scheduler start.

### Ending it

Under Installation, Restore mode a provider owner (with a recent sign-in) ends it after
checking the restored database, or on the command line
`restow restore-mode off --email <owner> --checked "<what you checked>"`:

1. **Compare now** runs the comparison again for every tenant. Every target must answer, or
   be accepted by name as unreachable.
2. **Import keys** takes key versions found in storage that the database lacks into the
   database (each must open with the master key and be the same on every target that has
   it). Ending is refused while such versions remain.
3. The form asks what was checked (at least 20 characters, kept in the audit log), what
   happens to data that only storage knows, and the typed confirmation `END`:
   - **Keep it for good** (the default): data in storage the database has no row for and
     that is older than this moment stays for good. The orphan sweep and the comparison of
     container repositories skip it; backups written after the dump remain restorable with
     the standalone restore tool (packages/cli) from their manifests.
   - **Let the clean-ups remove it**: the usual grace periods apply again.

Ending lifts each tenant's progress value above everything storage showed (by a margin of
one million, so markers on a target that was offline stay below it), records who ended it
and the audit entry `installation.restore_mode.ended` with what was checked. The history of
restore modes stays.

### Wrapped keys and repository passwords are never overwritten

`tenants/<tenant id>/keys/<version>` is the wrapped DEK the standalone restore opens data
with. The key mirror writes a missing key and leaves an identical one alone; a stored key
that differs from the database's under the same version is never overwritten, always, not
only in restore mode. It is reported instead (`installation.key_mirror_conflict`, the audit
entry `tenant.key_mirror.conflict`, listed under Installation, Restore mode): as a
**conflict** when the stored bytes open with the master key (another valid key under the
same version, for example after restoring a dump and creating a key again) or as
**damaged** when they do not. The copy mirror and a storage migration do the same for a
copy (`key_conflict`). A new key version is always allocated above every version stored
for the tenant on any target; a target that cannot be listed refuses the new version.

To resolve a finding by hand: keep the stored object (data written under it may need it);
compare its SHA-256 with the database's (`SELECT encode(sha256(decode(encrypted_dek,
'base64')), 'hex') FROM tenant_keys WHERE tenant_id = '<tenant>' AND key_version = <v>`). A
**conflict** whose stored key belongs to backups made after a dump is taken into the
database with `restow restore-mode import-keys` when the database lacks the version; when
the database holds another key under it, copy the stored object aside before anything else
and contact support. A **damaged** copy on one target can be replaced by hand with the
intact object of another target or of the database, at the storage provider.

A finding resolves itself once the target holds the database's bytes again (the next key
mirror sees it). A stored key that cannot be read this time (throttling, a timeout) is no
finding: it is compared again at the next resolution of the tenant's storage.

The sealed repository password next to a restic repository
(`.../restow-repository-password.json`, of a machine, a file share or a Proxmox VE guest) is
treated the same way: one that holds another password than the database's, or does not open
with the tenant's keys, is never replaced (also not by a copy or a storage migration). It is
reported as a finding with key version 0 and its storage key, with the same alert and audit
entry. After restoring a dump it may be the only copy of the password of backups written after
the dump.

## Capacity planning

Installation > Capacity planning (`/resources`, provider admins) shows what each tenant stores,
how fast that grows and, where a limit is known, when the repository runs full. `GET
/api/v1/capacity` answers it; the list of every tenant needs the gate `dashboard.allTenants`, a
member of the provider team limited to some tenants gets those, and an installation without the
gate shows its one tenant.

- **Stored** is the start page's physical figure: the sealed packs of the chunk store plus the
  restic repositories of machines, file shares and containers.
- **Growth** per day over 7, 30 and 90 days comes from `storage_samples`: once a day and tenant
  the worker writes the bytes of the chunk store and of every restic repository (an entry of the
  endpoint monitor, `apps/worker/src/storage-samples.ts`; one row per source and UTC day, kept
  400 days). A restic repository keeps no history of its size, so its growth is known from the
  day the samples start. Until a tenant has a week of samples its growth is read from the pack
  dates, as the start page's chart does: net growth of the chunk store only. A horizon the
  history does not reach back to has no figure.
- **Full on** is the estimate of the start page's chart (`dashboard/growth.ts`): a straight line
  through the history, from 90 days on a band between the slowest and the fastest week, and the
  repository's free space divided by it. It is given for a local repository the tenant has to
  itself (its own, or the installation default while it is the only tenant on it), never for S3
  (the S3 API shows no limit) nor for the shared default (that disk is the server's), and, while
  only the pack dates are known, not while machines, file shares or containers write to the same
  repository. Ten years or more is no day. The page words it as an estimate and never in green.
- **Quota** is what exists: the budgets of the machines (see "Other data on a target, and its
  budgets") and of the file shares (`docs/FILESHARES.md`). The chunk store has none.

## A full target

Retention frees space by forgetting restic snapshots and pruning the repository. restic's normal
`prune` repacks partly used packs: it writes the new packs before it deletes the old ones, and it
needs room for new index files, its lock and its cache. On a full target (a local directory, an
NFS or SMB share, an S3 bucket at its quota) that prune fails and frees nothing, so retention could
never get the space back by itself. Every prune the server runs, for machines
(`apps/worker/src/endpoints/retention.ts`), file shares (`file-shares/maintenance.ts`) and Proxmox
VE containers (`pve/maintenance.ts`, `reconcileGuestRepository`), therefore goes through one policy,
`resticPrune` in `packages/core/src/endpoints/restic-cli.ts`:

- **Headroom check.** A target that reports its free space (a directory, also a mounted NFS or SMB
  share: `statfs`; `StorageBackend.freeSpace`) and has less than 8 GiB or 20 % of it free gets a
  dry run first (`restic prune --dry-run --no-lock`, it writes nothing). What the repack would
  write (what it reads minus what it drops) plus 64 MiB of scratch room must fit, or only the
  delete-only prune runs.
- **Delete-only prune.** `restic prune --max-unused unlimited --max-repack-size 0 --no-cache`:
  packs no snapshot uses at all are deleted, partly used packs stay as they are
  (`--max-unused unlimited` selects none of them, `--max-repack-size 0` stops any repack, also of
  packs restic would rewrite for duplicates or mixed content). It writes only the new index files
  and its lock. `--no-cache` keeps restic's cache off the server's disk, which may be full too, or
  be the same disk as a local target (the cache of the other runs is `RESTOW_RESTIC_CACHE_DIR`,
  else the temporary folder; put it on another disk than a local target).
  `--unsafe-recover-no-free-space` is never used.
- **Fallback.** A normal prune that fails for lack of space (also on an S3 service at its quota)
  is followed by the delete-only prune at once. The server's maintenance listener answers an
  upload the storage refuses as full (`ENOSPC`, `EDQUOT`, an S3 quota error or HTTP 507) with 403,
  which restic treats as final, instead of 500, which it retries for a quarter of an hour per
  file; restic's run then ends as `storage_full`.
- **Repack later.** When the delete-only prune leaves more unused data than restic tolerates by
  default (5 %), the retention report records `prunePending`; the next run prunes again even when
  it has nothing to forget, and repacks once the headroom check lets it. A target that reports it
  is nearly full (less than 128 MiB or 2 % free) is pruned on every run as well, for containers too.

The delete-only prune is a deletion like every other: it runs under the pass's deletion permit
(`withDeletionPermit`, the deletion sites registry) and not at all in restore mode.

When not even the delete-only prune fits (the lock or the new index files need a few KiB), the
run fails as `storage_full`: the machine's retention report reads "Retention could not free space:
target full" with the next step (free space on the target or enlarge it, for an S3 bucket raise
its quota), the report keeps the prune due, and the next run deletes what no snapshot needs. A
repository check or a container listing that fails the same way is no finding about the
repository. The test `packages/core/src/endpoints/restic-prune-space.test.ts` fills a 96 MiB ext4
file system in a loop device with backups until the next pack does not fit (over 99 % used) and
checks that retention brings it back below the limit (it runs only as root where `losetup` works).

## Unusually large runs

One backup run can fill a target that retention keeps nicely below its size: someone adds a folder
by mistake (an operator saw an 879 GB recycle bin go into a backup of a server with 2000 GB in
total). The usual recycle bins are left out already (`**/.Trash`, `$Recycle.Bin`, `#recycle`,
snapshot folders); anything else, and a recycle bin under another name, went through unchecked.
From 0.5.0 a **size and space guard** measures every backup run while it writes
(`packages/core/src/run-size`, `packages/db/src/run-size.ts`).

**By default Restow only warns about large runs, and holds a run only for space.** A run that
adds far more than usual goes on and raises a notice (`backup.unusually_large_notice`, once per
run, not critical); a run that would leave its storage target too little free space is held
before it fills the storage. An administrator who wants large runs stopped sets the size check
to "hold", for the tenant or for one object (also straight from a notice).

**Where a run is measured.** A run's size is known only while it writes; restic's own summary
(`data_added`) comes at the end, when the data is stored already.

| Kind | Measured | Where |
| ---- | -------- | ----- |
| Servers and clients, file shares, Proxmox VE containers (restic) | the bytes of every upload of a backup run through the server's restic REST endpoint | the api (`/agent/restic`, `/internal/file-shares/restic`, `/agent/pve/restic`), before every upload but a lock file |
| Mailboxes, OneDrive, SharePoint sites, IMAP accounts (chunk store) | the plaintext of the new chunks in every pack the run writes (64 MiB at most), the unit of the history | the worker, before the pack is stored |
| Proxmox VE VMs (block backups into the chunk store, uploaded through the api) | not yet | |

**The rule.** Before an upload the guard asks two questions:

- **Size.** Does the run pass its limit? The limit is the largest of: 10 times the median of what
  the object's last 10 successful runs added (restic: `data_added_packed`, else `data_added`; the
  chunk store: the new chunk bytes), 10 GiB (small objects never trip it), and the object's own
  limit. With fewer than 3 earlier runs a run is a first backup: not checked, unless a limit for
  first backups is set. The history starts with the object's current repository: a run that
  begins a new repository (it uploads restic's `config`: after a reset, a new chain, a repository
  that was gone) is a first run itself, and so are the next two; a file share counts from its
  `repository_ready_at`, a Proxmox VE container from its newest backup chain. A machine that its
  job backs up as a whole (docs/BAREMETAL.md 5) is compared with its earlier whole machine runs
  only (those that recorded a layout), a machine backed up by its paths with its path runs: the
  first whole machine backup after the switch adds the whole system once and is a first run, not
  ten times the usual path run (`apps/api/src/features/run-size/scope.ts`).
- **Space.** Would the upload leave the target less free space than it keeps for everything else
  on it? See "The space rule" below. Only where the target reports its space (a directory, an NFS or SMB mount: `StorageBackend.freeSpace`). An S3
  bucket reports none: there the size rule alone applies, and the storage budgets of machines
  and file shares (above) still refuse what does not fit. The space is read at most every 30
  seconds; what the run was let upload since counts as used. The small uploads that finish a run
  (restic's index, snapshot, keys, config) are never held for space, so a run whose data went in
  is not refused its restore point.

**A large run in `warn` mode (the default).** A run that passes its size limit goes on: no
upload is refused, no hold is made. The guard raises `backup.unusually_large_notice` once for the
run (a warning, not critical: in the bell and to the rules and recipients that list it, held for
a digest as configured), naming the object, the run, what it had written and its limit, the usual
size and the hint to exclude what does not belong. The run is not checked for its size again; the
space rule still applies to it. The notice is kept on the run (`run_size_runs.noticed_at`,
`notice`, migration 0098), so an api restart or a retry raises none again. Warnings, "Held
backups", lists the notices of the last 30 days under "Unusually large backups that went on" (no
hold card), each with **Hold such runs**, which sets the object's size check to `hold` (audited
`backup.size_guard_changed`); the bell entry leads there.

**Held.** A run that answers the space question with yes, or the size question while its size
check is set to `hold`, is held: the upload is refused (restic gets 403 with
`urn:restow:problem:run-size-held`, which it takes as final; the chunk store stores no further
pack), the run ends without a restore point, a mailbox or OneDrive run with the failure "Held:
this backup is unusually large" (`storage.run_held`). Earlier restore points are untouched; the
packs a chunk store run stored before the hold stay in its index, so the run that continues does
not upload them again. The hold (`run_size_holds`) records
what the run had added, the limit, the median and the target's space, and raises
`backup.unusually_large` once (critical: the bell, the provider's mandatory recipients, every rule
that lists it, never held for a digest). Until an administrator decides, every further run of the
object is held at its first upload (counted on the hold, no second alert). A hold for space ends
by itself: the next run checks again and goes ahead once the target has half again what it keeps
free (`space_freed`), or once the space rule is switched off for the target, the tenant or the
installation (`settings_changed`). A hold of an object that is gone (a removed machine, a deleted share,
guest or account) ends when the list is read (`object_removed`). The run's failure says "held"
(`storage.run_held`) for a failed run; a run that made a restore point keeps its own.

The guard knows a run beyond the process that measures it (`run_size_runs`): the bytes it stored
(written at most every 256 MiB or 30 seconds, so a process that dies loses at most that much),
and why it is exempt (it used "continue once", or it began a new repository). An api restart, a
second api process or a retry of a mailbox backup under the same job carries on from there. A
question the database cannot answer is answered with 503, which restic tries again; it never
refuses a run for good. A machine's agent authenticates as the machine, not per run: its uploads
count towards its newest running backup run, also those of a native SQL Server backup that runs
at the same time (more, never less). A Proxmox VE container's or a file share's uploads count
only for a backup run.

**Deciding a hold** (Warnings, at the top: "Held backups"; `/api/v1/run-size`):

- **Continue once** (technicians and up, a hold for size only): the next run of the object goes
  through without the size check, whatever it adds; that run closes the hold. The space rule still
  applies to it: a run let through for its size is held when the target runs short. Audited
  (`backup.size_hold_continued`).
- **Raise the limit** (administrators and up, a hold for size only): the object's own limit
  becomes the given size; the hold ends. Audited (`backup.size_limit_raised`).
- A hold for space offers neither: letting a run fill its target is what the rule is there to
  prevent. The card says so and shows "Continue once" disabled; the api refuses it with 422
  (`urn:restow:problem:run-size-continue-not-for-space`). The hold ends with room on the target
  (free space up, or retention removed data), or with the space rule switched off.
- **Switch the check off for this object** (administrators and up). Audited
  (`backup.size_guard_changed`).
- **Exclude** the folder that does not belong in the backup in the object's settings, then
  continue once or let the next run be measured again.

**Settings of the size rule.** Defaults, then the tenant's, then an object's own (Warnings, "Size
check"; `PUT /api/v1/run-size/settings`): on or off, the **mode** (`warn`, the default: a notice
and the run goes on; `hold`: the run is held until an administrator decides), the factor (2 to
1000), the size below which a run is never flagged, a limit for first backups (empty: not
checked). The installation has no size settings of its own: its default is `warn`. What is saved is merged into
what was set; the object must be the tenant's. An open hold the new settings would not make ends
(`settings_changed`, or `guard_off`): switching an object (or the tenant) to `warn` ends its
open hold for size, and a hold for size made before is ended at the next run of an object that
warns now. Each change is audited (`backup.size_guard_changed`).
Switching the size check off for an object leaves the space rule of its target on.

**The space rule.** A storage target keeps free a share of its size, at least a minimum and at
most a maximum: `keep = min(max(percent × size, minimum), maximum)`. The defaults are **5 %, at
least 20 GiB, at most 500 GiB**: a 100 GiB disk keeps 20 GiB, a 1 TiB disk about 51 GiB, a 20 TiB
disk 500 GiB. A target that reports free space but no size keeps the minimum. A small target never
keeps more than a quarter of its size (a 40 GiB disk keeps 10 GiB, not the 20 GiB minimum: the
minimum must not hold every run of it). All three values are adjustable on three levels, each over
the one before:

| Level | Where | Who | API |
| ----- | ----- | --- | --- |
| Installation (the default) | Installation › Database, next to the disks | the owner | `GET/PUT /api/v1/updates/space-rule` |
| Tenant | Warnings › "Size check" | tenant administrators | `PUT /api/v1/run-size/settings` with `space` |
| Storage target | the target's card on the storage page (the tenant's own primary) | who may manage the target | `GET /api/v1/run-size/targets`, `PUT /api/v1/run-size/targets/:id` |

A level sets only what it changes (on or off, the percent from 0 to 50, the minimum and the maximum
in GiB); the rest follows the level below, and `null` goes back to it. A maximum below the minimum
is refused (422). On the installation's default target, which the tenants share, only the
installation's rule applies: a tenant's own rule counts on its own targets. Objects have no space
rule of their own: the space is the target's, not the object's. Each change is audited
(`backup.space_rule_changed`, with the level, before and after); switching the rule off ends the
open holds for space it covers. Below a tenth free, the low disk space warning (docs/DATABASE.md)
has spoken already for the local default repository.

"Continue once" lifts the size rule only (`CONTINUE_ONCE_LIFTS` in packages/db run-size.ts); a run
that begins a new repository is no unusual run either, and the target still needs room for it.

Known limits:

- A held restic run ends; restic writes no index for the packs it stored, so they are unused
  data until the next prune, and a run that continues once uploads them again.
- A process that dies loses at most the last 256 MiB (or 30 seconds) of a run's count: the run
  looks that much smaller (never larger).
- Where the size comes from (the largest new folders of a run) is not shown yet: the server sees
  packs, not files. The agent and the runners would have to report it.
- A notice in `warn` mode is shown in the bell, the mails and on Warnings; the run lists of the
  objects do not mark such a run yet. A run that writes more than its limit and is then retried
  under a new run id raises a notice of its own.
- Proxmox VE VM backups (changed blocks into the chunk store) are not measured yet, and the
  per-job setting is per object: a backup job of several mailboxes has one setting per mailbox.

## Immutable backups

Backup data that someone who controls Restow cannot delete or alter before a date: an
attacker on the Restow server, someone holding Restow's storage access key, a stolen
administrator account, or a retention policy shortened on purpose. Each repository (storage
target) has its own immutability setting; it is off until an administrator turns it on.

### What exists to protect (research)

- **Kinds of storage.** A target is an S3-compatible bucket (`s3`) or a directory (`local`:
  the Docker volume, or an NFS share mounted by the mounter at `/mnt/restow/<name>`). The
  installation default is one of the two, configured in the environment or under
  Installation; `STORAGE_COPY_LOCAL_PATH` is a directory. A tenant writes to its primary and
  every copy (`writeToAllTargets`, `packages/core/src/engine/chunkstore.ts`); the weekly
  scrub mirrors older data onto copies (`storage/copy.ts`); a `previous` target is read only.
- **Chunk store (Microsoft 365, IMAP, PVE disks).** Packs are written once under a new id
  (`tenants/<t>/packs/<xx>/<id>`) and never rewritten; a committed manifest
  (`manifests/<snapshot>.json.zst`) is written once; the checkpoint (`.partial`) is
  rewritten during a backup and deleted after it; wrapped keys (`keys/<version>`) are
  written once. Deduplication means a new restore point references packs of any age.
- **How data is deleted.** Retention (`retention` queue, daily) marks a restore point
  pruned, releases its chunk references and deletes its manifest on every target
  (`apps/worker/src/handlers/retention.ts`). Space comes back in the weekly scrub: garbage
  collection copies the surviving chunks of a pack into a new pack, swaps the catalog, keeps
  the old file for a day (`superseded`) and then deletes it; unrecorded pack files older than
  a day are swept (`verify/gc.ts`). Staging, exports, downloads and abandoned checkpoints
  are cleaned up as they expire.
- **restic repositories (endpoints, file shares, PVE containers).** They live under
  `endpoints/<id>/`, `file-shares/<id>/` and `pve-guests/<id>/` of the primary and are
  served by Restow's own restic REST layer (`endpoints/restic-rest.ts`) on top of the same
  storage backends. Agents and runners hold append-only credentials (they write new
  objects and their own lock files, nothing else). The server's retention decides which
  snapshots go and runs `restic forget <ids>` and `restic prune` through a loopback
  listener with full access (`endpoints/loopback.ts`); prune deletes packs and rewrites
  index files.
- **S3 Object Lock** needs versioning: a write is a new version, a DeleteObject without a
  version id only adds a delete marker, and a locked version cannot be removed before its
  retain-until date (COMPLIANCE: by nobody; GOVERNANCE: only with
  `s3:BypassGovernanceRetention`). Until now Restow locked only the archive's item records.

### Design

**What is locked.** By key (`lockClassOf`, `packages/core/src/storage/immutability.ts`):
packs, committed manifests and wrapped keys of the chunk store; the `data/`, `snapshots/`,
`keys/` and `config` objects of every restic repository, and the repository password file
next to it. Not locked: checkpoints, staging, exports, downloads, probes, restic `locks/`
(restic writes and removes them on every run) and restic `index/` files: every prune
rewrites the index and restic stops a prune for good when it cannot remove an old index
file (tested with restic 0.19.1). Index files only list what the packs hold; `restic
repair index` rebuilds them from the locked packs. Archive records keep their own
retention (`docs/ARCHIVE.md`).

**S3 with Object Lock (`compliance` or `governance`, N days).** Turning it on asks the
bucket for its Object Lock configuration and refuses a bucket without it (Object Lock can
only be enabled when a bucket is created). From then on every locked object is written with
`ObjectLockMode` and `ObjectLockRetainUntilDate = now + N + 7 days` (and Content-MD5,
which a write with lock parameters needs). A multipart upload gets the retention again
after it completes, since not every S3-compatible service applies it from
CreateMultipartUpload. Restow never sends the governance bypass header.

**Renewal (the "retention extension" of deduplicated data).** Locks run for N days plus a
renewal buffer of 7 days. The worker's daily retention job renews every object still in
use once the last complete renewal of the target is 6 days old: it sets the retention of
every catalogued pack and every wrapped key of the tenant, and of every locked object of
its restic repositories, to `now + N + 7 days`. Between two renewals every object in use
is therefore locked for at least N days beyond "now", so a restore point made now (and the
old packs it reuses) is covered for its whole period. Objects whose deletion was already
refused because of the lock (see below) are left out of the renewal so they can run out.
A renewal costs one PutObjectRetention per object every 6 days, 32 in flight at a time
(`IMMUTABILITY_RENEWAL_CONCURRENCY`). It goes through the keys in sorted order and records
how far it got on the target, so a pass that was interrupted, or in which some objects
failed, continues there with the same retain-until date and counts as complete from its
original start. When the renewal falls behind by more than the buffer the repository page
warns: data reused by new restore points may then be locked for less than N days.

**Deleting under a lock.** On an immutable S3 target Restow deletes an object by deleting
every one of its versions (a delete marker alone frees nothing and only hides the object),
after checking each version's retention; while one is locked it deletes nothing and gets
`ObjectLockedError`. The callers treat that as "not yet", never as a failure:

- retention leaves a restore point whose manifest is still locked on any target untouched
  (it stays visible and restorable) and counts it as deferred; for restic repositories it
  leaves snapshots whose snapshot file is locked out of `restic forget`;
- garbage collection re-packs as before, but keeps a superseded or orphaned pack file the
  target still locks on its list and deletes it in a later scrub; space therefore comes
  back only after the lock ends (up to N + 7 days later);
- restic prune gets 403 for a locked pack, reports it as a warning and carries on; the
  pack is unreferenced from then on and the next prune after the lock ends removes it.

A deletion of a restic object or of a manifest the storage refused is recorded per
repository (`immutability_deferred_deletions`, migration 0047), shown on the repository page
("deletions wait for their lock to run out") and left out of the renewal; the row goes once
the object is gone. Retention and the scrub count their own deferrals in their job reports
(`deferredByLock`).

**Verification.** The daily retention job (and "Verify now" on the repository page) asks
the storage for the retention of a sample of recently written objects that are still in use
(HeadObject, which needs `s3:GetObjectRetention`): each must be locked beyond now, in
COMPLIANCE when COMPLIANCE is set. An object written without lock (a worker that had not
seen the setting yet, a storage that ignored the headers) or in a weaker mode is shown as a
warning on the repository page and the dashboard.

**Restore points.** The restore point list asks the storage for the retention of the
restore point's manifest (restic: its snapshot file). "Immutable until <date>" is green
only when the storage itself reported a COMPLIANCE retention beyond now; GOVERNANCE is
shown neutral (an account with the bypass permission can lift it), and so is the deletion
delay of a directory (Restow's own promise, not the storage's).

**Directories: deletion delay, not immutability.** A file system cannot refuse Restow's own
processes, and none of the options at hand holds against the people it would be sold
against: `chattr +i` needs `CAP_LINUX_IMMUTABLE`, which root on the host, and any process
that reaches the Docker socket (the mounter has it), can use to lift it again, so an
attacker on the Restow server lifts it as easily as Restow sets it. A truly hardened
repository needs a separate machine that Restow cannot log in to. For a
directory Restow therefore offers only the **deletion delay** (`delayed_deletion`):
Restow's own code refuses to delete or overwrite a locked file (the classes above) until
N days after it was written, following the history of the setting, so a period lowered
later never shortens what was written before. It protects against misuse of Restow (a
stolen administrator account, a retention policy shortened to delete restore points)
and the interface says plainly that it is not immutability: someone with access to the
server or the share can still delete the files. For real immutability on premises use an
S3 service with Object Lock on a separate machine (Ceph RGW, or another S3 server that
implements Object Lock) as the repository or as a copy, or a NAS whose snapshots the Restow
host cannot delete (Restow cannot verify the latter and does not show it as immutable).

**Changing the setting.** Raising (more days, from off to on, GOVERNANCE to COMPLIANCE) is
open to whoever may configure the repository. Lowering it (fewer days, a weaker mode,
off) is for the provider owner with a sign-in from the last ten minutes only, and it
applies only to what is written from then on: S3 keeps every retention already set, and
the deletion delay follows the stored history. Every change is written to the tenant's
audit log (`storage.target.immutability_changed`, old and new setting, whether it lowered
the protection), as is every verification. The setting takes effect in the api at once and
in a worker within its storage cache time (a few minutes); objects written in between are
what the verification finds.

**In the web interface.** The card of each repository (Repositories) has an
"Immutable backups" part: the setting in words, for a directory with the plain note that it
is no immutability; the last renewal and verification; warnings first (objects found
without lock, a weaker mode than set, a renewal overdue or failed); deletions waiting for
their lock; "Change immutability" (a dialog that says what the setting protects against and
what not, and that a lowering applies only to new data and is for the provider owner) and
"Verify now". The restore point bar of the restore explorer and the restore points of a
machine show the badge described under "Restore points". The dashboard's storage tile counts
the tenant's repositories with Object Lock or a deletion delay and warns when one of them
needs attention; the provider view counts the customers with immutable backups and raises an
`immutability_warning`.

**API.** `PUT /api/v1/storage/targets/:id/immutability` (`{"mode": "compliance" |
"governance" | "delayed_deletion" | null, "days": 1..3650}`; problems
`urn:restow:problem:storage-immutability-object-lock-unavailable`, `-lowering-forbidden`,
`-mode-not-available`, and `recent-sign-in-required`), `POST
/api/v1/storage/targets/:id/immutability/verify`, `GET /api/v1/snapshots/:id/immutability`,
`GET /api/v1/endpoints/:id/snapshots/:snapshotId/immutability`. Every target in
`GET /api/v1/storage/targets` carries `immutability`.

**Permissions of the access key.** Besides reading and writing objects, an immutable S3
repository needs `s3:GetBucketObjectLockConfiguration` (detection),
`s3:PutObjectRetention` and `s3:GetObjectRetention` (renewal, verification, the badge), and
`s3:ListBucketVersions` and `s3:DeleteObjectVersion` (deleting an object for good after its
lock). It must not have `s3:BypassGovernanceRetention`, `s3:PutBucketObjectLockConfiguration`
or `s3:PutBucketVersioning`.

**What it does not protect against.** Someone who controls Restow can stop writing new
locks and stop the renewal: what was locked stays locked until its date (at least N days
after the last renewal before the attack), new backups after that are not protected. A
GOVERNANCE lock is lifted by any account with `s3:BypassGovernanceRetention`: give
Restow's key an IAM policy without it (and without `s3:PutBucketObjectLockConfiguration`
and `s3:PutBucketVersioning`), or use COMPLIANCE. Someone with Restow's key can still hide
objects behind delete markers or write garbage versions on top; the locked versions stay
and are restored by removing the newer versions or markers (`aws s3api
list-object-versions` / `delete-object --version-id`), after which `restow-restore` reads
the bucket as usual. The master key is not in the bucket; keep a copy of it (or the
exported tenant keys) away from the server, or locked data cannot be opened. Restic index
files are not locked (see above). The installation default storage cannot be made
immutable in this release: give the tenant a repository of its own (or an immutable copy).

## Write-once storage

A **write-once** (WORM) repository takes new files but refuses to delete, overwrite or rename the
ones it holds: an NFS share of a NAS with a WORM or retention lock (it answers EPERM, "Operation
not permitted"), a read-only mount (EROFS), an S3 bucket whose policy denies deletions
(AccessDenied), a bucket whose default retention locks every object. Restow backs up to such a
repository and restores from it; it never deletes anything there and says what that means.

**Detection.** Every test of a repository (adding it, "Test", a change of its location, the test
and the saving of the installation default) runs the write-once probe after the write, read and
list steps: it overwrites its probe object, reads it back, and deletes it
(`probeStorageBackend`, `packages/core/src/storage/factory.ts`, and `storage/write-once.ts`). A
refusal of either (EPERM, EACCES, EROFS, AccessDenied, Object Lock, or an overwrite the storage
accepts but ignores) makes the repository write-once; the test still passes (warning
`write_once`), and the probe object stays where the storage keeps it. The finding is recorded with
the test: for a tenant's repository in `storage_targets.config.lastProbe.writeOnce`, for the
installation default in `settings.default_storage_write_once` together with the location it was
found on (it applies only while the default still describes that location). A later test that
stops before its overwrite and delete step (a network error, a timeout, a share briefly
unmounted) found out nothing about it and keeps the finding of the last test that got there;
only new addressing or credentials of a tenant's repository drop it. The api and the
worker resolve each target's finding with its backend (`ResolvedStorageTarget.writeOnce`).
Without a test since 0.5.0 a repository counts as not write-once; the refusals below are then
found at runtime.

**What changes on a write-once repository** (the card on the Repositories page lists it):

- **No retention.** No restore point is pruned (Microsoft 365, IMAP, VMs and containers, file
  shares, machines), no `restic forget`, no `restic prune`, and the scrub's garbage collection does
  not run (a re-pack would only write the surviving chunks a second time). The pages of VMs and
  containers, file shares and machines, the retention settings of their jobs and the retention
  policies page say "Retention is not applied" (`GET /api/v1/storage/write-once`, every member of
  the tenant). The settings are kept and apply again once the backups go to another repository.
- **Repositories only grow.** Space never comes back; plan the capacity accordingly (Capacity
  planning shows the growth).
- **Lock files stay.** restic writes a lock file for every backup and cannot remove it; Restow
  judges locks by their age (stale after 30 minutes), runs no `restic unlock` there, and a restore
  check runs `restic check --no-lock` (docs/PVE.md, "Retention" and "Restore check").
- **A new chain goes to a fresh prefix.** A restic repository that must begin a new chain (a
  container after "Reset repository" or after the repository repair found it lost; a file share
  whose prefix holds data without `config` that no restore point refers to) cannot move the old
  one aside (`<prefix>.orphaned-<time>/` is a copy and a delete) nor clear its prefix. The new
  repository is created under a fresh prefix next to it, `<owner prefix>.chain-<n>/` (for example
  `pve-guests/<guest id>.chain-2/`; `packages/core/src/endpoints/repository-prefix.ts`), recorded
  per owner (`pve_guests.repository_prefix`, `file_shares.repository_prefix`, migration 0078) and
  in the container's chain record (`prefix`, `previousPrefix`), audited as
  `pve.repository.fresh_prefix`. The same happens on a repository not known as write-once when
  the storage refuses the move or the removal. Every reader uses the recorded prefix: the restic
  routes of nodes and runners, restores and browsing, the restore check and the check, retention's
  comparison, the measurement of a repository's size, a storage "move", the repository repair's
  scan, the renewal of immutable backups, and the check before an old location is removed (an
  earlier chain that no repository's current chain lies under counts like a moved-aside folder
  there). The old chain stays where it was, readable with its sealed password file next to it;
  its restore points became unavailable with the reset, as on any repository.
- **Nothing is deleted.** The repository repair leaves a lost repository where it is (the next
  backup begins under a fresh prefix); purging a file share's backups removes only Restow's
  records and counts what stayed (`kept` in the audit entry).
- **Backups, restores and checks work as usual**: they only read and add.

Machines (the Restow agent) never begin a new chain under the same id: a machine whose repository
is damaged is enrolled again and gets a new id, and with it a new prefix. Their retention is not
applied on a write-once repository either, and their page says so.

## restic repositories on copies

Machines (`endpoints/<endpoint id>/`), Proxmox VE containers (`pve-guests/<guest id>/`) and
file shares (`file-shares/<share id>/`) keep one restic repository each. Until 0.5.0 it lay on
the primary only: a copy target received the chunk store and nothing else, so servers,
containers and file shares had no second copy inside Restow. Since 0.5.0 the worker keeps a
**repository copy** of each of them on every copy target of the tenant
(`apps/worker/src/repository-copies/copies.ts`). VM disks are not restic repositories: they
are in the chunk store and have always reached a copy with the write itself.

**What lies on the copy target.** A restic repository of its own at the *same prefix*, created
with `restic init --copy-chunker-params` from the primary's repository (so deduplication works
as on the primary) and with the *same repository password* (the secret the tenant key seals;
nothing new to keep). It is filled with `restic copy`: every restore point the server keeps
that the copy does not hold yet. restic reads the source through one loopback listener and
writes the destination through another, both for this one operation
(`withRepositoryPair`, `packages/core/src/endpoints/restic-cli.ts`). `restic copy` verifies
what it reads and writes each snapshot under a new id, keeping the primary's id as the
snapshot's `original`; a copy therefore has its own `config`, keys and snapshot ids. The file
`restow-repository-copy.json` next to it marks it as a copy.

**Which restore points.** The ones the server's records name: the restore points of a
container and of a file share that are not pruned, and the snapshots a machine's runs
reported and its retention keeps (of several backups of one day the daily rule keeps the
newest: the copy holds that one, also while the primary still has the others until its
next retention run). A snapshot no record names (a run that never committed, a
snapshot a compromised machine wrote by itself) is neither copied nor ever deleted on a copy.

**When.** A pass every five minutes, in one worker at a time, copies every repository that
got a restore point since its last copy (several runs in between are one copy), and every
repository at least once a day, which catches up what a copy target that was down missed. A
copy target added later receives every repository on the next pass. A failed copy is tried
again after an hour; one that stopped half way (the copy target ran full, the connection
dropped) keeps the restore points it finished, counts the rest as missing and forgets nothing
in that pass. A pass copies at most 25 repositories; the rest follow in the next one.
Copying waits while a storage migration of the tenant runs and while new job starts are
paused for an update. It reads the primary's repository beside the API's reads and never
beside retention or the check of the same repository (the repository lock, shared).

**Retention on the copy** follows the primary's, by the same records:

- a container's and a file share's restore points that retention pruned are forgotten on
  the copy, the others stay;
- a machine's copy gets the same grouped retention as its primary (the machine's keep rules
  per group, `files` and `sql:<instance>`), dated by the end of the reporting run as the
  server recorded it, never by the time in the snapshot;
- while retention of the object is held on suspicion (`docs/RANSOMWARE.md`), nothing is
  forgotten on the copy either.

`restic forget` and `restic prune` on a copy run under the deletion pass
`repository_copy_retention`: restore mode refuses them while copying goes on, and the prune is
the one for a target short of space ("A full target": delete-only when the repack does not
fit). On a **write-once** copy target nothing is deleted: copying works, every restore point
stays, and the copy says that retention waits. A snapshot an Object Lock or the deletion
delay still protects stays until a later pass. A copy pass never deletes anything on the
primary.

**Proof.** After every copy `restic check` reads the structure of the copy (config and keys
open with the password, index and snapshots readable, every pack the index names present);
once a week it also reads a sample of the pack data back (`check --read-data-subset=2%`). Per
repository and copy target Restow records the newest copied restore point, the time of the
last copy, how many restore points are missing (the lag) and the result of the last check
(`repository_copies`, `GET /api/v1/storage/repository-copies`, per object
`GET /api/v1/storage/repository-copies/objects/<id>`). The card of a copy target shows "x of y
repositories current"; the page of a machine, container or file share shows "Copy on
<target>: current", "n behind" or "failed" with the reason. A copy that is not current for
more than two days (behind, failing, or not made at all) raises the notification
`storage.copy_behind` (a warning, once per episode; not critical, since the primary still
holds every backup).

**Reading and restoring from a copy.** When the primary no longer holds a repository, the
snapshot list, browsing, file downloads and full restores read its copy on a copy target; see
"Restoring from a copy" below.

**What a copy is not.** A repository copy is another repository, not a mirror of the
primary's files:

- promoting a copy and "keep" stay refused while the tenant has restic repositories; only a
  `move` brings the repositories themselves to a new primary;
- a `move` and the repository repair leave repository copies out (the marker): they never
  merge one into a repository or take one for it;
- the copy pass writes only into a repository it made. When the copy target already holds
  other files under the prefix (a retired primary that became a copy, the half of a split
  repository, what a cancelled `move` left), nothing is copied there and nothing is touched:
  the copy is shown as failed with that reason. Move those files away by hand (or remove the
  target) once they are no longer needed;
- removing a copy target, or removing the tenant's last copy, deletes nothing on it. Deleting
  a machine's backups (`endpoint-removal`) and purging a file share delete their repository
  copies together with the repository; a container's repository copy stays, like the
  container's repository.

### Restoring from a copy

The primary is always read first. Only when it no longer holds a repository's `config` (the
target was lost or emptied, the folder is gone) is the repository read from the first other
target that holds one: a copy target's repository copy, else a retired target or the
installation default (`repositorySource`, `apps/api/src/features/storage/repository-source.ts`;
the same search the credentials of container and file share restores have always used). The
same repository password opens it. A repository copy holds each restore point under an id of
its own and keeps the recorded one as `original`; wherever restic is handed a snapshot id, the
server hands it the copy's (`snapshotOnSource`), so nothing on a node, in a runner or in an
agent has to change:

- **Machines.** The snapshot list, browsing and downloads read the copy and show its
  snapshots with what the server recorded about each (rating, flags, data added). A restore
  task takes the id the runs recorded or the copy's own, is delivered with the copy's, and
  records the target it reads. The agent keeps its repository URL and credential: while its
  running run is the restore of such a task, the restic endpoint serves its requests from
  that copy target, and it writes and releases its lock there; any other upload is refused
  (`403`), a backup never lands in a repository copy. Every other run of the machine uses the
  primary as ever. The rule follows the run the agent registered, not the state of the
  storage: an agent runs one run at a time and registers it before it starts restic, so a
  backup never opens the copy (whose keys are not the primary's) and then writes to the
  primary, however the primary comes and goes.
- **Proxmox VE containers.** The node's volume lookup (`GET /restore-points`) answers with the
  copy's snapshot id, and the restore's credential is issued for the target that holds the
  repository (`pve_runs.storage_target`), as before. This covers a restore from Restow, a
  restore started in the PVE interface, a restore check and a boot test, which all restore
  through the node: a check that ran against the copy is a real restore of the copy.
- **Proxmox VE VMs.** Their disks are in the chunk store, which every copy target holds
  (written with the backup, mirrored by the scrub); the restore stream has always fallen back
  to a copy pack by pack.
- **File shares.** The dispatcher pins the restore run (and a copy job's run) to the target
  that holds the source share's repository; the runner's session names the copy's snapshot id.

A restore that read another target than the primary says so: the run records it
(`stats.readFrom` with the target's id, name and role; shown in the run's details for machines
and file shares and on the guest's page for containers), and so does the audit log (the
`readFrom` of `endpoint.restore.requested` and `endpoint.restore.finished`,
`pve.restore.read_from_copy`, `file_share.restore_read_from_copy`). A VM restore names no
target: its packs are read one by one from whichever target has each.

When the copy does not hold the restore point (it was not copied yet, or retention on the copy
removed it), a machine's restore task and a file share's restore are refused with
`storage-restore-point-not-on-copy` (`409`) instead of failing later in restic; a container
restore fails on the node with restic's "no matching ID".

The server's own checks stay on the primary and are never green for a repository it does not
hold: the weekly repository check of a machine or file share is red with restic's reason, a
machine's restore test from stored samples is incomplete (it rates nothing and is tried
again), and a container's check is not run, with the repository problem as the reason
(`docs/PVE.md`, "Repository problems").

A copy is for restoring, not for carrying on: backups of the object resume once the primary
holds a repository again (for a container see `docs/PVE.md`, "Repository problems"). The
restore points on the copy stay restorable throughout; the copy pass shows the copy as failed
("the repository is not on the primary storage target") and forgets nothing on it meanwhile.

## Replacing the primary

Moving a tenant off the installation default, or off one primary target onto
another (a bigger disk, a different S3 provider, centralizing several tenants onto
shared object storage, …), is a normal operation, not a maintenance event: it can be
started from the same "Add a target" dialog used for adding a copy, and the tenant's
backups and restores keep working throughout.

When a tenant already has a primary (a target row, or the installation default with
data already on it), the add-target dialog offers a role choice:

- **Copy (second location)** — the existing behaviour: the new target starts
  receiving every new backup alongside the current primary, and is mirrored with the
  primary's older data during the weekly scrub. Promote it to primary manually later,
  once it is complete.
- **Replace the primary** — starts a storage migration. The dialog also offers a
  choice for how existing backups move:
  - **Move existing backups** (recommended): the new target is added as a copy
    immediately (so every backup from this point on already reaches it), and a
    background job copies everything that existed before — every pack, backup
    manifest (mail and VM/container restore points alike), wrapped tenant key, sealed
    archive record (`tenants/<tid>/archive/`, written with the item's retention, see
    "Copies and the archive" below), and the restic repositories of the tenant's containers (`pve-guests/<id>/`), machines
    (`endpoints/<id>/`) and file shares (`file-shares/<id>/`) — onto it, verifies the
    copy against the source by SHA-256, and only then switches the primary over
    atomically. The old location is kept, attached read-only, until removed by hand.
  - **Keep existing backups where they are**: refused (`409`,
    `storage-switch-blocked-by-repositories`, and offered disabled in the dialog) while
    the tenant has containers or file shares with a restic repository: those
    repositories are written to the primary only, so after such a switch
    every container and share would find an empty repository on the new primary (the
    0.4.1 field incident: every container with an existing repository then failed with
    `repository does not exist`). Choose "move" for such a tenant; promoting a copy stays
    refused as well: a copy holds repository copies made with `restic copy` ("restic
    repositories on copies"), not the repositories the restore points name.
    Since 0.5.0 a file share counts as soon as its repository password is stored (its
    creation stores it before `restic init`), a container once its repository is created
    (its password is recorded together with its ready time, after `restic init`; while its
    first backup creates it, that running backup is what refuses the switch), and machines
    count too, revoked ones included. A running Proxmox VE backup (container or VM) or file
    share run refuses the switch as well (`storage-switch-blocked-by-runs`, "Runs and
    storage changes" below), and so does a queued or running repository repair
    (`storage-switch-blocked-by-repair`). Otherwise
    nothing is copied. The new target
    becomes the primary immediately, in the same request, once a quick write/read/
    delete probe has confirmed it is actually reachable (the same check
    `POST /storage/targets/:id/test` runs); the old one retires to `previous` in the
    same step (or, replacing the installation default, a placeholder row is created
    to stand in for it). Restoring, verifying and downloading objects protected
    before the switch keep working, reading the old location as a fallback
    (`previous`, above); so does every later backup of an object already protected
    there, which still needs its last manifest to dedupe and carry unchanged items
    forward. Only new bytes (a changed file, a new message, an object backed up for
    the first time after the switch) are ever written, and only to the new target;
    the one exception on a read-mostly queue is a restore's download export
    (`restore/download.ts`), which writes the requested ZIP to the primary, so
    `restore` counts as a writing queue for the checks below even though it never
    writes anything else. There is no background job to watch or cancel, and no
    "Retrying a failed move" case: the switch either commits right away or is
    refused up front, if the probe fails (`keep-target-unreachable`) or a backup,
    archive, retention, scrub, restore or storage-migration job for the tenant is
    still queued or active (`keep-blocked-by-active-job`): nothing already running,
    or already dispatched and about to start, is left writing to the target the
    switch is about to retire. A worker that had the tenant's storage cached from
    before the switch notices it immediately rather than waiting out the cache's
    usual few minutes: every job on a queue that writes to storage checks, before it
    uses its cached primary, whether a newer "keep" switch happened since that cache
    entry was loaded, and re-resolves it if so (`resolveStorageForJob`,
    `apps/worker/src/handlers/framework.ts`). See "Known limitations" for the one
    narrower gap this mode leaves: the weekly scrub does not check or mirror packs
    that live only on a `previous` target.

    Standalone restore (`restow-restore`, `packages/cli`) has no server and no
    Postgres chunk index, so it rebuilds its own pack index by scanning the
    `--storage` root(s) it is given rather than asking the server which target
    holds a pack. A snapshot taken after a "keep" switch can reference packs that
    were deduped against pre-switch content and so live only on the retired
    `previous` target, with only the post-switch manifest and new packs on the new
    primary. Pass `--storage` once per location for such a snapshot (current
    primary first, then the `previous` target(s)) — see `packages/cli/README.md`.
    A `move` replacement, once it finishes, makes the new primary self-sufficient
    again: a single `--storage` is enough for any snapshot after that.

The switch to the new primary only ever happens after Restow has proven, by copying
and hashing, that nothing is lost: an existing backup is never made unreachable by a
`move` replacement.

### The migration job (`move`)

A `move` migration runs as a background job (`storage_migration` queue) with its own
row (`storage_migrations`) tracking its state, independent of the generic job list, so
the target's card in the Repositories section can show it directly:

1. **queued** — accepted, waiting for a worker.
2. **copying** — every pack, manifest, wrapped key and sealed archive record the current primary holds (or,
   without a primary row, the installation default), and every file of the tenant's
   restic repositories (see "restic repositories in a move" below), is compared
   against what the
   destination already has (by size) and copied if missing or different. A tenant
   that chose "keep" for an earlier replacement may still have packs that live only
   on that retired target: this pass reads from it too (read-only, never written to),
   so a later "move" copies those older packs across as well instead of reporting
   them missing. Sequential, with a short pause between objects on purpose: a large
   backfill must not starve the disk or network a tenant's running backups and
   restores also use. A single object's read or write failure (a timeout, a dropped
   connection) is retried a few times before it counts against the migration; a
   hash or size mismatch is not, since re-reading the same bytes would not change the
   answer. Progress is checkpointed periodically, so an interrupted attempt resumes
   from where it left off rather than starting over: a graceful worker shutdown (a
   deploy or upgrade) or an about-to-expire background-job lease is not treated as a
   cancellation, only an admin's own cancel request is — the card keeps reading
   "Migrating NN %" and the job continues on the next worker. The card shows
   "Migrating NN %" with an estimated time left once the pace is known.
3. **verifying** — once every object is present, a second, independent pass reads
   both sides back and compares SHA-256, catching anything the cheaper size check in
   the copying phase could have missed and re-confirming everything after a resume.
   Any mismatch, or an object missing on the source, fails the migration outright:
   **the switch never happens, and the old primary keeps serving reads and writes
   exactly as before.** The failure reason (which objects, why) is recorded on the
   migration and shown on the card behind a "Technical details" disclosure (it can
   name storage keys and the tenant id, so it stays out of the headline); the
   half-copied destination stays a plain copy target that can be removed, or left as
   a genuine copy, or tried again (see "Retrying a failed move" below).
4. **reconciling** (still shown as "Verifying" on the card) — right before the
   switch, the item list is rebuilt from the source and compared against what has
   been copied and verified so far. This catches a backup that was already running
   when the target was added (its storage was resolved before the destination
   existed) or one that started in the few minutes the worker's storage cache takes
   to notice a new target: any pack, manifest or key it wrote that the migration had
   not seen yet is copied and verified too. While a backup or archive job of the
   tenant is still active and nothing new turns up, the switch waits and looks again;
   past a bound it gives up for this attempt (without failing the migration) so a
   very active tenant does not pin a worker slot indefinitely, and the next attempt
   picks up where this one left off. Once reconciliation is otherwise ready to
   proceed, the switch additionally waits out that same worker storage-cache delay,
   measured from when the destination was added: every worker process must have had
   the chance to notice it as a copy before the old primary is retired to read-only,
   or a backup starting on a worker with a stale cache would write only to the
   location about to become unreadable. Still shown as "Verifying"; nothing is
   marked failed while it waits.
5. **switching** — one atomic transaction: the destination becomes `primary`; the old
   one becomes `previous` (or, when it was the installation default, a placeholder
   row is created to stand in for it, so restore and verify have something concrete
   to read it from). The transaction re-checks, right before committing, that the
   source row is still the primary and the destination's addressing has not changed
   since the job opened it; either changing (a race the RBAC rule above should
   already prevent) fails the migration instead of corrupting the switch. Not
   cancellable: it commits within moments, so a cancel request at this point would
   not stop it, only leave a confusing audit trail next to one that says it
   switched.
6. **completed** — the card shows "Switched" with the date.

A running migration is `Cancelled` on request (a tenant admin or provider admin, from
the target's card): a queued job is withdrawn immediately, a running one stops at its
next checkpoint. Either way nothing the migration touched is left half-done — the
old primary was never modified, and the copy stays a copy. The same "Cancel" action
also recovers a migration whose background job died for good on its own (an
unreachable destination that exhausted its retries, a worker that never came back):
if the job is no longer running, the click finalizes the migration to match — as
failed, with the job's own error, or as cancelled — instead of leaving the card
reading "Migrating" forever with a cancel button that does nothing. The card notices
this on its own, without waiting for that click: a migration whose job has already
ended shows as "stalled" with the job's own cause as soon as the page loads it, so
the admin knows to cancel it rather than watching a progress bar that stopped
moving. Garbage collection is not fooled by a stalled migration either — it stops
waiting on one whose job is gone, the same as it would once the row is reconciled.

A pass gives up early, the same way, after several objects in a row fail outright
(not a hash or size mismatch — a plain read or write failure): past that point the
destination itself is treated as unreachable rather than one object having a bad day,
and the migration fails with that cause instead of retrying every remaining object at
the same doomed rate. A manifest that retention prunes while a pass is running (its
snapshot expired mid-migration) is the opposite case and never counts against the
migration at all: it is simply left out, since there is nothing left to move.

### restic repositories in a move

Containers (`pve-guests/<guest id>/`), machines (`endpoints/<endpoint id>/`, revoked ones
included) and file shares (`file-shares/<share id>/`) keep one restic repository each on
the primary. A target that was never a copy holds none of them, and a copy holds repository
copies with snapshot ids of their own ("restic repositories on copies"), so a switch without
the repositories themselves would leave every restore point pointing at nothing. A `move`
therefore copies them too, file by file
(`apps/worker/src/handlers/storage-migration-restic.ts`); a repository copy on a copy target
(marked with `restow-repository-copy.json`) is no part of a repository and is left out of a
move and of the repository repair:

- Each repository is collected from every place it may lie: the current primary, the
  copies (the destination aside), every `previous` target and the installation default
  (also when it is no target of the tenant any more). A run that went on while the
  primary changed (before 0.5.0) left its first files on one target and the rest on
  another; both halves are merged. restic names its data, index, snapshot and key files
  by the SHA-256 of their content, so the same name is the same file wherever it lies.
- A repository's chain is the one whose `config` the primary holds, else the first target
  that holds one. A target with another `config` holds another chain (a new chain on the
  primary, the old one on a retired target): its files are never mixed in.
- A repository that was created but cannot be copied whole from all targets together
  (data without a `config` or without a key anywhere, two different chains and none on the
  primary) rejects the migration before anything is copied, and
  again right before the switch, naming each one: switching would leave it behind
  silently. Run the repository repair first ("Repository repair" below).
- Data, index, snapshot and key files are copied and verified against their hash, like
  packs against theirs, so damage on the source fails the migration (`source_corrupt`)
  instead of spreading. `config` and the sealed password file are compared with the
  source. `locks/` is skipped.
- Right before the switch, restic checks the structure of every copied repository on the
  destination (`restic check` without reading pack data: config and keys open with the
  password, index and snapshots read, every pack the index names present). A repository
  that fails rejects the migration; the old primary stays as it is.
- Reconciliation also waits while a Proxmox VE backup or a file share run of the tenant is
  running (they write to the old primary), and retention of containers and file shares
  waits for a running migration, so no restic file is pruned away under it. A restic file
  that is gone from the source when it is copied (restic's own maintenance) is skipped.
- Up to 32 repositories of a kind are listed one prefix at a time; more are listed under
  the kind's prefix once and sorted out by id. A directory target walks only the folder a
  prefix lies in (since 0.5.0; before, every listing walked the whole tree).

The switch itself runs under the tenant's storage lock, which credential issue takes too
("Runs and storage changes"): when a container backup or a file share run is running at
that moment, the switch waits, brings over what it wrote and tries again; a machine
enrolled while the migration ran (its agent writes to the current primary) rejects it.

### Runs and storage changes

Every restic request of a container backup or a file share run goes to exactly one target:
the one its credential was issued for (`pve_runs.storage_target`,
`file_share_runs.storage_target`: a target id, or `installation_default`), recorded with
the tenant's storage generation (a fingerprint of its `storage_targets` rows,
`packages/db/src/storage-generation.ts`). Before 0.5.0 the target was looked up per
request, through caches of up to one (API) or five (worker) minutes: a promotion on
2026-10-16 changed the primary in the middle of a container's first backup, and its
config, keys and first packs landed on the installation default, its later packs, index
and snapshot on the new primary. The restore point looked fine and could not be restored.

- Credential issue (container backups and restores, the file share dispatcher) and every
  change of the primary (promoting a copy, "keep", the switch of a "move") take a
  per-tenant advisory lock (`lockTenantStorage`). A credential is never issued for a
  primary a concurrent switch is about to retire, and a switch sees every run that
  already has one.
- Promoting a copy and "keep" refuse while such a run is running
  (`storage-switch-blocked-by-runs`: a Proxmox VE backup of a container or a VM, or a file
  share run); the switch of a "move" waits.
- Enrolling a machine takes the same lock while it records the machine: a change of the
  primary either committed before (the repository is created on the new primary) or sees
  the active machine and refuses. `restic init`, the sealed password file and the cleanup
  after a failed enrollment all use the one target resolved then.
- A backup whose target stopped being the primary anyway (a change straight in the
  database, a run from before the update) gets `403 storage-switched-during-run` for every
  write (restic takes a 403 as final; it would retry a 409 for minutes) and fails cleanly;
  it may still read and release its own locks on its own target. Asking for a credential
  again then answers `409` with the same type.
  The next run uses the new primary.
- A restore reads from the target that held the repository when its credential was
  issued: the primary, a copy, a retired target or the installation default.
- The caches of the resolved targets (the API's chunk store and endpoint storage, the
  worker's per-tenant storage for write-queue jobs, the file share dispatcher and the PVE
  maintenance) compare the storage generation instead of relying on their time to live
  only, so a change of the primary is seen at the next request.

### Repository repair

For installations whose restic repositories were split across targets, or dropped with the
installation default by a promotion of 0.4.1, the Repositories page has a **Repository
repair** card (`apps/worker/src/handlers/repository-repair.ts`,
`POST /storage/repositories/scan`, `POST /storage/repositories/repair`):

- **Scan** lists every restic repository of the tenant on every place it may lie (the
  primary, the copies, the retired targets, an old location attached read-only, and the
  installation default) and classifies it: `ok` (complete on the primary), `elsewhere`
  (complete on another target), `split` (its parts on more than one target), `data_only`
  (data, but no `config` or no key anywhere), `password_only` (only the sealed password
  file), `missing`, or `conflict` (two different repositories under one prefix, none on the
  primary). It shows what each target holds and changes nothing. A place that could not be
  read is named on the card: one that did not answer, and a directory target whose folder
  is empty or does not exist (a share that is not mounted lists as an empty folder, not as
  an error; `rootState` in `packages/core/src/storage/local.ts`). Audited as
  `storage.repositories.scanned`.
- An old location that may still hold the missing parts (a restored copy of
  `/data/chunks`, a snapshot of the NAS share) can be attached first: "Attach an old
  location read-only" in the add-target dialog (role `previous`). Nothing is written there.
- **Repair** (an administrator, a recent sign-in and the typed word `REPAIR`, on the
  newest completed scan) is refused (`storage-repair-blocked`) while a Proxmox VE backup,
  a file share run or a storage migration of the tenant is active, and the worker checks
  again when it starts. From the moment it is queued until it ends, backups of containers
  and file shares get no credential (`storage-repair-running`, the share run's failure
  `share.repository_repair_running`) and the primary does not change
  (`storage-switch-blocked-by-repair`); both checks run under the tenant's storage lock.
  The repair refuses a scan that could not read every place, and stops without changing
  anything when a place does not answer now (the installation default included) or a
  target the scan read is gone. It plans again from a fresh listing and acts only on a
  repository whose class and holders are what the confirmed scan showed; anything else is
  reported as changed and left. Per repository, under the lock retention, the check and the
  file restore's reads take (`pveGuestRepositoryLockKey`, the machine's and the share's):
  - `elsewhere`, `split`: copies every data, index and snapshot file the primary lacks
    onto it, each verified against its SHA-256, and stops at the first that fails; only
    after all of them the keys, then the password file, then `config` (compared with its
    source). Then `restic check` (structure) and `restic snapshots` run there. When a file
    cannot be copied, or restic finds the result not sound, the keys and `config` this
    repair copied are moved aside again (`<prefix>.orphaned-<time>/`), and a container
    records `pve-repository-repair-failed`: its backups, retention and check refuse until a
    repair succeeds (a later repair checks such a container again even when it looks
    complete) or the repository is reset. Restore points created before the repair began
    whose restic snapshot is not in the rebuilt repository become unavailable; the chain
    goes on, and the guest page says so ("Repository repaired"). Audited as
    `storage.repository.merged`.
  - a container's repository that cannot be opened (`data_only`, `password_only`): its
    restore points become unavailable ("lost"), what lies at its prefix on the primary is
    moved aside to `pve-guests/<id>.orphaned-<time>/` (never deleted), and the next backup
    begins a new chain; the guest page says so. Audited as `storage.repository.lost`.
  - `missing` (on no place at all) is left as it is: an unmounted share looks the same.
    "Reset repository" on the guest page is the deliberate way to let its points go.
  - everything else (a `conflict`, a machine's or a file share's incomplete repository) is
    listed and left as it is for an operator to decide.
- **What it does not bring back:** the restore points of a chain that 0.4.2 to 0.4.12
  replaced silently (`pve.repository.reinitialized`, reason `missing`). The primary holds
  the new chain, complete, so the scan classes it `ok`; the old chain on another place is
  no part of it, and its restore points stay unavailable. Attaching the old location
  read-only keeps that data from being forgotten (removing that target is refused while
  only it holds it), and the old chain can be restored by hand with restic from there
  (its password is sealed next to it in `restow-repository-password.json`).
- **Moved-aside folders** (`<prefix>.orphaned-<time>/`, from the repair or from a backup
  that began a new chain after a reset) are not copied by a `move` and are not part of any
  repository. Removing a retired target is refused (`previous-holds-moved-aside`) while it
  is the only place that holds one: copy it elsewhere or delete it by hand once it is not
  needed.
- One scan or repair runs at a time per tenant; a worker that stops in the middle queues
  it again, and every step is safe to repeat.

### Copies and the archive

The sealed record of each archived mail (`tenants/<tid>/archive/<year>/<month>/<id>.json`,
`packages/core/src/archive/FORMAT.md`) is written once, to the primary and every copy that
exists at that moment, with an Object Lock retention up to the end of the item's retention
period. Since 0.5.0 everything that copies a tenant's store copies these records too: the
scrub's mirror onto a copy added later, a `move` migration, and the completeness check
before a copy is promoted (it counts them under "Sealed archive records"). Each record is
copied with the `retention_until` of its catalog row, so on an Object Lock target it is
locked exactly as long as on the target it was first written to; records of items deleted
after their retention are not copied. The scrub's mirror reads the records from the catalog
(`archive_items`, by creation time, a thousand at a time), not from a listing of the archive
prefix: a scheduled (sample) check takes only the records written since the position the last
check reached for the same copies (kept in its result, `copies.archiveThrough`, and moved only
while every record before it is on every copy); a full check, and the first check after a copy
is added, replaced or pointed elsewhere, goes through every record. Records younger than 15
minutes wait for the next check (their row may not be committed yet). Before 0.5.0 none of these paths knew the archive
prefix: a target added later never received the records written before it, and after a
`move` they existed only on the retired location.

## Removing an old location

A `previous` target is never deleted automatically. Once an admin no longer needs the
older backups it holds — retention has caught up, or they were confirmed restorable
from the new primary — they remove it from Restow like any other target, through a
confirming dialog (this is the point past which those older snapshots are no longer
reachable through Restow). The data at the location itself is not touched; removing
it there, if desired, is a separate step at the storage provider.

A target cannot be removed while an unfinished migration still references it (as
either side); the API refuses with a clear reason instead of leaving a dangling
reference. A `previous` target additionally cannot be removed while it still holds
backup data no other target has: Restow lists its packs against the tenant's current
primary and copies before every removal and refuses with `previous-holds-exclusive-data`
if any pack exists only there — the exact packs a "keep" replacement left behind — or any
committed manifest, wrapped key or sealed archive record of an item the archive still holds
(since 0.5.0; before, archive records were not compared, and a location holding the only
copy of years of records could be removed). The same
holds for restic repositories (`previous-holds-endpoint-repositories`): any data, index,
snapshot, key or `config` file of a container's, machine's or file share's repository
that no current target has blocks the removal, not only a `config` (a run that a switch
split left early packs on the old target while its `config` was on the new one as well).
A folder the repository repair or a new backup chain moved aside
(`<prefix>.orphaned-<time>/`) that no current target has blocks it too
(`previous-holds-moved-aside`): a `move` does not copy those folders, so copy it elsewhere
or delete it by hand once it is not needed.
Progress markers (`tenants/<tid>/progress/`, see
[Restore mode and progress markers](#restore-mode-and-progress-markers)) are ignored here:
they are never copied and never block a removal. While restore mode is on, no target can be
removed (409 `urn:restow:problem:restore-mode`).
Run a `move`
replacement first to copy them onto the current targets, which also closes the
scrub's integrity-checking gap for them (see above); removal is possible once nothing
depends on the old location any more.

## Known limitations (this release)

Honestly stated rather than hidden, per Restow's own rule that known limits are shown,
not papered over:

- **The repository repair rebuilds, it does not decide.** A machine's or a file share's
  repository that cannot be opened (no `config` or no key on any target), and two
  different repositories under one prefix, are listed by the scan and left as they are;
  such a repository also stops a `move`. A machine's page does not show the scan's finding
  yet: read it on the Repositories page.

- **A repository copy does not replace the primary's repository.** When the primary lost a
  repository, every restore reads its copy ("Restoring from a copy"), but backups of that
  object are refused until the primary holds a repository again; neither a `move` nor the
  repository repair rebuilds a primary's repository from a repository copy, and a copy cannot
  be promoted while the tenant has restic repositories. A machine's restore test that the
  agent runs itself (hash samples restored on the machine) is not served from a copy: it runs
  against the primary and cannot rate a repository that is not there. A boot test that read
  a copy says so on its run and in the audit log only, and a VM restore names no target.
- **Repository copies cost the copy target's space once more** (deduplicated per repository,
  like on the primary), and the first pass after the update copies every repository in full,
  25 repositories per pass. A copy target that already holds other files under a repository's
  prefix gets no copy there (see above).

- **There is no migration back to the installation default.** A tenant whose own
  primary already holds backups cannot replace it with the installation default: a
  storage migration's destination is always a target row with its own addressing,
  and the `installation_default` placeholder carries none. The tenant's storage page
  says so instead of offering it. Going back is possible while the own primary holds
  no data (it is simply removed). Moving a tenant's data onto the default's location
  by hand is not supported either.
- **Changing the installation default never moves data.** It is refused while tenants
  keep data on the current default (see "Changing it without orphaning data"). Mail
  file uploads still in staging and unexpired exports are not counted as data there:
  change the default while no import or export is pending.

- **A "keep" replacement's older packs are outside the weekly scrub's reach.** Once a
  `previous` target holds packs no current primary or copy ever received, the scrub's
  integrity checking and copy mirroring skip them: checking them against targets that
  never held them would wrongly report them "missing" and mark them damaged, and
  there is nothing to mirror them onto besides the retired target itself. Restore,
  verify and download still reach those objects (through the same read-only
  fallback), and nothing about them is lost; they simply go unchecked by the scrub
  until a `move` replacement copies them onto the current targets and closes the gap
  (see "Garbage collection yields to a migration" above).
- **A tenant with a pack already marked damaged (from an earlier scrub finding no
  intact copy anywhere) cannot complete a `move` replacement while that pack is still
  referenced by an active snapshot**: copying it fails with `source_corrupt`, on every
  attempt, since re-reading the same damaged bytes never changes the answer. Recover
  the pack first — a full backup of the affected object writes intact content again,
  as far as the source still holds it, and the next scrub then clears the damaged
  mark once every one of its chunks is confirmed elsewhere — or, if the object is
  intentionally being let go, remove its snapshots through retention so nothing
  references the damaged pack any more; either way, retry the migration once the
  block is gone.
- **Active machines still block a storage change.** The repositories of servers and
  clients backed up by the Restow agent (`docs/AGENT.md`) live in the primary target
  under `endpoints/<endpoint id>/`. A `move` copies them (see "restic repositories in a
  move"), but an active agent keeps writing to the old primary while it runs. While any
  machine of the tenant is active, Restow therefore refuses every change of the primary:
  replacing it (move or keep) and promoting a copy answer `409` with
  `storage-active-endpoints`. A
  repository also counts as data of the primary, so its location cannot be changed and
  it cannot be removed while it holds repositories. To change the primary of such a
  tenant, revoke or uninstall the machines first, switch, and enrol them again (new
  repositories on the new primary). The repositories of the revoked machines stay on
  the old target, which becomes `previous` (or a copy) and remains a read-only fallback,
  so their backups can still be browsed and downloaded; that target cannot be removed
  while it alone holds such a repository, or a container's or file share's
  (`storage-previous-holds-endpoint-repositories`); a `move` copies them across.
- **Write-once storage is known from its test.** A repository's finding comes from its last test
  (see "Write-once storage"); one never tested since 0.5.0 counts as not write-once, and retention
  still tries to delete there until a test finds it out (a refused deletion of a container's lock
  files, or of an old repository at a reset, is caught at runtime). Test each repository once
  after the update. A machine's or file share's lock files on such a share are not cleared either.

- **Immutable backups have limits of their own** (see "Immutable backups" for the whole
  picture). The installation default cannot be made immutable; give the tenant a repository
  of its own or an immutable copy. A directory gets only a deletion delay that Restow keeps,
  never immutability. A worker picks a changed setting up within its storage cache time (a
  few minutes; the api at once), and objects written in between carry the old setting; the
  verification shows them. The renewal runs inside the tenant's retention job: a tenant
  whose retention schedule was deleted is not renewed, and its repository page says the
  renewal is overdue. restic index files are not locked (`restic repair index` rebuilds
  them). Space of deleted data comes back only once its lock has run out, up to the period
  plus seven days later. A file share whose repository is still locked cannot be purged
  before the lock ends.
