/**
 * `endpoint-monitor`: the housekeeping and the alerts of endpoint backup
 * (docs/AGENT.md), every five minutes, across all tenants.
 *
 *   - A run that says "running" but has not reported for six hours died with
 *     its agent: it is closed as failed, so it does not stay "running" forever.
 *     A restore test closed this way could not complete: it rates nothing, is
 *     neither alerted nor sent as `job.failed`, and is offered again by the
 *     same rules as one the agent reported incomplete (@restow/core
 *     `restoreTestRetry`).
 *   - Restore tasks nobody picked up in time expire.
 *   - Prepared ZIP downloads (valid for ten minutes) are removed an hour after
 *     they expired, started or not.
 *   - A failed backup or restore run raises `backup.failed` / `restore.failed`,
 *     a failed restore test `verify.red`, a damaged repository `scrub.corrupt`,
 *     a red endpoint that turned green again `verify.recovered`. These are the
 *     events the mailbox jobs already raise, so an existing alert rule covers
 *     endpoints without a change.
 *   - A server silent for more than 2 hours, or a client without a good backup
 *     for 7 days (both configurable per endpoint), raises `endpoint.stale`.
 *   - A repository at 90 percent of its storage budget, or one whose upload was
 *     refused because the budget is used up, raises `endpoint.storage_quota`
 *     (once per level; re-armed below 80 percent). A tenant whose endpoints
 *     together reach 90 percent of the tenant's budget is told once a day.
 *
 * Every alert is raised once: the run, the report or the endpoint carries a
 * mark (`alerted_at`, `stale_alerted_at`) that is set in the same transaction
 * as the notification. The events go through the same outbox as all others
 * (bell, e-mail, webhook, throttled per rule).
 */
