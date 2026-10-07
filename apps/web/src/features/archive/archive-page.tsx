import {
  Archive as ArchiveIcon,
  FileDown,
  Link as LinkIcon,
  Paperclip,
  Search,
  ShieldAlert,
} from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { EmptyState, PageHeader, RefreshButton, RelativeTime } from "@/components/kit";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
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

import type { ArchiveSearchParams, ArchiveSearchResult, ArchiveSource } from "./api.js";
import { useArchiveItem, useArchiveSearch, useTenantScope, useVerifyChain } from "./hooks.js";

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

/**
 * /archive: full text search over the tenant's archive, one item's detail
 * and hash chain verification (docs/ARCHIVE.md). Sections of the
 * Business/Service Provider modules (legal holds, ee/web) render in the
 * `archive.sections` slot at the end.
 *
 * Known limitation: a full-width layout with a reading pane reusing the
 * restore explorer's sanitised preview (apps/web/src/features/restore/explorer/
 * reading-pane.tsx) is not implemented; this page shows an item's metadata
 * only, not a rendered mail body (see Known Issues in the release notes).
 */
export function ArchivePage() {
  const { t } = useTranslation("archive");
  const { t: tExports } = useTranslation("exports");
  const { enabled, canManage } = useTenantScope();

  const [q, setQ] = React.useState("");
  const [hasAttachment, setHasAttachment] = React.useState(false);
  const [mailbox, setMailbox] = React.useState<string | null>(null);
  const objects = useSnapshotObjects();
  const mailboxes = mailboxesOfArchive(objects.data ?? []);
  const mailboxLabel = mailboxes.find((candidate) => candidate.id === mailbox)?.label;
  const [selected, setSelected] = React.useState<string | null>(null);
  const [checked, setChecked] = React.useState<ReadonlySet<string>>(new Set());
  const [exportRequest, setExportRequest] = React.useState<ExportDialogRequest | null>(null);

  const params: ArchiveSearchParams = {
    q: q.trim() || undefined,
    hasAttachment: hasAttachment ? true : undefined,
    mailbox: mailbox ?? undefined,
    limit: 50,
  };
  const search = useArchiveSearch(params);
  const item = useArchiveItem(selected);
  const verifyChain = useVerifyChain();

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
  // Ticked rows, or else every result of the current search.
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
                hasAttachment: params.hasAttachment,
                mailbox: params.mailbox,
              },
              total: search.data?.total ?? null,
              ...(mailboxLabel ? { mailboxLabel } : {}),
            },
    });

  return (
    <>
      {header}

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search
            aria-hidden="true"
            className="text-muted-foreground pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2"
          />
          <Input
            className="pl-8"
            placeholder={t("search.placeholder")}
            value={q}
            onChange={(event) => setQ(event.target.value)}
          />
        </div>
        {mailboxes.length > 0 ? (
          <Select
            value={mailbox ?? ALL_MAILBOXES}
            onValueChange={(value) => setMailbox(value === ALL_MAILBOXES ? null : value)}
          >
            <SelectTrigger
              className="w-full sm:w-64"
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
        ) : null}
        <div className="flex items-center gap-2 text-sm">
          <Checkbox
            id="archive-has-attachment"
            checked={hasAttachment}
            onCheckedChange={(v) => setHasAttachment(v === true)}
          />
          <label htmlFor="archive-has-attachment">{t("search.hasAttachment")}</label>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={(search.data?.total ?? 0) === 0}
          onClick={openExport}
        >
          <FileDown />
          {checkedIds.length > 0
            ? tExports("action.exportSelected", { count: checkedIds.length })
            : tExports("action.exportAll")}
        </Button>
      </div>

      {search.data && (
        <p className="text-muted-foreground text-sm">
          {t("search.results", { count: search.data.total })}
        </p>
      )}

      {results.length === 0 && !search.isFetching ? (
        <EmptyState icon={ArchiveIcon} title={t(q ? "search.empty" : "search.emptyTenant")} />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
          <Table className="min-w-[44rem]" scrollLabel={t("title")}>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8">
                  <Checkbox
                    checked={allChecked ? true : checkedIds.length > 0 ? "indeterminate" : false}
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
                  onClick={() => setSelected(result.id)}
                >
                  <TableCell onClick={(event) => event.stopPropagation()}>
                    <Checkbox
                      checked={checked.has(result.id)}
                      onCheckedChange={(value) => toggleChecked(result.id, value === true)}
                      aria-label={tExports("archive.selectRow", { subject: result.subject ?? "" })}
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
                    {result.hasAttachment && <Paperclip aria-hidden="true" className="size-4" />}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          <div className="space-y-2 rounded-md border p-4">
            <h3 className="font-medium">{t("detail.title")}</h3>
            {item.data ? (
              <dl className="space-y-1 text-sm">
                <div>
                  <dt className="text-muted-foreground">{t("detail.messageId")}</dt>
                  <dd className="break-all">{item.data.envelope?.messageId ?? "—"}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">{t("detail.itemHash")}</dt>
                  <dd className="break-all font-mono text-xs">{item.data.itemHash}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">{t("detail.source")}</dt>
                  <dd>{sourceLabel(item.data.source, "detail")}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">{t("detail.retentionUntil")}</dt>
                  <dd>
                    {item.data.retentionUntil ? (
                      <RelativeTime value={item.data.retentionUntil} />
                    ) : (
                      t("detail.unlimited")
                    )}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">{t("detail.flags")}</dt>
                  <dd className="flex flex-wrap gap-1">
                    {item.data.flags.length === 0
                      ? t("detail.noFlags")
                      : item.data.flags.map((flag) => (
                          <Badge key={flag} variant="secondary">
                            {t(`flags.${flag}`, flag)}
                          </Badge>
                        ))}
                  </dd>
                </div>
              </dl>
            ) : (
              <p className="text-muted-foreground text-sm">
                {selected ? "…" : t("search.placeholder")}
              </p>
            )}
          </div>
        </div>
      )}

      <div className="space-y-2 rounded-md border p-4">
        <h3 className="flex items-center gap-2 font-medium">
          <LinkIcon aria-hidden="true" className="size-4" />
          {t("chain.title")}
        </h3>
        <p className="text-muted-foreground text-sm">{t("chain.description")}</p>
        <Button
          variant="outline"
          onClick={() => void verifyChain.mutateAsync()}
          disabled={verifyChain.isPending}
        >
          {t("actions.verifyChain")}
        </Button>
        {verifyChain.data && (
          <Alert variant={verifyChain.data.ok ? "default" : "destructive"}>
            <AlertDescription>
              {verifyChain.data.checked === 0
                ? t("chain.empty")
                : verifyChain.data.ok
                  ? t("chain.ok", { count: verifyChain.data.checked })
                  : t("chain.broken", { index: verifyChain.data.brokenAt?.index ?? 0 })}
            </AlertDescription>
          </Alert>
        )}
      </div>

      <ExportDialog request={exportRequest} onClose={() => setExportRequest(null)} />

      <ExtensionSlot name="archive.sections" props={{}} />
    </>
  );
}
