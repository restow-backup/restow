import { Folder, FolderOpen, FolderX, Trash2, X } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { ErrorState } from "@/components/error-state";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
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
import { ApiError } from "@/lib/api";
import { formatBytes, formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { FormatBadge, FormatIcon } from "../components/format-badge";
import type { FolderEntry } from "../types";
import { useFolderListing } from "../use-imports";
import { type FolderSelection, coveringDirectory } from "./wizard-state";

/** The API lists at most this many entries of one folder. */
export const FOLDER_ENTRY_LIMIT = 2000;

export function toSelection(entry: FolderEntry): FolderSelection {
  return {
    path: entry.path,
    name: entry.name,
    type: entry.type,
    size: entry.size,
    format: entry.format,
  };
}

/** Key (below `folder.reasons`) of why an entry cannot be ticked; null for one that can. */
export function unsupportedReason(entry: FolderEntry): string | null {
  if (entry.type === "directory" || entry.supported) {
    return null;
  }
  if (entry.format === "pst") return "pst";
  if (entry.format === "unknown" || entry.format === null) return "unknown";
  return "other";
}

/** Folders first, then by name; the order the person expects from a file browser. */
export function sortEntries(entries: readonly FolderEntry[]): FolderEntry[] {
  return [...entries].sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === "directory" ? -1 : 1;
    }
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  });
}

interface FolderBrowserProps {
  path: string;
  onPathChange: (path: string) => void;
  selection: readonly FolderSelection[];
  onToggle: (entry: FolderSelection) => void;
}

/**
 * The server import folder as a file browser: breadcrumb, folders to open,
 * files with their detected format and a checkbox for files and whole folders.
 * Entries the import cannot read stay visible, disabled, with the reason.
 */
