import { type Job, type VerifyReport, jobs, snapshots } from "@restow/db";
import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { z } from "zod";
import { isOverdue, objectStateOf } from "../../features/verify/summary.js";
import { loadObjectVerifications } from "../../features/verify/verification-state.js";
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
}

export interface ObjectFacts {
  snapshot: SnapshotFact | null;
  job: JobFact | null;
  verify: VerifyFact | null;
}

export const NO_FACTS: ObjectFacts = { snapshot: null, job: null, verify: null };

/**
 * Newest restorable snapshot, newest backup job and the verification that
 * rates that snapshot per object. After a new backup the object has no rating
 * (it reads `unverified`) until a check has read that backup back.
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
      };
    }
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
  }),
);
export type ObjectReadinessDto = z.infer<typeof objectReadinessSchema>;

export function readinessOf(facts: ObjectFacts, now: Date): ObjectReadinessDto {
  const checkedAt = facts.verify?.checkedAt ?? null;
  return {
    state: objectStateOf(facts.verify?.rating ?? null, facts.snapshot !== null),
    rating: facts.verify?.rating ?? null,
    kind: facts.verify?.kind ?? null,
    checkedAt: checkedAt?.toISOString() ?? null,
    overdue: isOverdue(checkedAt, now),
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
