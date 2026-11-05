/**
 * The capture gaps of one stream in `archive_capture_gaps` (docs/ARCHIVE.md "Lücken der
 * Erfassung", @restow/core archive/capture-gaps.ts): what a capture way could not take in.
 *
 * `failed` counts an attempt (a gap given up before, and resolved since, starts again at
 * one); from {@link archive.GAP_OPEN_AFTER_ATTEMPTS} on the gap is open (`opened_at`).
 * `gaveUp` opens it at once. `resolved` closes it; it is called for every folder read and
 * every mail captured, so it looks into the stream's unresolved gaps once (loaded on first
 * use, kept up to date by this object) and writes only for a ref that has one.
 */
import { archive } from "@restow/core";
import type { Database } from "@restow/db";
import { sql } from "drizzle-orm";
import { withTenantTx } from "../handlers/framework.js";

export class PgCaptureGaps implements archive.CaptureGapSink {
  private unresolved: Set<string> | null = null;

  constructor(
    private readonly db: Database,
    private readonly tenantId: string,
    private readonly streamId: string,
  ) {}

  private key(kind: archive.CaptureGapKind, ref: string): string {
    return `${kind}:${ref}`;
  }

  async failed(gap: archive.CaptureGap): Promise<number> {
    const open = archive.GAP_OPEN_AFTER_ATTEMPTS;
    const result = await withTenantTx(this.db, this.tenantId, (tx) =>
      tx.execute<{ attempts: number }>(sql`
        insert into archive_capture_gaps
          (tenant_id, stream_id, kind, ref, reason, attempts, opened_at)
        values (${this.tenantId}::uuid, ${this.streamId}::uuid, ${gap.kind}, ${gap.ref},
                ${gap.reason}, 1, case when 1 >= ${open} then now() end)
        on conflict (stream_id, kind, ref) do update set
          attempts = case when archive_capture_gaps.resolved_at is null
                          then archive_capture_gaps.attempts + 1 else 1 end,
          first_seen_at = case when archive_capture_gaps.resolved_at is null
                               then archive_capture_gaps.first_seen_at else now() end,
          opened_at = case
            when archive_capture_gaps.resolved_at is not null then null
            when archive_capture_gaps.attempts + 1 >= ${open}
              then coalesce(archive_capture_gaps.opened_at, now())
            else archive_capture_gaps.opened_at end,
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
          (tenant_id, stream_id, kind, ref, reason, attempts, opened_at)
        values (${this.tenantId}::uuid, ${this.streamId}::uuid, ${gap.kind}, ${gap.ref},
                ${gap.reason}, ${open}, now())
        on conflict (stream_id, kind, ref) do update set
          attempts = greatest(case when archive_capture_gaps.resolved_at is null
                                   then archive_capture_gaps.attempts else 0 end, ${open}),
          opened_at = case when archive_capture_gaps.resolved_at is null
                           then coalesce(archive_capture_gaps.opened_at, now()) else now() end,
          reason = excluded.reason,
          last_seen_at = now(),
          resolved_at = null
      `),
    );
    this.unresolved?.add(this.key(gap.kind, gap.ref));
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
