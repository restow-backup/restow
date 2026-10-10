import { backupJobMembers, backupJobs, fileShares } from "@restow/db";
import { type SQL, and, eq, sql } from "drizzle-orm";
import type { Transaction } from "../../lib/tenant-context.js";
import type { ResolvedPeriod } from "./period.js";

/**
 * What the statistics read about the file shares (docs/FILESHARES.md 13), from `file_shares`,
 * the share jobs, `file_share_snapshots`, `file_share_reports` and `file_share_runs`. Same
 * contract as collect.ts and guest-facts.ts: read inside the tenant's pinned transaction, the
 * tenant named in every query; the rating itself is pure (share-timeline.ts).
 *
 * A share's restore points live in a restic repository of its own, outside the chunk store, so
 * the storage, deduplication and largest-object figures stay as they are. What the shares add:
 *
 *   - the readiness series and the protected count (like the guests);
 *   - the backup outcomes (a backup "with warnings" went through: it counts as succeeded, as an
 *     agent backup that ended partial does);
 *   - the restores (a restore run, a scheduled copy included: a copy is a restore run);
 *   - the volume: what a backup covered (`bytes`) and what it added to its repository
 *     (`bytes_added`).
 *
 * Which shares count is decided by today's facts, as for the guests: a share that is not
 * retired, in an enabled share job now or with a restore point at the moment.
 */

export interface ShareRow {
  readonly id: string;
  readonly createdAt: Date;
  /** In an enabled share job now; one out of every job counts with a restore point only. */
  readonly inJob: boolean;
}

/** A restore point of a share, as far as readiness needs it. */
export interface ShareRestorePoint {
  readonly shareId: string;
  readonly sequence: number;
  readonly at: Date;
  readonly prunedAt: Date | null;
  /** The restore checks of it (the server's reports), oldest first. */
  readonly checks: readonly ShareCheck[];
}

export interface ShareCheck {
  readonly at: Date;
  readonly readiness: "green" | "yellow" | "red";
}

export interface ShareFacts {
  readonly list: readonly ShareRow[];
  /** The restore points kept at the start of the period or made during it. */
  readonly restorePoints: readonly ShareRestorePoint[];
  /** Finished backup runs per UTC day of `finished_at` over the previous and the current period. */
  readonly backupRuns: readonly {
    readonly day: string;
    readonly status: "succeeded" | "failed" | "cancelled";
    readonly count: number;
  }[];
  /** Finished restore and copy runs per UTC day over the previous and the current period. */
  readonly restoreRuns: readonly {
    readonly day: string;
    readonly status: "completed" | "failed";
    readonly count: number;
  }[];
  /** What the restore points made per UTC day of the current period covered and added. */
  readonly volume: readonly {
    readonly day: string;
    readonly bytes: number;
    readonly bytesAdded: number;
  }[];
}

/** A tenant without file shares. */
export const NO_SHARE_FACTS: ShareFacts = {
  list: [],
  restorePoints: [],
  backupRuns: [],
  restoreRuns: [],
  volume: [],
};

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

/** The backup outcome of a share run's status, as the statistics count it. */
export function shareBackupStatus(status: string): "succeeded" | "failed" | "cancelled" | null {
  switch (status) {
    case "succeeded":
    case "warning":
      return "succeeded";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    default:
      return null;
  }
}

