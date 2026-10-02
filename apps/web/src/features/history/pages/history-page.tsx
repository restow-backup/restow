import { useNavigate } from "@tanstack/react-router";
import type { ColumnDef } from "@tanstack/react-table";
import { History as HistoryIcon } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { DataTable, EmptyState, PageHeader, PageTabs, RefreshButton } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useBackupJobs } from "@/features/backup-jobs/hooks";
import { HISTORY_PATH } from "@/features/jobs/paths";

import { type HistoryFilters, RUN_CATEGORIES, type Run } from "../api";
import {
  OpenRunLink,
  RunCause,
  RunDuration,
  RunProgressCell,
  RunStarted,
} from "../components/run-cells";
import { RunDrawerHost } from "../components/run-drawer";
import { RunStateBadge, SubjectIcon, useRunTitle } from "../components/run-parts";
import { useHistory, useRunDrawer } from "../hooks";
import { historySearchOf } from "../presenters";

const ALL = "all";

/** The columns that stay while the table scrolls sideways: what identifies the run. */
const PINNED = ["run"] as const;

export interface HistoryPageProps {
  filters: HistoryFilters;
  /** Change the tab or the job; the address follows (the page does not keep filters of its own). */
  onFilters: (next: HistoryFilters) => void;
}

/**
 * History: every run of the tenant, from the server and from the agents, newest first, in tabs
 * by kind with an optional filter by job. A click on a row opens the run's drawer (live while it
 * runs); the run's name is a link to the same drawer and its page is one click further. The
 * restore-check retries of one backup are one row ("attempt 3 of 6").
 */
