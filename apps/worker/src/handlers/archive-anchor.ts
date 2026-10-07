/**
 * Daily anchors of the archive hash chain (docs/ARCHIVE.md; @restow/core
 * archive/chain.ts `DailyAnchor`).
 *
 * Once a UTC day is over, every tenant whose archive grew that day gets an
 * `archive_anchor` row: the chain hash of the last entry appended that day
 * and the number of entries the chain had by then, counted from its start.
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
  type Database,
  type NewArchiveAnchor,
  archiveAnchor,
  archiveItems,
  safeErrorMessage,
  tenants,
} from "@restow/db";
import { and, asc, count, desc, eq, gte, lt, sql } from "drizzle-orm";
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

    const day = sql<string>`to_char(${archiveItems.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`;
    const days = await tx
      .select({ day })
      .from(archiveItems)
      .where(
        and(
          eq(archiveItems.tenantId, tenantId),
          since ? gte(archiveItems.createdAt, since) : undefined,
          lt(archiveItems.createdAt, before),
        ),
      )
      .groupBy(day)
      .orderBy(day);

    const anchors: NewArchiveAnchor[] = [];
    for (const { day: anchorDate } of days) {
      const end = dayAfter(anchorDate);
      const ofChainUntilEnd = and(
        eq(archiveItems.tenantId, tenantId),
        lt(archiveItems.createdAt, end),
      );
      const [total] = await tx.select({ value: count() }).from(archiveItems).where(ofChainUntilEnd);
      const [last] = await tx
        .select({ chainHash: archiveItems.chainHash })
        .from(archiveItems)
        .where(ofChainUntilEnd)
        .orderBy(desc(archiveItems.createdAt), desc(archiveItems.id))
        .limit(1);
      if (last && total) {
        anchors.push({ tenantId, anchorDate, lastHash: last.chainHash, count: total.value });
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
