import { useQuery } from "@tanstack/react-query";
import {
  Archive as ArchiveIcon,
  ArchiveRestore,
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Info,
  MailX,
  X,
} from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { EmptyState, ErrorState } from "@/components/kit";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/sonner";
import { Textarea } from "@/components/ui/textarea";
import {
  ARCHIVE_GAP_PAGE,
  type ArchiveSearchResult,
  type ArchiveSource,
} from "@/features/archive/api";
import "@/features/archive/i18n";
import { ArchiveDetail } from "@/features/archive/archive-detail";
import { useArchiveGap, useTenantScope } from "@/features/archive/hooks";
import { ARCHIVE_SOURCE_KEYS } from "@/features/archive/presenters";
import type { SnapshotObject } from "@/features/restore/api";
import { objectLabel } from "@/features/restore/explorer/entry-icon";
import { restoreErrorOf, restoreStamp } from "@/features/restore/lib/request";
import { useOpenJob } from "@/features/restore/navigation";
import { useCreateArchiveRestore } from "@/features/restore/use-restore-data";
import { ApiError, setupStateQueryOptions } from "@/lib/api";
import { formatBytes, formatDateTime, formatInteger } from "@/lib/format";
import { useTenantNavOffers } from "@/lib/tenant-nav-offers";
import { cn } from "@/lib/utils";

/**
 * The restore explorer's source "From the archive" (#48, docs/ARCHIVE.md "Aus dem Archiv
 * im Restore-Explorer"): the mail that reached the archive after the newest backup of a
 * mailbox or IMAP account, listed next to its folders. Read only: a message opens in the
 * archive's audited reading pane, downloads as the original `.eml`, and goes back into
 * the mailbox through a restore job into a folder of its own; the archive itself stays
 * as it is (retention and legal holds included).
 *
 * The archive is open to tenant administrators only (the API enforces it on every
 * route), so is this source: it shows for them alone, and only where the tenant offers
 * the archive at all (lib/tenant-nav-offers.ts). Everybody else never sees the entry
 * and no archived message is ever asked for on their behalf.
 */

/** The objects whose mail the archive holds: mailboxes and IMAP accounts, not imported ones. */
export function holdsArchivedMail(object: Pick<SnapshotObject, "kind" | "sourceKind">): boolean {
  return (object.kind === "mailbox" || object.kind === "imap") && object.sourceKind !== "import";
}

/** Whether the viewer may use the source "From the archive" in this tenant. */
export function useArchiveSourceAvailable(): boolean {
  const { canManage } = useTenantScope();
  const offers = useTenantNavOffers();
  return canManage && offers?.archive === true;
}

function useSourceLabel(): (source: ArchiveSource | undefined, view: "list" | "detail") => string {
  const { t } = useTranslation("archive");
  return (source, view) => {
    const keys = source ? ARCHIVE_SOURCE_KEYS[source] : undefined;
    return keys ? t(keys[view]) : (source ?? "—");
  };
}

/** The entry below the folders that switches the list to the archive. */
export function ArchiveSourceEntry({
  active,
  label,
  onOpen,
}: {
  active: boolean;
  /** Which account it is for, when the person has more than one with mail. */
  label?: string;
  onOpen: () => void;
}) {
  const { t } = useTranslation("restore");
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-current={active ? "location" : undefined}
      data-slot="archive-source-entry"
      className={cn(
        "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm font-medium",
        "hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        active && "bg-accent text-accent-foreground",
      )}
    >
      <ArchiveIcon className="size-4 shrink-0 text-primary" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate">
        {t("explorer.archive.entry")}
        {label ? <span className="font-normal text-muted-foreground"> · {label}</span> : null}
      </span>
    </button>
  );
}

