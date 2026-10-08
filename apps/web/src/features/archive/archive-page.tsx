import { Link } from "@tanstack/react-router";
import {
  Archive as ArchiveIcon,
  ChevronLeft,
  ChevronRight,
  FileDown,
  Paperclip,
  Search,
  ShieldAlert,
} from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { EmptyState, ErrorState, PageHeader, RefreshButton, RelativeTime } from "@/components/kit";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  PIN_FIRST,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ExportDialog, type ExportDialogRequest } from "@/features/exports/export-dialog";
import type { SnapshotObject } from "@/features/restore/api";
import { objectLabel } from "@/features/restore/explorer/entry-icon";
import { useSnapshotObjects } from "@/features/restore/use-restore-data";
import { ExtensionSlot } from "@/lib/extensions";
import { formatInteger } from "@/lib/format";
import { activeTenantPageTo } from "@/lib/tenant-paths";

import type { ArchiveSearchResult, ArchiveSource } from "./api.js";
import { ArchiveDetail } from "./archive-detail.js";
import { ArchiveProtectionNotice } from "./archive-protection.js";
import { ChainCheck } from "./chain-check.js";
import { useArchiveSearch, useTenantScope } from "./hooks.js";
import {
  ARCHIVE_PAGE_SIZE,
  type ArchiveFilters,
  NO_FILTERS,
  SEARCH_DEBOUNCE_MS,
  invertedRange,
  isFiltered,
  pageRange,
  searchParamsOf,
} from "./presenters.js";

/**
 * The `archive` keys of each capture source: a short label for the list and
 * the full one for the detail. A new capture path has to name itself here;
 * an unknown source from a newer API shows its code instead of a wrong label.
 */
const SOURCE_KEYS: Readonly<Record<ArchiveSource, { list: string; detail: string }>> = {
  journal: { list: "table.sources.journal", detail: "detail.sourceJournal" },
  graph_sync: { list: "table.sources.graph_sync", detail: "detail.sourceGraphSync" },
  imap_sync: { list: "table.sources.imap_sync", detail: "detail.sourceImapSync" },
  file_import: { list: "table.sources.file_import", detail: "detail.sourceFileImport" },
};

const ALL_MAILBOXES = "all";

/**
 * The mailboxes the archive can be narrowed to (Microsoft 365 and IMAP, not
 * OneDrive), named with their address so two of the same name stay apart.
 * Journal reports count under every mailbox they were assigned to (#32).
 */
