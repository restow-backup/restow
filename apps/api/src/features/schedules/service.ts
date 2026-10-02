import {
  type CadenceInput,
  type ScheduleKind as CoreScheduleKind,
  type ExistingSchedule,
  PREVIEW_RUN_COUNT,
  isValidTimeZone,
  kindsOfRecommendations,
  missingRecommendedSchedules,
  nextRunAt,
  recommendedSchedules,
  upcomingRuns,
} from "@restow/core";
import {
  type Database,
  type Job,
  type ProtectedObject,
  type Schedule,
  type ScheduleKind,
  backupJobs,
  protectedObjects,
  schedules,
  sources,
  tenants,
  users,
} from "@restow/db";
import { and, asc, eq, sql } from "drizzle-orm";
import { audit } from "../../lib/audit.js";
import { isImportedObject } from "../../lib/imported-objects.js";
import { type Transaction, withTenantTx } from "../../lib/tenant-context.js";
import { ProblemError } from "../../problem.js";
import { ensureDefaultMailJob, mailJobCoverage } from "../backup-jobs/defaults.js";
import { type OwnedObject, type Viewer, isOwnObject, seesAllObjects } from "../snapshots/access.js";
import {
  type ApplyRecommendedInput,
  type CreateScheduleInput,
  OBJECT_SCOPED_KINDS,
  type PreviewScheduleInput,
  type UpdateScheduleInput,
  assertCadenceOrProblem,
  scheduleProblem,
} from "./schemas.js";

/**
 * The schedules of a tenant: what runs unattended (backup, verification,
 * scrub, directory sync, retention), how often, and how the last run went.
 * Everything runs in the tenant's RLS context and every change is audited in
 * the same transaction. Next runs are computed with the same @restow/core
 * code the scheduler plans with, so what the page shows is what happens.
 */

export const SCHEDULE_AUDIT_ACTIONS = {
  created: "schedule.created",
  updated: "schedule.updated",
  deleted: "schedule.deleted",
  recommendedApplied: "schedule.recommended.applied",
} as const;

/** Who acts: the signed-in administrator. */
export interface ScheduleActor {
  userId: string | null;
  label: string;
  ip: string | null;
}

/**
 * The one object a schedule is narrowed to. A tenant user learns another
 * person's object by its kind only: id and name are null (the object list and
 * the jobs that name mailboxes are for administrators).
 */
export type ScheduleObjectDto =
  | {
      id: string;
      /** Display name, else the address or external id. */
      name: string;
      kind: ProtectedObject["kind"];
    }
  | { id: null; name: null; kind: ProtectedObject["kind"] };

export interface ScheduleLastJobDto {
  /** Null for viewers who may not open jobs (tenant users). */
  id: string | null;
  status: Job["status"];
  finishedAt: string | null;
}

