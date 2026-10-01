import { Link } from "@tanstack/react-router";
import type { ColumnDef } from "@tanstack/react-table";
import { History, ListChecks } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { DataTable, EmptyState, RelativeTime, StatusBadge } from "@/components/kit";
import { formatInteger } from "@/lib/format";

import { CauseLine, ItemCauseLines } from "@/features/failures";
import { JOB_QUEUES } from "@/features/jobs/api";

import type { RecentJob, RecentJobsWidget as RecentJobsData } from "../api.js";
import { LinkButton } from "../components/link-button.js";
import { WidgetCard, type WidgetStateProps } from "../components/widget-frame.js";
import { PATHS, jobTo, to } from "../paths.js";
import { jobStatusView } from "../presenters.js";

// Derived from the shared queue list so a new queue is never missed here.
const KNOWN_QUEUES = new Set<string>(JOB_QUEUES);

function useColumns(): ColumnDef<RecentJob>[] {
  const { t, i18n } = useTranslation("dashboard");
  const language = i18n.resolvedLanguage ?? i18n.language;
  return React.useMemo<ColumnDef<RecentJob>[]>(
    () => [
      {
        id: "queue",
        accessorFn: (job) => job.queue,
        header: t("recentJobs.columns.queue"),
        cell: ({ row }) => (
          <Link
            to={jobTo(row.original.id)}
            className="font-medium underline-offset-4 hover:underline focus-visible:underline"
          >
            {KNOWN_QUEUES.has(row.original.queue)
              ? t(`recentJobs.queue.${row.original.queue}`)
              : row.original.queue}
          </Link>
        ),
      },
      {
        id: "object",
        accessorFn: (job) => job.object?.displayName ?? "",
        header: t("recentJobs.columns.object"),
        cell: ({ row }) => {
          const object = row.original.object;
          return object ? (
            <span className="block max-w-56 truncate" title={object.displayName ?? undefined}>
              {object.displayName ?? t(`recentJobs.kinds.${object.kind}`)}
            </span>
          ) : (
            <span className="text-muted-foreground">{t("recentJobs.wholeTenant")}</span>
          );
        },
        meta: { className: "hidden md:table-cell" },
      },
      {
        id: "status",
        accessorFn: (job) => jobStatusView(job).key,
        header: t("recentJobs.columns.status"),
        cell: ({ row }) => {
          const view = jobStatusView(row.original);
          const badge = (
            <StatusBadge tone={view.tone} live={view.live} icon={!view.live}>
              {t(`recentJobs.status.${view.key}`)}
            </StatusBadge>
          );
          const { throttledUntil } = row.original;
          if (view.key !== "throttled" || !throttledUntil) {
            // Why it failed, in one line, so the dashboard never shows a red badge without a reason.
            return (
              <span className="inline-flex max-w-64 flex-col items-start gap-0.5">
                {badge}
                <RecentJobCause job={row.original} />
              </span>
            );
          }
          // Microsoft asked the job to wait: say until when, not only that it waits.
          return (
            <span className="inline-flex flex-col items-start gap-0.5" data-throttled-until>
              {badge}
              <span className="text-xs text-muted-foreground">
                {t("recentJobs.resumes")} <RelativeTime value={throttledUntil} focusable={false} />
              </span>
            </span>
          );
        },
      },
      {
        id: "started",
        accessorFn: (job) => job.startedAt ?? job.createdAt,
        header: t("recentJobs.columns.started"),
        cell: ({ row }) =>
          row.original.startedAt ? (
            <RelativeTime value={row.original.startedAt} focusable={false} />
          ) : (
            <span className="text-muted-foreground">{t("recentJobs.notStarted")}</span>
          ),
      },
      {
        id: "progress",
        accessorFn: (job) => job.progress?.done ?? -1,
        header: t("recentJobs.columns.progress"),
        cell: ({ row }) => {
          const progress = row.original.progress;
          if (!progress) {
            return <span className="text-muted-foreground">–</span>;
          }
          return (
            <span className="inline-flex flex-col items-end gap-0.5">
              <span>
                {t("recentJobs.progress", {
                  done: formatInteger(progress.done, language),
                  total: formatInteger(progress.total, language),
                })}
              </span>
              {progress.failed > 0 ? (
                <span className="text-xs text-destructive-text">
                  {t("recentJobs.failedItems", { count: progress.failed })}
                </span>
              ) : null}
            </span>
          );
        },
        meta: { numeric: true },
      },
    ],
    [t, language],
  );
}

/** The cause of a failed job (or of the failed items of a finished one) as one short line. */
function RecentJobCause({ job }: { job: RecentJob }) {
  if (job.failure && (job.status === "failed" || job.status === "queued")) {
    return <CauseLine failure={job.failure} />;
  }
  if (job.itemCauses && job.itemCauses.length > 0 && job.status === "completed") {
    return <ItemCauseLines causes={job.itemCauses.slice(0, 1)} />;
  }
  return null;
}

function RecentJobsTable({ items }: { items: RecentJob[] }) {
  const { t } = useTranslation("dashboard");
  const columns = useColumns();
  return (
    <DataTable
      id="dashboard.recent-jobs"
      label={t("recentJobs.title")}
      columns={columns}
      data={items}
      getRowId={(job) => job.id}
      columnsMenu={false}
      maxHeight="none"
      empty={
        <EmptyState
          icon={ListChecks}
          title={t("recentJobs.empty.title")}
          description={t("recentJobs.empty.description")}
          variant="plain"
        />
      }
    />
  );
}

function RecentJobsSkeleton() {
  const columns = useColumns();
  return (
    <DataTable
      id="dashboard.recent-jobs"
      columns={columns}
      data={undefined}
      loading
      columnsMenu={false}
      skeletonRows={4}
      maxHeight="none"
    />
  );
}

/** The latest jobs of the tenant (admins only: the list names mailboxes and accounts). */
export function RecentJobsWidget(props: WidgetStateProps<RecentJobsData>) {
  const { t } = useTranslation("dashboard");
  return (
    <WidgetCard
      id="recentJobs"
      {...props}
      title={t("recentJobs.title")}
      description={t("recentJobs.description")}
      icon={History}
      action={
        <LinkButton to={to(PATHS.jobs)} variant="ghost">
          {t("recentJobs.all")}
        </LinkButton>
      }
      empty={(data) =>
        data.items.length === 0
          ? {
              icon: ListChecks,
              title: t("recentJobs.empty.title"),
              description: t("recentJobs.empty.description"),
              action: <LinkButton to={to(PATHS.backup)}>{t("recentJobs.empty.action")}</LinkButton>,
            }
          : null
      }
      skeleton={<RecentJobsSkeleton />}
    >
      {(data) => <RecentJobsTable items={data.items} />}
    </WidgetCard>
  );
}
