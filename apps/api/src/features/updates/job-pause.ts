import {
  type Database,
  type JobPauseMode,
  type JobPauseRequester,
  type JobStartPause,
  jobStartPause,
} from "@restow/db";
import { and, eq, sql } from "drizzle-orm";
import { type ScheduleRequest, scheduleRequestSchema } from "../../updater/protocol.js";

/**
 * The jobs an update meets (#46): what runs and waits right now, and the pause of new
 * starts while an update waits for running jobs or is announced (@restow/db
 * `job_start_pause`; the scheduler, the worker and the PVE heartbeat follow it).
 * On the installation pool, across tenants.
 */

/** How long an update waits for running jobs at most, per mode. */
export const MAX_WAIT_SECONDS: Readonly<Record<JobPauseMode, number>> = {
  wait: 2 * 60 * 60,
  // Worker jobs stop within a minute; the wait is for runs on agents, which cannot be stopped.
  drain: 30 * 60,
  interrupt: 0,
};

/** How long the pause may hold after the lead time, for the update itself. */
export const UPDATE_WINDOW_SECONDS = 2 * 60 * 60;

/** Runs on agents count while they started within this time (older ones are closed elsewhere). */
const AGENT_RUN_HOURS = 48;

export interface ActivityCount {
  running: number;
  queued: number;
}

export interface JobActivity {
  /** Jobs of Microsoft 365, IMAP, the mail archive, imports, exports and restores (`jobs`). */
  mail: ActivityCount;
  /** Runs of the endpoint agents on servers and clients. */
  machines: ActivityCount;
  /** Backups of Proxmox VE guests (runs; queued: tasks not yet taken by the node). */
  pve: ActivityCount;
  /** Runs of file shares. */
  fileShares: ActivityCount;
  /** All running and all queued, together. */
  running: number;
  queued: number;
}

type Counts = {
  mail_running: string;
  mail_queued: string;
  machines_running: string;
  machines_queued: string;
  pve_running: string;
  pve_queued: string;
  shares_running: string;
  shares_queued: string;
};

/** What runs and waits right now, in every tenant. */
export async function jobActivity(db: Database): Promise<JobActivity> {
  const recent = sql`now() - make_interval(hours => ${AGENT_RUN_HOURS})`;
  const result = await db.execute<Counts>(sql`
    SELECT
      (SELECT count(*) FROM jobs WHERE status = 'active') AS mail_running,
      (SELECT count(*) FROM jobs WHERE status = 'queued') AS mail_queued,
      (SELECT count(*) FROM endpoint_runs WHERE status = 'running' AND started_at > ${recent})
        AS machines_running,
      (SELECT count(*) FROM endpoint_tasks
        WHERE kind = 'backup_now' AND status IN ('pending', 'delivered')) AS machines_queued,
      (SELECT count(*) FROM pve_runs WHERE status = 'running' AND started_at > ${recent})
        AS pve_running,
      (SELECT count(*) FROM pve_tasks
        WHERE kind = 'backup' AND status IN ('pending', 'delivered')
          AND NOT EXISTS (SELECT 1 FROM pve_runs r WHERE r.task_id = pve_tasks.id)) AS pve_queued,
      (SELECT count(*) FROM file_share_runs WHERE status IN ('starting', 'running'))
        AS shares_running,
      (SELECT count(*) FROM file_share_runs WHERE status = 'queued') AS shares_queued`);
  const row = result.rows[0];
  const n = (value: string | undefined) => Number(value ?? 0);
  const mail = { running: n(row?.mail_running), queued: n(row?.mail_queued) };
  const machines = { running: n(row?.machines_running), queued: n(row?.machines_queued) };
  const pve = { running: n(row?.pve_running), queued: n(row?.pve_queued) };
  const fileShares = { running: n(row?.shares_running), queued: n(row?.shares_queued) };
  const groups = [mail, machines, pve, fileShares];
  return {
    mail,
    machines,
    pve,
    fileShares,
    running: groups.reduce((sum, group) => sum + group.running, 0),
    queued: groups.reduce((sum, group) => sum + group.queued, 0),
  };
}

/** The pause row, expired or not. */
export async function loadJobPause(db: Database): Promise<JobStartPause | null> {
  const [row] = await db.select().from(jobStartPause).limit(1);
  return row ?? null;
}

export interface NewJobPause {
  mode: JobPauseMode;
  phase: "draining" | "announced";
  request: ScheduleRequest;
  requestedBy: JobPauseRequester;
  now: Date;
}

/**
 * Pause new starts for an update. Replaces an older pause: the caller has made sure no
 * update waits for jobs and the updater has none announced, so whatever is left is stale.
 */
export async function insertJobPause(db: Database, input: NewJobPause): Promise<JobStartPause> {
  const { request, now } = input;
  const announced = input.phase === "announced";
  const deadlineAt = new Date(now.getTime() + MAX_WAIT_SECONDS[input.mode] * 1000);
  const expiresAt = new Date(
    (announced ? now : deadlineAt).getTime() + (request.leadSeconds + UPDATE_WINDOW_SECONDS) * 1000,
  );
  return db.transaction(async (tx) => {
    await tx.delete(jobStartPause);
    const [row] = await tx
      .insert(jobStartPause)
      .values({
        mode: input.mode,
        phase: input.phase,
        version: request.release.version,
        leadSeconds: request.leadSeconds,
        request: request as unknown as Record<string, unknown>,
        requestedBy: input.requestedBy,
        deadlineAt,
        announcedAt: announced ? now : null,
        expiresAt,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!row) {
      throw new Error("the job pause was not written");
    }
    return row;
  });
}

/**
 * Take the waiting update for announcing it: only one api process wins (the row moves
 * from `draining` to `announced` in one statement). Returns the row, or null when the
 * update is no longer waiting.
 */
export async function claimDrainedUpdate(
  db: Database,
  pause: Pick<JobStartPause, "id" | "leadSeconds">,
  now: Date,
): Promise<JobStartPause | null> {
  const [row] = await db
    .update(jobStartPause)
    .set({
      phase: "announced",
      announcedAt: now,
      expiresAt: new Date(now.getTime() + (pause.leadSeconds + UPDATE_WINDOW_SECONDS) * 1000),
      updatedAt: now,
    })
    .where(and(eq(jobStartPause.id, pause.id), eq(jobStartPause.phase, "draining")))
    .returning();
  return row ?? null;
}

/** Lift the pause. Returns whether there was one. */
export async function removeJobPause(db: Database, id?: string): Promise<boolean> {
  const removed = await db
    .delete(jobStartPause)
    .where(id ? eq(jobStartPause.id, id) : sql`true`)
    .returning({ id: jobStartPause.id });
  return removed.length > 0;
}

/** The updater's request kept in the row, checked again before it is sent. */
export function storedRequestOf(row: JobStartPause): ScheduleRequest {
  return scheduleRequestSchema.parse(row.request);
}
