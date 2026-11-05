import { readinessWithoutFreshness } from "@restow/core";
import { type Job, jobs, snapshots, type VerifyReport } from "@restow/db";
import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { z } from "zod";
import { parseReasons } from "../../features/verify/details.js";
import {
  type EmptyConfirmationDto,
  emptyStateOf,
  loadEmptyConfirmations,
} from "../../features/verify/empty.js";
import { isOverdue, objectStateOf } from "../../features/verify/summary.js";
import {
  loadObjectVerifications,
  withBackupAgeNow,
} from "../../features/verify/verification-state.js";
import type { Transaction } from "../../lib/tenant-context.js";
import { component } from "./components.js";
import { readinessSchema, readinessStateSchema, timestampSchema } from "./schemas.js";

/**
 * What the integration API knows about each protected object's backups: the
 * newest restorable snapshot, the newest backup job and the verification of
 * that snapshot. The readiness rules are the verify feature's (a backup that
 * was never proven by a test restore is not "fine", and a rating belongs to
 * the backup it checked), so an RMM sees exactly the rating the Restow UI
 * shows.
 */

export interface SnapshotFact {
  id: string;
  sequence: number;
  completedAt: Date | null;
  itemCount: number;
  byteSize: number;
}

export interface JobFact {
  id: string;
  status: Job["status"];
  createdAt: Date;
  completedAt: Date | null;
  errorMessage: string | null;
  /** The stored cause record (jsonb) behind `errorMessage`; null for older rows. */
  failure: unknown;
}

export interface VerifyFact {
  rating: VerifyReport["recoveryReadiness"];
  kind: VerifyReport["kind"];
  checkedAt: Date;
  /**
   * The report's stored reasons (raw jsonb): an orphaned object is rated by them, and an object
   * whose reasons say "empty" and nothing else reads empty ({@link readinessOf}).
   */
  reasons?: unknown;
  /** `details->>'origin'`: a storage finding (`scrub`) never reads empty. */
  origin?: string | null;
}

export interface ObjectFacts {
  snapshot: SnapshotFact | null;
  job: JobFact | null;
  verify: VerifyFact | null;
  /** An admin's "confirm as empty" (verify/empty.ts); it counts only while the check says empty. */
  emptyConfirmation?: EmptyConfirmationDto | null;
}

export const NO_FACTS: ObjectFacts = { snapshot: null, job: null, verify: null };

/**
 * Newest restorable snapshot, newest backup job and the verification that
 * rates that snapshot per object. After a new backup the object has no rating
 * (it reads `unverified`) until a check has read that backup back. With them
 * the admin confirmations as empty, so an empty object reads as the readiness
 * page shows it.
 */
export async function loadObjectFacts(
  tx: Transaction,
  tenantId: string,
  objectIds: readonly string[],
): Promise<Map<string, ObjectFacts>> {
  const facts = new Map<string, ObjectFacts>();
  if (objectIds.length === 0) {
    return facts;
  }
  const ids = [...objectIds];
  const entry = (id: string): ObjectFacts => {
    const existing = facts.get(id);
    if (existing) {
      return existing;
    }
    const created: ObjectFacts = { snapshot: null, job: null, verify: null };
    facts.set(id, created);
    return created;
  };

  const snapshotRows = await tx
    .selectDistinctOn([snapshots.protectedObjectId], {
      objectId: snapshots.protectedObjectId,
      id: snapshots.id,
      sequence: snapshots.sequence,
      completedAt: snapshots.completedAt,
      itemCount: snapshots.itemCount,
      byteSize: snapshots.byteSize,
    })
    .from(snapshots)
    .where(
      and(
        eq(snapshots.tenantId, tenantId),
        inArray(snapshots.protectedObjectId, ids),
        eq(snapshots.status, "active"),
        isNotNull(snapshots.manifestPath),
      ),
    )
    .orderBy(snapshots.protectedObjectId, desc(snapshots.sequence));
  for (const { objectId, ...snapshot } of snapshotRows) {
    entry(objectId).snapshot = snapshot;
  }

  const jobRows = await tx
    .selectDistinctOn([jobs.protectedObjectId], {
      objectId: jobs.protectedObjectId,
      id: jobs.id,
      status: jobs.status,
      createdAt: jobs.createdAt,
      completedAt: jobs.completedAt,
      errorMessage: jobs.errorMessage,
      failure: jobs.failure,
    })
    .from(jobs)
    .where(
      and(
        eq(jobs.tenantId, tenantId),
        eq(jobs.queue, "backup"),
        inArray(jobs.protectedObjectId, ids),
      ),
    )
    .orderBy(jobs.protectedObjectId, desc(jobs.createdAt), desc(jobs.id));
  for (const { objectId, ...job } of jobRows) {
    if (objectId) {
      entry(objectId).job = job;
    }
  }

  const verifications = await loadObjectVerifications(tx, tenantId, ids);
  for (const [objectId, { verification }] of verifications) {
    const report = verification.report;
    if (report) {
      entry(objectId).verify = {
        rating: report.readiness,
        kind: report.kind,
        checkedAt: report.checkedAt,
        reasons: report.reasons,
        origin: report.origin,
      };
    }
  }
  const confirmations = await loadEmptyConfirmations(tx, tenantId, ids);
  for (const [objectId, confirmation] of confirmations) {
    entry(objectId).emptyConfirmation = confirmation;
  }
  return facts;
}

