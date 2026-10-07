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
 * Legal hold coverage: a tenant-wide hold (no `protected_object_id`) blocks
 * every item; a hold scoped to a mailbox blocks items captured for that
 * mailbox and journal reports assigned to it (archive_item_mailboxes). A hold scoped to a search query (`legal_holds.scope`) is not
 * evaluated here (a known limitation): query-scoped holds need the same
 * search machinery as features/archive/search.ts.
 */
import { archive } from "@restow/core";
import {
  type Database,
  archiveItemMailboxIds,
  archiveItems,
  legalHolds,
  retentionPolicies,
} from "@restow/db";
import { and, eq, lte, sql } from "drizzle-orm";
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

interface HoldScope {
  readonly tenantWide: boolean;
  readonly protectedObjectIds: ReadonlySet<string>;
}

async function loadHolds(providerDb: Database, tenantId: string): Promise<HoldScope> {
  const rows = await providerDb
    .select({ protectedObjectId: legalHolds.protectedObjectId })
    .from(legalHolds)
    .where(and(eq(legalHolds.tenantId, tenantId), eq(legalHolds.active, true)));
  const protectedObjectIds = new Set<string>();
  let tenantWide = false;
  for (const row of rows) {
    if (row.protectedObjectId === null) {
      tenantWide = true;
    } else {
      protectedObjectIds.add(row.protectedObjectId);
    }
  }
  return { tenantWide, protectedObjectIds };
}

/**
 * Whether a hold covers an item: a tenant-wide hold, or a hold on any mailbox
 * the item belongs to (its own, or a journal report's assignments, #32).
 */
function isHeld(mailboxIds: readonly string[], holds: HoldScope): boolean {
  if (holds.tenantWide) {
    return true;
  }
  return mailboxIds.some((id) => holds.protectedObjectIds.has(id));
}

/** The task's own run, separated from {@link createArchiveRetentionTask} so tests can call it directly. */
export async function runArchiveRetention(
  providerDb: Database,
  tenantId: string,
  options: RetentionTaskOptions,
  now: () => Date,
): Promise<ArchiveRetentionSummary> {
  const policy = await loadArchivePolicy(providerDb, tenantId);
  const holds = await loadHolds(providerDb, tenantId);
  const currentTime = now();

  const candidates = await providerDb
    .select({
      id: archiveItems.id,
      itemHash: archiveItems.itemHash,
      chainHash: archiveItems.chainHash,
      mailboxIds: archiveItemMailboxIds,
      retentionUntil: archiveItems.retentionUntil,
    })
    .from(archiveItems)
    .where(and(eq(archiveItems.tenantId, tenantId), lte(archiveItems.retentionUntil, currentTime)));

  let deleted = 0;
  let held = 0;

  for (const item of candidates) {
    const itemHeld = isHeld(item.mailboxIds ?? [], holds);
    if (!archive.isDueForDeletion(item.retentionUntil, itemHeld, currentTime)) {
      if (itemHeld) {
        held++;
      }
      continue;
    }
    if (options.dryRun) {
      deleted++;
      continue;
    }
    await providerDb.transaction(async (tx) => {
      const removed = await tx
        .delete(archiveItems)
        .where(and(eq(archiveItems.id, item.id), eq(archiveItems.tenantId, tenantId)))
        .returning({ id: archiveItems.id });
      if (removed.length === 0) {
        return;
      }
      await appendAuditEntry(tx, {
        tenantId,
        actor: "system",
        action: "archive.item.deleted",
        target: item.id,
        targetType: "archive_item",
        details: {
          itemHash: item.itemHash,
          chainHash: item.chainHash,
          retentionUntil: item.retentionUntil?.toISOString() ?? null,
          policyYears: policy.years,
          policyMode: policy.mode,
        },
      });
    });
    deleted++;
  }
  return {
    policyYears: policy.years,
    policyMode: policy.mode,
    candidates: candidates.length,
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
      const summary = await runArchiveRetention(providerDb, ctx.tenantId, options, ctx.now);
      ctx.logger.info("archive retention run", { task: "archive", ...summary });
      return { ...summary };
    },
  };
}
