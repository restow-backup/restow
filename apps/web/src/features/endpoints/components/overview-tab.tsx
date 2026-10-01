import { History, Hourglass } from "lucide-react";
import * as React from "react";

import { RelativeTime, StatusBadge } from "@/components/kit";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

import type { EndpointDetail, EndpointTask } from "../api.js";
import { type EndpointFormat, useEndpointFormat } from "../hooks.js";
import {
  configPending,
  lastBackupOf,
  quotaPercent,
  retryNotBefore,
  taskOutcomeOf,
  waitingTasks,
} from "../presenters.js";
import { Fact, Facts } from "./facts.js";
import { ReportsCard } from "./reports-card.js";
import { RunsCard } from "./runs-card.js";
import { ConnectionBadge, OsLabel, TaskStatusBadge } from "./status.js";

function taskLabel(task: EndpointTask, format: EndpointFormat): string {
  const { t } = format;
  if (task.kind === "restore") {
    const paths = Array.isArray(task.params.paths) ? task.params.paths.length : 0;
    return t("tasks.restore", { count: paths });
  }
  return t(`tasks.kind.${task.kind}`);
}

/** Requests that wait for the machine: it picks them up with its next contact. */
export function PendingTasksCard({ tasks }: { tasks: readonly EndpointTask[] }) {
  const format = useEndpointFormat();
  const { t } = format;
  const waiting = waitingTasks(tasks);
  if (waiting.length === 0) {
    return null;
  }
  return (
    <Card data-slot="pending-tasks">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Hourglass aria-hidden="true" className="size-4 text-muted-foreground" />
          {t("tasks.title")}
        </CardTitle>
        <CardDescription>{t("tasks.description")}</CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="divide-y text-sm">
          {waiting.map((task) => {
            // A restore test offered again after it could not complete waits until then.
            const notBefore = retryNotBefore(task);
            return (
              <li
                key={task.id}
                className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2 first:pt-0 last:pb-0"
              >
                <div className="min-w-0">
                  <span className="font-medium">{taskLabel(task, format)}</span>
                  {notBefore ? (
                    <span className="block text-xs text-muted-foreground" data-task-retry="">
                      {t("tasks.retryFrom", { time: format.dateTime(notBefore) ?? "" })}
                    </span>
                  ) : null}
                </div>
                <span className="flex items-center gap-2 text-muted-foreground">
                  <StatusBadge tone={task.status === "delivered" ? "info" : "muted"} icon>
                    {t(`tasks.status.${task.status}`)}
                  </StatusBadge>
                  <RelativeTime value={task.createdAt} focusable={false} />
                </span>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}

/**
 * The last requests to the machine that are over, and how each ended. A
 * restore test that could not complete is neutral, not failed; `willRetry` is
 * false on a revoked machine, which runs no more tests.
 */
export function RecentTasksCard({
  tasks,
  willRetry = true,
}: { tasks: readonly EndpointTask[]; willRetry?: boolean }) {
  const format = useEndpointFormat();
  const { t } = format;
  if (tasks.length === 0) {
    return null;
  }
  return (
    <Card data-slot="recent-tasks">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <History aria-hidden="true" className="size-4 text-muted-foreground" />
          {t("tasks.recentTitle")}
        </CardTitle>
        <CardDescription>{t("tasks.recentDescription")}</CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="divide-y text-sm">
          {tasks.map((task) => {
            const outcome = taskOutcomeOf(task);
            return (
              <li
                key={task.id}
                data-task-status={task.status}
                className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 py-2 first:pt-0 last:pb-0"
              >
                <div className="min-w-0">
                  <span className="font-medium">{taskLabel(task, format)}</span>
                  {outcome.state !== "done" && outcome.reason ? (
                    <span className="block break-words text-xs text-muted-foreground">
                      {"key" in outcome.reason ? t(outcome.reason.key) : outcome.reason.text}
                    </span>
                  ) : null}
                </div>
                <span className="flex items-center gap-2 text-muted-foreground">
                  <TaskStatusBadge task={task} willRetry={willRetry} />
                  <RelativeTime value={task.finishedAt ?? task.createdAt} focusable={false} />
                </span>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}

function FactsCard({ detail }: { detail: EndpointDetail }) {
  const format = useEndpointFormat();
  const { t } = format;
  const last = lastBackupOf(detail);
  const pending = detail.status === "active" && configPending(detail);
  return (
    <Card data-slot="endpoint-facts">
      <CardHeader>
        <CardTitle className="text-base">{t("facts.title")}</CardTitle>
      </CardHeader>
      <CardContent>
        <Facts>
          <Fact label={t("facts.profile")}>{t(`profile.${detail.profile}`)}</Fact>
          <Fact label={t("facts.system")}>
            <OsLabel os={detail.os} arch={detail.arch} />
          </Fact>
          <Fact label={t("facts.osVersion")}>{detail.osVersion || t("list.unknown")}</Fact>
          <Fact label={t("facts.agentVersion")}>
            {detail.agentVersion ? (
              <code className="font-mono text-xs">{detail.agentVersion}</code>
            ) : (
              t("list.unknown")
            )}
          </Fact>
          <Fact label={t("facts.connection")}>
            <span className="flex flex-wrap items-center gap-2">
              <ConnectionBadge endpoint={detail} />
              <RelativeTime
                value={detail.lastSeenAt}
                fallback={t("status.never")}
                focusable={false}
              />
            </span>
          </Fact>
          <Fact label={t("facts.lastSuccess")}>
            <RelativeTime
              value={detail.lastSuccessAt}
              fallback={t("facts.noSuccess")}
              focusable={false}
            />
          </Fact>
          <Fact label={t("facts.lastBackup")}>
            {last.state === "done" ? (
              <span>
                <RelativeTime value={last.at} focusable={false} />
                {last.outcome !== "ok" ? ` · ${t(`facts.outcome.${last.outcome}`)}` : ""}
              </span>
            ) : last.state === "running" ? (
              t("list.backupRunning")
            ) : (
              t("list.noBackupYet")
            )}
          </Fact>
          <Fact label={t("facts.nextRun")}>
            {detail.status === "revoked" ? (
              t("facts.noNextRun")
            ) : (
              <RelativeTime
                value={detail.nextRunAt}
                fallback={t("facts.nextRunUnknown")}
                focusable={false}
              />
            )}
          </Fact>
          <Fact label={t("facts.config")}>
            <span data-config-pending={pending || undefined}>
              {pending
                ? t("facts.configPending", {
                    version: detail.configVersion,
                    applied: detail.agentConfigVersion ?? t("facts.configNone"),
                  })
                : detail.status === "active"
                  ? t("facts.configApplied", { version: detail.configVersion })
                  : t("facts.configRevoked", { version: detail.configVersion })}
            </span>
          </Fact>
          <Fact label={t("facts.added")}>
            <RelativeTime value={detail.createdAt} focusable={false} />
          </Fact>
          {detail.revokedAt ? (
            <Fact label={t("facts.revoked")}>
              <RelativeTime value={detail.revokedAt} focusable={false} />
            </Fact>
          ) : null}
        </Facts>
      </CardContent>
    </Card>
  );
}

function RepositoryCard({ detail }: { detail: EndpointDetail }) {
  const format = useEndpointFormat();
  const { t } = format;
  const { repository, settings, storage } = detail;
  const used = storage.usedBytes ?? repository?.bytes ?? null;
  const percent = quotaPercent(used, storage.budgetBytes);
  return (
    <Card data-slot="endpoint-repository">
      <CardHeader>
        <CardTitle className="text-base">{t("repository.title")}</CardTitle>
        <CardDescription>{t("repository.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {storage.level !== "ok" ? (
          <Alert
            variant={storage.level === "exceeded" ? "destructive" : "warning"}
            data-slot="storage-quota"
          >
            <AlertDescription>{t(`repository.quota.${storage.level}`)}</AlertDescription>
          </Alert>
        ) : null}
        <Facts>
          <Fact label={t("repository.size")}>
            {used === null
              ? t("repository.notMeasured")
              : storage.budgetBytes !== null && percent !== null
                ? t("repository.ofBudget", {
                    used: format.bytes(used),
                    budget: format.bytes(storage.budgetBytes),
                    percent,
                  })
                : format.bytes(used)}
          </Fact>
          <Fact label={t("repository.budget")}>
            {storage.budgetBytes === null
              ? t("repository.budgetUnlimited")
              : t(storage.ownBudget ? "repository.budgetOwn" : "repository.budgetDefault", {
                  budget: format.bytes(storage.budgetBytes),
                })}
          </Fact>
          <Fact label={t("repository.tenant")}>
            {storage.tenantBudgetBytes === null
              ? format.bytes(storage.tenantUsedBytes)
              : t("repository.tenantOf", {
                  used: format.bytes(storage.tenantUsedBytes),
                  budget: format.bytes(storage.tenantBudgetBytes),
                })}
          </Fact>
          {storage.refusedAt ? (
            <Fact label={t("repository.refused")}>
              <RelativeTime value={storage.refusedAt} focusable={false} />
            </Fact>
          ) : null}
          <Fact label={t("repository.snapshots")}>
            {repository?.snapshots != null
              ? format.integer(repository.snapshots)
              : t("repository.notMeasured")}
          </Fact>
          {repository ? (
            <Fact label={t("repository.measured")}>
              <RelativeTime value={repository.at} focusable={false} />
            </Fact>
          ) : null}
          <Fact label={t("repository.lastRetention")}>
            <RelativeTime
              value={detail.lastRetentionAt}
              fallback={t("facts.never")}
              focusable={false}
            />
          </Fact>
          <Fact label={t("repository.lastCheck")}>
            <RelativeTime
              value={detail.lastCheckAt}
              fallback={t("facts.never")}
              focusable={false}
            />
          </Fact>
          <Fact label={t("repository.lastRestoreTest")}>
            <RelativeTime
              value={detail.lastRestoreTestAt}
              fallback={t("facts.never")}
              focusable={false}
            />
          </Fact>
        </Facts>
        <p className="text-xs text-muted-foreground">
          {t("repository.retention", {
            daily: settings.retention.keepDaily,
            weekly: settings.retention.keepWeekly,
            monthly: settings.retention.keepMonthly,
          })}
        </p>
      </CardContent>
    </Card>
  );
}

/** Runs, reports, and the facts and repository of one machine. */
export function OverviewTab({
  detail,
  onOpenRun,
}: {
  detail: EndpointDetail;
  onOpenRun: (runId: string) => void;
}) {
  return (
    <div className="grid items-start gap-4 lg:grid-cols-3">
      <div className="min-w-0 space-y-4 lg:col-span-2">
        <PendingTasksCard tasks={detail.tasks} />
        <RunsCard
          endpointId={detail.id}
          runs={detail.runs}
          onOpen={onOpenRun}
          willRetry={detail.status === "active"}
        />
        <RecentTasksCard tasks={detail.recentTasks} willRetry={detail.status === "active"} />
        <ReportsCard reports={detail.reports} />
      </div>
      <div className="min-w-0 space-y-4">
        <FactsCard detail={detail} />
        <RepositoryCard detail={detail} />
      </div>
    </div>
  );
}
