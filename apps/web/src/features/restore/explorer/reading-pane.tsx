import { Download, FileWarning, Printer, ShieldAlert } from "lucide-react";
import { useTranslation } from "react-i18next";

import { ErrorState } from "@/components/kit";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { attachmentDownloadUrl } from "@/features/restore/api";
import type {
  EntryPreview,
  PreviewAttachment,
  PreviewUnavailableReason,
} from "@/features/restore/api";
import { Fact, Facts } from "@/features/restore/components/facts";
import { buildPrintDocument, printMessage } from "@/features/restore/lib/print";
import {
  isProtectionReason,
  protectionSelectKind,
  unavailableReasonKey,
} from "@/features/restore/lib/protection";
import { useActiveTenantId, useEntryPreview } from "@/features/restore/use-restore-data";
import { formatBytes, formatDateTime } from "@/lib/format";

/**
 * The content-security-policy every piece of server HTML is shown under in
 * this feature (the reading pane's `srcdoc` and the throwaway print
 * document): no scripts, no network requests, inline images and styles
 * only. `default-src 'none'` already blocks every other kind of fetch.
 */
const PREVIEW_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'";

interface ReadingPaneProps {
  snapshotId: string;
  /** The entry's storage id (`TreeEntry.id`), not its display path. */
  entryId: string;
}

/**
 * A mail's headers, its sanitised body and its attachments, with printing
 * and the notice rights-protected, S/MIME-encrypted, oversized or
 * unsupported-format mail shows instead of a body. The HTML body renders in
 * a sandboxed iframe via `srcdoc`, with only `allow-popups` and
 * `allow-popups-to-escape-sandbox` (so a link the server rewrote to open in a
 * new tab still can) — never `allow-scripts` or `allow-same-origin`: the
 * server already sanitised the body (no script, no remote fetch), and
 * printing goes through its own separate throwaway iframe (lib/print.ts), so
 * this one never needs same-origin access either. Plain text renders
 * directly, in a `pre`, since React already escapes it — no iframe needed for
 * content that cannot carry markup.
 */
export function ReadingPane({ snapshotId, entryId }: ReadingPaneProps) {
  const { t } = useTranslation("restore");
  const tenantId = useActiveTenantId();
  const preview = useEntryPreview(snapshotId, entryId);

  if (preview.isPending) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }
  if (preview.isError) {
    return (
      <ErrorState
        title={t("details.reading.loadError")}
        error={preview.error}
        onRetry={() => void preview.refetch()}
        retrying={preview.isFetching}
      />
    );
  }

  return (
    <ReadingPaneView
      snapshotId={snapshotId}
      entryId={entryId}
      tenantId={tenantId}
      preview={preview.data}
    />
  );
}

export interface ReadingPaneViewProps {
  snapshotId: string;
  entryId: string;
  tenantId: string | null;
  preview: EntryPreview;
  /**
   * Where an attachment downloads from. Defaults to the snapshot's attachment
   * endpoint; null lists the attachments without a download (the archive,
   * whose attachments come with the message's own `.eml` download).
   */
  attachmentHref?: ((attachmentId: string) => string) | null;
  /** A line under the attachments, e.g. where they can be had instead. */
  attachmentsNote?: string;
}

/**
 * The pure, already-loaded rendering half of {@link ReadingPane}, split out
 * so it is unit-tested without a `QueryClientProvider` (this file's own
 * tests render this directly).
 */