/** The list pane while the archive is the source: the gap since the newest backup. */
export function ArchiveGapList({
  object,
  openItemId,
  leading,
  onOpen,
  onBack,
  onRestore,
}: {
  object: SnapshotObject;
  openItemId: string | null;
  /** Shown first in the header row (the account list's trigger on narrow screens). */
  leading?: React.ReactNode;
  onOpen: (itemId: string) => void;
  onBack: () => void;
  onRestore: (itemIds: string[]) => void;
}) {
  const { t, i18n } = useTranslation("restore");
  const language = i18n.resolvedLanguage ?? i18n.language;
  const sourceLabel = useSourceLabel();
  const [offset, setOffset] = React.useState(0);
  const [selected, setSelected] = React.useState<ReadonlySet<string>>(new Set());
  const gap = useArchiveGap(object.id, offset);

  // Another account or another page starts with nothing selected.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the object and the page are the reset triggers.
  React.useEffect(() => {
    setSelected(new Set());
  }, [object.id, offset]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the object is the reset trigger.
  React.useEffect(() => {
    setOffset(0);
  }, [object.id]);

  const items = gap.data?.items ?? [];
  const total = gap.data?.total ?? 0;
  const allSelected = items.length > 0 && items.every((item) => selected.has(item.id));
  const someSelected = items.some((item) => selected.has(item.id));
  const toggle = (id: string, on: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const since = gap.data?.since ? formatDateTime(gap.data.since, language) : null;

  return (
    <div className="flex h-full min-h-0 flex-col" data-slot="archive-gap">
      <div className="space-y-2 border-b border-border px-3 py-2">
        <div className="flex flex-wrap items-center gap-2">
          {leading}
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onBack}
            aria-label={t("explorer.archive.back")}
          >
            <ArrowLeft />
          </Button>
          <h2 className="min-w-40 flex-1 truncate text-sm font-medium">
            {t("explorer.archive.title", { object: objectLabel(object) })}
          </h2>
          <Button
            variant="outline"
            size="sm"
            disabled={!someSelected}
            onClick={() =>
              onRestore(items.filter((item) => selected.has(item.id)).map((item) => item.id))
            }
            data-slot="archive-restore-selected"
          >
            <ArchiveRestore />
            {t("explorer.archive.restoreSelected", { count: selected.size })}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground" aria-live="polite">
          {gap.data
            ? since
              ? t("explorer.archive.since", { date: since, count: total })
              : t("explorer.archive.noBackup", { count: total })
            : t("explorer.archive.loading")}
        </p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {gap.isPending ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 5 }, (_, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder rows
              <Skeleton key={index} className="h-9 w-full" />
            ))}
          </div>
        ) : gap.isError ? (
          <div className="p-4">
            <ErrorState
              title={t("explorer.archive.loadError")}
              error={gap.error}
              onRetry={() => void gap.refetch()}
              retrying={gap.isFetching}
            />
          </div>
        ) : items.length === 0 ? (
          <div className="p-4">
            <EmptyState
              icon={MailX}
              title={t("explorer.archive.empty")}
              description={t("explorer.archive.emptyDescription")}
            />
          </div>
        ) : (
          <table className="w-full text-sm" data-slot="archive-gap-list">
            <thead className="sr-only">
              <tr>
                <th>{t("explorer.archive.columns.select")}</th>
                <th>{t("explorer.archive.columns.message")}</th>
                <th>{t("explorer.archive.columns.received")}</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-border">
                <td className="w-8 px-3 py-1.5">
                  <Checkbox
                    checked={allSelected ? true : someSelected ? "indeterminate" : false}
                    onCheckedChange={(checked) =>
                      setSelected(
                        checked === true ? new Set(items.map((item) => item.id)) : new Set(),
                      )
                    }
                    aria-label={t("explorer.archive.selectAll")}
                  />
                </td>
                <td colSpan={2} className="py-1.5 text-xs text-muted-foreground">
                  {t("explorer.archive.selectAll")}
                </td>
              </tr>
              {items.map((item) => (
                <GapRow
                  key={item.id}
                  item={item}
                  open={item.id === openItemId}
                  selected={selected.has(item.id)}
                  onToggle={(on) => toggle(item.id, on)}
                  onOpen={() => onOpen(item.id)}
                  sourceLabel={sourceLabel(item.source, "list")}
                  language={language}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-3 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <Info className="size-3.5" aria-hidden="true" />
          {t("explorer.archive.readOnly")}
        </span>
        {total > ARCHIVE_GAP_PAGE ? (
          <span className="flex items-center gap-2">
            <Button
              variant="outline"
              size="icon-sm"
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - ARCHIVE_GAP_PAGE))}
              aria-label={t("explorer.archive.previous")}
            >
              <ChevronLeft />
            </Button>
            {t("explorer.archive.range", {
              from: formatInteger(offset + 1, language),
              to: formatInteger(Math.min(offset + ARCHIVE_GAP_PAGE, total), language),
              total: formatInteger(total, language),
            })}
            <Button
              variant="outline"
              size="icon-sm"
              disabled={offset + ARCHIVE_GAP_PAGE >= total}
              onClick={() => setOffset(offset + ARCHIVE_GAP_PAGE)}
              aria-label={t("explorer.archive.next")}
            >
              <ChevronRight />
            </Button>
          </span>
        ) : null}
      </div>
    </div>
  );
}

