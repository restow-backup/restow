import {
  type BackupOutcome,
  type LatestBackupFact,
  UNKNOWN_WARNING_CAUSE,
  type WarningAckFact,
  type WarningEvaluation,
  classifyRunError,
  evaluateWarning,
  isInterruptedOnly,
  normalizeCauses,
  shareWarningCauses,
} from "@restow/core";
import {
  type EndpointRunError,
  type ItemFailureSummaryJson,
  type WarningAcknowledgement,
  endpointRuns,
  endpoints,
  fileShareRuns,
  fileShares,
  itemFailures,
  jobProgress,
  jobs,
  protectedObjects,
  warningAcknowledgements,
} from "@restow/db";
import { and, count, desc, eq, gt, inArray, isNotNull, sql } from "drizzle-orm";
import type { Transaction } from "../../lib/tenant-context.js";

/**
 * The warning state of protected objects and machines, read in one place for every reader (the
 * status summary, the start page, the directory, the backup jobs and the warnings page): the
 * newest finished backup run, the causes of its failed items, the acknowledgement, and whether a
 * run failed outright since it was given. The rule itself is packages/core
 * (failures/warnings.ts); this file only gathers the facts, a bounded number of queries for any
 * number of objects.
 */

/** `share`: a file share (docs/FILESHARES.md 13): its backups end "with warnings" by item causes. */
export type WarningTargetKind = "object" | "machine" | "share";

export interface WarningFact {
  kind: WarningTargetKind;
  id: string;
  latest: LatestBackupFact | null;
  /** Failed items per cause of the newest finished run (exact, also beyond the stored rows). */
  causeCounts: Record<string, number>;
  ack: WarningAcknowledgement | null;
  failedSinceAck: boolean;
  evaluation: WarningEvaluation;
}

export interface WarningScope {
  /** Only these objects (or machines); absent: every active one of the tenant. */
  ids?: readonly string[];
}

function ackFact(row: WarningAcknowledgement | null): WarningAckFact | null {
  return row
    ? {
        acknowledgedAt: row.acknowledgedAt.toISOString(),
        causes: normalizeCauses(row.causes),
        runId: row.runId,
      }
    : null;
}

function evaluate(
  kind: WarningTargetKind,
  id: string,
  latest: LatestBackupFact | null,
  causeCounts: Record<string, number>,
  ack: WarningAcknowledgement | null,
  failedSinceAck: boolean,
): WarningFact {
  return {
    kind,
    id,
    latest,
    causeCounts,
    ack,
    failedSinceAck,
    evaluation: evaluateWarning(latest, ackFact(ack), failedSinceAck),
  };
}

/** Counts per cause from a stored summary, defensively. */
export function summaryCounts(summary: ItemFailureSummaryJson | null | undefined) {
  const counts: Record<string, number> = {};
  if (!summary || typeof summary !== "object" || !summary.byCause) {
    return counts;
  }
  for (const [code, value] of Object.entries(summary.byCause)) {
    if (typeof value === "number" && value > 0) {
      counts[normalizeCauses([code])[0] as string] = value;
    }
  }
  return counts;
}

/** How a finished mail backup ended: failed outright, or completed with or without failed items. */
export function mailOutcome(status: string, failedItems: number): BackupOutcome {
  if (status === "failed") {
    return "failed";
  }
  return failedItems > 0 ? "partial" : "succeeded";
}

// ---------------------------------------------------------------------------
// Mail: protected objects (mailboxes, OneDrives, IMAP accounts)
// ---------------------------------------------------------------------------

