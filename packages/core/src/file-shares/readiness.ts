/**
 * Recovery readiness of a file share (docs/FILESHARES.md 8.4): a thin layer over the endpoint
 * rule (../endpoints/readiness.ts). The rating belongs to the restore point it checked: the
 * newest restore point is `unverified` until its restore check ran; green when every sample
 * matched (yellow when that backup ended with warnings), red when the check failed or a newer
 * repository check found damage. Overdue after the same 8 days.
 */
import {
  ENDPOINT_VERIFY_OVERDUE_DAYS,
  type EndpointReadinessResult,
  type ReadinessReportFact,
  endpointReadiness,
  endpointVerifyOverdue,
} from "../endpoints/readiness.js";

export type ShareReadinessResult = EndpointReadinessResult;

export interface ShareReadinessReport {
  kind: "restore_test" | "repository_check" | "retention";
  /** The restic snapshot id a restore check read. */
  snapshotId: string | null;
  readiness: "green" | "yellow" | "red" | null;
  checkedAt: Date;
}

export interface ShareReadinessInput {
  /** The restic snapshot id of the newest good restore point; null without one. */
  latestResticSnapshotId: string | null;
  /** That backup ended with warnings. */
  latestBackupWarning: boolean;
  reports: readonly ShareReadinessReport[];
}

export const SHARE_VERIFY_OVERDUE_DAYS = ENDPOINT_VERIFY_OVERDUE_DAYS;

export function shareReadiness(input: ShareReadinessInput): ShareReadinessResult {
  return endpointReadiness({
    latestSnapshotId: input.latestResticSnapshotId,
    latestBackupPartial: input.latestBackupWarning,
    reports: input.reports.map(
      (report): ReadinessReportFact => ({
        kind: report.kind,
        origin: "server",
        snapshotId: report.snapshotId,
        readiness: report.readiness,
        checkedAt: report.checkedAt,
      }),
    ),
  });
}

/** Whether the rating is older than the overdue limit at `now`. */
export function shareVerifyOverdue(checkedAt: Date | null, now: Date): boolean {
  return endpointVerifyOverdue(checkedAt, now);
}

/** Whether a restore point counts as verified for a copy job (4.10): a green restore check. */
export function isVerifiedRestorePoint(
  resticSnapshotId: string,
  reports: readonly Pick<ShareReadinessReport, "kind" | "snapshotId" | "readiness" | "checkedAt">[],
): boolean {
  const tests = reports
    .filter((report) => report.kind === "restore_test" && report.snapshotId === resticSnapshotId)
    .sort((a, b) => b.checkedAt.getTime() - a.checkedAt.getTime());
  const newest = tests[0];
  return newest !== undefined && (newest.readiness === "green" || newest.readiness === "yellow");
}