export interface ScheduleDto {
  id: string;
  kind: ScheduleKind;
  /** The one object a backup or verify schedule is narrowed to; null for all objects. */
  protectedObject: ScheduleObjectDto | null;
  intervalMinutes: number | null;
  cron: string | null;
  timezone: string;
  enabled: boolean;
  /** When it runs next; null while the schedule is switched off. */
  nextRunAt: string | null;
  lastRunAt: string | null;
  /**
   * The job of the last run. A run that enqueued several jobs (a backup of
   * every mailbox) is represented by its most telling one: a failed job before
   * a running one, before a queued, cancelled and finally a completed one.
   */
  lastJob: ScheduleLastJobDto | null;
  /**
   * The backup job that took this schedule over (release 0.2.0): the scheduler no longer plans
   * it and it cannot be changed, but the row stays. Null for a schedule that still runs.
   */
  supersededByJobId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduleListDto {
  items: ScheduleDto[];
  /** Recommended kinds the tenant has no schedule for (POST /recommended adds them). */
  missingKinds: CoreScheduleKind[];
}

export interface SchedulePreviewDto {
  /** The next runs as ISO instants (UTC), the first one being the next run of a new schedule. */
  next: string[];
}

export interface ApplyRecommendedDto {
  /** The schedules this call created (empty when every recommendation was covered). */
  created: ScheduleDto[];
  /**
   * The default mail job this call created, when the tenant had no job covering its objects:
   * backups and restore checks live in jobs since 0.2.0, not in schedules.
   */
  jobCreated: { id: string; name: string } | null;
  missingKinds: CoreScheduleKind[];
}

type ObjectRow = Pick<ProtectedObject, "id" | "displayName" | "externalId" | "kind">;

/**
 * What a viewer may learn about a schedule beyond its cadence. Administrators
 * see everything; a tenant user sees the name of an object only when it is
 * their own, and never a job id (the job pages are for administrators).
 */
export interface ScheduleVisibility {
  objectName: boolean;
  jobId: boolean;
}

/** Everything: the administrators' view (and every response to a change they made). */
export const FULL_VISIBILITY: ScheduleVisibility = { objectName: true, jobId: true };

// ---------------------------------------------------------------------------
// Pure mapping
// ---------------------------------------------------------------------------

const iso = (value: Date | string | null): string | null =>
  value === null ? null : new Date(value).toISOString();

/**
 * The visibility of one schedule for a viewer. `object` is the object the
 * schedule is narrowed to with its owner's address (null when it covers all
 * objects).
 */
export function scheduleVisibility(
  viewer: Pick<Viewer, "role" | "email">,
  object: OwnedObject | null,
): ScheduleVisibility {
  if (seesAllObjects(viewer)) {
    return FULL_VISIBILITY;
  }
  return { objectName: object === null || isOwnObject(viewer, object), jobId: false };
}

export function toObjectDto(
  object: ObjectRow | null,
  visibility: ScheduleVisibility = FULL_VISIBILITY,
): ScheduleObjectDto | null {
  if (!object) {
    return null;
  }
  if (!visibility.objectName) {
    return { id: null, name: null, kind: object.kind };
  }
  const displayName = object.displayName?.trim();
  return {
    id: object.id,
    name: displayName && displayName.length > 0 ? displayName : object.externalId,
    kind: object.kind,
  };
}

export function toScheduleDto(
  row: Schedule,
  object: ObjectRow | null,
  lastJob: ScheduleLastJobDto | null,
  visibility: ScheduleVisibility = FULL_VISIBILITY,
): ScheduleDto {
  return {
    id: row.id,
    kind: row.kind,
    protectedObject: toObjectDto(object, visibility),
    intervalMinutes: row.intervalMinutes,
    cron: row.cron,
    timezone: row.timezone,
    enabled: row.enabled,
    nextRunAt: row.enabled ? iso(row.nextRunAt) : null,
    lastRunAt: iso(row.lastRunAt),
    lastJob: lastJob && !visibility.jobId ? { ...lastJob, id: null } : lastJob,
    supersededByJobId: row.supersededByJobId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The stored definition of a schedule, as recorded in the audit log. */
export function scheduleDefinition(
  row: Pick<
    Schedule,
    "kind" | "protectedObjectId" | "intervalMinutes" | "cron" | "timezone" | "enabled"
  >,
): Record<string, unknown> {
  return {
    kind: row.kind,
    protectedObjectId: row.protectedObjectId,
    intervalMinutes: row.intervalMinutes,
    cron: row.cron,
    timezone: row.timezone,
    enabled: row.enabled,
  };
}

/** The editable fields of a schedule after a patch. */
export interface MergedSchedule {
  protectedObjectId: string | null;
  intervalMinutes: number | null;
  cron: string | null;
  timezone: string;
  enabled: boolean;
}

/**
 * Apply a patch to a schedule. Naming either `intervalMinutes` or `cron`
 * replaces the cadence (the one not set is cleared); both set, or both
 * cleared, is refused with a problem naming `intervalMinutes`.
 */
export function mergePatch(before: Schedule, patch: UpdateScheduleInput): MergedSchedule {
  const cadenceChanged = patch.intervalMinutes !== undefined || patch.cron !== undefined;
  return {
    protectedObjectId:
      patch.protectedObjectId !== undefined ? patch.protectedObjectId : before.protectedObjectId,
    intervalMinutes: cadenceChanged ? (patch.intervalMinutes ?? null) : before.intervalMinutes,
    cron: cadenceChanged ? (patch.cron ?? null) : before.cron,
    timezone: patch.timezone ?? before.timezone,
    enabled: patch.enabled ?? before.enabled,
  };
}

/** Fields whose value a merge changed, with the old and new value (for the audit entry). */
export function describeScheduleChanges(
  before: Schedule,
  after: MergedSchedule,
): Record<string, { from: unknown; to: unknown }> {
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const field of [
    "protectedObjectId",
    "intervalMinutes",
    "cron",
    "timezone",
    "enabled",
  ] as const) {
    if (before[field] !== after[field]) {
      changes[field] = { from: before[field], to: after[field] };
    }
  }
  return changes;
}

/**
 * Whether the next run must be computed again: the cadence or its zone
 * changed, or a switched-off schedule is switched on (its stored next run is
 * stale, and a nightly cron job must not fire in the afternoon for it).
 */
export function needsNewNextRun(before: Schedule, after: MergedSchedule): boolean {
  return (
    before.intervalMinutes !== after.intervalMinutes ||
    before.cron !== after.cron ||
    before.timezone !== after.timezone ||
    (!before.enabled && after.enabled)
  );
}

/** The next runs of a cadence for the preview; a 422 problem naming the field when unusable. */
export function previewSchedule(input: PreviewScheduleInput, now: Date): SchedulePreviewDto {
  const cadence: CadenceInput = {
    intervalMinutes: input.intervalMinutes ?? null,
    cron: input.cron ?? null,
    timezone: input.timezone,
  };
  assertCadenceOrProblem(cadence, now);
  const runs = upcomingRuns(cadence, { now, count: PREVIEW_RUN_COUNT });
  return { next: runs.map((run) => run.toISOString()) };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

async function findSchedule(tx: Transaction, tenantId: string, id: string): Promise<Schedule> {
  const [row] = await tx
    .select()
    .from(schedules)
    .where(and(eq(schedules.tenantId, tenantId), eq(schedules.id, id)))
    .limit(1);
  if (!row) {
    throw new ProblemError(404, "Schedule not found");
  }
  return row;
}

async function findObject(
  tx: Transaction,
  tenantId: string,
  id: string | null,
): Promise<ObjectRow | null> {
  if (id === null) {
    return null;
  }
  const [row] = await tx
    .select({
      id: protectedObjects.id,
      displayName: protectedObjects.displayName,
      externalId: protectedObjects.externalId,
      kind: protectedObjects.kind,
    })
    .from(protectedObjects)
    .where(and(eq(protectedObjects.tenantId, tenantId), eq(protectedObjects.id, id)))
    .limit(1);
  return row ?? null;
}

/** The scope of a backup or verify schedule: a protected object of this tenant. */
async function checkScope(
  tx: Transaction,
  tenantId: string,
  kind: ScheduleKind,
  protectedObjectId: string | null,
): Promise<ObjectRow | null> {
  if (protectedObjectId === null) {
    return null;
  }
  if (!OBJECT_SCOPED_KINDS.includes(kind)) {
    throw scheduleProblem(
      "protectedObjectId",
      "scope_not_supported",
      `A ${kind} schedule always covers the whole tenant.`,
    );
  }
  const object = await findObject(tx, tenantId, protectedObjectId);
  if (!object) {
    throw scheduleProblem(
      "protectedObjectId",
      "object_not_found",
      "The protected object does not exist in this tenant.",
    );
  }
  if (await isImportedObject(tx, tenantId, protectedObjectId)) {
    throw scheduleProblem(
      "protectedObjectId",
      "scope_not_supported",
      "An imported mailbox is not backed up or checked, so it has no schedule.",
    );
  }
  return object;
}

/** The job of each schedule's last run (see {@link ScheduleDto.lastJob}). */
async function loadLastJobs(
  tx: Transaction,
  tenantId: string,
  scheduleIds: readonly string[],
): Promise<Map<string, ScheduleLastJobDto>> {
  const result = new Map<string, ScheduleLastJobDto>();
  if (scheduleIds.length === 0) {
    return result;
  }
  const ids = sql.join(
    scheduleIds.map((id) => sql`${id}`),
    sql`, `,
  );
  // One run's jobs are enqueued in one transaction and share its created_at.
  const rows = await tx.execute<{
    schedule_id: string;
    id: string;
    status: Job["status"];
    completed_at: Date | string | null;
  }>(sql`
    SELECT schedule_id, id, status, completed_at
    FROM (
      SELECT j.payload->>'scheduleId' AS schedule_id, j.id, j.status, j.completed_at,
             row_number() OVER (
               PARTITION BY j.payload->>'scheduleId'
               ORDER BY j.created_at DESC,
                        CASE j.status
                          WHEN 'failed' THEN 0
                          WHEN 'active' THEN 1
                          WHEN 'queued' THEN 2
                          WHEN 'cancelled' THEN 3
                          ELSE 4
                        END,
                        j.id
             ) AS pick
      FROM jobs j
      WHERE j.tenant_id = ${tenantId}::uuid
        AND j.payload->>'scheduleId' IN (${ids})
    ) latest
    WHERE pick = 1
  `);
  for (const row of rows.rows) {
    result.set(row.schedule_id, {
      id: row.id,
      status: row.status,
      finishedAt: iso(row.completed_at),
    });
  }
  return result;
}

async function scheduleDto(tx: Transaction, row: Schedule): Promise<ScheduleDto> {
  const object = await findObject(tx, row.tenantId, row.protectedObjectId);
  const lastJobs = await loadLastJobs(tx, row.tenantId, [row.id]);
  return toScheduleDto(row, object, lastJobs.get(row.id) ?? null);
}

async function hasMicrosoftSource(tx: Transaction, tenantId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: sources.id })
    .from(sources)
    .where(and(eq(sources.tenantId, tenantId), eq(sources.kind, "m365")))
    .limit(1);
  return row !== undefined;
}

function asExisting(row: Schedule): ExistingSchedule {
  return {
    kind: row.kind,
    protectedObjectId: row.protectedObjectId,
    intervalMinutes: row.intervalMinutes,
    cron: row.cron,
  };
}

async function missingKinds(
  tx: Transaction,
  tenantId: string,
  rows: readonly Schedule[],
): Promise<CoreScheduleKind[]> {
  const recommended = recommendedSchedules({
    hasMicrosoftSource: await hasMicrosoftSource(tx, tenantId),
  });
  const existing = [...rows.map(asExisting), ...(await mailJobCoverage(tx, tenantId))];
  return kindsOfRecommendations(missingRecommendedSchedules(existing, recommended));
}

/** Problem type of a change to a schedule a backup job took over. */
export const SCHEDULE_SUPERSEDED_PROBLEM = "urn:restow:problem:schedule-superseded";

/** Backups and restore checks are part of backup jobs since 0.2.0; a schedule of them is not made any more. */
export const JOB_KINDS: readonly ScheduleKind[] = ["backup", "verify"];

function assertNotSuperseded(row: Schedule): void {
  if (row.supersededByJobId !== null) {
    throw new ProblemError(409, "Schedule replaced by a backup job", {
      type: SCHEDULE_SUPERSEDED_PROBLEM,
      detail:
        "A backup job took this schedule over; change the job instead. The schedule stays on record.",
      extensions: { jobId: row.supersededByJobId },
    });
  }
}

/** An audit entry about one schedule, or (`target.tenant`) about the tenant's set of schedules. */
function auditEvent(
  tenantId: string,
  actor: ScheduleActor,
  action: string,
  target: { id: string; tenant?: boolean },
  details: Record<string, unknown>,
) {
  const onTenant = target.tenant === true;
  return {
    tenantId,
    actor: actor.label,
    actorUserId: actor.userId,
    action,
    target: target.id,
    targetType: onTenant ? "tenant" : "schedule",
    ip: actor.ip,
    details,
  };
}

const scheduleTarget = (id: string) => ({ id });

// ---------------------------------------------------------------------------
// Schedules
// ---------------------------------------------------------------------------

/**
 * Every schedule of the tenant, shaped for the viewer: a tenant user sees
 * every schedule and how it went, but another person's object only by its
 * kind and no job ids ({@link scheduleVisibility}).
 */
export async function listSchedules(
  db: Database,
  tenantId: string,
  viewer: Pick<Viewer, "role" | "email">,
): Promise<ScheduleListDto> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select({
        schedule: schedules,
        object: {
          id: protectedObjects.id,
          displayName: protectedObjects.displayName,
          externalId: protectedObjects.externalId,
          kind: protectedObjects.kind,
        },
        ownerEmail: users.email,
      })
      .from(schedules)
      .leftJoin(protectedObjects, eq(protectedObjects.id, schedules.protectedObjectId))
      .leftJoin(users, eq(users.id, protectedObjects.userId))
      .where(eq(schedules.tenantId, tenantId))
      .orderBy(asc(schedules.kind), asc(schedules.createdAt), asc(schedules.id));
    const lastJobs = await loadLastJobs(
      tx,
      tenantId,
      rows.map((row) => row.schedule.id),
    );
    return {
      items: rows.map((row) =>
        toScheduleDto(
          row.schedule,
          row.object,
          lastJobs.get(row.schedule.id) ?? null,
          scheduleVisibility(
            viewer,
            row.object ? { externalId: row.object.externalId, ownerEmail: row.ownerEmail } : null,
          ),
        ),
      ),
      missingKinds: await missingKinds(
        tx,
        tenantId,
        rows.map((row) => row.schedule),
      ),
    };
  });
}

