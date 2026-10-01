import { randomUUID } from "node:crypto";
import {
  type BackupJobPayload,
  type FirstBackupCandidate,
  type VerifyJobPayload,
  selectFirstBackupTargets,
} from "@restow/core";
import {
  type Database,
  itemFailures,
  jobProgress,
  jobs,
  protectedObjects,
  snapshots,
  sources,
} from "@restow/db";
import {
  type SQL,
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  lt,
  ne,
  not,
  or,
  sql,
} from "drizzle-orm";
import { config } from "../../config.js";
import { audit } from "../../lib/audit.js";
import { assertDemoJobNotInFlight, isDemoJobInFlight } from "../../lib/demo-limits.js";
import { type Transaction, withTenantTx } from "../../lib/tenant-context.js";
import { ProblemError } from "../../problem.js";
import { type FailureGroupDto, failureDto } from "../failures/dto.js";
import {
  loadObjectVerifications,
  loadSnapshotVerifications,
} from "../verify/verification-state.js";
import {
  type Actor,
  type BackupSkipDto,
  type BackupTargetDto,
  type ItemCauseCountDto,
  type JobDetailDto,
  type JobDto,
  type JobObjectDto,
  type JobQueueName,
  type JobViewRow,
  type ProtectedObjectKindName,
  type SnapshotsDto,
  type StartBackupResult,
  type VerifySummaryDto,
  backupBlockedReason,
  backupResultOf,
  finiteNumber,
  isRetryable,
  toFailureDto,
  toJobDto,
  toSnapshotDto,
  toSnapshotHistoryEntry,
  verifySummaryOf,
} from "./dto.js";
import { type JobPageCursor, type Page, decodeCursor, pageOf } from "./pagination.js";
import { cancelQueuedJob, isMissingQueueSchema, sendJob } from "./queue.js";
import type { ListJobsQuery, SnapshotsQuery, StartBackupInput } from "./schemas.js";

/**
 * Jobs: what the UI and integrations see of the worker's lifecycle rows, and
 * the three things a tenant admin may do to them (start a backup, cancel,
 * retry). Every read is tenant-pinned (RLS); every write is audited. The
 * response shapes and their mapping live in ./dto.ts.
 */

/** Audit actions written by this feature. */
export const JOB_AUDIT_ACTIONS = {
  backupRequested: "backup.requested",
  /** The system, not an admin, queued an object's very first backup (see {@link enqueueFirstBackups}). */
  firstBackupQueued: "backup.first_queued",
  jobCancelled: "job.cancelled",
  jobRetried: "job.retried",
} as const;

/** Audit detail keeps at most this many ids; the count above always tells the full story. */
const MAX_AUDITED_FIRST_BACKUP_IDS = 200;

/** How many item failures a detail response carries; the count is always exact. */
export const MAX_FAILURES_IN_DETAIL = 500;
/** Upper bound of jobs the tenant-wide event stream follows at once. */
export const LIVE_WINDOW_LIMIT = 200;

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

const objectSelection = {
  id: protectedObjects.id,
  sourceId: protectedObjects.sourceId,
  kind: protectedObjects.kind,
  displayName: protectedObjects.displayName,
  externalId: protectedObjects.externalId,
  status: protectedObjects.status,
};

function jobViewQuery(tx: Transaction) {
  return tx
    .select({ job: jobs, progress: jobProgress, object: objectSelection })
    .from(jobs)
    .leftJoin(jobProgress, eq(jobProgress.jobId, jobs.id))
    .leftJoin(protectedObjects, eq(protectedObjects.id, jobs.protectedObjectId));
}

/** `created_at` at the precision a cursor can carry (JavaScript dates are milliseconds). */
const createdAtMs = sql`date_trunc('milliseconds', ${jobs.createdAt})`;

function afterCursor(cursor: JobPageCursor): SQL {
  const createdAt = new Date(cursor.createdAt);
  return or(
    lt(createdAtMs, createdAt),
    and(eq(createdAtMs, createdAt), lt(jobs.id, cursor.id)),
  ) as SQL;
}

