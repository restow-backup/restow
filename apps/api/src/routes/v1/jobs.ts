import { type Database, safeErrorMessage } from "@restow/db";
import type { Context } from "hono";
import { type SSEStreamingApi, streamSSE } from "hono/streaming";
import { z } from "zod";
import {
  type JobDetailDto,
  type JobDto,
  type StartBackupResult,
  isTerminalStatus,
} from "../../features/jobs/dto.js";
import {
  JobChangeTracker,
  type SseMessage,
  type StreamIo,
  type StreamStep,
  endMessage,
  runStreamLoop,
} from "../../features/jobs/events.js";
import { findJob, getJob, listJobs, startBackup } from "../../features/jobs/service.js";
import { ProblemError } from "../../problem.js";
import { type IntegrationApi, READ_ERRORS, type V1Deps, WRITE_ERRORS } from "./api.js";
import { V1_AUDIT_ACTIONS, presentFilters, readRecorder } from "./audit.js";
import { component } from "./components.js";
import {
  failureSchema,
  idParamSchema,
  jobStatusSchema,
  jobTypeSchema,
  objectKindSchema,
  objectStatusSchema,
  pageQuerySchema,
  pageSchema,
  timestampSchema,
  uuidSchema,
} from "./schemas.js";

/**
 * Jobs for integrations: GET /jobs, GET /jobs/:id, GET /jobs/:id/events (SSE)
 * and POST /jobs/backup. The work is the jobs feature's (its service reads,
 * enqueues and audits); this module maps its UI-shaped DTOs onto the
 * versioned v1 shapes, so the web UI can evolve without breaking an RMM.
 */

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const jobsQuerySchema = pageQuerySchema(100).extend({
  type: jobTypeSchema.optional().describe("Only jobs of this type (queue)."),
  status: jobStatusSchema.optional(),
  since: timestampSchema.optional().describe("Only jobs created at or after this instant."),
  protectedObjectId: uuidSchema.optional(),
});
export type JobsQuery = z.infer<typeof jobsQuerySchema>;

export const jobSchema = component(
  "Job",
  z.object({
    id: uuidSchema,
    type: jobTypeSchema,
    status: jobStatusSchema,
    protectedObjectId: uuidSchema.nullable(),
    object: z
      .object({
        id: uuidSchema,
        kind: objectKindSchema,
        displayName: z.string().nullable(),
        externalId: z.string(),
        status: objectStatusSchema,
      })
      .nullable(),
    full: z.boolean().describe("Backup jobs: a full re-enumeration instead of a delta run."),
    scheduled: z.boolean().describe("Started by a schedule rather than on request."),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    startedAt: timestampSchema.nullable(),
    completedAt: timestampSchema.nullable(),
    durationMs: z.number().int().nullable().describe("Run time of a finished job."),
    errorMessage: z.string().nullable(),
    failure: failureSchema
      .nullable()
      .describe(
        "Why the job failed (or its last attempt did), with the steps to fix it; null when it did not fail or no cause was recorded for it (then only `errorMessage` exists).",
      ),
    itemCauses: z
      .array(z.object({ code: z.string(), count: z.number().int() }))
      .describe(
        "Causes behind the failed items of a finished job, most frequent first (at most three).",
      ),
    progress: z
      .object({
        total: z.number().int(),
        done: z.number().int(),
        failed: z.number().int(),
        bytes: z.number().int(),
        etaSeconds: z.number().int().nullable(),
        updatedAt: timestampSchema,
      })
      .nullable(),
    phase: z.string().nullable().describe("Engine phase of a running job."),
    throttle: z
      .object({
        status: z.number().int().describe("HTTP status Microsoft Graph throttled with (429/503)."),
        waitMs: z.number().int(),
        retryAfterMs: z.number().int().nullable(),
        until: timestampSchema.describe("End of the current wait."),
        waits: z.number().int(),
        totalWaitMs: z.number().int(),
      })
      .nullable()
      .describe("The wait Microsoft Graph imposes on a running job, shown instead of hidden."),
    checkIncomplete: z
      .boolean()
      .describe(
        "A restore check (type `verify`) whose last attempt could not complete: the storage did not answer and nothing read proved damage, so it rated nothing (no report, the last result stays) and is repeated automatically. Not a failure.",
      ),
  }),
);
export type V1JobDto = z.infer<typeof jobSchema>;

