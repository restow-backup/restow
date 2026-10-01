/**
 * Optional test restore: put the sampled items into a real target (a test
 * mailbox or drive of the tenant) through the regular restore engine, and
 * record whether the target confirmed each one.
 *
 * The internal read-back (check.ts) already proves that the stored bytes are
 * intact; the test restore additionally proves that the target system accepts
 * them today (permissions, throttling, API changes). It runs only when the
 * worker supplies a probe for the object, because it needs a configured
 * target and costs Graph or IMAP quota.
 */
import type {
  JobContext,
  ProtectedObjectRef,
  RestoreEngine,
  RestoreRequest,
  RestoreResult,
} from "../engine/types.js";
import { classifyFailure } from "../failures/classify.js";
import type { FailureCause } from "../failures/types.js";
import type { ManifestObject } from "../manifest.js";

export type TestRestoreItemStatus = "confirmed" | "unconfirmed" | "failed";

export type TestRestoreItem = {
  path: string;
  status: TestRestoreItemStatus;
  reason: string | null;
  /** Why the target did not take the item (Graph permission, throttling, ...), when classified. */
  cause?: FailureCause;
};

export type TestRestoreOutcome = {
  /** Where the items were restored to (mailbox address, drive id, IMAP login). */
  target: string;
  items: TestRestoreItem[];
};

export interface RestoreProbe {
  readonly target: string;
  run(
    ctx: JobContext,
    protectedObject: ProtectedObjectRef,
    snapshotId: string,
    sample: readonly ManifestObject[],
  ): Promise<TestRestoreOutcome>;
}

/** Per-item outcome as the restore engines report it (restore/results.ts). */
type ReportedItem = {
  path: string;
  status: "restored" | "skipped" | "failed";
  verified: boolean;
  reason: string | undefined;
  cause?: FailureCause;
};

function reportedItems(result: RestoreResult): ReportedItem[] | null {
  const items = (result as { items?: unknown }).items;
  return Array.isArray(items) ? (items as ReportedItem[]) : null;
}

/** Map a restore engine's report onto the sampled objects. */
export function testRestoreItems(
  sample: readonly ManifestObject[],
  result: RestoreResult,
): TestRestoreItem[] {
  const byPath = new Map((reportedItems(result) ?? []).map((item) => [item.path, item]));
  const failedRefs = new Map(result.failures.map((failure) => [failure.itemRef, failure]));
  return sample.map((object): TestRestoreItem => {
    const reported = byPath.get(object.path);
    if (reported) {
      if (reported.status === "failed") {
        return {
          path: object.path,
          status: "failed",
          reason: reported.reason ?? null,
          ...(reported.cause ? { cause: reported.cause } : {}),
        };
      }
      if (reported.status === "restored" && reported.verified) {
        return { path: object.path, status: "confirmed", reason: null };
      }
      return {
        path: object.path,
        status: "unconfirmed",
        reason: reported.reason ?? "the target did not confirm the restored item",
      };
    }
    const failure = failedRefs.get(object.id ?? object.path) ?? failedRefs.get(object.path);
    if (failure !== undefined) {
      return {
        path: object.path,
        status: "failed",
        reason: failure.reason,
        ...(failure.cause ? { cause: failure.cause } : {}),
      };
    }
    return {
      path: object.path,
      status: "unconfirmed",
      reason: "the restore engine did not report this item",
    };
  });
}

/**
 * A probe over a regular restore engine: the sample goes to `target` as an
 * "other account" restore in rename mode, so nothing in the test target is
 * ever overwritten.
 */
export function restoreEngineProbe(engine: RestoreEngine, target: string): RestoreProbe {
  return {
    target,
    async run(ctx, protectedObject, snapshotId, sample) {
      const request: RestoreRequest = {
        restoreJobId: ctx.jobId,
        snapshotId,
        protectedObject,
        selection: { paths: sample.map((object) => object.path) },
        target: { type: "other", ref: target },
        mode: "rename",
        actor: { userId: null, impersonated: false, reason: "recovery readiness check" },
      };
      const result = await engine.run(ctx, request);
      return { target, items: testRestoreItems(sample, result) };
    },
  };
}