export function listFilters(tenantId: string, query: ListJobsQuery): SQL[] {
  const filters: SQL[] = [eq(jobs.tenantId, tenantId)];
  const queue = query.queue ?? query.type;
  if (queue) {
    filters.push(eq(jobs.queue, queue));
  }
  if (query.status) {
    filters.push(eq(jobs.status, query.status));
  }
  if (query.since) {
    filters.push(gte(jobs.createdAt, new Date(query.since)));
  }
  if (query.protectedObjectId) {
    filters.push(eq(jobs.protectedObjectId, query.protectedObjectId));
  }
  return filters;
}

export async function listJobs(
  db: Database,
  tenantId: string,
  query: ListJobsQuery,
): Promise<Page<JobDto>> {
  const cursor = decodeCursor(query.cursor);
  if (query.cursor && !cursor) {
    throw new ProblemError(400, "Invalid cursor", {
      detail: "The cursor is not one this endpoint issued.",
    });
  }
  const filters = listFilters(tenantId, query);
  if (cursor) {
    filters.push(afterCursor(cursor));
  }
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await jobViewQuery(tx)
      .where(and(...filters))
      .orderBy(desc(jobs.createdAt), desc(jobs.id))
      .limit(query.limit + 1);
    const page = pageOf(
      rows.map((row) => ({ ...row, id: row.job.id, createdAt: row.job.createdAt })),
      query.limit,
    );
    return { items: await toJobDtos(tx, tenantId, page.items), next: page.next };
  });
}

async function loadJobViews(tx: Transaction, ids: readonly string[]): Promise<JobViewRow[]> {
  if (ids.length === 0) {
    return [];
  }
  return jobViewQuery(tx).where(inArray(jobs.id, [...ids]));
}

async function loadJobView(tx: Transaction, tenantId: string, id: string): Promise<JobViewRow> {
  const [row] = await jobViewQuery(tx)
    .where(and(eq(jobs.tenantId, tenantId), eq(jobs.id, id)))
    .limit(1);
  if (!row) {
    throw new ProblemError(404, "Job not found");
  }
  return row;
}

/** Causes shown per job in lists. */
const MAX_ITEM_CAUSES_IN_LIST = 3;
/** Cause groups shown on a job's detail page. */
const MAX_FAILURE_GROUPS = 10;

/**
 * The causes behind the failed items of finished jobs, most frequent first, in
 * one grouped query for the whole page. Jobs that are still running are left
 * out (their counts still move) and so are jobs without failed items.
 */
async function loadItemCauses(
  tx: Transaction,
  tenantId: string,
  rows: readonly JobViewRow[],
): Promise<Map<string, ItemCauseCountDto[]>> {
  const ids = rows
    .filter(
      (row) =>
        (row.progress?.failed ?? 0) > 0 &&
        (row.job.status === "completed" || row.job.status === "failed"),
    )
    .map((row) => row.job.id);
  const result = new Map<string, ItemCauseCountDto[]>();
  if (ids.length === 0) {
    return result;
  }
  const grouped = await tx
    .select({
      jobId: itemFailures.jobId,
      code: sql<string>`${itemFailures.failure}->>'code'`,
      count: count(),
    })
    .from(itemFailures)
    .where(
      and(
        eq(itemFailures.tenantId, tenantId),
        inArray(itemFailures.jobId, ids),
        isNotNull(itemFailures.failure),
      ),
    )
    .groupBy(itemFailures.jobId, sql`${itemFailures.failure}->>'code'`);
  for (const row of grouped) {
    if (!row.code) {
      continue;
    }
    const list = result.get(row.jobId) ?? [];
    list.push({ code: row.code, count: row.count });
    result.set(row.jobId, list);
  }
  for (const [jobId, list] of result) {
    list.sort((a, b) => b.count - a.count || (a.code < b.code ? -1 : 1));
    result.set(jobId, list.slice(0, MAX_ITEM_CAUSES_IN_LIST));
  }
  return result;
}

/** Job DTOs for rows read in `tx`, with the causes of their failed items attached. */
async function toJobDtos(
  tx: Transaction,
  tenantId: string,
  rows: readonly JobViewRow[],
): Promise<JobDto[]> {
  const causes = await loadItemCauses(tx, tenantId, rows);
  return rows.map((row) => toJobDto(row, causes.get(row.job.id) ?? []));
}

