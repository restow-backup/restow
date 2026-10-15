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
is read through the opt-in updater; without it only the repository's disk is
watched.

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

## Not covered

- The updater's dumps stay in its volume (`restow-updater`, `/state/dumps`), on
  Docker's disk. Download and delete them in the Updates tab when room is short.
- Tablespaces, a `PGDATA` below the mount point, and network file systems are
  refused rather than handled.
