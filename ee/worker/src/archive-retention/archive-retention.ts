/**
 * The archive's deletion run (docs/ARCHIVE.md, retention and deletion):
 * daily, tenant-wide, removes only archive items
 * whose retention period has ended and that are not under legal hold, and
 * writes every deletion to the audit log. Never touches an item under hold,
 * regardless of how far past its retention date it is (@restow/core
 * archive/retention.ts `isDueForDeletion`).
 *
 * Registered into the shared `retentionTasks` registry (./retention.ts), so
 * the existing `retention` queue (one job per tenant, enqueued by the
 * scheduler) carries it alongside snapshot expiry — see index.ts, where this
 * task is added at startup.
 *
 * Deletion only ever runs on the installation database pool: a trigger
 * (packages/db/sql/rls.sql) makes `archive_items` append-only for the tenant
 * role (UPDATE is forbidden for both roles, DELETE is revoked from the
 * tenant role — packages/db/src/roles.ts), so only the installation role may
 * remove a row. `createArchiveRetentionTask`'s `providerDb` parameter must
 * always be the installation pool; passing the tenant pool here would make
 * every deletion fail with a permission error (and, per the fallback in
 * {@link runArchiveRetention}, the run reports it as a failed item rather
 * than crashing the whole retention job).
 *
 * Batches (0.5.0): due items are read in pages of {@link ARCHIVE_RETENTION_BATCH} in
 * (retention_until, id) order and each page is deleted in one transaction, with the legal
 * hold check inside the DELETE statement and the audit entries in the same transaction.
 * Before, the run read the holds and every due item of the tenant once (a whole capture year
 * under end_of_year) and then deleted item by item: a hold placed meanwhile did not stop it.
 * The job's signal is checked between batches.
 *
 * Chain (0.5.0): every deleted row leaves a tombstone in `archive_chain_tombstones`, written
 * by the same statement as the delete, so the chain check (apps/api features/archive
 * verify.ts) still links the next entry and counts the position; a gap without a tombstone
 * remains tampering.
 *
 * Legal hold coverage: a tenant-wide hold (no `protected_object_id`) blocks
 * every item; a hold scoped to a mailbox blocks items captured for that
 * mailbox and journal reports assigned to it (archive_item_mailboxes). A hold scoped to a search query (`legal_holds.scope`) is not
 * evaluated here (a known limitation): query-scoped holds need the same
 * search machinery as features/archive/search.ts.
 */
import { type archive, JobAbortedError } from "@restow/core";
import {
  archiveChainTombstones,
  archiveItems,
  type Database,
  legalHolds,
  retentionPolicies,
} from "@restow/db";
import { and, asc, count, eq, inArray, lte, type SQL, sql } from "drizzle-orm";
import { appendAuditEntry } from "../../../../apps/worker/src/audit.js";
import type { WorkerJobContext } from "../../../../apps/worker/src/handlers/framework.js";
import type {
  RetentionTask,
  RetentionTaskOptions,
} from "../../../../apps/worker/src/handlers/retention.js";
import { installationHasCapability } from "../../../licensing/src/index.js";

export interface ArchiveRetentionSummary {
  readonly policyYears: number | null;
  readonly policyMode: string;
  readonly candidates: number;
  readonly deleted: number;
  readonly held: number;
  readonly dryRun: boolean;
}

const DEFAULT_ARCHIVE_POLICY: archive.RetentionPolicy = { mode: "end_of_year", years: 8 };

async function loadArchivePolicy(
  providerDb: Database,
  tenantId: string,
): Promise<archive.RetentionPolicy> {
  const [row] = await providerDb
    .select({ years: retentionPolicies.years, mode: retentionPolicies.mode })
    .from(retentionPolicies)
    .where(
      and(
        eq(retentionPolicies.tenantId, tenantId),
        sql`${retentionPolicies.appliesTo}->>'target' = 'archive'`,
      ),
    )
    .limit(1);
  return row
    ? { mode: row.mode, years: row.years as archive.RetentionPolicy["years"] }
    : DEFAULT_ARCHIVE_POLICY;
}

/** Due items read and deleted per transaction. */
export const ARCHIVE_RETENTION_BATCH = 500;

export interface ArchiveRetentionRunOptions {
  /** Checked between batches: a cancelled job stops after the batch it is in. */
  readonly signal?: AbortSignal;
  /** Due items per batch (tests); default {@link ARCHIVE_RETENTION_BATCH}. */
  readonly batchSize?: number;
  /** Called after each batch committed (tests). */
  readonly afterBatch?: () => Promise<void>;
}

/** One deleted row, as the DELETE returned it. */
type DeletedRow = {
  readonly id: string;
  readonly item_hash: string;
  readonly chain_hash: string;
  readonly prev_chain_hash: string | null;
  readonly received_at: string;
  readonly created_at: string;
  readonly retention_until: string | null;
  readonly storage_path: string;
  readonly chunks: string[] | null;
};

/**
 * The legal-hold predicate, inside the statement that deletes: a hold placed while the run is
 * going covers every item the run has not reached yet, never a stale list read at its start.
 * A tenant-wide hold (no mailbox) covers every item; a mailbox hold the items of that mailbox,
 * their own (`protected_object_id`) and assigned ones (archive_item_mailboxes, #32).
 */
function notHeld(tenantId: string): SQL {
  return sql`not exists (
    select 1 from ${legalHolds} h
     where h.tenant_id = ${tenantId}::uuid
       and h.active
       and (
         h.protected_object_id is null
         or h.protected_object_id = archive_items.protected_object_id
         or h.protected_object_id in (
           select aim.protected_object_id from archive_item_mailboxes aim
            where aim.archive_item_id = archive_items.id
         )
       )
  )`;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new JobAbortedError();
  }
}