export const jobsPageSchema = component("JobPage", pageSchema(jobSchema));
export type V1JobsPageDto = z.infer<typeof jobsPageSchema>;

export const jobDetailSchema = component(
  "JobDetail",
  jobSchema.extend({
    failures: z
      .array(
        z.object({
          itemRef: z.string(),
          reason: z.string(),
          failure: failureSchema
            .nullable()
            .describe("Why this item failed; null when only text exists."),
          attempts: z.number().int(),
          lastAttemptAt: timestampSchema.nullable(),
        }),
      )
      .describe("Items the job could not process (the first 500)."),
    failureCount: z.number().int().describe("Exact number of failed items."),
    failureGroups: z
      .array(z.object({ failure: failureSchema, count: z.number().int() }))
      .describe(
        "The failed items grouped by cause, most frequent first, with the latest example of each.",
      ),
    snapshot: z
      .object({
        id: uuidSchema,
        sequence: z.number().int(),
        state: z.enum(["running", "completed", "incomplete", "pruned"]),
        itemCount: z.number().int(),
        byteSize: z.number().int(),
        startedAt: timestampSchema.nullable(),
        completedAt: timestampSchema.nullable(),
      })
      .nullable()
      .describe("The snapshot a backup job produced or is producing."),
    result: z
      .object({
        snapshotId: uuidSchema,
        sequence: z.number().int(),
        objectsWritten: z.number().int(),
        objectsTotal: z.number().int(),
        bytes: z.number().int(),
        failures: z.number().int(),
        repairedCopies: z.number().int(),
        verifyJobId: uuidSchema.nullable(),
        throttleWaits: z.number().int(),
        throttleWaitMs: z.number().int(),
        completedAt: timestampSchema,
      })
      .nullable()
      .describe("What a finished backup stored."),
  }),
);
export type V1JobDetailDto = z.infer<typeof jobDetailSchema>;

export const backupRequestSchema = z.object({
  protectedObjectId: uuidSchema
    .optional()
    .describe("The object to back up; omit to back up every protected object."),
  full: z
    .boolean()
    .default(false)
    .describe("Re-enumerate everything instead of continuing from the delta state."),
});

export const backupSkipReasonSchema = z.enum([
  "excluded",
  "orphaned",
  "source_pending",
  "source_disabled",
  "already_queued",
]);

export const backupAcceptedSchema = component(
  "BackupAccepted",
  z.object({
    queued: z.array(jobSchema),
    skipped: z.array(
      z.object({
        protectedObjectId: uuidSchema,
        displayName: z.string().nullable(),
        reason: backupSkipReasonSchema,
      }),
    ),
  }),
);
export type BackupAcceptedDto = z.infer<typeof backupAcceptedSchema>;

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

function durationOf(startedAt: string | null, completedAt: string | null): number | null {
  if (!startedAt || !completedAt) {
    return null;
  }
  return Math.max(0, Date.parse(completedAt) - Date.parse(startedAt));
}

export function toV1Job(job: JobDto): V1JobDto {
  return {
    id: job.id,
    type: job.queue,
    status: job.status,
    protectedObjectId: job.protectedObjectId,
    object: job.object
      ? {
          id: job.object.id,
          kind: job.object.kind,
          displayName: job.object.displayName,
          externalId: job.object.externalId,
          status: job.object.status,
        }
      : null,
    full: job.full,
    scheduled: job.scheduleId !== null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    durationMs: durationOf(job.startedAt, job.completedAt),
    errorMessage: job.errorMessage,
    failure: job.failure,
    itemCauses: job.itemCauses,
    progress: job.progress,
    phase: job.phase?.name ?? null,
    throttle: job.throttle,
    checkIncomplete: job.checkIncomplete,
  };
}

