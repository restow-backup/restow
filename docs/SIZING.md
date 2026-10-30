# Sizing: how much one Restow installation handles

This guide is for operators (self-hosting admins and service providers). It says how many
objects, machines and tenants one installation carries, which settings to raise when it
grows, and what hardware to plan. It is written from the code. Read the next section first.

## What is measured and what is estimated

**Nothing in this guide was load-tested.** No installation of this size has been run to
produce these numbers. There are three kinds of statement here, and each is marked:

- **Code** facts are read from the source and hold exactly: defaults, limits, the way a
  job uses the database. They name the file.
- **Assumption** values are inputs of the worked example (mailbox size, link speed, chunk
  size). Replace them with your own.
- **Estimate** values are calculated from the assumptions or are engineering judgement
  (per-job throughput, memory per job, row sizes). Treat them as an order of magnitude, not
  a promise. Your first large run is the real measurement: watch it (see "Watching a large
  first backup") and correct the settings from what you see.

If you measure a deviation, please tell us (SUPPORT.md); this guide improves from reports.

## How work is spread

All backup work runs in the worker process, as pg-boss jobs; the scheduler only enqueues,
the api only serves. One job backs up one protected object: one mailbox, one OneDrive, one
SharePoint site, one IMAP account. Machines with the endpoint agent run restic themselves
and upload to the api (docs/AGENT.md); for them the server does retention and checks.

The limits that decide the speed of a worker process (Code, `apps/worker/src/index.ts`,
`apps/worker/src/handlers/framework.ts`):

| Setting | Default | Meaning |
| --- | --- | --- |
| `WORKER_CONCURRENCY` | 2 | Jobs running at once **per queue** in one worker process. Seven queues get this many slots each: restore, backup, verify, scrub, storage migration, import and export. A process can therefore run up to 7 times this many jobs; in a first backup that is backup plus verify (a check follows every backup), so plan for about 2 times. |
| `WORKER_TENANT_CONCURRENCY` | 2 | Jobs of **one tenant** running at once in one worker process (`TenantConcurrencyLimiter`). The rest wait in the process. |
| `ARCHIVE_CAPTURE_CONCURRENCY` | 16 | Archive capture passes at once in one process (Business, docs/ARCHIVE.md). |
| `ARCHIVE_CAPTURE_TENANT_CONCURRENCY` | 4 | Of those, per tenant. |
| `ARCHIVE_BACKFILL_CONCURRENCY` | 4 | One-time takeovers of existing mail at once. |
| `IMPORT_PARSE_WORKERS` | 2 | Parser helper processes of the import (1 to 8), each up to 512 MB (3 GB for one large message). |
| `PREVIEW_PARSE_WORKERS` (api) | 2 | The same for previews. |
| `IMMUTABILITY_RENEWAL_CONCURRENCY` | 32 | Object Lock retention requests in flight per target (at most 256). |
| `WORKER_POLL_SECONDS` | 2 | pg-boss polling interval. |

Some queues have a fixed number of slots of their own (retention 1, directory sync 2,
webhook deliveries 4, `WEBHOOK_CONCURRENCY`, archive backfill, immutability renewal); they do
not follow `WORKER_CONCURRENCY`.

**Polling load.** Every slot is one pg-boss `work()` loop that polls every
`WORKER_POLL_SECONDS`. With seven queues, `WORKER_CONCURRENCY=32` registers about 224 loops,
which is about 110 fetch queries a second on the pg-boss pool at the default of 2 seconds
(Estimate). For large values raise `WORKER_POLL_SECONDS` (for example to 5 or 10: a job then
waits a few seconds longer to start, which does not matter for backups) and size
`RESTOW_DB_BOSS_POOL_MAX` generously.

Both numbers are **per worker process**. Two worker processes (`docker compose up -d
--scale worker=2`) double the slots, and also the jobs per tenant. A job that has to wait
because its tenant is at the limit holds its slot while it waits, so a `WORKER_CONCURRENCY`
far above `WORKER_TENANT_CONCURRENCY` times the number of busy tenants leaves slots idle.
Rule of thumb: `WORKER_CONCURRENCY` about 3 to 4 times `WORKER_TENANT_CONCURRENCY` when many
tenants are busy at the same time, and both equal when one big tenant is all there is.

A worker is one Node.js process: hashing, chunking and encryption of all its jobs share one
event loop, so one process uses about one CPU core for its own work. For more throughput than
one core carries, add worker processes rather than only raising the concurrency (Estimate).

## Microsoft Graph throttling

Code (`packages/core/src/graph/client.ts`) and docs/MICROSOFT.md, "Throttling":

- Microsoft throttles per app, per tenant and per mailbox. The documented rule of thumb for
  Outlook resources is 10,000 requests per 10 minutes per app and mailbox and 4 concurrent
  requests per mailbox. OneDrive and SharePoint have their own per-tenant limits that depend
  on the licence count. These are Microsoft's figures and change without notice; this
  guide does not verify them.
- The client honours 429, 503 and 504 with `Retry-After` (up to 5 minutes per wait), else an
  exponential backoff with jitter, and retries up to 5 times. Throttled `$batch` sub-responses
  (20 requests per batch) are retried one by one. A throttling wait is shown in the job as
  "waiting for Graph" and is not a failure.
- Restow parallelises across mailboxes, never inside one. So the load on one tenant is
  about `WORKER_TENANT_CONCURRENCY` times the number of worker processes. There is no shared
  budget across processes that shrinks after a 429 (docs/ARCHITECTURE.md): each process
  backs off on its own.
- The practical limit is therefore per tenant, not per installation: 30 slots over 30 tenants
  are far less likely to be throttled than 30 slots on one tenant. For a single large tenant,
  raise `WORKER_TENANT_CONCURRENCY` in steps (for example 4, 6, 8) and watch the throttling
  waits. If most of the job time goes to "waiting for Graph", raising it further only
  lengthens the waits.

## Database pools and Postgres

Every process opens node-postgres pools of at most 10 connections each (Code,
`packages/db/src/index.ts`). Since 0.4.8 the sizes are set by environment variables; the
defaults are the old values, so nothing changes until you set them.

| Variable | Pool | Used by | Default |
| --- | --- | --- | --- |
| `RESTOW_DB_POOL_MAX` | application pool (`DATABASE_URL`) | api, worker, scheduler | 10 |
| `RESTOW_DB_PROVIDER_POOL_MAX` | installation pool (`DATABASE_PROVIDER_URL`) | api, worker, scheduler | 10 |
| `RESTOW_DB_BOSS_POOL_MAX` | pg-boss's own pool | worker, scheduler | 10 |

The api's auth pool (`DATABASE_AUTH_URL`) stays at 10; it only serves sign-in. The api's job
sending and the worker's follow-up jobs go through the application pool, not a pool of their
own. A value must be a whole number from 1 to 500; anything else stops the process at start
with a message naming the variable. Empty means the default.

What needs the pool: every running job takes a connection for each short transaction (progress
rows, chunk index lookups, the reference counts at commit, one transaction per batch of 1,000
chunks) and gives it back. Jobs do not hold
a connection while they download or upload. With `WORKER_CONCURRENCY` jobs at once in
one queue the application pool must hold at least that many plus 2 for the process itself
(heartbeat, cancellation checks). **The worker warns at start when `RESTOW_DB_POOL_MAX` is
below `WORKER_CONCURRENCY` + 2**, and the jobs then queue for a connection. The warning looks
at one queue only. Backup and verify run together, and the other queues (archive capture,
retention) use the same pool at the same time, so size the pool for about 2 times
`WORKER_CONCURRENCY` (Estimate; verify jobs hold a connection less often than backups).
The installation pool serves scans across tenants and is rarely busy, but the worker pins
some of its connections for long (the IMAP IDLE lock connection for the whole run, advisory
locks during scans, heartbeat, reconciler). Keep `RESTOW_DB_PROVIDER_POOL_MAX` at 6 or more
and do not lower it; the default of 10 is enough up to the largest example here. The pg-boss
pool carries fetching and completing jobs: its use grows with the number of job slots, but
every call is short.

**Postgres `max_connections` must exceed the sum of all pool maxima of all processes**, plus
3 for `superuser_reserved_connections`, plus what else connects (a `psql` session, a backup
of the database, monitoring: plan 10 to 20). A pool opens connections on demand, so the real
number is usually lower than the sum of the maxima, but the sum is what a busy night can reach.

At the defaults: api 10 + 10 + 10, worker 10 + 10 + 10, scheduler 10 + 10 + 10 = 90, plus 3
reserved: 93 of Postgres' default of 100. A second worker process or a second scheduler
replica already exceeds it. Raise `max_connections` before you raise any pool or add a process:

```sh
docker compose exec postgres psql -U restow -c "ALTER SYSTEM SET max_connections = 300"
docker compose restart postgres
```

(`ALTER SYSTEM` writes `postgresql.auto.conf` into the data directory, so it survives updates
of the compose file. Use your `POSTGRES_USER`. Each connection costs Postgres memory, roughly
5 to 10 MB in use (Estimate), so do not set it far above what you need.)

### Postgres settings

Estimate, standard Postgres practice rather than anything measured with Restow:

| Setting | For a large installation |
| --- | --- |
| `max_connections` | sum of pools + 3 + 20, see above |
| `shared_buffers` | 25 % of the RAM given to Postgres |
| `effective_cache_size` | 60 to 75 % of that RAM |
| `maintenance_work_mem` | 512 MB to 1 GB (vacuum, index builds) |
| `work_mem` | leave at 4 MB, more multiplies by the connections |
| `max_wal_size` | 8 to 16 GB (many small commits write a lot of WAL) |
| `checkpoint_timeout` | 15 min |
| `autovacuum_vacuum_scale_factor` on `chunks` | 0.02 (default 0.2 lets millions of dead rows pile up) |

Put the database on SSD or NVMe, never on the same slow disk as the chunk store. Its size
follows the number of chunks, not the bytes (see below).

### The hard limit: reference counts per chunk

Code. Every snapshot commit adds one reference per chunk occurrence of the **whole object
list**, not just the new chunks: `SnapshotWriter.commit()` calls `addReferences` with every
chunk of every object in the snapshot, inherited ones included
(`packages/core/src/engine/snapshot.ts`, `referencedChunkIds`; the worker runs it as
`UPDATE chunks ... FROM (VALUES ...)` in batches of 1,000, `apps/worker/src/handlers/framework.ts`).
It also looks all of them up first (`locate`, batches of 1,000), and retention releases the
same number again when a snapshot is pruned. So the database work of a nightly run is
proportional to the **total chunks of all protected objects**, not to the nightly change.

Every one of these is an `UPDATE` of a row in the `chunks` table (random UUID primary key,
unique index on tenant and the HMAC stored id, so index writes land all over the index).
Dedupe is per tenant. Two consequences:

- The `chunks` table and its indexes should fit in the RAM of Postgres. When they do not,
  every commit turns into random disk reads and the nightly window stretches (Estimate).
- This, not the bandwidth, is the ceiling of a very large installation: past some size the
  nightly commits no longer finish in the night. Where that point lies depends on your
  hardware and was not measured. Give Postgres NVMe and RAM, spread the schedules of big tenants over the night, and split a very large installation
  into two installations (see "Beyond one installation") before the commits run late.

## CPU, RAM and disk

All values are Estimates unless marked.

- **CPU.** One worker process: about one core busy at 30 to 60 MB/s of source data
  (hashing, content-defined chunking and AES-256-GCM run in the Node event loop; Code:
  no worker threads). Add one worker process per 40 to 50 MB/s you want to sustain, up to the
  cores you have. The api needs 1 to 2 cores; Postgres 4 or more for a large installation.
- **RAM.** A running job holds its open pack (packs are up to 64 MiB, chunks up to 4 MiB, Code:
  `DEFAULT_MAX_PACK_BYTES`, docs/ARCHITECTURE.md) and its read caches: plan 150 to 300 MB per
  concurrent job. With backup and verify running together that is about 2 times
  `WORKER_CONCURRENCY` jobs, so `WORKER_CONCURRENCY=32` needs 10 to 20 GB for the worker, plus 512 MB per
  parser helper (`IMPORT_PARSE_WORKERS`). Watch the worker's memory during the first day and
  raise or lower the concurrency from what you see.
- **Disk, system.** Logs, Postgres, the restic cache of the agent maintenance
  (`RESTOW_RESTIC_CACHE_DIR`) and temporary files: 100 GB SSD is plenty for the system itself.
- **Disk, database.** About 250 bytes per chunk including the two indexes (Estimate), so
  100 million chunks are about 25 GB, plus vacuum headroom: plan twice that.
- **Disk, chunk store.** Stored size is the deduplicated size of all retained snapshots;
  docs/STORAGE.md describes the targets. A new installation is about the source size times
  0.6 to 0.9 for mail and files (Assumption), then grows with the change rate and retention.
  Local targets need that capacity plus 20 %; with S3 the provider limits apply (request
  rates, Object Lock renewal requests, `IMMUTABILITY_RENEWAL_CONCURRENCY`).

## Storage bandwidth

The first backup moves the whole source through the server: Microsoft to the worker, then to
the storage target (and to each copy target, which doubles the write side). Plan the slowest
of three links:

1. Download from Microsoft to the server. A single server typically reaches 30 to 80 MB/s
   from Microsoft 365 over a 1 Gbit/s link, less on shared lines and with throttling
   (Estimate; not measured).
2. Upload to the target: network share or S3. S3 needs many parallel requests (each worker
   slot writes its own packs), so the latency to the bucket matters as much as the line speed.
3. Disk writes of a local target, including the second copy if you use one.

A 1 Gbit/s line carries at most about 110 MB/s; plan on 60 to 70 % of that for sustained
transfer. The same line serves the agents' uploads of the machines and the nightly runs, so
keep the first backups of different tenants staged (see below) rather than starting all at once.

## First-backup duration

The estimate is simple: source bytes divided by sustained throughput, with the throughput
limited by the slots in use or by the line, whichever is smaller.

Throughput per running job, Assumption for the table below: about 3 MB/s on average over
mailboxes (many small items, 4 concurrent requests per mailbox) and OneDrives (larger files)
mixed. Real values vary a lot: one mailbox of small mails can be far slower, one OneDrive of
large files far faster. A job also pays a start-up cost (listing folders, the delta cursor)
that matters for small objects.

| Slots in use (jobs at once) | At 3 MB/s per job | Per day |
| --- | --- | --- |
| 2 (the defaults) | 6 MB/s | about 0.5 TB |
| 8 | 24 MB/s | about 2 TB |
| 16 | 48 MB/s | about 4 TB |
| 32 | 96 MB/s, capped by the line | about 4 to 5 TB (line-bound) |

(Estimates.) Also in the code and worth knowing for large single objects: a job that stops at
its time limit (95 % of pg-boss' 23-hour expiry) or at a restart keeps its checkpoint and
continues, up to 21 days after its first start, without using a retry (`apps/worker/src/continuation.ts`).
A multi-day first backup of one big mailbox is expected and not a failure.

## Worked example: MSP with 2,000 seats

All numbers are Assumptions or Estimates; nothing here was run.

**Customer base.** 2,000 seats, each with a Microsoft 365 mailbox and a OneDrive, spread over
about 60 customer tenants (an average of 33 seats; the biggest tenant 300). Plus 150 machines
(30 servers, 120 workstations) with the endpoint agent.

**Source volume.** Average mailbox 8 GB, average OneDrive 25 GB: 33 GB per seat, so
66 TB for the seats. The machines add about 30 TB (servers 600 GB, workstations 100 GB on
average, Assumption). The stored size after deduplication and compression is estimated at
0.6 to 0.9 of the source for the seats: about 40 to 60 TB (Estimate).

**Chunks.** Mail items are mostly below 256 KiB (one chunk each), files average about 1 MiB
(FastCDC, Code). Assuming 75 KiB average per mail item, an 8 GB mailbox has about 110,000
items and so 110,000 chunks; 25 GB of files at 1 MiB per chunk are 25,000 chunks: about
135,000 chunks per seat, 270 million for the 2,000 seats (before deduplication, which is per
tenant). The count scales with the item count: a mailbox of 30 KiB mails has more than twice
that. The `chunks` table with its indexes is about 67 GB (250 bytes each), so 64 GB RAM for
Postgres keeps the hot part in memory and 128 GB is better (Estimate).

### With the defaults

`WORKER_CONCURRENCY=2` and `WORKER_TENANT_CONCURRENCY=2` on one worker: 2 jobs at once, about
6 MB/s, about 0.5 TB a day. The 66 TB of the seats take about 130 days, more than four months,
and the nightly runs compete with the first backup for the same two slots. The defaults are
right for an installation with a few dozen objects, not for this one.

### Tuned

Two worker processes (one process is bound by one CPU core at 30 to 60 MB/s), each with:

```sh
WORKER_CONCURRENCY=16
WORKER_TENANT_CONCURRENCY=4
WORKER_POLL_SECONDS=5
RESTOW_DB_POOL_MAX=32
RESTOW_DB_BOSS_POOL_MAX=16
```

and `max_connections=300` (api 10+10+10, two workers 2 x (32+10+16) = 116, scheduler
10+10+10 = 30; sum 176; headroom for a standby scheduler, archive capture and tools).

With 60 tenants there are always enough tenants with waiting work to fill the 32 slots at 8
per tenant (4 per process); the largest tenant (300 seats) sees at most 8 jobs at once and is the last to
finish, about its 300 x 33 GB = 10 TB at 8 x 3 = 24 MB/s, five days (Estimate). Raise
`WORKER_TENANT_CONCURRENCY` in steps for it if the throttling waits stay low.

All 32 slots (two processes of about 48 MB/s each, within one core each) would carry about
96 MB/s: more than a 1 Gbit/s line gives. The line caps the
rate at 50 to 70 MB/s, so the 66 TB take 66e6 MB / 60 MB/s = 11e5 s, about 13 days of pure
transfer. With the retries after throttling, the nightly runs that share the line, and a
first-backup throughput below the peak, plan **2 to 4 weeks**, bandwidth-bound. A faster line
(10 Gbit/s) moves the limit to the worker CPU (add worker processes) and then to
Postgres.

The machines' first backups add to the same line. Stage them: enrol 10 to 20 a night, so
they do not take the Microsoft downloads' share of the line.

**Steady state afterwards.** The nightly run reads only the delta from Microsoft (a few
percent of the source), so bandwidth is no longer the problem. The database work is: every
committed snapshot of every object adds a reference for each of its chunks (see "The hard
limit"), about 270 million row updates for the whole base per cycle. Spread over an 8-hour
night that is about 9,000 row updates a second sustained (Estimate), plus the same number of
lookups and, a few weeks later, the same number of releases from retention. That is within
reach of a Postgres with NVMe and 64 to 128 GB RAM, and it is the reason the database server is the
first thing to size generously. If the nightly commits begin to run past the morning, you
have reached the limit of one installation.

## Recommended servers

One installation: api, worker, scheduler, Postgres and the chunk store on a host or split over
hosts. Estimates for the Microsoft 365 backup of the stated seats (a seat is a mailbox plus a
OneDrive) plus the stated machines.

| Size | Seats / machines / tenants | Worker host | Postgres | Settings |
| --- | --- | --- | --- | --- |
| S | up to 100 / 20 / 10 | 4 vCPU, 8 GB RAM | on the same host, 4 GB | defaults |
| M | up to 500 / 50 / 30 | 8 vCPU, 16 GB RAM | same host, 8 GB, SSD | `WORKER_CONCURRENCY=8`, `WORKER_TENANT_CONCURRENCY=4`, `RESTOW_DB_POOL_MAX=16`, `max_connections=150` |
| L | up to 2,000 / 150 / 60 | 16 vCPU, 32 GB RAM, 2 worker processes | own host, 8 vCPU, 64 GB RAM, NVMe | `WORKER_CONCURRENCY=16` and `WORKER_TENANT_CONCURRENCY=4` per process, `RESTOW_DB_POOL_MAX=32`, `max_connections=300` |
| XL | 2,000 to 5,000 / 400 / 150 | 3 to 4 worker hosts of 16 vCPU, 32 GB RAM; own api host | own host, 16 vCPU, 128 GB RAM, NVMe | as L per worker; 10 Gbit/s line; `max_connections=500`; check the nightly commits closely |
| Beyond | over 5,000 seats | two installations, split by customer group | | see below |

Line: S 100 Mbit/s, M 1 Gbit/s, L 1 to 2 Gbit/s, XL 10 Gbit/s. Storage: the stored size from
"First-backup duration" plus 20 %, on a target with enough write speed for the line.

The sums of the pools for the table rows must stay below `max_connections`: row L has 2 workers
x (32 + 10 + 10) + api 30 + scheduler 30 = 164, with room to grow.

## Watching a large first backup

- The Jobs page shows running and waiting jobs and the throttling waits per job; a long
  "waiting for Graph" on many jobs means the tenant limits are reached, not that the server is
  slow. Do not raise the tenant concurrency then.
- The worker's log line `worker started` shows `concurrency`, `tenantConcurrency` and the pool
  sizes it took. A warning about `RESTOW_DB_POOL_MAX` means the pool is smaller than the jobs.
- In Postgres, `SELECT count(*), state FROM pg_stat_activity GROUP BY 2` against
  `max_connections`, and `pg_stat_user_tables` for the dead rows of `chunks`.
- The job queue: jobs waiting in `pgboss.job` with state `created` are not yet taken; if they
  stay many while the slots are full, that is the expected queue of a first backup.
- Host: CPU of the worker (a process stuck near one core wants a second process), memory,
  and the network line.

## Beyond one installation

An installation is one Postgres with one chunk store index. When the nightly commits no
longer finish in the night, or a single database host no longer holds the `chunks` table in
memory, the way on is a second installation for a separate group of customers, not a bigger
`WORKER_CONCURRENCY`. Restow has no sharding of one installation across databases. Plan the
split before the first backups, because moving a tenant later means backing it up again.
