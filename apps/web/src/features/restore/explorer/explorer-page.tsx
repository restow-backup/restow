import {
  ArchiveRestore,
  ArrowUp,
  ChevronDown,
  Download,
  FileSearch,
  FolderX,
  PanelLeft,
  SearchX,
} from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { type LayoutStorage, useDefaultLayout } from "react-resizable-panels";

import { EmptyState, ErrorState, usePageWidth } from "@/components/kit";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { ExportDialog, type ExportDialogRequest } from "@/features/exports/export-dialog";
import { ExportMenuItems } from "@/features/exports/export-menu-items";
import type {
  SnapshotObject,
  StoredVersion,
  TreeEntry,
  TreeSort,
  Version,
} from "@/features/restore/api";
import { RestoreDialog, type RestoreDialogRequest } from "@/features/restore/dialog/restore-dialog";
import { AccountList } from "@/features/restore/explorer/account-list";
import { Breadcrumbs } from "@/features/restore/explorer/breadcrumbs";
import { type DetailsActions, DetailsPanel } from "@/features/restore/explorer/details-panel";
import {
  NoAccountsState,
  NoRestorePointState,
  useCanProtect,
} from "@/features/restore/explorer/empty-states";
import { objectLabel } from "@/features/restore/explorer/entry-icon";
import { FolderTree } from "@/features/restore/explorer/folder-tree";
import { ItemList } from "@/features/restore/explorer/item-list";
import { RestorePointBar } from "@/features/restore/explorer/restore-point-bar";
import { SearchField } from "@/features/restore/explorer/search-field";
import { SelectionBar } from "@/features/restore/explorer/selection-bar";
import {
  type ExplorerSearch,
  activeQuery,
  preferredObject,
  withFolder,
  withItem,
  withObject,
  withQuery,
  withSnapshot,
  withSort,
} from "@/features/restore/lib/explorer-search";
import { normalizePath, parentPathOf } from "@/features/restore/lib/paths";
import {
  EMPTY_SELECTION,
  type Selection,
  deselectAll,
  selectAll,
  selectionOf,
  toSelectedEntry,
  toggle,
} from "@/features/restore/lib/selection";
import { useMediaQuery } from "@/features/restore/lib/use-media-query";
import {
  snapshotOfVersion,
  storedVersionEntry,
  versionEntry,
} from "@/features/restore/lib/versions";
import { useExplorerSearch } from "@/features/restore/navigation";
import { RestoreTabs } from "@/features/restore/restore-tabs";
import {
  useSnapshotObjects,
  useSnapshotSearch,
  useSnapshots,
  useTree,
} from "@/features/restore/use-restore-data";
import { formatInteger } from "@/lib/format";
import { useSession } from "@/lib/session";

/**
 * `localStorage` wrapped for `react-resizable-panels`' `useDefaultLayout`, so
 * a private-browsing or storage-disabled failure never breaks the layout —
 * the pane sizes just stop being remembered (same reasoning as `@/i18n.ts`'s
 * own `localStorage` access).
 */
const panelLayoutStorage: LayoutStorage = {
  getItem: (key) => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  setItem: (key, value) => {
    try {
      localStorage.setItem(key, value);
    } catch {
      // Ignore storage access failures (private mode, disabled cookies).
    }
  },
};

/** Stable ids of the explorer's four panes, for `useDefaultLayout`'s `panelIds`. */
const PANEL_IDS = ["accounts", "tree", "items", "reading"];
/** `localStorage` key prefix `useDefaultLayout` saves the remembered pane sizes under, one per user. */
const PANEL_LAYOUT_PREFIX = "restow.restore.explorer.panels";

/**
 * The restore explorer: a full-width, four-pane layout — accounts, folders,
 * items, reading pane — with resizable panes remembered per user
 * (`useDefaultLayout` below). Pick an account and a restore point, browse
 * folders like a file manager, read a mail in place, select across folders,
 * and restore or download. Everything that identifies the view lives in the
 * URL.
 */
