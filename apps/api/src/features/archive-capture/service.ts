/**
 * The state of archive capture for a tenant (docs/ARCHIVE.md "Erfassungswege"): what the
 * capture ways do, per mailbox, and the hold confirmation of Microsoft 365 sources. Read
 * from the capture streams the worker's capture service keeps
 * (apps/worker/src/archive-capture) and from the archive itself (items and capture rows
 * per way, by the (tenant, way, received_at) indexes); no counter of its own.
 */
import {
  type ArchiveCaptureSettings,
  type CaptureKind,
  captureChoicePending,
  captureKindSql,
  effectiveArchiveCapture,
  type SourceConfig,
} from "@restow/db";
import { sql } from "drizzle-orm";
import { audit } from "../../lib/audit.js";
import { featureEnabled, requireFeature } from "../../lib/features.js";
import { type DbExecutor, withTenantTx } from "../../lib/tenant-context.js";
import { ProblemError } from "../../problem.js";
import type { ArchiveActor } from "../archive/service.js";

export const MAILBOX_WAYS = ["graph_sync", "imap_sync"] as const;
export type MailboxWay = (typeof MAILBOX_WAYS)[number];
export const STREAM_STATUSES = [
  "pending",
  "backfilling",
  "live",
  "paused",
  "disabled",
  "error",
] as const;
export type StreamStatus = (typeof STREAM_STATUSES)[number];
export type CaptureSourceName =
  | "journal"
  | "smtp_forward"
  | "graph_sync"
  | "imap_sync"
  | "file_import";

/**
 * How strong a way's capture is (docs/ARCHIVE.md "Echt oder zeitnah"): `transport` before
 * any user could touch the mail (journaling, forwarded copies), `mailbox` shortly after
 * delivery (Graph, IMAP), `late` taken over afterwards (backfill, file import).
 */
export type CaptureAssurance = "transport" | "mailbox" | "late";

export interface CaptureCounts {
  readonly lastCapturedAt: string | null;
  /** New archive items by this way. */
  readonly items24h: number;
  readonly items7d: number;
  /** Mail this way captured again that the archive already held (capture rows). */
  readonly captures24h: number;
  readonly captures7d: number;
}

export interface MailboxWayStatusDto extends CaptureCounts {
  readonly way: MailboxWay;
  /** The gate `archive.mailboxCapture` is open (edition). */
  readonly available: boolean;
  readonly assurance: "mailbox";
  readonly streams: Record<StreamStatus, number>;
  /** Live streams by how mail is noticed, as their way last reported it. */
  readonly modes: { readonly notifications: number; readonly poll: number };
  /** Why streams poll (a failure code), with how many streams name it. */
  readonly pollReasons: Record<string, number>;
  /** The one-time takeover: streams activated, and of them those done. */
  readonly backfill: { readonly total: number; readonly completed: number };
  /** Items of this way flagged `captured-late` in the last 7 days. */
  readonly capturedLate7d: number;
}

export interface SmtpWayStatusDto extends CaptureCounts {
  readonly way: "journal" | "smtp_forward";
  /** The gate `archive.smtpCapture` is open (edition). */
  readonly available: boolean;
  readonly assurance: "transport";
}

/**
 * A mail job that archives and could capture more from the mailboxes: it holds Microsoft 365
 * mailboxes with Graph capture off, or IMAP or Google accounts still waiting for a way since
 * the update to 0.4.4 (migration 0062: such jobs keep capturing as before until someone
 * chooses).
 */
export interface CaptureJobChoiceDto {
  readonly jobId: string;
  readonly name: string;
  /** The job holds Microsoft 365 mailboxes and Graph capture is off for them. */
  readonly graphOff: boolean;
  /** The kinds of accounts the job holds that wait for a way to be chosen. */
  readonly pending: readonly ("imap" | "google")[];
}

export interface CaptureStatusDto {
  readonly mailbox: readonly MailboxWayStatusDto[];
  readonly smtp: readonly SmtpWayStatusDto[];
  readonly fileImport: CaptureCounts & { readonly assurance: "late" };
  /** Jobs where a mailbox way could be switched on, by name (at most {@link CHOICE_JOBS_LIMIT}). */
  readonly jobs: readonly CaptureJobChoiceDto[];
}