/**
 * Jobs that are still moving or changed since `since`: the tenant-wide event
 * stream's window, bounded by {@link LIVE_WINDOW_LIMIT}. Queued jobs beyond the
 * bound join the window the moment they start.
 */
export async function listLiveJobs(
  db: Database,
  tenantId: string,
  since: Date,
  queue?: JobQueueName,
): Promise<JobDto[]> {
  const filters: SQL[] = [
    eq(jobs.tenantId, tenantId),
    or(
      inArray(jobs.status, ["queued", "active"]),
      gte(jobs.updatedAt, since),
      gte(jobProgress.updatedAt, since),
    ) as SQL,
  ];
  if (queue) {
    filters.push(eq(jobs.queue, queue));
  }
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await jobViewQuery(tx)
      .where(and(...filters))
      // Running jobs first, then whatever changed last: "Back up all" can queue
      // more jobs than the window holds, and the running ones must stay live.
      .orderBy(sql`(${jobs.status} = 'active') DESC`, desc(jobs.updatedAt), desc(jobs.id))
      .limit(LIVE_WINDOW_LIMIT);
    return toJobDtos(tx, tenantId, rows);
  });
}

/** One job as a DTO, or null when it does not exist (the single-job stream polls with this). */
export async function findJob(db: Database, tenantId: string, id: string): Promise<JobDto | null> {
  return withTenantTx(db, tenantId, async (tx) => {
    const [row] = await jobViewQuery(tx)
      .where(and(eq(jobs.tenantId, tenantId), eq(jobs.id, id)))
      .limit(1);
    if (!row) {
      return null;
    }
    const [dto] = await toJobDtos(tx, tenantId, [row]);
    return dto ?? null;
  });
}

/**
 * The failed items of a job grouped by cause, most frequent first, each with
 * the latest example (its details and steps). Items without a classified
 * cause are not grouped: the detail's `failureCount` still counts them.
 */
async function loadFailureGroups(
  tx: Transaction,
  tenantId: string,
  jobId: string,
): Promise<FailureGroupDto[]> {
  const code = sql<string>`${itemFailures.failure}->>'code'`;
  const where = and(
    eq(itemFailures.tenantId, tenantId),
    eq(itemFailures.jobId, jobId),
    isNotNull(itemFailures.failure),
  );
  const counts = await tx
    .select({ code, count: count() })
    .from(itemFailures)
    .where(where)
    .groupBy(code)
    .orderBy(desc(count()), code)
    .limit(MAX_FAILURE_GROUPS);
  if (counts.length === 0) {
    return [];
  }
  const examples = await tx
    .selectDistinctOn([code], { code, failure: itemFailures.failure })
    .from(itemFailures)
    .where(
      and(
        where,
        inArray(
          code,
          counts.map((row) => row.code),
        ),
      ),
    )
    .orderBy(code, desc(itemFailures.createdAt));
  const byCode = new Map(examples.map((row) => [row.code, row.failure]));
  return counts.flatMap((row) => {
    const failure = failureDto(byCode.get(row.code));
    return failure ? [{ failure, count: row.count }] : [];
  });
}

export async function getJob(db: Database, tenantId: string, id: string): Promise<JobDetailDto> {
  return withTenantTx(db, tenantId, async (tx) => {
    const view = await loadJobView(tx, tenantId, id);
    const failures = await tx
      .select()
      .from(itemFailures)
      .where(and(eq(itemFailures.tenantId, tenantId), eq(itemFailures.jobId, id)))
      .orderBy(asc(itemFailures.createdAt), asc(itemFailures.id))
      .limit(MAX_FAILURES_IN_DETAIL);
    const [failureCount] = await tx
      .select({ value: count() })
      .from(itemFailures)
      .where(and(eq(itemFailures.tenantId, tenantId), eq(itemFailures.jobId, id)));
    const [snapshot] = await tx
      .select()
      .from(snapshots)
      .where(and(eq(snapshots.tenantId, tenantId), eq(snapshots.jobId, id)))
      .orderBy(desc(snapshots.sequence))
      .limit(1);
    const [dto] = await toJobDtos(tx, tenantId, [view]);
    if (!dto) {
      throw new ProblemError(404, "Job not found");
    }
    return {
      ...dto,
      docsUrl: config.docsTroubleshootingUrl,
      failures: failures.map(toFailureDto),
      failureCount: failureCount?.value ?? failures.length,
      failureGroups: await loadFailureGroups(tx, tenantId, id),
      snapshot: snapshot ? toSnapshotDto(snapshot, dto.status) : null,
      result: backupResultOf(dto.queue, view.job.payload ?? null),
    };
  });
}