/** The task's own run, separated from {@link createArchiveRetentionTask} so tests can call it directly. */
export async function runArchiveRetention(
  providerDb: Database,
  tenantId: string,
  options: RetentionTaskOptions,
  now: () => Date,
  run: ArchiveRetentionRunOptions = {},
): Promise<ArchiveRetentionSummary> {
  const policy = await loadArchivePolicy(providerDb, tenantId);
  const currentTime = now();
  const batchSize = Math.max(1, run.batchSize ?? ARCHIVE_RETENTION_BATCH);

  let candidates = 0;
  let deleted = 0;
  let held = 0;
  // Keyset over (retention_until, id): an item kept (held) is never read again in this run,
  // and every page is an index range (archive_items_tenant_retention_idx).
  let after: { retentionUntil: string; id: string } | null = null;

  for (;;) {
    throwIfAborted(run.signal);
    const page: { id: string; retentionUntil: string }[] = await providerDb
      .select({
        id: archiveItems.id,
        retentionUntil: sql<string>`${archiveItems.retentionUntil}::text`,
      })
      .from(archiveItems)
      .where(
        and(
          eq(archiveItems.tenantId, tenantId),
          lte(archiveItems.retentionUntil, currentTime),
          after
            ? sql`(${archiveItems.retentionUntil}, ${archiveItems.id}) > (${after.retentionUntil}::timestamptz, ${after.id}::uuid)`
            : undefined,
        ),
      )
      .orderBy(asc(archiveItems.retentionUntil), asc(archiveItems.id))
      .limit(batchSize);
    const last = page[page.length - 1];
    if (!last) {
      break;
    }
    after = { retentionUntil: last.retentionUntil, id: last.id };
    candidates += page.length;
    const ids = page.map((row) => row.id);

    if (options.dryRun) {
      const [free] = await providerDb
        .select({ value: count() })
        .from(archiveItems)
        .where(
          and(
            eq(archiveItems.tenantId, tenantId),
            inArray(archiveItems.id, ids),
            notHeld(tenantId),
          ),
        );
      deleted += free?.value ?? 0;
      held += page.length - (free?.value ?? 0);
    } else {
      const removed = await providerDb.transaction(async (tx) => {
        // The row goes, its chain link stays: a tombstone per deleted row, in the same
        // statement (and so at the same full timestamp precision) as the delete.
        const rows = await tx.execute<DeletedRow>(sql`
          with deleted as (
            delete from ${archiveItems}
             where ${archiveItems.tenantId} = ${tenantId}::uuid
               and ${inArray(archiveItems.id, ids)}
               and ${archiveItems.retentionUntil} <= ${currentTime.toISOString()}::timestamptz
               and ${notHeld(tenantId)}
            returning id, tenant_id, item_hash, chain_hash, prev_chain_hash, received_at,
                      created_at, retention_until, storage_path, chunks
          ), tombstones as (
            insert into ${archiveChainTombstones}
              (tenant_id, item_id, item_hash, prev_chain_hash, chain_hash, received_at,
               item_created_at, retention_until, deleted_at)
            select tenant_id, id, item_hash, prev_chain_hash, chain_hash, received_at,
                   created_at, retention_until, ${currentTime.toISOString()}::timestamptz
              from deleted
          )
          select id, item_hash, chain_hash, prev_chain_hash, received_at::text,
                 created_at::text, retention_until::text, storage_path, chunks
            from deleted`);
        for (const row of rows.rows) {
          await appendAuditEntry(tx, {
            tenantId,
            actor: "system",
            action: "archive.item.deleted",
            target: row.id,
            targetType: "archive_item",
            details: {
              itemHash: row.item_hash,
              chainHash: row.chain_hash,
              retentionUntil: row.retention_until
                ? new Date(row.retention_until).toISOString()
                : null,
              policyYears: policy.years,
              policyMode: policy.mode,
            },
          });
        }
        return rows.rows;
      });
      deleted += removed.length;
      // Not returned: a hold covers it (checked in the DELETE itself), or it is already gone.
      held += page.length - removed.length;
    }
    await run.afterBatch?.();
    if (page.length < batchSize) {
      break;
    }
  }
  return {
    policyYears: policy.years,
    policyMode: policy.mode,
    candidates,
    deleted,
    held,
    dryRun: options.dryRun,
  };
}

/**
 * The archive deletion run, registered into the shared retention task
 * registry (see index.ts). Enforced archive retention is a Business/Service
 * Provider capability (`archive.retentionEnforcement`,
 * ee/licensing/src/capabilities.ts); a Community installation still
 * captures and searches the archive, it just never deletes anything from it
 * on a schedule. Gated here rather than at the queue level so the check
 * always reflects the edition in effect at run time, including a license key
 * installed after the worker started.
 */
export function createArchiveRetentionTask(providerDb: Database): RetentionTask {
  return {
    name: "archive",
    async run(
      ctx: WorkerJobContext,
      options: RetentionTaskOptions,
    ): Promise<Record<string, unknown>> {
      if (!(await installationHasCapability(providerDb, "archive.retentionEnforcement"))) {
        ctx.logger.info("archive retention run skipped: edition has no retention enforcement", {
          task: "archive",
        });
        return { skipped: true, reason: "edition_required" };
      }
      const summary = await runArchiveRetention(providerDb, ctx.tenantId, options, ctx.now, {
        signal: ctx.signal,
      });
      ctx.logger.info("archive retention run", { task: "archive", ...summary });
      return { ...summary };
    },
  };
}