/** The most jobs the status names as able to capture more. */
export const CHOICE_JOBS_LIMIT = 100;

type CountRow = {
  way: CaptureSourceName;
  last_captured_at: string | null;
  items_24h: number;
  items_7d: number;
  late_7d: number;
};

function emptyStatuses(): Record<StreamStatus, number> {
  return Object.fromEntries(STREAM_STATUSES.map((status) => [status, 0])) as Record<
    StreamStatus,
    number
  >;
}

/** GET /archive/capture */
export async function captureStatus(
  db: DbExecutor,
  tenantId: string,
  installation?: DbExecutor,
): Promise<CaptureStatusDto> {
  const [mailboxGate, smtpGate] = await Promise.all([
    featureEnabled("archive.mailboxCapture", installation),
    featureEnabled("archive.smtpCapture", installation),
  ]);
  return withTenantTx(db, tenantId, async (tx) => {
    const items = await tx.execute<CountRow>(sql`
      select v.way::text as way,
             (select max(received_at)::text from archive_items
               where tenant_id = ${tenantId}::uuid and captured_via = v.way) as last_captured_at,
             (select count(*)::int from archive_items
               where tenant_id = ${tenantId}::uuid and captured_via = v.way
                 and received_at > now() - interval '24 hours') as items_24h,
             (select count(*)::int from archive_items
               where tenant_id = ${tenantId}::uuid and captured_via = v.way
                 and received_at > now() - interval '7 days') as items_7d,
             (select count(*)::int from archive_items
               where tenant_id = ${tenantId}::uuid and captured_via = v.way
                 and received_at > now() - interval '7 days'
                 and flags @> '["captured-late"]'::jsonb) as late_7d
        from unnest(enum_range(null::archive_capture)) as v(way)
    `);
    const captures = await tx.execute<{
      way: CaptureSourceName;
      last_captured_at: string | null;
      c24: number;
      c7: number;
    }>(sql`
      select captured_via::text as way, max(received_at)::text as last_captured_at,
             count(*) filter (where received_at > now() - interval '24 hours')::int as c24,
             count(*)::int as c7
        from archive_item_captures
       where tenant_id = ${tenantId}::uuid and received_at > now() - interval '7 days'
       group by captured_via
    `);
    const streams = await tx.execute<{
      way: MailboxWay;
      status: StreamStatus;
      mode: string | null;
      poll_reason: string | null;
      activated: boolean;
      backfilled: boolean;
      n: number;
    }>(sql`
      select way::text as way, status::text as status,
             state->>'_mode' as mode, state->>'_pollReason' as poll_reason,
             activated_at is not null as activated, backfill_completed_at is not null as backfilled,
             count(*)::int as n
        from archive_capture_streams
       where tenant_id = ${tenantId}::uuid
       group by 1, 2, 3, 4, 5, 6
    `);

    const counts = (way: CaptureSourceName): CaptureCounts & { late: number } => {
      const row = items.rows.find((r) => r.way === way);
      const capture = captures.rows.find((r) => r.way === way);
      const last = [row?.last_captured_at, capture?.last_captured_at]
        .filter((value): value is string => typeof value === "string")
        .map((value) => new Date(value))
        .sort((a, b) => b.getTime() - a.getTime())[0];
      return {
        lastCapturedAt: last ? last.toISOString() : null,
        items24h: row?.items_24h ?? 0,
        items7d: row?.items_7d ?? 0,
        captures24h: capture?.c24 ?? 0,
        captures7d: capture?.c7 ?? 0,
        late: row?.late_7d ?? 0,
      };
    };

    const mailbox = MAILBOX_WAYS.map((way): MailboxWayStatusDto => {
      const { late, ...base } = counts(way);
      const byStatus = emptyStatuses();
      const modes = { notifications: 0, poll: 0 };
      const pollReasons: Record<string, number> = {};
      let total = 0;
      let completed = 0;
      for (const row of streams.rows.filter((r) => r.way === way)) {
        byStatus[row.status] += row.n;
        if (row.status === "disabled") {
          continue;
        }
        if (row.mode === "notifications" || row.mode === "poll") {
          modes[row.mode] += row.n;
        }
        if (row.mode === "poll" && row.poll_reason) {
          pollReasons[row.poll_reason] = (pollReasons[row.poll_reason] ?? 0) + row.n;
        }
        if (row.activated) {
          total += row.n;
          completed += row.backfilled ? row.n : 0;
        }
      }
      return {
        way,
        available: mailboxGate,
        assurance: "mailbox",
        ...base,
        streams: byStatus,
        modes,
        pollReasons,
        backfill: { total, completed },
        capturedLate7d: late,
      };
    });
    const smtp = (["journal", "smtp_forward"] as const).map((way): SmtpWayStatusDto => {
      const { late: _late, ...base } = counts(way);
      return { way, available: smtpGate, assurance: "transport", ...base };
    });
    const { late: _late, ...fileImport } = counts("file_import");
    const jobs = await captureJobChoices(tx, tenantId);
    return { mailbox, smtp, fileImport: { ...fileImport, assurance: "late" }, jobs };
  });
}

