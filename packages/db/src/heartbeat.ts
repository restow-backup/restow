import { randomUUID } from "node:crypto";
import { hostname as osHostname } from "node:os";
import { and, eq, gt, inArray, lt, ne, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "./schema/index.js";
import {
  type ServiceHeartbeatDetails,
  type ServiceRole,
  serviceHeartbeats,
} from "./schema/system.js";

/**
 * Process liveness: the worker and the scheduler report in to
 * `service_heartbeats` and `/readyz` reads the rows back (docs/ARCHITECTURE.md,
 * Health). Every process upserts its row on a fixed interval and removes it on
 * a graceful shutdown; a process that dies without a goodbye simply stops
 * beating and counts as missing once its last beat is older than
 * {@link HEARTBEAT_FRESH_MS}.
 *
 * Both sides of the comparison use the database clock (`now()`), so a container
 * with a skewed clock cannot make a live process look dead or the reverse.
 */

/** How often a process reports in. */
export const HEARTBEAT_INTERVAL_MS = 30_000;

/** A beat younger than this counts as alive: four missed beats. */
export const HEARTBEAT_FRESH_MS = 120_000;

/** Rows of instances that vanished without a goodbye are swept at the next start after this long. */
const PRUNE_AFTER_MS = 24 * 3_600_000;

/** Status of a role as `/readyz` reports it. */
export type ServiceStatus = "ok" | "missing";

/** The roles that are checked next to the API itself. */
export type WatchedRole = Exclude<ServiceRole, "api">;

export type ServiceStatuses = Record<WatchedRole, ServiceStatus>;

/** What one beat writes. `beatAt` is the database clock, not a value of the caller. */
export interface HeartbeatRow {
  role: ServiceRole;
  instanceId: string;
  version: string;
  hostname: string | null;
  startedAt: Date;
  details: ServiceHeartbeatDetails;
}

/** The persistence of {@link ServiceHeartbeatReporter}; the default one writes `service_heartbeats`. */
export interface HeartbeatStore {
  /** Insert the row, or refresh its beat and state when the instance already has one. */
  upsert(row: HeartbeatRow): Promise<void>;
  /** Remove the row of one instance. */
  remove(instanceId: string): Promise<void>;
  /** Remove the rows of other instances whose last beat is older than `olderThanMs`. */
  prune(ownInstanceId: string, olderThanMs: number): Promise<void>;
}

type HeartbeatDatabase = Pick<
  NodePgDatabase<typeof schema>,
  "insert" | "delete" | "select" | "selectDistinct"
>;

/** `service_heartbeats` on the given pool (either role may read and write it). */
export function heartbeatStore(db: HeartbeatDatabase): HeartbeatStore {
  return {
    async upsert(row) {
      const beat = {
        version: row.version,
        hostname: row.hostname,
        details: row.details,
        beatAt: sql`now()`,
        updatedAt: sql`now()`,
      };
      await db
        .insert(serviceHeartbeats)
        .values({ ...row, beatAt: sql`now()` })
        .onConflictDoUpdate({ target: serviceHeartbeats.instanceId, set: beat });
    },
    async remove(instanceId) {
      await db.delete(serviceHeartbeats).where(eq(serviceHeartbeats.instanceId, instanceId));
    },
    async prune(ownInstanceId, olderThanMs) {
      await db
        .delete(serviceHeartbeats)
        .where(
          and(
            ne(serviceHeartbeats.instanceId, ownInstanceId),
            lt(serviceHeartbeats.beatAt, sql`now() - ${olderThanMs} * interval '1 millisecond'`),
          ),
        );
    },
  };
}

/**
 * A host name the `service_heartbeats.hostname` constraint accepts: never an
 * IP address (a dotted IPv4 literal, or anything with a colon), so a writer
 * reports null when the host has no proper name.
 */
export function heartbeatHostname(raw: string | null | undefined): string | null {
  const name = raw?.trim();
  if (!name || name.includes(":") || /^[0-9]{1,3}([.][0-9]{1,3}){3}$/.test(name)) {
    return null;
  }
  return name;
}

/** The version the image was built with (`RESTOW_VERSION`, tag prefix `v` dropped); `0.0.0-dev` for a local build. */
export function serviceVersion(env: Record<string, string | undefined> = process.env): string {
  const value = env.RESTOW_VERSION?.trim().replace(/^v/, "");
  return value ? value : "0.0.0-dev";
}

export interface ServiceHeartbeatReporterOptions {
  store: HeartbeatStore;
  role: ServiceRole;
  /** The state to report with the next beat (`state` plus whatever the role documents). */
  details: () => ServiceHeartbeatDetails;
  version?: string;
  hostname?: string | null;
  /** Stable for the lifetime of the process; random per start by default. */
  instanceId?: string;
  intervalMs?: number;
  /** A failed beat or removal never stops the process; it is reported here and tried again. */
  onError?: (error: unknown) => void;
  now?: () => Date;
}

/** One process's heartbeat: {@link start} it once the process is able to do its work, {@link stop} it on shutdown. */
export class ServiceHeartbeatReporter {
  readonly instanceId: string;
  private readonly role: ServiceRole;
  private readonly store: HeartbeatStore;
  private readonly details: () => ServiceHeartbeatDetails;
  private readonly version: string;
  private readonly hostname: string | null;
  private readonly intervalMs: number;
  private readonly onError: (error: unknown) => void;
  private readonly startedAt: Date;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<void> = Promise.resolve();
  private pending = 0;
  private stopped = false;

  constructor(options: ServiceHeartbeatReporterOptions) {
    this.store = options.store;
    this.role = options.role;
    this.details = options.details;
    this.instanceId = options.instanceId ?? `${options.role}-${randomUUID()}`;
    this.version = options.version ?? serviceVersion();
    this.hostname = heartbeatHostname(
      options.hostname === undefined ? osHostname() : options.hostname,
    );
    this.intervalMs = options.intervalMs ?? HEARTBEAT_INTERVAL_MS;
    this.onError = options.onError ?? (() => undefined);
    this.startedAt = (options.now ?? (() => new Date()))();
  }

  /** Sweep the rows of long-dead instances, report in now and then every interval. */
  async start(): Promise<void> {
    if (this.timer !== null || this.stopped) {
      return;
    }
    try {
      await this.store.prune(this.instanceId, PRUNE_AFTER_MS);
    } catch (error) {
      this.onError(error);
    }
    await this.beat();
    if (this.stopped) {
      return;
    }
    this.timer = setInterval(() => {
      // A database that answers slower than the interval must not build up a queue of beats.
      if (this.pending === 0) {
        void this.beat();
      }
    }, this.intervalMs);
    // The process is kept alive by its own work; the timer alone never does.
    this.timer.unref();
  }

  /** Report in now, for example right after the state changed. Never throws. */
  beat(): Promise<void> {
    this.pending += 1;
    this.inFlight = this.inFlight.then(async () => {
      if (this.stopped) {
        this.pending -= 1;
        return;
      }
      try {
        await this.store.upsert({
          role: this.role,
          instanceId: this.instanceId,
          version: this.version,
          hostname: this.hostname,
          startedAt: this.startedAt,
          details: this.details(),
        });
      } catch (error) {
        this.onError(error);
      } finally {
        this.pending -= 1;
      }
    });
    return this.inFlight;
  }

  /** Stop beating and remove the row: a clean shutdown is not a missing process. Never throws. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Let a beat that is in flight finish first, or it would write the row again after the removal.
    await this.inFlight;
    try {
      await this.store.remove(this.instanceId);
    } catch (error) {
      this.onError(error);
    }
  }
}

/**
 * Which of the watched roles has a heartbeat younger than `freshMs`: any
 * instance counts, so a second scheduler on stand-by does not hide a first one
 * that vanished, and the reverse. A role without a fresh beat is `missing`.
 */
export async function readServiceStatuses(
  db: HeartbeatDatabase,
  freshMs: number = HEARTBEAT_FRESH_MS,
): Promise<ServiceStatuses> {
  const watched: WatchedRole[] = ["worker", "scheduler"];
  const rows = await db
    .selectDistinct({ role: serviceHeartbeats.role })
    .from(serviceHeartbeats)
    .where(
      and(
        inArray(serviceHeartbeats.role, watched),
        gt(serviceHeartbeats.beatAt, sql`now() - ${freshMs} * interval '1 millisecond'`),
      ),
    );
  const alive = new Set<string>(rows.map((row) => row.role));
  return {
    worker: alive.has("worker") ? "ok" : "missing",
    scheduler: alive.has("scheduler") ? "ok" : "missing",
  };
}
