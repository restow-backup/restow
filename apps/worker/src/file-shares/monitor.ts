/**
 * `file-share-monitor` (every minute, docs/FILESHARES.md 8.3): runs whose runner went quiet,
 * vanished or ran out of time, cancellations, finishes nobody processed, and the storage
 * budgets. A run is a database row and a runner container, never a pg-boss job, so none of this
 * rests on pg-boss' job expiry: a 40-hour first backup of a large share is ordinary.
 *
 *   starting   more than 5 minutes without a session call: ask the mounter; exited: fail with
 *              its exit (`share.runner_failed`, `share.out_of_memory`); still running: stop it
 *              and fail; unknown: `share.runner_lost`
 *   running    no progress for 10 minutes: ask the mounter; exited without a finish:
 *              `share.runner_failed`; unknown: `share.runner_lost`; alive but silent for 30
 *              minutes: stop it, `share.runner_stalled`
 *   deadline   past it: the mounter has stopped it or is told to; `share.timeout`
 *   cancel     requested more than 2 minutes ago and still running: stop it, `cancelled`
 *   finish     recorded by the api more than 2 minutes ago and not processed: process it
 *   budget     `file_share.storage_quota` at 80 and at 100 percent, once each, re-armed below 70
 */
import {
  type FailureCause,
  type RunnerRunDetail,
  RunnerUnavailableError,
  redactSensitiveText,
  runnerExitCause,
  shareBudgetBytes,
  shareCause,
  shareQuotaAlert,
  shareQuotaPercent,
  tenantShareBudgetBytes,
} from "@restow/core";
import { type FileShare, type FileShareRun, fileShareRuns, fileShares, tenants } from "@restow/db";
import { and, eq, inArray, isNotNull, isNull, lt } from "drizzle-orm";
import { withTenantTx } from "../handlers/framework.js";
import { raiseEvents } from "../reporting.js";
import { type FileShareDeps, loadFileShareSettings, reportableMessage } from "./common.js";
import { endRun, processFinish } from "./finish.js";

const MINUTE = 60_000;
export const STARTING_LIMIT_MS = 5 * MINUTE;
export const SILENCE_CHECK_MS = 10 * MINUTE;
export const STALL_LIMIT_MS = 30 * MINUTE;
export const CANCEL_GRACE_MS = 2 * MINUTE;
export const FINISH_GRACE_MS = 2 * MINUTE;

export interface FileShareMonitorSummary {
  failed: number;
  stopped: number;
  cancelled: number;
  processed: number;
  quotaAlerts: number;
}

/** The cause of a runner that ended without a finish report. */
function exitCause(detail: RunnerRunDetail): FailureCause {
  const code = runnerExitCause(detail) ?? "share.runner_failed";
  return shareCause(code as FailureCause["code"], {
    exitCode: detail.exitCode,
    params: typeof detail.exitCode === "number" ? { exitCode: detail.exitCode } : {},
    detail: detail.stderrTail ? redactSensitiveText(detail.stderrTail).slice(-500) : null,
  });
}

async function stop(deps: FileShareDeps, runId: string): Promise<void> {
  try {
    await deps.runner.stop(runId);
  } catch (error) {
    deps.runtime.logger.warn("the mounter could not stop a file share runner", {
      runId,
      errorMessage: reportableMessage(error),
    });
  }
}

/** What the mounter knows about a run: its detail, null when unknown, "unavailable". */
async function askMounter(
  deps: FileShareDeps,
  runId: string,
): Promise<RunnerRunDetail | null | "unavailable"> {
  try {
    return await deps.runner.get(runId);
  } catch (error) {
    if (error instanceof RunnerUnavailableError) {
      return "unavailable";
    }
    throw error;
  }
}

async function watchRun(
  deps: FileShareDeps,
  run: FileShareRun,
  now: Date,
  summary: FileShareMonitorSummary,
): Promise<void> {
  const nowMs = now.getTime();
  // Past the deadline: the mounter kills it at its deadline label; told again here.
  if (run.tokenExpiresAt && run.tokenExpiresAt.getTime() <= nowMs) {
    await stop(deps, run.id);
    if (await endRun(deps, run, { status: "failed", cause: shareCause("share.timeout") }, now)) {
      summary.failed++;
    }
    return;
  }
  if (run.cancelRequestedAt && nowMs - run.cancelRequestedAt.getTime() > CANCEL_GRACE_MS) {
    await stop(deps, run.id);
    if (await endRun(deps, run, { status: "cancelled", message: "cancelled in Restow" }, now)) {
      summary.cancelled++;
    }
    return;
  }
  const since = (run.lastProgressAt ?? run.startedAt ?? run.queuedAt).getTime();
  const quiet = nowMs - since;
  const limit = run.status === "starting" ? STARTING_LIMIT_MS : SILENCE_CHECK_MS;
  if (quiet <= limit) {
    return;
  }
  const detail = await askMounter(deps, run.id);
  if (detail === "unavailable") {
    // Without the mounter nothing can be told; the next pass asks again.
    return;
  }
  if (detail === null) {
    if (
      await endRun(deps, run, { status: "failed", cause: shareCause("share.runner_lost") }, now)
    ) {
      summary.failed++;
    }
    return;
  }
  if (detail.state === "exited") {
    // A finish may be on its way through the api; give it a moment after the exit.
    const exited = detail.finishedAt ? Date.parse(detail.finishedAt) : nowMs;
    if (nowMs - exited < FINISH_GRACE_MS) {
      return;
    }
    const cause = exitCause(detail);
    if (
      await endRun(
        deps,
        run,
        {
          status: "failed",
          cause,
          logTail: detail.stderrTail ? redactSensitiveText(detail.stderrTail).slice(-8000) : null,
        },
        now,
      )
    ) {
      summary.failed++;
    }
    return;
  }
  if (run.status === "starting") {
    // Running for five minutes without ever asking for its session.
    await stop(deps, run.id);
    summary.stopped++;
    if (
      await endRun(
        deps,
        run,
        {
          status: "failed",
          cause: shareCause("share.runner_failed", {
            detail: "the runner never asked for its session",
          }),
        },
        now,
      )
    ) {
      summary.failed++;
    }
    return;
  }
  if (quiet > STALL_LIMIT_MS) {
    await stop(deps, run.id);
    summary.stopped++;
    if (
      await endRun(deps, run, { status: "failed", cause: shareCause("share.runner_stalled") }, now)
    ) {
      summary.failed++;
    }
  }
}