/**
 * The tenant's archiving mail jobs that could capture more (see {@link CaptureJobChoiceDto}):
 * one statement, the capture kinds per job from its members, and for a job of scope `all` from
 * the tenant's mail objects in no other job (as the worker's reconcile counts them).
 */
async function captureJobChoices(tx: DbExecutor, tenantId: string): Promise<CaptureJobChoiceDto[]> {
  const rows = await tx.execute<{
    id: string;
    name: string;
    capture: ArchiveCaptureSettings | null;
    kinds: CaptureKind[] | null;
  }>(sql`
    with jobs as (
      select id, name, scope_mode, archive_capture
        from backup_jobs
       where tenant_id = ${tenantId}::uuid and kind = 'mail' and archive
    ),
    objects as (
      select j.id as job_id, ${captureKindSql("po", "s")} as kind
        from jobs j
        join backup_job_members m on m.job_id = j.id
        join protected_objects po on po.id = m.protected_object_id
        join sources s on s.id = po.source_id
       where po.status = 'active'
      union
      select j.id, ${captureKindSql("po", "s")}
        from jobs j
        join protected_objects po
          on po.tenant_id = ${tenantId}::uuid and po.kind in ('mailbox', 'imap')
         and po.status = 'active'
        join sources s on s.id = po.source_id
       where j.scope_mode = 'all'
         and not exists (
           select 1 from backup_job_members m2
            where m2.protected_object_id = po.id and m2.job_id <> j.id
         )
    )
    select j.id::text as id, j.name, j.archive_capture as capture,
           array_agg(distinct o.kind) filter (where o.kind is not null) as kinds
      from jobs j
      join objects o on o.job_id = j.id
     group by j.id, j.name, j.archive_capture
     order by lower(j.name), j.id
  `);
  const choices: CaptureJobChoiceDto[] = [];
  for (const row of rows.rows) {
    const kinds = new Set(row.kinds ?? []);
    const ways = effectiveArchiveCapture(row.capture);
    const graphOff = kinds.has("m365") && !ways.m365.graph;
    const pending: ("imap" | "google")[] = [];
    if (
      (kinds.has("imap") || kinds.has("imap_microsoft")) &&
      captureChoicePending(row.capture, "imap")
    ) {
      pending.push("imap");
    }
    if (kinds.has("google") && captureChoicePending(row.capture, "google")) {
      pending.push("google");
    }
    if (graphOff || pending.length > 0) {
      choices.push({ jobId: row.id, name: row.name, graphOff, pending });
    }
    if (choices.length >= CHOICE_JOBS_LIMIT) {
      break;
    }
  }
  return choices;
}

export interface CaptureMailboxDto {
  readonly streamId: string;
  readonly protectedObjectId: string;
  readonly kind: string;
  readonly externalId: string;
  readonly displayName: string | null;
  readonly way: MailboxWay;
  readonly status: StreamStatus;
  readonly mode: "notifications" | "poll" | null;
  readonly activatedAt: string | null;
  readonly backfillCompletedAt: string | null;
  readonly lastCaptureAt: string | null;
  readonly lastSuccessAt: string | null;
  readonly nextDueAt: string | null;
  readonly consecutiveFailures: number;
  /** The classified failure of the last pass (FailureRecordJson), null when it worked. */
  readonly failure: unknown;
}

