import { type ColumnDef, flexRender, getCoreRowModel, useReactTable } from "@tanstack/react-table";
import type { TFunction } from "i18next";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  CircleMinus,
  Cloud,
  FolderSearch,
  History,
  Inbox,
  ListPlus,
  Mail,
  RotateCcw,
  Search,
  ShieldOff,
  TriangleAlert,
  X,
} from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { ErrorState } from "@/components/error-state";
import { ConfirmDialog, type RowAction, RowActionsMenu, RowContextMenu } from "@/components/kit";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/sonner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  type TablePin,
  TableRow,
} from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { type JobsAccess, useJobsAccess } from "@/features/backup-jobs/components/access-note";
import { linkProps, newJobTo } from "@/features/backup-jobs/paths";
import { explorerAt } from "@/features/restore/navigation";
import { WarningSheet } from "@/features/warnings";
import { errorMessageKey } from "@/lib/api";
import { formatDateTime, formatInteger, formatRelative } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Link } from "@tanstack/react-router";

import {
  type BulkSelectionState,
  EMPTY_SELECTION,
  bulkTarget,
  clearSelection,
  isPageFullySelected,
  isPagePartiallySelected,
  isSelected as objectIsSelected,
  selectAllMatching,
  selectionCount,
  isEmpty as selectionIsEmpty,
  togglePage as togglePageSelection,
  toggleRow as toggleRowSelection,
} from "./bulk-selection";
import { useBulkSetProtection, useDebouncedValue, useProtectedObjects } from "./hooks";
import { useObjectActions } from "./object-actions";
import { BackupCause, CredentialCause } from "./object-causes";
import {
  backupFailure,
  backupState,
  credentialFailure,
  credentialView,
  hasCredentialProblem,
  objectStatusView,
  objectSubtitle,
  objectTitle,
  pageCount,
  readinessView,
} from "./presenters";
import { type DirectorySearch, PAGE_SIZES, hasObjectFilters, toObjectsQuery } from "./search";
import type {
  BulkProtectionInput,
  DirectorySource,
  ObjectKind,
  ObjectSort,
  ObjectsFilter,
  ProtectedObject,
} from "./types";

const ALL = "all";
/** Bulk actions apply to one source; picking exactly one is what enables them. */
const BULK_ACTIONS = ["include", "exclude", "reset"] as const;
type BulkAction = (typeof BULK_ACTIONS)[number];

const KIND_ICON: Record<ObjectKind, typeof Mail> = {
  mailbox: Mail,
  onedrive: Cloud,
  imap: Inbox,
};

/** Columns the API can sort by; the others are facts joined per page. */
const SORTABLE = new Set<ObjectSort>(["name", "kind", "status"]);

interface ObjectsPanelProps {
  search: DirectorySearch;
  onSearchChange: (change: Partial<DirectorySearch>) => void;
  sources: readonly DirectorySource[];
  onShowSources: () => void;
}

/** Combined active/total over every source the panel knows about, for the header count. */
function protectedTotals(sources: readonly DirectorySource[]): { active: number; total: number } {
  return sources.reduce(
    (acc, source) => ({
      active: acc.active + source.counts.active,
      total: acc.total + source.counts.total,
    }),
    { active: 0, total: 0 },
  );
}

