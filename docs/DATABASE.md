# The database location

This document is for operators. It explains where Restow's PostgreSQL keeps its
data, how Restow watches the free space under it and under the local repository,
how to move the database to another disk from the web interface (Installation ›
Database), and how to do the same by hand.

## Where the data lives

The `postgres` service mounts its data directory from what two lines of `.env`
say (`docker-compose.yml`, release 0.4.0 and later):

```yaml
volumes:
  - type: ${RESTOW_POSTGRES_DATA_TYPE:-volume}
    source: ${RESTOW_POSTGRES_DATA:-pgdata}
    target: /var/lib/postgresql/data
    bind:
      create_host_path: false
```

| `.env`                                                             | Data directory                                   |
| ------------------------------------------------------------------ | ------------------------------------------------ |
| both lines empty (the default)                                     | the Docker volume `restow_pgdata`, in Docker's data directory (`/var/lib/docker`, usually the system disk) |
| `RESTOW_POSTGRES_DATA_TYPE=bind`, `RESTOW_POSTGRES_DATA=/mnt/…/restow-postgres-<time>` | that directory on the host |

`.env` carries the location, not a compose override, because `.env` is the one
file every way of running the stack reads: the updater never changes the compose
file, and `install.sh` replaces `docker-compose.yml` with the release's file on a
rerun and calls Compose with `-f`, which ignores `docker-compose.override.yml`.
`install.sh` refuses to put in place, or start the stack from, a compose file
that does not read `RESTOW_POSTGRES_DATA` while `.env` sets it.

`create_host_path: false` matters: when the disk under the directory is not
mounted (a volume that did not attach after a reboot), Docker refuses to start
PostgreSQL instead of creating an empty directory that PostgreSQL would
initialise as a new, empty database. The move puts the data into a subdirectory
`restow-postgres-<yyyymmdd-hhmmss>` of the directory you name, so even a mount
point that is empty while unmounted gives a missing path, not an empty one.

## Disk space

