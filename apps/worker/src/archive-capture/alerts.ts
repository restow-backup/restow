/**
 * Alerts of the archive capture (docs/ARCHIVE.md "Erfassungswege"), as the existing event
 * `archive.failed` with `details.reason`:
 *
 *   capture_error  a capture stream (Graph or IMAP, one mailbox) has been in `error` for more
 *                  than an hour (`_errorSince` in its state, ./streams.ts). Once per stream and
 *                  error stretch: a pass that works ends the stretch.
 *   forward_stale  forwarded copies of an IMAP account arrived since its archive address was
 *                  issued, but none for 24 hours, while a mail job that archives the account
 *                  chose the forwarded copy. Once per address and stretch: a new copy ends it.
 *   journal_stale  the tenant's journal address received journal reports, but none for 24
 *                  hours. Once per tenant and stretch.
 *
 * "Received before" looks back 7 days, like the status of the forwarding and journal pages
 * (`stale`); an address silent for longer was already announced, or never worked. Whether
 * an alert was raised is read back from the notifications, as the overdue pass does
 * (../overdue.ts): an alert names the start of its stretch (`errorSince`, `lastCopyAt`,
 * `lastReportAt`), and a stretch already named is not announced again. A paused job keeps capturing (./reconcile.ts), so its accounts count too.
 *
 * Runs with the endpoint monitor every five minutes: a few queries across all tenants on
 * indexed columns, no query per mailbox; at most {@link MAX_ALERTS_PER_TENANT} per tenant
 * and pass.
 */
import { captureKindSql, type NewNotification } from "@restow/db";
import { sql } from "drizzle-orm";
import type { EndpointJobDeps } from "../endpoints/common.js";
import { withTenantTx } from "../handlers/framework.js";
import { alertFailure, raiseEvents } from "../reporting.js";

const HOUR_MS = 60 * 60 * 1000;
/** A stream in `error` this long raises an alert. */
export const CAPTURE_ERROR_ALERT_MS = HOUR_MS;
/** Forwarding or journaling silent this long (after it received) raises an alert. */
export const SMTP_STALE_ALERT_MS = 24 * HOUR_MS;
/** How far back "it received before" looks. */
const LOOKBACK_MS = 7 * 24 * HOUR_MS;
const MAX_ALERTS_PER_TENANT = 100;

export type ArchiveAlertReason = "capture_error" | "forward_stale" | "journal_stale";

type Deps = Pick<EndpointJobDeps, "db" | "providerDb">;

const iso = (value: Date | string): string =>
  (value instanceof Date ? value : new Date(value)).toISOString();

const WAY_LABEL: Record<string, string> = {
  graph_sync: "Microsoft Graph",
  imap_sync: "IMAP",
};

type StreamRow = {
  id: string;
  tenant_id: string;
  protected_object_id: string;
  way: string;
  name: string;
  failure: Record<string, unknown> | null;
  error_since: Date | string;
};

/** Streams in `error` for longer than an hour that were not announced in this stretch. */
async function erroredStreams(deps: Deps, now: Date): Promise<StreamRow[]> {
  const since = new Date(now.getTime() - CAPTURE_ERROR_ALERT_MS);
  const result = await deps.providerDb.execute<StreamRow>(sql`
    with errored as (
      select s.id, s.tenant_id, s.protected_object_id, s.way::text as way, s.failure,
             coalesce((s.state->>'_errorSince')::timestamptz, s.last_success_at, s.activated_at,
                      s.created_at) as error_since,
             coalesce(nullif(trim(po.display_name), ''), po.external_id) as name
        from archive_capture_streams s
        join protected_objects po on po.id = s.protected_object_id
        join tenants t on t.id = s.tenant_id and t.status = 'active'
       where s.status = 'error'
    )
    select e.* from errored e
     where e.error_since < ${since.toISOString()}::timestamptz
       and not exists (
         select 1 from notifications n
          where n.tenant_id = e.tenant_id and n.event = 'archive.failed'
            and n.details->>'captureStreamId' = e.id::text
            and (n.details->>'errorSince')::timestamptz >= e.error_since - interval '1 millisecond')
     order by e.tenant_id, e.error_since
  `);
  return result.rows;
}

