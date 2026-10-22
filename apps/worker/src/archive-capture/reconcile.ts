/**
 * Which capture streams the mail jobs want (docs/ARCHIVE.md "Erfassungswege").
 *
 * A stream is wanted for every active mail object of a mail job with archive on
 * whose capture kind (packages/db archive-capture.ts) has its mailbox way chosen in the
 * job's `archive_capture` (absent = the default: Graph for Microsoft 365, IMAP sync for
 * IMAP): the job's members, and for a job of scope `all` every object of the tenant that
 * is not a member of another job. One statement on the installation pool, every tenant at
 * once, run every two minutes by the capture service:
 *
 *   - a wanted stream that does not exist is created `pending` and due now;
 *   - a wanted stream that was `disabled` comes back (`pending` if it never went live, else
 *     `live`) and is due now;
 *   - a stream nobody wants any more is `disabled` and due now, so the service passes it
 *     once more to release what its way set up (a Graph subscription); its state and
 *     history stay.
 *
 * A paused job keeps capturing: pausing stops its scheduled backups only. Capture stops when
 * the job's archive or the way is switched off (both audited as a change of the job).
 *
 * No `jobs` row, no per-row query.
 */
import { captureKindSql, type Database } from "@restow/db";
import { sql } from "drizzle-orm";

export interface ReconcileOutcome {
  /** Streams created or brought back. */
  readonly wanted: number;
  /** Streams nobody wants any more, disabled now. */
  readonly disabled: number;
}

/** Reconcile every tenant's streams with its mail jobs (see the module docstring). */
export async function reconcileCaptureStreams(providerDb: Database): Promise<ReconcileOutcome> {
  const result = await providerDb.execute<{ wanted: string; disabled: string }>(sql`
    with job_objects as (
      select j.tenant_id, j.archive_capture as capture, m.protected_object_id as object_id
        from backup_jobs j
        join backup_job_members m on m.job_id = j.id
       where j.kind = 'mail' and j.archive and m.protected_object_id is not null
      union all
      select j.tenant_id, j.archive_capture, po.id
        from backup_jobs j
        join protected_objects po on po.tenant_id = j.tenant_id
       where j.kind = 'mail' and j.scope_mode = 'all' and j.archive
         and po.kind in ('mailbox', 'imap')
         and not exists (
           select 1 from backup_job_members m2
            where m2.protected_object_id = po.id and m2.job_id <> j.id
         )
    ),
    kinds as (
      select jo.tenant_id, jo.capture, po.id as object_id, po.source_id,
             ${captureKindSql("po", "s")} as kind
        from job_objects jo
        join protected_objects po on po.id = jo.object_id
        join sources s on s.id = po.source_id
       where po.status = 'active' and s.status <> 'disabled'
    ),
    desired as (
      select distinct on (object_id, way) tenant_id, object_id, source_id, way
        from (
          select tenant_id, object_id, source_id,
                 (case
                    when kind = 'm365' and coalesce((capture->'m365'->>'graph')::boolean, true)
                      then 'graph_sync'
                    when kind = 'google' and coalesce((capture->'google'->>'sync')::boolean, true)
                      then 'imap_sync'
                    when kind in ('imap', 'imap_microsoft')
                         and coalesce((capture->'imap'->>'sync')::boolean, true)
                      then 'imap_sync'
                  end)::archive_capture_way as way
            from kinds
        ) w
       where way is not null
       order by object_id, way
    ),
    wanted as (
      insert into archive_capture_streams as cs
             (tenant_id, protected_object_id, source_id, way, status, next_due_at)
      select d.tenant_id, d.object_id, d.source_id, d.way, 'pending', now() from desired d
       -- Streams that exist and are wanted stay untouched (and unlocked: a claim running at
       -- the same time must not skip them).
       where not exists (
         select 1 from archive_capture_streams e
          where e.protected_object_id = d.object_id and e.way = d.way and e.status <> 'disabled'
       )
      on conflict (protected_object_id, way) do update set
        status = (case when cs.activated_at is null then 'pending' else 'live' end)::archive_stream_status,
        source_id = excluded.source_id,
        next_due_at = now(),
        updated_at = now()
      where cs.status = 'disabled'
      returning cs.id
    ),
    unwanted as (
      update archive_capture_streams cs
         set status = 'disabled', next_due_at = now(), updated_at = now()
       where cs.status <> 'disabled'
         and not exists (
           select 1 from desired d where d.object_id = cs.protected_object_id and d.way = cs.way
         )
      returning cs.id
    )
    select (select count(*) from wanted)::text as wanted,
           (select count(*) from unwanted)::text as disabled
  `);
  const row = result.rows[0];
  return { wanted: Number(row?.wanted ?? 0), disabled: Number(row?.disabled ?? 0) };
}