export function ExplorerPage() {
  usePageWidth("full");
  const { t } = useTranslation("restore");
  // include=all: every account of the tenant, even one still without a
  // restore point, so the account list can say so instead of hiding it.
  const objects = useSnapshotObjects(true);
  const canProtect = useCanProtect();

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <RestoreTabs current="browse" />
      <PageHeader title={t("explorer.title")} description={t("explorer.subtitle")} />

      {objects.isPending ? (
        <ExplorerSkeleton />
      ) : objects.isError ? (
        <ErrorState
          title={t("explorer.object.loadError")}
          error={objects.error}
          onRetry={() => void objects.refetch()}
          retrying={objects.isFetching}
        />
      ) : objects.data.length === 0 ? (
        <NoAccountsState canProtect={canProtect} />
      ) : (
        <ExplorerShell objects={objects.data} />
      )}
    </div>
  );
}

function ExplorerSkeleton() {
  return (
    <div className="grid min-h-0 flex-1 gap-2 lg:grid-cols-[16rem_16rem_minmax(0,1fr)_20rem]">
      <Skeleton className="hidden h-full lg:block" />
      <Skeleton className="hidden h-full lg:block" />
      <Skeleton className="h-full" />
      <Skeleton className="hidden h-full lg:block" />
    </div>
  );
}

/**
 * The four resizable panes and the restore point timeline along the bottom
 * edge, all mounted exactly once: switching account or restore point never remounts
 * any of this, it only swaps what each piece shows. That keeps the account
 * list's search text, filter, scroll position and focus intact across a
 * switch, and the panes never resize or flash — only the multi-select,
 * the open dialog and which entry was last opened reset (they belong to one
 * restore point, not to the explorer itself).
 */