type ForwardRow = {
  id: string;
  tenant_id: string;
  protected_object_id: string;
  name: string;
  last_at: Date | string;
};

/**
 * Archive addresses of accounts whose job wants the forwarded copy, that received a copy
 * since they were issued (within the look-back) but none for 24 hours, not yet announced.
 */
async function staleForwardAddresses(deps: Deps, now: Date): Promise<ForwardRow[]> {
  const since7 = new Date(now.getTime() - LOOKBACK_MS).toISOString();
  const since24 = new Date(now.getTime() - SMTP_STALE_ALERT_MS).toISOString();
  const kind = captureKindSql("po", "s");
  const result = await deps.providerDb.execute<ForwardRow>(sql`
    with addresses as (
      select fa.id, fa.tenant_id, fa.protected_object_id, fa.created_at,
             coalesce(nullif(trim(po.display_name), ''), po.external_id) as name,
             ${kind} as capture_kind
        from archive_forward_addresses fa
        join protected_objects po on po.id = fa.protected_object_id
        join sources s on s.id = po.source_id
        join tenants t on t.id = fa.tenant_id and t.status = 'active'
       where fa.revoked_at is null and po.kind = 'imap' and s.kind = 'imap'
    ),
    wanted as (
      select a.* from addresses a
       where exists (
         select 1 from backup_jobs j
          where j.tenant_id = a.tenant_id and j.kind = 'mail' and j.archive
            and coalesce((j.archive_capture->(case when a.capture_kind = 'google' then 'google' else 'imap' end)->>'forward')::boolean, false)
            and (
              exists (select 1 from backup_job_members m
                       where m.job_id = j.id and m.protected_object_id = a.protected_object_id)
              or (j.scope_mode = 'all' and not exists (
                    select 1 from backup_job_members m2
                     where m2.protected_object_id = a.protected_object_id and m2.job_id <> j.id))
            ))
    ),
    copies as (
      select i.tenant_id, i.protected_object_id, max(i.received_at) as last_at
        from archive_items i
       where i.tenant_id in (select tenant_id from wanted) and i.captured_via = 'smtp_forward'
         and i.received_at >= ${since7}::timestamptz
         and i.protected_object_id in (select protected_object_id from wanted)
       group by i.tenant_id, i.protected_object_id
      union all
      select c.tenant_id, c.protected_object_id, max(c.received_at)
        from archive_item_captures c
       where c.tenant_id in (select tenant_id from wanted) and c.captured_via = 'smtp_forward'
         and c.received_at >= ${since7}::timestamptz
         and c.protected_object_id in (select protected_object_id from wanted)
       group by c.tenant_id, c.protected_object_id
    ),
    latest as (
      select tenant_id, protected_object_id, max(last_at) as last_at
        from copies group by tenant_id, protected_object_id
    )
    select w.id, w.tenant_id, w.protected_object_id, w.name, l.last_at
      from wanted w
      join latest l on l.tenant_id = w.tenant_id and l.protected_object_id = w.protected_object_id
     where l.last_at >= w.created_at and l.last_at < ${since24}::timestamptz
       and not exists (
         select 1 from notifications n
          where n.tenant_id = w.tenant_id and n.event = 'archive.failed'
            and n.details->>'forwardAddressId' = w.id::text
            and (n.details->>'lastCopyAt')::timestamptz >= l.last_at - interval '1 millisecond')
     order by w.tenant_id, l.last_at
  `);
  return result.rows;
}

type JournalRow = {
  tenant_id: string;
  last_at: Date | string;
};

