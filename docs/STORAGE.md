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
the web interface with the opt-in mounter (Installation > Network shares, `docs/MOUNTS.md`); it
then appears in the api and the worker at `/mnt/restow/<name>`. The path field of a
"directory" target (and of the installation default storage) also takes an NFS address
such as `nas.local:/volume1/restow` or `nfs://192.168.1.10/export/backup`: the form offers
to mount it right there and then fills in `/mnt/restow/<name>` (`docs/MOUNTS.md`, "From
the storage form"). Every target has a role:

- **primary** — receives every new backup first. A tenant has at most one. A tenant
  with no primary target of its own uses the installation's default storage as its
  primary (see "Installation default" below: the default a provider owner saved under
  Installation → Default repository, otherwise the environment's `STORAGE_TARGET` /
  `STORAGE_LOCAL_PATH` / `S3_*` settings), so a fresh install works out of the box
  with a single container plus Postgres.
- **copy** — receives every new backup too, in addition to the primary. Data written
  before the copy existed is mirrored onto it, verified by hash, during the weekly
  scrub. Any number of copies is allowed; a copy can later be promoted to primary
  (`POST /storage/targets/:id/promote`) once it is proven complete.
- **previous** — a retired primary, left behind by a storage migration (see below).
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
(`docs/ARCHIVE.md`). In 0.1.0 Object Lock covers only the archive's item records, not
the packs that hold the message content, and backup data carries no Object Lock
retention; local and NFS targets are shown as having no hardware WORM.

## Installation default

The installation default is the storage every tenant without a primary target of its
own writes to. It is one location for the whole installation, shown under
Installation → Default repository (`/installation/default-storage`).

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
own under these prefixes.

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
    manifest, and wrapped tenant key — onto it, verifies the copy against the source
    by SHA-256, and only then switches the primary over atomically. The old location
    is kept, attached read-only, until removed by hand.
  - **Keep existing backups where they are**: nothing is copied. The new target
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
2. **copying** — every pack, manifest and wrapped key the current primary holds (or,
   without a primary row, the installation default) is compared against what the
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

### Retrying a failed move

A failed `move` can be tried again from its card ("Retry") instead of deleting the
destination and adding it again (which `location_overlap` would refuse anyway while
it is still there). This re-queues a fresh job for the same destination and source;
objects already copied and verified are found in place quickly rather than rewritten,
so a retry after a transient problem (the destination briefly unreachable) picks up
close to where the failed attempt left off. "Keep" has no job to retry — it either
switches immediately or is refused up front (see above).

### Garbage collection yields to a migration

The weekly scrub's garbage-collection pass (re-packing and deleting unreferenced
chunks) does not run at all for a tenant while a `move` migration is active: the
migration is reading the primary's packs to copy them, and is about to retire it, so
nothing may be re-packed or deleted underneath it. This is checked both before the
scrub starts and continuously while it runs, so a migration that begins after
garbage collection is already under way stops it just as reliably as one that was
already running. The scrub's other duties (integrity checking, mirroring genuine copy
targets) are unaffected. Once the migration finishes — completed, failed or cancelled
— garbage collection resumes on the next scrub run.

A tenant whose most recent replacement was a "keep" has a permanent, narrower
exclusion on top of that: packs written before the switch live only on the retired
`previous` target, which the current primary and copies never had. The scrub does not
check or mirror those packs (checking them against targets that never held them would
wrongly report them "missing" and mark them damaged), so they are not covered by
integrity checking or the copy job until a later `move` replacement copies them onto
the current targets and closes the gap. This is a known, accepted limitation of
"keep", not a bug: the packs are exactly where "keep" said they would stay, on the
target the operator chose to leave them on.

## RBAC and audit

Starting, cancelling or retrying a migration is available to tenant admins and
provider admins only, the same as every other storage-target change (`tenant_admin`
minimum role; local filesystem targets additionally require a provider admin, since a
mounted path is part of the server, not the tenant's own configuration). Every step —
started, verify failed, switched, cancelled — is written to the tenant's audit log
with the actor, the source and destination target, and (once known) the byte and
object totals; a retry is recorded as a new "started" entry so the log reads as what
actually happened (a second attempt), not as a repeat of the first one.

While a migration is unfinished, neither its source nor its destination can be edited
(a location change) or promoted through the ordinary copy-promotion shortcut: the
migration's own worker job opened both at the start and keeps writing to that same
addressing throughout, so changing either out from under it, or promoting a third
target to primary, would collide with its own atomic switch. The API refuses both
with `migration-in-progress`, the same reason starting a second migration gets; a
name-only edit (no location change) is unaffected.

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
if any pack exists only there — the exact packs a "keep" replacement left behind.
Run a `move`
replacement first to copy them onto the current targets, which also closes the
scrub's integrity-checking gap for them (see above); removal is possible once nothing
depends on the old location any more.

## Known limitations (this release)

Honestly stated rather than hidden, per Restow's own rule that known limits are shown,
not papered over:

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
- **Endpoint backup repositories are not moved by a storage change.** The repositories of
  servers and clients backed up by the Restow agent (`docs/AGENT.md`) live in the
  primary target under `endpoints/<endpoint id>/`, and a replacement copies only
  `tenants/<tenant id>/...`. While any machine of the tenant is active, Restow
  therefore refuses every change of the primary: replacing it (move or keep) and
  promoting a copy answer `409` with `storage-active-endpoints`, because the agent,
  retention and the checks would find an empty repository on the new primary. A
  repository also counts as data of the primary, so its location cannot be changed and
  it cannot be removed while it holds repositories. To change the primary of such a
  tenant, revoke or uninstall the machines first, switch, and enrol them again (new
  repositories on the new primary). The repositories of the revoked machines stay on
  the old target, which becomes `previous` (or a copy) and remains a read-only fallback,
  so their backups can still be browsed and downloaded; that target cannot be removed
  while it alone holds such a repository (`storage-previous-holds-endpoint-repositories`).
