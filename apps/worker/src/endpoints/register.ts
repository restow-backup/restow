/**
 * Endpoint backup jobs of the worker (docs/AGENT.md): their own pg-boss
 * queues (like the audit anchor), not members of the tenant queues, because
 * they run on an endpoint's repository and not on a protected object.
 */
import {
  ENDPOINT_QUEUE_SETTINGS,
  ENDPOINT_QUEUES,
  type EndpointJobPayload,
  type EndpointQueue,
} from "@restow/core";
import {
  EndpointRecoveryActiveError,
  EndpointRepositoryBusyError,
  retryConcurrentSetup,
} from "@restow/db";
import type PgBoss from "pg-boss";
import { isUuid } from "../handlers/framework.js";
import { BaremetalCheckIncompleteError, endpointBaremetalCheck } from "./baremetal-check.js";
import { endpointCheck } from "./check.js";
import type { EndpointJobDeps } from "./common.js";
import { endpointMonitor } from "./monitor.js";
import { endpointRecoveryIso, RecoveryIsoRetryError } from "./recovery-iso.js";
import { endpointRemoval } from "./removal.js";
import { endpointRetention } from "./retention.js";
import { endpointVerify, RestoreTestIncompleteError } from "./verify.js";

function payloadOf(data: unknown): EndpointJobPayload {
  const record = (data ?? {}) as Record<string, unknown>;
  if (!isUuid(record.tenantId) || !isUuid(record.endpointId)) {
    throw new Error("endpoint job payload needs tenantId and endpointId");
  }
  return record as unknown as EndpointJobPayload;
}

/** Create the queues and start consuming them. */
export async function registerEndpointJobs(
  boss: PgBoss,
  deps: EndpointJobDeps,
  options: { pollingIntervalSeconds?: number } = {},
): Promise<void> {
  const { logger } = deps.runtime;
  for (const settings of Object.values(ENDPOINT_QUEUE_SETTINGS)) {
    // The scheduler creates the same queues at start; a race is retried.
    await retryConcurrentSetup(async () => {
      await boss.createQueue(settings.name, { ...settings });
      await boss.updateQueue(settings.name, { ...settings });
    });
  }
  const work = async <T>(
    queue: EndpointQueue,
    run: (job: PgBoss.Job<unknown>) => Promise<T>,
  ): Promise<void> => {
    await boss.work(
      queue,
      { batchSize: 1, pollingIntervalSeconds: options.pollingIntervalSeconds ?? 5 },
      async ([job]) => {
        if (!job) {
          return;
        }
        try {
          await run(job);
        } catch (error) {
          if (error instanceof EndpointRecoveryActiveError) {
            // A bare metal recovery reads the repository (docs/BAREMETAL.md 9.7): retried later,
            // nothing was rated or counted.
            logger.warn("endpoint repository read by a running recovery, job will retry", {
              queue,
              recoveryId: error.recoveryId,
            });
            throw error;
          }
          if (error instanceof EndpointRepositoryBusyError) {
            // Other server work held the repository: retried later, nothing was rated.
            logger.warn("endpoint repository busy with other server work, job will retry", {
              queue,
            });
            throw error;
          }
          if (error instanceof BaremetalCheckIncompleteError) {
            // The snapshot could not be read for a reason that proves nothing about the backup.
            logger.warn("endpoint bare metal check could not read the snapshot, job will retry", {
              queue,
              reason: error.reason,
            });
            throw error;
          }
          if (error instanceof RecoveryIsoRetryError) {
            // The network or a cut-off download: retried, the next attempt continues the file.
            logger.warn("recovery ISO download will retry", {
              queue,
              problem: error.result.state.problem,
            });
            throw error;
          }
          if (error instanceof RestoreTestIncompleteError) {
            // A sampled file could not be read for a reason that proves nothing about the backup.
            logger.warn("endpoint restore test could not complete, job will retry", {
              queue,
              reason: error.reason,
            });
            throw error;
          }
          logger.error("endpoint job failed", {
            queue,
            errorMessage: error instanceof Error ? error.message.slice(0, 500) : String(error),
          });
          throw error;
        }
      },
    );
  };
  await work(ENDPOINT_QUEUES.retention, (job) => endpointRetention(deps, payloadOf(job.data)));
  await work(ENDPOINT_QUEUES.check, (job) => endpointCheck(deps, payloadOf(job.data)));
  await work(ENDPOINT_QUEUES.verify, (job) => endpointVerify(deps, payloadOf(job.data)));
  await work(ENDPOINT_QUEUES.removal, (job) => endpointRemoval(deps, payloadOf(job.data)));
  await work(ENDPOINT_QUEUES.baremetalCheck, (job) =>
    endpointBaremetalCheck(deps, payloadOf(job.data)),
  );
  await work(ENDPOINT_QUEUES.recoveryIso, () => endpointRecoveryIso(deps));
  await work(ENDPOINT_QUEUES.monitor, async () => {
    const summary = await endpointMonitor(deps);
    if (Object.values(summary).some((count) => count > 0)) {
      logger.info("endpoint monitor pass", { ...summary });
    }
  });
  logger.info("endpoint queues ready", { queues: Object.values(ENDPOINT_QUEUES) });
}
