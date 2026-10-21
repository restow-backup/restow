import type { ColumnDef, SortingState } from "@tanstack/react-table";
import { Box, Container, ServerCog, TriangleAlert } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { DataTable, DataTableSearch, EmptyState, RelativeTime } from "@/components/kit";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

import type { PveGuest, PveJob } from "./api.js";
import {
  BackupSizeLine,
  GuestActionButton,
  GuestStatusCell,
  type SelfBackupGuard,
} from "./guest-cells.js";
import { GUEST_STATE_FILTERS, type GuestStateFilter } from "./guest-status.js";
import {
  DEFAULT_GUEST_PAGE_SIZE,
  GUEST_PAGE_SIZES,
  GUEST_SORTS,
  type GuestRow,
  type GuestSort,
  hasGuestFilter,
  NO_JOB,
  type PveSearch,
} from "./guests-search.js";
import { PVE_NAMESPACE } from "./i18n.js";

/**
 * The guests of VMs & containers (0.4.3): one line per guest in a table whose columns keep
 * their width (`fixedLayout`), a search over ID and name, filters by node, kind, job and
 * state ("Problems only" one click away), sortable columns, pages, and the count of what the
 * filters left. Everything lives in the address (`PveSearch`). A row opens the guest's detail
 * panel; its name is the button that does the same for the keyboard.
 */

/** Width of each column in pixels: the table never measures its content. */
export const GUEST_COLUMN_SIZES = {
  vmid: 60,
  name: 156,
  state: 196,
  lastBackup: 104,
  node: 84,
  size: 250,
  job: 96,
  actions: 160,
} as const;

/** The data attribute of a row's name button: where focus returns when the panel closes. */
export const GUEST_NAME_ATTRIBUTE = "data-pve-guest-name";

const ALL = "__all__";