export function toV1JobDetail(job: JobDetailDto): V1JobDetailDto {
  return {
    ...toV1Job(job),
    failures: job.failures.map(({ itemRef, reason, failure, attempts, lastAttemptAt }) => ({
      itemRef,
      reason,
      failure,
      attempts,
      lastAttemptAt,
    })),
    failureCount: job.failureCount,
    failureGroups: job.failureGroups,
    snapshot: job.snapshot
      ? {
          id: job.snapshot.id,
          sequence: job.snapshot.sequence,
          state: job.snapshot.state,
          itemCount: job.snapshot.itemCount,
          byteSize: job.snapshot.byteSize,
          startedAt: job.snapshot.startedAt,
          completedAt: job.snapshot.completedAt,
        }
      : null,
    result: job.result,
  };
}

export function toBackupAccepted(result: StartBackupResult): BackupAcceptedDto {
  return {
    queued: result.queued.map(toV1Job),
    skipped: result.skipped.map((skip) => ({
      protectedObjectId: skip.protectedObjectId,
      displayName: skip.displayName,
      reason: skip.reason,
    })),
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listV1Jobs(
  db: Database,
  tenantId: string,
  query: JobsQuery,
): Promise<V1JobsPageDto> {
  const page = await listJobs(db, tenantId, {
    type: query.type,
    status: query.status,
    since: query.since,
    protectedObjectId: query.protectedObjectId,
    limit: query.limit,
    cursor: query.cursor,
  });
  return { items: page.items.map(toV1Job), next: page.next };
}

export async function getV1Job(
  db: Database,
  tenantId: string,
  id: string,
): Promise<V1JobDetailDto> {
  return toV1JobDetail(await getJob(db, tenantId, id));
}

// ---------------------------------------------------------------------------
// Live updates (SSE)
// ---------------------------------------------------------------------------

/** A changed job in its v1 shape; the id lets a reconnecting client tell where it was. */
export function jobEvent(job: V1JobDto): SseMessage {
  return { event: "job", data: JSON.stringify(job), id: `${job.id}:${job.updatedAt}` };
}

/**
 * One poll of a single job's stream: `job` events while it changes, then one
 * `end` event once it finished (or disappeared), which closes the stream.
 */
export function jobStreamStep(
  tracker: JobChangeTracker,
  jobId: string,
  job: JobDto | null,
): StreamStep {
  if (job === null) {
    return { messages: [endMessage(jobId, null)], done: true };
  }
  const messages = tracker.changes([job]).map((changed) => jobEvent(toV1Job(changed)));
  if (isTerminalStatus(job.status)) {
    return { messages: [...messages, endMessage(jobId, job)], done: true };
  }
  return { messages, done: false };
}

function sleepUnless(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

function sseIo(stream: SSEStreamingApi): StreamIo {
  const disconnected = new AbortController();
  stream.onAbort(() => disconnected.abort());
  return {
    write: (message) => stream.writeSSE({ ...message }),
    heartbeat: async () => {
      await stream.write(": keep-alive\n\n");
    },
    sleep: (ms) => sleepUnless(ms, disconnected.signal),
    gone: () => stream.aborted || stream.closed,
    now: () => Date.now(),
  };
}

/**
 * Stream one job until it ends. The caller has checked that the job exists;
 * a read failure mid-stream sends an `error` event (the client reconnects)
 * and is logged here without any job data.
 */
export function streamJob(c: Context, db: Database, tenantId: string, jobId: string): Response {
  const tracker = new JobChangeTracker();
  // Tell reverse proxies not to buffer the stream.
  c.header("X-Accel-Buffering", "no");
  return streamSSE(c, async (stream) => {
    try {
      await runStreamLoop(sseIo(stream), async () =>
        jobStreamStep(tracker, jobId, await findJob(db, tenantId, jobId)),
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          level: "error",
          message: "integration job event stream failed",
          tenantId,
          jobId,
          // Never the failed query with its bound parameters.
          errorMessage: safeErrorMessage(error),
        }),
      );
    }
  });
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function registerJobRoutes(api: IntegrationApi, deps: V1Deps): void {
  const { db } = deps;
  const recordRead = readRecorder(deps);

  api.tenant(
    {
      method: "get",
      path: "/jobs",
      operationId: "listJobs",
      summary: "Jobs with progress, failures and duration, newest first",
      tag: "Jobs",
      scope: "jobs:read",
      audited: true,
      query: jobsQuerySchema,
      errors: READ_ERRORS,
      response: { status: 200, description: "A page of jobs.", schema: jobsPageSchema },
    },
    async ({ tenant, actor, input: { query } }) => {
      const page = await listV1Jobs(db, tenant.id, query);
      await recordRead(tenant.id, actor, {
        action: V1_AUDIT_ACTIONS.jobsRead,
        target: tenant.id,
        targetType: "tenant",
        details: {
          count: page.items.length,
          filters: presentFilters({
            type: query.type,
            status: query.status,
            since: query.since,
            protectedObjectId: query.protectedObjectId,
          }),
        },
      });
      return page;
    },
  );

  api.tenant(
    {
      method: "post",
      path: "/jobs/backup",
      operationId: "startBackup",
      summary: "Back up one object, or every protected object, now",
      description:
        "Objects that cannot run are listed under `skipped` with the reason; a single named object that cannot run is a 409 instead.",
      tag: "Jobs",
      scope: "restore:write",
      write: true,
      body: backupRequestSchema,
      errors: WRITE_ERRORS,
      response: { status: 202, description: "The queued jobs.", schema: backupAcceptedSchema },
    },
    async ({ tenant, actor, input: { body } }) =>
      toBackupAccepted(await startBackup(db, tenant.id, body, actor)),
  );

  api.tenant(
    {
      method: "get",
      path: "/jobs/:id",
      operationId: "getJob",
      summary: "One job with its failed items, snapshot and result",
      tag: "Jobs",
      scope: "jobs:read",
      audited: true,
      params: idParamSchema,
      errors: READ_ERRORS,
      response: { status: 200, description: "The job.", schema: jobDetailSchema },
    },
    async ({ tenant, actor, input: { params } }) => {
      const job = await getV1Job(db, tenant.id, params.id);
      await recordRead(tenant.id, actor, {
        action: V1_AUDIT_ACTIONS.jobRead,
        target: job.id,
        targetType: "job",
        details: { type: job.type, failureCount: job.failureCount },
      });
      return job;
    },
  );

  api.tenant(
    {
      method: "get",
      path: "/jobs/:id/events",
      operationId: "streamJobEvents",
      summary: "Live progress of one job (server-sent events)",
      description:
        "Events: `job` carries the job (same shape as `GET /jobs/{id}` without failures) whenever it changes; `end` ({ id, status }) follows once it finished and closes the stream; `error` means updates are unavailable, reconnect after the `retry` delay. A comment line keeps idle connections open. Streams end after five minutes; reconnect to continue.",
      tag: "Jobs",
      scope: "jobs:read",
      audited: true,
      params: idParamSchema,
      errors: READ_ERRORS,
      response: { status: 200, description: "An event stream.", contentType: "text/event-stream" },
    },
    async ({ c, tenant, actor, input: { params } }) => {
      if ((await findJob(db, tenant.id, params.id)) === null) {
        throw new ProblemError(404, "Job not found");
      }
      await recordRead(tenant.id, actor, {
        action: V1_AUDIT_ACTIONS.jobEventsOpened,
        target: params.id,
        targetType: "job",
      });
      return streamJob(c, db, tenant.id, params.id);
    },
  );
}
