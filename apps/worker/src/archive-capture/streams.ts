/**
 * `archive_capture_streams` as the capture service's queue (./service.ts).
 *
 * Claiming spans tenants and runs on the installation pool (BYPASSRLS), like the webhook
 * dispatcher: due streams are taken with `FOR UPDATE SKIP LOCKED` and leased to one worker
 * process (`lease_owner`, `lease_until`), so two processes never work one mailbox and a
 * crashed one only delays it until its lease runs out. Every write after the claim names
 * the owner: a process whose lease was taken over writes nothing.
 *
 * A tenant whose storage is switching targets (`storage_migrations.status = 'switching'`)
 * is not claimed: its captures wait until the switch committed (./service.ts).
 */
import type {
  ArchiveStreamState,
  ArchiveStreamStatus,
  Database,
  FailureRecordJson,
} from "@restow/db";
import { sql } from "drizzle-orm";
import type { CaptureStream, MailboxWay } from "./ways.js";

interface StreamRow {
  id: string;
  tenant_id: string;
  protected_object_id: string;
  source_id: string;
  way: MailboxWay;
  status: ArchiveStreamStatus;
  activated_at: Date | string | null;
  backfill_completed_at: Date | string | null;
  state: ArchiveStreamState | null;
  dirty_since: Date | string | null;
  consecutive_failures: number;
  last_capture_at: Date | string | null;
}

function date(value: Date | string | null): Date | null {
  return value === null ? null : value instanceof Date ? value : new Date(value);
}

export function streamFromRow(row: StreamRow): CaptureStream {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    protectedObjectId: row.protected_object_id,
    sourceId: row.source_id,
    way: row.way,
    status: row.status,
    activatedAt: date(row.activated_at),
    backfillCompletedAt: date(row.backfill_completed_at),
    state: row.state ?? {},
    dirtySince: date(row.dirty_since),
    consecutiveFailures: row.consecutive_failures,
    lastCaptureAt: date(row.last_capture_at),
  };
}

const STREAM_COLUMNS = sql.raw(
  "s.id, s.tenant_id, s.protected_object_id, s.source_id, s.way, s.status, s.activated_at, s.backfill_completed_at, s.state, s.dirty_since, s.consecutive_failures, s.last_capture_at",
);

/** What a finished pass writes back. */
export interface StreamOutcome {
  readonly state: ArchiveStreamState;
  readonly status: ArchiveStreamStatus;
  /** Null: nothing to do until something makes it due again (a disabled stream, released). */
  readonly nextDueAt: Date | null;
  /** Set once, when the way activated a pending stream. */
  readonly activatedAt?: Date;
  readonly backfillJobId?: string;
  /** The pass started at; `dirty_since` up to it is cleared on success. */
  readonly passStartedAt: Date;
  readonly captured: number;
  readonly failure: FailureRecordJson | null;
}

export class PgStreamStore {
  /**
   * What each stream held when this store claimed it, exactly as Postgres holds it (text,
   * the due time to the microsecond): its due time and its resync request. `complete()`
   * and `checkpoint()` compare them with the row. A different due time means something
   * made the stream due while the pass ran (an IDLE or change notification, a resync, the
   * IDLE manager taking the account over); a different resync request means a resync was
   * asked for meanwhile. Both are kept instead of being overwritten by what the pass
   * writes, which it built from the row as it was claimed.
   */
  private readonly claimed = new Map<string, { due: string | null; resync: string | null }>();

  /** `db`: the installation pool. */
  constructor(private readonly db: Database) {}