Installation › Database shows the location, the size of the data directory, the
file system and the free space under it, and the free space under the local
default repository (`STORAGE_LOCAL_PATH`, or a local default saved under
Installation › Default repository). It also shows what the next update needs on
disk ([docs/UPDATING.md, Disk space](UPDATING.md#disk-space)).

A disk counts as **low** when less than a tenth of it is free, and always below
5 GiB (a quarter of a disk smaller than 20 GiB). Every 15 minutes the api checks
both disks; when one becomes low it raises the installation event
`installation.disk_low` once: a notification in the bell of the provider
administrators, and e-mails and webhooks of every alert rule that lists “Low disk
space” (only provider administrators can choose it). It is raised again only
after the disk recovered to a fifth above the line in between. The database's disk
is read through the opt-in updater. Without the updater (0.5.0), the api reads it on
the volume `restow-data`, which it mounts at `/data`, while the database is in its
named volume (both lines of `.env` empty, or `RESTOW_POSTGRES_DATA_TYPE=volume`): both
volumes lie in Docker's volume directory, on the same disk; the page says "read without
the updater". A database moved to a directory of the host is watched only through the
updater. From 0.4.5 the api also watches the server's system disk (`/` as the api
container sees it: the disk under Docker's data directory) with the same rule, and keeps
its free space once an hour for two weeks: the trend the dashboard shows when a
repository lies on that disk ([docs/STORAGE.md, Where backups land](STORAGE.md#where-backups-land)).
In a standard installation the three are one disk. From 0.5.0 a low disk raises **one**
warning however many of the three lie on it: the api compares their devices (the system disk
as `/` and the files Docker mounts into the container show it, else the device number of the
path), and the warning, its mail and its bell line name every place on the disk (`details.disks`,
the system disk first), with the emergency reserve once. Places on different disks warn each on
their own. While one place on a disk is still low from an earlier warning, another place on the
same disk running low raises no second one. The page shows the database's and the repository's
disk as one line when they are one disk. A database moved to a directory of the host, read by the
updater, cannot be told apart from here and keeps a warning of its own.

The same card holds what every storage target keeps free for everything else on it, the
installation's space rule of the size and space guard: by default 5 % of the target's size, at
least 20 GiB, at most 500 GiB ([docs/STORAGE.md, Unusually large runs](STORAGE.md#unusually-large-runs)).
Only the owner changes it.

## Disk full

When the disk under PostgreSQL fills up to the last byte, PostgreSQL stops (it cannot
even write `postmaster.pid`), the api cannot start, and the web edge shows its
maintenance page. Getting it back used to need a shell or a hoster's rescue console.
Since 0.5.0 Restow keeps an **emergency reserve** for that case.

### The emergency reserve

The api keeps a file of real blocks, `restow-disk-reserve` on the volume `restow-data`
(`/data/restow-disk-reserve` in the api container), 2 GiB by default. It is written with
random bytes, so a file system that compresses or deduplicates still keeps its blocks; it
is never sparse. In a standard installation that volume, PostgreSQL's volume `pgdata` and
Docker's data directory are on one disk, so freeing the reserve gives that disk room.

- **Freed by itself.** Every 30 seconds the api compares the free space of that disk with a
  floor (1 GiB by default). Below it, the api deletes the reserve and raises
  `installation.disk_reserve_released` (critical: the bell of the provider administrators,
  the provider's mandatory recipients, and every alert rule that lists "Emergency disk
  reserve freed"). Whenever the api container starts, it does the same check before the
  migrations, without the database: when PostgreSQL stopped on a full disk, the reserve is
  freed before anything else, PostgreSQL (which Docker restarts by itself) gets room to
  start, and the alert goes out once the database answers.
- **Written again.** Once the disk has room for the low-space threshold plus the reserve
  (on a 100 GiB disk: 10 GiB + 2 GiB), the api writes the reserve again and raises
  `installation.disk_reserve_restored`.
- **Installer.** On a new server (and a restore onto one) `install.sh` writes it right after the
  first start, whenever the disk keeps the floor besides it
  (`docker compose exec api restow disk-reserve create --initial`). On an existing installation
  it uses the api's own rule (the low-space threshold plus the reserve), so the api does not
  free it again at once with a critical alert.
- **Settings** (`.env`, read by the api): `RESTOW_DISK_RESERVE_MB` (size, default 2048;
  `0` switches it off), `RESTOW_DISK_RESERVE_FLOOR_MB` (floor, default 1024),
  `RESTOW_DISK_RESERVE_PATH` (default `/data/restow-disk-reserve`; its name must begin with
  `restow-disk-reserve`, any other value takes the default).
- **Only its own file.** The reserve begins with a mark (`RESTOW-DISK-RESERVE v1`). Only a
  regular file with that mark is ever replaced or deleted; anything else at the path (another
  file, a symbolic link) is left alone, and the page says "something else is at the path". One
  writer at a time: `restow-disk-reserve.lock` names the writing process; the lock of a process
  that is gone is taken over and its half-written files (`restow-disk-reserve.writing-*`) are
  removed. The check at the container's start gives up after 30 seconds (a data volume that
  hangs), and the api starts anyway.

Installation › Database shows the reserve: there, freed, or waiting for room. The low disk
space warning names it and the command that frees it.

Known limits:

- The reserve helps the disk it is on. A database moved to another disk (Installation ›
  Database) is not protected by it; keep room on that disk yourself.
- On a copy-on-write file system with snapshots of the volume (btrfs, ZFS), deleting the
  file frees nothing while a snapshot still holds its blocks.
- Freeing the reserve buys room, not time: a backup into a local repository on the same
  disk keeps writing. Stop it, or let the size and space guard hold it
  ([docs/STORAGE.md, Unusually large runs](STORAGE.md#unusually-large-runs)).
- The check runs every 30 seconds: a disk that fills faster than that can still reach
  0 bytes. The reserve is then freed at the next check, or at the api's next start.

### Freeing the reserve by hand

```sh
# while the api runs
docker compose exec api restow disk-reserve release
# while the api does not start (needs no database)
docker compose run --rm --no-deps --entrypoint restow api disk-reserve release
# without Docker's help: delete the file on the host
sudo rm /var/lib/docker/volumes/restow_restow-data/_data/restow-disk-reserve
# what the reserve is now
docker compose exec api restow disk-reserve status
```

Then start what stopped (`docker compose up -d`) and clean up from the interface.

### Safe cleanup

What can go, in this order:

```sh
# images no container uses (old releases; the updater removes most after an update)
docker image prune -a
# the build cache (an installation built from source)
docker builder prune
# the database dumps the updater kept before updates, oldest first
docker compose --profile updater exec updater ls -ltr /state/dumps
```

Delete the oldest dumps in the Updates tab (it refuses the one a rollback may still need).
When the api does not run, remove the oldest file by hand
(`docker compose --profile updater exec updater rm /state/dumps/<file>`), never the newest.

Then look at what grows: the backups in a local repository on this disk (retention, or a
repository on another disk or on S3: docs/STORAGE.md), the container logs
(`docker system df -v`).

**Never delete** PostgreSQL's data (`pgdata`, the directory `RESTOW_POSTGRES_DATA` names,
and in particular `pg_wal` inside it: those files are the database, not logs), and never
a Docker volume (`docker volume rm`, `docker system prune --volumes`,
`docker compose down -v`): the volumes hold the database, the local repository and the
keys of the updater and the mounter.

## Moving the database (Installation › Database)

Needs the opt-in updater ([docs/UPDATING.md](UPDATING.md#the-opt-in-updater)) and
the `docker-compose.yml` of release 0.4.0 or later. Checking a directory and
moving are for the provider owner; moving and removing an old copy ask for a
recent sign-in. Every request is written to the audit log
(`database.move.requested`, and from the updater `database.move.started`,
`database.move.succeeded`, `database.move.failed`, `database.old_copy.removed`).

1. Attach the new disk and mount it on the host (for example at
   `/mnt/volume-1`, with an entry in `/etc/fstab`), and create a directory on it,
   e.g. `/mnt/volume-1/restow-db`.
2. Enter the directory under **Installation › Database** and choose **Check
   directory**. Nothing changes; the updater checks that:
   - the path is a plain absolute path and not a system directory (`/etc`,
     `/usr`, `/var/lib/docker`, `/tmp`, …);
   - the directory exists on the host and is writable;
   - it is on **another file system** than the data now;
   - the file system suits PostgreSQL: ext4, XFS, Btrfs or ZFS. NFS, SMB/CIFS,
     FUSE, tmpfs, overlay and anything else are refused;
   - it has room for the data directory plus a tenth of it, at least 2 GiB;
   - the database has no tablespaces outside its directory;
   - `.env` is writable, and Compose takes the location from `.env` and resolves
     it to where the database runs now.
3. Choose **Move database…**. The dialog names the downtime; type the directory
   again to confirm.

The updater then runs these steps; the page and the maintenance page show them.
Restow is unavailable from step 1 to step 8. Copy and comparison read the data
about three times, so plan several minutes per 10 GB on ordinary disks.

| Step | What happens | Checked |
| ---- | ------------ | ------- |
| 1 Stop the application | api, worker and scheduler stop (the worker checkpoints running jobs; the edge keeps serving the maintenance page) | |
| 2 Stop the database | PostgreSQL stops (up to 120 s) | `pg_controldata` must report `shut down` |
| 3 Copy | `<dir>/restow-postgres-<time>` is created and the data copied with `cp -a` (owner, permissions, times) in a helper container of the postgres image, the old data mounted read-only | |
| 4 Verify | both trees are listed side by side | the same entries, types, sizes, permissions, owners, and the SHA-256 of every file |
| 5 Test start | PostgreSQL starts on the copy in an isolated container (no network, as the data's owner) | it must answer with the number of applied migrations read before the stop, and stop cleanly again |
| 6 Switch | `RESTOW_POSTGRES_DATA_TYPE=bind` and `RESTOW_POSTGRES_DATA=<copy>` go into `.env` (the previous lines are kept); the old copy gets a file `RESTOW-MOVED.txt` and its `PG_VERSION` is renamed to `PG_VERSION.restow-moved` | Compose must resolve the new location |
| 7 Start the database | PostgreSQL is recreated on the new directory | healthy, running from the new directory, the same migration count |
| 8 Start the application | api, then worker and scheduler | the api answers ready |

**If any step fails**, the updater goes back: it stops what it started, puts the
two lines of `.env` back byte for byte, renames `PG_VERSION` of the old copy back,
starts PostgreSQL on the old location (it must run from there and show the
migration count of before) and starts the application. The move ends
**rolled back**; the database is unchanged. An incomplete copy is removed; a copy
the database had already run from (a failure in step 7 or 8) is kept and named on
the page, since it may hold a few minutes of changes. When the way back fails as
well, the move ends **needs attention** and PostgreSQL is left stopped rather than
started on a location that might be the wrong one: see below. If the updater is
restarted in the middle of a move, it takes the same way back when it starts
again. An update, a restart of a service and a start of the mounter are refused
while a move runs, and a move is refused while one of them runs.

**The old copy is never deleted by the move.** Its renamed `PG_VERSION` makes
PostgreSQL refuse to start on it (PostgreSQL would otherwise run on stale data if
`.env` were changed back or an old compose file were used; the container then
fails with “directory exists but is not empty”). Once the database runs well from
the new disk, remove it with **Remove old copy**: the updater deletes its content
and keeps `RESTOW-MOVED.txt`, so the directory can never be mistaken for an empty
database. The volume `restow_pgdata` itself stays (empty but for the note).

Going back to the old copy after a successful move is not offered: it is a
snapshot of the moment of the move, and every backup recorded since would be
missing from it. To return to the system disk, move the database again (to a
directory there).

### When a move needs attention

The page shows which step failed and the updater's log. The data is in one of the
two places, both intact: the old location (until step 6 nothing touched it) and,
from step 3 on, the copy. Check `.env`, then:

```sh
cd /opt/restow
grep RESTOW_POSTGRES_DATA .env                 # where Compose will start PostgreSQL
# the old location, if it is the volume:
docker run --rm -v restow_pgdata:/old alpine ls /old
# a quarantined old copy has PG_VERSION.restow-moved instead of PG_VERSION; to use it again:
docker run --rm -v restow_pgdata:/old alpine sh -c 'cd /old && mv PG_VERSION.restow-moved PG_VERSION && rm -f RESTOW-MOVED.txt'
# with both lines of .env empty (old location) or pointing at the copy:
docker compose up -d postgres && docker compose up -d
```

Use the location the last successful state ran from: the old one when the move
ended before step 7, the copy when it failed after the database had run from it
(the page names it as the kept copy).

## Moving by hand

Without the updater, or on an older compose file, the same steps by hand (as root
on the host, in the project directory):

```sh
cd /opt/restow
docker compose stop api worker scheduler
docker compose stop -t 120 postgres
NEW=/mnt/volume-1/restow-db/restow-postgres-$(date -u +%Y%m%d-%H%M%S)
mkdir "$NEW"
# copy with owner and permissions (the postgres image's own cp; the old data read-only)
docker run --rm -v restow_pgdata:/from:ro -v "$NEW":/to --entrypoint sh postgres:16-alpine \
  -c 'cp -a /from/. /to/ && chown "$(stat -c %u:%g /from)" /to && chmod "$(stat -c %a /from)" /to'
# compare (both lines must be identical)
docker run --rm -v restow_pgdata:/a:ro -v "$NEW":/b:ro --entrypoint sh postgres:16-alpine \
  -c 'for d in /a /b; do (cd $d && find . -type f -exec sha256sum {} + | LC_ALL=C sort -k2 | sha256sum); done'
# point .env at the copy (needs the docker-compose.yml of 0.4.0 or later)
printf 'RESTOW_POSTGRES_DATA_TYPE=bind\nRESTOW_POSTGRES_DATA=%s\n' "$NEW" >> .env
docker compose config --format json | grep -c "$NEW"      # must be at least 1
# keep the old copy from starting by mistake
docker run --rm -v restow_pgdata:/old alpine sh -c 'echo "moved to '"$NEW"'" > /old/RESTOW-MOVED.txt && mv /old/PG_VERSION /old/PG_VERSION.restow-moved'
docker compose up -d postgres && docker compose up -d
```

Remove empty `RESTOW_POSTGRES_DATA_TYPE=` / `RESTOW_POSTGRES_DATA=` lines further
up in `.env` first (the last assignment wins, but one line each is clearer). To
undo before the application started, empty the two lines again, rename
`PG_VERSION.restow-moved` back and start the stack.

## Moving to a new host, restoring a dump, failing over

A copy of the database that is older than its storage (a dump restored after the
application kept running, a replica that lagged) knows less than the storage: backups
written since are in storage, not in the database. The installation then runs in
**restore mode** until a provider owner has checked it
([STORAGE.md](STORAGE.md#restore-mode-and-progress-markers)): nothing is deleted, jobs from
before the restore are held, new backups run.

- **A host move:** stop the application before the dump and keep it stopped until the
  database runs on the new host (`docker compose stop api worker scheduler`, then
  `pg_dump`, copy, `pg_restore`, start there). The copy is then exactly as new as the
  storage and nothing triggers. A dump taken while the application ran is older than the
  storage it is started against: switch restore mode on before the new host's worker
  starts (`docker compose run --rm --no-deps --entrypoint restow api restore-mode on
  --reason "host move"`), or the worker switches it on by itself at its start.
- **A restored dump** (a rollback, see [UPDATING.md](UPDATING.md#rollback)): restore
  mode first, then start the stack, check, and end it under Installation, Restore mode.
- **A failover to a replica:** an asynchronous replica that lags behind the primary at the
  failover is an older copy; restore mode comes on by itself once its worker sees a target
  ahead of it. A synchronous replica, or one that had caught up, triggers nothing.
- **Moving back to an old copy** after the installation ran on a newer one (the old copy a
  move left under Installation, Database) is a restored dump as well and triggers restore
  mode.

## Restore an installation from a dump

A new server that takes over an installation from a dump of its database (pg_dump -Fc): the old
server is gone, or the installation moves. The first question of the setup wizard and of
`install.sh` offers it (2: "Restore an installation"). What it needs:

- the **same `RESTOW_MASTER_KEY`** as the old installation in `.env` (and its
  `BETTER_AUTH_SECRET`, or sign-ins with an authenticator app fail; an owner then gets access
  again with `restow admin recover`), and
- the **dump**: uploaded in the wizard, one the updater kept (only when its volume survived on
  this host), or a file on the host for `install.sh --restore`.

The order keeps the restored data safe: no worker and no scheduler, which run the deleting
passes, start on restored data before restore mode is on in it.

1. Worker and scheduler are stopped; the dump is restored into a database of its own,
   `restow_restore` (`pg_restore --no-owner --no-acl --exit-on-error`): the live database stays
   the fresh one.
2. `restow restore prepare` on it: refused when it is no Restow database, newer than this release
   or without a finished setup; migrated to this release, the roles of this server provisioned;
   **restore mode switched on** (source `setup`) as the first thing written; then
   `RESTOW_MASTER_KEY` must unwrap every tenant key and open every installation secret and one
   secret per tenant. A wrong key refuses (`master_key_mismatch`): the scratch database is
   dropped, nothing changed, start again with the right key (install.sh: exit code 11). Last,
   every storage target of the restored configuration is compared with the database (progress
   markers), and the report says what was found.
3. The operator reads the report and activates: the api stops, `restow restore activate`
   renames the fresh database to `restow_before_restore_<time>` and `restow_restore` to `restow`,
   the api starts on it, and only then worker and scheduler.
4. Sign in with an account of the restored installation (no setup token, no first admin: the dump
   brought its users) and work through Installation › Restore mode before ending it.

With the updater the wizard does all of it. Without it, on a **fresh host** (no installation
yet), the install script does:

```sh
sudo bash install.sh --restore /path/to/restow.dump --env-from /path/to/old/.env
```

It refuses a host that runs an installation already, also one whose setup has not run yet: there,
restore by hand (below). Worker nodes of the old installation join again (their database logins
are not part of a dump).

### Restoring a dump by hand

On an installation whose setup has not run (the wizard shows these steps when the updater does not
answer):

```sh
cd /opt/restow
# 1. Replace RESTOW_MASTER_KEY and BETTER_AUTH_SECRET in .env with the old installation's
sudo nano .env
# 2. Restore the dump into a database of its own, worker and scheduler stopped
sudo docker compose stop api worker scheduler
sudo docker compose exec -T postgres psql -U restow -d postgres -c "CREATE DATABASE restow_restore"
sudo docker compose exec -T postgres pg_restore -U restow -d restow_restore --no-owner --no-acl --exit-on-error < restow.dump
# 3. Restore mode on, master key and storage checked; read the report
sudo docker compose run --rm --no-deps --entrypoint restow api restore prepare
# 4. Make it the live database, then start everything
sudo docker compose run --rm --no-deps --entrypoint restow api restore activate
sudo docker compose up -d
```

The master key goes into `.env` first: `restore prepare` checks it against the restored keys and
refuses (exit code 3, nothing changed) when it does not open them. `restow restore abort` drops
the scratch database again; `docker compose up -d` then starts the fresh installation as before.

### An interrupted restore

`install.sh --restore` leaves `.restore-in-progress` in the installation directory until the
restored database is live. A run cut off before that (Ctrl-C or a lost SSH session during
`pg_restore`, at the confirmation, or inside `restore activate`) leaves the marker, the `.env`
with the old master key and a scratch database that may be half filled. Then:

- A plain `install.sh` refuses to start anything (exit code 8) and says how to go on: worker and
  scheduler never start on a half-restored database.
- `install.sh --restore <dump> --env-from <old .env>` again removes what the interrupted run left
  (`docker compose down -v`, `.env`, the marker: all of it was that run's own, on a fresh host)
  and restores from the start.
- If the report said the restored database was prepared, finish by hand instead:
  `docker compose run --rm --no-deps --entrypoint restow api restore activate` (it completes a
  swap cut off half way, or answers that the restored database is live already), then
  `docker compose up -d` and `rm .restore-in-progress`.

### When a restore needs attention

The wizard's last step reads the updater's restore status. When the activation or the start after
it failed, or the updater restarted in the middle, the restore ends `needs_attention`: worker and
scheduler stay stopped, and the api may run on the fresh database again (with a new setup token
in its log). The step shows the updater's reason and these commands:

```sh
cd /opt/restow
# finish it: activate again (resumable; "live already" when the swap was done), then start all
sudo docker compose run --rm --no-deps --entrypoint restow api restore activate
sudo docker compose up -d
# or undo it (before the swap): drop the restored database, start the fresh installation again
sudo docker compose run --rm --no-deps --entrypoint restow api restore abort
sudo docker compose up -d
```

`docker compose logs updater` has the details of the failed step.

**Never `pg_restore --clean --if-exists` onto a migrated database of a newer release:** the tables
of the newer migrations stay while the restored migration journal says they do not exist, and the
next migration fails. Restore into a fresh database instead (above, or drop and create `restow`
first, docs/UPDATING.md).

## Not covered

- The updater's dumps stay in its volume (`restow-updater`, `/state/dumps`), on
  Docker's disk. Download and delete them in the Updates tab when room is short.
- Tablespaces, a `PGDATA` below the mount point, and network file systems are
  refused rather than handled.
