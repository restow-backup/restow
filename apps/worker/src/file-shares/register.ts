/**
 * File share backup in the worker (docs/FILESHARES.md 8): its own pg-boss queues (like the
 * endpoint jobs), consumed here, and the dispatcher loop that starts runs through the mounter.
 */
import {
  FILE_SHARE_QUEUES,
  FILE_SHARE_QUEUE_SETTINGS,
  type FileShareBackupPayload,
  type FileShareCopyPayload,
  type FileShareFinishPayload,
  type FileShareJobPayload,
  type FileShareQueue,
} from "@restow/core";
import { EndpointRepositoryBusyError, retryConcurrentSetup } from "@restow/db";
import type PgBoss from "pg-boss";
import { isUuid } from "../handlers/framework.js";
import { shareCatalog } from "./catalog.js";
import { type FileShareDeps, reportableMessage } from "./common.js";
import { startFileShareDispatcher } from "./dispatch.js";
import { processFinish } from "./finish.js";
import {
  ShareRestoreCheckIncompleteError,
  shareCheck,
  shareRetention,
  shareVerify,
} from "./maintenance.js";
import { fileShareMonitor } from "./monitor.js";
import { purgeShare } from "./purge.js";
import { queueShareBackup, queueShareCopy } from "./queue.js";

function record(data: unknown): Record<string, unknown> {
  return (data ?? {}) as Record<string, unknown>;
}

function sharePayload(data: unknown): FileShareJobPayload {
  const value = record(data);
  if (!isUuid(value.tenantId) || !isUuid(value.fileShareId)) {
    throw new Error("file share job payload needs tenantId and fileShareId");
  }
  return value as unknown as FileShareJobPayload;
}

function backupPayload(data: unknown): FileShareBackupPayload {
  const value = record(data);
  if (!isUuid(value.tenantId) || !isUuid(value.fileShareId)) {
    throw new Error("file share backup payload needs tenantId and fileShareId");
  }
  const trigger =
    value.trigger === "manual" || value.trigger === "retry" ? value.trigger : "schedule";
  return {
    tenantId: value.tenantId,
    fileShareId: value.fileShareId,
    backupJobId: isUuid(value.backupJobId) ? value.backupJobId : null,
    trigger,
  };
}

function copyPayload(data: unknown): FileShareCopyPayload {
  const value = record(data);
  if (!isUuid(value.tenantId) || !isUuid(value.backupJobId)) {
    throw new Error("file share copy payload needs tenantId and backupJobId");
  }
  return { tenantId: value.tenantId, backupJobId: value.backupJobId, force: value.force === true };
}

function finishPayload(data: unknown): FileShareFinishPayload {
  const value = record(data);
  if (!isUuid(value.tenantId) || !isUuid(value.runId)) {
    throw new Error("file share finish payload needs tenantId and runId");
  }
  return { tenantId: value.tenantId, runId: value.runId };
}

/** Create the queues (the scheduler creates the same ones at start; a race is retried). */
export async function createFileShareQueues(boss: PgBoss): Promise<void> {
  for (const settings of Object.values(FILE_SHARE_QUEUE_SETTINGS)) {
    await retryConcurrentSetup(async () => {
      await boss.createQueue(settings.name, { ...settings });
      await boss.updateQueue(settings.name, { ...settings });
    });
  }
}

/** Create the queues, consume them and start the dispatcher; returns a stop function. */
export async function registerFileShareJobs(
  boss: PgBoss,
  deps: FileShareDeps,
  options: { pollingIntervalSeconds?: number; dispatchIntervalMs?: number } = {},
): Promise<() => void> {
  const { logger } = deps.runtime;
  await createFileShareQueues(boss);
  const work = async (
    queue: FileShareQueue,
    run: (job: PgBoss.Job<unknown>) => Promise<unknown>,
  ) => {
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
          if (error instanceof EndpointRepositoryBusyError) {
            logger.warn("file share repository busy with other server work, job will retry", {
              queue,
            });
          } else if (error instanceof ShareRestoreCheckIncompleteError) {
            logger.warn("file share restore check could not complete, job will retry", {
              queue,
              reason: error.reason,
            });
          } else {
            logger.error("file share job failed", {
              queue,
              errorMessage: reportableMessage(error),
            });
          }
          throw error;
        }
      },
    );
  };
  const withBoss: FileShareDeps = { ...deps, boss: deps.boss ?? boss };
  await work(FILE_SHARE_QUEUES.backup, (job) =>
    queueShareBackup(withBoss, backupPayload(job.data)),
  );
  await work(FILE_SHARE_QUEUES.copy, (job) => queueShareCopy(withBoss, copyPayload(job.data)));
  await work(FILE_SHARE_QUEUES.finish, (job) => {
    const payload = finishPayload(job.data);
    return processFinish(withBoss, payload.tenantId, payload.runId);
  });
  await work(FILE_SHARE_QUEUES.retention, (job) =>
    shareRetention(withBoss, sharePayload(job.data)),
  );
  await work(FILE_SHARE_QUEUES.check, (job) => shareCheck(withBoss, sharePayload(job.data)));
  await work(FILE_SHARE_QUEUES.verify, (job) => shareVerify(withBoss, sharePayload(job.data)));
  await work(FILE_SHARE_QUEUES.catalog, (job) => shareCatalog(withBoss, sharePayload(job.data)));
  await work(FILE_SHARE_QUEUES.purge, (job) => purgeShare(withBoss, sharePayload(job.data)));
  await work(FILE_SHARE_QUEUES.monitor, async () => {
    const summary = await fileShareMonitor(withBoss);
    if (Object.values(summary).some((count) => count > 0)) {
      logger.info("file share monitor pass", { ...summary });
    }
  });
  const stop = startFileShareDispatcher(withBoss, options.dispatchIntervalMs);
  logger.info("file share queues ready", {
    queues: Object.values(FILE_SHARE_QUEUES),
    mounter: deps.runner.enabled,
  });
  return stop;
}