export async function createSchedule(
  db: Database,
  tenantId: string,
  input: CreateScheduleInput,
  actor: ScheduleActor,
  now: Date,
): Promise<ScheduleDto> {
  const cadence: CadenceInput = {
    intervalMinutes: input.intervalMinutes ?? null,
    cron: input.cron ?? null,
    timezone: input.timezone,
  };
  assertCadenceOrProblem(cadence, now);
  if (JOB_KINDS.includes(input.kind)) {
    throw scheduleProblem(
      "kind",
      "kind_replaced_by_jobs",
      "Backups and restore checks are scheduled in backup jobs (Jobs); a schedule of this kind is not made any more.",
    );
  }
  return withTenantTx(db, tenantId, async (tx) => {
    const object = await checkScope(tx, tenantId, input.kind, input.protectedObjectId);
    const [row] = await tx
      .insert(schedules)
      .values({
        tenantId,
        kind: input.kind,
        protectedObjectId: input.protectedObjectId,
        intervalMinutes: cadence.intervalMinutes ?? null,
        cron: cadence.cron ?? null,
        timezone: cadence.timezone,
        enabled: input.enabled,
        nextRunAt: nextRunAt(cadence, { now }),
      })
      .returning();
    if (!row) {
      throw new Error("schedule insert returned no row");
    }
    await audit(
      tx,
      auditEvent(
        tenantId,
        actor,
        SCHEDULE_AUDIT_ACTIONS.created,
        scheduleTarget(row.id),
        scheduleDefinition(row),
      ),
    );
    return toScheduleDto(row, object, null);
  });
}