  /**
   * Claim up to `limit` due streams for `owner`, oldest due first, skipping tenants in a
   * storage switch and (optionally) tenants that already have `busyTenants` work here.
   */
  async claimDue(options: {
    readonly owner: string;
    readonly limit: number;
    readonly leaseMs: number;
    readonly ways: readonly MailboxWay[];
    readonly skipTenants?: readonly string[];
  }): Promise<CaptureStream[]> {
    if (options.limit <= 0 || options.ways.length === 0) {
      return [];
    }
    const ways = sql`ARRAY[${sql.join(
      options.ways.map((way) => sql`${way}`),
      sql`, `,
    )}]::archive_capture_way[]`;
    const skip = (options.skipTenants ?? []).filter((id) => /^[0-9a-f-]{36}$/i.test(id));
    const skipTenants =
      skip.length > 0
        ? sql`and c.tenant_id <> all(ARRAY[${sql.join(
            skip.map((id) => sql`${id}`),
            sql`, `,
          )}]::uuid[])`
        : sql``;
    const result = await this.db.execute(sql`
      update archive_capture_streams as s
         set lease_owner = ${options.owner},
             lease_until = now() + ${`${options.leaseMs} milliseconds`}::interval
       where s.id in (
         select c.id from archive_capture_streams c
          where c.next_due_at <= now()
            and c.status <> 'paused'
            and c.way = any(${ways})
            and (c.lease_until is null or c.lease_until < now())
            and not exists (
              select 1 from storage_migrations m
               where m.tenant_id = c.tenant_id and m.status = 'switching'
            )
            ${skipTenants}
          order by c.next_due_at
          limit ${options.limit}
          for update skip locked
       )
      returning ${STREAM_COLUMNS}, s.next_due_at::text as claimed_due,
                s.state->>'resyncRequestedAt' as claimed_resync
    `);
    const rows = result.rows as unknown as (StreamRow & {
      claimed_due: string | null;
      claimed_resync: string | null;
    })[];
    for (const row of rows) {
      this.claimed.set(row.id, { due: row.claimed_due, resync: row.claimed_resync });
    }
    return rows.map(streamFromRow);
  }

  /** Extend the leases `owner` holds; returns the ids it no longer holds. */
  async renew(owner: string, ids: readonly string[], leaseMs: number): Promise<Set<string>> {
    if (ids.length === 0) {
      return new Set();
    }
    const result = await this.db.execute<{ id: string }>(sql`
      update archive_capture_streams
         set lease_until = now() + ${`${leaseMs} milliseconds`}::interval
       where lease_owner = ${owner}
         and id = any(ARRAY[${sql.join(
           ids.map((id) => sql`${id}`),
           sql`, `,
         )}]::uuid[])
      returning id
    `);
    const held = new Set(result.rows.map((row) => row.id));
    return new Set(ids.filter((id) => !held.has(id)));
  }