import {
  QUOTA_CLEAR_RATIO,
  type RestoreTestTaskParams,
  agentStoppedCause,
  endpointBudgetBytes,
  endpointQuotaLimits,
  endpointStaleness,
  isInterruptedOnly,
  quotaLevelOf,
  quotaRatio,
  restoreTestAlreadyWaiting,
  restoreTestRetry,
  toFailureRecord,
} from "@restow/core";
import {
  type Endpoint,
  type NewNotification,
  endpointDownloads,
  endpointReports,
  endpointRuns,
  endpointTasks,
  endpoints,
  notifications,
  tenants,
} from "@restow/db";
import { and, eq, gt, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { withTenantTx } from "../handlers/framework.js";
import { emitWebhookEvent } from "../handlers/webhooks.js";
import type { TenantTx } from "../progress.js";
import { raiseEvents } from "../reporting.js";
import type { EndpointJobDeps } from "./common.js";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** A running run silent for this long is dead. */
export const RUN_SILENCE_LIMIT_MS = 6 * HOUR_MS;
/** Failures older than this are not announced any more (an outage of the monitor must not flood). */
const ALERT_WINDOW_MS = 3 * DAY_MS;

export interface MonitorSummary {
  abandonedRuns: number;
  expiredTasks: number;
  purgedDownloads: number;
  runAlerts: number;
  reportAlerts: number;
  staleAlerts: number;
  quotaAlerts: number;
}

export function endpointName(endpoint: Pick<Endpoint, "displayName" | "hostname">): string {
  return endpoint.displayName?.trim() || endpoint.hostname;
}

export function staleMessage(
  endpoint: Pick<Endpoint, "displayName" | "hostname" | "profile">,
  reason: "silent" | "backup_overdue",
  limit: { hours?: number; days?: number },
): string {
  const name = endpointName(endpoint);
  return reason === "silent"
    ? `The server ${name} has not reported for more than ${limit.hours ?? 2} hours.`
    : `The client ${name} has had no good backup for more than ${limit.days ?? 7} days.`;
}

/**
 * A restore test whose agent went silent could not complete: it proves nothing
 * about the backup, so it is offered again like one the agent reported
 * incomplete (apps/api `offerRestoreTestAgain`): the same files after the next
 * wait, only for the machine's newest backup, while waits are left, and not
 * when a test of that backup already waits.
 */
async function offerRestoreTestAgain(
  tx: TenantTx,
  run: { tenantId: string; endpointId: string; taskId: string },
  now: Date,
): Promise<boolean> {
  const [task] = await tx
    .select({ params: endpointTasks.params })
    .from(endpointTasks)
    .where(eq(endpointTasks.id, run.taskId))
    .limit(1);
  const [endpoint] = await tx
    .select({ status: endpoints.status, lastSnapshotId: endpoints.lastSnapshotId })
    .from(endpoints)
    .where(eq(endpoints.id, run.endpointId))
    .limit(1);
  if (!task || !endpoint) {
    return false;
  }
  const params = task.params as RestoreTestTaskParams;
  const next = restoreTestRetry(params, endpoint, now);
  if (!next) {
    return false;
  }
  const waiting = await tx
    .select({ id: endpointTasks.id, params: endpointTasks.params })
    .from(endpointTasks)
    .where(
      and(
        eq(endpointTasks.endpointId, run.endpointId),
        eq(endpointTasks.kind, "verify_sample"),
        inArray(endpointTasks.status, ["pending", "delivered"]),
      ),
    );
  if (restoreTestAlreadyWaiting(waiting, next.params.snapshotId, run.taskId)) {
    return false;
  }
  await tx.insert(endpointTasks).values({
    tenantId: run.tenantId,
    endpointId: run.endpointId,
    kind: "verify_sample",
    params: next.params,
    createdAt: now,
    expiresAt: next.expiresAt,
  });
  return true;
}

async function closeAbandonedRuns(deps: EndpointJobDeps, now: Date): Promise<number> {
  const before = new Date(now.getTime() - RUN_SILENCE_LIMIT_MS);
  const dead = await deps.providerDb
    .select({
      id: endpointRuns.id,
      tenantId: endpointRuns.tenantId,
      endpointId: endpointRuns.endpointId,
      kind: endpointRuns.kind,
      taskId: endpointRuns.taskId,
    })
    .from(endpointRuns)
    .where(
      and(
        eq(endpointRuns.status, "running"),
        sql`greatest(${endpointRuns.startedAt}, coalesce((${endpointRuns.progress}->>'updatedAt')::timestamptz, ${endpointRuns.startedAt})) < ${before}`,
      ),
    )
    .limit(200);
  for (const run of dead) {
    await withTenantTx(deps.db, run.tenantId, async (tx) => {
      const [closed] = await tx
        .update(endpointRuns)
        .set({
          status: "failed",
          finishedAt: now,
          progress: null,
          errors: [
            {
              message: "The agent stopped reporting while this run was in progress.",
              code: "agent_stopped",
            },
          ],
          failure: toFailureRecord(agentStoppedCause(), { now }),
        })
        .where(and(eq(endpointRuns.id, run.id), eq(endpointRuns.status, "running")))
        .returning({ id: endpointRuns.id });
      if (run.taskId) {
        await tx
          .update(endpointTasks)
          .set({ status: "failed", finishedAt: now, errorMessage: "agent stopped reporting" })
          .where(eq(endpointTasks.id, run.taskId));
        // Only a run closed here: one the agent finished meanwhile was judged by the API.
        if (closed && run.kind === "verify_sample") {
          await offerRestoreTestAgain(
            tx,
            { tenantId: run.tenantId, endpointId: run.endpointId, taskId: run.taskId },
            now,
          );
        }
      }
    });
  }
  return dead.length;
}

async function expireTasks(deps: EndpointJobDeps, now: Date): Promise<number> {
  const expired = await deps.providerDb
    .update(endpointTasks)
    .set({ status: "failed", finishedAt: now, errorMessage: "expired" })
    .where(and(eq(endpointTasks.status, "pending"), lt(endpointTasks.expiresAt, now)))
    .returning({ id: endpointTasks.id });
  return expired.length;
}

/** Prepared downloads are valid for minutes; their rows are kept for an hour more, then go. */
export const DOWNLOAD_KEEP_MS = HOUR_MS;

async function purgeDownloads(deps: EndpointJobDeps, now: Date): Promise<number> {
  const purged = await deps.providerDb
    .delete(endpointDownloads)
    .where(lt(endpointDownloads.expiresAt, new Date(now.getTime() - DOWNLOAD_KEEP_MS)))
    .returning({ id: endpointDownloads.id });
  return purged.length;
}

async function alertFailedRuns(deps: EndpointJobDeps, now: Date): Promise<number> {
  const since = new Date(now.getTime() - ALERT_WINDOW_MS);
  const rows = await deps.providerDb
    .select({
      run: endpointRuns,
      hostname: endpoints.hostname,
      displayName: endpoints.displayName,
      profile: endpoints.profile,
    })
    .from(endpointRuns)
    .innerJoin(endpoints, eq(endpoints.id, endpointRuns.endpointId))
    .where(
      and(
        eq(endpointRuns.status, "failed"),
        isNull(endpointRuns.alertedAt),
        sql`${endpointRuns.finishedAt} > ${since}`,
      ),
    )
    .limit(200);
  const byTenant = new Map<string, typeof rows>();
  for (const row of rows) {
    byTenant.set(row.run.tenantId, [...(byTenant.get(row.run.tenantId) ?? []), row]);
  }
  let alerts = 0;
  for (const [tenantId, list] of byTenant) {
    const raised: NewNotification[] = [];
    for (const { run, hostname, displayName } of list) {
      // A failed restore test is reported by its report (verify.red), not by the run, and a
      // run the agent only lost to a restart is resumed by it: neither is an alert.
      if (run.kind === "verify_sample" || isInterruptedOnly(run.errors)) {
        continue;
      }
      const name = endpointName({ hostname, displayName });
      const reason = run.errors[0]?.message ?? "";
      const backup = run.kind === "backup";
      raised.push({
        tenantId,
        level: "error",
        event: backup ? "backup.failed" : "restore.failed",
        message: `The ${backup ? "backup" : "restore"} of ${name} failed${reason ? `: ${reason.slice(0, 300)}` : "."}`,
        details: {
          endpointId: run.endpointId,
          objectName: name,
          runId: run.id,
          errorMessage: reason ? reason.slice(0, 500) : null,
          completedAt: run.finishedAt?.toISOString() ?? null,
        },
      });
    }
    await withTenantTx(deps.db, tenantId, async (tx) => {
      await raiseEvents(tx, raised, now);
      await tx
        .update(endpointRuns)
        .set({ alertedAt: now })
        .where(
          inArray(
            endpointRuns.id,
            list.map(({ run }) => run.id),
          ),
        );
    });
    // The agent reports its own failures with a webhook; runs closed here are announced now.
    // A restore test closed here could not complete: it proves nothing, so it is no `job.failed`.
    for (const { run, hostname, displayName, profile } of list) {
      if (
        run.kind !== "verify_sample" &&
        run.errors[0]?.message?.startsWith("The agent stopped reporting")
      ) {
        await emitWebhookEvent(deps.db, {
          tenantId,
          event: "job.failed",
          occurredAt: now,
          data: {
            job: {
              id: run.id,
              queue: `endpoint_${run.kind}`,
              status: "failed",
              protectedObjectId: null,
              startedAt: run.startedAt.toISOString(),
              completedAt: run.finishedAt?.toISOString() ?? null,
              durationMs: null,
              errorMessage: run.errors[0]?.message ?? null,
              failure: run.failure ?? null,
            },
            endpoint: { id: run.endpointId, hostname, displayName, profile },
          },
        }).catch(() => undefined);
      }
    }
    alerts += raised.length;
  }
  return alerts;
}

async function alertReports(deps: EndpointJobDeps, now: Date): Promise<number> {
  const since = new Date(now.getTime() - ALERT_WINDOW_MS);
  const rows = await deps.providerDb
    .select({
      report: endpointReports,
      hostname: endpoints.hostname,
      displayName: endpoints.displayName,
    })
    .from(endpointReports)
    .innerJoin(endpoints, eq(endpoints.id, endpointReports.endpointId))
    .where(
      and(
        isNull(endpointReports.alertedAt),
        inArray(endpointReports.readiness, ["red", "green"]),
        sql`${endpointReports.checkedAt} > ${since}`,
        inArray(endpointReports.kind, ["restore_test", "repository_check"]),
      ),
    )
    .limit(200);
  const byTenant = new Map<string, typeof rows>();
  for (const row of rows) {
    byTenant.set(row.report.tenantId, [...(byTenant.get(row.report.tenantId) ?? []), row]);
  }
  let alerts = 0;
  for (const [tenantId, list] of byTenant) {
    await withTenantTx(deps.db, tenantId, async (tx) => {
      const raised: NewNotification[] = [];
      for (const { report, hostname, displayName } of list) {
        const name = endpointName({ hostname, displayName });
        if (report.readiness === "red") {
          const test = report.kind === "restore_test";
          const detail =
            report.summary.errorMessage ??
            (report.summary.mismatched?.length
              ? `${report.summary.mismatched.length} of ${report.summary.files ?? "?"} sample files did not match`
              : "");
          raised.push({
            tenantId,
            level: "error",
            event: test ? "verify.red" : "scrub.corrupt",
            message: test
              ? `The restore test of ${name} failed${detail ? `: ${detail}` : "."}`
              : `The repository check of ${name} found problems${detail ? `: ${detail.slice(0, 200)}` : "."}`,
            details: {
              endpointId: report.endpointId,
              objectName: name,
              reportId: report.id,
              snapshotId: report.snapshotId,
              errorMessage: detail ? detail.slice(0, 500) : null,
            },
          });
        } else if (report.kind === "restore_test") {
          // Green again: only news if this endpoint was alerted red before.
          const [earlier] = await tx
            .select({ id: endpointReports.id })
            .from(endpointReports)
            .where(
              and(
                eq(endpointReports.endpointId, report.endpointId),
                eq(endpointReports.readiness, "red"),
                eq(endpointReports.kind, "restore_test"),
                sql`${endpointReports.alertedAt} IS NOT NULL`,
                sql`${endpointReports.checkedAt} < ${report.checkedAt}`,
              ),
            )
            .limit(1);
          if (earlier) {
            raised.push({
              tenantId,
              level: "info",
              event: "verify.recovered",
              message: `${name} can be restored again.`,
              details: { endpointId: report.endpointId, objectName: name, reportId: report.id },
            });
          }
        }
      }
      await raiseEvents(tx, raised, now);
      await tx
        .update(endpointReports)
        .set({ alertedAt: now })
        .where(
          inArray(
            endpointReports.id,
            list.map(({ report }) => report.id),
          ),
        );
      alerts += raised.length;
    });
  }
  return alerts;
}

async function alertStaleEndpoints(deps: EndpointJobDeps, now: Date): Promise<number> {
  const candidates = await deps.providerDb
    .select()
    .from(endpoints)
    .where(
      and(
        eq(endpoints.status, "active"),
        isNull(endpoints.staleAlertedAt),
        sql`exists (select 1 from tenants t where t.id = ${endpoints.tenantId} and t.status = 'active')`,
      ),
    )
    .limit(1000);
  const byTenant = new Map<string, Endpoint[]>();
  for (const endpoint of candidates) {
    const staleness = endpointStaleness(endpoint, now);
    if (staleness.silent || staleness.backupOverdue) {
      byTenant.set(endpoint.tenantId, [...(byTenant.get(endpoint.tenantId) ?? []), endpoint]);
    }
  }
  let alerts = 0;
  for (const [tenantId, list] of byTenant) {
    const raised: NewNotification[] = list.map((endpoint) => {
      const staleness = endpointStaleness(endpoint, now);
      const reason = staleness.silent ? "silent" : "backup_overdue";
      return {
        tenantId,
        level: "warning",
        event: "endpoint.stale",
        message: staleMessage(endpoint, reason, staleness.limit),
        details: {
          endpointId: endpoint.id,
          objectName: endpointName(endpoint),
          reason,
          profile: endpoint.profile,
          lastSeenAt: endpoint.lastSeenAt?.toISOString() ?? null,
          lastSuccessAt: endpoint.lastSuccessAt?.toISOString() ?? null,
        },
      };
    });
    await withTenantTx(deps.db, tenantId, async (tx) => {
      await raiseEvents(tx, raised, now);
      await tx
        .update(endpoints)
        .set({ staleAlertedAt: now })
        .where(
          inArray(
            endpoints.id,
            list.map((endpoint) => endpoint.id),
          ),
        );
    });
    alerts += raised.length;
  }
  return alerts;
}

/** Bytes as an operator reads them in an alert text: GiB or TiB with one decimal. */
export function formatQuotaBytes(bytes: number): string {
  const gib = bytes / 1024 ** 3;
  return gib >= 1024 ? `${(gib / 1024).toFixed(1)} TiB` : `${gib.toFixed(1)} GiB`;
}

const QUOTA_LEVEL_RANK = { ok: 0, near: 1, exceeded: 2 } as const;

async function alertStorageQuota(deps: EndpointJobDeps, now: Date): Promise<number> {
  const limits = endpointQuotaLimits();
  const rows = await deps.providerDb
    .select({
      id: endpoints.id,
      tenantId: endpoints.tenantId,
      hostname: endpoints.hostname,
      displayName: endpoints.displayName,
      status: endpoints.status,
      settings: endpoints.settings,
      repositoryBytes: endpoints.repositoryBytes,
      quotaRefusedAt: endpoints.quotaRefusedAt,
      quotaAlertLevel: endpoints.quotaAlertLevel,
    })
    .from(endpoints)
    .where(
      and(
        isNotNull(endpoints.repositoryBytes),
        sql`exists (select 1 from tenants t where t.id = ${endpoints.tenantId} and t.status = 'active')`,
      ),
    )
    .limit(5000);
  const byTenant = new Map<string, typeof rows>();
  for (const row of rows) {
    byTenant.set(row.tenantId, [...(byTenant.get(row.tenantId) ?? []), row]);
  }
  let alerts = 0;
  for (const [tenantId, list] of byTenant) {
    // Revoked endpoints no longer upload, but their repositories still take room.
    const tenantUsed = list.reduce((sum, row) => sum + (row.repositoryBytes ?? 0), 0);
    const raised: NewNotification[] = [];
    const marks: { id: string; level: "near" | "exceeded" | null }[] = [];
    for (const row of list) {
      if (row.status !== "active") {
        continue;
      }
      const used = row.repositoryBytes ?? 0;
      const budget = endpointBudgetBytes(row.settings, limits);
      const own = quotaLevelOf(used, budget);
      const refused =
        row.quotaRefusedAt !== null && now.getTime() - row.quotaRefusedAt.getTime() < DAY_MS;
      const level = own === "exceeded" || refused ? "exceeded" : own;
      const alerted = row.quotaAlertLevel ?? "ok";
      if (level === "ok") {
        const ratio = quotaRatio(used, budget);
        if (row.quotaAlertLevel !== null && (ratio === null || ratio < QUOTA_CLEAR_RATIO)) {
          marks.push({ id: row.id, level: null });
        }
        continue;
      }
      if (QUOTA_LEVEL_RANK[level] <= QUOTA_LEVEL_RANK[alerted]) {
        continue;
      }
      const name = endpointName(row);
      const share = budget ? Math.min(999, Math.round((used / budget) * 100)) : null;
      const usage =
        budget !== null
          ? `${formatQuotaBytes(used)} of ${formatQuotaBytes(budget)}${share !== null ? ` (${share} %)` : ""}`
          : formatQuotaBytes(used);
      const scope = own === "exceeded" || level === "near" ? "endpoint" : "tenant";
      raised.push({
        tenantId,
        level: level === "exceeded" ? "error" : "warning",
        event: "endpoint.storage_quota",
        message:
          level === "exceeded"
            ? scope === "endpoint"
              ? `The storage budget of ${name} is used up (${usage}); its backups are refused until the budget is raised or retention frees space.`
              : `Backups of ${name} are refused because the storage budget for all servers and clients of this tenant is used up.`
            : `The repository of ${name} uses ${usage} of its storage budget.`,
        details: {
          endpointId: row.id,
          objectName: name,
          level,
          scope,
          usedBytes: used,
          budgetBytes: budget,
          tenantUsedBytes: tenantUsed,
          tenantBudgetBytes: limits.tenantBytes,
        },
      });
      marks.push({ id: row.id, level });
    }

    // The tenant as a whole, told at most once a day while it stays above 90 percent.
    const tenantLevel = quotaLevelOf(tenantUsed, limits.tenantBytes);
    const tenantAlert =
      tenantLevel !== "ok" && limits.tenantBytes !== null
        ? await deps.providerDb
            .select({ id: notifications.id })
            .from(notifications)
            .where(
              and(
                eq(notifications.tenantId, tenantId),
                eq(notifications.event, "endpoint.storage_quota"),
                sql`${notifications.details}->>'scope' = 'tenant_total'`,
                gt(notifications.createdAt, new Date(now.getTime() - DAY_MS)),
              ),
            )
            .limit(1)
            .then((found) => found.length === 0)
        : false;
    if (tenantAlert && limits.tenantBytes !== null) {
      // The tenant is the subject: its name stands where an alert names the machine.
      const [tenant] = await deps.providerDb
        .select({ name: tenants.name })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1);
      raised.push({
        tenantId,
        level: tenantLevel === "exceeded" ? "error" : "warning",
        event: "endpoint.storage_quota",
        message: `The servers and clients of this tenant use ${formatQuotaBytes(tenantUsed)} of their common storage budget of ${formatQuotaBytes(limits.tenantBytes)}.`,
        details: {
          objectName: tenant?.name ?? "",
          level: tenantLevel,
          scope: "tenant_total",
          tenantUsedBytes: tenantUsed,
          tenantBudgetBytes: limits.tenantBytes,
        },
      });
    }
    if (raised.length === 0 && marks.length === 0) {
      continue;
    }
    await withTenantTx(deps.db, tenantId, async (tx) => {
      await raiseEvents(tx, raised, now);
      for (const mark of marks) {
        await tx
          .update(endpoints)
          .set({ quotaAlertLevel: mark.level, quotaAlertedAt: mark.level === null ? null : now })
          .where(eq(endpoints.id, mark.id));
      }
    });
    alerts += raised.length;
  }
  return alerts;
}

export async function endpointMonitor(deps: EndpointJobDeps): Promise<MonitorSummary> {
  const now = deps.runtime.now();
  const summary: MonitorSummary = {
    abandonedRuns: await closeAbandonedRuns(deps, now),
    expiredTasks: await expireTasks(deps, now),
    purgedDownloads: await purgeDownloads(deps, now),
    runAlerts: 0,
    reportAlerts: 0,
    staleAlerts: 0,
    quotaAlerts: 0,
  };
  summary.runAlerts = await alertFailedRuns(deps, now);
  summary.reportAlerts = await alertReports(deps, now);
  summary.staleAlerts = await alertStaleEndpoints(deps, now);
  summary.quotaAlerts = await alertStorageQuota(deps, now);
  return summary;
}
