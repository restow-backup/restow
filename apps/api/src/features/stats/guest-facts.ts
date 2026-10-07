import { pveGuestBackable, pveJobOfGuest } from "@restow/core";
import { pveGuests, pveJobs, pveRuns, pveSnapshots } from "@restow/db";
import { type SQL, sql } from "drizzle-orm";
import type { Transaction } from "../../lib/tenant-context.js";
import type { ResolvedPeriod } from "./period.js";

/**
 * What the statistics read about the VMs and containers of Proxmox VE (docs/PVE.md), from
 * `pve_guests`, `pve_jobs`, `pve_snapshots` and `pve_runs`. Same contract as collect.ts and
 * endpoint-facts.ts: read inside the tenant's pinned transaction, the tenant named in every
 * query; the rating itself is pure (guest-timeline.ts).
 *
 * Only what the recovery readiness and the backup outcomes need is read. A guest's restore
 * points hold the tenant's chunks (VMs) or a restic repository (containers), but the storage,
 * volume, deduplication, restore and largest-object figures stay as they are, as they do for
 * the servers and clients.
 *
 * Which guests count is decided by today's facts, as for the protected objects (whose status
 * history is not stored either): a guest PVE can back up that is in an enabled PVE job now, or
 * that has a restore point. A restore check of a restore point is kept with the restore point
 * (`pve_snapshots.verify`, its newest check only), so the check counts from when it ran.
 */

export interface GuestRow {
  readonly id: string;
  readonly createdAt: Date;
  /** In an enabled PVE job now (`pveJobOfGuest`); one out of every job counts with a restore point only. */
  readonly inJob: boolean;
}

/** A restore point of a guest, as far as readiness needs it. */
export interface GuestRestorePoint {
  readonly guestId: string;
  readonly sequence: number;
  readonly backupAt: Date;
  readonly prunedAt: Date | null;
  /** The newest restore check of it: when it ran and its rating; null while none ran. */
  readonly check: { readonly at: Date; readonly readiness: "green" | "red" } | null;
}

export interface GuestFacts {
  readonly list: readonly GuestRow[];
  /** The restore points kept at the start of the period or made during it. */
  readonly restorePoints: readonly GuestRestorePoint[];
  /** Finished backup runs per UTC day of `finished_at` over the previous and the current period. */
  readonly backupRuns: readonly {
    readonly day: string;
    readonly status: "succeeded" | "failed";
    readonly count: number;
  }[];
}

/** A tenant without Proxmox VE. */
export const NO_GUEST_FACTS: GuestFacts = { list: [], restorePoints: [], backupRuns: [] };

type Row = Record<string, unknown>;

async function rows(tx: Transaction, query: SQL): Promise<Row[]> {
  const result = await tx.execute(query);
  return result.rows as Row[];
}

function toDate(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

function toNumber(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Everything the statistics need about the tenant's guests for `period`. Four queries. */
export async function collectGuestFacts(
  tx: Transaction,
  tenantId: string,
  period: ResolvedPeriod,
): Promise<GuestFacts> {
  const { start, end } = period.current;
  const since = period.previous.start;

  const guests = await tx
    .select({
      id: pveGuests.id,
      createdAt: pveGuests.createdAt,
      jobId: pveGuests.jobId,
      kind: pveGuests.kind,
      template: pveGuests.template,
      present: pveGuests.present,
    })
    .from(pveGuests)
    .where(sql`${pveGuests.tenantId} = ${tenantId}`);
  if (guests.length === 0) {
    return NO_GUEST_FACTS;
  }
  const jobs = await tx
    .select({ id: pveJobs.id, enabled: pveJobs.enabled, scopeAll: pveJobs.scopeAll })
    .from(pveJobs)
    .where(sql`${pveJobs.tenantId} = ${tenantId}`);

  const points = await rows(
    tx,
    sql`
      select s.guest_id, s.sequence, s.backup_at, s.pruned_at,
        s.verify->>'checkedAt' as checked_at,
        coalesce((s.verify->>'mismatched')::int, 0) as mismatched,
        coalesce(jsonb_array_length(case when jsonb_typeof(s.verify->'errors') = 'array'
          then s.verify->'errors' end), 0) as errors
      from ${pveSnapshots} as s
      where s.tenant_id = ${tenantId} and s.backup_at < ${end}
        and (s.pruned_at is null or s.pruned_at >= ${start})`,
  );

  const runs = await rows(
    tx,
    sql`
      select to_char(r.finished_at at time zone 'UTC', 'YYYY-MM-DD') as day, r.status,
        count(*)::int as count
      from ${pveRuns} as r
      where r.tenant_id = ${tenantId} and r.kind = 'backup'
        and r.status in ('succeeded', 'failed')
        and r.finished_at >= ${since} and r.finished_at < ${end}
      group by 1, 2`,
  );

  return {
    list: guests
      .filter((guest) => pveGuestBackable(guest))
      .map((guest) => ({
        id: guest.id,
        createdAt: guest.createdAt,
        inJob: pveJobOfGuest(guest, jobs) !== null,
      })),
    restorePoints: points.map((row) => ({
      guestId: String(row.guest_id),
      sequence: toNumber(row.sequence),
      backupAt: toDate(row.backup_at),
      prunedAt:
        row.pruned_at === null || row.pruned_at === undefined ? null : toDate(row.pruned_at),
      check:
        typeof row.checked_at === "string" && row.checked_at.length > 0
          ? {
              at: toDate(row.checked_at),
              readiness: toNumber(row.mismatched) > 0 || toNumber(row.errors) > 0 ? "red" : "green",
            }
          : null,
    })),
    backupRuns: runs.map((row) => ({
      day: String(row.day),
      status: row.status === "failed" ? "failed" : "succeeded",
      count: toNumber(row.count),
    })),
  };
}
