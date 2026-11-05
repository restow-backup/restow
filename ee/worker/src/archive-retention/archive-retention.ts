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
 * What a deletion removes (0.5.0): the row (with its mailbox assignments and further captures,
 * by cascade), exactly the chunk references the writer took for it (released in the same
 * transaction; garbage collection reclaims what nothing else references), and its sealed
 * record on the primary and every copy (queued in `archive_record_deletions` in that
 * transaction, deleted right after; a target that refuses keeps it queued for the next run).
 * Before, only the row went: the message stayed rebuildable from storage and never freed.
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
import {
  type archive,
  isObjectNotFound,
  JobAbortedError,
  lockedErrorOf,
  type StorageTargets,
} from "@restow/core";
import {
  archiveChainTombstones,
  archiveItems,
  archiveRecordDeletions,
  chunks,
  type Database,
  legalHolds,
  retentionPolicies,
  safeErrorMessage,
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
  /** Item rows deleted (with their tombstone and audit entry). */
  readonly deleted: number;
  readonly held: number;
  /** Chunk references the deleted items held, released (garbage collection decides). */
  readonly chunkReferencesReleased: number;
  /** Sealed records deleted on every target (this run's and earlier runs' queued ones). */
  readonly recordsDeleted: number;
  /** Sealed records a target refused (Object Lock, outage): queued for the next run. */
  readonly recordsDeferred: number;
  /** Sealed records still queued after the run (deferred, or no storage given). */
  readonly recordsPending: number;
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
  /**
   * The tenant's targets: the sealed records of deleted items are removed from the primary
   * and every copy. Without it the records stay queued (counted as pending).
   */
  readonly storage?: StorageTargets;
}

/** Chunk ids per reference update. */
const RELEASE_BATCH = 1000;

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
  let referencesReleased = 0;
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
        // Exactly the references the writer took for these items (one per chunk occurrence,
        // archive/writer.ts), in this transaction: a row deleted releases them once, a row kept
        // never. Chunks shared with a backup or another item keep theirs; garbage collection
        // decides after its grace period.
        const references = rows.rows.flatMap((row) => row.chunks ?? []);
        await releaseChunkReferences(tx, tenantId, references);
        // The sealed record goes from storage after the commit; until then it is queued.
        if (rows.rows.length > 0) {
          await tx
            .insert(archiveRecordDeletions)
            .values(
              rows.rows.map((row) => ({ tenantId, itemId: row.id, storagePath: row.storage_path })),
            )
            .onConflictDoNothing();
        }
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
              deleted: {
                row: true,
                chunkReferencesReleased: row.chunks?.length ?? 0,
                // Deleted on every target right after this commit; a refusal is audited
                // (archive.record.deletion_deferred) and retried by the next run.
                sealedRecord: "queued",
                storagePath: row.storage_path,
              },
            },
          });
        }
        return { rows: rows.rows, references: references.length };
      });
      deleted += removed.rows.length;
      referencesReleased += removed.references;
      // Not returned: a hold covers it (checked in the DELETE itself), or it is already gone.
      held += page.length - removed.rows.length;
    }
    await run.afterBatch?.();
    if (page.length < batchSize) {
      break;
    }
  }
  // The sealed records of this run's deletions, and of earlier runs a target refused.
  const records = options.dryRun
    ? { deleted: 0, deferred: 0, pending: 0 }
    : run.storage
      ? await deleteQueuedRecords(providerDb, tenantId, run.storage, run)
      : { deleted: 0, deferred: 0, pending: await queuedRecordCount(providerDb, tenantId) };
  return {
    policyYears: policy.years,
    policyMode: policy.mode,
    candidates,
    deleted,
    held,
    chunkReferencesReleased: referencesReleased,
    recordsDeleted: records.deleted,
    recordsDeferred: records.deferred,
    recordsPending: records.pending,
    dryRun: options.dryRun,
  };
}

