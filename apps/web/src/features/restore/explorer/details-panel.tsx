import { ArchiveRestore, Download, FolderOpen, LocateFixed, Lock, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import type {
  Snapshot,
  SnapshotObject,
  StoredVersion,
  TreeEntry,
  Version,
} from "@/features/restore/api";
import { Fact, Facts } from "@/features/restore/components/facts";
import { EntryIcon } from "@/features/restore/explorer/entry-icon";
import { ReadingPane } from "@/features/restore/explorer/reading-pane";
import { useEntryLabel, useLocationLabel } from "@/features/restore/explorer/use-entry-label";
import { VersionHistory } from "@/features/restore/explorer/version-history";
import { toNamedEntry } from "@/features/restore/lib/entries";
import { parentPathOf } from "@/features/restore/lib/paths";
import { isProtectionReason, protectionSelectKind } from "@/features/restore/lib/protection";
import { useEntryPreview } from "@/features/restore/use-restore-data";
import { formatBytes, formatDateTime } from "@/lib/format";

export interface DetailsActions {
  onClose: () => void;
  onOpenFolder: (path: string) => void;
  /** Show the entry inside its folder (for search results). */
  onReveal: (entry: TreeEntry) => void;
  onRestore: (entry: TreeEntry, target: "original" | "download") => void;
  onShowVersion: (version: Version) => void;
  onRestoreVersion: (version: Version, target: "original" | "download") => void;
  onDownloadStored: (version: StoredVersion) => void;
}

interface DetailsPanelProps extends DetailsActions {
  entry: TreeEntry;
  object: SnapshotObject;
  snapshot: Snapshot;
  /** The entry is not in the listed folder (a search result): offer to show it there. */
  canReveal: boolean;
}

/**
 * One entry up close: a mail's subject, sender and date, a file's size and
 * type, where it lives, and its version history across backups, with the
 * actions to restore or download exactly this.
 */
export function DetailsPanel({
  entry,
  object,
  snapshot,
  canReveal,
  ...actions
}: DetailsPanelProps) {
  const { t, i18n } = useTranslation("restore");
  const { t: tCommon } = useTranslation();
  const language = i18n.resolvedLanguage ?? i18n.language;
  const label = useEntryLabel(object.kind)(toNamedEntry(entry));
  const location = useLocationLabel(object.kind)(parentPathOf(entry.path));
  const folder = entry.kind === "folder";
  const mail = entry.mail;

  // The tree listing's own `mail.protection` can be stale or absent (older
  // restore points only ever detected protection when the preview itself
  // was loaded): fall back to what the loaded preview reports, so the
  // Download hint below and the reading pane never disagree about whether
  // this mail is rights-protected or S/MIME-encrypted.
  const mailPreview = useEntryPreview(snapshot.id, mail ? entry.id : null);
  const previewProtection =
    mailPreview.data && !mailPreview.data.previewable && isProtectionReason(mailPreview.data.reason)
      ? mailPreview.data.reason
      : null;
  const protection = mail?.protection ?? previewProtection;

  return (
    // `@container`: the reading pane can be much narrower than the viewport
    // (a resizable side pane at 1280px window width measured ~326px here),
    // narrow enough that the Facts grid below squeezed an address into
    // ~130px and wrapped it letter by letter. This gives both this file's
    // own Facts and the nested ReadingPane's (reading-pane.tsx, mounted a
    // few lines down) a real width to query against, so each can stack
    // label-above-value instead.
    <div className="space-y-4 @container">
      <div className="flex items-start gap-3">
        <EntryIcon kind={entry.kind} className="mt-0.5 size-5" />
        <div className="min-w-0 flex-1 space-y-1">
          <h2 className="break-words text-base font-semibold leading-snug">{label}</h2>
          <div className="flex flex-wrap gap-1.5">
            <Badge variant="secondary">{t(`explorer.kinds.${entry.kind}`)}</Badge>
            {entry.deleted ? <Badge variant="muted">{t("explorer.deleted")}</Badge> : null}
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={actions.onClose}
          aria-label={tCommon("actions.close")}
        >
          <X />
        </Button>
      </div>

      {entry.deleted ? (
        <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
          {t("details.deletedHint")}
        </p>
      ) : null}

      {/* The reading pane (headers, sanitised body, attachments, print) sits
          ahead of the restore/download actions below it. */}
      {mail ? <ReadingPane snapshotId={snapshot.id} entryId={entry.id} /> : null}

      <div className="flex flex-wrap items-center gap-2">
        {folder ? (
          <Button variant="outline" size="sm" onClick={() => actions.onOpenFolder(entry.path)}>
            <FolderOpen />
            {t("details.openFolder")}
          </Button>
        ) : null}
        {canReveal ? (
          <Button variant="outline" size="sm" onClick={() => actions.onReveal(entry)}>
            <LocateFixed />
            {t("details.reveal")}
          </Button>
        ) : null}
        <Button size="sm" onClick={() => actions.onRestore(entry, "original")}>
          <ArchiveRestore />
          {t("details.restore")}
        </Button>
        <Button variant="outline" size="sm" onClick={() => actions.onRestore(entry, "download")}>
          <Download />
          {t("details.download")}
        </Button>
      </div>

      {protection ? (
        <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
          <Lock className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          {t("details.protection.downloadHint", { kind: protectionSelectKind(protection) })}
        </p>
      ) : null}

      {folder ? <p className="text-sm text-muted-foreground">{t("details.folderHint")}</p> : null}

      <Facts className="grid-cols-1 gap-y-1 @sm:grid-cols-[minmax(0,9rem)_minmax(0,1fr)] @sm:gap-y-2">
        <Fact label={t("details.location")}>{location}</Fact>
        {folder ? null : <Fact label={t("details.size")}>{formatBytes(entry.size, language)}</Fact>}
        {entry.mtime && !mail ? (
          <Fact label={t("details.modified")}>{formatDateTime(entry.mtime, language)}</Fact>
        ) : null}
        {/* Sender and mailbox clock can disagree (relay delays); only worth a
            line when it actually differs from the received date shown above. */}
        {mail?.sentDateTime && mail.sentDateTime !== mail.date ? (
          <Fact label={t("details.mail.sent")}>{formatDateTime(mail.sentDateTime, language)}</Fact>
        ) : null}
        {entry.contentType ? (
          <Fact label={t("details.contentType")}>{entry.contentType}</Fact>
        ) : null}
        <Fact label={t("details.path")}>
          <span className="font-mono text-xs">{entry.path}</span>
        </Fact>
      </Facts>

      {folder ? null : (
        <>
          <Separator />
          <VersionHistory
            object={object}
            entry={entry}
            snapshot={snapshot}
            onShow={actions.onShowVersion}
            onRestore={actions.onRestoreVersion}
            onDownloadStored={actions.onDownloadStored}
          />
        </>
      )}
    </div>
  );
}
