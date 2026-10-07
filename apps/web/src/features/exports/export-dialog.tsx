import type { TFunction } from "i18next";
import {
  AlertTriangle,
  Database,
  FileArchive,
  FileDown,
  Files,
  Inbox,
  type LucideIcon,
  UserRound,
} from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/sonner";
import { Textarea } from "@/components/ui/textarea";
import type { ArchiveExportFilter, ExportFormatId } from "@/features/exports/api";
import { type Choice, ChoiceCards } from "@/features/exports/components/choice-cards";
import { type FormatChoice, defaultFormat, formatChoices } from "@/features/exports/lib/formats";
import {
  type ArchiveExportScope,
  type ExportErrorDisplay,
  type ExportFormContext,
  type ExportFormErrors,
  type ExportFormField,
  type ExportFormState,
  type ExportSource,
  archiveScopeSize,
  buildExportRequest,
  cleanFilter,
  exportErrorOf,
  hasErrors,
  suggestedFileName,
  validateExportForm,
} from "@/features/exports/lib/request";
import { useOpenExport } from "@/features/exports/navigation";
import { useCreateExport, useExportFormats } from "@/features/exports/use-exports-data";
import type { Snapshot, SnapshotObject } from "@/features/restore/api";
import { objectLabel } from "@/features/restore/explorer/entry-icon";
import { useSnapshotLabel } from "@/features/restore/explorer/restore-point-label";
import { useEntryLabel } from "@/features/restore/explorer/use-entry-label";
import type { RestoreScope } from "@/features/restore/lib/request";
import { countSelection } from "@/features/restore/lib/selection";
import { errorMessageKey } from "@/lib/api";
import { formatBytes } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * What the dialog exports and where it comes from: a selection (or a whole
 * folder) of a mailbox snapshot in the restore explorer, or the results of
 * the archive search.
 */
export type ExportDialogRequest =
  | {
      origin: "snapshot";
      object: SnapshotObject;
      snapshot: Snapshot;
      scope: RestoreScope;
    }
  | {
      origin: "archive";
      scope: ArchiveExportScope;
    };

export type { ArchiveExportScope } from "@/features/exports/lib/request";

/**
 * Export mail as files: pick a format, optionally a file name, and (for
 * somebody else's mailbox) the reason. Submitting starts the export job and
 * opens its page, where the finished file is downloaded.
 */
