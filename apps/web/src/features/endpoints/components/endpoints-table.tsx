import { Link } from "@tanstack/react-router";
import type { ColumnDef } from "@tanstack/react-table";
import { Info, TriangleAlert } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import {
  DataTable,
  DataTableFacetedFilter,
  DataTableSearch,
  RelativeTime,
  StatusBadge,
  matchesAnyOf,
} from "@/components/kit";
import { cn } from "@/lib/utils";

import type { EndpointSummary, ReadinessState } from "../api.js";
import { type EndpointArea, endpointDetailTo } from "../paths.js";
import { endpointHostLine, endpointName, lastBackupOf } from "../presenters.js";
import {
  ActivityBadge,
  AttentionBadges,
  ConnectionBadge,
  OsLabel,
  ProfileBadge,
  ProfileIcon,
  ReadinessBadge,
} from "./status.js";

export interface EndpointsTableProps {
  area: EndpointArea;
  items: readonly EndpointSummary[] | undefined;
  loading: boolean;
  fetching: boolean;
  error: unknown;
  onRetry: () => void;
  /** Shown instead of the table body when there is no machine yet. */
  empty: React.ReactNode;
}

/** Worst first, the order an admin should look at machines in. */
const READINESS_RANK: Record<ReadinessState, number> = {
  red: 0,
  no_backup: 1,
  unverified: 2,
  yellow: 3,
  green: 4,
};

const READINESS_ORDER = ["red", "no_backup", "unverified", "yellow", "green"] as const;
/** The machine stays in view while the other columns scroll. */
const PINNED = ["name"] as const;