function ExplorerShell({ objects }: { objects: SnapshotObject[] }) {
  const { t } = useTranslation("restore");
  const { user } = useSession();
  const canProtect = useCanProtect();
  const wide = useMediaQuery("(min-width: 1024px)");
  const [search, setSearch] = useExplorerSearch();

  const object = objects.find((candidate) => candidate.id === search.object) ?? null;
  React.useEffect(() => {
    const fallback = preferredObject(objects);
    if (!object && fallback) {
      setSearch(withObject(fallback.id), { replace: true });
    }
  }, [object, objects, setSearch]);

  const objectId = object?.id ?? null;
  const restorePoints = useSnapshots(objectId);
  const restorePoint =
    restorePoints.data?.find((candidate) => candidate.id === search.snapshot) ?? null;
  const latest = restorePoints.data?.[0] ?? null;
  React.useEffect(() => {
    if (objectId && !restorePoint && latest) {
      setSearch(withSnapshot(search, latest.id), { replace: true });
    }
  }, [objectId, restorePoint, latest, search, setSearch]);

  const snapshotId = restorePoint?.id ?? null;
  const path = normalizePath(search.path);
  const query = activeQuery(search);
  const sort: TreeSort = search.sort ?? "date";
  const tree = useTree(snapshotId, path, sort);
  const results = useSnapshotSearch(snapshotId, query);

  const [selection, setSelection] = React.useState<Selection>(EMPTY_SELECTION);
  const [dialog, setDialog] = React.useState<RestoreDialogRequest | null>(null);
  const [exportDialog, setExportDialog] = React.useState<ExportDialogRequest | null>(null);
  const [opened, setOpened] = React.useState<TreeEntry | null>(null);

  // A new restore point starts with its own selection: resetting these on
  // its id, rather than remounting the panes to get the same effect, keeps
  // the account list and the pane sizes untouched across the switch.
  // biome-ignore lint/correctness/useExhaustiveDependencies: snapshotId is the reset trigger, not a value the effect reads.
  React.useEffect(() => {
    setSelection(EMPTY_SELECTION);
    setDialog(null);
    setExportDialog(null);
    setOpened(null);
  }, [snapshotId]);

  const entries: TreeEntry[] = query ? (results.data?.hits ?? []) : tree.entries;
  const itemPath = normalizePath(search.item) || null;
  const detail =
    itemPath === null
      ? null
      : (entries.find((entry) => entry.path === itemPath) ??
        (opened?.path === itemPath ? opened : null));

  const openFolder = (folderPath: string) => setSearch(withFolder(search, folderPath));
  const openEntry = (entry: TreeEntry) => {
    if (entry.kind === "folder") {
      openFolder(entry.path);
      return;
    }
    setOpened(entry);
    setSearch(withItem(search, entry.path));
  };
  // Up/Down keyboard moves through the item list: same destination as
  // `openEntry`, but *replaces* the current history entry. Otherwise every
  // keystroke pushes a new one (a click plus three ArrowDown presses grew
  // history by four), and holding the key floods Back with every message
  // it passed over.
  const navigateEntry = (entry: TreeEntry) => {
    setOpened(entry);
    setSearch(withItem(search, entry.path), { replace: true });
  };
  const closeDetails = () => setSearch(withItem(search, undefined));
  const restoreScope = (scopeSelection: Selection, target: "original" | "download") => {
    if (!object || !restorePoint) {
      return;
    }
    setDialog({
      object,
      snapshot: restorePoint,
      scope: { kind: "selection", selection: scopeSelection },
      target,
    });
  };
  // Mail export: a selection, the folder being browsed (`folderOnly`), or everything.
  const exportScope = (scopeSelection: Selection | null) => {
    if (!object || !restorePoint || object.kind === "onedrive") {
      return;
    }
    setExportDialog({
      origin: "snapshot",
      object,
      snapshot: restorePoint,
      scope: scopeSelection
        ? { kind: "selection", selection: scopeSelection }
        : { kind: "everything" },
    });
  };
  const exportFrom = (folderOnly: boolean) =>
    exportScope(
      folderOnly
        ? selectionOf({ path, kind: "folder", itemId: null, subject: null, size: 0 })
        : null,
    );

  const detailActions: DetailsActions = {
    onClose: closeDetails,
    onOpenFolder: openFolder,
    onReveal: (entry: TreeEntry) => {
      setOpened(entry);
      setSearch({ ...withFolder(search, parentPathOf(entry.path)), item: entry.path });
    },
    onRestore: (entry: TreeEntry, target) =>
      restoreScope(selectionOf(toSelectedEntry(entry)), target),
    onShowVersion: (version: Version) =>
      setSearch({
        ...search,
        snapshot: version.snapshotId,
        path: parentPathOf(version.path),
        item: version.path,
        q: undefined,
      }),
    onRestoreVersion: (version: Version, target) => {
      if (!detail || !object) return;
      setDialog({
        object,
        snapshot: snapshotOfVersion(version, restorePoints.data),
        scope: { kind: "selection", selection: selectionOf(versionEntry(version, detail)) },
        target,
      });
    },
    onDownloadStored: (version: StoredVersion) => {
      if (!object || !restorePoint) return;
      setDialog({
        object,
        snapshot: restorePoint,
        scope: { kind: "selection", selection: selectionOf(storedVersionEntry(version)) },
        onlyTarget: "download",
      });
    },
  };

  const details =
    detail && object && restorePoint ? (
      <DetailsPanel
        entry={detail}
        object={object}
        snapshot={restorePoint}
        canReveal={query !== null || parentPathOf(detail.path) !== path}
        {...detailActions}
      />
    ) : null;

  const accountList = (
    <AccountList objects={objects} value={objectId} onChange={(id) => setSearch(withObject(id))} />
  );

  // Below `lg` the account list is not a pane: this opens it as a sheet. It
  // sits with the file manager's own controls, so the explorer needs no
  // toolbar row of its own for it.
  const accountsTrigger = wide ? null : (
    <Sheet>
      <SheetTrigger asChild>
        <Button variant="outline" size="icon-sm" aria-label={t("explorer.accounts.title")}>
          <PanelLeft />
        </Button>
      </SheetTrigger>
      <SheetContent side="left" className="w-full max-w-xs p-0 sm:max-w-xs">
        <SheetTitle className="sr-only">{t("explorer.accounts.title")}</SheetTitle>
        {accountList}
      </SheetContent>
    </Sheet>
  );

  // Whether there is a restore point to actually browse: distinct from
  // `restorePoints.isPending` so a *known* empty or failed result (this
  // account has never been backed up, or the request failed) stops showing
  // loading skeletons and inert controls forever instead of resolving into
  // real content.
  const restorePointsKnown = !restorePoints.isPending;
  const restorePointsAvailable = restorePoints.isError
    ? false
    : (restorePoints.data?.length ?? 0) > 0;
  const restorePointReady = Boolean(object && restorePoint);

  const folderTreePane =
    object && restorePoint ? (
      <div className="h-full overflow-y-auto p-2">
        <FolderTree
          snapshotId={restorePoint.id}
          object={object}
          currentPath={path}
          onOpen={openFolder}
        />
      </div>
    ) : object && restorePointsKnown && !restorePointsAvailable ? (
      <p className="p-3 text-xs text-muted-foreground">{t("explorer.restorePoint.none")}</p>
    ) : (
      <div className="space-y-2 p-3">
        <Skeleton className="h-6 w-3/4" />
        <Skeleton className="h-5 w-1/2" />
        <Skeleton className="h-5 w-2/3" />
      </div>
    );

  const itemListPane = (
    <div className="flex h-full min-h-0 flex-col">
      {object ? (
        <ItemListHeader
          query={query}
          path={path}
          rootLabel={objectLabel(object)}
          objectKind={object.kind}
          sort={sort}
          resultCount={results.data?.hits.length ?? 0}
          searching={results.isFetching}
          restorePointReady={restorePointReady}
          leading={accountsTrigger}
          onOpenFolder={openFolder}
          onSortChange={(next) => setSearch(withSort(search, next))}
          searchValue={search.q ?? ""}
          onSearchCommit={(q) => setSearch(withQuery(search, q), { replace: true })}
          onWholeRestore={() =>
            restorePoint &&
            setDialog({
              object,
              snapshot: restorePoint,
              scope: { kind: "everything" },
              target: "original",
            })
          }
          onWholeDownload={() =>
            restorePoint &&
            setDialog({
              object,
              snapshot: restorePoint,
              scope: { kind: "everything" },
              target: "download",
            })
          }
          onExport={object.kind === "onedrive" ? undefined : exportFrom}
        />
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {restorePoints.isError ? (
          <div className="p-4">
            <ErrorState
              title={t("explorer.restorePoint.loadError")}
              error={restorePoints.error}
              onRetry={() => void restorePoints.refetch()}
              retrying={restorePoints.isFetching}
            />
          </div>
        ) : restorePoints.data && restorePoints.data.length === 0 ? (
          <div className="p-4">
            <NoRestorePointState canProtect={canProtect} />
          </div>
        ) : !object || !restorePoint ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 6 }, (_, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder rows
              <Skeleton key={index} className="h-9 w-full" />
            ))}
          </div>
        ) : (
          <ListContent
            query={query}
            tree={tree}
            results={results}
            path={path}
            entries={entries}
            onOpenFolder={openFolder}
          >
            <ItemList
              entries={entries}
              objectKind={object.kind}
              selection={selection}
              activePath={itemPath}
              showLocation={query !== null}
              onToggle={(entry) => setSelection((current) => toggle(current, entry))}
              onToggleAll={(select) =>
                setSelection((current) =>
                  select ? selectAll(current, entries) : deselectAll(current, entries),
                )
              }
              onOpen={openEntry}
              onNavigate={navigateEntry}
            />
          </ListContent>
        )}
      </div>
    </div>
  );

  const readingPane = (
    <div className="h-full overflow-y-auto p-4">{details ?? <DetailsPlaceholder />}</div>
  );

  const layoutId = `${PANEL_LAYOUT_PREFIX}.${user?.id ?? "anon"}`;
  const savedLayout = useDefaultLayout({
    id: layoutId,
    storage: panelLayoutStorage,
    panelIds: PANEL_IDS,
  });

  return (
    <>
      {wide ? (
        <ResizablePanelGroup
          orientation="horizontal"
          defaultLayout={savedLayout.defaultLayout}
          onLayoutChanged={savedLayout.onLayoutChanged}
          className="min-h-0 flex-1 rounded-lg border border-border"
        >
          {/* Defaults favour the items pane over the accounts/tree ones: the
              item list's own columns hide below `@lg`/`@xl`/`@3xl`
              container-query widths (item-list.tsx), so at a common laptop
              window width (1280px) the old 18/16/38/28 split left the items
              pane under 400px wide — Date and From both hidden, nothing
              past Subject and Size. This split still leaves every pane
              comfortably above its own `minSize`, and a saved layout
              (`useDefaultLayout` above) always wins over these once the
              person has resized anything themselves. */}
          <ResizablePanel id="accounts" defaultSize="16%" minSize="14%" maxSize="28%">
            {accountList}
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel id="tree" defaultSize="14%" minSize="10%" maxSize="28%">
            {folderTreePane}
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel id="items" defaultSize="42%" minSize="22%">
            {itemListPane}
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel id="reading" defaultSize="28%" minSize="18%">
            {readingPane}
          </ResizablePanel>
        </ResizablePanelGroup>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-border">
          {itemListPane}
        </div>
      )}

      {wide ? null : (
        <Sheet open={details !== null} onOpenChange={(open) => (open ? undefined : closeDetails())}>
          <SheetContent
            side="right"
            hideClose
            className="w-full max-w-md overflow-y-auto p-4 sm:max-w-md"
            aria-describedby={undefined}
          >
            <SheetTitle className="sr-only">{t("details.title")}</SheetTitle>
            {details}
          </SheetContent>
        </Sheet>
      )}

      {selection.size > 0 ? (
        <SelectionBar
          selection={selection}
          onClear={() => setSelection(EMPTY_SELECTION)}
          onRestore={() => restoreScope(selection, "original")}
          onDownload={() => restoreScope(selection, "download")}
          onExport={object?.kind === "onedrive" ? undefined : () => exportScope(selection)}
        />
      ) : null}

      <RestorePointBar
        restorePoints={restorePoints.data}
        loading={restorePoints.isPending}
        failed={restorePoints.isError}
        value={snapshotId}
        onChange={(id) => setSearch(withSnapshot(search, id))}
      />

      <RestoreDialog
        request={dialog}
        onClose={() => setDialog(null)}
        onStarted={() => {
          if (dialog?.scope.kind === "selection" && dialog.scope.selection === selection) {
            setSelection(EMPTY_SELECTION);
          }
        }}
      />

      <ExportDialog request={exportDialog} onClose={() => setExportDialog(null)} />
    </>
  );
}

