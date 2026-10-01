# @restow/scheduler

The scheduler is one of the three roles of the single Restow image (`api | worker | scheduler`).
It runs as a single logical process that enqueues **due** jobs onto pg-boss for the workers to run.

## What it does

- **Leader election.** Every replica opens a dedicated Postgres connection and contends for a
  session-level advisory lock (`pg_try_advisory_lock`). Exactly one becomes the leader; the rest
  stand by and retry, so a crashed leader's lock is released by Postgres and picked up automatically.
- **Tick loop.** Only the leader ticks. Each tick reads the wall clock at runtime, asks the planner
  which schedules are due, and enqueues the jobs of each due schedule together with its next run in
  one transaction. Ticks never overlap.
- **Scheduled queues:** `backup`, `verify`, `retention`, `scrub` and `directory` (Entra ID sync of
  Microsoft 365 sources). Restores and one-off runs started by hand are enqueued by the API.
- **Recommended schedules.** When a tenant has its first active source, the next tick gives it the
  recommended schedules once and records that on the tenant (`schedule_defaults_applied_at`):

  | Kind      | Cadence                                        | Note                                          |
  | --------- | ---------------------------------------------- | --------------------------------------------- |
  | backup    | every 8 hours, first run at once               | every active protected object                 |
  | directory | every 6 hours, first run at once               | only with a Microsoft 365 source              |
  | verify    | weekly, Sunday 03:00                           | also verifies every new backup                |
  | scrub     | weekly, Saturday 04:00                         | sampled pack check                            |
  | scrub     | monthly on the 1st, 05:00                      | full pack check                               |
  | retention | daily, 04:30                                   | applies the retention policies                |

  Times are local times in `SCHEDULER_DEFAULT_TIMEZONE`. A schedule that already covers a kind is
  kept as it is, and a schedule an administrator deletes later is never recreated. The values live
  in `packages/core/src/schedule/defaults.ts`; administrators change or add schedules on the
  Schedules page, which can also apply missing recommendations again.
- **Graceful shutdown** on `SIGTERM` / `SIGINT`: finish the in-flight tick, release the advisory
  lock, stop the queue client, close the database pools.

Cron expressions have five fields and are evaluated in the schedule's IANA time zone, so a daily
03:30 stays at 03:30 local time across daylight-saving switches (a wall time that does not exist on
the spring-forward day is skipped, one that happens twice in autumn runs once). The same code
(`@restow/core`, `schedule`) validates schedules and previews their next runs in the API.

## Configuration

| Variable                     | Required | Default         | Purpose                                                            |
| ---------------------------- | -------- | --------------- | ------------------------------------------------------------------ |
| `DATABASE_URL`               | yes      | —               | Application role (Row Level Security): every write for a tenant.   |
| `DATABASE_PROVIDER_URL`      | yes      | —               | Installation role: the scan across tenants, pg-boss, leader lock.  |
| `SCHEDULER_DEFAULT_TIMEZONE` | no       | `Europe/Berlin` | IANA zone of the recommended schedules; an unknown zone stops the process. |
| `SCHEDULER_TICK_MS`          | no       | `30000`         | Interval between leader ticks.                                     |
| `SCHEDULER_LEADER_RETRY_MS`  | no       | `15000`         | Stand-by re-election retry interval.                               |
| `SCHEDULER_LOCK_KEY`         | no       | `5150130105`    | Advisory-lock key for leader election.                             |
| `SCHEDULER_BATCH_SIZE`       | no       | `200`           | Due schedules (and waiting tenants) handled per tick.              |
| `SCHEDULER_DEFER_MS`         | no       | `3600000`       | How long a schedule that cannot be planned waits before a retry.   |

## Scripts

- `pnpm dev` — run with `tsx watch`.
- `pnpm build` — compile to `dist/` (excludes tests).
- `pnpm typecheck` — type-check without emitting.
- `pnpm test` — run the unit tests; the Postgres suites (`*.pg.test.ts`) run when
  `RESTOW_TEST_DATABASE_URL` points at a Postgres 16 server as a superuser.
