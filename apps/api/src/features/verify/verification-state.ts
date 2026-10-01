import { snapshots, verifyReports } from "@restow/db";
import { type SQL, and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { DbExecutor } from "../../lib/tenant-context.js";
import type { Readiness } from "./details.js";
import type { ObjectState } from "./summary.js";

/**
 * When is a backup proven restorable? The one rule every view shares.
 *
 * A verify run reads back a sample of one snapshot and stores its rating with
 * that snapshot's id (`verify_reports.snapshot_id`). The rating therefore
 * belongs to the snapshot, not to the protected object: a backup taken after
 * a green check is `unverified` until a check of that backup ran, whatever an
 * older snapshot scored. A backup without a verified restore counts as failed
 * (docs/TESTING.md), so it is never shown as fine.
 *
 * The storage check (scrub) files red findings per object without a snapshot
 * id: it knows which objects keep data in a damaged pack, not which of their
 * snapshots. A finding therefore rates a snapshot red when it is newer than
 * that snapshot's latest check, or, for a snapshot never checked, newer than
 * every check of the object (a later check already accounted for the damage,
 * because verify reads the scrub's list of damaged packs). Reports without a
 * snapshot id that are not storage findings (written before reports were
 * linked, or by a check that found no backup at all) rate no snapshot.
 */

/** The verification of one backup (snapshot). */
export type VerificationState = Readiness | "unverified";

/** What the rule needs to know about one report. */
export interface RatedReport {
  id: string;
  readiness: Readiness;
  checkedAt: Date;
  /** The snapshot the report checked; null for storage findings and unlinked reports. */
  snapshotId: string | null;
  /** `verify` or `scrub` from the stored details; anything else for unknown formats. */
  origin: string | null;
}

/** A report of the storage check (scrub): damage in the object's data, no snapshot named. */
export function isStorageFinding(report: Pick<RatedReport, "origin">): boolean {
  return report.origin === "scrub";
}

/** The newest of two reports (the first on a tie); null when both are missing. */
export function newestOf<T extends RatedReport>(a: T | null, b: T | null): T | null {
  if (!a || !b) {
    return a ?? b;
  }
  return b.checkedAt > a.checkedAt ? b : a;
}

/**
 * The report that rates one snapshot, or null when nothing does (the snapshot
 * is unverified).
 *
 * @param latestCheck    the newest check of exactly this snapshot
 * @param latestFinding  the newest storage finding of the snapshot's object
 * @param objectCheckedAt when the object was last checked, whatever snapshot
 */
export function ratingReport<T extends RatedReport>(
  latestCheck: T | null,
  latestFinding: T | null,
  objectCheckedAt: Date | null,
): T | null {
  if (latestFinding) {
    const findingIsNewerThan = (at: Date | null) => at === null || latestFinding.checkedAt > at;
    if (findingIsNewerThan(latestCheck ? latestCheck.checkedAt : objectCheckedAt)) {
      return latestFinding;
    }
  }
  return latestCheck;
}

/** The verification of one snapshot, as the snapshot lists show it. */
export interface SnapshotVerificationDto {
  state: VerificationState;
  /** When the rating was established; null while unverified. */
  checkedAt: string | null;
  /** The report behind the rating; null while unverified. */
  reportId: string | null;
}

/** A backup no check has rated (yet). */
export function unverifiedSnapshot(): SnapshotVerificationDto {
  return { state: "unverified", checkedAt: null, reportId: null };
}

export function snapshotVerificationOf(
  latestCheck: RatedReport | null,
  latestFinding: RatedReport | null,
  objectCheckedAt: Date | null,
): SnapshotVerificationDto {
  const report = ratingReport(latestCheck, latestFinding, objectCheckedAt);
  return report
    ? { state: report.readiness, checkedAt: report.checkedAt.toISOString(), reportId: report.id }
    : unverifiedSnapshot();
}

/** How one protected object stands, with the reports behind it. */
export interface ObjectVerification<T extends RatedReport> {
  state: ObjectState;
  /** The report behind `state`; null for `unverified` and `no_backup`. */
  report: T | null;
  /**
   * The newest check of an older backup while the newest backup is
   * unverified: what was proven before, never what holds now.
   */
  previous: T | null;
}

/**
 * The state of an object: the rating of its newest completed snapshot,
 * `unverified` when nothing rates that snapshot, `no_backup` without one.
 */
export function objectVerificationOf<T extends RatedReport>(input: {
  /** The newest completed, unpruned snapshot of the object. */
  latestSnapshotId: string | null;
  /** The newest check of exactly that snapshot. */
  latestCheck: T | null;
  /** The newest storage finding of the object. */
  latestFinding: T | null;
  /** The newest check of the object, whatever snapshot it read. */
  newestCheck: T | null;
}): ObjectVerification<T> {
  if (input.latestSnapshotId === null) {
    return { state: "no_backup", report: null, previous: null };
  }
  const check =
    input.latestCheck && input.latestCheck.snapshotId === input.latestSnapshotId
      ? input.latestCheck
      : null;
  const report = ratingReport(check, input.latestFinding, input.newestCheck?.checkedAt ?? null);
  if (report) {
    return { state: report.readiness, report, previous: null };
  }
  return { state: "unverified", report: null, previous: input.newestCheck };
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/** One report as the views load it: the small parts of the details, never the item lists. */
export interface ReportFact extends RatedReport {
  objectId: string;
  kind: "verify" | "health_check";
  jobId: string | null;
  reasons: unknown;
  counts: unknown;
}

export const reportFactColumns = {
  id: verifyReports.id,
  objectId: verifyReports.protectedObjectId,
  snapshotId: verifyReports.snapshotId,
  kind: verifyReports.kind,
  readiness: verifyReports.recoveryReadiness,
  checkedAt: verifyReports.checkedAt,
  jobId: verifyReports.jobId,
  origin: sql<string | null>`${verifyReports.details}->>'origin'`,
  reasons: sql<unknown>`${verifyReports.details}->'reasons'`,
  counts: sql<unknown>`${verifyReports.details}->'counts'`,
};

/** Newest first; ties (same instant) by insertion. */
const NEWEST_FIRST = [desc(verifyReports.checkedAt), desc(verifyReports.createdAt)];

const storageFinding = (): SQL => sql`${verifyReports.details}->>'origin' = 'scrub'`;
const check = (): SQL => sql`coalesce(${verifyReports.details}->>'origin', '') <> 'scrub'`;

const completedSnapshot = (): SQL =>
  and(eq(snapshots.status, "active"), isNotNull(snapshots.manifestPath)) as SQL;

function byObject<T extends { objectId: string }>(rows: readonly T[]): Map<string, T> {
  return new Map(rows.map((row) => [row.objectId, row]));
}

/** The newest completed snapshot of an object. */
export interface LatestSnapshotFact {
  id: string;
  sequence: number;
  completedAt: Date | null;
}

export interface ObjectVerificationFacts {
  latestSnapshot: LatestSnapshotFact | null;
  verification: ObjectVerification<ReportFact>;
  /** The newest report of the object, check or finding: when it was last looked at. */
  newest: ReportFact | null;
}

/**
 * The verification of every object of the tenant (or of `objectIds`) that has
 * a completed snapshot or a report, in four queries. Runs inside the caller's
 * tenant-pinned transaction.
 */
export async function loadObjectVerifications(
  tx: DbExecutor,
  tenantId: string,
  objectIds?: readonly string[],
): Promise<Map<string, ObjectVerificationFacts>> {
  if (objectIds && objectIds.length === 0) {
    return new Map();
  }
  const snapshotFilters: SQL[] = [eq(snapshots.tenantId, tenantId), completedSnapshot()];
  const reportFilters: SQL[] = [eq(verifyReports.tenantId, tenantId)];
  if (objectIds) {
    snapshotFilters.push(inArray(snapshots.protectedObjectId, [...objectIds]));
    reportFilters.push(inArray(verifyReports.protectedObjectId, [...objectIds]));
  }
  const latestSnapshotIds = tx
    .selectDistinctOn([snapshots.protectedObjectId], { id: snapshots.id })
    .from(snapshots)
    .where(and(...snapshotFilters))
    .orderBy(snapshots.protectedObjectId, desc(snapshots.sequence));

  // One after the other: a transaction is one connection, which runs one query at a time.
  const latest = await tx
    .selectDistinctOn([snapshots.protectedObjectId], {
      objectId: snapshots.protectedObjectId,
      id: snapshots.id,
      sequence: snapshots.sequence,
      completedAt: snapshots.completedAt,
    })
    .from(snapshots)
    .where(and(...snapshotFilters))
    .orderBy(snapshots.protectedObjectId, desc(snapshots.sequence));
  const latestChecks = await tx
    .selectDistinctOn([verifyReports.protectedObjectId], reportFactColumns)
    .from(verifyReports)
    .where(and(...reportFilters, inArray(verifyReports.snapshotId, latestSnapshotIds)))
    .orderBy(verifyReports.protectedObjectId, ...NEWEST_FIRST);
  const findings = await tx
    .selectDistinctOn([verifyReports.protectedObjectId], reportFactColumns)
    .from(verifyReports)
    .where(and(...reportFilters, storageFinding()))
    .orderBy(verifyReports.protectedObjectId, ...NEWEST_FIRST);
  const newestChecks = await tx
    .selectDistinctOn([verifyReports.protectedObjectId], reportFactColumns)
    .from(verifyReports)
    .where(and(...reportFilters, check()))
    .orderBy(verifyReports.protectedObjectId, ...NEWEST_FIRST);

  const latestByObject = byObject(latest);
  const checkByObject = byObject<ReportFact>(latestChecks);
  const findingByObject = byObject<ReportFact>(findings);
  const newestCheckByObject = byObject<ReportFact>(newestChecks);

  const ids = new Set<string>([
    ...latestByObject.keys(),
    ...findingByObject.keys(),
    ...newestCheckByObject.keys(),
  ]);
  const result = new Map<string, ObjectVerificationFacts>();
  for (const objectId of ids) {
    const snapshot = latestByObject.get(objectId);
    const finding = findingByObject.get(objectId) ?? null;
    const newestCheck = newestCheckByObject.get(objectId) ?? null;
    result.set(objectId, {
      latestSnapshot: snapshot
        ? { id: snapshot.id, sequence: snapshot.sequence, completedAt: snapshot.completedAt }
        : null,
      verification: objectVerificationOf({
        latestSnapshotId: snapshot?.id ?? null,
        latestCheck: checkByObject.get(objectId) ?? null,
        latestFinding: finding,
        newestCheck,
      }),
      newest: newestOf(newestCheck, finding),
    });
  }
  return result;
}

/**
 * The verification of each listed snapshot, keyed by snapshot id, in three
 * queries. Runs inside the caller's tenant-pinned transaction.
 */
export async function loadSnapshotVerifications(
  tx: DbExecutor,
  tenantId: string,
  listed: readonly { id: string; objectId: string }[],
): Promise<Map<string, SnapshotVerificationDto>> {
  const result = new Map<string, SnapshotVerificationDto>();
  if (listed.length === 0) {
    return result;
  }
  const snapshotIds = [...new Set(listed.map((snapshot) => snapshot.id))];
  const objectIds = [...new Set(listed.map((snapshot) => snapshot.objectId))];
  const ofObjects = and(
    eq(verifyReports.tenantId, tenantId),
    inArray(verifyReports.protectedObjectId, objectIds),
  ) as SQL;
  const checks = await tx
    .selectDistinctOn([verifyReports.snapshotId], reportFactColumns)
    .from(verifyReports)
    .where(
      and(eq(verifyReports.tenantId, tenantId), inArray(verifyReports.snapshotId, snapshotIds)),
    )
    .orderBy(verifyReports.snapshotId, ...NEWEST_FIRST);
  const findings = await tx
    .selectDistinctOn([verifyReports.protectedObjectId], reportFactColumns)
    .from(verifyReports)
    .where(and(ofObjects, storageFinding()))
    .orderBy(verifyReports.protectedObjectId, ...NEWEST_FIRST);
  const newestChecks = await tx
    .selectDistinctOn([verifyReports.protectedObjectId], reportFactColumns)
    .from(verifyReports)
    .where(and(ofObjects, check()))
    .orderBy(verifyReports.protectedObjectId, ...NEWEST_FIRST);
  const checkBySnapshot = new Map<string, ReportFact>();
  for (const row of checks) {
    if (row.snapshotId) {
      checkBySnapshot.set(row.snapshotId, row);
    }
  }
  const findingByObject = byObject<ReportFact>(findings);
  const newestCheckByObject = byObject<ReportFact>(newestChecks);
  for (const snapshot of listed) {
    result.set(
      snapshot.id,
      snapshotVerificationOf(
        checkBySnapshot.get(snapshot.id) ?? null,
        findingByObject.get(snapshot.objectId) ?? null,
        newestCheckByObject.get(snapshot.objectId)?.checkedAt ?? null,
      ),
    );
  }
  return result;
}