export async function updateSchedule(
  db: Database,
  tenantId: string,
  id: string,
  patch: UpdateScheduleInput,
  actor: ScheduleActor,
  now: Date,
): Promise<ScheduleDto> {
  return withTenantTx(db, tenantId, async (tx) => {
    const before = await findSchedule(tx, tenantId, id);
    assertNotSuperseded(before);
    const after = mergePatch(before, patch);
    const reschedule = needsNewNextRun(before, after);
    // An untouched cadence is not re-judged (switching off or rescoping always
    // works); a new or re-enabled one must be able to run.
    if (reschedule) {
      assertCadenceOrProblem(after, now);
    }
    if (after.protectedObjectId !== before.protectedObjectId) {
      await checkScope(tx, tenantId, before.kind, after.protectedObjectId);
    }
    const changes = describeScheduleChanges(before, after);
    if (Object.keys(changes).length === 0) {
      return scheduleDto(tx, before);
    }
    const [row] = await tx
      .update(schedules)
      .set({
        ...after,
        ...(reschedule
          ? { nextRunAt: nextRunAt(after, { now, lastRunAt: before.lastRunAt }) }
          : {}),
      })
      .where(and(eq(schedules.tenantId, tenantId), eq(schedules.id, id)))
      .returning();
    if (!row) {
      throw new ProblemError(404, "Schedule not found");
    }
    await audit(
      tx,
      auditEvent(tenantId, actor, SCHEDULE_AUDIT_ACTIONS.updated, scheduleTarget(id), {
        kind: row.kind,
        changes,
      }),
    );
    return scheduleDto(tx, row);
  });
}

