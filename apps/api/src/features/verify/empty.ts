import { isEmptyFinding, isSourceEmptyFinding } from "@restow/core";
import { type Database, emptyConfirmations, protectedObjects } from "@restow/db";
import { and, eq, inArray, type SQL } from "drizzle-orm";
import { audit } from "../../lib/audit.js";
import { notImported } from "../../lib/imported-objects.js";
import { type DbExecutor, type Transaction, withTenantTx } from "../../lib/tenant-context.js";
import { ProblemError } from "../../problem.js";
import { loadMailWithoutJob } from "../backup-jobs/coverage.js";
import { parseContentStats, parseReasons } from "./details.js";
import { loadObjectVerifications, type ReportFact } from "./verification-state.js";

/**
 * "Confirm as empty" (0.4.9): an empty mailbox (only its default folders), an empty OneDrive or a
 * site with system pages only is backed up like any other object, but its restore check finds
 * nothing to restore (core `snapshot_empty`, yellow). An admin who agrees confirms it as empty;
 * from then on the object reads neutral grey (`state: "empty"`, verify/summary.ts) and counts for
 * no "needs attention": not in the tenant rating, the dashboard, the statistics, the provider
 * view or the alerts, and it is never overdue.
 *
 * A confirmation only counts while the object's newest check still says exactly "empty"
 * ({@link confirmationApplies}): any other finding, or a check that read content back, sets it
 * aside at once. The worker also deletes the row with the first report that finds content, in
 * the same transaction (apps/worker handlers/verify.ts), so an object that turns empty again later
 * is confirmed anew. Confirming and revoking are audited.
 *
 * Empty by the source (0.5.0): a OneDrive or mailbox whose backup holds nothing while Microsoft
 * 365 itself reports it empty, before and after the run (core verify/source.ts,
 * `snapshot_empty_confirmed_by_source`), reads "empty" the same way without anyone confirming
 * it ({@link emptyStateOf}). It cannot be confirmed (there is nothing to confirm), and it is
 * not audited: it is a rating, not a decision. Every view that shows an object's state asks
 * {@link emptyStateOf}, so the verify overview, the statistics, the restore explorer, the
 * directory and the integration API (/v1/verify, /v1/status, /v1/users and /v1/objects, where
 * v1 knows no "empty" and counts it as green) agree.
 */

export const EMPTY_AUDIT_ACTIONS = {
  confirmed: "verify.empty_confirmed",
  revoked: "verify.empty_confirmation_revoked",
} as const;

/** Objects one request confirms at most (like acknowledged warnings). */
export const MAX_EMPTY_CONFIRMATIONS = 200;

export interface EmptyActor {
  userId: string | null;
  email: string;
  ip: string | null;
}

/** Who confirmed an object as empty, and which backup they looked at. */
export interface EmptyConfirmationDto {
  confirmedAt: string;
  confirmedBy: string;
  note: string | null;
  /** The backup the confirmation was given for; null once it was pruned. */
  snapshotId: string | null;
}

/**
 * `excluded`: the object is excluded from protection; the overview does not list it either.
 * `empty_by_source`: Microsoft 365 reports it empty as well, it reads "empty" without one (0.5.0).
 */
export type EmptySkipReason =
  | "not_empty"
  | "no_report"
  | "not_found"
  | "excluded"
  | "empty_by_source";

export interface EmptyConfirmResultDto {
  confirmed: { protectedObjectId: string; displayName: string | null }[];
  skipped: { protectedObjectId: string; displayName: string | null; reason: EmptySkipReason }[];
}

export type EmptyConfirmInput = (
  | { objectIds: string[]; filter?: undefined }
  | { filter: { state: "empty_unconfirmed" }; objectIds?: undefined }
) & { note?: string | null };

/** The reasons that only say how old the backup is (core `readinessWithoutFreshness`). */
const FRESHNESS_REASONS: ReadonlySet<string> = new Set(["snapshot_outdated", "snapshot_stale"]);

/**
 * Whether a report's reasons say "empty" and nothing else, as the object is rated: an object
 * rated without the age of its backup (orphaned, or in no backup job) has the age reasons set
 * aside first.
 */
export function restsOnEmpty(reasons: readonly { code: string }[], withoutAge: boolean): boolean {
  return isEmptyFinding(
    withoutAge ? reasons.filter((reason) => !FRESHNESS_REASONS.has(reason.code)) : reasons,
  );
}