export interface GuestsTableProps {
  /** The rows of the open page, filtered and sorted. */
  rows: readonly GuestRow[] | undefined;
  /** Rows the filters leave (all pages) and rows overall. */
  matching: number;
  total: number;
  /** Guests with a problem, for the "Problems only" button. */
  problems: number;
  search: PveSearch;
  onSearchChange: (patch: Partial<PveSearch>) => void;
  jobs: readonly PveJob[];
  nodes: readonly string[];
  loading?: boolean;
  fetching?: boolean;
  error?: unknown;
  onRetry?: () => void;
  guard: SelfBackupGuard;
  onOpen: (guest: PveGuest) => void;
  /** Beside the count: guests without a job and the recommended job. */
  toolbarExtra?: React.ReactNode;
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
  className,
}: {
  label: string;
  value: string | undefined;
  onChange: (value: string | undefined) => void;
  options: readonly { value: string; label: string }[];
  className?: string;
}) {
  return (
    <Select
      value={value ?? ALL}
      onValueChange={(next) => onChange(next === ALL ? undefined : next)}
    >
      <SelectTrigger
        size="sm"
        aria-label={label}
        className={cn(
          "h-8 w-full overflow-hidden whitespace-nowrap sm:w-44",
          value && "border-primary/60",
          className,
        )}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function GuestsTable({
  rows,
  matching,
  total,
  problems,
  search,
  onSearchChange,
  jobs,
  nodes,
  loading = false,
  fetching = false,
  error,
  onRetry,
  guard,
  onOpen,
  toolbarExtra,
}: GuestsTableProps) {
  const { t } = useTranslation(PVE_NAMESPACE);
  const columns = React.useMemo<ColumnDef<GuestRow>[]>(
    () => [
      {
        id: "vmid",
        accessorFn: (row) => row.guest.vmid,
        header: t("guests.vmid"),
        size: GUEST_COLUMN_SIZES.vmid,
        meta: { label: t("guests.vmid"), numeric: true },
        cell: ({ row }) => row.original.guest.vmid,
      },
      {
        id: "name",
        accessorFn: (row) => row.guest.name ?? "",
        header: t("guests.name"),
        size: GUEST_COLUMN_SIZES.name,
        enableHiding: false,
        meta: { label: t("guests.name") },
        cell: ({ row }) => {
          const guest = row.original.guest;
          const name = guest.name ?? String(guest.vmid);
          const Icon = guest.kind === "vm" ? Box : Container;
          return (
            <span className="flex min-w-0 items-center gap-1.5">
              <Icon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
              <span className="sr-only">{t(`guests.${guest.kind}`)} </span>
              <button
                type="button"
                {...{ [GUEST_NAME_ATTRIBUTE]: guest.id }}
                onClick={() => onOpen(guest)}
                title={name}
                className="min-w-0 truncate rounded-sm text-left font-medium underline-offset-4 outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
                aria-haspopup="dialog"
              >
                {name}
              </button>
              {guest.restowServer ? (
                <ServerCog
                  className="size-3.5 shrink-0 text-warning-text"
                  aria-label={t("selfBackup.badge")}
                  role="img"
                />
              ) : null}
            </span>
          );
        },
      },
      {
        id: "state",
        accessorFn: (row) => row.statuses[0]?.key ?? "",
        header: t("guests.state"),
        size: GUEST_COLUMN_SIZES.state,
        enableHiding: false,
        meta: { label: t("guests.state") },
        cell: ({ row }) => (
          <button
            type="button"
            className="-mx-1 flex w-full min-w-0 rounded-sm px-1 text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            onClick={() => onOpen(row.original.guest)}
            aria-label={t("sheet.openFor", {
              name: row.original.guest.name ?? row.original.guest.vmid,
            })}
            aria-haspopup="dialog"
            tabIndex={-1}
          >
            <GuestStatusCell guest={row.original.guest} statuses={row.original.statuses} />
          </button>
        ),
      },
      {
        id: "lastBackup",
        accessorFn: (row) => row.guest.lastBackupAt ?? "",
        header: t("guests.lastBackup"),
        size: GUEST_COLUMN_SIZES.lastBackup,
        meta: { label: t("guests.lastBackup") },
        cell: ({ row }) => (
          <RelativeTime value={row.original.guest.lastBackupAt} fallback={t("guests.never")} />
        ),
      },
      {
        id: "node",
        accessorFn: (row) => row.guest.node ?? "",
        header: t("guests.node"),
        size: GUEST_COLUMN_SIZES.node,
        meta: { label: t("guests.node") },
        cell: ({ row }) => (
          <span title={row.original.guest.node ?? undefined}>{row.original.guest.node ?? ""}</span>
        ),
      },
      {
        id: "size",
        accessorFn: (row) => row.guest.backups?.last?.contains ?? -1,
        header: t("guests.backup"),
        size: GUEST_COLUMN_SIZES.size,
        meta: { label: t("guests.backup") },
        cell: ({ row }) => <BackupSizeLine guest={row.original.guest} />,
      },
      {
        id: "job",
        accessorFn: (row) => row.guest.jobName ?? "",
        header: t("guests.job"),
        size: GUEST_COLUMN_SIZES.job,
        enableSorting: false,
        meta: { label: t("guests.job") },
        cell: ({ row }) =>
          row.original.guest.jobName ? (
            <span title={row.original.guest.jobName}>{row.original.guest.jobName}</span>
          ) : (
            <span className="text-muted-foreground">{t("guests.noJob")}</span>
          ),
      },
      {
        id: "actions",
        header: () => <span className="sr-only">{t("guests.actions")}</span>,
        size: GUEST_COLUMN_SIZES.actions,
        enableSorting: false,
        enableHiding: false,
        meta: { label: t("guests.actions"), cellClassName: "py-0" },
        cell: ({ row }) => <GuestActionButton guest={row.original.guest} guard={guard} />,
      },
    ],
    [t, guard, onOpen],
  );

  const sorting: SortingState = search.sort
    ? [{ id: search.sort, desc: Boolean(search.desc) }]
    : [];
  const pageSize = search.size ?? DEFAULT_GUEST_PAGE_SIZE;
  const filtered = hasGuestFilter(search);
  const problemsOnly = search.state === "problems";

  const stateOptions = [
    { value: ALL, label: t("guests.filter.allStates") },
    ...GUEST_STATE_FILTERS.map((value) => ({ value, label: t(`guests.filter.state.${value}`) })),
  ];

  return (
    <div className="space-y-3" data-slot="pve-guests">
      <div className="flex flex-col gap-2 lg:flex-row lg:flex-wrap lg:items-center">
        <DataTableSearch
          value={search.q ?? ""}
          onChange={(q) => onSearchChange({ q: q || undefined, page: undefined })}
          placeholder={t("guests.filter.search")}
        />
        <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center">
          <FilterSelect
            label={t("guests.node")}
            value={search.node}
            onChange={(node) => onSearchChange({ node, page: undefined })}
            options={[
              { value: ALL, label: t("guests.filter.allNodes") },
              ...nodes.map((node) => ({ value: node, label: node })),
            ]}
          />
          <FilterSelect
            label={t("guests.kind")}
            value={search.kind}
            onChange={(kind) =>
              onSearchChange({ kind: kind as PveSearch["kind"], page: undefined })
            }
            options={[
              { value: ALL, label: t("guests.filter.allKinds") },
              { value: "vm", label: t("guests.filter.vms") },
              { value: "ct", label: t("guests.filter.cts") },
            ]}
          />
          <FilterSelect
            label={t("guests.job")}
            value={search.job}
            onChange={(job) => onSearchChange({ job, page: undefined })}
            options={[
              { value: ALL, label: t("guests.filter.allJobs") },
              { value: NO_JOB, label: t("guests.noJob") },
              ...jobs.map((job) => ({ value: job.id, label: job.name })),
            ]}
          />
          <FilterSelect
            label={t("guests.state")}
            value={search.state}
            onChange={(state) =>
              onSearchChange({ state: state as GuestStateFilter | undefined, page: undefined })
            }
            options={stateOptions}
          />
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          aria-pressed={problemsOnly}
          className={cn(
            "h-8 self-start lg:self-auto",
            problemsOnly && "border-warning bg-warning/20 text-warning-text hover:bg-warning/30",
          )}
          onClick={() =>
            onSearchChange({ state: problemsOnly ? undefined : "problems", page: undefined })
          }
          data-slot="pve-problems-only"
        >
          <TriangleAlert aria-hidden="true" />
          {t("guests.filter.problemsOnly", { count: problems })}
        </Button>
      </div>
      <div className="flex min-h-8 flex-wrap items-center justify-between gap-2 text-sm">
        <p
          className="text-muted-foreground tabular-nums"
          aria-live="polite"
          data-slot="pve-guest-count"
        >
          {filtered
            ? t("guests.filter.countFiltered", { count: matching, total })
            : t("guests.filter.count", { count: total })}
        </p>
        {toolbarExtra}
      </div>
      <DataTable<GuestRow>
        id="pve-guests"
        label={t("guests.title")}
        columns={columns}
        data={rows}
        getRowId={(row) => row.guest.id}
        loading={loading}
        fetching={fetching}
        error={error}
        onRetry={onRetry}
        fixedLayout
        skeletonRows={8}
        maxHeight="none"
        filtered={filtered}
        onResetFilters={() =>
          onSearchChange({
            q: undefined,
            node: undefined,
            kind: undefined,
            job: undefined,
            state: undefined,
            page: undefined,
          })
        }
        empty={<EmptyState variant="plain" icon={Container} title={t("guests.empty")} />}
        sorting={{
          mode: "manual",
          state: sorting,
          onChange: (next) => {
            const first = next[0];
            const sort =
              first && (GUEST_SORTS as readonly string[]).includes(first.id)
                ? (first.id as GuestSort)
                : undefined;
            onSearchChange({
              sort,
              desc: sort && first?.desc ? true : undefined,
              page: undefined,
            });
          },
        }}
        pagination={{
          mode: "manual",
          pageIndex: (search.page ?? 1) - 1,
          pageSize,
          rowCount: matching,
          pageSizes: GUEST_PAGE_SIZES,
          onChange: (next) =>
            onSearchChange({
              page: next.pageIndex > 0 ? next.pageIndex + 1 : undefined,
              size: next.pageSize === DEFAULT_GUEST_PAGE_SIZE ? undefined : next.pageSize,
            }),
        }}
        onRowClick={(row) => onOpen(row.guest)}
        columnsMenu={false}
      />
    </div>
  );
}