export function ExportDialog({
  request,
  onClose,
  onStarted,
}: {
  request: ExportDialogRequest | null;
  onClose: () => void;
  /** Called after the export was accepted (e.g. to clear the selection). */
  onStarted?: () => void;
}) {
  return (
    <Dialog open={request !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      {request ? (
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl">
          <ExportForm request={request} onClose={onClose} onStarted={onStarted} />
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

const FORMAT_ICONS: Record<ExportFormatId, LucideIcon> = {
  eml_zip: FileArchive,
  mbox: Inbox,
  msg_zip: Files,
  pst: Database,
};

/** Fields in the order the form shows them. */
const FIELD_ORDER: readonly ExportFormField[] = ["scope", "format", "fileName", "reason"];

function ExportForm({
  request,
  onClose,
  onStarted,
}: {
  request: ExportDialogRequest;
  onClose: () => void;
  onStarted?: () => void;
}) {
  const { t, i18n } = useTranslation("exports");
  const { t: tAny } = useTranslation();
  const language = i18n.resolvedLanguage ?? i18n.language;
  const snapshotLabel = useSnapshotLabel();
  const openExport = useOpenExport();
  const create = useCreateExport();
  const formats = useExportFormats();

  const object = request.origin === "snapshot" ? request.object : null;
  const label = object ? objectLabel(object) : null;
  const choices = React.useMemo(() => formatChoices(formats.data), [formats.data]);

  const context: ExportFormContext = {
    reasonRequired: object !== null && !object.own,
    choices,
  };
  const source: ExportSource =
    request.origin === "snapshot"
      ? { origin: "snapshot", snapshotId: request.snapshot.id, scope: request.scope }
      : { origin: "archive", scope: request.scope };

  // The format the person picked; until then (and if the pick vanished) the default one.
  const [picked, setPicked] = React.useState<ExportFormatId | null>(null);
  const effective =
    picked && choices.some((choice) => choice.id === picked && choice.available)
      ? picked
      : defaultFormat(choices);
  const [fileName, setFileName] = React.useState("");
  const [reason, setReason] = React.useState("");
  const [errors, setErrors] = React.useState<ExportFormErrors>({});
  const [failure, setFailure] = React.useState<ExportErrorDisplay | null>(null);
  const fileNameRef = React.useRef<HTMLInputElement>(null);
  const reasonRef = React.useRef<HTMLTextAreaElement>(null);
  const focusField = (field: ExportFormField | null | undefined) => {
    if (field === "fileName") fileNameRef.current?.focus();
    if (field === "reason") reasonRef.current?.focus();
  };

  const clear = (...fields: ExportFormField[]) => {
    setErrors((current) => {
      const next = { ...current };
      for (const field of fields) {
        delete next[field];
      }
      return next;
    });
    setFailure(null);
  };

  const placeholder = React.useMemo(
    () =>
      suggestedFileName(
        label ?? "",
        t(
          request.origin === "archive" ? "dialog.fileNameBase.archive" : "dialog.fileNameBase.mail",
        ),
        new Date(),
      ),
    [label, request.origin, t],
  );

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const state: ExportFormState = { format: effective, fileName, reason };
    const found = validateExportForm(state, context, source);
    setErrors(found);
    if (hasErrors(found)) {
      focusField(FIELD_ORDER.find((field) => found[field] !== undefined));
      return;
    }
    create.mutate(buildExportRequest({ source, state, context }), {
      onSuccess: (created) => {
        toast.success(t("dialog.started.title"), { description: t("dialog.started.description") });
        onStarted?.();
        onClose();
        openExport(created.id);
      },
      onError: (error) => {
        const display = exportErrorOf(error, request.origin);
        if (display.field) {
          setErrors((current) => ({ ...current, [display.field as string]: display.key }));
          focusField(display.field);
        } else {
          setFailure(display);
        }
      },
    });
  };

  const fieldError = (field: ExportFormField) => {
    const value = errors[field];
    return value ? tAny(value) : undefined;
  };

  const formatChoicesView: Choice<ExportFormatId>[] = choices.map((choice) => toChoice(choice, t));
  const pending = formats.isPending;
  const canSubmit = !pending && effective !== null;
  const showCalendarNote = object?.kind === "mailbox";

  return (
    <form onSubmit={submit} className="grid gap-5" noValidate>
      <DialogHeader>
        <DialogTitle>{t("dialog.title")}</DialogTitle>
        <DialogDescription>
          {request.origin === "snapshot"
            ? t("dialog.source.snapshot", {
                object: label,
                restorePoint: snapshotLabel(request.snapshot),
              })
            : t("dialog.source.archive")}
        </DialogDescription>
      </DialogHeader>

      {request.origin === "snapshot" && object ? (
        <SnapshotScopeSummary scope={request.scope} object={object} language={language} />
      ) : request.origin === "archive" ? (
        <ArchiveScopeSummary scope={request.scope} />
      ) : null}
      {errors.scope ? (
        <p role="alert" className="-mt-3 text-xs text-destructive">
          {fieldError("scope")}
        </p>
      ) : null}

      {pending ? (
        <output className="block space-y-2" aria-label={t("dialog.formats.loading")}>
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </output>
      ) : formats.isError ? (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>{t("dialog.formats.loadError")}</AlertTitle>
          <AlertDescription className="space-y-2">
            <span className="block">{tAny(errorMessageKey(formats.error))}</span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void formats.refetch()}
              loading={formats.isFetching}
            >
              {tAny("actions.retry")}
            </Button>
          </AlertDescription>
        </Alert>
      ) : (
        <ChoiceCards
          name="export-format"
          legend={t("dialog.formats.label")}
          value={effective}
          onChange={(next) => {
            setPicked(next);
            clear("format");
          }}
          choices={formatChoicesView}
          error={fieldError("format")}
        />
      )}

      {request.origin === "snapshot" ? (
        <p className="-mt-2 rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
          {showCalendarNote ? t("dialog.mailOnly.mailbox") : t("dialog.mailOnly.general")}
        </p>
      ) : null}

      <div className="space-y-1.5">
        <Label htmlFor="export-file-name">{t("dialog.fileName.label")}</Label>
        <Input
          id="export-file-name"
          ref={fileNameRef}
          value={fileName}
          onChange={(event) => {
            setFileName(event.target.value);
            clear("fileName");
          }}
          placeholder={placeholder}
          aria-invalid={errors.fileName ? true : undefined}
          aria-describedby="export-file-name-message"
          autoComplete="off"
          spellCheck={false}
        />
        <p
          id="export-file-name-message"
          role={errors.fileName ? "alert" : undefined}
          className={cn("text-xs", errors.fileName ? "text-destructive" : "text-muted-foreground")}
        >
          {fieldError("fileName") ?? t("dialog.fileName.help")}
        </p>
      </div>

      {context.reasonRequired ? (
        <div className="space-y-1.5">
          <Alert variant="info">
            <UserRound />
            <AlertTitle>{t("dialog.reason.impersonationTitle")}</AlertTitle>
            <AlertDescription>
              {t("dialog.reason.impersonation", { owner: object?.ownerEmail ?? label ?? "" })}
            </AlertDescription>
          </Alert>
          <Label htmlFor="export-reason">{t("dialog.reason.label")}</Label>
          <Textarea
            id="export-reason"
            ref={reasonRef}
            value={reason}
            onChange={(event) => {
              setReason(event.target.value);
              clear("reason");
            }}
            placeholder={t("dialog.reason.placeholder")}
            rows={3}
            maxLength={2000}
            aria-invalid={errors.reason ? true : undefined}
            aria-describedby="export-reason-message"
          />
          <p
            id="export-reason-message"
            role={errors.reason ? "alert" : undefined}
            className={cn("text-xs", errors.reason ? "text-destructive" : "text-muted-foreground")}
          >
            {fieldError("reason") ?? t("dialog.reason.help")}
          </p>
        </div>
      ) : null}

      {failure ? (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>{t("dialog.errors.title")}</AlertTitle>
          <AlertDescription>{tAny(failure.key)}</AlertDescription>
        </Alert>
      ) : null}

      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onClose} disabled={create.isPending}>
          {tAny("actions.cancel")}
        </Button>
        <Button type="submit" loading={create.isPending} disabled={!canSubmit}>
          <FileDown />
          {t("dialog.submit")}
        </Button>
      </DialogFooter>
    </form>
  );
}

/** The card of one format: its own words, and for a format that does not exist yet, the honest alternative. */
function toChoice(choice: FormatChoice, t: TFunction): Choice<ExportFormatId> {
  const base = `formats.${choice.id}`;
  return {
    value: choice.id,
    label: t(`${base}.label`),
    icon: FORMAT_ICONS[choice.id],
    description: t(`${base}.description`),
    disabled: !choice.available,
    badge: choice.planned && !choice.available ? t("formats.planned") : undefined,
    disabledHint: choice.available
      ? undefined
      : choice.planned
        ? t(`${base}.alternative`)
        : t("formats.unavailable"),
  };
}

const PREVIEW_ENTRIES = 5;

/** What will be exported from a snapshot, in words: everything, or the first few entries and the rest counted. */
function SnapshotScopeSummary({
  scope,
  object,
  language,
}: {
  scope: RestoreScope;
  object: SnapshotObject;
  language: string;
}) {
  const { t } = useTranslation("exports");
  const { t: tRestore } = useTranslation("restore");
  const entryLabel = useEntryLabel(object.kind);
  if (scope.kind === "everything") {
    return (
      <p className="rounded-md border border-border px-3 py-2 text-sm">
        {t("dialog.scope.everything")}
      </p>
    );
  }
  const counts = countSelection(scope.selection);
  const entries = [...scope.selection.values()];
  const shown = entries.slice(0, PREVIEW_ENTRIES);
  return (
    <div className="space-y-2 rounded-md border border-border px-3 py-2 text-sm">
      <p className="font-medium">
        {[
          counts.folders > 0
            ? tRestore("explorer.selection.folders", { count: counts.folders })
            : null,
          counts.items > 0 ? tRestore("explorer.selection.items", { count: counts.items }) : null,
        ]
          .filter(Boolean)
          .join(", ")}
        {counts.bytes > 0 ? (
          <span className="font-normal text-muted-foreground">
            {" · "}
            {formatBytes(counts.bytes, language)}
          </span>
        ) : null}
      </p>
      <ul className="space-y-0.5 text-muted-foreground">
        {shown.map((entry) => (
          <li key={entry.path} className="truncate">
            {entryLabel({ kind: entry.kind, path: entry.path, subject: entry.subject })}
          </li>
        ))}
        {entries.length > shown.length ? (
          <li>{t("dialog.scope.andMore", { count: entries.length - shown.length })}</li>
        ) : null}
      </ul>
    </div>
  );
}

/** The parts of an archive search that narrow it, as short readable lines. */
function filterLines(
  filter: ArchiveExportFilter,
  t: TFunction,
  mailboxLabel: string | undefined,
): string[] {
  const clean = cleanFilter(filter);
  const lines: string[] = [];
  if (clean.q) lines.push(t("dialog.scope.archive.filter.q", { q: clean.q }));
  if (clean.mailbox)
    lines.push(
      t("dialog.scope.archive.filter.mailbox", { mailbox: mailboxLabel ?? clean.mailbox }),
    );
  if (clean.from) lines.push(t("dialog.scope.archive.filter.from", { from: clean.from }));
  if (clean.dateFrom)
    lines.push(t("dialog.scope.archive.filter.dateFrom", { date: clean.dateFrom }));
  if (clean.dateTo) lines.push(t("dialog.scope.archive.filter.dateTo", { date: clean.dateTo }));
  if (clean.hasAttachment) lines.push(t("dialog.scope.archive.filter.hasAttachment"));
  return lines;
}

/** What will be exported from the archive: the ticked mails, or every mail the search finds. */
function ArchiveScopeSummary({ scope }: { scope: ArchiveExportScope }) {
  const { t } = useTranslation("exports");
  const size = archiveScopeSize(scope);
  if (scope.kind === "items") {
    return (
      <p className="rounded-md border border-border px-3 py-2 text-sm font-medium">
        {t("dialog.scope.archive.items", { count: scope.itemIds.length })}
      </p>
    );
  }
  const lines = filterLines(scope.filter, t, scope.mailboxLabel);
  return (
    <div className="space-y-1.5 rounded-md border border-border px-3 py-2 text-sm">
      <p className="font-medium">
        {size === null
          ? t("dialog.scope.archive.filterUnknown")
          : t("dialog.scope.archive.filterCount", { count: size })}
      </p>
      {lines.length > 0 ? (
        <ul className="space-y-0.5 text-muted-foreground">
          {lines.map((line) => (
            <li key={line} className="truncate">
              {line}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground">{t("dialog.scope.archive.wholeArchive")}</p>
      )}
    </div>
  );
}