export function HistoryPage({ filters, onFilters }: HistoryPageProps) {
  const { t } = useTranslation("history");
  const { list, runs } = useHistory(filters);
  const drawer = useRunDrawer();
  const title = useRunTitle();
  const jobs = useBackupJobs();
  const filtered = filters.type !== null || filters.job !== null;

  const search = historySearchOf(filters);
  const tabs = [
    {
      id: "all",
      label: t("tabs.all"),
      to: HISTORY_PATH,
      search: historySearchOf({ job: filters.job }),
    },
    ...RUN_CATEGORIES.map((category) => ({
      id: category,
      label: t(`tabs.${category}`),
      to: HISTORY_PATH,
      search: historySearchOf({ type: category, job: filters.job }),
    })),
  ];

  const columns = React.useMemo<ColumnDef<Run>[]>(
    () => [
      {
        id: "run",
        size: 250,
        enableSorting: false,
        enableHiding: false,
        header: t("columns.run"),
        meta: { label: t("columns.run") },
        cell: ({ row }) => {
          const run = row.original;
          return (
            <div className="min-w-0 space-y-1">
              <OpenRunLink
                runId={run.id}
                to={HISTORY_PATH}
                search={search}
                className="block truncate font-medium"
                label={t("row.open", { name: title(run) })}
              >
                {title(run)}
              </OpenRunLink>
              <div className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
                <span>{t(`trigger.${run.trigger}`)}</span>
                {run.job ? <span>· {run.job.name}</span> : null}
                {run.attempt ? (
                  <span className="whitespace-nowrap">
                    · {t("attempt", { number: run.attempt.number, of: run.attempt.of })}
                  </span>
                ) : null}
                {run.full ? <span>· {t("row.full")}</span> : null}
              </div>
            </div>
          );
        },
      },
      {
        id: "subject",
        size: 210,
        enableSorting: false,
        header: t("columns.subject"),
        // The run's title already names the object; its own column is for the widest screens.
        meta: { label: t("columns.subject"), className: "hidden 2xl:table-cell" },
        cell: ({ row }) => {
          const { subject } = row.original;
          return subject ? (
            <div className="flex min-w-0 items-start gap-2">
              <SubjectIcon kind={subject.kind} className="mt-0.5 text-muted-foreground" />
              <div className="min-w-0">
                <p className="truncate">{subject.name}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {t(`subject.${subject.kind}`)}
                </p>
              </div>
            </div>
          ) : (
            <span className="text-muted-foreground">{t("row.tenantWide")}</span>
          );
        },
      },
      {
        id: "status",
        size: 190,
        enableSorting: false,
        header: t("columns.status"),
        meta: { label: t("columns.status") },
        cell: ({ row }) => (
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <RunStateBadge run={row.original} />
              {/* The progress column is off screen on a phone; the percent stays beside the state. */}
              {row.original.state === "running" && row.original.progress?.percent != null ? (
                <span className="font-mono text-xs tabular-nums sm:hidden">
                  {row.original.progress.percent} %
                </span>
              ) : null}
            </div>
            <RunCause run={row.original} />
          </div>
        ),
      },
      {
        id: "progress",
        size: 260,
        enableSorting: false,
        header: t("columns.progress"),
        meta: { label: t("columns.progress") },
        cell: ({ row }) => <RunProgressCell run={row.original} />,
      },
      {
        id: "started",
        size: 130,
        enableSorting: false,
        header: t("columns.started"),
        meta: {
          label: t("columns.started"),
          headerClassName: "whitespace-nowrap",
          className: "hidden lg:table-cell",
        },
        cell: ({ row }) => <RunStarted run={row.original} />,
      },
      {
        id: "duration",
        size: 90,
        enableSorting: false,
        header: t("columns.duration"),
        meta: { label: t("columns.duration"), className: "hidden lg:table-cell" },
        cell: ({ row }) => <RunDuration run={row.original} />,
      },
    ],
    [t, title, search],
  );

  return (
    <div className="space-y-5" data-slot="history-page">
      <PageTabs label={t("tabs.label")} tabs={tabs} current={filters.type ?? "all"} />
      <PageHeader
        icon={HistoryIcon}
        title={t("title")}
        description={t("description")}
        actions={
          <RefreshButton
            label={t("page.refresh")}
            fetching={list.isFetching}
            onRefresh={() => void list.refetch()}
          />
        }
      />
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="history-filter-job" className="text-xs text-muted-foreground">
            {t("filter.job")}
          </Label>
          <Select
            value={filters.job ?? ALL}
            onValueChange={(next) => onFilters({ ...filters, job: next === ALL ? null : next })}
          >
            <SelectTrigger id="history-filter-job" className="w-60">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{t("filter.allJobs")}</SelectItem>
              {(jobs.data?.items ?? []).map((job) => (
                <SelectItem key={job.id} value={job.id}>
                  {job.name}
                </SelectItem>
              ))}
              {/* A job named in the address that the list does not know (another tenant's, deleted). */}
              {filters.job && !(jobs.data?.items ?? []).some((job) => job.id === filters.job) ? (
                <SelectItem value={filters.job}>{t("filter.unknownJob")}</SelectItem>
              ) : null}
            </SelectContent>
          </Select>
        </div>
      </div>

      <DataTable
        id="history-runs"
        label={t("page.table")}
        columns={columns}
        data={list.data === undefined ? undefined : runs}
        getRowId={(run) => run.id}
        loading={list.isPending}
        fetching={list.isFetching}
        error={list.error}
        onRetry={() => void list.refetch()}
        errorTitle={t("page.loadError")}
        empty={
          <EmptyState
            icon={HistoryIcon}
            title={t("page.empty.title")}
            description={t("page.empty.description")}
            variant="plain"
          />
        }
        filteredEmpty={
          <EmptyState
            icon={HistoryIcon}
            title={t("page.emptyFiltered.title")}
            description={t(
              filters.job ? "page.emptyFiltered.descriptionJob" : "page.emptyFiltered.description",
            )}
            variant="plain"
            actions={
              <Button variant="outline" onClick={() => onFilters({ type: null, job: null })}>
                {t("page.clearFilters")}
              </Button>
            }
          />
        }
        filtered={filtered}
        onResetFilters={() => onFilters({ type: null, job: null })}
        pinnedColumns={PINNED}
        onRowClick={(run) => drawer.open(run.id)}
        sorting={{ mode: "manual", state: [], onChange: () => undefined }}
        columnsMenu={false}
        pagination={{
          mode: "loadMore",
          hasMore: list.hasNextPage,
          loadingMore: list.isFetchingNextPage,
          onLoadMore: () => void list.fetchNextPage(),
        }}
      />
      <RunDrawerHost />
    </div>
  );
}

export function useHistoryNavigation() {
  const navigate = useNavigate();
  return React.useCallback(
    (filters: HistoryFilters) =>
      void navigate({
        to: HISTORY_PATH as never,
        search: historySearchOf(filters) as never,
      }),
    [navigate],
  );
}
