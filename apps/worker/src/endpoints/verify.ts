/**
 * `endpoint-verify`: the restore test of an endpoint's newest backup
 * (docs/AGENT.md, readiness).
 *
 * After every good backup the agent reports the SHA-256 of up to 20 random
 * files (`endpoint_samples`). This job reads those files back from the
 * repository with `restic dump`, hashes them and compares. Only matching
 * hashes rate the snapshot green; red needs proof (below). It also hands the
 * same files to the agent as a `verify_sample` task, so the endpoint itself
 * restores them once and reports back; the agent's result is a second report on
 * the same snapshot, and either one failing keeps the endpoint red.
 *
 * A file that could not be read for a reason that says nothing about the
 * backup (the repository busy, restic stopped, unable to start or to reach the
 * repository, any error restic does not put down to the backup's data) proves
 * nothing: the job fails without a report, pg-boss retries it and the
 * scheduler offers it again every hour until a test completes. Only a hash
 * that differs, or restic reporting the file or its data missing or damaged,
 * rates the snapshot red (@restow/core `isBackupFinding`).
 */
import {
  type EndpointJobPayload,
  RESTORE_TEST_TASK_TTL_MS,
  type RestoreTestResult,
  restoreTestSamples,
  withRepository,
} from "@restow/core";
import { endpointSamples, endpointTasks, endpoints } from "@restow/db";
import { and, eq, inArray } from "drizzle-orm";
import { withTenantTx } from "../handlers/framework.js";
import {
  type EndpointJobDeps,
  openEndpointRepository,
  withMaintenanceLock,
  writeReport,
} from "./common.js";

/** The restore test could not complete; nothing was rated and the job is retried. */
export class RestoreTestIncompleteError extends Error {
  constructor(readonly reason: string) {
    super(`the restore test could not complete and will be retried: ${reason}`);
    this.name = "RestoreTestIncompleteError";
  }
}

/** Green only when every sampled file matched and there was something to test. */
export function ratingOf(result: Pick<RestoreTestResult, "files" | "matched" | "mismatched">) {
  return result.files > 0 && result.mismatched.length === 0 && result.matched === result.files
    ? ("green" as const)
    : ("red" as const);
}

export async function endpointVerify(
  deps: EndpointJobDeps,
  payload: EndpointJobPayload,
): Promise<void> {
  const { tenantId, endpointId } = payload;
  const { logger } = deps.runtime;
  const { endpoint, access } = await openEndpointRepository(deps, tenantId, endpointId);
  const snapshotId = endpoint.lastSnapshotId;
  if (!snapshotId || endpoint.status !== "active") {
    return;
  }
  const samples = await withTenantTx(deps.db, tenantId, (tx) =>
    tx
      .select({
        path: endpointSamples.path,
        sha256: endpointSamples.sha256,
        size: endpointSamples.size,
      })
      .from(endpointSamples)
      .where(
        and(eq(endpointSamples.endpointId, endpointId), eq(endpointSamples.snapshotId, snapshotId)),
      ),
  );
  if (samples.length === 0) {
    logger.info("no samples to restore-test", { tenantId, endpointId, snapshotId });
    return;
  }
  // Shared with the API's reads, never beside retention or the check: a prune that rewrites
  // packs under a running restore test would make sound data look damaged.
  const result = await withMaintenanceLock(deps, endpointId, "shared", () =>
    withRepository(access, (session) =>
      restoreTestSamples(session, snapshotId, samples, { signal: deps.runtime.shutdownSignal }),
    ),
  );
  const now = deps.runtime.now();
  if (result.transient) {
    throw new RestoreTestIncompleteError(result.incomplete ?? "a sampled file could not be read");
  }
  const readiness = ratingOf(result);
  await writeReport(
    deps,
    tenantId,
    {
      endpointId,
      kind: "restore_test",
      origin: "server",
      snapshotId,
      readiness,
      summary: {
        files: result.files,
        matched: result.matched,
        mismatched: result.mismatched.slice(0, 20),
      },
    },
    now,
  );
  await withTenantTx(deps.db, tenantId, async (tx) => {
    await tx.update(endpoints).set({ lastRestoreTestAt: now }).where(eq(endpoints.id, endpointId));
    // The endpoint restores the same files once itself, unless a test for this snapshot waits already.
    const [waiting] = await tx
      .select({ id: endpointTasks.id, params: endpointTasks.params })
      .from(endpointTasks)
      .where(
        and(
          eq(endpointTasks.endpointId, endpointId),
          eq(endpointTasks.kind, "verify_sample"),
          inArray(endpointTasks.status, ["pending", "delivered"]),
        ),
      )
      .limit(1);
    if (!waiting || (waiting.params as { snapshotId?: string }).snapshotId !== snapshotId) {
      await tx.insert(endpointTasks).values({
        tenantId,
        endpointId,
        kind: "verify_sample",
        params: {
          snapshotId,
          files: samples.map((sample) => ({ path: sample.path, sha256: sample.sha256 })),
        },
        // A restore-test task the agent did not pick up expires (a laptop that stayed off).
        expiresAt: new Date(now.getTime() + RESTORE_TEST_TASK_TTL_MS),
      });
    }
  });
  logger.info("endpoint restore test finished", {
    tenantId,
    endpointId,
    snapshotId,
    readiness,
    files: result.files,
    matched: result.matched,
  });
}
