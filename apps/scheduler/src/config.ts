// Scheduler configuration, read from the environment at startup.
//
// Only the two database URLs are required; everything else has an operational
// default. DATABASE_URL is the application role (subject to Row Level Security),
// DATABASE_PROVIDER_URL the installation role (BYPASSRLS) for the scan across
// tenants and pg-boss (packages/db/src/roles.ts).
// No secret is ever written to disk or logged from here.

import { DEFAULT_SCHEDULE_TIMEZONE } from "@restow/core";
import { isValidTimeZone } from "./cron.js";

const DEFAULT_TICK_INTERVAL_MS = 30_000;
const DEFAULT_LEADER_RETRY_INTERVAL_MS = 15_000;
const DEFAULT_BATCH_SIZE = 200;
const DEFAULT_DEFER_MS = 60 * 60 * 1000;

/**
 * Fixed, arbitrary 64-bit key that identifies the scheduler's leader lock in
 * Postgres. Every scheduler replica contends for this exact key via
 * pg_try_advisory_lock, so exactly one becomes the active leader. Overridable
 * only to isolate independent installations that share one database.
 */
const DEFAULT_ADVISORY_LOCK_KEY = 5_150_130_105;

export interface SchedulerConfig {
  /** The application role: every write for a tenant, pinned to it. */
  readonly databaseUrl: string;
  /** The installation role: the due-schedule scan, pg-boss and the leader lock. */
  readonly databaseProviderUrl: string;
  /** How often the leader wakes up to look for due jobs. */
  readonly tickIntervalMs: number;
  /** How often a stand-by replica retries to become leader. */
  readonly leaderRetryIntervalMs: number;
  /** Postgres advisory-lock key used for leader election. */
  readonly advisoryLockKey: number;
  /** Maximum due schedules handled per tick. */
  readonly batchSize: number;
  /** How long a schedule that cannot be planned (bad cron) waits before it is looked at again. */
  readonly deferMs: number;
  /**
   * IANA zone of the recommended schedules the scheduler gives a tenant once it
   * has an active source (the daily and weekly runs happen at local night time).
   */
  readonly defaultTimezone: string;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Build the scheduler configuration from an environment map (defaults to
 * `process.env`). Throws when a mandatory database URL is missing so the
 * process fails fast instead of silently idling.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): SchedulerConfig {
  const databaseUrl = env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for the scheduler process");
  }
  const databaseProviderUrl = env.DATABASE_PROVIDER_URL?.trim();
  if (!databaseProviderUrl) {
    throw new Error("DATABASE_PROVIDER_URL is required for the scheduler process");
  }
  return {
    databaseUrl,
    databaseProviderUrl,
    tickIntervalMs: parsePositiveInt(env.SCHEDULER_TICK_MS, DEFAULT_TICK_INTERVAL_MS),
    leaderRetryIntervalMs: parsePositiveInt(
      env.SCHEDULER_LEADER_RETRY_MS,
      DEFAULT_LEADER_RETRY_INTERVAL_MS,
    ),
    advisoryLockKey: parsePositiveInt(env.SCHEDULER_LOCK_KEY, DEFAULT_ADVISORY_LOCK_KEY),
    batchSize: parsePositiveInt(env.SCHEDULER_BATCH_SIZE, DEFAULT_BATCH_SIZE),
    deferMs: parsePositiveInt(env.SCHEDULER_DEFER_MS, DEFAULT_DEFER_MS),
    defaultTimezone: parseTimeZone(env.SCHEDULER_DEFAULT_TIMEZONE),
  };
}

/**
 * The recommended schedules' zone. A value that is not an IANA zone stops the
 * process: silently falling back would run every tenant's nightly work at the
 * wrong hour.
 */
function parseTimeZone(raw: string | undefined): string {
  const value = raw?.trim();
  if (!value) {
    return DEFAULT_SCHEDULE_TIMEZONE;
  }
  if (!isValidTimeZone(value)) {
    throw new Error(
      `SCHEDULER_DEFAULT_TIMEZONE must be an IANA time zone such as Europe/Berlin, got "${value}"`,
    );
  }
  return value;
}