// ---------------------------------------------------------------------------
// Enqueueing
// ---------------------------------------------------------------------------

interface BackupCandidate {
  id: string;
  displayName: string | null;
  objectStatus: JobObjectDto["status"];
  sourceStatus: string;
}

async function loadBackupCandidates(
  tx: Transaction,
  tenantId: string,
  protectedObjectId?: string,
): Promise<BackupCandidate[]> {
  const filters: SQL[] = [eq(protectedObjects.tenantId, tenantId)];
  if (protectedObjectId) {
    filters.push(eq(protectedObjects.id, protectedObjectId));
  } else {
    // "Back up everything" means everything protected; excluded and orphaned
    // objects are not candidates, so they are not reported as skipped either.
    filters.push(eq(protectedObjects.status, "active"));
  }
  return tx
    .select({
      id: protectedObjects.id,
      displayName: protectedObjects.displayName,
      objectStatus: protectedObjects.status,
      sourceStatus: sources.status,
    })
    .from(protectedObjects)
    .innerJoin(sources, eq(sources.id, protectedObjects.sourceId))
    .where(and(...filters))
    .orderBy(asc(protectedObjects.displayName), asc(protectedObjects.externalId));
}

/** Insert the lifecycle row of a job pg-boss accepted. */
async function insertQueuedJob(
  tx: Transaction,
  tenantId: string,
  queue: "backup" | "verify",
  payload: BackupJobPayload | VerifyJobPayload,
  pgBossJobId: string,
): Promise<void> {
  await tx.insert(jobs).values({
    id: payload.jobId,
    tenantId,
    queue,
    status: "queued",
    protectedObjectId: payload.protectedObjectId,
    payload: payload as unknown as Record<string, unknown>,
    pgBossJobId,
  });
}

/** Create the pg-boss job and the lifecycle row for one backup; null when already queued. */
async function enqueueBackup(
  tx: Transaction,
  db: Database,
  tenantId: string,
  protectedObjectId: string,
  full: boolean,
): Promise<string | null> {
  const payload: BackupJobPayload = {
    jobId: randomUUID(),
    tenantId,
    protectedObjectId,
    ...(full ? { full: true } : {}),
  };
  const pgBossJobId = await sendJob(tx, "backup", payload, db);
  if (pgBossJobId === null) {
    return null;
  }
  await insertQueuedJob(tx, tenantId, "backup", payload, pgBossJobId);
  return payload.jobId;
}

/**
 * Whether each candidate already has a completed snapshot or a backup job in
 * flight. An id that does not name an `active` object of this tenant — wrong
 * tenant (RLS hides it, same as a typo'd id), or its status moved on again
 * before this ran — is silently dropped rather than acted on, the same way a
 * bulk action drops an id outside its source. An object whose source is
 * `pending` (a new IMAP source awaiting its first probe) or `disabled` is
 * dropped too: queuing it would only hand the worker a job it refuses with
 * `InvalidPayloadError`, which fails without retry and fires a `job.failed`
 * webhook for every such object (mirrors `backupBlockedReason`, the same rule
 * `startBackup` and the scheduler apply). The tenant's backup schedule or
 * "Backup now" queues it once the source becomes usable.
 */
