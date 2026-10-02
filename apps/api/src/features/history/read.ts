import { mailJobObjectIds } from "@restow/core";
import {
  type Database,
  type EndpointReport,
  MAX_RUN_SAMPLES,
  type RunSamplePoint,
  backupJobs,
  endpointReports,
  endpointRuns,
  endpointTasks,
  endpoints,
  itemFailures,
  jobs,
  runSamples,
  snapshots,
} from "@restow/db";
import { type SQL, and, asc, count, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { config } from "../../config.js";
import { type Transaction, withTenantTx } from "../../lib/tenant-context.js";
import { ProblemError } from "../../problem.js";
import { loadAllMembers, loadObjectInfos } from "../backup-jobs/loaders.js";
import { jobsOfEndpoints } from "../backup-jobs/membership.js";
import { loadJob } from "../backup-jobs/read.js";
import { loadRatedTests } from "../endpoints/service.js";
import { type JobDto, type JobViewRow, backupResultOf } from "../jobs/dto.js";
import { type JobPageCursor, decodeCursor, encodeCursor } from "../jobs/pagination.js";
import { jobViewQuery, toJobDtos } from "../jobs/service.js";
import { loadSnapshotVerifications } from "../verify/verification-state.js";
import {
  ENDPOINT_KINDS_OF_CATEGORY,
  LIST_SAMPLE_COUNT,
  QUEUES_OF_CATEGORY,
  type RunBatchDto,
  type RunCategory,
  type RunDetailDto,
  type RunDto,
  type RunErrorDto,
  type RunEventDto,
  type RunObjectDto,
  type RunRestoreCheckDto,
  type RunSource,
  type RunState,
  type RunSummaryDto,
  batchOf,
  endpointRun,
  isFinished,
  mailRun,
  timeline,
} from "./dto.js";

/**
 * The read model of History: one list over the mail runs (`jobs`) and the runs agents
 * reported (`endpoint_runs`), the detail of one run and the set of runs the live channel
 * follows. Every read runs in the tenant's pinned transaction.
 *
 * The list is keyset-paged by `(created_at, id)`, newest first, over both tables at once: a page
 * names the ids and sources of its rows (one UNION query that touches nothing but the two
 * indexes on `(tenant_id, created_at)`), then each source loads its own rows.
 *
 * A restore test on a machine that could not complete is offered again as a new task, and each
 * try is a run of its own. History shows the newest try only ("attempt 3 of 7"): a run is
 * left out of the list when a newer run of a test of the same snapshot of the same machine exists.
 */

export const NOT_FOUND = () => new ProblemError(404, "Run not found");

/** Runs of one backup job started within this long of each other are one wave ("3 of 4 mailboxes"). */
export const WAVE_MS = 10 * 60_000;
/** The most runs of a wave the drawer counts, and how many of them it lists. */
const WAVE_LIMIT = 200;
const WAVE_LIST = 50;
/** Lines of errors the detail carries. */
const MAX_ERRORS = 20;

export interface HistoryQuery {
  category?: RunCategory;
  /** Only the runs of this backup job (its backups and their restore checks). */
  jobId?: string;
  limit: number;
  cursor?: string;
}

export interface HistoryPage {
  items: RunDto[];
  /** Cursor of the next page, or null on the last one. */
  next: string | null;
}

interface RunRef {
  source: RunSource;
  id: string;
}

// ---------------------------------------------------------------------------
// Hydration: ids to RunDtos
// ---------------------------------------------------------------------------

interface HydrateOptions {
  /** How many of the newest measurements each run carries. */
  sampleCount: number;
  /** Which runs carry measurements: those still running (a list) or all (a detail). */
  samples: "running" | "all";
}

async function loadSamples(
  tx: Transaction,
  tenantId: string,
  column: typeof runSamples.jobId | typeof runSamples.endpointRunId,
  ids: readonly string[],
): Promise<Map<string, RunSamplePoint[]>> {
  const result = new Map<string, RunSamplePoint[]>();
  if (ids.length === 0) {
    return result;
  }
  const rows = await tx
    .select({ id: column, points: runSamples.points })
    .from(runSamples)
    .where(and(eq(runSamples.tenantId, tenantId), inArray(column, [...ids])));
  for (const row of rows) {
    if (row.id) {
      result.set(row.id, row.points);
    }
  }
  return result;
}

interface MailLoad {
  rows: Map<string, JobViewRow>;
  dtos: Map<string, JobDto>;
  jobNames: Map<string, string>;
}

async function loadMail(
  tx: Transaction,
  tenantId: string,
  ids: readonly string[],
): Promise<MailLoad> {
  const rows = new Map<string, JobViewRow>();
  const dtos = new Map<string, JobDto>();
  const jobNames = new Map<string, string>();
  if (ids.length === 0) {
    return { rows, dtos, jobNames };
  }
  const found = await jobViewQuery(tx).where(
    and(eq(jobs.tenantId, tenantId), inArray(jobs.id, [...ids])),
  );
  const list = await toJobDtos(tx, tenantId, found);
  for (const row of found) {
    rows.set(row.job.id, row);
  }
  for (const dto of list) {
    dtos.set(dto.id, dto);
  }
  const jobIds = [...new Set(list.flatMap((dto) => (dto.backupJobId ? [dto.backupJobId] : [])))];
  if (jobIds.length > 0) {
    const named = await tx
      .select({ id: backupJobs.id, name: backupJobs.name })
      .from(backupJobs)
      .where(and(eq(backupJobs.tenantId, tenantId), inArray(backupJobs.id, jobIds)));
    for (const job of named) {
      jobNames.set(job.id, job.name);
    }
  }
  return { rows, dtos, jobNames };
}

export interface Hydrated {
  /** The runs behind the refs as DTOs, keyed by id. A ref that no longer exists is absent. */
  runs: Map<string, RunDto>;
  /** The same mail runs in the shape `/api/v1/jobs` has always had (the live channel's `job` events). */
  jobs: Map<string, JobDto>;
}

/** The runs behind `refs`. */
export async function hydrateRuns(
  tx: Transaction,
  tenantId: string,
  refs: readonly RunRef[],
  options: HydrateOptions,
): Promise<Hydrated> {
  const result = new Map<string, RunDto>();
  const mailIds = refs.filter((ref) => ref.source === "mail").map((ref) => ref.id);
  const endpointIds = refs.filter((ref) => ref.source === "endpoint").map((ref) => ref.id);

  const mail = await loadMail(tx, tenantId, mailIds);
  const mailSampleIds = [...mail.dtos.values()]
    .filter((dto) => options.samples === "all" || dto.status === "active")
    .map((dto) => dto.id);
  const mailSamples = await loadSamples(tx, tenantId, runSamples.jobId, mailSampleIds);
  for (const [id, row] of mail.rows) {
    const dto = mail.dtos.get(id);
    if (!dto) continue;
    const backupJobId = dto.backupJobId;
    result.set(
      id,
      mailRun({
        row,
        dto,
        job:
          backupJobId && mail.jobNames.has(backupJobId)
            ? { id: backupJobId, name: mail.jobNames.get(backupJobId) as string }
            : null,
        samples: mailSamples.get(id) ?? null,
        sampleCount: options.sampleCount,
      }),
    );
  }

  if (endpointIds.length > 0) {
    const runs = await tx
      .select()
      .from(endpointRuns)
      .where(and(eq(endpointRuns.tenantId, tenantId), inArray(endpointRuns.id, endpointIds)));
    const machineIds = [...new Set(runs.map((run) => run.endpointId))];
    const machines = machineIds.length
      ? await tx
          .select({
            id: endpoints.id,
            hostname: endpoints.hostname,
            displayName: endpoints.displayName,
            profile: endpoints.profile,
            os: endpoints.os,
          })
          .from(endpoints)
          .where(and(eq(endpoints.tenantId, tenantId), inArray(endpoints.id, machineIds)))
      : [];
    const machineBy = new Map(machines.map((machine) => [machine.id, machine]));
    const taskIds = runs.flatMap((run) => (run.taskId ? [run.taskId] : []));
    const tasks = taskIds.length
      ? await tx
          .select({ id: endpointTasks.id, params: endpointTasks.params })
          .from(endpointTasks)
          .where(and(eq(endpointTasks.tenantId, tenantId), inArray(endpointTasks.id, taskIds)))
      : [];
    const paramsBy = new Map(tasks.map((task) => [task.id, task.params]));
    const rated = await loadRatedTests(tx, tenantId, runs);
    const jobOf = await jobsOfEndpoints(tx, tenantId, machineIds);
    const sampleIds = runs
      .filter((run) => options.samples === "all" || run.status === "running")
      .map((run) => run.id);
    const endpointSamples = await loadSamples(tx, tenantId, runSamples.endpointRunId, sampleIds);
    for (const run of runs) {
      const machine = machineBy.get(run.endpointId);
      if (!machine) continue;
      result.set(
        run.id,
        endpointRun({
          run,
          endpoint: machine,
          taskParams: run.taskId ? (paramsBy.get(run.taskId) ?? null) : null,
          job: jobOf.get(run.endpointId) ?? null,
          rated: rated.runs.has(run.id),
          samples: endpointSamples.get(run.id) ?? null,
          sampleCount: options.sampleCount,
        }),
      );
    }
  }
  return { runs: result, jobs: mail.dtos };
}

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

/** The scope of one backup job: which of the tenant's runs belong to it. */
interface JobScope {
  jobId: string;
  /** Mail: the objects it covers (its backups and restore checks); null for a machine job. */
  objectIds: string[] | null;
  /** Machine jobs: the machines in it; null for a mail job. */
  endpointIds: string[] | null;
}

async function scopeOfJob(tx: Transaction, tenantId: string, jobId: string): Promise<JobScope> {
  const job = await loadJob(tx, tenantId, jobId);
  const members = await loadAllMembers(tx, tenantId);
  if (job.kind === "mail") {
    const objects = await loadObjectInfos(tx, tenantId);
    return {
      jobId,
      objectIds: mailJobObjectIds(
        job,
        members.filter((member) => member.protectedObjectId !== null) as {
          jobId: string;
          protectedObjectId: string;
        }[],
        objects,
      ),
      endpointIds: null,
    };
  }
  return {
    jobId,
    objectIds: null,
    endpointIds: members
      .filter((member) => member.jobId === jobId && member.endpointId)
      .map((member) => member.endpointId as string),
  };
}

function list(values: readonly string[]): SQL {
  return sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  );
}

