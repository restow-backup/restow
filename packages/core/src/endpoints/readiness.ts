/**
 * Recovery readiness of an endpoint (pure, no I/O), on the rule every other
 * object follows (apps/api features/verify/verification-state.ts): the rating
 * belongs to the backup it checked. A backup taken after a green test is
 * `unverified` until a test of that backup ran; a backup without a proven
 * restore counts as failed (docs/TESTING.md), so it is never shown as fine.
 *
 *   no_backup    no good backup yet
 *   unverified   a backup exists, no restore test of it
 *   green        a restore test of the newest backup matched every hash
 *   yellow       green, but the backup itself was partial (some files unreadable)
 *   red          a restore test of the newest backup failed, or a newer
 *                repository check found damage
 */

export type EndpointReadiness = "green" | "yellow" | "red";
export type EndpointState = EndpointReadiness | "unverified" | "no_backup";

export interface ReadinessReportFact {
  kind: "restore_test" | "repository_check" | "retention";
  origin: "server" | "agent";
  snapshotId: string | null;
  readiness: EndpointReadiness | null;
  checkedAt: Date;
}

export interface EndpointReadinessInput {
  /** The newest good backup's snapshot; null without one. */
  latestSnapshotId: string | null;
  /** That backup ended `partial` (a snapshot exists, some files could not be read). */
  latestBackupPartial: boolean;
  reports: readonly ReadinessReportFact[];
}

export interface EndpointReadinessResult {
  state: EndpointState;
  /** When the rating was established; null while unverified. */
  checkedAt: Date | null;
  /** Why: the restore test or the repository check that decided. */
  basis: "restore_test" | "repository_check" | null;
}

const byNewest = (a: ReadinessReportFact, b: ReadinessReportFact): number =>
  b.checkedAt.getTime() - a.checkedAt.getTime();

/** Restore tests older than this many days are overdue (the same 8 days the mailbox rule uses). */
export const ENDPOINT_VERIFY_OVERDUE_DAYS = 8;

export function endpointReadiness(input: EndpointReadinessInput): EndpointReadinessResult {
  if (input.latestSnapshotId === null) {
    return { state: "no_backup", checkedAt: null, basis: null };
  }
  const tests = input.reports
    .filter(
      (report) =>
        report.kind === "restore_test" &&
        report.snapshotId === input.latestSnapshotId &&
        report.readiness !== null,
    )
    .sort(byNewest);
  // The newest test of each origin (server reading the repository, agent restoring).
  const newestPerOrigin = new Map<string, ReadinessReportFact>();
  for (const test of tests) {
    if (!newestPerOrigin.has(test.origin)) {
      newestPerOrigin.set(test.origin, test);
    }
  }
  const newestTest = tests[0] ?? null;
  const check = input.reports
    .filter((report) => report.kind === "repository_check")
    .sort(byNewest)[0];

  const failedTest = [...newestPerOrigin.values()].find((test) => test.readiness === "red");
  if (failedTest) {
    return { state: "red", checkedAt: failedTest.checkedAt, basis: "restore_test" };
  }
  // Damage found after the last test invalidates what that test proved.
  if (
    check?.readiness === "red" &&
    (newestTest === null || check.checkedAt.getTime() > newestTest.checkedAt.getTime())
  ) {
    return { state: "red", checkedAt: check.checkedAt, basis: "repository_check" };
  }
  if (newestPerOrigin.size > 0 && newestTest) {
    return {
      state: input.latestBackupPartial ? "yellow" : "green",
      checkedAt: newestTest.checkedAt,
      basis: "restore_test",
    };
  }
  return { state: "unverified", checkedAt: null, basis: null };
}

/** Whether a rating is older than the overdue limit at `now`. */
export function endpointVerifyOverdue(checkedAt: Date | null, now: Date): boolean {
  return (
    checkedAt !== null &&
    now.getTime() - checkedAt.getTime() > ENDPOINT_VERIFY_OVERDUE_DAYS * 24 * 60 * 60 * 1000
  );
}