export async function loadMailWarnings(
  tx: Transaction,
  tenantId: string,
  scope: WarningScope = {},
): Promise<Map<string, WarningFact>> {
  const result = new Map<string, WarningFact>();
  if (scope.ids && scope.ids.length === 0) {
    return result;
  }
  const ids = scope.ids ? [...new Set(scope.ids)] : null;
  const latestRows = await tx
    .selectDistinctOn([jobs.protectedObjectId], {
      objectId: jobs.protectedObjectId,
      id: jobs.id,
      status: jobs.status,
      completedAt: jobs.completedAt,
      createdAt: jobs.createdAt,
      failed: jobProgress.failed,
      summary: jobs.itemFailureSummary,
    })
    .from(jobs)
    .innerJoin(protectedObjects, eq(protectedObjects.id, jobs.protectedObjectId))
    .leftJoin(jobProgress, eq(jobProgress.jobId, jobs.id))
    .where(
      and(
        eq(jobs.tenantId, tenantId),
        eq(jobs.queue, "backup"),
        inArray(jobs.status, ["completed", "failed"]),
        ids ? inArray(jobs.protectedObjectId, ids) : eq(protectedObjects.status, "active"),
      ),
    )
    .orderBy(jobs.protectedObjectId, desc(jobs.createdAt), desc(jobs.id));

  // The causes of runs that left items behind: the summary where the worker wrote one, the
  // stored rows for runs from before it did.
  const counts = new Map<string, Record<string, number>>();
  const needRows: string[] = [];
  for (const row of latestRows) {
    const fromSummary = summaryCounts(row.summary);
    if (Object.keys(fromSummary).length > 0) {
      counts.set(row.id, fromSummary);
    } else if ((row.failed ?? 0) > 0 || row.status === "failed") {
      needRows.push(row.id);
    }
  }
  if (needRows.length > 0) {
    const code = sql<string | null>`${itemFailures.failure}->>'code'`;
    const grouped = await tx
      .select({ jobId: itemFailures.jobId, code, n: count() })
      .from(itemFailures)
      .where(and(eq(itemFailures.tenantId, tenantId), inArray(itemFailures.jobId, needRows)))
      .groupBy(itemFailures.jobId, code);
    for (const row of grouped) {
      const entry = counts.get(row.jobId) ?? {};
      const key = normalizeCauses([row.code])[0] as string;
      entry[key] = (entry[key] ?? 0) + row.n;
      counts.set(row.jobId, entry);
    }
  }

  const objectIds = ids ?? latestRows.flatMap((row) => (row.objectId ? [row.objectId] : []));
  const acks = objectIds.length
    ? await tx
        .select()
        .from(warningAcknowledgements)
        .where(
          and(
            eq(warningAcknowledgements.tenantId, tenantId),
            inArray(warningAcknowledgements.protectedObjectId, objectIds),
          ),
        )
    : [];
  const ackBy = new Map(acks.map((row) => [row.protectedObjectId as string, row]));
  const failedSince = new Set<string>();
  if (acks.length > 0) {
    const rows = await tx
      .selectDistinct({ objectId: jobs.protectedObjectId })
      .from(jobs)
      .innerJoin(
        warningAcknowledgements,
        and(
          eq(warningAcknowledgements.protectedObjectId, jobs.protectedObjectId),
          gt(jobs.completedAt, warningAcknowledgements.acknowledgedAt),
        ),
      )
      .where(
        and(
          eq(jobs.tenantId, tenantId),
          eq(jobs.queue, "backup"),
          eq(jobs.status, "failed"),
          inArray(
            jobs.protectedObjectId,
            acks.map((row) => row.protectedObjectId as string),
          ),
        ),
      );
    for (const row of rows) {
      if (row.objectId) failedSince.add(row.objectId);
    }
  }

  for (const row of latestRows) {
    if (!row.objectId) continue;
    const causeCounts = counts.get(row.id) ?? {};
    const summaryTotal = row.summary?.total ?? 0;
    const failedItems = Math.max(row.failed ?? 0, summaryTotal);
    const outcome = mailOutcome(row.status, failedItems);
    const latest: LatestBackupFact = {
      runId: row.id,
      outcome,
      finishedAt: (row.completedAt ?? row.createdAt).toISOString(),
      failedItems,
      causes:
        outcome === "partial"
          ? normalizeCauses(
              Object.keys(causeCounts).length > 0
                ? Object.keys(causeCounts)
                : [UNKNOWN_WARNING_CAUSE],
            )
          : [],
    };
    result.set(
      row.objectId,
      evaluate(
        "object",
        row.objectId,
        latest,
        causeCounts,
        ackBy.get(row.objectId) ?? null,
        failedSince.has(row.objectId),
      ),
    );
  }
  // Objects asked for without any finished backup still answer (with nothing to report), so an
  // acknowledgement on them stays visible.
  for (const id of ids ?? []) {
    if (!result.has(id)) {
      result.set(id, evaluate("object", id, null, {}, ackBy.get(id) ?? null, false));
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Machines (servers and clients with the agent)
// ---------------------------------------------------------------------------

/** The causes of the errors an agent reported for a run, counted. */
export function machineCauseCounts(errors: readonly EndpointRunError[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const error of errors) {
    const code = classifyRunError(error).code;
    counts[code] = (counts[code] ?? 0) + 1;
  }
  return counts;
}

/** How a finished machine backup ended; a run the agent only reports as interrupted is not a failure. */
export function machineOutcome(
  status: string,
  errors: readonly EndpointRunError[],
): BackupOutcome | null {
  if (status === "partial") return "partial";
  if (status === "succeeded") return "succeeded";
  if (status === "failed") return isInterruptedOnly(errors) ? null : "failed";
  return null;
}

export async function loadMachineWarnings(
  tx: Transaction,
  tenantId: string,
  scope: WarningScope = {},
): Promise<Map<string, WarningFact>> {
  const result = new Map<string, WarningFact>();
  if (scope.ids && scope.ids.length === 0) {
    return result;
  }
  const ids = scope.ids ? [...new Set(scope.ids)] : null;
  const latestRows = await tx
    .selectDistinctOn([endpointRuns.endpointId], {
      endpointId: endpointRuns.endpointId,
      id: endpointRuns.id,
      status: endpointRuns.status,
      finishedAt: endpointRuns.finishedAt,
      startedAt: endpointRuns.startedAt,
      errors: endpointRuns.errors,
    })
    .from(endpointRuns)
    .innerJoin(endpoints, eq(endpoints.id, endpointRuns.endpointId))
    .where(
      and(
        eq(endpointRuns.tenantId, tenantId),
        eq(endpointRuns.kind, "backup"),
        inArray(endpointRuns.status, ["succeeded", "partial", "failed"]),
        isNotNull(endpointRuns.finishedAt),
        // A run that only says it was interrupted resumes by itself: it is not the newest outcome.
        sql`not (${endpointRuns.status} = 'failed' and jsonb_array_length(${endpointRuns.errors}) > 0 and not exists (select 1 from jsonb_array_elements(${endpointRuns.errors}) e where coalesce(e->>'code', '') <> 'interrupted'))`,
        ids ? inArray(endpointRuns.endpointId, ids) : eq(endpoints.status, "active"),
      ),
    )
    .orderBy(endpointRuns.endpointId, desc(endpointRuns.startedAt), desc(endpointRuns.id));

  const endpointIds = ids ?? latestRows.map((row) => row.endpointId);
  const acks = endpointIds.length
    ? await tx
        .select()
        .from(warningAcknowledgements)
        .where(
          and(
            eq(warningAcknowledgements.tenantId, tenantId),
            inArray(warningAcknowledgements.endpointId, endpointIds),
          ),
        )
    : [];
  const ackBy = new Map(acks.map((row) => [row.endpointId as string, row]));
  const failedSince = new Set<string>();
  if (acks.length > 0) {
    const rows = await tx
      .select({ endpointId: endpointRuns.endpointId, errors: endpointRuns.errors })
      .from(endpointRuns)
      .innerJoin(
        warningAcknowledgements,
        and(
          eq(warningAcknowledgements.endpointId, endpointRuns.endpointId),
          gt(endpointRuns.finishedAt, warningAcknowledgements.acknowledgedAt),
        ),
      )
      .where(
        and(
          eq(endpointRuns.tenantId, tenantId),
          eq(endpointRuns.kind, "backup"),
          eq(endpointRuns.status, "failed"),
          inArray(
            endpointRuns.endpointId,
            acks.map((row) => row.endpointId as string),
          ),
        ),
      )
      .limit(1000);
    for (const row of rows) {
      if (!isInterruptedOnly(row.errors ?? [])) failedSince.add(row.endpointId);
    }
  }

  for (const row of latestRows) {
    const errors = row.errors ?? [];
    const outcome = machineOutcome(row.status, errors) ?? "failed";
    const causeCounts = outcome === "succeeded" ? {} : machineCauseCounts(errors);
    const latest: LatestBackupFact = {
      runId: row.id,
      outcome,
      finishedAt: (row.finishedAt ?? row.startedAt).toISOString(),
      failedItems: errors.length,
      causes:
        outcome === "partial"
          ? normalizeCauses(
              Object.keys(causeCounts).length > 0
                ? Object.keys(causeCounts)
                : [UNKNOWN_WARNING_CAUSE],
            )
          : [],
    };
    result.set(
      row.endpointId,
      evaluate(
        "machine",
        row.endpointId,
        latest,
        causeCounts,
        ackBy.get(row.endpointId) ?? null,
        failedSince.has(row.endpointId),
      ),
    );
  }
  for (const id of ids ?? []) {
    if (!result.has(id)) {
      result.set(id, evaluate("machine", id, null, {}, ackBy.get(id) ?? null, false));
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// File shares (docs/FILESHARES.md 13)
// ---------------------------------------------------------------------------

/** How a finished share backup ended: `warning` is a backup that left items behind. */
export function shareOutcome(status: string): BackupOutcome | null {
  if (status === "succeeded") return "succeeded";
  if (status === "warning") return "partial";
  if (status === "failed") return "failed";
  return null;
}

/** The warning causes of a share run's item counts (`stats.items`), as a record. */
export function shareCauseCounts(
  items: Readonly<Record<string, number>> | null | undefined,
): Record<string, number> {
  return Object.fromEntries(shareWarningCauses(items).map((cause) => [cause.code, cause.count]));
}

export async function loadShareWarnings(
  tx: Transaction,
  tenantId: string,
  scope: WarningScope = {},
): Promise<Map<string, WarningFact>> {
  const result = new Map<string, WarningFact>();
  if (scope.ids && scope.ids.length === 0) {
    return result;
  }
  const ids = scope.ids ? [...new Set(scope.ids)] : null;
  const latestRows = await tx
    .selectDistinctOn([fileShareRuns.fileShareId], {
      shareId: fileShareRuns.fileShareId,
      id: fileShareRuns.id,
      status: fileShareRuns.status,
      finishedAt: fileShareRuns.finishedAt,
      queuedAt: fileShareRuns.queuedAt,
      stats: fileShareRuns.stats,
      itemCount: fileShareRuns.itemCount,
    })
    .from(fileShareRuns)
    .innerJoin(fileShares, eq(fileShares.id, fileShareRuns.fileShareId))
    .where(
      and(
        eq(fileShareRuns.tenantId, tenantId),
        eq(fileShareRuns.kind, "backup"),
        inArray(fileShareRuns.status, ["succeeded", "warning", "failed"]),
        isNotNull(fileShareRuns.finishedAt),
        ids ? inArray(fileShareRuns.fileShareId, ids) : sql`${fileShares.retiredAt} is null`,
      ),
    )
    .orderBy(fileShareRuns.fileShareId, desc(fileShareRuns.finishedAt), desc(fileShareRuns.id));

  const shareIds = ids ?? latestRows.map((row) => row.shareId);
  const acks = shareIds.length
    ? await tx
        .select()
        .from(warningAcknowledgements)
        .where(
          and(
            eq(warningAcknowledgements.tenantId, tenantId),
            inArray(warningAcknowledgements.fileShareId, shareIds),
          ),
        )
    : [];
  const ackBy = new Map(acks.map((row) => [row.fileShareId as string, row]));
  const failedSince = new Set<string>();
  if (acks.length > 0) {
    const rows = await tx
      .selectDistinct({ shareId: fileShareRuns.fileShareId })
      .from(fileShareRuns)
      .innerJoin(
        warningAcknowledgements,
        and(
          eq(warningAcknowledgements.fileShareId, fileShareRuns.fileShareId),
          gt(fileShareRuns.finishedAt, warningAcknowledgements.acknowledgedAt),
        ),
      )
      .where(
        and(
          eq(fileShareRuns.tenantId, tenantId),
          eq(fileShareRuns.kind, "backup"),
          eq(fileShareRuns.status, "failed"),
          inArray(
            fileShareRuns.fileShareId,
            acks.map((row) => row.fileShareId as string),
          ),
        ),
      );
    for (const row of rows) {
      failedSince.add(row.shareId);
    }
  }

  for (const row of latestRows) {
    const outcome = shareOutcome(row.status) ?? "failed";
    const causeCounts =
      outcome === "succeeded"
        ? {}
        : shareCauseCounts(row.stats?.items as Record<string, number> | undefined);
    const counted = Object.values(causeCounts).reduce((sum, value) => sum + value, 0);
    const latest: LatestBackupFact = {
      runId: row.id,
      outcome,
      finishedAt: (row.finishedAt ?? row.queuedAt).toISOString(),
      failedItems: Math.max(counted, outcome === "succeeded" ? 0 : row.itemCount),
      causes:
        outcome === "partial"
          ? normalizeCauses(
              Object.keys(causeCounts).length > 0
                ? Object.keys(causeCounts)
                : [UNKNOWN_WARNING_CAUSE],
            )
          : [],
    };
    result.set(
      row.shareId,
      evaluate(
        "share",
        row.shareId,
        latest,
        causeCounts,
        ackBy.get(row.shareId) ?? null,
        failedSince.has(row.shareId),
      ),
    );
  }
  for (const id of ids ?? []) {
    if (!result.has(id)) {
      result.set(id, evaluate("share", id, null, {}, ackBy.get(id) ?? null, false));
    }
  }
  return result;
}

/** The warning counts of a set of facts: what the overview and the status API report. */
export function warningCounts(facts: Iterable<WarningFact>): {
  failed: number;
  open: number;
  acknowledged: number;
} {
  let failed = 0;
  let open = 0;
  let acknowledged = 0;
  for (const fact of facts) {
    if (fact.evaluation.state === "failed") failed++;
    else if (fact.evaluation.state === "open") open++;
    else if (fact.evaluation.state === "acknowledged") acknowledged++;
  }
  return { failed, open, acknowledged };
}
