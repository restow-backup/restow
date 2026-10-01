import {
  ChevronRight,
  Download,
  File,
  Folder,
  FolderOpen,
  Link2,
  Loader2,
  RotateCw,
  X,
} from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { ErrorState } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

import { type BrowseEntry, LIMITS } from "../api.js";
import { type EndpointFormat, useEndpointFormat } from "../hooks.js";
import {
  MANY_ITEMS_NOTE_AT,
  type Selection,
  allState,
  coveredByFolder,
  endpointErrorKey,
  isRetryableProblem,
  isSelectable,
  pathSegments,
} from "../presenters.js";

/** The path bar: the snapshot's root and every folder down to the current one. */
export function PathBar({
  path,
  onNavigate,
}: {
  path: string;
  onNavigate: (path: string) => void;
}) {
  const { t } = useTranslation("endpoints");
  const segments = pathSegments(path);
  return (
    <nav aria-label={t("browser.pathBar")} className="min-w-0">
      <ol className="flex flex-wrap items-center gap-x-0.5 gap-y-1 text-sm">
        <li>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2"
            aria-current={segments.length === 0 ? "page" : undefined}
            onClick={() => onNavigate("/")}
          >
            <FolderOpen aria-hidden="true" />
            {t("browser.root")}
          </Button>
        </li>
        {segments.map((segment, index) => {
          const last = index === segments.length - 1;
          return (
            <li key={segment.path} className="flex min-w-0 items-center gap-0.5">
              <ChevronRight
                aria-hidden="true"
                className="size-3.5 shrink-0 text-muted-foreground"
              />
              <Button
                variant="ghost"
                size="sm"
                className={cn("h-7 max-w-48 px-2", last && "font-semibold")}
                aria-current={last ? "page" : undefined}
                onClick={() => onNavigate(segment.path)}
                title={segment.path}
              >
                <span className="truncate">{segment.name}</span>
              </Button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function EntryIcon({ type, className }: { type: BrowseEntry["type"]; className?: string }) {
  const cls = cn("size-4 shrink-0 text-muted-foreground", className);
  if (type === "dir") return <Folder aria-hidden="true" className={cn(cls, "text-primary")} />;
  if (type === "symlink") return <Link2 aria-hidden="true" className={cls} />;
  return <File aria-hidden="true" className={cls} />;
}

/** The folder listing of a snapshot, with a box in front of every file and folder. */
export function EntryTable({
  path,
  entries,
  hasMore,
  selection,
  onToggle,
  onToggleAll,
  onOpenFolder,
  format,
}: {
  /** The folder the entries belong to. */
  path: string;
  /** What the server sent so far, in its order: folders first, then by name. */
  entries: readonly BrowseEntry[];
  /** The folder has more entries than are loaded; selecting "all" then means the loaded ones. */
  hasMore: boolean;
  selection: Selection;
  onToggle: (entry: BrowseEntry) => void;
  onToggleAll: (entries: readonly BrowseEntry[]) => void;
  onOpenFolder: (path: string) => void;
  format: EndpointFormat;
}) {
  const { t } = format;
  const all = allState(selection, entries);
  const insideSelectedFolder = coveredByFolder(selection, path);
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-10 pl-4">
            <Checkbox
              checked={all}
              disabled={entries.filter(isSelectable).length === 0 || insideSelectedFolder}
              onCheckedChange={() => onToggleAll(entries)}
              aria-label={hasMore ? t("browser.selectAllLoaded") : t("browser.selectAll")}
            />
          </TableHead>
          <TableHead>{t("browser.columns.name")}</TableHead>
          <TableHead className="text-right whitespace-nowrap">
            {t("browser.columns.size")}
          </TableHead>
          <TableHead className="hidden whitespace-nowrap pr-4 sm:table-cell">
            {t("browser.columns.modified")}
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {entries.length === 0 ? (
          <TableRow>
            <TableCell colSpan={4} className="py-8 text-center text-muted-foreground">
              {t("browser.emptyFolder")}
            </TableCell>
          </TableRow>
        ) : (
          entries.map((entry) => {
            const covered = coveredByFolder(selection, entry.path);
            const checked = selection.has(entry.path) || covered;
            return (
              <TableRow key={entry.path} data-state={checked ? "selected" : undefined}>
                <TableCell className="w-10 pl-4">
                  <Checkbox
                    checked={checked}
                    disabled={!isSelectable(entry) || covered}
                    onCheckedChange={() => onToggle(entry)}
                    aria-label={
                      covered
                        ? t("browser.coveredBy", { name: entry.name })
                        : t("browser.select", { name: entry.name })
                    }
                  />
                </TableCell>
                <TableCell className="max-w-0 min-w-40">
                  <div className="flex min-w-0 items-start gap-2">
                    <EntryIcon type={entry.type} className="mt-0.5" />
                    <div className="min-w-0">
                      {entry.type === "dir" ? (
                        <button
                          type="button"
                          onClick={() => onOpenFolder(entry.path)}
                          className="block max-w-full truncate rounded-sm text-left font-medium outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
                          title={entry.path}
                        >
                          {entry.name}
                        </button>
                      ) : (
                        <span className="block truncate" title={entry.path}>
                          {entry.name}
                        </span>
                      )}
                      {entry.type === "symlink" ? (
                        <span className="block text-xs text-muted-foreground">
                          {t("browser.symlink")}
                        </span>
                      ) : null}
                      {entry.type === "other" ? (
                        <span className="block text-xs text-muted-foreground">
                          {t("browser.special")}
                        </span>
                      ) : null}
                    </div>
                  </div>
                </TableCell>
                <TableCell className="text-right whitespace-nowrap tabular-nums">
                  {entry.size !== null && entry.type !== "dir" ? format.bytes(entry.size) : ""}
                </TableCell>
                <TableCell className="hidden whitespace-nowrap pr-4 text-muted-foreground sm:table-cell">
                  {entry.mtime ? (format.dateTime(entry.mtime) ?? "") : ""}
                </TableCell>
              </TableRow>
            );
          })
        )}
      </TableBody>
    </Table>
  );
}

/** What the selection allows: the counts and the two actions. */
export function SelectionBar({
  count,
  singleFiles,
  blockedDownload,
  blockedRestore,
  downloading,
  canRestore,
  onClear,
  onDownload,
  onRestore,
}: {
  count: number;
  /** Selected files that are not inside a selected folder. */
  singleFiles: number;
  blockedDownload: "too_many" | null;
  blockedRestore: "too_many" | null;
  /** The server is checking the selection and preparing the ZIP. */
  downloading: boolean;
  canRestore: boolean;
  onClear: () => void;
  onDownload: () => void;
  onRestore: () => void;
}) {
  const { t } = useTranslation("endpoints");
  return (
    <div data-slot="selection-bar" className="flex flex-col gap-3 border-t bg-muted/40 px-4 py-3">
      <div className="space-y-0.5 text-sm">
        <p className="font-medium" aria-live="polite">
          {count === 0 ? t("browser.selection.none") : t("browser.selection.count", { count })}
        </p>
        <p className="text-xs text-muted-foreground">{t("browser.selection.folderNote")}</p>
        {singleFiles > MANY_ITEMS_NOTE_AT ? (
          <p className="text-xs text-muted-foreground" data-selection-note="many">
            {t("browser.selection.manyNote", { count: MANY_ITEMS_NOTE_AT })}
          </p>
        ) : null}
        {blockedDownload ? (
          <p className="text-xs text-destructive-text" aria-live="polite">
            {t(`browser.selection.download.${blockedDownload}`, { max: LIMITS.downloadPaths })}
          </p>
        ) : null}
        {blockedRestore ? (
          <p className="text-xs text-destructive-text" aria-live="polite">
            {t("browser.selection.restore.too_many", { max: LIMITS.restorePaths })}
          </p>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          className="mr-auto"
          onClick={onClear}
          disabled={count === 0}
        >
          <X aria-hidden="true" />
          {t("browser.selection.clear")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={onDownload}
          disabled={count === 0 || blockedDownload !== null || downloading}
        >
          {downloading ? (
            <Loader2 aria-hidden="true" className="animate-spin" />
          ) : (
            <Download aria-hidden="true" />
          )}
          {downloading
            ? t("browser.selection.download.preparing")
            : t("browser.selection.downloadZip")}
        </Button>
        <Button size="sm" onClick={onRestore} disabled={!canRestore || count === 0}>
          <RotateCw aria-hidden="true" />
          {t("browser.selection.restore.action")}
        </Button>
      </div>
    </div>
  );
}

/** What the folder has shown so far and what more can be asked for. */
export interface FolderPages {
  path: string;
  entries: readonly BrowseEntry[];
  hasMore: boolean;
  loadingMore: boolean;
  /** Fetching the next page failed; the pages shown so far stay. */
  moreError: unknown;
  onLoadMore: () => void;
}

/** Loading, failure or the listing of the current folder, with a button for the next page. */
export function BrowserBody({
  loading,
  error,
  onRetry,
  retrying,
  pages,
  selection,
  onToggle,
  onToggleAll,
  onOpenFolder,
}: {
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  retrying: boolean;
  pages: FolderPages | undefined;
  selection: Selection;
  onToggle: (entry: BrowseEntry) => void;
  onToggleAll: (entries: readonly BrowseEntry[]) => void;
  onOpenFolder: (path: string) => void;
}) {
  const format = useEndpointFormat();
  const { t } = format;
  if (error) {
    return (
      <div className="p-4">
        <ErrorState
          title={isRetryableProblem(error) ? t("browser.busyTitle") : t("browser.errorTitle")}
          description={t(endpointErrorKey(error))}
          error={error}
          onRetry={onRetry}
          retrying={retrying}
        />
      </div>
    );
  }
  if (loading || !pages) {
    return (
      <div className="space-y-2 p-4" aria-busy="true" aria-hidden="true">
        {[0, 1, 2, 3, 4].map((row) => (
          <Skeleton key={row} className="h-8 w-full" />
        ))}
      </div>
    );
  }
  return (
    <>
      <EntryTable
        path={pages.path}
        entries={pages.entries}
        hasMore={pages.hasMore}
        selection={selection}
        onToggle={onToggle}
        onToggleAll={onToggleAll}
        onOpenFolder={onOpenFolder}
        format={format}
      />
      {pages.hasMore ? (
        <div
          data-browser="more"
          className="flex flex-wrap items-center justify-between gap-2 border-t px-4 py-3 text-sm"
        >
          <span className="text-muted-foreground" aria-live="polite">
            {pages.moreError
              ? t("browser.loadMoreError")
              : t("browser.shown", { count: pages.entries.length })}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={pages.onLoadMore}
            disabled={pages.loadingMore}
          >
            {pages.loadingMore ? <Loader2 aria-hidden="true" className="animate-spin" /> : null}
            {pages.loadingMore
              ? t("browser.loadingMore")
              : pages.moreError
                ? t("browser.loadMoreRetry")
                : t("browser.loadMore")}
          </Button>
        </div>
      ) : null}
    </>
  );
}