async function loadFirstBackupCandidates(
  tx: Transaction,
  tenantId: string,
  protectedObjectIds: readonly string[],
): Promise<FirstBackupCandidate[]> {
  const requested = [...new Set(protectedObjectIds)];
  if (requested.length === 0) {
    return [];
  }
  const activeRows = await tx
    .select({ id: protectedObjects.id })
    .from(protectedObjects)
    .innerJoin(sources, eq(sources.id, protectedObjects.sourceId))
    .where(
      and(
        eq(protectedObjects.tenantId, tenantId),
        eq(protectedObjects.status, "active"),
        inArray(protectedObjects.id, requested),
        not(inArray(sources.status, ["pending", "disabled"])),
      ),
    );
  const ids = activeRows.map((row) => row.id);
  if (ids.length === 0) {
    return [];
  }
  const snapshotRows = await tx
    .selectDistinct({ protectedObjectId: snapshots.protectedObjectId })
    .from(snapshots)
    .where(
      and(
        eq(snapshots.tenantId, tenantId),
        eq(snapshots.status, "active"),
        isNotNull(snapshots.manifestPath),
        inArray(snapshots.protectedObjectId, ids),
      ),
    );
  const jobRows = await tx
    .selectDistinct({ protectedObjectId: jobs.protectedObjectId })
    .from(jobs)
    .where(
      and(
        eq(jobs.tenantId, tenantId),
        eq(jobs.queue, "backup"),
        inArray(jobs.status, ["queued", "active"]),
        inArray(jobs.protectedObjectId, ids),
      ),
    );
  const withSnapshot = new Set(snapshotRows.map((row) => row.protectedObjectId));
  const withJob = new Set(
    jobRows.flatMap((row) => (row.protectedObjectId ? [row.protectedObjectId] : [])),
  );
  return ids.map((id) => ({
    protectedObjectId: id,
    hasSnapshot: withSnapshot.has(id),
    hasQueuedOrActiveBackup: withJob.has(id),
  }));
}

/**
 * Enqueue the first backup of every object in `protectedObjectIds` that still
 * needs one: no completed snapshot yet, no backup already queued or running
 * (the selection is @restow/core's `selectFirstBackupTargets`, unit tested
 * there). Called the moment objects become protected — a directory sync
 * finding new or re-included objects, an admin including one object or many,
 * an IMAP account being added — so the first backup starts promptly instead
 * of waiting for the tenant's schedule (the readiness view's grace period,
 * verify/summary.ts, shows the honest wait either way).
 *
 * Batched per tenant in one tenant-pinned transaction; idempotent, because
 * pg-boss' backup singleton key (one queued/active job per object) makes
 * calling this again for an object already covered a safe no-op even under a
 * race with another trigger. Every object actually queued is written to the
 * audit log in one entry, attributed to the system: protection becoming
 * active started these backups, not an admin's specific decision.
 *
 * Called after the change that made these objects active has already
 * committed (a separate transaction), so a failure here must never surface
 * as a failed request: on a fresh install where the worker has not created
 * pg-boss' schema yet, this reports nothing queued instead of throwing,
 * exactly like {@link queueSyncAfterChange} does for a directory sync queued
 * right after a change. The tenant's backup schedule or "Backup now" queues
 * these objects once the worker is up.
 *
 * Demo mode (lib/demo-limits.ts) applies the same one-backup-batch-at-a-time
 * rule as "Back up now": while any backup of the tenant is queued or running,
 * this queues nothing, and says so in the log, instead of refusing with a 409
 * — the change that triggered it has already committed. The demo seed
 * (deploy/demo/seed) waits for these first backups and queues any object
 * skipped this way itself, one at a time. A visitor never reaches this path:
 * the demo guard refuses every protection change and account import.
 */
export async function enqueueFirstBackups(
  db: Database,
  tenantId: string,
  protectedObjectIds: readonly string[],
): Promise<string[]> {
  if (protectedObjectIds.length === 0) {
    return [];
  }
  try {
    return await withTenantTx(db, tenantId, async (tx) => {
      if (config.demo.enabled && (await isDemoJobInFlight(tx, tenantId, "backup"))) {
        console.info(
          JSON.stringify({
            level: "info",
            message: "first backup enqueue skipped: demo mode allows one backup at a time",
            tenantId,
            count: protectedObjectIds.length,
          }),
        );
        return [];
      }
      const candidates = await loadFirstBackupCandidates(tx, tenantId, protectedObjectIds);
      const targets = selectFirstBackupTargets(candidates);
      const queued: string[] = [];
      for (const id of targets) {
        const jobId = await enqueueBackup(tx, db, tenantId, id, false);
        if (jobId !== null) {
          queued.push(id);
        }
      }
      if (queued.length > 0) {
        await audit(tx, {
          tenantId,
          actor: "system",
          action: JOB_AUDIT_ACTIONS.firstBackupQueued,
          target: tenantId,
          targetType: "tenant",
          details: {
            count: queued.length,
            protectedObjectIds: queued.slice(0, MAX_AUDITED_FIRST_BACKUP_IDS),
            truncated: queued.length > MAX_AUDITED_FIRST_BACKUP_IDS,
          },
        });
      }
      return queued;
    });
  } catch (error) {
    if (!isMissingQueueSchema(error)) {
      throw error;
    }
    console.warn(
      JSON.stringify({
        level: "warn",
        message: "first backup enqueue skipped: job queue not ready",
        tenantId,
        count: protectedObjectIds.length,
      }),
    );
    return [];
  }
}