  /** Persist a mid-pass state while `owner` holds the lease. */
  async checkpoint(owner: string, id: string, state: ArchiveStreamState): Promise<boolean> {
    const result = await this.db.execute(sql`
      update archive_capture_streams
         set state = ${JSON.stringify(state)}::jsonb || ${this.resyncAskedMeanwhile(id)},
             updated_at = now()
       where id = ${id}::uuid and lease_owner = ${owner}
    `);
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Record an activation while `owner` holds the lease: the way's state, `activated_at` and
   * `backfilling`, before the backfill is queued, so the backfill job (which may start at
   * once) reads both. False when the lease was lost.
   */
  async activate(
    owner: string,
    id: string,
    state: ArchiveStreamState,
    activatedAt: Date,
  ): Promise<boolean> {
    const result = await this.db.execute(sql`
      update archive_capture_streams set
        state = ${JSON.stringify(state)}::jsonb,
        activated_at = coalesce(activated_at, ${activatedAt.toISOString()}::timestamptz),
        status = case when status = 'pending' then 'backfilling'::archive_stream_status
                      else status end,
        updated_at = now()
       where id = ${id}::uuid and lease_owner = ${owner}
    `);
    return (result.rowCount ?? 0) > 0;
  }

  /** Write a pass's outcome and release the lease; false when the lease was lost. */
  async complete(owner: string, id: string, outcome: StreamOutcome): Promise<boolean> {
    const ok = outcome.failure === null;
    const keepResync = this.resyncAskedMeanwhile(id);
    const claimedDue = this.claimed.get(id)?.due ?? null;
    this.claimed.delete(id);
    const next = outcome.nextDueAt?.toISOString() ?? null;
    const result = await this.db.execute(sql`
      update archive_capture_streams set
        -- _errorSince: when the stream went into error (kept while it stays there, removed
        -- by the next pass that is not one); the capture alerts (./alerts.ts) read it.
        state = case when ${outcome.status} = 'error'
                     then ${JSON.stringify(outcome.state)}::jsonb || ${keepResync} || jsonb_build_object('_errorSince',
                            coalesce(state->>'_errorSince', to_char(now() at time zone 'UTC',
                                     'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))
                     else (${JSON.stringify(outcome.state)}::jsonb || ${keepResync}) - '_errorSince' end,
        -- A stream disabled or paused meanwhile (reconcile, an administrator) stays so.
        status = case when status in ('disabled', 'paused') then status
                      else ${outcome.status}::archive_stream_status end,
        -- Made due while the pass ran (the row no longer holds the due time it was claimed
        -- with): the earlier of the two, so that request is not lost until the pass's own
        -- next time (up to the safety pass of a watched account, half an hour later).
        next_due_at = case when ${claimedDue}::timestamptz is not null
                            and next_due_at is distinct from ${claimedDue}::timestamptz
                           then least(next_due_at, ${next}::timestamptz)
                           else ${next}::timestamptz end,
        activated_at = coalesce(activated_at, ${outcome.activatedAt?.toISOString() ?? null}::timestamptz),
        backfill_job_id = coalesce(${outcome.backfillJobId ?? null}::uuid, backfill_job_id),
        dirty_since = case when ${ok} and dirty_since <= ${outcome.passStartedAt.toISOString()}::timestamptz
                           then null else dirty_since end,
        last_capture_at = case when ${outcome.captured} > 0 then now() else last_capture_at end,
        last_success_at = case when ${ok} then now() else last_success_at end,
        consecutive_failures = case when ${ok} then 0 else consecutive_failures + 1 end,
        failure = ${outcome.failure ? JSON.stringify(outcome.failure) : null}::jsonb,
        lease_owner = null,
        lease_until = null,
        updated_at = now()
       where id = ${id}::uuid and lease_owner = ${owner}
    `);
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * The resync request the row holds when it is not the one the stream was claimed with
   * (asked for while the pass ran), to be merged into the state the pass writes; an empty
   * object otherwise. Reads the row's current value inside the UPDATE.
   */
  private resyncAskedMeanwhile(id: string) {
    const claimedResync = this.claimed.get(id)?.resync ?? null;
    return sql`(case when state->>'resyncRequestedAt' is not null
                      and state->>'resyncRequestedAt' is distinct from ${claimedResync}::text
                     then jsonb_build_object('resyncRequestedAt', state->'resyncRequestedAt')
                     else '{}'::jsonb end)`;
  }

  /** Give a lease back without writing anything else (an aborted pass). */
  async release(owner: string, id: string): Promise<void> {
    this.claimed.delete(id);
    await this.db.execute(sql`
      update archive_capture_streams set lease_owner = null, lease_until = null
       where id = ${id}::uuid and lease_owner = ${owner}
    `);
  }

  /** Make streams due now (notifications, a background component, a resync). */
  async markDue(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) {
      return;
    }
    await this.db.execute(sql`
      update archive_capture_streams
         set next_due_at = now(), dirty_since = coalesce(dirty_since, now()), updated_at = now()
       where id = any(ARRAY[${sql.join(
         ids.map((id) => sql`${id}`),
         sql`, `,
       )}]::uuid[])
    `);
  }

  /** The tenants whose storage is switching targets right now. */
  async switchingTenants(): Promise<Set<string>> {
    const result = await this.db.execute<{ tenant_id: string }>(
      sql`select distinct tenant_id from storage_migrations where status = 'switching'`,
    );
    return new Set(result.rows.map((row) => row.tenant_id));
  }

  /** Refs notifications announced for a stream's mailbox, oldest first. */
  async pendingRefs(stream: CaptureStream, limit: number): Promise<string[]> {
    const result = await this.db.execute<{ external_ref: string }>(sql`
      select external_ref from archive_capture_pending
       where protected_object_id = ${stream.protectedObjectId}::uuid and way = ${stream.way}
       order by created_at
       limit ${limit}
    `);
    return result.rows.map((row) => row.external_ref);
  }

  async deletePending(stream: CaptureStream, refs: readonly string[]): Promise<void> {
    if (refs.length === 0) {
      return;
    }
    await this.db.execute(sql`
      delete from archive_capture_pending
       where protected_object_id = ${stream.protectedObjectId}::uuid and way = ${stream.way}
         and external_ref = any(ARRAY[${sql.join(
           refs.map((ref) => sql`${ref}`),
           sql`, `,
         )}]::text[])
    `);
  }

  /** One stream by mailbox and way (the backfill job), unleased read. */
  async find(protectedObjectId: string, way: MailboxWay): Promise<CaptureStream | null> {
    const result = await this.db.execute(sql`
      select ${STREAM_COLUMNS} from archive_capture_streams s
       where s.protected_object_id = ${protectedObjectId}::uuid and s.way = ${way}
    `);
    const row = result.rows[0] as unknown as StreamRow | undefined;
    return row ? streamFromRow(row) : null;
  }

  /** The backfill of a stream finished: it is live from now on. */
  async backfillCompleted(id: string): Promise<void> {
    await this.db.execute(sql`
      update archive_capture_streams set
        backfill_completed_at = coalesce(backfill_completed_at, now()),
        status = case when status = 'backfilling' then 'live'::archive_stream_status else status end,
        updated_at = now()
       where id = ${id}::uuid
    `);
  }
}