function ItemListHeader({
  query,
  path,
  rootLabel,
  objectKind,
  sort,
  resultCount,
  searching,
  restorePointReady,
  leading,
  onOpenFolder,
  onSortChange,
  searchValue,
  onSearchCommit,
  onWholeRestore,
  onWholeDownload,
  onExport,
}: {
  query: string | null;
  path: string;
  rootLabel: string;
  objectKind: SnapshotObject["kind"];
  sort: TreeSort;
  resultCount: number;
  searching: boolean;
  /** Whether there is a browsed restore point to sort, search or restore from. */
  restorePointReady: boolean;
  /** Shown before everything else in the first row (the account list's trigger on narrow screens). */
  leading: React.ReactNode;
  onOpenFolder: (path: string) => void;
  onSortChange: (sort: TreeSort) => void;
  searchValue: string;
  onSearchCommit: (query: string) => void;
  onWholeRestore: () => void;
  onWholeDownload: () => void;
  /** Opens the export dialog for the current folder or everything; absent where mail cannot be exported. */
  onExport?: (folderOnly: boolean) => void;
}) {
  const { t } = useTranslation("restore");
  return (
    <div className="space-y-2 border-b border-border px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        {leading}
        {query ? (
          <SearchHeading query={query} count={resultCount} loading={searching} />
        ) : (
          <>
            {path ? (
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => onOpenFolder(parentPathOf(path))}
                aria-label={t("explorer.actions.up")}
              >
                <ArrowUp />
              </Button>
            ) : null}
            {/* `min-w-40` (not `min-w-0`): with `flex-wrap`, a flexed item
                still shrinks to fit its line before the row wraps, which
                squeezed this breadcrumb to single characters in a narrow
                pane instead of pushing the sort toggle to its own line. A
                real minimum width makes the *later* items wrap instead. */}
            <div className="min-w-40 flex-1">
              <Breadcrumbs
                path={path}
                rootLabel={rootLabel}
                objectKind={objectKind}
                onOpen={onOpenFolder}
              />
            </div>
            <ToggleGroup
              type="single"
              variant="outline"
              size="sm"
              value={sort}
              onValueChange={(next) => next && onSortChange(next as TreeSort)}
              aria-label={t("explorer.sort.label")}
              disabled={!restorePointReady}
            >
              <ToggleGroupItem value="date">{t("explorer.sort.date")}</ToggleGroupItem>
              <ToggleGroupItem value="name">{t("explorer.sort.name")}</ToggleGroupItem>
            </ToggleGroup>
          </>
        )}
        <WholeSnapshotMenu
          disabled={!restorePointReady}
          onRestore={onWholeRestore}
          onDownload={onWholeDownload}
          onExport={onExport}
          inFolder={!query && path !== ""}
        />
      </div>
      <SearchField value={searchValue} onCommit={onSearchCommit} disabled={!restorePointReady} />
    </div>
  );
}

