/**
 * Verification reasons as failure causes.
 *
 * A verification report already carries machine-coded reasons (verify/
 * readiness.ts). Mapping them onto failure causes lets the UI explain a red or
 * yellow rating with the same what/why/what-to-do component as a failed job,
 * and works for reports written before failure records existed.
 */
import type { ReadinessReason, ReadinessReasonCode } from "../verify/readiness.js";
import { buildCause } from "./classify.js";
import type { FailureCause, FailureCode, FailureParams } from "./types.js";

const REASON_CODES: Readonly<Record<ReadinessReasonCode, FailureCode>> = {
  no_snapshot: "verify.no_snapshot",
  manifest_unreadable: "verify.manifest_unreadable",
  manifest_missing: "verify.manifest_missing",
  items_missing: "verify.chunk_missing",
  items_unreadable: "verify.pack_unreadable",
  items_mismatched: "verify.hash_mismatch",
  storage_corrupt: "verify.storage_corrupt",
  storage_unreadable: "verify.storage_unreadable",
  storage_unreadable_persistent: "verify.storage_unreadable_persistent",
  test_restore_failed: "verify.restore_test_failed",
  snapshot_outdated: "verify.snapshot_outdated",
  snapshot_stale: "verify.snapshot_stale",
  snapshot_empty: "verify.snapshot_empty",
  snapshot_empty_confirmed_by_source: "verify.snapshot_empty_source",
  backup_missing_source_content: "verify.backup_missing_source_content",
  nothing_to_verify: "verify.nothing_to_verify",
  test_restore_unconfirmed: "verify.restore_test_unconfirmed",
  backup_incomplete: "verify.backup_incomplete",
  backup_incomplete_persistent: "verify.backup_incomplete_persistent",
  check_incomplete: "verify.check_incomplete",
};

/** The failure cause a readiness reason stands for, or null for a reason code this build does not know. */
export function causeOfReadinessReason(reason: {
  code: string;
  count?: number | null;
  ageHours?: number | null;
  bytes?: number | null;
}): FailureCause | null {
  const code = (REASON_CODES as Readonly<Record<string, FailureCode | undefined>>)[reason.code];
  if (!code) {
    return null;
  }
  const params: FailureParams = {};
  if (typeof reason.count === "number") {
    params.count = reason.count;
  }
  if (typeof reason.ageHours === "number") {
    params.ageHours = reason.ageHours;
  }
  if (typeof reason.bytes === "number") {
    params.bytes = reason.bytes;
  }
  return buildCause(code, params);
}

/** Convenience for the worker: causes for every reason of an assessment. */
export function causesOfReasons(reasons: readonly ReadinessReason[]): FailureCause[] {
  return reasons.flatMap((reason) => {
    const cause = causeOfReadinessReason(reason);
    return cause ? [cause] : [];
  });
}