/** Tenants whose journal address received reports (within the look-back), none for 24 hours. */
async function staleJournals(deps: Deps, now: Date): Promise<JournalRow[]> {
  const since7 = new Date(now.getTime() - LOOKBACK_MS).toISOString();
  const since24 = new Date(now.getTime() - SMTP_STALE_ALERT_MS).toISOString();
  const result = await deps.providerDb.execute<JournalRow>(sql`
    select t.id as tenant_id, l.last_at
      from tenants t
     cross join lateral (
       select greatest(
         (select max(i.received_at) from archive_items i
           where i.tenant_id = t.id and i.captured_via = 'journal'
             and i.received_at >= ${since7}::timestamptz),
         (select max(c.received_at) from archive_item_captures c
           where c.tenant_id = t.id and c.captured_via = 'journal'
             and c.received_at >= ${since7}::timestamptz)) as last_at
     ) l
     where t.status = 'active' and t.journal_token is not null
       and l.last_at < ${since24}::timestamptz
       and not exists (
         select 1 from notifications n
          where n.tenant_id = t.id and n.event = 'archive.failed'
            and n.details->>'reason' = 'journal_stale'
            and (n.details->>'lastReportAt')::timestamptz >= l.last_at - interval '1 millisecond')
  `);
  return result.rows;
}

/** The alert of a stream in `error`. */
export function captureErrorNotification(row: StreamRow): NewNotification {
  const failure =
    row.failure && typeof row.failure.code === "string"
      ? alertFailure(row.failure as unknown as Parameters<typeof alertFailure>[0])
      : null;
  const way = WAY_LABEL[row.way] ?? row.way;
  return {
    tenantId: row.tenant_id,
    level: "error",
    event: "archive.failed",
    message: `Archive capture of ${row.name} by ${way} has been failing for more than an hour.`,
    details: {
      reason: "capture_error" satisfies ArchiveAlertReason,
      queue: "archive",
      protectedObjectId: row.protected_object_id,
      objectName: row.name,
      captureStreamId: row.id,
      captureWay: row.way,
      errorSince: iso(row.error_since),
      failure,
    },
  };
}

/** The alert of an archive address that stopped receiving forwarded copies. */
export function forwardStaleNotification(row: ForwardRow): NewNotification {
  return {
    tenantId: row.tenant_id,
    level: "error",
    event: "archive.failed",
    message: `No forwarded copy of ${row.name} has arrived for more than 24 hours.`,
    details: {
      reason: "forward_stale" satisfies ArchiveAlertReason,
      queue: "archive",
      protectedObjectId: row.protected_object_id,
      objectName: row.name,
      forwardAddressId: row.id,
      lastCopyAt: iso(row.last_at),
    },
  };
}

/** The alert of a journal address that stopped receiving journal reports. */
export function journalStaleNotification(row: JournalRow): NewNotification {
  return {
    tenantId: row.tenant_id,
    level: "error",
    event: "archive.failed",
    message: "No journal report has arrived for more than 24 hours.",
    details: {
      reason: "journal_stale" satisfies ArchiveAlertReason,
      queue: "archive",
      lastReportAt: iso(row.last_at),
    },
  };
}

/** Raise the capture alerts of every active tenant; returns how many were raised. */
export async function alertArchiveCapture(deps: Deps, now: Date): Promise<number> {
  const raised = [
    ...(await erroredStreams(deps, now)).map(captureErrorNotification),
    ...(await staleForwardAddresses(deps, now)).map(forwardStaleNotification),
    ...(await staleJournals(deps, now)).map(journalStaleNotification),
  ];
  const byTenant = new Map<string, NewNotification[]>();
  for (const notification of raised) {
    const tenantId = notification.tenantId as string;
    const list = byTenant.get(tenantId) ?? [];
    if (list.length < MAX_ALERTS_PER_TENANT) {
      list.push(notification);
    }
    byTenant.set(tenantId, list);
  }
  let alerts = 0;
  for (const [tenantId, list] of byTenant) {
    await withTenantTx(deps.db, tenantId, (tx) => raiseEvents(tx, list, now));
    alerts += list.length;
  }
  return alerts;
}