function GapRow({
  item,
  open,
  selected,
  onToggle,
  onOpen,
  sourceLabel,
  language,
}: {
  item: ArchiveSearchResult;
  open: boolean;
  selected: boolean;
  onToggle: (on: boolean) => void;
  onOpen: () => void;
  sourceLabel: string;
  language: string;
}) {
  const { t } = useTranslation("restore");
  const subject = item.subject?.trim() || t("explorer.archive.noSubject");
  return (
    <tr
      className={cn("border-b border-border hover:bg-accent/50", open && "bg-accent")}
      data-slot="archive-gap-row"
    >
      <td className="w-8 px-3 py-2 align-top">
        <Checkbox
          checked={selected}
          onCheckedChange={(checked) => onToggle(checked === true)}
          aria-label={t("explorer.archive.select", { subject })}
        />
      </td>
      <td className="min-w-0 py-2 pr-2 align-top">
        <button
          type="button"
          onClick={onOpen}
          aria-current={open ? "true" : undefined}
          className="block w-full min-w-0 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="block truncate font-medium">{subject}</span>
          <span className="block truncate text-xs text-muted-foreground">
            {item.from ?? "—"}
            {item.sizeBytes !== null ? ` · ${formatBytes(item.sizeBytes, language)}` : ""}
          </span>
        </button>
      </td>
      <td className="w-px py-2 pr-3 text-right align-top text-xs whitespace-nowrap text-muted-foreground">
        <span className="block">{formatDateTime(item.receivedAt, language)}</span>
        <Badge variant="outline" className="mt-1">
          {sourceLabel}
        </Badge>
      </td>
    </tr>
  );
}

/** The reading pane of one archived message, with the way back into the mailbox. */
export function ArchiveGapReading({
  itemId,
  onClose,
  onRestore,
}: {
  itemId: string;
  onClose: () => void;
  onRestore: () => void;
}) {
  const { t } = useTranslation("restore");
  const sourceLabel = useSourceLabel();
  return (
    <div className="space-y-3" data-slot="archive-gap-reading">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button variant="outline" size="sm" onClick={onRestore} data-slot="archive-restore-one">
          <ArchiveRestore />
          {t("explorer.archive.restoreOne")}
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onClose}
          aria-label={t("explorer.archive.close")}
        >
          <X />
        </Button>
      </div>
      <ArchiveDetail itemId={itemId} sourceLabel={sourceLabel} />
    </div>
  );
}

/** What the dialog puts back: archived messages of one mailbox. */
export interface ArchiveRestoreRequest {
  object: SnapshotObject;
  itemIds: string[];
}

/** The keys this dialog explains a refused request with (the rest as any restore). */
function archiveRestoreErrorKey(error: unknown): string {
  if (error instanceof ApiError && error.problem) {
    if (error.problem.type === "urn:restow:problem:restore-selection-unknown") {
      return "restore:explorer.archive.errors.selectionUnknown";
    }
    if (error.problem.type === "urn:restow:problem:archive-content-unavailable") {
      return "restore:explorer.archive.errors.notRecorded";
    }
  }
  return restoreErrorOf(error).key;
}