export interface CaptureMailboxPage {
  readonly items: CaptureMailboxDto[];
  /** Pass as `cursor` for the next page; null on the last one. */
  readonly nextCursor: string | null;
}

const iso = (value: string | null) => (value ? new Date(value).toISOString() : null);

/** GET /archive/capture/mailboxes: the streams, in id order, keyset-paginated. */
export async function captureMailboxes(
  db: DbExecutor,
  tenantId: string,
  query: { way?: MailboxWay; status?: StreamStatus; cursor?: string; limit: number },
): Promise<CaptureMailboxPage> {
  return withTenantTx(db, tenantId, async (tx) => {
    const result = await tx.execute<{
      id: string;
      protected_object_id: string;
      kind: string;
      external_id: string;
      display_name: string | null;
      way: MailboxWay;
      status: StreamStatus;
      mode: string | null;
      activated_at: string | null;
      backfill_completed_at: string | null;
      last_capture_at: string | null;
      last_success_at: string | null;
      next_due_at: string | null;
      consecutive_failures: number;
      failure: unknown;
    }>(sql`
      select s.id, s.protected_object_id, po.kind::text as kind, po.external_id, po.display_name,
             s.way::text as way, s.status::text as status, s.state->>'_mode' as mode,
             s.activated_at::text as activated_at, s.backfill_completed_at::text as backfill_completed_at,
             s.last_capture_at::text as last_capture_at, s.last_success_at::text as last_success_at,
             s.next_due_at::text as next_due_at, s.consecutive_failures, s.failure
        from archive_capture_streams s
        join protected_objects po on po.id = s.protected_object_id
       where s.tenant_id = ${tenantId}::uuid
         ${query.way ? sql`and s.way = ${query.way}` : sql``}
         ${query.status ? sql`and s.status = ${query.status}` : sql``}
         ${query.cursor ? sql`and s.id > ${query.cursor}::uuid` : sql``}
       order by s.id
       limit ${query.limit + 1}
    `);
    const rows = result.rows.slice(0, query.limit);
    return {
      items: rows.map((row) => ({
        streamId: row.id,
        protectedObjectId: row.protected_object_id,
        kind: row.kind,
        externalId: row.external_id,
        displayName: row.display_name,
        way: row.way,
        status: row.status,
        mode: row.mode === "notifications" || row.mode === "poll" ? row.mode : null,
        activatedAt: iso(row.activated_at),
        backfillCompletedAt: iso(row.backfill_completed_at),
        lastCaptureAt: iso(row.last_capture_at),
        lastSuccessAt: iso(row.last_success_at),
        nextDueAt: iso(row.next_due_at),
        consecutiveFailures: row.consecutive_failures,
        failure: row.failure ?? null,
      })),
      nextCursor: result.rows.length > query.limit ? (rows.at(-1)?.id ?? null) : null,
    };
  });
}

/**
 * POST /archive/capture/mailboxes/:objectId/resync: the mailbox's capture streams run a
 * full catch-up on their next pass (due now). Audited `archive.capture.resync_requested`.
 */
export async function requestResync(
  db: DbExecutor,
  tenantId: string,
  objectId: string,
  actor: ArchiveActor,
  installation?: DbExecutor,
): Promise<{ streams: number }> {
  await requireFeature("archive.mailboxCapture", installation);
  return withTenantTx(db, tenantId, async (tx) => {
    const result = await tx.execute<{ way: string }>(sql`
      update archive_capture_streams
         set dirty_since = coalesce(dirty_since, now()), next_due_at = now(),
             state = state || jsonb_build_object('resyncRequestedAt', now()::text),
             updated_at = now()
       where tenant_id = ${tenantId}::uuid and protected_object_id = ${objectId}::uuid
         and status not in ('disabled', 'paused')
      returning way::text as way
    `);
    if (result.rows.length === 0) {
      throw new ProblemError(404, "No capture stream", {
        detail: "No archive capture runs for this mailbox.",
      });
    }
    await audit(tx, {
      tenantId,
      actor: actor.label,
      actorUserId: actor.userId,
      action: "archive.capture.resync_requested",
      target: objectId,
      targetType: "protected_object",
      ip: actor.ip,
      details: { ways: result.rows.map((row) => row.way).sort() },
    });
    return { streams: result.rows.length };
  });
}