export function ReadingPaneView({
  snapshotId,
  entryId,
  tenantId,
  preview,
  attachmentHref,
  attachmentsNote,
}: ReadingPaneViewProps) {
  const { t, i18n } = useTranslation("restore");
  const language = i18n.resolvedLanguage ?? i18n.language;
  const { headers, attachments, previewable } = preview;
  const formattedDate = headers.date ? formatDateTime(headers.date, language) : null;
  const to = headers.to.join(", ");
  const cc = headers.cc.join(", ");
  // Embedded (cid:) images already arrive inlined into the body as data:
  // URIs; a part flagged inline is not a separate download.
  const downloadableAttachments = attachments.filter((attachment) => !attachment.inline);

  const print = () => {
    if (!previewable) {
      return;
    }
    printMessage(
      buildPrintDocument(
        {
          subject: headers.subject,
          from: headers.from,
          to: to || null,
          cc: cc || null,
          date: formattedDate,
          body: preview.body,
        },
        {
          subject: t("details.mail.subject"),
          from: t("details.mail.from"),
          to: t("details.mail.to"),
          cc: t("details.mail.cc"),
          date: t("details.mail.date"),
          noSubject: t("details.mail.noSubject"),
        },
      ),
    );
  };

  return (
    <div className="space-y-4">
      {/* `grid-cols-1` below `@sm` (the reading pane at 1280px is only
          ~326px wide there — a fixed 9rem label column left barely 130px for
          an address, wrapping it letter by letter): stacked label-above-value
          until the ancestor `@container` (DetailsPanel's own root — see
          details-panel.tsx) is wide enough for the two-column layout to have
          real room. */}
      <Facts className="grid-cols-1 gap-y-1 @sm:grid-cols-[minmax(0,9rem)_minmax(0,1fr)] @sm:gap-y-2">
        <Fact label={t("details.mail.subject")}>
          {headers.subject ?? (
            <span className="text-muted-foreground">{t("details.mail.noSubject")}</span>
          )}
        </Fact>
        {headers.from ? <Fact label={t("details.mail.from")}>{headers.from}</Fact> : null}
        {to ? <Fact label={t("details.mail.to")}>{to}</Fact> : null}
        {cc ? <Fact label={t("details.mail.cc")}>{cc}</Fact> : null}
        {formattedDate ? <Fact label={t("details.mail.date")}>{formattedDate}</Fact> : null}
      </Facts>

      {!previewable ? (
        <UnavailableNotice reason={preview.reason} />
      ) : (
        <>
          <div className="flex justify-end">
            <Button type="button" variant="outline" size="sm" onClick={print}>
              <Printer />
              {t("details.reading.print")}
            </Button>
          </div>
          {preview.simplified ? (
            <Alert variant="info">
              <FileWarning />
              <AlertTitle>{t("details.reading.simplified.title")}</AlertTitle>
              <AlertDescription>{t("details.reading.simplified.description")}</AlertDescription>
            </Alert>
          ) : null}
          {preview.body.kind === "html" ? (
            <iframe
              title={headers.subject ?? t("details.mail.noSubject")}
              // Every restriction except opening a link the server rewrote to
              // `target="_blank" rel="noopener noreferrer"` (see preview.ts):
              // `allow-popups` lets that click open a new tab the ordinary
              // way, and `allow-popups-to-escape-sandbox` keeps the new tab
              // itself unsandboxed (a real, addressable page, not another
              // opaque-origin frame) — without it the popup would inherit
              // this sandbox and could not navigate anywhere either. Still no
              // `allow-scripts` and no `allow-same-origin`: the server
              // already sanitised this HTML (no script, no remote fetch), and
              // the print button above never touches this iframe, it opens
              // its own separate throwaway one (lib/print.ts).
              sandbox="allow-popups allow-popups-to-escape-sandbox"
              srcDoc={buildSrcDoc(preview.body.content)}
              // A flat height regardless of the pane's own size wasted most
              // of a tall reading pane (e.g. ~1190px at 2560×1440) on a
              // fixed 384px frame. `min()` scales it with the viewport
              // instead, capped so one very long message cannot dominate
              // the whole pane either; the iframe scrolls its own content
              // past that cap.
              className="h-[min(60vh,48rem)] min-h-64 w-full rounded-md border border-border bg-white"
            />
          ) : (
            <pre
              aria-label={t("details.reading.plainText")}
              className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-muted/30 p-3 text-sm"
            >
              {preview.body.content}
            </pre>
          )}
          <AttachmentsList
            hrefOf={
              attachmentHref === undefined
                ? (attachmentId) =>
                    attachmentDownloadUrl(snapshotId, entryId, attachmentId, tenantId)
                : attachmentHref
            }
            attachments={downloadableAttachments}
            language={language}
            note={attachmentsNote}
          />
        </>
      )}
    </div>
  );
}

/** The reading iframe's document: the server-sanitised body under the shared preview CSP. */
function buildSrcDoc(html: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}"><style>body{font-family:sans-serif;font-size:14px;line-height:1.5;word-break:break-word;margin:0.75rem;}img{max-width:100%;}</style></head><body>${html}</body></html>`;
}

/**
 * Shown instead of a body when the preview cannot show one. Rights-protected
 * (Microsoft Purview) and S/MIME-encrypted mail get the fuller explanation
 * (opening the EML needs the recipient's own rights or certificate, but
 * restoring the item into a mailbox always works, since the recipient's own
 * client applies their rights there); an oversized or unsupported-format
 * message just says so.
 */
function UnavailableNotice({ reason }: { reason: PreviewUnavailableReason }) {
  const { t } = useTranslation("restore");
  const protection = isProtectionReason(reason);
  return (
    <Alert variant="info">
      {protection ? <ShieldAlert /> : <FileWarning />}
      <AlertTitle>{t(unavailableReasonKey(reason))}</AlertTitle>
      {protection ? (
        <AlertDescription>
          {t("details.protection.notice", { kind: protectionSelectKind(reason) })}
        </AlertDescription>
      ) : null}
    </Alert>
  );
}

function AttachmentsList({
  hrefOf,
  attachments,
  language,
  note,
}: {
  /** The download address of an attachment; null when the list only names them. */
  hrefOf: ((attachmentId: string) => string) | null;
  attachments: readonly PreviewAttachment[];
  language: string;
  note?: string;
}) {
  const { t } = useTranslation("restore");
  return (
    <section aria-labelledby="restore-attachments-title" className="space-y-2">
      <h3 id="restore-attachments-title" className="text-sm font-semibold">
        {t("details.reading.attachmentsCount", { count: attachments.length })}
      </h3>
      {attachments.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("details.reading.attachmentsEmpty")}</p>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border">
          {attachments.map((attachment) => {
            const name = attachment.filename ?? t("details.reading.attachmentsUnnamed");
            return (
              <li key={attachment.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                <p className="min-w-0 flex-1 truncate">
                  {t("details.reading.downloadSize", {
                    name,
                    size: formatBytes(attachment.size, language),
                  })}
                </p>
                {hrefOf ? (
                  <a
                    href={hrefOf(attachment.id)}
                    className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    aria-label={t("details.reading.download", { name })}
                  >
                    <Download className="size-4" aria-hidden="true" />
                  </a>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {note && attachments.length > 0 ? (
        <p className="text-xs text-muted-foreground">{note}</p>
      ) : null}
    </section>
  );
}
