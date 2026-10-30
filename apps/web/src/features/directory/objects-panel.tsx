import { Link } from "@tanstack/react-router";
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
  Globe,
  Inbox,
  ListChecks,
  ListPlus,
  Mail,
  Search,
  TriangleAlert,
  UsersRound,
  X,
} from "lucide-react";
import * as React from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { ErrorState } from "@/components/error-state";
import {
  ReadOnlyGroup,
  type RowAction,
  RowActionsMenu,
  RowContextMenu,
  useReadOnlyGroup,
} from "@/components/kit";
import { useSectionAside } from "@/components/layout/section-aside";
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
import { RecommendedJobButton } from "@/features/backup-jobs/components/recommended-job";
import { jobDefinitionTo, linkProps, newJobTo } from "@/features/backup-jobs/paths";
import { AddToJobDialog } from "@/features/endpoints/components/add-to-job-dialog";
import { explorerAt } from "@/features/restore/navigation";
import { WarningSheet } from "@/features/warnings";
import { formatDateTime, formatInteger, formatRelative } from "@/lib/format";
import { useMediaQuery } from "@/lib/use-media-query";
import { cn } from "@/lib/utils";

import {
  type BulkSelectionState,
  clearSelection,
  EMPTY_SELECTION,
  isPageFullySelected,
  isPagePartiallySelected,
  isSelected as objectIsSelected,
  selectionCount,
  isEmpty as selectionIsEmpty,
  togglePage as togglePageSelection,
  toggleRow as toggleRowSelection,
} from "./bulk-selection";
import { useDebouncedValue, useProtectedObjects } from "./hooks";
import { useBackupNowAction, useObjectActions } from "./object-actions";
import { BackupCause, CredentialCause } from "./object-causes";
import {
  backupFailure,
  backupState,
  credentialFailure,
  credentialView,
  hasCredentialProblem,
  inactiveDetail,
  objectStatusView,
  objectSubtitle,
  objectTitle,
  pageCount,
  protectionScope,
  readinessView,
} from "./presenters";
import { type DirectorySearch, hasObjectFilters, PAGE_SIZES, toObjectsQuery } from "./search";
import { clearOnEscape, SelectionPanel, selectionJobActions } from "./selection-panel";
import type {
  DirectorySource,
  ObjectKind,
  ObjectSort,
  ProtectedObject,
  SourceStatus,
} from "./types";

const ALL = "all";
/** From here on the tenant page shows its section column, where the selection panel docks. */
const WIDE = "(min-width: 64rem)";

