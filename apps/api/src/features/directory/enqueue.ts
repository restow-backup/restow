import { randomUUID } from "node:crypto";
import type { DirectoryJobPayload } from "@restow/core";
import { type Database, jobs } from "@restow/db";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { type Transaction, withTenantTx } from "../../lib/tenant-context.js";
import { ProblemError } from "../../problem.js";
import { type JobThrottleDto, runtimeThrottleOf } from "../jobs/dto.js";
import { isMissingQueueSchema, sendJob } from "../jobs/queue.js";

/**
 * Queue a directory sync from the API.
 *
 * The pg-boss job and the Restow `jobs` lifecycle row are written in one
 * tenant-pinned transaction through the jobs feature's queue handle, so a
 * failed enqueue never leaves a row that nothing will run. The queue's
 * `stately` policy and the per-source singleton key (@restow/core
 * engine/jobs.ts) keep it to one queued and one running sync per source.
 */

const QUEUE = "directory";

export type EnqueueOutcome =
  | { status: "queued"; jobId: string }
  | { status: "already_queued"; jobId: string | null };

export interface PendingSync {
  id: string;
  status: "queued" | "active";
  startedAt: Date | null;
  /** The current (or last) Graph throttling wait of a running sync. */
  throttle: JobThrottleDto | null;
}

/** The pending or running sync of a source, if any (newest first). */
export async function findPendingSync(
  tx: Transaction,
  tenantId: string,
  sourceId: string,
): Promise<PendingSync | null> {
  const [row] = await tx
    .select({ id: jobs.id, status: jobs.status, startedAt: jobs.startedAt, payload: jobs.payload })
    .from(jobs)
    .where(
      and(
        eq(jobs.tenantId, tenantId),
        eq(jobs.queue, QUEUE),
        inArray(jobs.status, ["queued", "active"]),
        sql`${jobs.payload}->>'sourceId' = ${sourceId}`,
      ),
    )
    .orderBy(desc(jobs.createdAt))
    .limit(1);
  if (!row || (row.status !== "queued" && row.status !== "active")) {
    return null;
  }
  return {
    id: row.id,
    status: row.status,
    startedAt: row.startedAt,
    throttle: row.status === "active" ? runtimeThrottleOf(row.payload ?? null) : null,
  };
}

function queueNotReady(): ProblemError {
  return new ProblemError(503, "Job queue not ready", {
    type: "urn:restow:problem:queue-unavailable",
    detail: "The worker has not created its job queues yet. Start the worker and try again.",
  });
}

/**
 * pg-boss answers "no job" both for a taken singleton key and for a queue
 * that does not exist; only the first is "already queued".
 */
async function queueExists(tx: Transaction): Promise<boolean> {
  const result = await tx.execute(sql`SELECT 1 FROM pgboss.queue WHERE name = ${QUEUE} LIMIT 1`);
  return result.rows.length > 0;
}

/** Queue a sync for the source, or report the one already pending. */
export async function enqueueDirectorySync(
  db: Database,
  tenantId: string,
  sourceId: string,
): Promise<EnqueueOutcome> {
  try {
    return await withTenantTx(db, tenantId, async (tx) => {
      const pending = await findPendingSync(tx, tenantId, sourceId);
      if (pending) {
        return { status: "already_queued", jobId: pending.id };
      }
      if (!(await queueExists(tx))) {
        throw queueNotReady();
      }
      const payload: DirectoryJobPayload = { jobId: randomUUID(), tenantId, sourceId };
      const pgBossJobId = await sendJob(tx, QUEUE, payload, db);
      if (pgBossJobId === null) {
        return { status: "already_queued", jobId: null };
      }
      await tx.insert(jobs).values({
        id: payload.jobId,
        tenantId,
        queue: QUEUE,
        status: "queued",
        payload: { ...payload },
        pgBossJobId,
      });
      return { status: "queued", jobId: payload.jobId };
    });
  } catch (error) {
    if (isMissingQueueSchema(error)) {
      throw queueNotReady();
    }
    throw error;
  }
}