const SORT_AT = (column: SQL) =>
  sql`to_char(date_trunc('milliseconds', ${column}) at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

/** The ids of one page, newest first, over both sources. */
export async function pageOfRefs(
  tx: Transaction,
  tenantId: string,
  query: Pick<HistoryQuery, "category" | "limit">,
  cursor: JobPageCursor | null,
  scope: JobScope | null,
): Promise<{ ref: RunRef; sortAt: string }[]> {
  const queues = query.category ? QUEUES_OF_CATEGORY[query.category] : null;
  const kinds = query.category ? ENDPOINT_KINDS_OF_CATEGORY[query.category] : null;

  // The mail branch.
  const mailWhere: SQL[] = [sql`j.tenant_id = ${tenantId}`];
  if (queues) {
    mailWhere.push(sql`j.queue in (${list(queues)})`);
  }
  if (scope) {
    if (scope.objectIds === null) {
      mailWhere.push(sql`false`);
    } else {
      mailWhere.push(sql`j.queue in ('backup', 'verify')`);
      const covered = scope.objectIds.length
        ? sql`j.protected_object_id in (${list(scope.objectIds)})`
        : sql`false`;
      // A job that was taken out of its scope still shows what it queued itself.
      mailWhere.push(sql`(${covered} or j.payload->>'backupJobId' = ${scope.jobId})`);
    }
  }
  // The endpoint branch.
  const endpointWhere: SQL[] = [sql`r.tenant_id = ${tenantId}`];
  if (kinds) {
    endpointWhere.push(kinds.length ? sql`r.kind in (${list(kinds)})` : sql`false`);
  }
  if (scope) {
    endpointWhere.push(
      scope.endpointIds?.length ? sql`r.endpoint_id in (${list(scope.endpointIds)})` : sql`false`,
    );
  }
  // One row for the tries of one restore test: leave a run out when a newer run tests the same snapshot.
  endpointWhere.push(sql`not (r.kind = 'verify_sample' and exists (
    select 1
      from endpoint_runs r2
      join endpoint_tasks t2 on t2.id = r2.task_id
      join endpoint_tasks t1 on t1.id = r.task_id
     where r2.tenant_id = r.tenant_id
       and r2.endpoint_id = r.endpoint_id
       and r2.kind = 'verify_sample'
       and t2.params->>'snapshotId' = t1.params->>'snapshotId'
       and (r2.created_at, r2.id) > (r.created_at, r.id)))`);

  if (cursor) {
    const at = new Date(cursor.createdAt);
    mailWhere.push(
      sql`(date_trunc('milliseconds', j.created_at), j.id) < (${at}::timestamptz, ${cursor.id}::uuid)`,
    );
    endpointWhere.push(
      sql`(date_trunc('milliseconds', r.created_at), r.id) < (${at}::timestamptz, ${cursor.id}::uuid)`,
    );
  }

  const result = await tx.execute(sql`
    select source, id, sort_at from (
      select 'mail'::text as source, j.id as id, ${SORT_AT(sql`j.created_at`)} as sort_at,
             date_trunc('milliseconds', j.created_at) as sort_key
        from jobs j
       where ${sql.join(mailWhere, sql` and `)}
      union all
      select 'endpoint'::text as source, r.id as id, ${SORT_AT(sql`r.created_at`)} as sort_at,
             date_trunc('milliseconds', r.created_at) as sort_key
        from endpoint_runs r
       where ${sql.join(endpointWhere, sql` and `)}
    ) page
    order by sort_key desc, id desc
    limit ${query.limit + 1}`);
  return (result.rows as { source: RunSource; id: string; sort_at: string }[]).map((row) => ({
    ref: { source: row.source, id: row.id },
    sortAt: row.sort_at,
  }));
}

export async function listHistory(
  db: Database,
  tenantId: string,
  query: HistoryQuery,
): Promise<HistoryPage> {
  const cursor = decodeCursor(query.cursor);
  if (query.cursor && !cursor) {
    throw new ProblemError(400, "Invalid cursor", {
      detail: "The cursor is not one this endpoint issued.",
    });
  }
  return withTenantTx(db, tenantId, async (tx) => {
    const scope = query.jobId ? await scopeOfJob(tx, tenantId, query.jobId) : null;
    const found = await pageOfRefs(tx, tenantId, query, cursor, scope);
    const page = found.slice(0, query.limit);
    const { runs } = await hydrateRuns(
      tx,
      tenantId,
      page.map((entry) => entry.ref),
      { sampleCount: LIST_SAMPLE_COUNT, samples: "running" },
    );
    const items = page.flatMap((entry) => {
      const run = runs.get(entry.ref.id);
      return run ? [run] : [];
    });
    const last = page[page.length - 1];
    return {
      items,
      next:
        found.length > query.limit && last
          ? encodeCursor({ createdAt: last.sortAt, id: last.ref.id })
          : null,
    };
  });
}

// ---------------------------------------------------------------------------
// The live window
// ---------------------------------------------------------------------------

/** Runs the live channel follows at most at once. */
export const LIVE_RUN_LIMIT = 200;

/**
 * The runs that are moving or changed since `since`: queued, running, or finished lately, running
 * ones first. Bounded by {@link LIVE_RUN_LIMIT}.
 */
export async function liveRuns(
  tx: Transaction,
  tenantId: string,
  since: Date,
): Promise<{ runs: RunDto[]; jobs: JobDto[] }> {
  const result = await tx.execute(sql`
    select source, id from (
      select 'mail'::text as source, j.id as id, (j.status = 'active') as active, j.updated_at as changed
        from jobs j
        left join job_progress p on p.job_id = j.id
       where j.tenant_id = ${tenantId}
         and (j.status in ('queued', 'active') or j.updated_at >= ${since} or p.updated_at >= ${since})
      union all
      select 'endpoint'::text, r.id, (r.status = 'running'), coalesce(r.finished_at, r.created_at)
        from endpoint_runs r
       where r.tenant_id = ${tenantId}
         and (r.status = 'running' or r.finished_at >= ${since} or r.created_at >= ${since})
    ) live
    order by active desc, changed desc, id desc
    limit ${LIVE_RUN_LIMIT}`);
  const refs = result.rows as unknown as RunRef[];
  const hydrated = await hydrateRuns(tx, tenantId, refs, {
    sampleCount: LIST_SAMPLE_COUNT,
    samples: "running",
  });
  return {
    runs: refs.flatMap((ref) => {
      const run = hydrated.runs.get(ref.id);
      return run ? [run] : [];
    }),
    jobs: refs.flatMap((ref) => {
      const job = hydrated.jobs.get(ref.id);
      return job ? [job] : [];
    }),
  };
}

// ---------------------------------------------------------------------------
// The detail
// ---------------------------------------------------------------------------

const NO_CHECK: RunRestoreCheckDto = { state: "none", checkedAt: null, runId: null };

function readinessState(readiness: string | null | undefined): RunRestoreCheckDto["state"] {
  switch (readiness) {
    case "green":
      return "passed";
    case "yellow":
      return "warning";
    case "red":
      return "failed";
    default:
      return "unverified";
  }
}

const CHECK_EVENT = {
  queued: "restore_check_queued",
  running: "restore_check_running",
  passed: "restore_check_passed",
  warning: "restore_check_warning",
  failed: "restore_check_failed",
} as const;

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

function checkEvent(
  check: RunRestoreCheckDto,
  fallbackAt: string | null,
): Omit<RunEventDto, "durationMs"> | null {
  if (check.state in CHECK_EVENT) {
    const at = check.checkedAt ?? fallbackAt;
    return at
      ? {
          at,
          type: CHECK_EVENT[check.state as keyof typeof CHECK_EVENT],
          params: { runId: check.runId },
        }
      : null;
  }
  return null;
}

/** What the backups' restore checks say: the snapshot's rating, or that a check is waiting or running. */
async function mailRestoreChecks(
  tx: Transaction,
  tenantId: string,
  rows: readonly JobViewRow[],
): Promise<Map<string, RunRestoreCheckDto>> {
  const result = new Map<string, RunRestoreCheckDto>();
  const backups = rows.filter((row) => row.job.queue === "backup" && row.job.protectedObjectId);
  if (backups.length === 0) {
    return result;
  }
  const snapshotRows = await tx
    .select({ id: snapshots.id, jobId: snapshots.jobId, objectId: snapshots.protectedObjectId })
    .from(snapshots)
    .where(
      and(
        eq(snapshots.tenantId, tenantId),
        inArray(
          snapshots.jobId,
          backups.map((row) => row.job.id),
        ),
      ),
    );
  const verification = await loadSnapshotVerifications(
    tx,
    tenantId,
    snapshotRows.map((row) => ({ id: row.id, objectId: row.objectId })),
  );
  const snapshotOf = new Map(snapshotRows.map((row) => [row.jobId, row]));
  const verifyIds = backups.flatMap((row) => {
    const id = backupResultOf("backup", row.job.payload ?? null)?.verifyJobId;
    return id ? [id] : [];
  });
  const verifyJobs = verifyIds.length
    ? await tx
        .select({
          id: jobs.id,
          status: jobs.status,
          createdAt: jobs.createdAt,
          startedAt: jobs.startedAt,
        })
        .from(jobs)
        .where(and(eq(jobs.tenantId, tenantId), inArray(jobs.id, verifyIds)))
    : [];
  const verifyBy = new Map(verifyJobs.map((job) => [job.id, job]));
  for (const row of backups) {
    const snapshot = snapshotOf.get(row.job.id);
    const verifyId = backupResultOf("backup", row.job.payload ?? null)?.verifyJobId ?? null;
    const verifyJob = verifyId ? verifyBy.get(verifyId) : undefined;
    const rating = snapshot ? verification.get(snapshot.id) : undefined;
    if (verifyJob && (verifyJob.status === "queued" || verifyJob.status === "active")) {
      result.set(row.job.id, {
        state: verifyJob.status === "queued" ? "queued" : "running",
        checkedAt: iso(verifyJob.startedAt ?? verifyJob.createdAt),
        runId: verifyJob.id,
      });
    } else if (rating && rating.state !== "unverified") {
      result.set(row.job.id, {
        state: readinessState(rating.state),
        checkedAt: rating.checkedAt,
        runId: verifyId,
      });
    } else {
      result.set(row.job.id, {
        state: snapshot ? "unverified" : "none",
        checkedAt: null,
        runId: verifyId,
      });
    }
  }
  return result;
}

/** The restore checks of agent backups: the report of the snapshot, else a test that waits or runs. */
async function endpointRestoreChecks(
  tx: Transaction,
  tenantId: string,
  runs: readonly (typeof endpointRuns.$inferSelect)[],
): Promise<Map<string, RunRestoreCheckDto>> {
  const result = new Map<string, RunRestoreCheckDto>();
  const backups = runs.filter((run) => run.kind === "backup" && run.snapshotId);
  if (backups.length === 0) {
    return result;
  }
  const snapshotIds = [...new Set(backups.map((run) => run.snapshotId as string))];
  const reports = await tx
    .select()
    .from(endpointReports)
    .where(
      and(
        eq(endpointReports.tenantId, tenantId),
        eq(endpointReports.kind, "restore_test"),
        inArray(endpointReports.snapshotId, snapshotIds),
      ),
    )
    .orderBy(desc(endpointReports.checkedAt));
  const reportBy = new Map<string, EndpointReport>();
  for (const report of reports) {
    // A red report from either side keeps the snapshot red; otherwise the newest one speaks.
    const known = report.snapshotId ? reportBy.get(report.snapshotId) : undefined;
    if (
      report.snapshotId &&
      (!known || (report.readiness === "red" && known.readiness !== "red"))
    ) {
      reportBy.set(report.snapshotId, report);
    }
  }
  const waiting = await tx
    .select({
      endpointId: endpointTasks.endpointId,
      status: endpointTasks.status,
      snapshotId: sql<string | null>`${endpointTasks.params}->>'snapshotId'`,
    })
    .from(endpointTasks)
    .where(
      and(
        eq(endpointTasks.tenantId, tenantId),
        eq(endpointTasks.kind, "verify_sample"),
        inArray(endpointTasks.status, ["pending", "delivered"]),
      ),
    );
  for (const run of backups) {
    const report = reportBy.get(run.snapshotId as string);
    const task = waiting.find(
      (candidate) =>
        candidate.endpointId === run.endpointId && candidate.snapshotId === run.snapshotId,
    );
    if (report) {
      result.set(run.id, {
        state: readinessState(report.readiness),
        checkedAt: report.checkedAt.toISOString(),
        runId: report.runId,
      });
    } else if (task) {
      result.set(run.id, {
        state: task.status === "delivered" ? "running" : "queued",
        checkedAt: null,
        runId: null,
      });
    } else {
      result.set(run.id, { state: "unverified", checkedAt: null, runId: null });
    }
  }
  return result;
}

const STATE_ORDER: Record<RunState, number> = {
  running: 0,
  failed: 1,
  partial: 2,
  queued: 3,
  cancelled: 4,
  succeeded: 5,
};

/** The mail runs of the same job started within a wave of this one, this one included. */
async function mailWave(
  tx: Transaction,
  tenantId: string,
  row: JobViewRow,
): Promise<{ runs: RunDto[]; rows: JobViewRow[]; truncated: boolean }> {
  const backupJobId =
    typeof row.job.payload?.backupJobId === "string" ? row.job.payload.backupJobId : null;
  if (!backupJobId || row.job.queue !== "backup") {
    return { runs: [], rows: [], truncated: false };
  }
  const from = new Date(row.job.createdAt.getTime() - WAVE_MS);
  const to = new Date(row.job.createdAt.getTime() + WAVE_MS);
  const found = await jobViewQuery(tx)
    .where(
      and(
        eq(jobs.tenantId, tenantId),
        eq(jobs.queue, "backup"),
        sql`${jobs.payload}->>'backupJobId' = ${backupJobId}`,
        gte(jobs.createdAt, from),
        sql`${jobs.createdAt} <= ${to}`,
      ),
    )
    .orderBy(asc(jobs.createdAt), asc(jobs.id))
    .limit(WAVE_LIMIT + 1);
  const rows = found.slice(0, WAVE_LIMIT);
  const dtos = await toJobDtos(tx, tenantId, rows);
  const runs = rows.flatMap((candidate, index) => {
    const dto = dtos[index];
    return dto ? [mailRun({ row: candidate, dto, job: null, sampleCount: 0 })] : [];
  });
  return { runs, rows, truncated: found.length > WAVE_LIMIT };
}

export async function getRunDetail(
  db: Database,
  tenantId: string,
  id: string,
): Promise<RunDetailDto> {
  return withTenantTx(db, tenantId, async (tx) => {
    const [mail] = await jobViewQuery(tx)
      .where(and(eq(jobs.tenantId, tenantId), eq(jobs.id, id)))
      .limit(1);
    if (mail) {
      return mailDetail(tx, tenantId, mail);
    }
    const [run] = await tx
      .select()
      .from(endpointRuns)
      .where(and(eq(endpointRuns.tenantId, tenantId), eq(endpointRuns.id, id)))
      .limit(1);
    if (run) {
      return endpointDetail(tx, tenantId, run);
    }
    throw NOT_FOUND();
  });
}

async function mailDetail(
  tx: Transaction,
  tenantId: string,
  row: JobViewRow,
): Promise<RunDetailDto> {
  const hydrated = await hydrateRuns(tx, tenantId, [{ source: "mail", id: row.job.id }], {
    sampleCount: MAX_RUN_SAMPLES,
    samples: "all",
  });
  const run = hydrated.runs.get(row.job.id);
  if (!run) {
    throw NOT_FOUND();
  }
  const payload = row.job.payload ?? null;
  const result = backupResultOf(row.job.queue, payload);
  const [snapshot] = await tx
    .select({ id: snapshots.id, sequence: snapshots.sequence })
    .from(snapshots)
    .where(and(eq(snapshots.tenantId, tenantId), eq(snapshots.jobId, row.job.id)))
    .orderBy(desc(snapshots.sequence))
    .limit(1);

  const checks = await mailRestoreChecks(tx, tenantId, [row]);
  let restoreCheck = checks.get(row.job.id) ?? NO_CHECK;
  if (row.job.queue === "verify" && run.state !== "running" && run.state !== "queued") {
    // The run is the check: its rating is its own result.
    const rated = payload?.result as { readiness?: string; completedAt?: string } | undefined;
    restoreCheck = rated?.readiness
      ? {
          state: readinessState(rated.readiness),
          checkedAt: rated.completedAt ?? iso(row.job.completedAt),
          runId: row.job.id,
        }
      : NO_CHECK;
  }

  // The failed items.
  const failureRows = await tx
    .select({
      itemRef: itemFailures.itemRef,
      reason: itemFailures.reason,
      failure: itemFailures.failure,
      createdAt: itemFailures.createdAt,
    })
    .from(itemFailures)
    .where(and(eq(itemFailures.tenantId, tenantId), eq(itemFailures.jobId, row.job.id)))
    .orderBy(asc(itemFailures.createdAt), asc(itemFailures.id))
    .limit(MAX_ERRORS);
  const [failureCount] = await tx
    .select({ value: count() })
    .from(itemFailures)
    .where(and(eq(itemFailures.tenantId, tenantId), eq(itemFailures.jobId, row.job.id)));
  const errors: RunErrorDto[] = failureRows.map((failure) => ({
    path: failure.itemRef.slice(0, 300),
    message: failure.reason.slice(0, 500),
    code: failure.failure?.code ?? null,
  }));

  // The wave: the runs of the same job started together.
  const wave = await mailWave(tx, tenantId, row);
  let batch: RunBatchDto | null = null;
  let objects: RunObjectDto[] = [];
  if (wave.runs.length > 0) {
    const waveChecks = await mailRestoreChecks(tx, tenantId, wave.rows);
    batch = batchOf(
      wave.runs.map((candidate) => candidate.state),
      { truncated: wave.truncated },
    );
    objects = wave.runs
      .flatMap((candidate): RunObjectDto[] =>
        candidate.subject
          ? [
              {
                runId: candidate.id,
                subject: candidate.subject,
                state: candidate.state,
                restoreCheck: waveChecks.get(candidate.id) ?? NO_CHECK,
                current: candidate.id === row.job.id,
              },
            ]
          : [],
      )
      .sort(
        (a, b) =>
          Number(b.current) - Number(a.current) ||
          STATE_ORDER[a.state] - STATE_ORDER[b.state] ||
          a.subject.name.localeCompare(b.subject.name),
      )
      .slice(0, WAVE_LIST);
  } else if (run.subject) {
    objects = [
      { runId: run.id, subject: run.subject, state: run.state, restoreCheck, current: true },
    ];
  }

  const events: Omit<RunEventDto, "durationMs">[] = [
    { at: run.createdAt, type: "queued", params: {} },
  ];
  if (run.startedAt) {
    events.push({ at: run.startedAt, type: "started", params: { full: run.full } });
  }
  if (run.state === "running" && run.phase) {
    events.push({
      at: run.phase.since ?? run.startedAt ?? run.createdAt,
      type: "phase",
      params: { phase: run.phase.name },
    });
  }
  if (run.state === "running" && run.throttle) {
    events.push({
      at: new Date(Date.parse(run.throttle.until) - run.throttle.waitMs).toISOString(),
      type: "throttled",
      params: { status: run.throttle.status, waitMs: run.throttle.waitMs },
    });
  }
  for (const failure of failureRows) {
    events.push({
      at: failure.createdAt.toISOString(),
      type: "item_failed",
      params: { item: failure.itemRef.slice(0, 200), reason: failure.reason.slice(0, 300) },
    });
  }
  if (run.finishedAt && isFinished(run.state)) {
    events.push({
      at: run.finishedAt,
      type:
        run.state === "failed" ? "failed" : run.state === "cancelled" ? "cancelled" : "completed",
      params: {
        itemsWritten: result?.objectsWritten ?? run.progress?.itemsDone ?? null,
        itemsTotal: result?.objectsTotal ?? run.progress?.itemsTotal ?? null,
        failed: run.progress?.itemsFailed ?? 0,
        message: run.state === "failed" ? (run.errorMessage ?? null) : null,
      },
    });
  }
  const resultEvent = row.job.queue === "backup" ? checkEvent(restoreCheck, run.finishedAt) : null;
  if (resultEvent) {
    events.push(resultEvent);
  }

  const summary: RunSummaryDto | null =
    row.job.queue === "backup" || result
      ? {
          itemsWritten: result?.objectsWritten ?? null,
          itemsTotal: result?.objectsTotal ?? null,
          filesNew: null,
          filesChanged: null,
          bytesNew: result?.bytes ?? run.progress?.bytesNew ?? null,
          snapshot: snapshot ? { id: snapshot.id, sequence: snapshot.sequence } : null,
          throttleWaits: result?.throttleWaits ?? 0,
          throttleWaitMs: result?.throttleWaitMs ?? 0,
        }
      : null;

  return {
    ...run,
    summary,
    restoreCheck,
    batch,
    objects,
    events: timeline(events),
    errors,
    errorCount: failureCount?.value ?? errors.length,
    logTail: null,
    docsUrl: config.docsTroubleshootingUrl,
  };
}

async function endpointDetail(
  tx: Transaction,
  tenantId: string,
  row: typeof endpointRuns.$inferSelect,
): Promise<RunDetailDto> {
  const hydrated = await hydrateRuns(tx, tenantId, [{ source: "endpoint", id: row.id }], {
    sampleCount: MAX_RUN_SAMPLES,
    samples: "all",
  });
  const run = hydrated.runs.get(row.id);
  if (!run) {
    throw NOT_FOUND();
  }
  const checks = await endpointRestoreChecks(tx, tenantId, [row]);
  const restoreCheck = checks.get(row.id) ?? NO_CHECK;

  // The runs of the same job's machines started together.
  let batch: RunBatchDto | null = null;
  let objects: RunObjectDto[] = [];
  const jobOf = await jobsOfEndpoints(tx, tenantId, [row.endpointId]);
  const job = jobOf.get(row.endpointId);
  if (job && row.kind === "backup") {
    const members = await loadAllMembers(tx, tenantId);
    const machineIds = members
      .filter((member) => member.jobId === job.id && member.endpointId)
      .map((member) => member.endpointId as string);
    const from = new Date(row.createdAt.getTime() - WAVE_MS);
    const to = new Date(row.createdAt.getTime() + WAVE_MS);
    const siblings = machineIds.length
      ? await tx
          .select()
          .from(endpointRuns)
          .where(
            and(
              eq(endpointRuns.tenantId, tenantId),
              eq(endpointRuns.kind, "backup"),
              inArray(endpointRuns.endpointId, machineIds),
              gte(endpointRuns.createdAt, from),
              sql`${endpointRuns.createdAt} <= ${to}`,
            ),
          )
          .orderBy(asc(endpointRuns.createdAt), asc(endpointRuns.id))
          .limit(WAVE_LIMIT + 1)
      : [];
    const shown = siblings.slice(0, WAVE_LIMIT);
    // One run per machine: the newest in the wave.
    const newestByMachine = new Map<string, (typeof shown)[number]>();
    for (const sibling of shown) {
      newestByMachine.set(sibling.endpointId, sibling);
    }
    // The run that was opened stands for its machine, even when a later one followed it.
    newestByMachine.set(row.endpointId, row);
    const waveRuns = [...newestByMachine.values()];
    if (waveRuns.length > 0) {
      const waveHydrated = await hydrateRuns(
        tx,
        tenantId,
        waveRuns.map((sibling) => ({ source: "endpoint" as const, id: sibling.id })),
        { sampleCount: 0, samples: "running" },
      );
      const waveChecks = await endpointRestoreChecks(tx, tenantId, waveRuns);
      const dtos = waveRuns.flatMap((sibling) => {
        const dto = waveHydrated.runs.get(sibling.id);
        return dto ? [dto] : [];
      });
      batch = batchOf(
        dtos.map((dto) => dto.state),
        { truncated: siblings.length > WAVE_LIMIT },
      );
      objects = dtos
        .flatMap((dto): RunObjectDto[] =>
          dto.subject
            ? [
                {
                  runId: dto.id,
                  subject: dto.subject,
                  state: dto.state,
                  restoreCheck: waveChecks.get(dto.id) ?? NO_CHECK,
                  current: dto.id === row.id,
                },
              ]
            : [],
        )
        .sort(
          (a, b) =>
            Number(b.current) - Number(a.current) ||
            STATE_ORDER[a.state] - STATE_ORDER[b.state] ||
            a.subject.name.localeCompare(b.subject.name),
        )
        .slice(0, WAVE_LIST);
    }
  }
  if (objects.length === 0 && run.subject) {
    objects = [
      { runId: run.id, subject: run.subject, state: run.state, restoreCheck, current: true },
    ];
  }

  const stats = row.stats;
  const events: Omit<RunEventDto, "durationMs">[] = [
    { at: run.startedAt ?? run.createdAt, type: "started", params: {} },
  ];
  const finishedAt = run.finishedAt;
  for (const error of row.errors.slice(0, MAX_ERRORS)) {
    events.push({
      at: finishedAt ?? run.startedAt ?? run.createdAt,
      type: "agent_error",
      params: {
        path: error.path ?? null,
        message: error.message.slice(0, 300),
        code: error.code ?? null,
      },
    });
  }
  if (finishedAt && isFinished(run.state)) {
    events.push({
      at: finishedAt,
      type: "finished",
      params: {
        state: run.state,
        filesNew: stats?.filesNew ?? null,
        filesChanged: stats?.filesChanged ?? null,
        dataAdded: stats?.dataAdded ?? null,
      },
    });
  }
  const checkLine = row.kind === "backup" ? checkEvent(restoreCheck, finishedAt) : null;
  if (checkLine) {
    events.push(checkLine);
  }

  return {
    ...run,
    summary: {
      itemsWritten: stats ? (stats.filesNew ?? 0) + (stats.filesChanged ?? 0) : null,
      itemsTotal: stats?.totalFilesProcessed ?? null,
      filesNew: stats?.filesNew ?? null,
      filesChanged: stats?.filesChanged ?? null,
      bytesNew: stats?.dataAdded ?? null,
      snapshot: row.snapshotId ? { id: row.snapshotId, sequence: null } : null,
      throttleWaits: 0,
      throttleWaitMs: 0,
    },
    restoreCheck,
    batch,
    objects,
    events: timeline(events),
    errors: row.errors.slice(0, MAX_ERRORS).map((error) => ({
      path: error.path ?? null,
      message: error.message,
      code: error.code ?? null,
    })),
    errorCount: row.errors.length,
    logTail: row.logTail,
    docsUrl: config.docsTroubleshootingUrl,
  };
}