/** Everything the statistics need about the tenant's shares for `period`. Six queries. */
export async function collectShareFacts(
  tx: Transaction,
  tenantId: string,
  period: ResolvedPeriod,
): Promise<ShareFacts> {
  const { start, end } = period.current;
  const since = period.previous.start;

  const shares = await tx
    .select({ id: fileShares.id, createdAt: fileShares.createdAt })
    .from(fileShares)
    .where(and(eq(fileShares.tenantId, tenantId), sql`${fileShares.retiredAt} is null`));
  if (shares.length === 0) {
    return NO_SHARE_FACTS;
  }
  const protectedRows = await tx
    .selectDistinct({ id: backupJobMembers.fileShareId })
    .from(backupJobMembers)
    .innerJoin(backupJobs, eq(backupJobs.id, backupJobMembers.jobId))
    .where(
      and(
        eq(backupJobMembers.tenantId, tenantId),
        eq(backupJobs.kind, "share"),
        eq(backupJobs.enabled, true),
      ),
    );
  const inJob = new Set(protectedRows.flatMap((row) => (row.id ? [row.id] : [])));

  const points = await rows(
    tx,
    sql`
      select s.file_share_id, s.sequence, s.snapshot_time, s.pruned_at, s.restic_snapshot_id
      from file_share_snapshots as s
      where s.tenant_id = ${tenantId} and s.snapshot_time < ${end}
        and (s.pruned_at is null or s.pruned_at >= ${start})`,
  );
  const checks = await rows(
    tx,
    sql`
      select r.file_share_id, r.snapshot_id, r.readiness::text as readiness, r.checked_at
      from file_share_reports as r
      where r.tenant_id = ${tenantId} and r.kind = 'restore_test'
        and r.readiness is not null and r.snapshot_id is not null and r.checked_at < ${end}
      order by r.checked_at`,
  );
  const checksOf = new Map<string, ShareCheck[]>();
  for (const row of checks) {
    const key = `${String(row.file_share_id)}:${String(row.snapshot_id)}`;
    const list = checksOf.get(key) ?? [];
    list.push({
      at: toDate(row.checked_at),
      readiness: row.readiness === "red" ? "red" : row.readiness === "yellow" ? "yellow" : "green",
    });
    checksOf.set(key, list);
  }

  const finishedDay = sql`to_char(r.finished_at at time zone 'UTC', 'YYYY-MM-DD')`;
  const backups = await rows(
    tx,
    sql`
      select ${finishedDay} as day, r.status, count(*)::int as count
      from file_share_runs as r
      where r.tenant_id = ${tenantId} and r.kind = 'backup'
        and r.status in ('succeeded', 'warning', 'failed', 'cancelled')
        and r.finished_at >= ${since} and r.finished_at < ${end}
      group by 1, 2`,
  );
  const restores = await rows(
    tx,
    sql`
      select ${finishedDay} as day, r.status, count(*)::int as count
      from file_share_runs as r
      where r.tenant_id = ${tenantId} and r.kind = 'restore'
        and r.status in ('succeeded', 'warning', 'failed')
        and r.finished_at >= ${since} and r.finished_at < ${end}
      group by 1, 2`,
  );
  const volume = await rows(
    tx,
    sql`
      select to_char(s.snapshot_time at time zone 'UTC', 'YYYY-MM-DD') as day,
        sum(s.bytes)::float8 as bytes, sum(s.bytes_added)::float8 as bytes_added
      from file_share_snapshots as s
      where s.tenant_id = ${tenantId} and s.snapshot_time >= ${start} and s.snapshot_time < ${end}
      group by 1`,
  );

  const backupRuns: ShareFacts["backupRuns"][number][] = [];
  for (const row of backups) {
    const status = shareBackupStatus(String(row.status));
    if (status) {
      backupRuns.push({ day: String(row.day), status, count: toNumber(row.count) });
    }
  }
  return {
    list: shares.map((share) => ({
      id: share.id,
      createdAt: share.createdAt,
      inJob: inJob.has(share.id),
    })),
    restorePoints: points.map((row) => {
      const shareId = String(row.file_share_id);
      return {
        shareId,
        sequence: toNumber(row.sequence),
        at: toDate(row.snapshot_time),
        prunedAt:
          row.pruned_at === null || row.pruned_at === undefined ? null : toDate(row.pruned_at),
        checks: checksOf.get(`${shareId}:${String(row.restic_snapshot_id)}`) ?? [],
      };
    }),
    backupRuns,
    restoreRuns: restores.map((row) => ({
      day: String(row.day),
      status: row.status === "failed" ? "failed" : "completed",
      count: toNumber(row.count),
    })),
    volume: volume.map((row) => ({
      day: String(row.day),
      bytes: toNumber(row.bytes),
      bytesAdded: toNumber(row.bytes_added),
    })),
  };
}