/** Decrement each chunk's refcount once per occurrence in `storedIds` (never below zero). */
async function releaseChunkReferences(
  tx: Parameters<Parameters<Database["transaction"]>[0]>[0],
  tenantId: string,
  storedIds: readonly string[],
): Promise<void> {
  const counts = new Map<string, number>();
  for (const id of storedIds) {
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const entries = [...counts];
  for (let i = 0; i < entries.length; i += RELEASE_BATCH) {
    const values = sql.join(
      entries.slice(i, i + RELEASE_BATCH).map(([id, n]) => sql`(${id}::text, ${n}::int)`),
      sql`, `,
    );
    await tx.execute(sql`
      update ${chunks} as c
         set refcount = greatest(0, c.refcount - v.n), updated_at = now()
        from (values ${values}) as v(stored_id, n)
       where c.tenant_id = ${tenantId}::uuid and c.stored_id = v.stored_id`);
  }
}

async function queuedRecordCount(providerDb: Database, tenantId: string): Promise<number> {
  const [row] = await providerDb
    .select({ value: count() })
    .from(archiveRecordDeletions)
    .where(eq(archiveRecordDeletions.tenantId, tenantId));
  return row?.value ?? 0;
}

/**
 * Delete the queued sealed records from the primary and every copy (a record already gone
 * counts as deleted). A target that refuses keeps the record queued, with its attempts and
 * error, for the next run: counted as deferred and audited once, never reported as deleted.
 * A retired (`previous`) location is never written to, and so keeps its copy until it is
 * removed (docs/ARCHIVE.md "Löschkonzept").
 */
async function deleteQueuedRecords(
  providerDb: Database,
  tenantId: string,
  storage: StorageTargets,
  run: ArchiveRetentionRunOptions,
): Promise<{ deleted: number; deferred: number; pending: number }> {
  const targets = [storage.primary, ...storage.copies];
  let deleted = 0;
  let deferred = 0;
  let after: { createdAt: string; id: string } | null = null;
  for (;;) {
    throwIfAborted(run.signal);
    const page: {
      id: string;
      itemId: string;
      storagePath: string;
      attempts: number;
      createdAt: string;
    }[] = await providerDb
      .select({
        id: archiveRecordDeletions.id,
        itemId: archiveRecordDeletions.itemId,
        storagePath: archiveRecordDeletions.storagePath,
        attempts: archiveRecordDeletions.attempts,
        createdAt: sql<string>`${archiveRecordDeletions.createdAt}::text`,
      })
      .from(archiveRecordDeletions)
      .where(
        and(
          eq(archiveRecordDeletions.tenantId, tenantId),
          after
            ? sql`(${archiveRecordDeletions.createdAt}, ${archiveRecordDeletions.id}) > (${after.createdAt}::timestamptz, ${after.id}::uuid)`
            : undefined,
        ),
      )
      .orderBy(asc(archiveRecordDeletions.createdAt), asc(archiveRecordDeletions.id))
      .limit(ARCHIVE_RETENTION_BATCH);
    const last = page[page.length - 1];
    if (!last) {
      break;
    }
    after = { createdAt: last.createdAt, id: last.id };
    const done: { id: string; itemId: string }[] = [];
    const refused: {
      id: string;
      itemId: string;
      storagePath: string;
      attempts: number;
      error: string;
    }[] = [];
    for (const entry of page) {
      const problems: string[] = [];
      for (const [index, target] of targets.entries()) {
        try {
          await target.delete(entry.storagePath);
        } catch (error) {
          if (isObjectNotFound(error)) {
            continue;
          }
          const locked = lockedErrorOf(error);
          problems.push(
            `${index === 0 ? "primary" : `copy ${index}`}: ${
              locked
                ? `locked${locked.retainUntil ? ` until ${locked.retainUntil.toISOString()}` : ""}`
                : safeErrorMessage(error)
            }`,
          );
        }
      }
      if (problems.length === 0) {
        done.push(entry);
      } else {
        refused.push({ ...entry, error: problems.join("; ") });
      }
    }
    await providerDb.transaction(async (tx) => {
      if (done.length > 0) {
        await tx.delete(archiveRecordDeletions).where(
          inArray(
            archiveRecordDeletions.id,
            done.map((entry) => entry.id),
          ),
        );
        await appendAuditEntry(tx, {
          tenantId,
          actor: "system",
          action: "archive.records.deleted",
          target: null,
          targetType: "archive_item",
          details: { items: done.map((entry) => entry.itemId), targets: targets.length },
        });
      }
      for (const entry of refused) {
        await tx
          .update(archiveRecordDeletions)
          .set({ attempts: entry.attempts + 1, lastError: entry.error, updatedAt: new Date() })
          .where(eq(archiveRecordDeletions.id, entry.id));
        if (entry.attempts === 0) {
          await appendAuditEntry(tx, {
            tenantId,
            actor: "system",
            action: "archive.record.deletion_deferred",
            target: entry.itemId,
            targetType: "archive_item",
            details: { storagePath: entry.storagePath, error: entry.error },
          });
        }
      }
    });
    deleted += done.length;
    deferred += refused.length;
    if (page.length < ARCHIVE_RETENTION_BATCH) {
      break;
    }
  }
  return { deleted, deferred, pending: deferred };
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
        storage: ctx.storage,
      });
      if (summary.recordsDeferred > 0) {
        ctx.logger.warn("archive records not deleted on every target; queued for the next run", {
          task: "archive",
          records: summary.recordsDeferred,
        });
      }
      ctx.logger.info("archive retention run", { task: "archive", ...summary });
      return { ...summary };
    },
  };
}