/** Whether a report's reasons say "empty by the source and by the backup" and nothing else. */
export function restsOnSourceEmpty(
  reasons: readonly { code: string }[],
  withoutAge: boolean,
): boolean {
  return isSourceEmptyFinding(
    withoutAge ? reasons.filter((reason) => !FRESHNESS_REASONS.has(reason.code)) : reasons,
  );
}

/**
 * Why the object reads "empty" now, or null when it does not: `source` when the report that
 * rates it says "empty by Microsoft 365 and by the backup" and nothing else, `admin` when an
 * admin's confirmation counts for it ({@link confirmationApplies}). A storage finding never
 * reads "empty".
 */
export function emptyStateOf(
  report: Pick<ReportFact, "reasons" | "origin"> | null | undefined,
  confirmation: EmptyConfirmationDto | null | undefined,
  withoutAge: boolean,
): "source" | "admin" | null {
  if (!report || report.origin === "scrub") {
    return null;
  }
  if (restsOnSourceEmpty(parseReasons(report.reasons), withoutAge)) {
    return "source";
  }
  return confirmationApplies(confirmation, report, withoutAge) ? "admin" : null;
}

/** Whether a stored confirmation counts for the report that rates the object now. */
export function confirmationApplies(
  confirmation: EmptyConfirmationDto | null | undefined,
  report: Pick<ReportFact, "reasons" | "origin"> | null | undefined,
  withoutAge: boolean,
): boolean {
  if (!confirmation || !report || report.origin === "scrub") {
    return false;
  }
  return restsOnEmpty(parseReasons(report.reasons), withoutAge);
}

/** The confirmations of the tenant's objects (or of `objectIds`), by object id. */
export async function loadEmptyConfirmations(
  tx: DbExecutor,
  tenantId: string,
  objectIds?: readonly string[],
): Promise<Map<string, EmptyConfirmationDto>> {
  if (objectIds && objectIds.length === 0) {
    return new Map();
  }
  const filters: SQL[] = [eq(emptyConfirmations.tenantId, tenantId)];
  if (objectIds) {
    filters.push(inArray(emptyConfirmations.protectedObjectId, [...objectIds]));
  }
  const rows = await tx
    .select({
      objectId: emptyConfirmations.protectedObjectId,
      confirmedAt: emptyConfirmations.confirmedAt,
      confirmedBy: emptyConfirmations.confirmedBy,
      note: emptyConfirmations.note,
      snapshotId: emptyConfirmations.snapshotId,
    })
    .from(emptyConfirmations)
    .where(and(...filters));
  return new Map(
    rows.map((row) => [
      row.objectId,
      {
        confirmedAt: row.confirmedAt.toISOString(),
        confirmedBy: row.confirmedBy,
        note: row.note,
        snapshotId: row.snapshotId,
      },
    ]),
  );
}

function trimNote(note: string | null | undefined): string | null {
  const value = note?.trim() ?? "";
  return value.length > 0 ? value : null;
}

interface Candidate {
  id: string;
  displayName: string | null;
  status: "active" | "excluded" | "orphaned";
}

async function candidatesOf(
  tx: Transaction,
  tenantId: string,
  objectIds: readonly string[] | null,
): Promise<Candidate[]> {
  const filters: SQL[] = [eq(protectedObjects.tenantId, tenantId), notImported()];
  if (objectIds) {
    filters.push(inArray(protectedObjects.id, [...objectIds]));
  }
  return tx
    .select({
      id: protectedObjects.id,
      displayName: protectedObjects.displayName,
      status: protectedObjects.status,
    })
    .from(protectedObjects)
    .where(and(...filters));
}

/**
 * Confirm objects as empty: the listed ones (at most {@link MAX_EMPTY_CONFIRMATIONS}), or with
 * the filter every object whose newest check found it empty and that nobody confirmed yet. Only
 * an object whose newest check says "empty" and nothing else is confirmed; the others come back
 * in `skipped` with the reason. An excluded object is never confirmed: the overview does not
 * list it, so nobody saw it as empty. Confirming again replaces the earlier confirmation. Every
 * confirmation is audited on its own.
 */