export type ArchiveHoldStatus = "unknown" | "confirmed";

export interface ArchiveHoldDto {
  readonly sourceId: string;
  readonly name: string;
  readonly status: ArchiveHoldStatus;
  readonly confirmedBy: string | null;
  readonly confirmedAt: string | null;
  /** Mailboxes of the source captured by Graph (streams not disabled). */
  readonly graphMailboxes: number;
}

type HoldRow = {
  id: string;
  name: string;
  config: SourceConfig | null;
  graph_mailboxes: number;
};

function holdOf(row: HoldRow): ArchiveHoldDto {
  const hold = row.config?.archiveHold;
  return {
    sourceId: row.id,
    name: row.name,
    status: hold?.status === "confirmed" ? "confirmed" : "unknown",
    confirmedBy: hold?.status === "confirmed" ? (hold.confirmedBy ?? null) : null,
    confirmedAt: hold?.status === "confirmed" ? (hold.confirmedAt ?? null) : null,
    graphMailboxes: row.graph_mailboxes,
  };
}

const HOLD_SELECT = sql`
  select s.id, s.name, s.config,
         (select count(*)::int from archive_capture_streams cs
           where cs.source_id = s.id and cs.way = 'graph_sync' and cs.status <> 'disabled')
           as graph_mailboxes
    from sources s`;

/** GET /archive/capture/holds: the hold confirmation of every Microsoft 365 source. */
export async function listHolds(db: DbExecutor, tenantId: string): Promise<ArchiveHoldDto[]> {
  return withTenantTx(db, tenantId, async (tx) => {
    const result = await tx.execute<HoldRow>(sql`
      ${HOLD_SELECT}
       where s.tenant_id = ${tenantId}::uuid and s.kind = 'm365'
       order by lower(s.name), s.id
    `);
    return result.rows.map(holdOf);
  });
}

/**
 * PUT /archive/capture/holds/:sourceId: an administrator confirms (or withdraws) that a
 * retention policy or litigation hold keeps deleted mail in the Microsoft 365 tenant.
 * Restow cannot read that from Graph, so it records who said so and when; audited
 * `archive.hold.confirmed` (or `archive.hold.unconfirmed`).
 */
export async function setHold(
  db: DbExecutor,
  tenantId: string,
  sourceId: string,
  status: ArchiveHoldStatus,
  actor: ArchiveActor,
  now: Date = new Date(),
): Promise<ArchiveHoldDto> {
  return withTenantTx(db, tenantId, async (tx) => {
    const hold =
      status === "confirmed"
        ? { status, confirmedBy: actor.label, confirmedAt: now.toISOString() }
        : { status, confirmedBy: null, confirmedAt: null };
    const updated = await tx.execute<{ id: string }>(sql`
      update sources
         set config = config || jsonb_build_object('archiveHold', ${JSON.stringify(hold)}::jsonb),
             updated_at = now()
       where id = ${sourceId}::uuid and tenant_id = ${tenantId}::uuid and kind = 'm365'
      returning id
    `);
    if (updated.rows.length === 0) {
      throw new ProblemError(404, "Source not found", {
        detail: "No Microsoft 365 source with this id in the tenant.",
      });
    }
    await audit(tx, {
      tenantId,
      actor: actor.label,
      actorUserId: actor.userId,
      action: status === "confirmed" ? "archive.hold.confirmed" : "archive.hold.unconfirmed",
      target: sourceId,
      targetType: "source",
      ip: actor.ip,
      details: { status },
    });
    const result = await tx.execute<HoldRow>(sql`${HOLD_SELECT} where s.id = ${sourceId}::uuid`);
    return holdOf(result.rows[0] as HoldRow);
  });
}
