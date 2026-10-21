import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { timestamps } from "./_shared.js";

/**
 * How an update treats the jobs that run when it is confirmed (#46):
 *
 *   wait       new starts pause; running jobs finish, then the update is announced
 *   drain      new starts pause; worker jobs checkpoint and stop at once (they continue after
 *              the update without using up an attempt), runs on agents are waited for
 *   interrupt  new starts pause during the lead time only; the update does not wait
 */
export const JOB_PAUSE_MODES = ["wait", "drain", "interrupt"] as const;
export type JobPauseMode = (typeof JOB_PAUSE_MODES)[number];

/**
 * `draining`: the api waits for running jobs before it hands the update to the updater;
 * `announced`: the updater has the update (lead time, then the run); `fleet` (0.4.2): the
 * server is updated and the Proxmox VE nodes and endpoint agents update themselves (until all
 * reachable ones report the new version, at most `deadline_at`). All pause new starts.
 */
export const JOB_PAUSE_PHASES = ["draining", "announced", "fleet"] as const;
export type JobPausePhase = (typeof JOB_PAUSE_PHASES)[number];

/** Who confirmed the update (the requester the updater records once it gets the request). */
export type JobPauseRequester = { userId: string | null; label: string; ip: string | null };

/**
 * New job starts paused for an update (#46), at most one row (`singleton`). Written by the api
 * when an administrator confirms an update; read by the scheduler (no planning), the worker
 * (no new jobs from the queues, `drain` stops running ones cleanly) and the PVE node
 * heartbeat (no backup tasks handed out); `created_at` is when the pause began. The api
 * removes it once the update finished, was cancelled or could not be announced;
 * `expires_at` lifts the pause in any case, so an installation is never left paused by an
 * api that went away.
 *
 * `request` is the updater's schedule request, kept until the jobs drained (it holds no
 * secret: the access token is fetched by the updater itself). Installation-level, no tenant
 * data, no Row Level Security; the installation role alone reads and writes it.
 */
export const jobStartPause = pgTable(
  "job_start_pause",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Always true; the unique index keeps at most one pause.
    singleton: boolean("singleton").notNull().default(true),
    mode: text("mode").$type<JobPauseMode>().notNull(),
    phase: text("phase").$type<JobPausePhase>().notNull(),
    /** The release the pause is for. */
    version: text("version").notNull(),
    leadSeconds: integer("lead_seconds").notNull(),
    request: jsonb("request").$type<Record<string, unknown>>().notNull(),
    requestedBy: jsonb("requested_by").$type<JobPauseRequester>().notNull(),
    /**
     * `draining` ends here at the latest: the update is then announced anyway; `fleet` ends here
     * at the latest: the pause lifts although some nodes or agents did not update.
     */
    deadlineAt: timestamp("deadline_at", { withTimezone: true }).notNull(),
    /** When the update was handed to the updater. */
    announcedAt: timestamp("announced_at", { withTimezone: true }),
    /** The pause lifts itself here, whatever happened to the update. */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("job_start_pause_singleton_uq").on(t.singleton),
    check("job_start_pause_mode", sql`${t.mode} IN ('wait', 'drain', 'interrupt')`),
    check("job_start_pause_phase", sql`${t.phase} IN ('draining', 'announced', 'fleet')`),
  ],
);

export type JobStartPause = typeof jobStartPause.$inferSelect;
