/**
 * The daily size samples of the capacity page (apps/api features/capacity): once a day and
 * tenant, the bytes of its chunk store (the sum of its packs) and of every restic repository of
 * its machines, file shares and Proxmox VE containers (their `repository_bytes`) are written to
 * `storage_samples`. A restic repository keeps no history of its size, so this is where its
 * growth comes from, from the day the first sample exists; the chunk store gets a series that
 * pruning does not shrink after the fact, as it does the pack dates.
 *
 * Runs with the endpoint monitor, every five minutes, across all tenants that are not being
 * deleted, but a tenant is measured only while it has no `chunk_store` row for today (UTC day),
 * so a pass costs one cheap query on a day that is done. A tenant's rows are written in one
 * transaction, `chunk_store` among them (also with 0 bytes), so a day that has the row has all
 * of the tenant's rows. At most {@link MAX_TENANTS_PER_PASS} tenants are measured per pass; the
 * next pass takes the rest. The rows older than {@link STORAGE_SAMPLE_RETENTION_DAYS} days are
 * removed at the end of every pass.
 */
import {
  endpoints,
  fileShares,
  type NewStorageSampleRow,
  packs,
  pveGuests,
  STORAGE_SAMPLE_RETENTION_DAYS,
  type StorageSampleKind,
  storageSamples,
  tenants,
} from "@restow/db";
import { and, eq, isNotNull, lt, ne, notExists, sql } from "drizzle-orm";
import type { EndpointJobDeps } from "./endpoints/common.js";
import { withTenantTx } from "./handlers/framework.js";
import type { TenantTx } from "./progress.js";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Tenants measured per pass: an installation with many tenants is measured over several passes. */
export const MAX_TENANTS_PER_PASS = 50;

export interface StorageSampleSummary {
  /** Tenants measured in this pass. */
  tenants: number;
  /** Rows written. */
  rows: number;
  /** Rows removed for their age. */
  removed: number;
}

/** The UTC day of a moment, `YYYY-MM-DD`: the day a sample belongs to. */
export function sampleDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** The rows of one tenant for `day`, read inside its pinned transaction. */
export async function measureTenant(
  tx: TenantTx,
  tenantId: string,
  day: string,
): Promise<NewStorageSampleRow[]> {
  const [chunk] = await tx
    .select({ bytes: sql<number>`coalesce(sum(${packs.size}), 0)`.mapWith(Number) })
    .from(packs)
    .where(eq(packs.tenantId, tenantId));
  const rows: NewStorageSampleRow[] = [
    { tenantId, sourceKind: "chunk_store", sourceId: null, day, bytes: chunk?.bytes ?? 0 },
  ];
  // A repository whose size was never measured has no figure yet and no row.
  const repositories: [StorageSampleKind, { id: string; bytes: number | null }[]][] = [
    [
      "endpoint",
      await tx
        .select({ id: endpoints.id, bytes: endpoints.repositoryBytes })
        .from(endpoints)
        .where(and(eq(endpoints.tenantId, tenantId), isNotNull(endpoints.repositoryBytes))),
    ],
    [
      "file_share",
      await tx
        .select({ id: fileShares.id, bytes: fileShares.repositoryBytes })
        .from(fileShares)
        .where(and(eq(fileShares.tenantId, tenantId), isNotNull(fileShares.repositoryBytes))),
    ],
    [
      "pve_guest",
      await tx
        .select({ id: pveGuests.id, bytes: pveGuests.repositoryBytes })
        .from(pveGuests)
        .where(and(eq(pveGuests.tenantId, tenantId), isNotNull(pveGuests.repositoryBytes))),
    ],
  ];
  for (const [sourceKind, sources] of repositories) {
    for (const source of sources) {
      rows.push({
        tenantId,
        sourceKind,
        sourceId: source.id,
        day,
        bytes: Math.max(0, source.bytes ?? 0),
      });
    }
  }
  return rows;
}

/** The tenants that have no sample for `day` yet, the oldest tenants first. */
async function tenantsDue(deps: EndpointJobDeps, day: string, limit: number): Promise<string[]> {
  const rows = await deps.providerDb
    .select({ id: tenants.id })
    .from(tenants)
    .where(
      and(
        ne(tenants.status, "deleting"),
        notExists(
          deps.providerDb
            .select({ one: sql`1` })
            .from(storageSamples)
            .where(
              and(
                eq(storageSamples.tenantId, tenants.id),
                eq(storageSamples.sourceKind, "chunk_store"),
                eq(storageSamples.day, day),
              ),
            ),
        ),
      ),
    )
    .orderBy(tenants.createdAt, tenants.id)
    .limit(limit);
  return rows.map((row) => row.id);
}

/** Measure the tenants that are due and remove the samples past their retention. */
export async function recordStorageSamples(
  deps: EndpointJobDeps,
  now: Date,
  options: { limit?: number } = {},
): Promise<StorageSampleSummary> {
  const { logger } = deps.runtime;
  const day = sampleDay(now);
  const summary: StorageSampleSummary = { tenants: 0, rows: 0, removed: 0 };
  for (const tenantId of await tenantsDue(deps, day, options.limit ?? MAX_TENANTS_PER_PASS)) {
    try {
      const written = await withTenantTx(deps.db, tenantId, async (tx) => {
        const rows = await measureTenant(tx, tenantId, day);
        // A second worker that measured the tenant meanwhile wins; its rows are as good.
        await tx.insert(storageSamples).values(rows).onConflictDoNothing();
        return rows.length;
      });
      summary.tenants++;
      summary.rows += written;
    } catch (error) {
      // One tenant that cannot be read must not keep the others from being measured.
      logger.warn("storage samples of a tenant could not be written", {
        tenantId,
        errorMessage: error instanceof Error ? error.message.slice(0, 300) : String(error),
      });
    }
  }
  const cutoff = sampleDay(new Date(now.getTime() - STORAGE_SAMPLE_RETENTION_DAYS * DAY_MS));
  const removed = await deps.providerDb
    .delete(storageSamples)
    .where(lt(storageSamples.day, cutoff))
    .returning({ id: storageSamples.id });
  summary.removed = removed.length;
  return summary;
}