// ---------------------------------------------------------------------------
// Readiness of one object
// ---------------------------------------------------------------------------

export const objectReadinessSchema = component(
  "ObjectReadiness",
  z.object({
    state: readinessStateSchema,
    rating: readinessSchema.nullable(),
    kind: z
      .enum(["verify", "health_check"])
      .nullable()
      .describe("`verify` is a sampled test restore, `health_check` a full reconciliation."),
    checkedAt: timestampSchema.nullable(),
    overdue: z.boolean().describe("The latest rating is older than the weekly verify interval."),
    inJob: z
      .boolean()
      .describe(
        "False for an active object that no enabled backup job covers: nothing backs it up any more. It is then rated by whether its newest backup restores, not by that backup's age, and is never `overdue`; the tenant's overall readiness is at least yellow. An object without any backup stays `no_backup`.",
      ),
  }),
);
export type ObjectReadinessDto = z.infer<typeof objectReadinessSchema>;

/**
 * The readiness of one object, as the verify feature rates it (verify/service.ts
 * readinessOverview): an orphaned object (removed from its source, backups kept) is rated by whether
 * its last backup restores, without the age of that backup, and is never overdue, since nothing
 * schedules checks for it any more. So is an active object in no enabled backup job
 * (`withoutJob`, @restow/core `mailObjectsInNoJob`): no new backup is due, so the age of the last
 * one is no fault (the tenant is still kept from green, see summary `withoutJob`).
 *
 * An object that reads "empty" on the readiness page (verify/empty.ts `emptyStateOf`: empty by
 * Microsoft 365 and by the backup, or confirmed as empty by an admin) is green here and never
 * overdue, as /v1/verify and /v1/status count it: v1 knows no state "empty", and nothing about
 * such an object needs attention.
 */
export function readinessOf(
  facts: ObjectFacts,
  now: Date,
  status: "active" | "excluded" | "orphaned" = "active",
  withoutJob = false,
): ObjectReadinessDto {
  const checkedAt = facts.verify?.checkedAt ?? null;
  const retained = status === "orphaned";
  const withoutAge = retained || (withoutJob && status === "active");
  // The backup's age now, not at the check (verification-state.ts withBackupAgeNow), as the
  // readiness page rates it: a mailbox whose backups stopped turns yellow and red here too.
  const empty = facts.verify
    ? emptyStateOf(
        { reasons: facts.verify.reasons, origin: facts.verify.origin ?? null },
        facts.emptyConfirmation,
        withoutAge,
      )
    : null;
  if (empty !== null) {
    return {
      state: "green",
      rating: "green",
      kind: facts.verify?.kind ?? null,
      checkedAt: checkedAt?.toISOString() ?? null,
      overdue: false,
      inJob: !(withoutJob && status === "active"),
    };
  }
  const rating = facts.verify
    ? withoutAge
      ? readinessWithoutFreshness(parseReasons(facts.verify.reasons))
      : withBackupAgeNow(facts.verify.rating, facts.snapshot?.completedAt, now, false)
    : null;
  return {
    state: objectStateOf(rating, facts.snapshot !== null),
    rating,
    kind: facts.verify?.kind ?? null,
    checkedAt: checkedAt?.toISOString() ?? null,
    overdue: withoutAge ? false : isOverdue(checkedAt, now),
    inJob: !(withoutJob && status === "active"),
  };
}

/**
 * Whether an object takes part in the readiness rating: excluded objects are
 * not protected, and an orphaned one counts only while its backups exist
 * (the verify feature's rule).
 */
export function countsForReadiness(
  status: "active" | "excluded" | "orphaned",
  hasSnapshot: boolean,
) {
  return status === "active" || (status === "orphaned" && hasSnapshot);
}
