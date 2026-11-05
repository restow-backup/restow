/**
 * Daily anchors of the archive hash chain (docs/ARCHIVE.md; @restow/core
 * archive/chain.ts `DailyAnchor`).
 *
 * Once a UTC day is over, every tenant whose archive grew that day gets an
 * `archive_anchor` row: the chain hash of the last entry appended that day
 * and the number of entries the chain had by then, counted from its start
 * (tombstones of items deleted after their retention included, so a deletion
 * never shifts the positions anchors name).
 * The archive check (apps/api features/archive/verify.ts) compares the chain
 * against these seals, which is what exposes entries cut off the end of the
 * chain: every remaining link still verifies, but the chain no longer
 * reaches an anchor. Anchors are append-only (packages/db/sql/rls.sql), and
 * each one is also written to the worker log, a copy outside the database.
 *
 * Runs with the audit anchors (./audit-anchor.ts), in the same nightly run:
 * idempotent, catches up on every day since the tenant's last anchor, never
 * seals the running day. Append order is `created_at` order, the order the
 * archive catalog links entries in (apps/api features/archive/catalog.ts).
 */
import {
  archiveAnchor,
  archiveChainTombstones,
  archiveItems,
  type Database,
  type NewArchiveAnchor,
  safeErrorMessage,
  tenants,
} from "@restow/db";
import { asc, desc, eq, sql } from "drizzle-orm";
import { type AnchorLogger, dayAfter, startOfUtcDay } from "./audit-anchor.js";

export interface ArchiveAnchorDeps {
  readonly db: Database;
  readonly logger: AnchorLogger;
  readonly now?: () => Date;
}

export interface ArchiveAnchorRunSummary {
  readonly tenants: number;
  readonly anchorsWritten: number;
  readonly failedTenants: number;
}

export class ArchiveAnchorRunError extends Error {
  readonly summary: ArchiveAnchorRunSummary;

  constructor(summary: ArchiveAnchorRunSummary) {
    super(`archive anchors missing for ${summary.failedTenants} of ${summary.tenants} tenants`);
    this.name = "ArchiveAnchorRunError";
    this.summary = summary;
  }
}

/** Advisory lock serializing anchor writes per tenant archive. */
export function archiveAnchorLockKey(tenantId: string): string {
  return `restow.archive-anchor:${tenantId}`;
}

/** Seal every complete, unsealed day of one tenant's archive chain before `before` (a UTC midnight). */
export async function anchorArchiveChain(
  db: Database,
  tenantId: string,
  before: Date,
): Promise<NewArchiveAnchor[]> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${archiveAnchorLockKey(tenantId)}))`,
    );

    const [latest] = await tx
      .select({ date: archiveAnchor.anchorDate })
      .from(archiveAnchor)
      .where(eq(archiveAnchor.tenantId, tenantId))
      .orderBy(desc(archiveAnchor.anchorDate))
      .limit(1);
    const since = latest ? dayAfter(latest.date) : null;

    // The chain is the items plus the tombstones of items deleted after their retention
    // (archive_chain_tombstones): a deletion keeps the positions, so anchors count both.
    const days = await tx.execute<{ day: string }>(sql`
      select day from (
        select to_char(created_at at time zone 'UTC', 'YYYY-MM-DD') as day
          from ${archiveItems}
         where tenant_id = ${tenantId}::uuid
           ${since ? sql`and created_at >= ${since.toISOString()}::timestamptz` : sql``}
           and created_at < ${before.toISOString()}::timestamptz
        union
        select to_char(item_created_at at time zone 'UTC', 'YYYY-MM-DD')
          from ${archiveChainTombstones}
         where tenant_id = ${tenantId}::uuid
           ${since ? sql`and item_created_at >= ${since.toISOString()}::timestamptz` : sql``}
           and item_created_at < ${before.toISOString()}::timestamptz
      ) days
      order by day`);

    const anchors: NewArchiveAnchor[] = [];
    for (const { day: anchorDate } of days.rows) {
      const end = dayAfter(anchorDate).toISOString();
      const result = await tx.execute<{ count: number; chain_hash: string | null }>(sql`
        with chain as (
          select chain_hash, created_at, id from ${archiveItems}
           where tenant_id = ${tenantId}::uuid and created_at < ${end}::timestamptz
          union all
          select chain_hash, item_created_at, item_id from ${archiveChainTombstones}
           where tenant_id = ${tenantId}::uuid and item_created_at < ${end}::timestamptz
        )
        select (select count(*)::int from chain) as count,
               (select chain_hash from chain order by created_at desc, id desc limit 1) as chain_hash`);
      const row = result.rows[0];
      if (row?.chain_hash && row.count > 0) {
        anchors.push({ tenantId, anchorDate, lastHash: row.chain_hash, count: row.count });
      }
    }
    if (anchors.length > 0) {
      await tx.insert(archiveAnchor).values(anchors);
    }
    return anchors;
  });
}

/** Seal the finished days of every tenant's archive chain. Throws after trying all if any failed. */
export async function writeArchiveAnchors(
  deps: ArchiveAnchorDeps,
): Promise<ArchiveAnchorRunSummary> {
  const before = startOfUtcDay((deps.now ?? (() => new Date()))());
  const tenantRows = await deps.db
    .select({ id: tenants.id })
    .from(tenants)
    .orderBy(asc(tenants.createdAt), asc(tenants.id));

  let anchorsWritten = 0;
  let failedTenants = 0;
  for (const { id: tenantId } of tenantRows) {
    try {
      const written = await anchorArchiveChain(deps.db, tenantId, before);
      anchorsWritten += written.length;
      for (const anchor of written) {
        deps.logger.info("archive chain anchored", {
          tenantId,
          anchorDate: anchor.anchorDate,
          lastHash: anchor.lastHash,
          count: anchor.count,
        });
      }
    } catch (error) {
      failedTenants += 1;
      deps.logger.error("archive chain anchoring failed", {
        tenantId,
        errorMessage: safeErrorMessage(error),
      });
    }
  }
  const summary = { tenants: tenantRows.length, anchorsWritten, failedTenants };
  if (failedTenants > 0) {
    throw new ArchiveAnchorRunError(summary);
  }
  return summary;
}