function SearchHeading({
  query,
  count,
  loading,
}: { query: string; count: number; loading: boolean }) {
  const { t } = useTranslation("restore");
  return (
    <p className="min-w-0 flex-1 truncate text-sm" aria-live="polite" aria-busy={loading}>
      {t("explorer.search.results", { count, query })}
    </p>
  );
}

function WholeSnapshotMenu({
  disabled,
  onRestore,
  onDownload,
  onExport,
  inFolder,
}: {
  disabled: boolean;
  onRestore: () => void;
  onDownload: () => void;
  onExport?: (folderOnly: boolean) => void;
  inFolder: boolean;
}) {
  const { t } = useTranslation("restore");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" disabled={disabled}>
          {t("explorer.whole.trigger")}
          <ChevronDown />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>{t("explorer.whole.label")}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onRestore}>
          <ArchiveRestore />
          {t("explorer.whole.restore")}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onDownload}>
          <Download />
          {t("explorer.whole.download")}
        </DropdownMenuItem>
        {onExport ? <ExportMenuItems inFolder={inFolder} onExport={onExport} /> : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function DetailsPlaceholder() {
  const { t } = useTranslation("restore");
  return (
    <EmptyState
      icon={FileSearch}
      title={t("details.title")}
      description={t("details.empty")}
      variant="plain"
    />
  );
}

/** Loading, failure and empty states around the listing; the list renders when there is data. */
function ListContent({
  query,
  tree,
  results,
  path,
  entries,
  onOpenFolder,
  children,
}: {
  query: string | null;
  tree: ReturnType<typeof useTree>;
  results: ReturnType<typeof useSnapshotSearch>;
  path: string;
  entries: TreeEntry[];
  onOpenFolder: (path: string) => void;
  children: React.ReactNode;
}) {
  const { t, i18n } = useTranslation("restore");
  const language = i18n.resolvedLanguage ?? i18n.language;
  const source = query ? results : tree;

  if (source.isPending) {
    return (
      <div className="space-y-2 p-4">
        {Array.from({ length: 6 }, (_, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder rows
          <Skeleton key={index} className="h-9 w-full" />
        ))}
      </div>
    );
  }
  if (source.isError) {
    return (
      <div className="p-4">
        <ErrorState
          title={t(query ? "explorer.search.loadError" : "explorer.loadError")}
          error={source.error}
          onRetry={() => void source.refetch()}
          retrying={source.isFetching}
        />
      </div>
    );
  }
  if (entries.length === 0) {
    return (
      <div className="p-4">
        {query ? (
          <EmptyState
            icon={SearchX}
            title={t("explorer.search.none", { query })}
            description={t("explorer.search.noneDescription")}
          />
        ) : (
          <EmptyState
            icon={FolderX}
            title={t(path ? "explorer.empty" : "explorer.emptyRoot")}
            description={path ? t("explorer.emptyDescription") : undefined}
            actions={
              path ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => onOpenFolder(parentPathOf(path))}
                >
                  <ArrowUp />
                  {t("explorer.actions.up")}
                </Button>
              ) : undefined
            }
          />
        )}
      </div>
    );
  }

  return (
    <>
      {children}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-3 text-xs text-muted-foreground">
        {query ? (
          <span>
            {results.data?.truncated
              ? t("explorer.search.truncated", { shown: formatInteger(entries.length, language) })
              : t("explorer.search.scope")}
          </span>
        ) : (
          <span>
            {t("explorer.shown", {
              shown: formatInteger(entries.length, language),
              total: formatInteger(tree.total, language),
            })}
          </span>
        )}
        {!query && tree.hasNextPage ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => void tree.fetchNextPage()}
            loading={tree.isFetchingNextPage}
          >
            {t("explorer.actions.loadMore")}
          </Button>
        ) : null}
      </div>
    </>
  );
}