export function FolderBrowser({ path, onPathChange, selection, onToggle }: FolderBrowserProps) {
  const { t, i18n } = useTranslation("imports");
  const language = i18n.resolvedLanguage ?? i18n.language;
  const listing = useFolderListing(path, true);

  if (listing.isPending) {
    return (
      <div className="space-y-2" aria-busy="true">
        {Array.from({ length: 5 }, (_, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder rows
          <Skeleton key={index} className="h-10 w-full" />
        ))}
      </div>
    );
  }

  if (listing.isError) {
    const gone =
      listing.error instanceof ApiError &&
      (listing.error.status === 404 || listing.error.status === 422) &&
      path !== "";
    return gone ? (
      <Alert variant="warning">
        <FolderX />
        <AlertTitle>{t("folder.gone.title")}</AlertTitle>
        <AlertDescription className="space-y-2">
          <p>{t("folder.gone.description")}</p>
          <Button variant="outline" size="sm" onClick={() => onPathChange("")}>
            {t("folder.gone.toRoot")}
          </Button>
        </AlertDescription>
      </Alert>
    ) : (
      <ErrorState
        title={t("folder.loadError")}
        error={listing.error}
        onRetry={() => void listing.refetch()}
        retrying={listing.isFetching}
      />
    );
  }

  const data = listing.data;
  if (!data.enabled) {
    return (
      <Alert variant="warning">
        <FolderX />
        <AlertTitle>{t("folder.notEnabled.title")}</AlertTitle>
        <AlertDescription>{t("folder.notEnabled.description")}</AlertDescription>
      </Alert>
    );
  }

  const entries = sortEntries(data.entries);
  const segments = (data.current || path).split("/").filter(Boolean);

  return (
    <div className="space-y-3">
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            {segments.length === 0 ? (
              <BreadcrumbPage>{t("folder.root")}</BreadcrumbPage>
            ) : (
              <BreadcrumbLink asChild>
                <button type="button" onClick={() => onPathChange("")}>
                  {t("folder.root")}
                </button>
              </BreadcrumbLink>
            )}
          </BreadcrumbItem>
          {segments.map((segment, index) => {
            const target = segments.slice(0, index + 1).join("/");
            const last = index === segments.length - 1;
            return (
              <React.Fragment key={target}>
                <BreadcrumbSeparator />
                <BreadcrumbItem>
                  {last ? (
                    <BreadcrumbPage>{segment}</BreadcrumbPage>
                  ) : (
                    <BreadcrumbLink asChild>
                      <button type="button" onClick={() => onPathChange(target)}>
                        {segment}
                      </button>
                    </BreadcrumbLink>
                  )}
                </BreadcrumbItem>
              </React.Fragment>
            );
          })}
        </BreadcrumbList>
      </Breadcrumb>

      {entries.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
          {t("folder.empty")}
        </p>
      ) : (
        <div className="rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-10">
                  <span className="sr-only">{t("folder.columns.select")}</span>
                </TableHead>
                <TableHead>{t("folder.columns.name")}</TableHead>
                <TableHead className="hidden sm:table-cell">{t("folder.columns.format")}</TableHead>
                <TableHead className="hidden text-right sm:table-cell">
                  {t("folder.columns.size")}
                </TableHead>
                <TableHead className="hidden lg:table-cell">
                  {t("folder.columns.modified")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map((entry) => (
                <EntryRow
                  key={entry.path}
                  entry={entry}
                  language={language}
                  selection={selection}
                  onOpen={() => onPathChange(entry.path)}
                  onToggle={() => onToggle(toSelection(entry))}
                />
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {data.entries.length >= FOLDER_ENTRY_LIMIT ? (
        <p className="text-xs text-muted-foreground">
          {t("folder.truncated", { count: FOLDER_ENTRY_LIMIT })}
        </p>
      ) : null}
    </div>
  );
}

function EntryRow({
  entry,
  language,
  selection,
  onOpen,
  onToggle,
}: {
  entry: FolderEntry;
  language: string;
  selection: readonly FolderSelection[];
  onOpen: () => void;
  onToggle: () => void;
}) {
  const { t } = useTranslation("imports");
  const reason = unsupportedReason(entry);
  const covering = coveringDirectory(selection, entry.path);
  const ticked = selection.some((chosen) => chosen.path === entry.path) || covering !== null;
  const disabled = reason !== null || covering !== null;

  return (
    <TableRow
      data-state={ticked ? "selected" : undefined}
      className={cn(reason !== null && "text-muted-foreground")}
    >
      <TableCell className="w-10 align-top">
        <Checkbox
          checked={ticked}
          disabled={disabled}
          onCheckedChange={onToggle}
          aria-label={t("folder.select", { name: entry.name })}
        />
      </TableCell>
      <TableCell className="max-w-0 min-w-40 align-top">
        <div className="flex min-w-0 items-center gap-2">
          {entry.type === "directory" ? (
            <>
              <Folder aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
              <button
                type="button"
                onClick={onOpen}
                className="min-w-0 truncate rounded-sm text-left font-medium outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
                title={entry.name}
              >
                {entry.name}
              </button>
            </>
          ) : (
            <>
              <FormatIcon format={entry.format} className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 truncate" title={entry.name}>
                {entry.name}
              </span>
            </>
          )}
        </div>
        {reason ? (
          <p className="mt-0.5 text-xs">{t(`folder.reasons.${reason}`)}</p>
        ) : covering ? (
          <p className="mt-0.5 text-xs">{t("folder.covered", { folder: covering.name })}</p>
        ) : null}
        {/* On narrow screens the columns are hidden; keep the essentials under the name. */}
        <div className="mt-1 flex flex-wrap items-center gap-2 sm:hidden">
          {entry.type === "file" ? <FormatBadge format={entry.format} /> : null}
          {entry.size !== null ? (
            <span className="text-xs tabular-nums">{formatBytes(entry.size, language)}</span>
          ) : null}
        </div>
      </TableCell>
      <TableCell className="hidden align-top sm:table-cell">
        {entry.type === "directory" ? (
          <span className="text-xs text-muted-foreground">{t("folder.directory")}</span>
        ) : (
          <FormatBadge format={entry.format} />
        )}
      </TableCell>
      <TableCell className="hidden text-right align-top tabular-nums sm:table-cell">
        {entry.size !== null ? formatBytes(entry.size, language) : ""}
      </TableCell>
      <TableCell className="hidden align-top text-xs whitespace-nowrap lg:table-cell">
        {formatDateTime(entry.modifiedAt, language)}
      </TableCell>
    </TableRow>
  );
}

// --- What is ticked ------------------------------------------------------------------------

/** The ticked entries as a list with a way to take each one out again. */
export function SelectedEntries({
  selection,
  onRemove,
  onClear,
}: {
  selection: readonly FolderSelection[];
  onRemove: (path: string) => void;
  onClear: () => void;
}) {
  const { t, i18n } = useTranslation("imports");
  const language = i18n.resolvedLanguage ?? i18n.language;
  if (selection.length === 0) {
    return <p className="text-sm text-muted-foreground">{t("folder.nothingSelected")}</p>;
  }
  return (
    <section aria-label={t("folder.selected.title")} className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">
          {t("folder.selected.title")}
          <span className="ml-2 font-normal text-muted-foreground">
            {t("folder.selected.count", { count: selection.length })}
          </span>
        </h3>
        <Button variant="ghost" size="sm" onClick={onClear}>
          <Trash2 />
          {t("folder.selected.clear")}
        </Button>
      </div>
      <ul className="divide-y divide-border rounded-lg border border-border">
        {selection.map((entry) => (
          <li key={entry.path} className="flex items-center gap-3 px-3 py-2">
            {entry.type === "directory" ? (
              <FolderOpen aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
            ) : (
              <FormatIcon format={entry.format} className="size-4 shrink-0 text-muted-foreground" />
            )}
            <span className="min-w-0 flex-1 truncate font-mono text-xs" title={entry.path}>
              {entry.path}
            </span>
            {entry.type === "directory" ? (
              <span className="shrink-0 text-xs text-muted-foreground">
                {t("folder.directory")}
              </span>
            ) : entry.size !== null ? (
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                {formatBytes(entry.size, language)}
              </span>
            ) : null}
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => onRemove(entry.path)}
              aria-label={t("folder.selected.remove", { name: entry.name })}
              title={t("folder.selected.remove", { name: entry.name })}
            >
              <X />
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