function timeValue(value: string | null): number {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** A revoked machine stays in the list, greyed out. */
function Dimmed({ revoked, children }: { revoked: boolean; children: React.ReactNode }) {
  return <div className={cn("min-w-0", revoked && "opacity-60")}>{children}</div>;
}

function LastBackupCell({ endpoint }: { endpoint: EndpointSummary }) {
  const { t } = useTranslation("endpoints");
  const last = lastBackupOf(endpoint);
  if (last.state === "running") {
    return <span className="text-muted-foreground">{t("list.backupRunning")}</span>;
  }
  if (last.state === "never") {
    return <span className="text-muted-foreground">{t("list.noBackupYet")}</span>;
  }
  return (
    <div className="flex flex-col items-start gap-1">
      <RelativeTime value={last.at} focusable={false} />
      {last.outcome === "failed" ? (
        <StatusBadge tone="destructive" icon={TriangleAlert} className="whitespace-nowrap">
          {t("list.backupFailed")}
        </StatusBadge>
      ) : last.outcome === "interrupted" ? (
        <StatusBadge tone="info" icon={Info} className="whitespace-nowrap">
          {t("runStatus.interrupted")}
        </StatusBadge>
      ) : last.outcome === "partial" ? (
        <StatusBadge tone="warning" icon={TriangleAlert} className="whitespace-nowrap">
          {t("list.backupPartial")}
        </StatusBadge>
      ) : null}
    </div>
  );
}

/**
 * Servers, clients or every machine with an agent: name, system, connection,
 * last backup, last contact, the rating of the newest backup and what needs
 * attention. The agents list adds the profile and the agent version.
 */
export function EndpointsTable({
  area,
  items,
  loading,
  fetching,
  error,
  onRetry,
  empty,
}: EndpointsTableProps) {
  const { t } = useTranslation("endpoints");
  const showAgentColumns = area === "agents";

  const columns = React.useMemo<ColumnDef<EndpointSummary>[]>(() => {
    const list: ColumnDef<EndpointSummary>[] = [
      {
        id: "name",
        // Pinned (see `pinnedColumns`): the width is fixed.
        size: 288,
        // The search reads the label and the host name.
        accessorFn: (endpoint) => `${endpointName(endpoint)} ${endpoint.hostname}`,
        header: t("list.columns.name"),
        meta: { label: t("list.columns.name") },
        enableHiding: false,
        sortingFn: (a, b) =>
          endpointName(a.original).localeCompare(endpointName(b.original), undefined, {
            sensitivity: "base",
            numeric: true,
          }),
        cell: ({ row }) => {
          const endpoint = row.original;
          const hostLine = endpointHostLine(endpoint);
          return (
            <Dimmed revoked={endpoint.status === "revoked"}>
              <div className="flex min-w-0 items-start gap-2">
                <ProfileIcon profile={endpoint.profile} className="mt-0.5" />
                <div className="min-w-0">
                  <Link
                    to={endpointDetailTo(endpoint.id)}
                    className="block truncate rounded-sm font-medium outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
                    title={endpointName(endpoint)}
                  >
                    {endpointName(endpoint)}
                  </Link>
                  {hostLine ? (
                    <p className="truncate text-xs text-muted-foreground" title={hostLine}>
                      {hostLine}
                    </p>
                  ) : null}
                </div>
              </div>
            </Dimmed>
          );
        },
      },
    ];

    if (showAgentColumns) {
      list.push({
        id: "profile",
        size: 110,
        accessorFn: (endpoint) => endpoint.profile,
        header: t("list.columns.profile"),
        meta: { label: t("list.columns.profile"), className: "hidden 2xl:table-cell" },
        filterFn: matchesAnyOf,
        cell: ({ row }) => (
          <Dimmed revoked={row.original.status === "revoked"}>
            <ProfileBadge profile={row.original.profile} />
          </Dimmed>
        ),
      });
    }

    list.push(
      {
        id: "system",
        size: 150,
        accessorFn: (endpoint) => `${endpoint.os} ${endpoint.arch}`,
        header: t("list.columns.system"),
        meta: { label: t("list.columns.system"), className: "hidden md:table-cell" },
        cell: ({ row }) => (
          <Dimmed revoked={row.original.status === "revoked"}>
            <OsLabel os={row.original.os} arch={row.original.arch} />
          </Dimmed>
        ),
      },
      {
        id: "status",
        size: 150,
        accessorFn: (endpoint) => (endpoint.status === "revoked" ? "revoked" : endpoint.connection),
        header: t("list.columns.status"),
        meta: { label: t("list.columns.status") },
        cell: ({ row }) => (
          <div className="flex flex-col items-start gap-1">
            <ConnectionBadge endpoint={row.original} />
            <ActivityBadge endpoint={row.original} />
          </div>
        ),
      },
      {
        id: "readiness",
        size: 150,
        accessorFn: (endpoint) => endpoint.readiness.state,
        header: t("list.columns.readiness"),
        meta: { label: t("list.columns.readiness"), headerClassName: "whitespace-nowrap" },
        filterFn: matchesAnyOf,
        sortingFn: (a, b) =>
          READINESS_RANK[a.original.readiness.state] - READINESS_RANK[b.original.readiness.state],
        cell: ({ row }) => (
          <Dimmed revoked={row.original.status === "revoked"}>
            <ReadinessBadge readiness={row.original.readiness} />
          </Dimmed>
        ),
      },
      {
        id: "lastBackup",
        size: 150,
        accessorFn: (endpoint) => timeValue(endpoint.lastBackupAt),
        enableGlobalFilter: false,
        header: t("list.columns.lastBackup"),
        meta: { label: t("list.columns.lastBackup"), headerClassName: "whitespace-nowrap" },
        cell: ({ row }) => (
          <Dimmed revoked={row.original.status === "revoked"}>
            <LastBackupCell endpoint={row.original} />
          </Dimmed>
        ),
      },
      {
        id: "lastSeen",
        size: 130,
        accessorFn: (endpoint) => timeValue(endpoint.lastSeenAt),
        enableGlobalFilter: false,
        header: t("list.columns.lastSeen"),
        meta: {
          label: t("list.columns.lastSeen"),
          className: "hidden xl:table-cell",
          headerClassName: "whitespace-nowrap",
        },
        cell: ({ row }) => (
          <Dimmed revoked={row.original.status === "revoked"}>
            <RelativeTime
              value={row.original.lastSeenAt}
              fallback={t("status.never")}
              focusable={false}
            />
          </Dimmed>
        ),
      },
      {
        id: "attention",
        size: 200,
        accessorFn: (endpoint) => endpoint.attention.length,
        enableGlobalFilter: false,
        header: t("list.columns.attention"),
        meta: { label: t("list.columns.attention"), cellClassName: "max-w-64" },
        cell: ({ row }) => <AttentionBadges attention={row.original.attention} max={2} />,
      },
    );

    if (showAgentColumns) {
      list.push({
        id: "agentVersion",
        size: 120,
        accessorFn: (endpoint) => endpoint.agentVersion ?? "",
        header: t("list.columns.agentVersion"),
        meta: {
          label: t("list.columns.agentVersion"),
          className: "hidden 2xl:table-cell",
          headerClassName: "whitespace-nowrap",
        },
        cell: ({ row }) => (
          <Dimmed revoked={row.original.status === "revoked"}>
            {row.original.agentVersion ? (
              <span className="font-mono text-xs">{row.original.agentVersion}</span>
            ) : (
              <span className="text-muted-foreground">{t("list.unknown")}</span>
            )}
          </Dimmed>
        ),
      });
    }
    return list;
  }, [t, showAgentColumns]);

  const present = new Set((items ?? []).map((endpoint) => endpoint.readiness.state));
  const readinessOptions = READINESS_ORDER.filter((state) => present.has(state)).map((state) => ({
    value: state,
    label: t(`readiness.state.${state}`),
  }));
  const profilesPresent = new Set((items ?? []).map((endpoint) => endpoint.profile));
  const profileOptions = (["server", "client"] as const)
    .filter((profile) => profilesPresent.has(profile))
    .map((profile) => ({ value: profile, label: t(`profile.${profile}`) }));

  return (
    <DataTable
      id={`endpoints-${area}`}
      label={t(`areas.${area}.title`)}
      columns={columns}
      data={items}
      getRowId={(endpoint) => endpoint.id}
      loading={loading}
      fetching={fetching}
      error={error}
      onRetry={onRetry}
      errorTitle={t("list.errors.load")}
      empty={empty}
      pinnedColumns={PINNED}
      sorting={{ mode: "client", initial: [{ id: "name", desc: false }] }}
      pagination={{ mode: "client", pageSize: 25 }}
      toolbar={(table) => (
        <>
          <DataTableSearch
            value={String(table.getState().globalFilter ?? "")}
            onChange={(value) => table.setGlobalFilter(value)}
            placeholder={t("list.search")}
          />
          {readinessOptions.length > 1 ? (
            <DataTableFacetedFilter
              title={t("list.columns.readiness")}
              options={readinessOptions}
              column={table.getColumn("readiness")}
            />
          ) : null}
          {showAgentColumns && profileOptions.length > 1 ? (
            <DataTableFacetedFilter
              title={t("list.columns.profile")}
              options={profileOptions}
              column={table.getColumn("profile")}
            />
          ) : null}
        </>
      )}
    />
  );
}
