/**
 * Background conversion of the 0.3.4 manifest mirror into versions (0.3.5).
 *
 * Up to 0.3.4 every snapshot copied every object of its mailbox or OneDrive
 * into `manifest_objects`; 0.3.5 keeps `manifest_versions`, where an
 * unchanged object is one row for all the snapshots it is part of
 * (@restow/db manifest-versions.ts). Migration 0033 only creates the new
 * table, so the api starts at once on any database size; this loop folds the
 * old rows in afterwards, one snapshot per transaction, the snapshots of each
 * object oldest first (which is what lets unchanged objects extend instead of
 * being copied), deleting the old rows of a snapshot in the same transaction.
 * The readers include the old rows that are left, so browsing, search,
 * restore and export keep working throughout, and an interrupted conversion
 * simply continues on the next start.
 *
 * The space of the deleted rows goes back to the file system when the old
 * table is empty: the running api truncates it within a quarter of an hour,
 * as its owner (apps/api lib/legacy-manifest-reclaim.ts, which runs
 * @restow/db migrate.ts `reclaimLegacyManifestSpace`, as does the migration
 * step at every api start), and a VACUUM, which autovacuum runs by itself,
 * truncates the empty pages as well.
 *
 * One worker at a time (a session advisory lock on the installation pool);
 * a tick lists the snapshots that still have old rows on the installation
 * pool and converts each in a transaction pinned to its tenant.
 */
import { type Database, convertLegacySnapshot, safeErrorMessage } from "@restow/db";
import { sql } from "drizzle-orm";
import { type WorkerRuntime, withTenantTx } from "./handlers/framework.js";

export interface ManifestConversionDeps {
  readonly db: Database;
  readonly providerDb: Database;
  readonly runtime: Pick<WorkerRuntime, "logger" | "shutdownSignal">;
}

export interface ConversionPassSummary {
  /** Snapshots whose old rows were folded in. */
  readonly snapshots: number;
  /** Old rows folded in (and deleted). */
  readonly rows: number;
  /** Version rows written for them (new versions; unchanged objects only extend). */
  readonly versions: number;
  /** Whether old rows are left (the pass stopped early or failed). */
  readonly remaining: boolean;
}

const LOCK_KEY = 0x6d616e69; // "mani"
const LIST_BATCH = 200;
const PROGRESS_EVERY = 25;
export const CONVERSION_RETRY_MS = 60 * 1000;
const FIRST_TICK_MS = 15 * 1000;

interface PendingSnapshot extends Record<string, unknown> {
  tenant_id: string;
  id: string;
  sequence: number;
}

/** Snapshots that still have old rows, the snapshots of each object oldest first. */
async function pendingSnapshots(providerDb: Database): Promise<PendingSnapshot[]> {
  const result = await providerDb.execute<PendingSnapshot>(sql`
    SELECT s.tenant_id::text AS tenant_id, s.id::text AS id, s.sequence
    FROM snapshots s
    WHERE EXISTS (SELECT 1 FROM manifest_objects l WHERE l.snapshot_id = s.id)
    ORDER BY s.tenant_id, s.protected_object_id, s.sequence
    LIMIT ${LIST_BATCH}
  `);
  return result.rows;
}

/** Convert until nothing is left or the worker shuts down. */
export async function convertLegacyManifests(
  deps: ManifestConversionDeps,
): Promise<ConversionPassSummary> {
  const { logger, shutdownSignal } = deps.runtime;
  let snapshots = 0;
  let rows = 0;
  let versions = 0;
  for (;;) {
    const pending = await pendingSnapshots(deps.providerDb);
    if (pending.length === 0) {
      return { snapshots, rows, versions, remaining: false };
    }
    for (const snapshot of pending) {
      if (shutdownSignal.aborted) {
        return { snapshots, rows, versions, remaining: true };
      }
      const outcome = await withTenantTx(deps.db, snapshot.tenant_id, (tx) =>
        convertLegacySnapshot(tx, snapshot.tenant_id, snapshot.id),
      );
      if (outcome) {
        snapshots += 1;
        rows += outcome.converted;
        versions += outcome.inserted;
        if (snapshots % PROGRESS_EVERY === 0) {
          logger.info("manifest index conversion progress", { snapshots, rows, versions });
        }
      }
    }
  }
}

/** Whether the old table still holds rows (an index probe, cheap at any size). */
async function legacyRowsLeft(providerDb: Database): Promise<boolean> {
  const result = await providerDb.execute<{ remaining: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM snapshots s
      WHERE EXISTS (SELECT 1 FROM manifest_objects l WHERE l.snapshot_id = s.id)
    ) AS remaining
  `);
  return result.rows[0]?.remaining === true;
}

/**
 * Start the conversion loop; returns a stop function. Ticks until no old row
 * is left (then it ends for good), retrying a failed or interrupted pass a
 * minute later.
 */
export function startManifestConversion(
  deps: ManifestConversionDeps,
  options: { firstTickMs?: number; retryMs?: number } = {},
): () => void {
  const { logger, shutdownSignal } = deps.runtime;
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  const schedule = (ms: number) => {
    if (!stopped) {
      timer = setTimeout(() => void tick(), ms);
    }
  };
  const tick = async () => {
    let again = true;
    try {
      if (!(await legacyRowsLeft(deps.providerDb))) {
        again = false;
        return;
      }
      const client = await deps.providerDb.$client.connect();
      try {
        const { rows } = await client.query<{ locked: boolean }>(
          "SELECT pg_try_advisory_lock($1) AS locked",
          [LOCK_KEY],
        );
        if (!rows[0]?.locked) {
          return; // another worker converts
        }
        try {
          logger.info("manifest index conversion started");
          const started = Date.now();
          const summary = await convertLegacyManifests(deps);
          if (!summary.remaining) {
            again = false;
            logger.info("manifest index conversion finished", {
              ...summary,
              seconds: Math.round((Date.now() - started) / 1000),
            });
          }
        } finally {
          await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]);
        }
      } finally {
        client.release();
      }
    } catch (error) {
      logger.error("manifest index conversion failed; retrying", {
        errorMessage: safeErrorMessage(error),
      });
    } finally {
      if (again) {
        schedule(options.retryMs ?? CONVERSION_RETRY_MS);
      }
    }
  };
  schedule(options.firstTickMs ?? FIRST_TICK_MS);
  const stop = () => {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
    }
  };
  shutdownSignal.addEventListener("abort", stop, { once: true });
  return stop;
}