export async function deleteSchedule(
  db: Database,
  tenantId: string,
  id: string,
  actor: ScheduleActor,
): Promise<void> {
  await withTenantTx(db, tenantId, async (tx) => {
    const before = await findSchedule(tx, tenantId, id);
    assertNotSuperseded(before);
    await tx.delete(schedules).where(and(eq(schedules.tenantId, tenantId), eq(schedules.id, id)));
    await audit(
      tx,
      auditEvent(
        tenantId,
        actor,
        SCHEDULE_AUDIT_ACTIONS.deleted,
        scheduleTarget(id),
        scheduleDefinition(before),
      ),
    );
  });
}

/**
 * Add the recommended schedules the tenant does not have (the same rule the
 * scheduler applies once per tenant) and record that they were applied, so
 * the scheduler never adds them again. Idempotent: a second call creates
 * nothing. The tenant row is locked first, so a concurrent scheduler tick
 * cannot add the same schedules twice.
 */
export async function applyRecommendedSchedules(
  db: Database,
  tenantId: string,
  input: ApplyRecommendedInput,
  actor: ScheduleActor,
  now: Date,
): Promise<ApplyRecommendedDto> {
  if (!isValidTimeZone(input.timezone)) {
    throw scheduleProblem(
      "timezone",
      "timezone_unknown",
      `"${input.timezone}" is not an IANA time zone such as Europe/Berlin.`,
    );
  }
  return withTenantTx(db, tenantId, async (tx) => {
    const [tenant] = await tx
      .select({ appliedAt: tenants.scheduleDefaultsAppliedAt })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .for("update");
    if (!tenant) {
      throw new ProblemError(404, "Tenant not found");
    }
    const existing = await tx.select().from(schedules).where(eq(schedules.tenantId, tenantId));
    const missingAll = missingRecommendedSchedules(
      [...existing.map(asExisting), ...(await mailJobCoverage(tx, tenantId))],
      recommendedSchedules({
        timezone: input.timezone,
        hasMicrosoftSource: await hasMicrosoftSource(tx, tenantId),
      }),
    );
    // Backups and restore checks are a job; only the maintenance is a schedule.
    const missing = missingAll.filter((schedule) => !JOB_KINDS.includes(schedule.kind));
    const jobCreated = await ensureDefaultMailJob(
      tx,
      tenantId,
      missingAll.filter((schedule) => JOB_KINDS.includes(schedule.kind)),
      now,
    );
    const created =
      missing.length === 0
        ? []
        : await tx
            .insert(schedules)
            .values(
              missing.map((schedule) => ({
                tenantId,
                kind: schedule.kind,
                intervalMinutes: schedule.intervalMinutes,
                cron: schedule.cron,
                timezone: schedule.timezone,
                enabled: true,
                nextRunAt: nextRunAt(schedule, { now }),
              })),
            )
            .returning();
    const markerSet = tenant.appliedAt === null;
    if (markerSet) {
      await tx
        .update(tenants)
        .set({ scheduleDefaultsAppliedAt: now })
        .where(eq(tenants.id, tenantId));
    }
    if (created.length > 0 || jobCreated || markerSet) {
      await audit(
        tx,
        auditEvent(
          tenantId,
          actor,
          SCHEDULE_AUDIT_ACTIONS.recommendedApplied,
          { id: tenantId, tenant: true },
          {
            timezone: input.timezone,
            created: created.map((row) => ({ id: row.id, ...scheduleDefinition(row) })),
            ...(jobCreated ? { job: jobCreated } : {}),
          },
        ),
      );
    }
    return {
      created: created.map((row) => toScheduleDto(row, null, null)),
      jobCreated,
      missingKinds: await missingKinds(tx, tenantId, [...existing, ...created]),
    };
  });
}
