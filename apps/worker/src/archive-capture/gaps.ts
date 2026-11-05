/**
 * The capture gaps of one stream in `archive_capture_gaps` (docs/ARCHIVE.md "Lücken der
 * Erfassung", @restow/core archive/capture-gaps.ts): what a capture way could not take in.
 *
 * `failed` counts an attempt (a gap given up before, and resolved since, starts again at
 * one), at most one per {@link archive.GAP_ATTEMPT_SPACING_MS} (`last_attempt_at`); from
 * {@link archive.GAP_OPEN_AFTER_ATTEMPTS} on the gap is open (`opened_at`). `gaveUp` opens it
 * at once. `resolved` closes it; it is called for every folder read and every mail captured,
 * so it looks into the stream's unresolved gaps once (loaded on first use, kept up to date by
 * this object) and writes only for a ref that has one. `retryDue` hands out open gaps not
 * tried for {@link archive.GAP_RETRY_AFTER_MS} and marks them tried.
 */
import { archive } from "@restow/core";
import type { Database } from "@restow/db";
import { sql } from "drizzle-orm";
import { withTenantTx } from "../handlers/framework.js";

export class PgCaptureGaps implements archive.CaptureGapSink {
  private unresolved: Set<string> | null = null;
  private readonly spacingMs: number;
  private readonly retryAfterMs: number;

  constructor(
    private readonly db: Database,
    private readonly tenantId: string,
    private readonly streamId: string,
    options: { readonly spacingMs?: number; readonly retryAfterMs?: number } = {},
  ) {
    this.spacingMs = options.spacingMs ?? archive.GAP_ATTEMPT_SPACING_MS;
    this.retryAfterMs = options.retryAfterMs ?? archive.GAP_RETRY_AFTER_MS;
  }

  private key(kind: archive.CaptureGapKind, ref: string): string {
    return `${kind}:${ref}`;
  }

  async failed(gap: archive.CaptureGap): Promise<number> {
    const open = archive.GAP_OPEN_AFTER_ATTEMPTS;
    // An attempt counts when the gap was resolved since (it starts again at one) or when the
    // last counted attempt is at least the spacing ago; otherwise only last_seen_at moves.
    const counts = sql`(archive_capture_gaps.resolved_at is not null
      or archive_capture_gaps.last_attempt_at is null
      or archive_capture_gaps.last_attempt_at
           <= now() - ${this.spacingMs} * interval '1 millisecond')`;
    const result = await withTenantTx(this.db, this.tenantId, (tx) =>
      tx.execute<{ attempts: number }>(sql`
        insert into archive_capture_gaps
          (tenant_id, stream_id, kind, ref, reason, attempts, opened_at, last_attempt_at)
        values (${this.tenantId}::uuid, ${this.streamId}::uuid, ${gap.kind}, ${gap.ref},
                ${gap.reason}, 1, case when 1 >= ${open} then now() end, now())
        on conflict (stream_id, kind, ref) do update set
          attempts = case
            when archive_capture_gaps.resolved_at is not null then 1
            when ${counts} then archive_capture_gaps.attempts + 1
            else archive_capture_gaps.attempts end,
          first_seen_at = case when archive_capture_gaps.resolved_at is null
                               then archive_capture_gaps.first_seen_at else now() end,
          opened_at = case
            when archive_capture_gaps.resolved_at is not null then null
            when ${counts} and archive_capture_gaps.attempts + 1 >= ${open}
              then coalesce(archive_capture_gaps.opened_at, now())
            else archive_capture_gaps.opened_at end,
          last_attempt_at = case when ${counts} then now()
                                 else archive_capture_gaps.last_attempt_at end,
          reason = excluded.reason,
          last_seen_at = now(),
          resolved_at = null
        returning attempts
      `),
    );
    this.unresolved?.add(this.key(gap.kind, gap.ref));
    return Number(result.rows[0]?.attempts ?? 1);
  }

  async gaveUp(gap: archive.CaptureGap): Promise<void> {
    const open = archive.GAP_OPEN_AFTER_ATTEMPTS;
    await withTenantTx(this.db, this.tenantId, (tx) =>
      tx.execute(sql`
        insert into archive_capture_gaps
          (tenant_id, stream_id, kind, ref, reason, attempts, opened_at, last_attempt_at)
        values (${this.tenantId}::uuid, ${this.streamId}::uuid, ${gap.kind}, ${gap.ref},
                ${gap.reason}, ${open}, now(), now())
        on conflict (stream_id, kind, ref) do update set
          attempts = greatest(case when archive_capture_gaps.resolved_at is null
                                   then archive_capture_gaps.attempts else 0 end, ${open}),
          opened_at = case when archive_capture_gaps.resolved_at is null
                           then coalesce(archive_capture_gaps.opened_at, now()) else now() end,
          reason = excluded.reason,
          last_seen_at = now(),
          last_attempt_at = now(),
          resolved_at = null
      `),
    );
    this.unresolved?.add(this.key(gap.kind, gap.ref));
  }

  async retryDue(query: {
    readonly kinds: readonly archive.CaptureGapKind[];
    readonly reasons?: readonly string[];
  }): Promise<archive.CaptureGap[]> {
    if (query.kinds.length === 0) {
      return [];
    }
    const kinds = sql`ARRAY[${sql.join(
      query.kinds.map((kind) => sql`${kind}`),
      sql`, `,
    )}]::archive_capture_gap_kind[]`;
    const reasons =
      query.reasons && query.reasons.length > 0
        ? sql`and g.reason = any(ARRAY[${sql.join(
            query.reasons.map((reason) => sql`${reason}`),
            sql`, `,
          )}]::text[])`
        : sql``;
    const result = await withTenantTx(this.db, this.tenantId, (tx) =>
      tx.execute<{ kind: archive.CaptureGapKind; ref: string; reason: string }>(sql`
        update archive_capture_gaps set last_attempt_at = now()
         where id in (
           select g.id from archive_capture_gaps g
            where g.stream_id = ${this.streamId}::uuid
              and g.resolved_at is null and g.opened_at is not null
              and g.kind = any(${kinds}) ${reasons}
              and coalesce(g.last_attempt_at, g.last_seen_at)
                    <= now() - ${this.retryAfterMs} * interval '1 millisecond'
            order by coalesce(g.last_attempt_at, g.last_seen_at), g.ref
            limit ${archive.GAP_RETRY_BATCH}
            for update skip locked)
        returning kind::text as kind, ref, reason
      `),
    );
    return result.rows.map((row) => ({ kind: row.kind, ref: row.ref, reason: row.reason }));
  }

  async resolved(kind: archive.CaptureGapKind, ref: string): Promise<void> {
    if (this.unresolved === null) {
      const rows = await withTenantTx(this.db, this.tenantId, (tx) =>
        tx.execute<{ kind: archive.CaptureGapKind; ref: string }>(sql`
          select kind::text as kind, ref from archive_capture_gaps
           where stream_id = ${this.streamId}::uuid and resolved_at is null
        `),
      );
      this.unresolved = new Set(rows.rows.map((row) => this.key(row.kind, row.ref)));
    }
    const key = this.key(kind, ref);
    if (!this.unresolved.has(key)) {
      return;
    }
    await withTenantTx(this.db, this.tenantId, (tx) =>
      tx.execute(sql`
        update archive_capture_gaps set resolved_at = now(), last_seen_at = now()
         where stream_id = ${this.streamId}::uuid and kind = ${kind} and ref = ${ref}
           and resolved_at is null
      `),
    );
    this.unresolved.delete(key);
  }
}