export async function confirmEmpty(
  db: Database,
  tenantId: string,
  input: EmptyConfirmInput,
  actor: EmptyActor,
): Promise<EmptyConfirmResultDto> {
  const listed = input.objectIds ? [...new Set(input.objectIds)] : null;
  if (listed && listed.length > MAX_EMPTY_CONFIRMATIONS) {
    throw new ProblemError(400, "Too many objects", {
      detail: `Confirm at most ${MAX_EMPTY_CONFIRMATIONS} objects at once.`,
    });
  }
  const note = trimNote(input.note);
  return withTenantTx(db, tenantId, async (tx) => {
    const candidates = await candidatesOf(tx, tenantId, listed);
    const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
    const ids = listed ?? candidates.map((candidate) => candidate.id);
    const verifications = await loadObjectVerifications(tx, tenantId, listed ?? undefined);
    const existing = await loadEmptyConfirmations(tx, tenantId, listed ?? undefined);
    const noJob = await loadMailWithoutJob(tx, tenantId);
    const result: EmptyConfirmResultDto = { confirmed: [], skipped: [] };
    for (const id of ids) {
      const candidate = byId.get(id);
      if (!candidate) {
        result.skipped.push({ protectedObjectId: id, displayName: null, reason: "not_found" });
        continue;
      }
      const skip = (reason: EmptySkipReason) => {
        // The filter looks at every object: only the listed ones are worth an answer.
        if (listed) {
          result.skipped.push({
            protectedObjectId: id,
            displayName: candidate.displayName,
            reason,
          });
        }
      };
      if (candidate.status === "excluded") {
        skip("excluded");
        continue;
      }
      const facts = verifications.get(id);
      const report = facts?.verification.report ?? null;
      if (!facts?.latestSnapshot || !report) {
        skip("no_report");
        continue;
      }
      const withoutAge =
        candidate.status === "orphaned" || (candidate.status === "active" && noJob.has(id));
      if (
        report.origin !== "scrub" &&
        restsOnSourceEmpty(parseReasons(report.reasons), withoutAge)
      ) {
        // Empty by Microsoft 365 as well: it reads "empty" already, nothing to confirm.
        skip("empty_by_source");
        continue;
      }
      if (report.origin === "scrub" || !restsOnEmpty(parseReasons(report.reasons), withoutAge)) {
        skip("not_empty");
        continue;
      }
      if (!listed && existing.has(id)) {
        // "Empty, not confirmed yet": the confirmed ones stay as they are.
        continue;
      }
      const values = {
        snapshotId: facts.latestSnapshot.id,
        note,
        confirmedByUserId: actor.userId,
        confirmedBy: actor.email,
        confirmedAt: new Date(),
      };
      await tx
        .insert(emptyConfirmations)
        .values({ tenantId, protectedObjectId: id, ...values })
        .onConflictDoUpdate({ target: emptyConfirmations.protectedObjectId, set: values });
      const content = parseContentStats(report.content);
      await audit(tx, {
        tenantId,
        actor: actor.email,
        actorUserId: actor.userId,
        action: EMPTY_AUDIT_ACTIONS.confirmed,
        target: id,
        targetType: "protected_object",
        ip: actor.ip,
        details: {
          name: candidate.displayName,
          snapshotId: facts.latestSnapshot.id,
          reportId: report.id,
          itemCount: content?.items ?? null,
          note,
          replaced: existing.has(id),
        },
      });
      result.confirmed.push({ protectedObjectId: id, displayName: candidate.displayName });
    }
    return result;
  });
}

/** Take a confirmation back: the object reads yellow again. 404 when there is none. */
export async function revokeEmptyConfirmation(
  db: Database,
  tenantId: string,
  objectId: string,
  actor: EmptyActor,
): Promise<void> {
  await withTenantTx(db, tenantId, async (tx) => {
    const [removed] = await tx
      .delete(emptyConfirmations)
      .where(
        and(
          eq(emptyConfirmations.tenantId, tenantId),
          eq(emptyConfirmations.protectedObjectId, objectId),
        ),
      )
      .returning({ snapshotId: emptyConfirmations.snapshotId });
    if (!removed) {
      throw new ProblemError(404, "No confirmation to revoke", {
        detail: "This object is not confirmed as empty.",
      });
    }
    const [object] = await tx
      .select({ displayName: protectedObjects.displayName })
      .from(protectedObjects)
      .where(and(eq(protectedObjects.tenantId, tenantId), eq(protectedObjects.id, objectId)))
      .limit(1);
    await audit(tx, {
      tenantId,
      actor: actor.email,
      actorUserId: actor.userId,
      action: EMPTY_AUDIT_ACTIONS.revoked,
      target: objectId,
      targetType: "protected_object",
      ip: actor.ip,
      details: { name: object?.displayName ?? null, snapshotId: removed.snapshotId },
    });
  });
}