export function mailboxesOfArchive(
  objects: readonly SnapshotObject[],
): { id: string; label: string }[] {
  return objects
    .filter((object) => object.kind === "mailbox" || object.kind === "imap")
    .map((object) => {
      const name = objectLabel(object);
      // The owner's address, or an IMAP account's login; never the opaque Entra id.
      const address = object.ownerEmail ?? (object.kind === "imap" ? object.externalId : null);
      const repeats = !address || address.toLowerCase() === name.toLowerCase();
      return { id: object.id, label: repeats ? name : `${name} (${address})` };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** Whether only the free-text fields differ: those wait for a pause in typing. */
function onlyTextDiffers(a: ArchiveFilters, b: ArchiveFilters): boolean {
  return (
    a.dateFrom === b.dateFrom &&
    a.dateTo === b.dateTo &&
    a.mailbox === b.mailbox &&
    a.hasAttachment === b.hasAttachment
  );
}

function sameFilters(a: ArchiveFilters, b: ArchiveFilters): boolean {
  return onlyTextDiffers(a, b) && a.q === b.q && a.from === b.from;
}

/**
 * /archive: search over the tenant's archive with date, sender, mailbox and
 * attachment filters, page by page; a reading pane with the `.eml` download;
 * the protection the archive's storage gives; and the archive check
 * (docs/ARCHIVE.md). Legal holds and retention are tenant settings
 * (Tenant › Archive); extensions may still add sections at the end
 * (`archive.sections`).
 *
 * Every search and every read is audited, so a search runs once typing
 * pauses (or on Enter), never per keystroke, and not again on window focus.
 */
export function ArchivePage() {
  const { t, i18n } = useTranslation("archive");
  const { t: tExports } = useTranslation("exports");
  const language = i18n.resolvedLanguage ?? i18n.language;
  const { enabled, canManage } = useTenantScope();

  const [filters, setFilters] = React.useState<ArchiveFilters>(NO_FILTERS);
  const [committed, setCommitted] = React.useState<ArchiveFilters>(NO_FILTERS);
  const [offset, setOffset] = React.useState(0);
  const objects = useSnapshotObjects();
  const mailboxes = mailboxesOfArchive(objects.data ?? []);
  const mailboxLabel = mailboxes.find((candidate) => candidate.id === committed.mailbox)?.label;
  const [selected, setSelected] = React.useState<string | null>(null);
  const [checked, setChecked] = React.useState<ReadonlySet<string>>(new Set());
  const [exportRequest, setExportRequest] = React.useState<ExportDialogRequest | null>(null);
  const detailRef = React.useRef<HTMLElement>(null);

  const commit = React.useCallback((next: ArchiveFilters) => {
    setCommitted(next);
    setOffset(0);
  }, []);

  // Text waits for a pause; a date, mailbox or attachment choice searches at once.
  React.useEffect(() => {
    if (sameFilters(filters, committed)) {
      return;
    }
    const delay = onlyTextDiffers(filters, committed) ? SEARCH_DEBOUNCE_MS : 0;
    const timer = window.setTimeout(() => commit(filters), delay);
    return () => window.clearTimeout(timer);
  }, [filters, committed, commit]);

  const params = searchParamsOf(committed, offset);
  const search = useArchiveSearch(params);

  const open = (itemId: string) => {
    setSelected(itemId);
    // Below the two-column layout the reading pane sits under the list: bring it into view.
    if (typeof window !== "undefined" && window.matchMedia?.("(max-width: 1279px)").matches) {
      window.requestAnimationFrame(() =>
        detailRef.current?.scrollIntoView?.({ behavior: "smooth", block: "start" }),
      );
    }
  };

  const sourceLabel = (source: ArchiveSource | undefined, view: "list" | "detail") => {
    const keys = source ? SOURCE_KEYS[source] : undefined;
    return keys ? t(keys[view]) : (source ?? "—");
  };

  const header = (
    <PageHeader
      icon={ArchiveIcon}
      title={t("page.title")}
      description={t("page.description")}
      actions={
        enabled && canManage ? (
          <RefreshButton
            label={t("actions.refresh")}
            fetching={search.isFetching}
            onRefresh={() => void search.refetch()}
          />
        ) : null
      }
    />
  );

  if (!enabled) {
    return (
      <>
        {header}
        <EmptyState icon={ArchiveIcon} title={t("noTenant")} />
      </>
    );
  }

  if (!canManage) {
    return (
      <>
        {header}
        <Alert variant="destructive">
          <ShieldAlert aria-hidden="true" />
          <AlertTitle>{t("forbidden")}</AlertTitle>
        </Alert>
      </>
    );
  }

  const results = search.data?.items ?? [];
  const total = search.data?.total ?? 0;
  const range = pageRange(search.data?.offset ?? offset, results.length, total);
  // Only rows that are on screen count: a tick from an earlier search is not exported unseen.
  const checkedIds = results.filter((result) => checked.has(result.id)).map((result) => result.id);
  const allChecked = results.length > 0 && checkedIds.length === results.length;
  const toggleChecked = (id: string, on: boolean) =>
    setChecked((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const toggleAllChecked = (on: boolean) =>
    setChecked((current) => {
      const next = new Set(current);
      for (const result of results) {
        if (on) next.add(result.id);
        else next.delete(result.id);
      }
      return next;
    });
  // Ticked rows, or else every result of the current search (all pages).
  const openExport = () =>
    setExportRequest({
      origin: "archive",
      scope:
        checkedIds.length > 0
          ? { kind: "items", itemIds: checkedIds }
          : {
              kind: "filter",
              filter: {
                q: params.q,
                from: params.from,
                dateFrom: params.dateFrom,
                dateTo: params.dateTo,
                hasAttachment: params.hasAttachment,
                mailbox: params.mailbox,
              },
              total: search.data?.total ?? null,
              ...(mailboxLabel ? { mailboxLabel } : {}),
            },
    });
  const update = (patch: Partial<ArchiveFilters>) =>
    setFilters((current) => ({ ...current, ...patch }));
  const number = (value: number) => formatInteger(value, language);

  return (
    <>
      {header}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
        <Link
          to={activeTenantPageTo("archive")}
          className="font-medium text-primary underline underline-offset-4 hover:no-underline"
        >
          {t("page.settingsLink")}
        </Link>
      </div>

      <ArchiveProtectionNotice />

      <form
        data-slot="archive-search"
        className="space-y-2"
        onSubmit={(event) => {
          event.preventDefault();
          commit(filters);
        }}
      >
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <Search
              aria-hidden="true"
              className="text-muted-foreground pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2"
            />
            <Input
              className="pl-8"
              type="search"
              placeholder={t("search.placeholder")}
              aria-label={t("search.placeholder")}
              value={filters.q}
              onChange={(event) => update({ q: event.target.value })}
            />
          </div>
          <Button type="submit" variant="secondary" size="sm">
            {t("search.submit")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            type="button"
            disabled={total === 0}
            onClick={openExport}
          >
            <FileDown />
            {checkedIds.length > 0
              ? tExports("action.exportSelected", { count: checkedIds.length })
              : tExports("action.exportAll")}
          </Button>
        </div>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,14rem)_10rem_10rem_auto] lg:items-end">
          <div className="grid gap-1">
            <Label htmlFor="archive-from" className="text-xs text-muted-foreground">
              {t("search.from")}
            </Label>
            <Input
              id="archive-from"
              value={filters.from}
              placeholder={t("search.fromPlaceholder")}
              onChange={(event) => update({ from: event.target.value })}
              autoComplete="off"
            />
          </div>
          {mailboxes.length > 0 ? (
            <div className="grid gap-1">
              <Label className="text-xs text-muted-foreground" id="archive-mailbox-label">
                {t("search.mailbox")}
              </Label>
              <Select
                value={filters.mailbox ?? ALL_MAILBOXES}
                onValueChange={(value) =>
                  update({ mailbox: value === ALL_MAILBOXES ? null : value })
                }
              >
                <SelectTrigger
                  className="w-full"
                  aria-label={t("search.mailbox")}
                  data-slot="archive-mailbox"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_MAILBOXES}>{t("search.allMailboxes")}</SelectItem>
                  {mailboxes.map((candidate) => (
                    <SelectItem key={candidate.id} value={candidate.id}>
                      {candidate.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : (
            <div className="hidden lg:block" />
          )}
          <div className="grid gap-1">
            <Label htmlFor="archive-date-from" className="text-xs text-muted-foreground">
              {t("search.dateFrom")}
            </Label>
            <Input
              id="archive-date-from"
              type="date"
              value={filters.dateFrom}
              onChange={(event) => update({ dateFrom: event.target.value })}
            />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="archive-date-to" className="text-xs text-muted-foreground">
              {t("search.dateTo")}
            </Label>
            <Input
              id="archive-date-to"
              type="date"
              value={filters.dateTo}
              onChange={(event) => update({ dateTo: event.target.value })}
            />
          </div>
          <div className="flex items-center gap-2 pb-2 text-sm">
            <Checkbox
              id="archive-has-attachment"
              checked={filters.hasAttachment}
              onCheckedChange={(v) => update({ hasAttachment: v === true })}
            />
            <label htmlFor="archive-has-attachment">{t("search.hasAttachment")}</label>
          </div>
        </div>
        {invertedRange(filters) ? (
          <p role="alert" className="text-xs text-destructive">
            {t("search.invertedRange")}
          </p>
        ) : null}
        {isFiltered(filters) ? (
          <Button
            type="button"
            variant="link"
            size="sm"
            className="h-auto p-0"
            onClick={() => {
              setFilters(NO_FILTERS);
              commit(NO_FILTERS);
            }}
          >
            {t("search.reset")}
          </Button>
        ) : null}
      </form>

      {search.isError ? (
        <ErrorState
          title={t("search.loadError")}
          description={t("search.loadErrorDescription")}
          error={search.error}
          onRetry={() => void search.refetch()}
          retrying={search.isFetching}
        />
      ) : (
        <>
          {search.data ? (
            <p className="text-muted-foreground text-sm" aria-live="polite">
              {t("search.results", { count: total })}
            </p>
          ) : null}

          <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            {search.data && results.length === 0 && !search.isFetching ? (
              <EmptyState
                icon={ArchiveIcon}
                title={t(isFiltered(committed) ? "search.empty" : "search.emptyTenant")}
              />
            ) : (
              <div className="min-w-0 space-y-2">
                <Table className="min-w-[40rem]" scrollLabel={t("title")}>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-8">
                        <Checkbox
                          checked={
                            allChecked ? true : checkedIds.length > 0 ? "indeterminate" : false
                          }
                          onCheckedChange={(value) => toggleAllChecked(value === true)}
                          aria-label={tExports("archive.selectAll")}
                        />
                      </TableHead>
                      {/* Pinned where it stands: the box in front scrolls away under it. */}
                      <TableHead pin={PIN_FIRST}>{t("table.subject")}</TableHead>
                      <TableHead>{t("table.from")}</TableHead>
                      <TableHead>{t("table.date")}</TableHead>
                      <TableHead>{t("table.source")}</TableHead>
                      <TableHead className="w-8" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {results.map((result: ArchiveSearchResult) => (
                      <TableRow
                        key={result.id}
                        data-state={selected === result.id ? "selected" : undefined}
                        className="cursor-pointer"
                        onClick={() => open(result.id)}
                      >
                        <TableCell onClick={(event) => event.stopPropagation()}>
                          <Checkbox
                            checked={checked.has(result.id)}
                            onCheckedChange={(value) => toggleChecked(result.id, value === true)}
                            aria-label={tExports("archive.selectRow", {
                              subject: result.subject ?? "",
                            })}
                          />
                        </TableCell>
                        <TableCell pin={PIN_FIRST} className="max-w-64 truncate font-medium">
                          {result.subject ?? "—"}
                        </TableCell>
                        <TableCell className="max-w-40 truncate">{result.from ?? "—"}</TableCell>
                        <TableCell>
                          <RelativeTime value={result.sentAt ?? result.receivedAt} />
                        </TableCell>
                        <TableCell className="text-muted-foreground whitespace-nowrap text-xs">
                          {sourceLabel(result.source, "list")}
                        </TableCell>
                        <TableCell>
                          {result.hasAttachment && (
                            <Paperclip aria-hidden="true" className="size-4" />
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                {total > 0 ? (
                  <nav
                    aria-label={t("search.pagination")}
                    className="flex items-center justify-between gap-2 text-sm"
                    data-slot="archive-pages"
                  >
                    <span className="text-muted-foreground tabular-nums">
                      {t("search.range", {
                        first: number(range.first),
                        last: number(range.last),
                        total: number(range.total),
                      })}
                    </span>
                    <span className="flex gap-1">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={offset === 0 || search.isFetching}
                        onClick={() => setOffset(Math.max(0, offset - ARCHIVE_PAGE_SIZE))}
                        aria-label={t("search.previous")}
                      >
                        <ChevronLeft aria-hidden="true" />
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={offset + ARCHIVE_PAGE_SIZE >= total || search.isFetching}
                        onClick={() => setOffset(offset + ARCHIVE_PAGE_SIZE)}
                        aria-label={t("search.next")}
                      >
                        <ChevronRight aria-hidden="true" />
                      </Button>
                    </span>
                  </nav>
                ) : null}
              </div>
            )}

            <ArchiveDetail ref={detailRef} itemId={selected} sourceLabel={sourceLabel} />
          </div>
        </>
      )}

      <ChainCheck onOpenItem={open} />

      <ExportDialog request={exportRequest} onClose={() => setExportRequest(null)} />

      <ExtensionSlot name="archive.sections" props={{}} />
    </>
  );
}