const KIND_ICON: Record<ObjectKind, typeof Mail> = {
  mailbox: Mail,
  onedrive: Cloud,
  site: Globe,
  group: UsersRound,
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
function protectedTotals(sources: readonly DirectorySource[]): {
  active: number;
  total: number;
  toConfirm: number;
} {
  return sources.reduce(
    (acc, source) => ({
      active: acc.active + source.counts.active,
      total: acc.total + source.counts.total,
      toConfirm: acc.toConfirm + (source.counts.toConfirm ?? 0),
    }),
    { active: 0, total: 0, toConfirm: 0 },
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

  // Bulk protection applies to one source; a filter or an only source picks it. Confirming
  // objects no longer backed up works tenant-wide, so the "to confirm" filter selects as well.
  const activeSourceId = search.source ?? (sources.length === 1 ? sources[0]?.id : undefined);
  const activeSource = sources.find((source) => source.id === activeSourceId);
  const selectable = activeSourceId !== undefined || search.status === "to_confirm";
  const [selection, setSelection] = React.useState<BulkSelectionState>(EMPTY_SELECTION);
  const jobs = useJobsAccess();
  const [adding, setAdding] = React.useState<{ id: string; name: string }[] | null>(null);
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
  // The row last checked or unchecked, where focus returns once the selection is gone.
  const lastToggled = React.useRef<string | null>(null);
  const toggleRow = React.useCallback((id: string) => {
    lastToggled.current = id;
    setSelection((current) => toggleRowSelection(current, id));
  }, []);
  const togglePage = React.useCallback(() => {
    lastToggled.current = null;
    setSelection((current) => togglePageSelection(current, pageIds));
  }, [pageIds]);
  const selectionCells = React.useMemo(
    () => ({ selection, pageIds, toggleRow, togglePage }),
    [selection, pageIds, toggleRow, togglePage],
  );
  // Stable across checks and refetches: the cells read the selection from context. Columns made
  // anew would be new component types to React (flexRender renders a function as one), and every
  // cell would be remounted on each check, losing focus, open tooltips and menus.
  const columns = React.useMemo(
    () => objectColumns(t, language, selectable),
    [t, language, selectable],
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

  // The selection panel: docked in the free space of the tenant page's section column on wide
  // screens (a portal into its slot), a bar at the bottom of the viewport otherwise. Out of the
  // list's flow either way, so checking a row never moves the rows.
  const aside = useSectionAside();
  const wide = useMediaQuery(WIDE);
  const readOnly = useReadOnlyGroup();
  const panelRef = React.useRef<HTMLDivElement>(null);
  const tableRef = React.useRef<HTMLDivElement>(null);
  const hasSelection = selectable && !selectionIsEmpty(selection);
  const docked = hasSelection && aside !== null && wide;
  const clear = React.useCallback(() => setSelection(clearSelection()), []);

  // One live region stays mounted and only its text changes; it says the count, and that the
  // selection is gone once it was there (a region that appears with its text is often skipped).
  const hadSelection = React.useRef(false);
  if (hasSelection) {
    hadSelection.current = true;
  }
  const announcement = hasSelection
    ? t("bulk.selected", { count: selectionCount(selection, total) })
    : hadSelection.current
      ? t("bulk.cleared")
      : "";

  // When the selection ends with focus in the panel (cleared there, Escape, a confirmed action),
  // the focused control is gone with it: back to the row last checked, else the page checkbox.
  const hadSelectionBefore = React.useRef(false);
  React.useEffect(() => {
    const ended = hadSelectionBefore.current && !hasSelection;
    hadSelectionBefore.current = hasSelection;
    if (!ended) {
      return;
    }
    const timer = window.setTimeout(() => {
      const active = document.activeElement;
      if (active && active !== document.body) {
        return;
      }
      const table = tableRef.current;
      const id = lastToggled.current;
      const target =
        (id ? table?.querySelector<HTMLElement>(`[data-select-row="${CSS.escape(id)}"]`) : null) ??
        table?.querySelector<HTMLElement>("[data-select-page]");
      target?.focus();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [hasSelection]);

  const panel = hasSelection ? (
    <SelectionPanel
      ref={panelRef}
      variant={docked ? "column" : "bar"}
      jobs={jobs}
      sourceId={activeSourceId}
      sourceKind={activeSource?.kind}
      selection={selection}
      onSelectionChange={setSelection}
      pageIds={pageIds}
      total={total}
      filter={query}
      onAddToJob={setAdding}
    />
  ) : null;

  // Objects can disappear while a later page is open; land on the last page that exists.
  React.useEffect(() => {
    if (objects.data && total > 0 && query.page > pages) {
      onSearchChange({ page: pages });
    }
  }, [objects.data, total, query.page, pages, onSearchChange]);

  return (
    <AddToJobContext.Provider value={setAdding}>
      {/* Mounted once asked for: the dialog loads the jobs only then. */}
      {adding ? (
        <AddToJobDialog
          open
          kind="mail"
          onOpenChange={(open) => {
            if (!open) setAdding(null);
          }}
          endpoints={adding}
        />
      ) : null}
      <div className="space-y-4">
        {protectedTotal.total > 0 ? (
          <p className="text-sm text-muted-foreground">
            {t("objects.protectedCount", {
              active: protectedTotal.active,
              total: protectedTotal.total,
            })}
          </p>
        ) : null}

        {protectedTotal.toConfirm > 0 && search.status !== "to_confirm" ? (
          <div
            className="flex flex-col gap-2 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm sm:flex-row sm:items-center sm:justify-between"
            data-testid="inactive-to-confirm"
          >
            <span className="flex items-start gap-2">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              {t("inactive.banner", { count: protectedTotal.toConfirm })}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                // The count is tenant-wide: drop the other filters, or the list shows only part.
                onSearchChange({
                  status: "to_confirm",
                  q: undefined,
                  kind: undefined,
                  source: undefined,
                  job: undefined,
                  shared: undefined,
                  page: 1,
                })
              }
            >
              {t("inactive.showToConfirm")}
            </Button>
          </div>
        ) : null}

        <ObjectFilters search={search} onSearchChange={onSearchChange} sources={sources} />

        <p className="sr-only" aria-live="polite" aria-atomic="true" data-slot="selection-status">
          {announcement}
        </p>

        {docked ? (
          // The docked panel comes before the list in the document: a way to it, right before
          // the table (a few steps back from a checked row), onto its first action.
          <Button
            variant="outline"
            size="sm"
            className="sr-only focus-visible:not-sr-only"
            data-action="jumpToSelectionActions"
            onClick={() => {
              // The first action that takes the focus (a closed one does not), the clear button last.
              const root = panelRef.current;
              const candidates = root
                ? [
                    ...root.querySelectorAll<HTMLElement>(
                      "button[data-action]:not([data-action=clearSelection]):not([disabled])",
                    ),
                    ...root.querySelectorAll<HTMLElement>("button[data-action=clearSelection]"),
                  ]
                : [];
              for (const candidate of candidates) {
                candidate.focus();
                if (document.activeElement === candidate) {
                  return;
                }
              }
            }}
          >
            {t("bulk.jumpToActions")}
          </Button>
        ) : null}

        {objects.isError && !objects.data ? (
          <ErrorState
            title={t("objects.error")}
            error={objects.error}
            onRetry={() => void objects.refetch()}
            retrying={objects.isFetching}
          />
        ) : (
          <div ref={tableRef} className="rounded-lg border border-border">
            <SelectionContext.Provider value={selectionCells}>
              <Table
                // Escape in the list clears the selection, as it does in the panel.
                onKeyDown={hasSelection ? (event) => clearOnEscape(event, clear) : undefined}
                aria-busy={objects.isFetching || undefined}
                className="md:min-w-[56rem]"
                scrollLabel={t("title")}
              >
                <TableHeader>
                  {table.getHeaderGroups().map((group) => (
                    <TableRow key={group.id} className="hover:bg-transparent">
                      {group.headers.map((header) => {
                        const id = header.column.id as ObjectSort;
                        const label = flexRender(
                          header.column.columnDef.header,
                          header.getContext(),
                        );
                        return (
                          <TableHead
                            key={header.id}
                            pin={columnPin(header.column.id)}
                            className={columnClass(header.column.id)}
                            aria-sort={
                              !SORTABLE.has(id)
                                ? undefined
                                : query.sort !== id
                                  ? "none"
                                  : query.order === "asc"
                                    ? "ascending"
                                    : "descending"
                            }
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
                              job: undefined,
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
                      <ObjectRow
                        key={row.id}
                        object={row.original}
                        selection={selection}
                        jobs={jobs}
                        sourceStatus={sources.find((s) => s.id === row.original.sourceId)?.status}
                      >
                        {row.getVisibleCells().map((cell) => (
                          <TableCell
                            key={cell.id}
                            pin={columnPin(cell.column.id)}
                            className={columnClass(cell.column.id)}
                            data-column={cell.column.id}
                          >
                            {flexRender(cell.column.columnDef.cell, cell.getContext())}
                          </TableCell>
                        ))}
                      </ObjectRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </SelectionContext.Provider>
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

        {docked && aside
          ? createPortal(<ReadOnlyGroup closed={readOnly}>{panel}</ReadOnlyGroup>, aside)
          : panel}
      </div>
    </AddToJobContext.Provider>
  );
}

/**
 * The name stays on the left while the other columns scroll. It is pinned
 * where it stands: the selection checkbox in front of it scrolls away under it.
 */
function columnPin(columnId: string): TablePin | undefined {
  return columnId === "name" ? { left: 0, width: 260, edge: true } : undefined;
}

/** Narrow screens keep name, status, backup scope and actions; the rest appears from md/lg on. */
function columnClass(columnId: string): string | undefined {
  switch (columnId) {
    case "select":
      return "w-10";
    case "kind":
      return "hidden md:table-cell";
    case "lastBackup":
    case "readiness":
      return "hidden lg:table-cell";
    case "job":
      return "hidden xl:table-cell";
    case "actions":
      return "w-12 text-right";
    default:
      return undefined;
  }
}

/** The selection, for the checkbox cells (columns stay stable while it changes). */
const SelectionContext = React.createContext<{
  selection: BulkSelectionState;
  pageIds: readonly string[];
  toggleRow: (id: string) => void;
  togglePage: () => void;
}>({ selection: EMPTY_SELECTION, pageIds: [], toggleRow: () => {}, togglePage: () => {} });

function SelectPageHeader() {
  const { t } = useTranslation("directory");
  const { selection, pageIds, togglePage } = React.useContext(SelectionContext);
  return (
    <Checkbox
      checked={
        isPageFullySelected(selection, pageIds)
          ? true
          : isPagePartiallySelected(selection, pageIds)
            ? "indeterminate"
            : false
      }
      onCheckedChange={togglePage}
      disabled={pageIds.length === 0}
      aria-label={t("bulk.selectPage")}
      data-select-page=""
    />
  );
}

function SelectRowCell({ object }: { object: ProtectedObject }) {
  const { t } = useTranslation("directory");
  const { selection, toggleRow } = React.useContext(SelectionContext);
  return (
    <Checkbox
      checked={objectIsSelected(selection, object.id)}
      onCheckedChange={() => toggleRow(object.id)}
      aria-label={t("bulk.selectRow", { name: objectTitle(object) })}
      data-select-row={object.id}
    />
  );
}

function objectColumns(
  t: TFunction<"directory">,
  language: string,
  selectable: boolean,
): ColumnDef<ProtectedObject>[] {
  const selectColumn: ColumnDef<ProtectedObject>[] = selectable
    ? [
        {
          id: "select",
          header: () => <SelectPageHeader />,
          cell: ({ row }) => <SelectRowCell object={row.original} />,
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
          <div className="min-w-0 space-y-0.5">
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge variant={view.variant} tabIndex={0}>
                  {t(`status.${view.suffix}`)}
                </Badge>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs">{t(`statusHint.${view.suffix}`)}</TooltipContent>
            </Tooltip>
            <InactiveLine object={row.original} language={language} />
          </div>
        );
      },
    },
    {
      id: "scope",
      header: t("objects.columns.scope"),
      cell: ({ row }) => <ScopeCell object={row.original} />,
    },
    {
      id: "job",
      header: t("objects.columns.job"),
      cell: ({ row }) => <JobCell object={row.original} />,
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

/**
 * Under the status of an object no longer backed up: why and since when (amber, waiting for a
 * confirmation), or who confirmed it and when (grey). Nothing for any other object.
 */
function InactiveLine({ object, language }: { object: ProtectedObject; language: string }) {
  const { t } = useTranslation("directory");
  const detail = inactiveDetail(object);
  if (!detail) {
    return null;
  }
  const reason = t(detail.reasonKey);
  const since = detail.since ? formatDateTime(detail.since, language) : null;
  return (
    <div className="text-xs text-muted-foreground" data-testid="inactive-detail">
      <div>{since ? t("inactive.reasonSince", { reason, date: since }) : reason}</div>
      {detail.hintKey ? <div>{t(detail.hintKey)}</div> : null}
      {detail.confirmed ? (
        <div>
          {detail.confirmed.byMigration
            ? t("inactive.confirmedByMigration")
            : detail.confirmed.byExclusion
              ? t("inactive.confirmedByExclusion")
              : t("inactive.confirmedBy", {
                  who: detail.confirmed.by,
                  date: formatDateTime(detail.confirmed.at, language),
                })}
        </div>
      ) : null}
    </div>
  );
}

/** The backup job that covers the object, as a link; a note when it does not run on a schedule. */
function JobCell({ object }: { object: ProtectedObject }) {
  const { t } = useTranslation("directory");
  if (!object.job) {
    return object.coverage === "none" ? (
      <span className="text-muted-foreground">{t("job.none")}</span>
    ) : null;
  }
  return (
    <div className="min-w-0">
      <Link
        {...linkProps(jobDefinitionTo(object.job.id, "mail"))}
        className="block truncate rounded-sm font-medium outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
        title={object.job.name}
      >
        {object.job.name}
      </Link>
      {object.job.scheduled ? null : (
        <span className="block text-xs text-muted-foreground">{t("job.paused")}</span>
      )}
    </div>
  );
}

/** Opens "Add to job" for some objects; null where jobs cannot be managed. */
const AddToJobContext = React.createContext<
  ((objects: { id: string; name: string }[]) => void) | null
>(null);

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
  if (object.job) {
    actions.push({
      id: "openJob",
      label: t("rowActions.openJob"),
      icon: ListChecks,
      link: jobDefinitionTo(object.job.id, "mail"),
    });
  }
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
  sourceStatus,
  children,
}: {
  object: ProtectedObject;
  selection: BulkSelectionState;
  jobs: JobsAccess;
  sourceStatus?: SourceStatus;
  children: React.ReactNode;
}) {
  const { t } = useTranslation("directory");
  const own = useObjectActions(object);
  const addToJob = React.useContext(AddToJobContext);
  const name = objectTitle(object);
  const actions = [...objectLinkActions(object, t, jobs), ...own.actions];
  // An object in scope can join an existing job, not only a new one.
  if (addToJob && object.status === "active") {
    actions.splice(2, 0, {
      id: "addToJob",
      label: t("rowActions.addToJob"),
      icon: ListChecks,
      disabled: jobs.closed,
      reason: jobs.reason,
      onSelect: () => addToJob([{ id: object.id, name }]),
    });
  }
  const backupNow = useBackupNowAction(object, sourceStatus);
  if (backupNow) {
    actions.splice(1, 0, backupNow);
  }
  const selected = objectIsSelected(selection, object.id);
  const several = selected && selection.mode === "ids" && selection.ids.size > 1;
  const contextActions = (): RowAction[] =>
    several ? selectionJobActions(selection.ids, jobs, addToJob, t) : actions;
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
      {object.sharedOrBlocked ? (
        <div className="flex flex-wrap gap-1">
          <HintBadge variant="outline" label={t("sharedOrBlocked.label")}>
            {t("sharedOrBlocked.hint")}
          </HintBadge>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Whether the object is in the backup scope ("Included" / "Excluded") and who decided it below:
 * the source's rules, or an admin ("manual": an M365 override, or any IMAP account, which has no
 * rules). An object no longer backed up shows a dash: its status says why. Its override, which
 * applies again once it is back, is shown quietly.
 */
function ScopeCell({ object }: { object: ProtectedObject }) {
  const { t } = useTranslation("directory");
  const scope = protectionScope(object);
  if (!scope) {
    return (
      <div data-scope="none">
        <HintBadge
          variant="ghost"
          className="text-muted-foreground"
          label={
            <>
              <span aria-hidden="true">–</span>
              <span className="sr-only">{t("scope.none")}</span>
            </>
          }
        >
          {t("scope.inactiveHint")}
        </HintBadge>
      </div>
    );
  }
  const included = scope.decision === "included";
  const waiting = object.status === "orphaned";
  return (
    <div className="space-y-0.5" data-scope={scope.decision} data-scope-by={scope.by}>
      <HintBadge
        variant={included && !waiting ? "outline" : "muted"}
        label={t(`scope.${scope.decision}`)}
        icon={included ? CircleCheck : CircleMinus}
        contentClassName="space-y-1"
      >
        {object.sourceKind !== "m365" ? (
          <p>{t("scope.imapHint")}</p>
        ) : object.override ? (
          <p>
            <span className="font-medium">{t(`override.${object.override}`)}:</span>{" "}
            {t(`override.${object.override}Hint`)}
          </p>
        ) : (
          <p>{t("scope.ruleHint")}</p>
        )}
        {waiting ? <p>{t("scope.pendingHint")}</p> : null}
      </HintBadge>
      <div className="text-xs text-muted-foreground">
        {t(scope.by === "rule" ? "scope.byRule" : "scope.manual")}
      </div>
    </div>
  );
}

function HintBadge({
  variant,
  label,
  icon: Icon,
  className,
  contentClassName,
  children,
}: {
  variant: NonNullable<BadgeProps["variant"]>;
  label: React.ReactNode;
  icon?: typeof Mail;
  className?: string;
  contentClassName?: string;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant={variant} tabIndex={0} className={className}>
          {Icon ? <Icon aria-hidden="true" /> : null}
          {label}
        </Badge>
      </TooltipTrigger>
      <TooltipContent className={cn("max-w-xs", contentClassName)}>{children}</TooltipContent>
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
    case "not_backed_up":
      // Disabled or unlicensed: neutral, the backups that exist stay; nothing to fix here.
      return (
        <div className="space-y-0.5">
          <HintBadge variant="muted" label={t(`backup.notBackedUp.${state.reason}`)}>
            {t(`backup.notBackedUpHint.${state.reason}`)}
          </HintBadge>
          {state.at ? (
            <div className="text-xs text-muted-foreground">
              <time dateTime={state.at} title={formatDateTime(state.at, language) ?? undefined}>
                {formatRelative(state.at, language)}
              </time>
              {" · "}
              {t("backup.snapshots", { count: object.snapshotCount })}
            </div>
          ) : null}
        </div>
      );
    case "limited": {
      // Held back by a service: amber, with the cause below, and the next run tries again.
      const failure = backupFailure(object);
      const job = object.latestBackupJob;
      const when = formatRelative(state.at, language) ?? "";
      return (
        <div className="space-y-1">
          <HintBadge variant="warning" label={t("backup.limited")}>
            {t("backup.limitedWhen", { when })}
          </HintBadge>
          {failure && job ? (
            <BackupCause failure={failure} jobId={job.id} linkLabel={t("backup.openJob")} />
          ) : null}
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
            {(["mailbox", "onedrive", "site", "group", "imap"] as const).map((kind) => (
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
            {(
              ["active", "excluded", "not_selected", "orphaned", "to_confirm", "confirmed"] as const
            ).map((status) => (
              <SelectItem key={status} value={status}>
                {t(`status.${status}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={search.job ?? ALL}
          onValueChange={(value) =>
            onSearchChange({ job: value === ALL ? undefined : (value as DirectorySearch["job"]) })
          }
        >
          <SelectTrigger className="w-full sm:w-56" aria-label={t("objects.filters.job")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{t("objects.filters.allJobs")}</SelectItem>
            <SelectItem value="scheduled">{t("objects.filters.jobScheduled")}</SelectItem>
            <SelectItem value="unscheduled">{t("objects.filters.jobUnscheduled")}</SelectItem>
            <SelectItem value="none">{t("objects.filters.jobNone")}</SelectItem>
          </SelectContent>
        </Select>
        {/* Objects in no job: the recommended mail job over all objects protects them (#52). */}
        {search.job === "none" ? (
          <RecommendedJobButton scope={{ mail: true }} className="col-span-2 sm:col-span-1" />
        ) : null}
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
                job: undefined,
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
