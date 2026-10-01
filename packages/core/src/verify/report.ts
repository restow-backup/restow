/**
 * The persisted shape of a readiness report (`verify_reports.details`).
 *
 * Two producers write reports: the verify job (a sampled or complete read-back
 * of the latest snapshot) and the scrub job (which files a red report for
 * every object whose data sits in a pack it found corrupt and could not
 * repair). Both carry the same reason vocabulary so the UI renders them alike.
 * The format is versioned; readers must tolerate unknown fields.
 */
import type { VerifyKind } from "../engine/types.js";
import type { FailureCause } from "../failures/types.js";
import type { ItemCheck, ItemCheckStatus } from "./check.js";
import type { TestRestoreOutcome } from "./probe.js";
import type { ReadinessReason } from "./readiness.js";
import type { CategoryCounts, SampleQuota } from "./sampling.js";
import type { ScrubFindingDetails } from "./scrub.js";

export const READINESS_REPORT_FORMAT = 1;

/** Cap on listed items for complete (health check) runs; failures are listed first. */
export const MAX_LISTED_ITEMS = 500;

export type ReportSnapshotRef = {
  id: string;
  sequence: number;
  /** ISO 8601 completion time of the snapshot. */
  completedAt: string | null;
  itemCount: number;
  /**
   * Packs the manifest recorded at backup time. Informational: garbage
   * collection may have moved the chunks into other packs since.
   */
  packCount: number;
};

export type VerifyCounts = {
  eligible: CategoryCounts;
  sampled: CategoryCounts;
  checked: number;
  bytesRead: number;
} & Record<ItemCheckStatus, number>;

export type VerifyReportDetails = {
  format: typeof READINESS_REPORT_FORMAT;
  origin: "verify";
  kind: VerifyKind;
  /** `sample` draws per category (weekly proof); `all` reads every eligible object. */
  scope: "sample" | "all";
  /** Seed of the sample draw, to replay exactly which items were chosen. */
  seed: number | null;
  quota: SampleQuota | null;
  snapshot: ReportSnapshotRef | null;
  reasons: ReadinessReason[];
  /** Why the manifest of the latest snapshot could not be read, when it could not. */
  manifestCause?: FailureCause;
  counts: VerifyCounts;
  items: ItemCheck[];
  /** Checked and counted, but not listed (complete runs list failures only). */
  itemsOmitted: number;
  /**
   * Packs the latest scrub reported corrupt that hold chunks of the snapshot
   * now, resolved through the chunk index.
   */
  damagedPacks: string[];
  testRestore: TestRestoreOutcome | null;
  startedAt: string;
  durationMs: number;
};

/** Everything that lands in `verify_reports.details`. */
export type ReadinessReportDetails = VerifyReportDetails | ScrubFindingDetails;

/** Which items a report lists: all of a sample; failures only (capped) of a complete run. */
export function listedItems(
  checks: readonly ItemCheck[],
  scope: VerifyReportDetails["scope"],
  cap: number = MAX_LISTED_ITEMS,
): { items: ItemCheck[]; omitted: number } {
  if (scope === "sample") {
    return { items: [...checks], omitted: 0 };
  }
  const failures = checks.filter((check) => check.status !== "verified").slice(0, cap);
  return { items: failures, omitted: checks.length - failures.length };
}
