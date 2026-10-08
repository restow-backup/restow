import { randomUUID } from "node:crypto";
import type { ScrubJobPayload, VerifyJobPayload } from "@restow/core";
import {
  type Database,
  type ProtectedObject,
  jobs,
  protectedObjects,
  schedules,
  users,
  verifyReports,
} from "@restow/db";
import { type SQL, and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { config } from "../../config.js";
import { audit } from "../../lib/audit.js";
import { assertDemoJobNotInFlight } from "../../lib/demo-limits.js";
import { isImportedObject, notImported } from "../../lib/imported-objects.js";
import { type Transaction, withTenantTx } from "../../lib/tenant-context.js";
import { ProblemError } from "../../problem.js";
import { type EndpointReadinessRowDto, loadEndpointOverview } from "../endpoints/overview.js";
import { type Page, decodeCursor, encodeCursor } from "../jobs/pagination.js";
import { sendJob } from "../jobs/queue.js";
import { type GuestReadinessRowDto, loadGuestProtection } from "../pve/protection.js";
import {
  type CountSummaryDto,
  type Readiness,
  type ReasonDto,
  type ReportDetailsDto,
  type ScrubReportDto,
  parseCountSummary,
  parseDetails,
  parseReasons,
  parseScrubReport,
} from "./details.js";
import type {
  ListReportsQuery,
  RunScrubInput,
  RunVerifyInput,
  VerifyKindInput,
} from "./schemas.js";
import {
  type ObjectState,
  type ReadinessSummaryDto,
  type SkipReason,
  isFirstBackupOverdue,
  isOverdue,
  summarize,
  verifyBlockedReason,
} from "./summary.js";
import {
  type ObjectVerificationFacts,
  type ReportFact,
  type SnapshotVerificationDto,
  isStorageFinding,
  loadObjectVerifications,
  reportFactColumns,
} from "./verification-state.js";

/**
 * Recovery readiness: the latest rating per protected object, the report
 * history behind it, the storage integrity found by the scrub, and "check
 * now" for both. Reads are tenant-pinned (RLS); every write and every read of
 * a report's item list (backup data) is audited.
 */

export const VERIFY_AUDIT_ACTIONS = {
  requested: "verify.requested",
  reportViewed: "verify.report.viewed",
  scrubRequested: "scrub.requested",
} as const;

export interface VerifyActor {
  /** The better-auth user; null for an integration (API key). */
  userId: string | null;
  email: string;
  ip: string | null;
}

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

export interface ObjectDto {
  id: string;
  kind: ProtectedObject["kind"];
  displayName: string | null;
  externalId: string;
  status: ProtectedObject["status"];
  /**
   * The linked directory user's primary address, when known. `externalId` is
   * a stable identifier, not something to show: for a mailbox and a OneDrive
   * it is the owning Entra user's object id or drive id (opaque, GUID-like),
   * never the address. Only for `imap` is `externalId` itself the human
   * login, so the UI never needs this field to name an IMAP object.
   */
  email: string | null;
  upn: string | null;
}

export type ReportOrigin = "verify" | "scrub" | "unknown";

export interface LatestReportDto {
  id: string;
  kind: VerifyKindInput;
  origin: ReportOrigin;
  reasons: ReasonDto[];
  counts: CountSummaryDto | null;
}

export interface RunningCheckDto {
  jobId: string;
  status: "queued" | "active";
  kind: VerifyKindInput;
}

/** A check of an older backup, shown while the newest backup is not verified yet. */
export interface PreviousCheckDto {
  reportId: string;
  readiness: Readiness;
  checkedAt: string;
  /** The older backup it read back; null for reports written before checks named their backup. */
  snapshotId: string | null;
}

/**
 * The readiness of one object. `state`, `readiness`, `checkedAt` and `report`
 * describe the newest completed backup (see verification-state.ts): after a
 * new backup they are `unverified` / null until a check of that backup ran.
 */
export interface ObjectReadinessDto {
  object: ObjectDto;
  state: ObjectState;
  /** The rating of the newest backup; null while it is unverified or without a backup. */
  readiness: Readiness | null;
  checkedAt: string | null;
  overdue: boolean;
  latestSnapshotAt: string | null;
  report: LatestReportDto | null;
  running: RunningCheckDto | null;
  /** The newest completed backup the state is about (always set by the service). */
  latestSnapshotId?: string | null;
  /**
   * While the newest backup is unverified: the newest check of an older
   * backup, what was proven before (always set by the service; null otherwise).
   */
  previousCheck?: PreviousCheckDto | null;
}

export type StorageState = "ok" | "repaired" | "corrupt" | "never";

export interface StorageIntegrityDto {
  state: StorageState;
  latest: (ScrubReportDto & { jobId: string; completedAt: string | null }) | null;
  lastFullAt: string | null;
  running: { jobId: string; status: "queued" | "active"; mode: "sample" | "full" } | null;
  /** A scrub that failed after the latest successful one. */
  lastFailure: { jobId: string; at: string | null; message: string | null } | null;
}

/** An enabled schedule of a kind, with its next due time; null when nothing is scheduled. */
export interface ScheduleDto {
  nextRunAt: string | null;
}

export interface ReadinessOverviewDto {
  summary: ReadinessSummaryDto;
  objects: ObjectReadinessDto[];
  /** Servers and clients backed up by the agent (docs/AGENT.md); counted in `summary` as well. */
  endpoints: EndpointReadinessRowDto[];
  /**
   * VMs and containers of Proxmox VE (docs/PVE.md) in a backup job, or out of every job with a
   * restore point left; counted in `summary` as well.
   */
  guests: GuestReadinessRowDto[];
  storage: StorageIntegrityDto;
  schedules: { backup: ScheduleDto | null; verify: ScheduleDto | null; scrub: ScheduleDto | null };
}

export interface ReportSummaryDto {
  id: string;
  object: ObjectDto;
  kind: VerifyKindInput;
  origin: ReportOrigin;
  readiness: Readiness;
  checkedAt: string;
  jobId: string | null;
  /** The backup the report checked; null for storage findings and reports that name none. */
  snapshotId: string | null;
  reasons: ReasonDto[];
  counts: CountSummaryDto | null;
}

/** The object's newest backup, when a report checked an older one. */
export interface LatestBackupDto {
  snapshotId: string;
  sequence: number;
  completedAt: string | null;
  verification: SnapshotVerificationDto;
}

export interface ReportDetailDto extends ReportSummaryDto {
  details: ReportDetailsDto;
  /**
   * The object's newest backup when it is not the one this report checked,
   * with its own verification; null when the report checked the newest
   * backup, for storage findings, and when no backup is left.
   */
  latestBackup: LatestBackupDto | null;
}

export interface QueuedCheckDto {
  jobId: string;
  protectedObjectId: string;
  displayName: string | null;
  kind: VerifyKindInput;
}

export interface SkippedCheckDto {
  protectedObjectId: string;
  displayName: string | null;
  reason: SkipReason;
}

export interface RunVerifyResultDto {
  queued: QueuedCheckDto[];
  skipped: SkippedCheckDto[];
}

export interface QueuedScrubDto {
  jobId: string;
  mode: "sample" | "full";
}

// ---------------------------------------------------------------------------
// Shared queries
// ---------------------------------------------------------------------------

const objectColumns = {
  id: protectedObjects.id,
  kind: protectedObjects.kind,
  displayName: protectedObjects.displayName,
  externalId: protectedObjects.externalId,
  status: protectedObjects.status,
  // Every query that selects these columns must also
  // `leftJoin(users, eq(protectedObjects.userId, users.id))` (left, so an
  // object whose user link is gone still comes back, address-less).
  email: users.email,
  upn: users.upn,
};

function originOf(value: string | null): ReportOrigin {
  return value === "verify" || value === "scrub" ? value : "unknown";
}

function toLatestReport(report: ReportFact): LatestReportDto {
  return {
    id: report.id,
    kind: report.kind,
    origin: originOf(report.origin),
    reasons: parseReasons(report.reasons, report.checkedAt),
    counts: parseCountSummary(report.counts),
  };
}

function toPreviousCheck(report: ReportFact): PreviousCheckDto {
  return {
    reportId: report.id,
    readiness: report.readiness,
    checkedAt: report.checkedAt.toISOString(),
    snapshotId: report.snapshotId,
  };
}

/** The verification of the object's newest backup; null without a backup. */
function latestBackupVerification(
  facts: ObjectVerificationFacts | undefined,
): SnapshotVerificationDto | null {
  if (!facts?.latestSnapshot) {
    return null;
  }
  const { state, report } = facts.verification;
  return state === "no_backup"
    ? null
    : {
        state,
        checkedAt: report?.checkedAt.toISOString() ?? null,
        reportId: report?.id ?? null,
      };
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

async function loadStorageIntegrity(
  tx: Transaction,
  tenantId: string,
): Promise<StorageIntegrityDto> {
  const recent = await tx
    .select({
      id: jobs.id,
      status: jobs.status,
      payload: jobs.payload,
      errorMessage: jobs.errorMessage,
      completedAt: jobs.completedAt,
      createdAt: jobs.createdAt,
    })
    .from(jobs)
    .where(and(eq(jobs.tenantId, tenantId), eq(jobs.queue, "scrub")))
    .orderBy(desc(jobs.createdAt))
    .limit(25);
  const [lastFull] = await tx
    .select({ completedAt: jobs.completedAt })
    .from(jobs)
    .where(
      and(
        eq(jobs.tenantId, tenantId),
        eq(jobs.queue, "scrub"),
        eq(jobs.status, "completed"),
        sql`${jobs.payload}->>'mode' = 'full'`,
      ),
    )
    .orderBy(desc(jobs.completedAt))
    .limit(1);

  const completed = recent.find((job) => job.status === "completed");
  const report = completed ? parseScrubReport(completed.payload?.result) : null;
  const running = recent.find((job) => job.status === "queued" || job.status === "active");
  const failed = recent.find((job) => job.status === "failed");
  const failedAfterSuccess = failed && (!completed || failed.createdAt > completed.createdAt);

  const state: StorageState = !report
    ? "never"
    : report.corrupt.length > 0
      ? "corrupt"
      : report.repaired.length > 0
        ? "repaired"
        : "ok";
  return {
    state,
    latest:
      completed && report
        ? {
            ...report,
            jobId: completed.id,
            completedAt: completed.completedAt?.toISOString() ?? null,
          }
        : null,
    lastFullAt: lastFull?.completedAt?.toISOString() ?? null,
    running: running
      ? {
          jobId: running.id,
          status: running.status as "queued" | "active",
          mode: running.payload?.mode === "full" ? "full" : "sample",
        }
      : null,
    lastFailure:
      failed && failedAfterSuccess
        ? {
            jobId: failed.id,
            at: (failed.completedAt ?? failed.createdAt).toISOString(),
            message: failed.errorMessage,
          }
        : null,
  };
}

/** Whether verify and scrub run on a schedule for the tenant, and when next. */
async function loadSchedules(
  tx: Transaction,
  tenantId: string,
): Promise<ReadinessOverviewDto["schedules"]> {
  const asDate = (value: string | Date | null) => (value === null ? null : new Date(value));
  // A schedule a backup job took over is the job's now: the job speaks for it below.
  const rows = await tx
    .select({
      kind: schedules.kind,
      nextRunAt: sql<Date | null>`min(${schedules.nextRunAt})`.mapWith(asDate),
    })
    .from(schedules)
    .where(
      and(
        eq(schedules.tenantId, tenantId),
        eq(schedules.enabled, true),
        isNull(schedules.supersededByJobId),
        inArray(schedules.kind, ["backup", "verify", "scrub"]),
      ),
    )
    .groupBy(schedules.kind);
  // Backups and restore checks of the mail jobs: the job's own timer, and the timers of members
  // that carry a schedule of their own.
  type Timers = {
    backup: boolean | null;
    backup_next: Date | string | null;
    verify: boolean | null;
    verify_next: Date | string | null;
  };
  const jobTimers = (
    await tx.execute<Timers>(sql`
      SELECT bool_or(schedule IS NOT NULL) AS backup,
             min(next_run_at) FILTER (WHERE schedule IS NOT NULL) AS backup_next,
             bool_or(verify_schedule IS NOT NULL) AS verify,
             min(verify_next_run_at) FILTER (WHERE verify_schedule IS NOT NULL) AS verify_next
        FROM backup_jobs
       WHERE tenant_id = ${tenantId}::uuid AND kind = 'mail' AND enabled`)
  ).rows[0];
  const memberTimers = (
    await tx.execute<Timers>(sql`
      SELECT bool_or(jsonb_typeof(m.overrides -> 'schedule') = 'object') AS backup,
             min(m.next_run_at) FILTER (WHERE jsonb_typeof(m.overrides -> 'schedule') = 'object') AS backup_next,
             bool_or(jsonb_typeof(m.overrides -> 'verifySchedule') = 'object') AS verify,
             min(m.verify_next_run_at) FILTER (WHERE jsonb_typeof(m.overrides -> 'verifySchedule') = 'object') AS verify_next
        FROM backup_job_members m
        JOIN backup_jobs j ON j.id = m.job_id
       WHERE m.tenant_id = ${tenantId}::uuid AND j.kind = 'mail' AND j.enabled`)
  ).rows[0];
  const earliest = (...dates: (Date | null)[]): Date | null => {
    const known = dates.filter((date): date is Date => date !== null);
    return known.length === 0 ? null : new Date(Math.min(...known.map((date) => date.getTime())));
  };
  const of = (kind: "backup" | "verify" | "scrub"): ScheduleDto | null => {
    const row = rows.find((candidate) => candidate.kind === kind);
    const key = kind === "backup" ? "backup" : kind === "verify" ? "verify" : null;
    const fromJobs = key !== null && (jobTimers?.[key] === true || memberTimers?.[key] === true);
    if (!row && !fromJobs) {
      return null;
    }
    const next = earliest(
      row?.nextRunAt ?? null,
      key ? asDate(jobTimers?.[`${key}_next`] ?? null) : null,
      key ? asDate(memberTimers?.[`${key}_next`] ?? null) : null,
    );
    return { nextRunAt: next?.toISOString() ?? null };
  };
  return { backup: of("backup"), verify: of("verify"), scrub: of("scrub") };
}

/** The readiness of every protected object, the tenant summary and the storage integrity. */
export async function readinessOverview(
  db: Database,
  tenantId: string,
  now: Date = new Date(),
): Promise<ReadinessOverviewDto> {
  return withTenantTx(db, tenantId, async (tx) => {
    // One after the other: a transaction is one connection, which runs one query at a time.
    const objects = await tx
      .select({
        ...objectColumns,
        // When protection last started, not when the row was first created:
        // an object made `excluded` by the directory's rules and included
        // later (or re-included after being orphaned) must not be judged
        // against a "since" date from before it was ever protected. Objects
        // written before this column existed fall back to `created_at`,
        // exactly the date they were judged against before.
        protectedSince:
          sql<Date>`coalesce(${protectedObjects.activeSince}, ${protectedObjects.createdAt})`.mapWith(
            (value: string | Date) => new Date(value),
          ),
      })
      .from(protectedObjects)
      .leftJoin(users, eq(protectedObjects.userId, users.id))
      // Imported mailboxes are never backed up or checked: they are not "not protected".
      .where(and(eq(protectedObjects.tenantId, tenantId), notImported()))
      .orderBy(asc(protectedObjects.displayName), asc(protectedObjects.externalId));
    const verifications = await loadObjectVerifications(tx, tenantId);
    const runningJobs = await tx
      .select({
        id: jobs.id,
        objectId: jobs.protectedObjectId,
        queue: jobs.queue,
        status: jobs.status,
        payload: jobs.payload,
      })
      .from(jobs)
      .where(
        and(
          eq(jobs.tenantId, tenantId),
          // Verify jobs feed `running`/the tenant summary below; backup jobs
          // are only used to keep a first backup already under way from
          // being flagged overdue while it runs (see `overdue` below).
          inArray(jobs.queue, ["verify", "backup"]),
          inArray(jobs.status, ["queued", "active"]),
        ),
      )
      .orderBy(desc(jobs.createdAt));
    const storage = await loadStorageIntegrity(tx, tenantId);
    const scheduled = await loadSchedules(tx, tenantId);

    const runningByObject = new Map<string, RunningCheckDto>();
    const runningFirstBackupIds = new Set<string>();
    for (const job of runningJobs) {
      if (!job.objectId) {
        continue;
      }
      if (job.queue === "backup") {
        runningFirstBackupIds.add(job.objectId);
        continue;
      }
      if (!runningByObject.has(job.objectId)) {
        runningByObject.set(job.objectId, {
          jobId: job.id,
          status: job.status as "queued" | "active",
          kind: job.payload?.kind === "health_check" ? "health_check" : "verify",
        });
      }
    }

    const items: ObjectReadinessDto[] = [];
    const lastLookedAt: (Date | null)[] = [];
    for (const { protectedSince, ...object } of objects) {
      const facts = verifications.get(object.id);
      const latestSnapshot = facts?.latestSnapshot ?? null;
      // Excluded objects are not protected; orphaned ones count while their backups exist.
      if (object.status === "excluded" || (object.status === "orphaned" && !latestSnapshot)) {
        continue;
      }
      const verification = facts?.verification ?? { state: "no_backup", report: null };
      const report = verification.report;
      const checkedAt = report?.checkedAt ?? null;
      // A fresh "no_backup" object is not a problem yet, only once it missed
      // its first chance (isFirstBackupOverdue); every other state keeps the
      // ordinary "the last check is stale" rule. Either way, an object whose
      // first backup is already queued or running is not overdue: it is
      // being worked on, not neglected.
      const overdue =
        verification.state === "no_backup"
          ? isFirstBackupOverdue(protectedSince, now) && !runningFirstBackupIds.has(object.id)
          : isOverdue(checkedAt, now);
      items.push({
        object,
        state: verification.state,
        readiness: report?.readiness ?? null,
        checkedAt: checkedAt?.toISOString() ?? null,
        overdue,
        latestSnapshotAt: latestSnapshot?.completedAt?.toISOString() ?? null,
        report: report ? toLatestReport(report) : null,
        running: runningByObject.get(object.id) ?? null,
        latestSnapshotId: latestSnapshot?.id ?? null,
        previousCheck: facts?.verification.previous
          ? toPreviousCheck(facts.verification.previous)
          : null,
      });
      lastLookedAt.push(facts?.newest?.checkedAt ?? null);
    }

    const endpointOverview = await loadEndpointOverview(tx, tenantId, now);
    const guestOverview = await loadGuestProtection(tx, tenantId, now);
    const summary = summarize(
      [
        ...items.map((item, index) => ({
          state: item.state,
          overdue: item.overdue,
          // When a check last ran, even one that rated an older backup.
          checkedAt: lastLookedAt[index] ?? null,
        })),
        // Servers and clients count like any other protected object.
        ...endpointOverview.rated,
        // So do the VMs and containers of Proxmox VE.
        ...guestOverview.rated,
      ],
      runningByObject.size,
    );
    return {
      summary,
      objects: items,
      endpoints: endpointOverview.rows,
      guests: guestOverview.rows,
      storage,
      schedules: scheduled,
    };
  });
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

type ReportRow = ReportFact & { object: ObjectDto };

function toReportSummary(row: ReportRow): ReportSummaryDto {
  return {
    id: row.id,
    object: row.object,
    kind: row.kind,
    origin: originOf(row.origin),
    readiness: row.readiness,
    checkedAt: row.checkedAt.toISOString(),
    jobId: row.jobId,
    snapshotId: row.snapshotId,
    reasons: parseReasons(row.reasons, row.checkedAt),
    counts: parseCountSummary(row.counts),
  };
}

/**
 * The object's newest backup next to a report of an older one, so the report
 * never reads as the verification of a backup it did not check.
 */
function latestBackupBeside(
  row: ReportRow,
  facts: ObjectVerificationFacts | undefined,
): LatestBackupDto | null {
  const latest = facts?.latestSnapshot;
  const verification = latestBackupVerification(facts);
  if (!latest || !verification || isStorageFinding(row) || latest.id === row.snapshotId) {
    return null;
  }
  return {
    snapshotId: latest.id,
    sequence: latest.sequence,
    completedAt: latest.completedAt?.toISOString() ?? null,
    verification,
  };
}

/** Report history, newest first, optionally for one object or one rating. */
export async function listReports(
  db: Database,
  tenantId: string,
  query: ListReportsQuery,
): Promise<Page<ReportSummaryDto>> {
  const cursor = decodeCursor(query.cursor);
  if (query.cursor && !cursor) {
    throw new ProblemError(422, "Invalid cursor", {
      detail: "The cursor is not one this API issued. Start again from the first page.",
    });
  }
  return withTenantTx(db, tenantId, async (tx) => {
    const filters: SQL[] = [eq(verifyReports.tenantId, tenantId)];
    if (query.objectId) {
      filters.push(eq(verifyReports.protectedObjectId, query.objectId));
    }
    if (query.readiness) {
      filters.push(eq(verifyReports.recoveryReadiness, query.readiness));
    }
    if (cursor) {
      filters.push(
        sql`(${verifyReports.checkedAt}, ${verifyReports.id}) < (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`,
      );
    }
    const rows = await tx
      .select({ ...reportFactColumns, object: objectColumns })
      .from(verifyReports)
      .innerJoin(protectedObjects, eq(protectedObjects.id, verifyReports.protectedObjectId))
      .leftJoin(users, eq(protectedObjects.userId, users.id))
      .where(and(...filters))
      .orderBy(desc(verifyReports.checkedAt), desc(verifyReports.id))
      .limit(query.limit + 1);
    const items = rows.slice(0, query.limit);
    const last = items[items.length - 1];
    return {
      items: items.map(toReportSummary),
      next:
        rows.length > query.limit && last
          ? encodeCursor({ createdAt: last.checkedAt.toISOString(), id: last.id })
          : null,
    };
  });
}

/** One report with its item list. Reading it reveals backup item paths, so it is audited. */
export async function getReport(
  db: Database,
  tenantId: string,
  id: string,
  actor: VerifyActor,
): Promise<ReportDetailDto> {
  return withTenantTx(db, tenantId, async (tx) => {
    const [row] = await tx
      .select({ ...reportFactColumns, details: verifyReports.details, object: objectColumns })
      .from(verifyReports)
      .innerJoin(protectedObjects, eq(protectedObjects.id, verifyReports.protectedObjectId))
      .leftJoin(users, eq(protectedObjects.userId, users.id))
      .where(and(eq(verifyReports.tenantId, tenantId), eq(verifyReports.id, id)))
      .limit(1);
    if (!row) {
      throw new ProblemError(404, "Report not found", {
        detail: "No readiness report with this id exists in the tenant.",
      });
    }
    await audit(tx, {
      tenantId,
      actor: actor.email,
      actorUserId: actor.userId,
      action: VERIFY_AUDIT_ACTIONS.reportViewed,
      target: id,
      targetType: "verify_report",
      ip: actor.ip,
      details: {
        protectedObjectId: row.objectId,
        externalId: row.object.externalId,
        readiness: row.readiness,
      },
    });
    const verifications = await loadObjectVerifications(tx, tenantId, [row.objectId]);
    return {
      ...toReportSummary(row),
      details: parseDetails(row.details, row.checkedAt),
      latestBackup: latestBackupBeside(row, verifications.get(row.objectId)),
    };
  });
}

// ---------------------------------------------------------------------------
// Check now
// ---------------------------------------------------------------------------

async function enqueueVerify(
  tx: Transaction,
  db: Database,
  tenantId: string,
  protectedObjectId: string,
  kind: VerifyKindInput,
  sampleSize: number | undefined,
): Promise<string | null> {
  const payload: VerifyJobPayload = {
    jobId: randomUUID(),
    tenantId,
    protectedObjectId,
    kind,
    ...(sampleSize !== undefined && kind === "verify" ? { sampleSize } : {}),
  };
  const pgBossJobId = await sendJob(tx, "verify", payload, db);
  if (pgBossJobId === null) {
    return null;
  }
  await tx.insert(jobs).values({
    id: payload.jobId,
    tenantId,
    queue: "verify",
    status: "queued",
    protectedObjectId,
    payload: payload as unknown as Record<string, unknown>,
    pgBossJobId,
  });
  return payload.jobId;
}

const SKIP_DETAIL: Record<SkipReason, string> = {
  no_backup: "The object has no completed backup yet, so there is nothing to verify.",
  excluded: "The object is excluded from protection.",
  already_queued: "A check for this object is already queued or running.",
};

/**
 * "Check now" for one object, every object with a backup, or (`unverifiedOnly`)
 * every object whose newest backup is not verified yet. Objects that cannot
 * be checked are reported as skipped with the reason; a single explicit
 * object that cannot be checked is a 409 instead.
 */
export async function runVerify(
  db: Database,
  tenantId: string,
  input: RunVerifyInput,
  actor: VerifyActor,
): Promise<RunVerifyResultDto> {
  return withTenantTx(db, tenantId, async (tx) => {
    if (config.demo.enabled) {
      await assertDemoJobNotInFlight(tx, tenantId, "verify");
    }
    const filters: SQL[] = [eq(protectedObjects.tenantId, tenantId), notImported()];
    if (input.protectedObjectId) {
      filters.push(eq(protectedObjects.id, input.protectedObjectId));
    }
    const candidates = await tx
      .select(objectColumns)
      .from(protectedObjects)
      .leftJoin(users, eq(protectedObjects.userId, users.id))
      .where(and(...filters))
      .orderBy(asc(protectedObjects.displayName), asc(protectedObjects.externalId));
    if (input.protectedObjectId && candidates.length === 0) {
      if (await isImportedObject(tx, tenantId, input.protectedObjectId)) {
        throw new ProblemError(409, "Imported mailboxes are not checked", {
          type: "urn:restow:problem:imported-mailbox",
          detail:
            "This mailbox was imported from files. Nothing is backed up from it, so there is no backup to check.",
        });
      }
      throw new ProblemError(404, "Protected object not found");
    }
    const verifications = await loadObjectVerifications(
      tx,
      tenantId,
      candidates.map((candidate) => candidate.id),
    );

    const queued: QueuedCheckDto[] = [];
    const skipped: SkippedCheckDto[] = [];
    const skip = (candidate: ObjectDto, reason: SkipReason) => {
      if (input.protectedObjectId) {
        throw new ProblemError(409, "Check not possible", {
          detail: SKIP_DETAIL[reason],
          extensions: { reason },
        });
      }
      // Excluded objects are simply not part of "check everything".
      if (reason !== "excluded") {
        skipped.push({
          protectedObjectId: candidate.id,
          displayName: candidate.displayName,
          reason,
        });
      }
    };

    for (const candidate of candidates) {
      const facts = verifications.get(candidate.id);
      const blocked = verifyBlockedReason({
        status: candidate.status,
        hasSnapshot: Boolean(facts?.latestSnapshot),
      });
      if (blocked) {
        skip(candidate, blocked);
        continue;
      }
      // "Verify what is not verified yet" leaves the other objects alone, silently.
      if (
        input.unverifiedOnly &&
        !input.protectedObjectId &&
        facts?.verification.state !== "unverified"
      ) {
        continue;
      }
      const jobId = await enqueueVerify(
        tx,
        db,
        tenantId,
        candidate.id,
        input.kind,
        input.sampleSize,
      );
      if (jobId === null) {
        skip(candidate, "already_queued");
        continue;
      }
      queued.push({
        jobId,
        protectedObjectId: candidate.id,
        displayName: candidate.displayName,
        kind: input.kind,
      });
    }

    await audit(tx, {
      tenantId,
      actor: actor.email,
      actorUserId: actor.userId,
      action: VERIFY_AUDIT_ACTIONS.requested,
      target: input.protectedObjectId ?? "all",
      targetType: input.protectedObjectId ? "protected_object" : "tenant",
      ip: actor.ip,
      details: {
        kind: input.kind,
        sampleSize: input.sampleSize ?? null,
        unverifiedOnly: input.unverifiedOnly ?? false,
        queued: queued.length,
        skipped: skipped.length,
        jobIds: queued.map((check) => check.jobId),
      },
    });
    return { queued, skipped };
  });
}

/** Start a scrub of the tenant's storage now. */
export async function runScrubNow(
  db: Database,
  tenantId: string,
  input: RunScrubInput,
  actor: VerifyActor,
): Promise<QueuedScrubDto> {
  return withTenantTx(db, tenantId, async (tx) => {
    const payload: ScrubJobPayload = { jobId: randomUUID(), tenantId, mode: input.mode };
    const pgBossJobId = await sendJob(tx, "scrub", payload, db);
    if (pgBossJobId === null) {
      throw new ProblemError(409, "Storage check already running", {
        detail: "A storage check of this tenant is already queued or running.",
        extensions: { reason: "already_queued" },
      });
    }
    await tx.insert(jobs).values({
      id: payload.jobId,
      tenantId,
      queue: "scrub",
      status: "queued",
      payload: payload as unknown as Record<string, unknown>,
      pgBossJobId,
    });
    await audit(tx, {
      tenantId,
      actor: actor.email,
      actorUserId: actor.userId,
      action: VERIFY_AUDIT_ACTIONS.scrubRequested,
      target: tenantId,
      targetType: "tenant",
      ip: actor.ip,
      details: { mode: input.mode, jobId: payload.jobId },
    });
    return { jobId: payload.jobId, mode: input.mode };
  });
}