export function ObjectsPanel({
  search,
  onSearchChange,
  sources,
  onShowSources,
}: ObjectsPanelProps) {
  const { t, i18n } = useTranslation("directory");
  const query = toObjectsQuery(search);
  const objects = useProtectedObjects(query);
  const language = i18n.resolvedLanguage ?? i18n.language;

  // Bulk selection applies to one source; a filter or an only source picks it.
  const activeSourceId = search.source ?? (sources.length === 1 ? sources[0]?.id : undefined);
  const activeSource = sources.find((source) => source.id === activeSourceId);
  const [selection, setSelection] = React.useState<BulkSelectionState>(EMPTY_SELECTION);
  const jobs = useJobsAccess();
  const queryKey = JSON.stringify(query);
  const lastQueryKey = React.useRef(queryKey);
  if (lastQueryKey.current !== queryKey) {
    lastQueryKey.current = queryKey;
    if (!selectionIsEmpty(selection)) {
      // A changed filter or page can no longer promise what was selected still applies.
      setSelection(EMPTY_SELECTION);
    }
  }

  const pageIds = React.useMemo(() => (objects.data?.items ?? []).map((o) => o.id), [objects.data]);
  const columns = React.useMemo(
    () =>
      objectColumns(t, language, {
        selectable: activeSourceId !== undefined,
        selection,
        pageIds,
        onToggleRow: (id) => setSelection((current) => toggleRowSelection(current, id)),
        onTogglePage: () => setSelection((current) => togglePageSelection(current, pageIds)),
      }),
    [t, language, activeSourceId, selection, pageIds],
  );
  const table = useReactTable({
    data: objects.data?.items ?? [],
    columns,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (row) => row.id,
    manualPagination: true,
    manualSorting: true,
    rowCount: objects.data?.total ?? 0,
  });

  const total = objects.data?.total ?? 0;
  const pages = pageCount(total, query.pageSize);
  const filtered = hasObjectFilters(search);
  const protectedTotal = protectedTotals(sources);

  // Objects can disappear while a later page is open; land on the last page that exists.
  React.useEffect(() => {
    if (objects.data && total > 0 && query.page > pages) {
      onSearchChange({ page: pages });
    }
  }, [objects.data, total, query.page, pages, onSearchChange]);

  return (
    <div className="space-y-4">
      {protectedTotal.total > 0 ? (
        <p className="text-sm text-muted-foreground">
          {t("objects.protectedCount", {
            active: protectedTotal.active,
            total: protectedTotal.total,
          })}
        </p>
      ) : null}

      <ObjectFilters search={search} onSearchChange={onSearchChange} sources={sources} />

      {activeSourceId !== undefined ? (
        <BulkActionBar
          jobs={jobs}
          sourceId={activeSourceId}
          sourceKind={activeSource?.kind}
          selection={selection}
          onSelectionChange={setSelection}
          pageIds={pageIds}
          total={total}
          filter={query}
        />
      ) : null}

      {objects.isError && !objects.data ? (
        <ErrorState
          title={t("objects.error")}
          error={objects.error}
          onRetry={() => void objects.refetch()}
          retrying={objects.isFetching}
        />
      ) : (
        <div className="rounded-lg border border-border">
          <Table
            aria-busy={objects.isFetching || undefined}
            className="min-w-[56rem]"
            scrollLabel={t("title")}
          >
            <TableHeader>
              {table.getHeaderGroups().map((group) => (
                <TableRow key={group.id} className="hover:bg-transparent">
                  {group.headers.map((header) => {
                    const id = header.column.id as ObjectSort;
                    const label = flexRender(header.column.columnDef.header, header.getContext());
                    return (
                      <TableHead
                        key={header.id}
                        pin={columnPin(header.column.id)}
                        className={columnClass(header.column.id)}
                      >
                        {SORTABLE.has(id) ? (
                          <SortButton
                            column={id}
                            label={t(`objects.columns.${id}`)}
                            query={query}
                            onSearchChange={onSearchChange}
                          >
                            {label}
                          </SortButton>
                        ) : (
                          label
                        )}
                      </TableHead>
                    );
                  })}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody>
              {objects.isPending ? (
                <LoadingRows columnIds={columns.map((column) => column.id ?? "")} />
              ) : table.getRowModel().rows.length === 0 ? (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={columns.length} className="py-12">
                    <EmptyObjects
                      filtered={filtered}
                      hasSources={sources.length > 0}
                      onReset={() =>
                        onSearchChange({
                          q: undefined,
                          kind: undefined,
                          status: undefined,
                          source: undefined,
                          shared: undefined,
                        })
                      }
                      onShowSources={onShowSources}
                    />
                  </TableCell>
                </TableRow>
              ) : (
                table.getRowModel().rows.map((row) => (
                  <ObjectRow key={row.id} object={row.original} selection={selection} jobs={jobs}>
                    {row.getVisibleCells().map((cell) => (
                      <TableCell
                        key={cell.id}
                        pin={columnPin(cell.column.id)}
                        className={columnClass(cell.column.id)}
                      >
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </TableCell>
                    ))}
                  </ObjectRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      )}

      {total > 0 ? (
        <Pagination
          page={query.page}
          pages={pages}
          pageSize={query.pageSize}
          total={total}
          onSearchChange={onSearchChange}
        />
      ) : null}
    </div>
  );
}

/**
 * Above the table once at least one row is checked: how many, a way to reach
 * past the page ("select all N matching"), and the three bulk decisions —
 * each behind a confirmation that states the count and the effect, exactly
 * like the per-row actions, just applied to many objects through the same
 * per-object logic on the server.
 */
function BulkActionBar({
  jobs,
  sourceId,
  sourceKind,
  selection,
  onSelectionChange,
  pageIds,
  total,
  filter,
}: {
  jobs: JobsAccess;
  sourceId: string;
  /** Reset only makes sense for an M365 source (IMAP accounts have no rules to fall back to). */
  sourceKind: DirectorySource["kind"] | undefined;
  selection: BulkSelectionState;
  onSelectionChange: (next: BulkSelectionState) => void;
  pageIds: readonly string[];
  total: number;
  filter: ObjectsFilter;
}) {
  const { t } = useTranslation("directory");
  const bulk = useBulkSetProtection();
  const canReset = sourceKind === "m365";

  if (selectionIsEmpty(selection)) {
    return null;
  }

  const count = selectionCount(selection, total);
  const offerAllMatching =
    selection.mode === "ids" && isPageFullySelected(selection, pageIds) && total > pageIds.length;

  const applyBulk = (action: BulkAction) => {
    const input: BulkProtectionInput = { action, ...bulkTarget(selection, filter) };
    return bulk.mutateAsync({ sourceId, input }).then((result) => {
      toast.success(t(`bulk.done.${action}`, { count: result.updated }));
      onSelectionChange(EMPTY_SELECTION);
      return result;
    });
  };

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted/30 p-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <span className="font-medium">{t("bulk.selected", { count })}</span>
        {offerAllMatching ? (
          <Button
            variant="link"
            size="sm"
            className="h-auto p-0"
            onClick={() => onSelectionChange(selectAllMatching())}
          >
            {t("bulk.selectAllMatching", { count: total })}
          </Button>
        ) : null}
        <Button
          variant="link"
          size="sm"
          className="h-auto p-0 text-muted-foreground"
          onClick={() => onSelectionChange(clearSelection())}
        >
          {t("bulk.clear")}
        </Button>
      </div>
      <div className="flex flex-wrap gap-2">
        {selection.mode === "ids" && !jobs.closed ? (
          <Button variant="outline" size="sm" asChild data-action="newJobFromSelection">
            <Link {...linkProps(newJobTo("mail", [...selection.ids]))}>
              <ListPlus aria-hidden="true" />
              {t("rowActions.newJobFromSelection", { count: selection.ids.size })}
            </Link>
          </Button>
        ) : null}
        <ConfirmDialog
          trigger={
            <Button variant="outline" size="sm">
              <CircleCheck />
              {t("bulk.include")}
            </Button>
          }
          title={t("bulk.confirm.include.title", { count })}
          description={t("bulk.confirm.include.description", { count })}
          confirmLabel={t("bulk.confirm.include.confirm")}
          onConfirm={() => applyBulk("include")}
        />
        <ConfirmDialog
          trigger={
            <Button variant="outline" size="sm">
              <CircleMinus />
              {t("bulk.exclude")}
            </Button>
          }
          title={t("bulk.confirm.exclude.title", { count })}
          description={t("bulk.confirm.exclude.description", { count })}
          confirmLabel={t("bulk.confirm.exclude.confirm")}
          destructive
          onConfirm={() => applyBulk("exclude")}
        />
        {canReset ? (
          <ConfirmDialog
            trigger={
              <Button variant="outline" size="sm">
                <RotateCcw />
                {t("bulk.reset")}
              </Button>
            }
            title={t("bulk.confirm.reset.title", { count })}
            description={t("bulk.confirm.reset.description", { count })}
            confirmLabel={t("bulk.confirm.reset.confirm")}
            onConfirm={() => applyBulk("reset")}
          />
        ) : null}
      </div>
    </div>
  );
}

/**
 * The name stays on the left while the other columns scroll. It is pinned
 * where it stands: the selection checkbox in front of it scrolls away under it.
 */
function columnPin(columnId: string): TablePin | undefined {
  return columnId === "name" ? { left: 0, width: 260, edge: true } : undefined;
}

/** Narrow screens keep name, status and actions; the rest appears from md/lg on. */
function columnClass(columnId: string): string | undefined {
  switch (columnId) {
    case "select":
      return "w-10";
    case "kind":
      return "hidden md:table-cell";
    case "lastBackup":
    case "readiness":
      return "hidden lg:table-cell";
    case "actions":
      return "w-12 text-right";
    default:
      return undefined;
  }
}

interface SelectionColumnState {
  selectable: boolean;
  selection: BulkSelectionState;
  pageIds: readonly string[];
  onToggleRow: (id: string) => void;
  onTogglePage: () => void;
}

function objectColumns(
  t: TFunction<"directory">,
  language: string,
  selectionState: SelectionColumnState,
): ColumnDef<ProtectedObject>[] {
  const selectColumn: ColumnDef<ProtectedObject>[] = selectionState.selectable
    ? [
        {
          id: "select",
          header: () => (
            <Checkbox
              checked={
                isPageFullySelected(selectionState.selection, selectionState.pageIds)
                  ? true
                  : isPagePartiallySelected(selectionState.selection, selectionState.pageIds)
                    ? "indeterminate"
                    : false
              }
              onCheckedChange={selectionState.onTogglePage}
              disabled={selectionState.pageIds.length === 0}
              aria-label={t("bulk.selectPage")}
            />
          ),
          cell: ({ row }) => (
            <Checkbox
              checked={objectIsSelected(selectionState.selection, row.original.id)}
              onCheckedChange={() => selectionState.onToggleRow(row.original.id)}
              aria-label={t("actions.menu", { name: objectTitle(row.original) })}
            />
          ),
        },
      ]
    : [];
  return [
    ...selectColumn,
    {
      id: "name",
      header: t("objects.columns.name"),
      cell: ({ row }) => <NameCell object={row.original} />,
    },
    {
      id: "kind",
      header: t("objects.columns.kind"),
      cell: ({ row }) => {
        const Icon = KIND_ICON[row.original.kind];
        return (
          <div className="flex items-start gap-2">
            <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <div className="min-w-0">
              <div>{t(`kind.${row.original.kind}`)}</div>
              <div className="truncate text-xs text-muted-foreground">
                {row.original.sourceName}
              </div>
            </div>
          </div>
        );
      },
    },
    {
      id: "status",
      header: t("objects.columns.status"),
      cell: ({ row }) => {
        const view = objectStatusView(row.original);
        return (
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge variant={view.variant} tabIndex={0}>
                {t(`status.${view.suffix}`)}
              </Badge>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs">{t(`statusHint.${view.suffix}`)}</TooltipContent>
          </Tooltip>
        );
      },
    },
    {
      id: "lastBackup",
      header: t("objects.columns.lastBackup"),
      cell: ({ row }) => <BackupCell object={row.original} language={language} />,
    },
    {
      id: "readiness",
      header: t("objects.columns.readiness"),
      cell: ({ row }) => <ReadinessCell object={row.original} language={language} />,
    },
    {
      id: "credential",
      header: t("objects.columns.credential"),
      cell: ({ row }) => <CredentialCell object={row.original} language={language} />,
    },
    {
      id: "actions",
      header: () => <span className="sr-only">{t("objects.columns.actions")}</span>,
      cell: () => <ObjectActionsCell />,
    },
  ];
}

/** The actions of the row being rendered, for its "…" menu (see `ObjectRow`). */
const RowActionsContext = React.createContext<{ actions: RowAction[]; name: string } | null>(null);

function ObjectActionsCell() {
  const row = React.useContext(RowActionsContext);
  return row ? <RowActionsMenu actions={row.actions} name={row.name} /> : null;
}

/**
 * Where an object leads and what it can start: its restore points on the file restore page
 * (mailboxes and IMAP accounts), a restore in the explorer, and a new job with it. Closed with a
 * reason while there is nothing to restore, or while the viewer may not change jobs.
 */
function objectLinkActions(
  object: ProtectedObject,
  t: TFunction<"directory">,
  jobs: JobsAccess,
): RowAction[] {
  const nothing = object.snapshotCount === 0;
  const reason = nothing ? t("rowActions.noBackup") : undefined;
  const actions: RowAction[] = [];
  actions.push(
    {
      id: "explorer",
      label: t("rowActions.explorer"),
      icon: FolderSearch,
      disabled: nothing,
      reason,
      link: explorerAt(object.id),
    },
    {
      id: "newJob",
      label: t("rowActions.newJob"),
      icon: ListPlus,
      disabled: jobs.closed,
      reason: jobs.reason,
      link: newJobTo("mail", [object.id]),
    },
  );
  return actions;
}

/**
 * One row of the objects table with its actions: the "…" menu at its end and the context menu of
 * the row offer the same entries. A row among several checked ones offers a new job with all of
 * them.
 */
function ObjectRow({
  object,
  selection,
  jobs,
  children,
}: {
  object: ProtectedObject;
  selection: BulkSelectionState;
  jobs: JobsAccess;
  children: React.ReactNode;
}) {
  const { t } = useTranslation("directory");
  const own = useObjectActions(object);
  const actions = [...objectLinkActions(object, t, jobs), ...own.actions];
  const name = objectTitle(object);
  const selected = objectIsSelected(selection, object.id);
  const several = selected && selection.mode === "ids" && selection.ids.size > 1;
  const contextActions = (): RowAction[] => {
    if (!several) {
      return actions;
    }
    return [
      {
        id: "newJobFromSelection",
        label: t("rowActions.newJobFromSelection", { count: selection.ids.size }),
        icon: ListPlus,
        disabled: jobs.closed,
        reason: jobs.reason,
        link: newJobTo("mail", [...selection.ids]),
      },
    ];
  };
  const value = { actions, name };
  return (
    <RowActionsContext.Provider value={value}>
      <RowContextMenu
        actions={contextActions}
        label={
          several
            ? t("rowActions.selectionMenu", { count: selection.ids.size })
            : t("actions.menu", { name })
        }
      >
        <TableRow
          data-selected={selected || undefined}
          className="data-[selected=true]:[--row-mix:100%] data-[state=open]:[--row-mix:50%]"
        >
          {children}
        </TableRow>
      </RowContextMenu>
      {own.dialogs}
    </RowActionsContext.Provider>
  );
}

function NameCell({ object }: { object: ProtectedObject }) {
  const { t } = useTranslation("directory");
  const subtitle = objectSubtitle(object);
  return (
    <div className="min-w-0 space-y-1">
      <div className="truncate font-medium">{objectTitle(object)}</div>
      {subtitle ? <div className="truncate text-xs text-muted-foreground">{subtitle}</div> : null}
      {object.sharedOrBlocked || object.override ? (
        <div className="flex flex-wrap gap-1">
          {object.sharedOrBlocked ? (
            <HintBadge variant="outline" label={t("sharedOrBlocked.label")}>
              {t("sharedOrBlocked.hint")}
            </HintBadge>
          ) : null}
          {object.override ? (
            <HintBadge
              variant="secondary"
              label={t(`override.${object.override}`)}
              icon={object.override === "exclude" ? ShieldOff : undefined}
            >
              {t(`override.${object.override}Hint`)}
            </HintBadge>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function HintBadge({
  variant,
  label,
  icon: Icon,
  children,
}: {
  variant: NonNullable<BadgeProps["variant"]>;
  label: string;
  icon?: typeof Mail;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant={variant} tabIndex={0}>
          {Icon ? <Icon aria-hidden="true" /> : null}
          {label}
        </Badge>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">{children}</TooltipContent>
    </Tooltip>
  );
}

function BackupCell({ object, language }: { object: ProtectedObject; language: string }) {
  const { t } = useTranslation("directory");
  const state = backupState(object);
  switch (state.kind) {
    case "running":
      return <Badge variant="secondary">{t("backup.running")}</Badge>;
    case "failed": {
      const failure = backupFailure(object);
      const job = object.latestBackupJob;
      const when = formatRelative(state.at, language) ?? "";
      if (!failure || !job) {
        return (
          <HintBadge variant="destructive" label={t("backup.failed")}>
            {t("backup.failedHint", { when })}
          </HintBadge>
        );
      }
      // The cause is right below, so the tooltip need not send anyone to the jobs view for it.
      return (
        <div className="space-y-1">
          <HintBadge variant="destructive" label={t("backup.failed")}>
            {t("backup.failedWhen", { when })}
          </HintBadge>
          <BackupCause failure={failure} jobId={job.id} linkLabel={t("backup.openJob")} />
        </div>
      );
    }
    case "done":
      return (
        <div className="space-y-0.5">
          <time dateTime={state.at} title={formatDateTime(state.at, language) ?? undefined}>
            {formatRelative(state.at, language)}
          </time>
          <div className="text-xs text-muted-foreground">
            {t("backup.snapshots", { count: object.snapshotCount })}
          </div>
          {object.warning ? <BackupWarning object={object} language={language} /> : null}
        </div>
      );
    default:
      return <span className="text-muted-foreground">{t("backup.never")}</span>;
  }
}

/**
 * The newest backup left items behind: a warning badge (or the quieter acknowledged one) and the
 * way to the reasons, so the badge is never a dead end (features/warnings).
 */
function BackupWarning({ object, language }: { object: ProtectedObject; language: string }) {
  const { t } = useTranslation("directory");
  const [open, setOpen] = React.useState(false);
  const warning = object.warning;
  if (!warning) {
    return null;
  }
  const acknowledged = warning.state === "acknowledged";
  const when = formatRelative(object.lastBackupAt, language) ?? "";
  return (
    <div className="space-y-0.5 pt-0.5" data-warning={warning.state}>
      <HintBadge
        variant={acknowledged ? "muted" : "warning"}
        label={t(acknowledged ? "backup.acknowledged" : "backup.warning")}
        icon={acknowledged ? undefined : TriangleAlert}
      >
        {t(acknowledged ? "backup.acknowledgedHint" : "backup.warningHint", {
          count: warning.failedItems,
          when,
        })}
      </HintBadge>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="block text-xs font-medium underline-offset-4 hover:underline"
      >
        {t("backup.reasons")}
      </button>
      <WarningSheet
        target={open ? { kind: "object", id: object.id } : null}
        name={objectTitle(object)}
        onOpenChange={setOpen}
      />
    </div>
  );
}

function CredentialCell({ object, language }: { object: ProtectedObject; language: string }) {
  const { t } = useTranslation("directory");
  const view = credentialView(object);
  if (!view) {
    return null;
  }
  const credential = object.credential;
  const hint = credential?.checkedAt
    ? t("credential.checked", { when: formatRelative(credential.checkedAt, language) ?? "" })
    : t(`credential.hint.${view.key.split(".").at(-1)}`);
  // The stored error is a raw, always-English server description; a known
  // reason gets a translated line above it, so the German UI is never left
  // showing only English text for a failed login.
  const reason = credential?.errorReason
    ? t(`credential.probeReasons.${credential.errorReason}`)
    : null;
  const failure = credentialFailure(object);
  if (failure) {
    // A classified cause says the reason and keeps the raw text among its technical details.
    return (
      <div className="space-y-1">
        <HintBadge variant={view.variant} label={t(view.key)}>
          {hint}
        </HintBadge>
        <CredentialCause object={object} failure={failure} />
      </div>
    );
  }
  return (
    <HintBadge variant={view.variant} label={t(view.key)}>
      {hint}
      {reason ? <div className="mt-1 text-xs">{reason}</div> : null}
      {credential?.error ? (
        <div className="mt-1 text-xs text-muted-foreground">{credential.error}</div>
      ) : null}
    </HintBadge>
  );
}

function ReadinessCell({ object, language }: { object: ProtectedObject; language: string }) {
  const { t } = useTranslation("directory");
  const view = readinessView(object);
  const hint = hasCredentialProblem(object)
    ? t("readiness.needsCredentialHint")
    : object.readiness
      ? t("readiness.checked", { when: formatRelative(object.readiness.checkedAt, language) ?? "" })
      : object.snapshotCount > 0
        ? t("readiness.unverifiedHint")
        : t("readiness.noneHint");
  return (
    <HintBadge variant={view.variant} label={t(view.key)}>
      {hint}
    </HintBadge>
  );
}

function SortButton({
  column,
  label,
  query,
  onSearchChange,
  children,
}: {
  column: ObjectSort;
  label: string;
  query: ReturnType<typeof toObjectsQuery>;
  onSearchChange: (change: Partial<DirectorySearch>) => void;
  children: React.ReactNode;
}) {
  const { t } = useTranslation("directory");
  const active = query.sort === column;
  const Icon = !active ? ArrowUpDown : query.order === "asc" ? ArrowUp : ArrowDown;
  return (
    <button
      type="button"
      className="-ml-1 inline-flex items-center gap-1 rounded px-1 py-0.5 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      aria-label={t("objects.sortBy", { column: label })}
      aria-sort={active ? (query.order === "asc" ? "ascending" : "descending") : undefined}
      onClick={() =>
        onSearchChange({
          sort: column,
          order: active && query.order === "asc" ? "desc" : "asc",
        })
      }
    >
      {children}
      <Icon className={cn("size-3.5", active ? "opacity-100" : "opacity-40")} aria-hidden="true" />
    </button>
  );
}

function ObjectFilters({
  search,
  onSearchChange,
  sources,
}: {
  search: DirectorySearch;
  onSearchChange: (change: Partial<DirectorySearch>) => void;
  sources: readonly DirectorySource[];
}) {
  const { t } = useTranslation("directory");
  const [text, setText] = React.useState(search.q ?? "");
  const debounced = useDebouncedValue(text, 300);
  // What the field last wrote to the URL, to tell our own updates from outside ones.
  const pushed = React.useRef(search.q ?? "");
  const change = React.useRef(onSearchChange);
  change.current = onSearchChange;

  // The URL is the source of truth; follow it when it changes elsewhere (reset, back button).
  React.useEffect(() => {
    const external = search.q ?? "";
    if (external !== pushed.current) {
      pushed.current = external;
      setText(external);
    }
  }, [search.q]);
  // Only a settled keystroke changes the URL.
  React.useEffect(() => {
    const next = debounced.trim();
    if (next !== pushed.current) {
      pushed.current = next;
      change.current({ q: next || undefined });
    }
  }, [debounced]);

  const filtered = hasObjectFilters(search);
  return (
    <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
      {/* Wide enough for its placeholder; the filters next to it wrap instead. */}
      <div className="relative lg:max-w-sm lg:min-w-72 lg:flex-1">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden="true"
        />
        <Input
          type="search"
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder={t("objects.search")}
          aria-label={t("objects.search")}
          className="pl-9"
        />
      </div>
      <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
        <Select
          value={search.kind ?? ALL}
          onValueChange={(value) =>
            onSearchChange({ kind: value === ALL ? undefined : (value as ObjectKind) })
          }
        >
          <SelectTrigger className="w-full sm:w-40" aria-label={t("objects.filters.kind")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{t("objects.filters.allKinds")}</SelectItem>
            {(["mailbox", "onedrive", "imap"] as const).map((kind) => (
              <SelectItem key={kind} value={kind}>
                {t(`kind.${kind}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={search.status ?? ALL}
          onValueChange={(value) =>
            onSearchChange({
              status: value === ALL ? undefined : (value as DirectorySearch["status"]),
            })
          }
        >
          <SelectTrigger className="w-full sm:w-48" aria-label={t("objects.filters.status")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{t("objects.filters.allStatuses")}</SelectItem>
            {(["active", "excluded", "not_selected", "orphaned"] as const).map((status) => (
              <SelectItem key={status} value={status}>
                {t(`status.${status}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={search.shared === undefined ? ALL : String(search.shared)}
          onValueChange={(value) =>
            onSearchChange({ shared: value === ALL ? undefined : value === "true" })
          }
        >
          <SelectTrigger
            className="col-span-2 w-full sm:col-span-1 sm:w-64"
            aria-label={t("objects.filters.shared")}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{t("objects.filters.sharedAll")}</SelectItem>
            <SelectItem value="true">{t("objects.filters.sharedOnly")}</SelectItem>
            <SelectItem value="false">{t("objects.filters.sharedExcluded")}</SelectItem>
          </SelectContent>
        </Select>
        {sources.length > 1 ? (
          <Select
            value={search.source ?? ALL}
            onValueChange={(value) => onSearchChange({ source: value === ALL ? undefined : value })}
          >
            <SelectTrigger
              className="col-span-2 w-full sm:w-48"
              aria-label={t("objects.filters.source")}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{t("objects.filters.allSources")}</SelectItem>
              {sources.map((source) => (
                <SelectItem key={source.id} value={source.id}>
                  {source.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
        {filtered ? (
          <Button
            variant="ghost"
            className="col-span-2 sm:col-span-1"
            onClick={() =>
              onSearchChange({
                q: undefined,
                kind: undefined,
                status: undefined,
                source: undefined,
                shared: undefined,
              })
            }
          >
            <X />
            {t("objects.filters.reset")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function LoadingRows({ columnIds }: { columnIds: readonly string[] }) {
  return (
    <>
      {Array.from({ length: 5 }, (_, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
        <TableRow key={index} className="hover:bg-transparent">
          {columnIds.map((id) => (
            <TableCell key={id} pin={columnPin(id)} className={columnClass(id)}>
              {id === "actions" || id === "select" ? null : (
                <Skeleton className="h-4 w-full max-w-40" />
              )}
            </TableCell>
          ))}
        </TableRow>
      ))}
    </>
  );
}

function EmptyObjects({
  filtered,
  hasSources,
  onReset,
  onShowSources,
}: {
  filtered: boolean;
  hasSources: boolean;
  onReset: () => void;
  onShowSources: () => void;
}) {
  const { t } = useTranslation("directory");
  if (filtered) {
    return (
      <div className="flex flex-col items-center gap-3 text-center">
        <p className="text-sm text-muted-foreground">{t("objects.empty.filtered")}</p>
        <Button variant="outline" size="sm" onClick={onReset}>
          {t("objects.filters.reset")}
        </Button>
      </div>
    );
  }
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-2 text-center">
      <p className="font-medium">{t("objects.empty.title")}</p>
      <p className="text-sm text-muted-foreground">{t("objects.empty.description")}</p>
      {hasSources ? (
        <Button variant="outline" size="sm" className="mt-2" onClick={onShowSources}>
          {t("tabs.sources")}
        </Button>
      ) : null}
    </div>
  );
}

function Pagination({
  page,
  pages,
  pageSize,
  total,
  onSearchChange,
}: {
  page: number;
  pages: number;
  pageSize: number;
  total: number;
  onSearchChange: (change: Partial<DirectorySearch>) => void;
}) {
  const { t, i18n } = useTranslation("directory");
  const language = i18n.resolvedLanguage ?? i18n.language;
  const from = Math.min(total, (page - 1) * pageSize + 1);
  const to = Math.min(total, page * pageSize);
  return (
    <div className="flex flex-col-reverse gap-3 text-sm sm:flex-row sm:items-center sm:justify-between">
      <p className="text-muted-foreground" aria-live="polite">
        {t("objects.range", {
          from: formatInteger(from, language),
          to: formatInteger(to, language),
          total: formatInteger(total, language),
        })}
      </p>
      <div className="flex items-center justify-between gap-4 sm:justify-end">
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground">{t("objects.pageSize")}</span>
          <Select
            value={String(pageSize)}
            onValueChange={(value) => onSearchChange({ size: Number(value) })}
          >
            <SelectTrigger size="sm" className="w-20" aria-label={t("objects.pageSize")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PAGE_SIZES.map((size) => (
                <SelectItem key={size} value={String(size)}>
                  {size}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-1">
          <span className="mr-2 text-muted-foreground">{t("objects.page", { page, pages })}</span>
          <Button
            variant="outline"
            size="icon-sm"
            disabled={page <= 1}
            onClick={() => onSearchChange({ page: page - 1 })}
            aria-label={t("objects.previous")}
          >
            <ChevronLeft />
          </Button>
          <Button
            variant="outline"
            size="icon-sm"
            disabled={page >= pages}
            onClick={() => onSearchChange({ page: page + 1 })}
            aria-label={t("objects.next")}
          >
            <ChevronRight />
          </Button>
        </div>
      </div>
    </div>
  );
}
