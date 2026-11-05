/**
 * The OneDrive's own size signal for the restore check (verify/source.ts): the root folder's
 * `size` and `folder.childCount`, measured at the start of the run and, when the snapshot
 * about to be committed holds no content, again at its end, plus the quota for display.
 *
 * A measurement that fails (throttled, refused, a 404) gives no signal and never fails the
 * backup; only a cancellation ends the run.
 */
import { JobAbortedError } from "../../engine/chunkstore.js";
import type { JobContext, Logger } from "../../engine/types.js";
import type { GraphClient } from "../../graph/client.js";
import { getDriveQuota, getDriveRoot } from "../../graph/resources/drive.js";
import type { DriveMeasure, DriveQuotaInfo } from "../../manifest.js";

function rethrowIfAborted(ctx: Pick<JobContext, "signal">, error: unknown): void {
  if (error instanceof JobAbortedError) {
    throw error;
  }
  if (ctx.signal.aborted) {
    throw new JobAbortedError();
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The root folder of `driveId` as a measure, or null when Graph did not say. */
export async function measureDriveRoot(
  ctx: Pick<JobContext, "signal" | "now">,
  client: GraphClient,
  driveId: string,
  logger: Logger,
): Promise<DriveMeasure | null> {
  try {
    const root = await getDriveRoot(client, driveId);
    if (root.size === null || root.size < 0) {
      logger.info("drive root has no size, no source signal");
      return null;
    }
    return {
      rootBytes: root.size,
      rootChildren: Math.max(0, root.childCount ?? 0),
      at: ctx.now().getTime(),
    };
  } catch (error) {
    rethrowIfAborted(ctx, error);
    logger.info("drive root could not be measured, no source signal", {
      reason: describe(error),
    });
    return null;
  }
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** The drive's quota for the details view, or null when Graph did not say. */
export async function readDriveQuota(
  ctx: Pick<JobContext, "signal">,
  client: GraphClient,
  driveId: string,
  logger: Logger,
): Promise<DriveQuotaInfo | null> {
  try {
    const quota = await getDriveQuota(client, driveId);
    if (!quota) {
      return null;
    }
    return {
      used: numberOrNull(quota.used),
      deleted: numberOrNull(quota.deleted),
      remaining: numberOrNull(quota.remaining),
      total: numberOrNull(quota.total),
      state: typeof quota.state === "string" ? quota.state : null,
    };
  } catch (error) {
    rethrowIfAborted(ctx, error);
    logger.info("drive quota could not be read", { reason: describe(error) });
    return null;
  }
}

/** What the engine hands the run: the first measure, and how to take the second. */
export interface DriveSourceProbe {
  readonly before: DriveMeasure | null;
  measureAfter(): Promise<{ after: DriveMeasure | null; quota: DriveQuotaInfo | null }>;
}

/** Measure the drive once now and offer the end-of-run measure. */
export async function probeDriveSource(
  ctx: Pick<JobContext, "signal" | "now">,
  client: GraphClient,
  driveId: string,
  logger: Logger,
): Promise<DriveSourceProbe> {
  const before = await measureDriveRoot(ctx, client, driveId, logger);
  return {
    before,
    measureAfter: async () => ({
      after: await measureDriveRoot(ctx, client, driveId, logger),
      quota: await readDriveQuota(ctx, client, driveId, logger),
    }),
  };
}