/** The storage budget alerts of every share of active tenants (7.4). */
async function budgetAlerts(deps: FileShareDeps, now: Date): Promise<number> {
  const settings = await loadFileShareSettings(deps);
  const rows = await deps.providerDb
    .select({ share: fileShares })
    .from(fileShares)
    .innerJoin(tenants, eq(tenants.id, fileShares.tenantId))
    .where(and(eq(tenants.status, "active"), isNull(fileShares.retiredAt)));
  const byTenant = new Map<string, FileShare[]>();
  for (const { share } of rows) {
    byTenant.set(share.tenantId, [...(byTenant.get(share.tenantId) ?? []), share]);
  }
  let raised = 0;
  for (const [tenantId, shares] of byTenant) {
    const tenantUsed = shares.reduce((sum, share) => sum + (share.repositoryBytes ?? 0), 0);
    const tenantBudget = tenantShareBudgetBytes(settings, tenantId);
    for (const share of shares) {
      const usage = {
        shareUsed: share.repositoryBytes ?? 0,
        shareBudget: shareBudgetBytes(share.quotaGib),
        tenantUsed,
        tenantBudget,
      };
      const decision = shareQuotaAlert(share.quotaAlertLevel, usage);
      if (decision.kind === "none") {
        continue;
      }
      await withTenantTx(deps.db, tenantId, async (tx) => {
        if (decision.kind === "clear") {
          await tx
            .update(fileShares)
            .set({ quotaAlertLevel: null, quotaAlertedAt: null })
            .where(eq(fileShares.id, share.id));
          return;
        }
        const percent = shareQuotaPercent(usage) ?? 100;
        await raiseEvents(
          tx,
          [
            {
              tenantId,
              level: "warning",
              event: "file_share.storage_quota",
              message:
                decision.level === "exceeded"
                  ? `The storage budget for the backups of the file share ${share.name} is used up; new backups are refused.`
                  : `The backups of the file share ${share.name} use ${percent} percent of their storage budget.`,
              details: {
                fileShareId: share.id,
                objectName: share.name,
                level: decision.level,
                percent,
                usedBytes: usage.shareUsed,
                budgetBytes: usage.shareBudget,
                tenantUsedBytes: tenantUsed,
                tenantBudgetBytes: tenantBudget,
              },
            },
          ],
          now,
        );
        await tx
          .update(fileShares)
          .set({ quotaAlertLevel: decision.level, quotaAlertedAt: now })
          .where(eq(fileShares.id, share.id));
        raised++;
      });
    }
  }
  return raised;
}

export async function fileShareMonitor(deps: FileShareDeps): Promise<FileShareMonitorSummary> {
  const now = deps.runtime.now();
  const summary: FileShareMonitorSummary = {
    failed: 0,
    stopped: 0,
    cancelled: 0,
    processed: 0,
    quotaAlerts: 0,
  };
  const open = await deps.providerDb
    .select()
    .from(fileShareRuns)
    .where(inArray(fileShareRuns.status, ["starting", "running"]));
  for (const run of open) {
    try {
      await watchRun(deps, run, now, summary);
    } catch (error) {
      deps.runtime.logger.warn("a file share run could not be checked", {
        runId: run.id,
        errorMessage: reportableMessage(error),
      });
    }
  }
  // A queued run cancelled before it started ends at once.
  const cancelledQueued = await deps.providerDb
    .select({ id: fileShareRuns.id, tenantId: fileShareRuns.tenantId })
    .from(fileShareRuns)
    .where(and(eq(fileShareRuns.status, "queued"), isNotNull(fileShareRuns.cancelRequestedAt)));
  for (const run of cancelledQueued) {
    if (
      await endRun(deps, run, { status: "cancelled", message: "cancelled before it started" }, now)
    ) {
      summary.cancelled++;
    }
  }
  const unprocessed = await deps.providerDb
    .select({ id: fileShareRuns.id, tenantId: fileShareRuns.tenantId })
    .from(fileShareRuns)
    .where(
      and(
        isNotNull(fileShareRuns.finishedAt),
        isNull(fileShareRuns.finishProcessedAt),
        lt(fileShareRuns.finishedAt, new Date(now.getTime() - FINISH_GRACE_MS)),
      ),
    )
    .limit(200);
  for (const run of unprocessed) {
    if (await processFinish(deps, run.tenantId, run.id, now)) {
      summary.processed++;
    }
  }
  summary.quotaAlerts = await budgetAlerts(deps, now);
  return summary;
}