async function enqueueVerify(
  tx: Transaction,
  db: Database,
  tenantId: string,
  protectedObjectId: string,
  kind: "verify" | "health_check",
  sampleSize: number | undefined,
): Promise<string | null> {
  const payload: VerifyJobPayload = {
    jobId: randomUUID(),
    tenantId,
    protectedObjectId,
    kind,
    ...(sampleSize !== undefined ? { sampleSize } : {}),
  };
  const pgBossJobId = await sendJob(tx, "verify", payload, db);
  if (pgBossJobId === null) {
    return null;
  }
  await insertQueuedJob(tx, tenantId, "verify", payload, pgBossJobId);
  return payload.jobId;
}

/**
 * "Backup now" for one object or every protected object of the tenant.
 * Objects that cannot run are reported as skipped with the reason; a single
 * explicit object that cannot run is a 409 instead, so the caller learns why.
 */
export async function startBackup(
  db: Database,
  tenantId: string,
  input: StartBackupInput,
  actor: Actor,
): Promise<StartBackupResult> {
  return withTenantTx(db, tenantId, async (tx) => {
    if (config.demo.enabled) {
      await assertDemoJobNotInFlight(tx, tenantId, "backup");
    }
    const candidates = await loadBackupCandidates(tx, tenantId, input.protectedObjectId);
    if (input.protectedObjectId && candidates.length === 0) {
      throw new ProblemError(404, "Protected object not found");
    }
    const queuedIds: string[] = [];
    const skipped: BackupSkipDto[] = [];
    for (const candidate of candidates) {
      const blocked = backupBlockedReason(candidate.objectStatus, candidate.sourceStatus);
      if (blocked && input.protectedObjectId) {
        throw new ProblemError(409, "Backup not possible", {
          detail: "The object cannot be backed up in its current state.",
          extensions: { reason: blocked },
        });
      }
      const jobId = blocked
        ? null
        : await enqueueBackup(tx, db, tenantId, candidate.id, input.full);
      if (jobId === null) {
        skipped.push({
          protectedObjectId: candidate.id,
          displayName: candidate.displayName,
          reason: blocked ?? "already_queued",
        });
        continue;
      }
      queuedIds.push(jobId);
    }
    await audit(tx, {
      tenantId,
      actor: actor.label,
      actorUserId: actor.userId,
      action: JOB_AUDIT_ACTIONS.backupRequested,
      target: input.protectedObjectId ?? "all",
      targetType: input.protectedObjectId ? "protected_object" : "tenant",
      ip: actor.ip,
      details: {
        full: input.full,
        queued: queuedIds.length,
        skipped: skipped.length,
        jobIds: queuedIds,
      },
    });
    const views = await loadJobViews(tx, queuedIds);
    const byId = new Map(views.map((view) => [view.job.id, toJobDto(view)]));
    return {
      queued: queuedIds.flatMap((id) => byId.get(id) ?? []),
      skipped,
    };
  });
}

/**
 * Cancel a queued or running job. A queued job is withdrawn from pg-boss and
 * finished right here; a running job is flagged and the worker aborts it at
 * its next checkpoint (it then records the final state).
 */