export function ArchiveRestoreDialog({
  request,
  onClose,
  onStarted,
}: {
  request: ArchiveRestoreRequest | null;
  onClose: () => void;
  onStarted?: () => void;
}) {
  return (
    <Dialog open={request !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      {request ? (
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
          <ArchiveRestoreForm request={request} onClose={onClose} onStarted={onStarted} />
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

function ArchiveRestoreForm({
  request,
  onClose,
  onStarted,
}: {
  request: ArchiveRestoreRequest;
  onClose: () => void;
  onStarted?: () => void;
}) {
  const { t } = useTranslation("restore");
  const { t: tAny } = useTranslation();
  const create = useCreateArchiveRestore();
  const openJob = useOpenJob();
  const setupState = useQuery(setupStateQueryOptions);
  const demoMode = setupState.data?.demo.enabled === true;
  const { object, itemIds } = request;
  const label = objectLabel(object);
  const reasonRequired = !object.own;
  const [openedAt] = React.useState(() => new Date());
  const folder = t("explorer.archive.folderName", { stamp: restoreStamp(openedAt) });
  const [reason, setReason] = React.useState("");
  const [reasonError, setReasonError] = React.useState<string | null>(null);
  const [failure, setFailure] = React.useState<string | null>(null);
  const reasonRef = React.useRef<HTMLTextAreaElement>(null);
  const gone = object.status === "orphaned";

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = reason.trim();
    if (reasonRequired && trimmed.length < 3) {
      setReasonError(t("dialog.errors.reasonRequired"));
      reasonRef.current?.focus();
      return;
    }
    create.mutate(
      {
        objectId: object.id,
        itemIds,
        ...(reasonRequired ? { reason: trimmed } : {}),
        options: { restoreFolderName: folder },
      },
      {
        onSuccess: (created) => {
          toast.success(t("dialog.started.restore"), {
            description: t("dialog.started.description"),
          });
          onStarted?.();
          onClose();
          openJob(created.id);
        },
        onError: (error) => {
          const key = archiveRestoreErrorKey(error);
          if (key === "restore:dialog.errors.reasonRequired") {
            setReasonError(tAny(key));
            reasonRef.current?.focus();
          } else {
            setFailure(tAny(key));
          }
        },
      },
    );
  };

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <DialogHeader>
        <DialogTitle>{t("explorer.archive.dialog.title")}</DialogTitle>
        <DialogDescription>
          {t("explorer.archive.dialog.description", {
            count: itemIds.length,
            object: label,
            folder,
          })}
        </DialogDescription>
      </DialogHeader>

      <Alert>
        <Info aria-hidden="true" />
        <AlertTitle>{t("explorer.archive.dialog.archiveTitle")}</AlertTitle>
        <AlertDescription>{t("explorer.archive.dialog.archiveUnchanged")}</AlertDescription>
      </Alert>

      {demoMode ? (
        <p className="text-sm text-muted-foreground">{t("explorer.archive.dialog.demo")}</p>
      ) : gone ? (
        <p className="text-sm text-muted-foreground">{t("explorer.archive.dialog.gone")}</p>
      ) : null}

      {reasonRequired ? (
        <div className="space-y-1.5">
          <p className="text-sm">
            {t("dialog.reason.impersonation", { owner: object.ownerEmail ?? object.externalId })}
          </p>
          <Label htmlFor="archive-restore-reason">{t("dialog.reason.label")}</Label>
          <Textarea
            id="archive-restore-reason"
            ref={reasonRef}
            value={reason}
            onChange={(event) => {
              setReason(event.target.value);
              setReasonError(null);
            }}
            placeholder={t("dialog.reason.placeholder")}
            aria-invalid={reasonError ? true : undefined}
            aria-describedby="archive-restore-reason-help"
          />
          <p id="archive-restore-reason-help" className="text-xs text-muted-foreground">
            {t("dialog.reason.help")}
          </p>
          {reasonError ? (
            <p role="alert" className="text-xs text-destructive">
              {reasonError}
            </p>
          ) : null}
        </div>
      ) : null}

      {failure ? (
        <Alert variant="destructive">
          <AlertTitle>{t("dialog.errors.title")}</AlertTitle>
          <AlertDescription>{failure}</AlertDescription>
        </Alert>
      ) : null}

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          {tAny("common:actions.cancel")}
        </Button>
        <Button type="submit" loading={create.isPending} disabled={demoMode || gone}>
          <ArchiveRestore />
          {t("explorer.archive.dialog.submit")}
        </Button>
      </DialogFooter>
    </form>
  );
}