export async function cancelJob(
  db: Database,
  tenantId: string,
  id: string,
  actor: Actor,
): Promise<JobDto> {
  const { dto, pgBossJobId } = await withTenantTx(db, tenantId, async (tx) => {
    const { job } = await loadJobView(tx, tenantId, id);
    if (job.status !== "queued" && job.status !== "active") {
      throw new ProblemError(409, "Job not cancellable", {
        detail: `A ${job.status} job cannot be cancelled.`,
        extensions: { status: job.status },
      });
    }
    const now = new Date();
    await tx
      .update(jobs)
      .set(
        job.status === "queued"
          ? { status: "cancelled", completedAt: now, cursor: null }
          : { status: "cancelled" },
      )
      .where(and(eq(jobs.tenantId, tenantId), eq(jobs.id, id)));
    await audit(tx, {
      tenantId,
      actor: actor.label,
      actorUserId: actor.userId,
      action: JOB_AUDIT_ACTIONS.jobCancelled,
      target: id,
      targetType: "job",
      ip: actor.ip,
      details: { queue: job.queue, previousStatus: job.status },
    });
    const updated = await loadJobView(tx, tenantId, id);
    return {
      dto: toJobDto(updated),
      pgBossJobId: job.status === "queued" ? job.pgBossJobId : null,
    };
  });
  if (pgBossJobId) {
    // Best effort: the row already says cancelled, and the worker checks that
    // before it starts a delivered job.
    await cancelQueuedJob(dto.queue, pgBossJobId, db).catch(() => undefined);
  }
  return dto;
}

/** Re-enqueue a failed or cancelled backup or verify for the same object. Returns the new job. */
export async function retryJob(
  db: Database,
  tenantId: string,
  id: string,
  actor: Actor,
): Promise<JobDto> {
  return withTenantTx(db, tenantId, async (tx) => {
    const { job, object } = await loadJobView(tx, tenantId, id);
    if (!isRetryable(job, object) || !object) {
      throw new ProblemError(409, "Job not retryable", {
        detail:
          "Only failed or cancelled backup and verify jobs of an active object can be retried.",
        extensions: { queue: job.queue, status: job.status },
      });
    }
    const payload = job.payload ?? {};
    let newJobId: string | null;
    if (job.queue === "backup") {
      newJobId = await enqueueBackup(tx, db, tenantId, object.id, payload.full === true);
    } else {
      const kind = payload.kind === "health_check" ? "health_check" : "verify";
      const sampleSize = finiteNumber(payload.sampleSize) ?? undefined;
      newJobId = await enqueueVerify(tx, db, tenantId, object.id, kind, sampleSize);
    }
    if (newJobId === null) {
      throw new ProblemError(409, "Job already queued", {
        detail: "A job of this kind is already queued or running for the object.",
        extensions: { reason: "already_queued" },
      });
    }
    await audit(tx, {
      tenantId,
      actor: actor.label,
      actorUserId: actor.userId,
      action: JOB_AUDIT_ACTIONS.jobRetried,
      target: newJobId,
      targetType: "job",
      ip: actor.ip,
      details: { queue: job.queue, previousJobId: id, protectedObjectId: object.id },
    });
    return toJobDto(await loadJobView(tx, tenantId, newJobId));
  });
}

// ---------------------------------------------------------------------------
// Snapshots and backup targets
// ---------------------------------------------------------------------------

/**
 * The rating of each object's newest backup (the verify feature's rule): an
 * object whose newest backup was not checked yet has none, whatever an older
 * backup scored.
 */
async function latestVerifyByObject(
  tx: Transaction,
  tenantId: string,
  objectIds: readonly string[],
): Promise<Map<string, VerifySummaryDto>> {
  const verifications = await loadObjectVerifications(tx, tenantId, objectIds);
  const result = new Map<string, VerifySummaryDto>();
  for (const [objectId, facts] of verifications) {
    const summary = verifySummaryOf(facts.verification);
    if (summary) {
      result.set(objectId, summary);
    }
  }
  return result;
}

/** The snapshot history of one protected object, newest first. */
export async function listSnapshots(
  db: Database,
  tenantId: string,
  protectedObjectId: string,
  options: SnapshotsQuery,
): Promise<SnapshotsDto> {
  return withTenantTx(db, tenantId, async (tx) => {
    const [object] = await tx
      .select(objectSelection)
      .from(protectedObjects)
      .where(
        and(eq(protectedObjects.tenantId, tenantId), eq(protectedObjects.id, protectedObjectId)),
      )
      .limit(1);
    if (!object) {
      throw new ProblemError(404, "Protected object not found");
    }
    const filters: SQL[] = [
      eq(snapshots.tenantId, tenantId),
      eq(snapshots.protectedObjectId, protectedObjectId),
    ];
    if (!options.includePruned) {
      filters.push(eq(snapshots.status, "active"));
    }
    const rows = await tx
      .select({ snapshot: snapshots, jobStatus: jobs.status })
      .from(snapshots)
      .leftJoin(jobs, eq(jobs.id, snapshots.jobId))
      .where(and(...filters))
      .orderBy(desc(snapshots.sequence))
      .limit(options.limit);
    const verify = await latestVerifyByObject(tx, tenantId, [protectedObjectId]);
    const verifications = await loadSnapshotVerifications(
      tx,
      tenantId,
      rows.map((row) => ({ id: row.snapshot.id, objectId: protectedObjectId })),
    );
    return {
      object,
      snapshots: rows.map((row) =>
        toSnapshotHistoryEntry(row.snapshot, row.jobStatus, verifications.get(row.snapshot.id)),
      ),
      latestVerify: verify.get(protectedObjectId) ?? null,
    };
  });
}

/** Every protected object with what "Backup now" needs to know about it. */
export async function listBackupTargets(
  db: Database,
  tenantId: string,
  kind?: ProtectedObjectKindName,
): Promise<BackupTargetDto[]> {
  return withTenantTx(db, tenantId, async (tx) => {
    // Imported mailboxes have nothing to back up (source kind `import`), so they
    // are no "Backup now" targets.
    const filters: SQL[] = [eq(protectedObjects.tenantId, tenantId), ne(sources.kind, "import")];
    if (kind) {
      filters.push(eq(protectedObjects.kind, kind));
    }
    const objects = await tx
      .select({
        object: objectSelection,
        source: {
          id: sources.id,
          name: sources.name,
          kind: sql<"m365" | "imap">`${sources.kind}`,
          status: sources.status,
        },
      })
      .from(protectedObjects)
      .innerJoin(sources, eq(sources.id, protectedObjects.sourceId))
      .where(and(...filters))
      .orderBy(asc(protectedObjects.displayName), asc(protectedObjects.externalId));
    const ids = objects.map((row) => row.object.id);
    if (ids.length === 0) {
      return [];
    }

    const lastSnapshots = await tx
      .selectDistinctOn([snapshots.protectedObjectId])
      .from(snapshots)
      .where(
        and(
          eq(snapshots.tenantId, tenantId),
          inArray(snapshots.protectedObjectId, ids),
          eq(snapshots.status, "active"),
          sql`${snapshots.manifestPath} IS NOT NULL`,
        ),
      )
      .orderBy(snapshots.protectedObjectId, desc(snapshots.sequence));
    const lastJobs = await tx
      .selectDistinctOn([jobs.protectedObjectId], {
        job: jobs,
        progress: jobProgress,
        object: objectSelection,
      })
      .from(jobs)
      .leftJoin(jobProgress, eq(jobProgress.jobId, jobs.id))
      .leftJoin(protectedObjects, eq(protectedObjects.id, jobs.protectedObjectId))
      .where(
        and(
          eq(jobs.tenantId, tenantId),
          inArray(jobs.protectedObjectId, ids),
          eq(jobs.queue, "backup"),
        ),
      )
      .orderBy(jobs.protectedObjectId, desc(jobs.createdAt), desc(jobs.id));
    const verify = await latestVerifyByObject(tx, tenantId, ids);

    const snapshotByObject = new Map(lastSnapshots.map((row) => [row.protectedObjectId, row]));
    const lastJobDtos = await toJobDtos(tx, tenantId, lastJobs);
    const jobByObject = new Map(
      lastJobDtos.flatMap((dto) =>
        dto.protectedObjectId ? [[dto.protectedObjectId, dto] as const] : [],
      ),
    );

    return objects.map(({ object, source }) => {
      const snapshot = snapshotByObject.get(object.id);
      return {
        ...object,
        source,
        blocked: backupBlockedReason(object.status, source.status),
        lastSnapshot: snapshot ? toSnapshotDto(snapshot, null) : null,
        lastJob: jobByObject.get(object.id) ?? null,
        latestVerify: verify.get(object.id) ?? null,
      };
    });
  });
}
