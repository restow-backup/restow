import {
  CircleAlert,
  CircleCheck,
  CircleX,
  FileUp,
  Loader2,
  RotateCw,
  Trash2,
  Upload,
} from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { useJobFormat } from "@/features/jobs/use-format";
import { ProgressBar } from "@/features/restore/components/progress-bar";
import { formatBytes, formatDateTime, formatInteger } from "@/lib/format";
import { cn } from "@/lib/utils";
import { FormatBadge } from "../components/format-badge";
import type { ImportConfig, ImportUploadDto } from "../types";
import { itemRatio } from "../upload/progress";
import { receivedRatio } from "../upload/resume";
import type { UploadErrorCode, UploadItem } from "../upload/types";
import type { UploadManager } from "../upload/use-upload-manager";
import { extractDroppedFiles, hasFiles } from "./dropped-files";

interface UploadPanelProps {
  manager: UploadManager;
  config: ImportConfig;
  /** Uploads the server still holds from earlier visits. */
  unfinished: readonly ImportUploadDto[];
  onDiscardUnfinished: (uploadId: string) => void;
  discarding: boolean;
}

/**
 * Step "files" for the upload origin: a drop zone and file picker, the list of
 * files with their progress, and the unfinished uploads from earlier visits.
 * Upload starts as soon as files are added; the wizard can move on while it
 * runs.
 */
export function UploadPanel({
  manager,
  config,
  unfinished,
  onDiscardUnfinished,
  discarding,
}: UploadPanelProps) {
  const { t, i18n } = useTranslation("imports");
  const language = i18n.resolvedLanguage ?? i18n.language;
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = React.useState(false);

  const add = (files: readonly File[], directories = 0) => {
    if (directories > 0) {
      toast.warning(t("upload.folderDropped", { count: directories }));
    }
    if (files.length === 0) {
      return;
    }
    const result = manager.addFiles(files);
    if (result.duplicates > 0) {
      toast.info(t("upload.duplicates", { count: result.duplicates }));
    }
  };

  const inUse = new Set(manager.items.map((item) => item.uploadId).filter(Boolean));
  const leftovers = unfinished.filter((upload) => !inUse.has(upload.id));

  return (
    <div className="space-y-5">
      <div
        onDragEnter={(event) => {
          if (hasFiles(event.dataTransfer)) {
            event.preventDefault();
            setDragging(true);
          }
        }}
        onDragOver={(event) => {
          if (hasFiles(event.dataTransfer)) {
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
          }
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            setDragging(false);
          }
        }}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          const dropped = extractDroppedFiles(event.dataTransfer);
          add(dropped.files, dropped.directories);
        }}
        data-dragging={dragging || undefined}
        className={cn(
          "flex flex-col items-center gap-3 rounded-lg border border-dashed border-border px-6 py-8 text-center transition-colors",
          dragging && "border-primary bg-primary/5",
        )}
      >
        <span className="flex size-11 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <Upload aria-hidden="true" className="size-5" />
        </span>
        <div className="space-y-1">
          <p className="text-sm font-medium">
            {dragging ? t("upload.dropActive") : t("upload.dropTitle")}
          </p>
          <p className="text-xs text-muted-foreground">
            {t("upload.limit", { size: formatBytes(config.maxFileBytes, language) })}
          </p>
        </div>
        <Button variant="outline" onClick={() => inputRef.current?.click()}>
          <FileUp />
          {t("upload.pick")}
        </Button>
        <input
          ref={inputRef}
          type="file"
          multiple
          className="sr-only"
          tabIndex={-1}
          aria-label={t("upload.pick")}
          data-testid="file-input"
          onChange={(event) => {
            add(Array.from(event.target.files ?? []));
            // The same file can be picked again after it was removed.
            event.target.value = "";
          }}
        />
      </div>

      {manager.items.length > 0 ? <UploadList manager={manager} config={config} /> : null}

      {leftovers.length > 0 ? (
        <UnfinishedUploads
          uploads={leftovers}
          onUse={manager.addReadyUpload}
          onDiscard={onDiscardUnfinished}
          discarding={discarding}
        />
      ) : null}
    </div>
  );
}

// --- The list --------------------------------------------------------------------------

function UploadList({ manager, config }: { manager: UploadManager; config: ImportConfig }) {
  const { t, i18n } = useTranslation("imports");
  const jobFormat = useJobFormat();
  const language = i18n.resolvedLanguage ?? i18n.language;
  const { progress } = manager;
  const visible = manager.items.filter((item) => item.status !== "cancelled");

  return (
    <section aria-label={t("upload.list.title")} className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{t("upload.list.title")}</h3>
        <Button variant="ghost" size="sm" onClick={manager.cancelAll}>
          <Trash2 />
          {t("upload.list.removeAll")}
        </Button>
      </div>

      {progress.files > 1 || progress.busy ? (
        <div className="space-y-1.5 rounded-lg border border-border p-3" data-testid="overall">
          <ProgressBar
            ratio={progress.ratio}
            label={t("upload.overall.label")}
            tone={progress.filesFailed > 0 ? "destructive" : "default"}
          />
          <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs tabular-nums text-muted-foreground">
            <span>
              {t("upload.overall.files", {
                done: formatInteger(progress.filesDone, language),
                total: formatInteger(progress.files, language),
              })}
            </span>
            <span>
              {t("upload.overall.bytes", {
                sent: formatBytes(progress.uploadedBytes, language),
                total: formatBytes(progress.totalBytes, language),
                percent: formatInteger(Math.floor(progress.ratio * 100), language),
              })}
            </span>
            {progress.busy && progress.bytesPerSecond ? (
              <span>
                {t("upload.overall.speed", {
                  speed: formatBytes(progress.bytesPerSecond, language),
                })}
              </span>
            ) : null}
            {progress.busy && progress.etaSeconds !== null ? (
              <span>
                {t("upload.overall.eta", { duration: jobFormat.duration(progress.etaSeconds) })}
              </span>
            ) : null}
          </div>
        </div>
      ) : null}

      <ul className="divide-y divide-border rounded-lg border border-border">
        {visible.map((item) => (
          <UploadRow key={item.localId} item={item} manager={manager} config={config} />
        ))}
      </ul>
    </section>
  );
}

const ERROR_KEY: Record<UploadErrorCode, string> = {
  network: "upload.errors.network",
  server: "upload.errors.server",
  unauthorized: "upload.errors.unauthorized",
  forbidden: "upload.errors.forbidden",
  too_large: "upload.errors.tooLarge",
  empty: "upload.errors.empty",
  gone: "upload.errors.gone",
  staging_full: "upload.errors.stagingFull",
  conflict: "upload.errors.conflict",
  corrupt: "upload.errors.corrupt",
  invalid: "upload.errors.invalid",
  unreadable: "upload.errors.unreadable",
  unknown: "upload.errors.unknown",
};

/** Errors that trying the same file again cannot fix. */
const FINAL_ERRORS: ReadonlySet<UploadErrorCode> = new Set(["too_large", "empty", "forbidden"]);

function UploadRow({
  item,
  manager,
  config,
}: {
  item: UploadItem;
  manager: UploadManager;
  config: ImportConfig;
}) {
  const { t, i18n } = useTranslation("imports");
  const language = i18n.resolvedLanguage ?? i18n.language;
  const ratio = itemRatio(item);
  const percent = Math.floor(ratio * 100);

  return (
    <li className="space-y-2 px-3 py-3" data-status={item.status}>
      <div className="flex items-start gap-3">
        <RowIcon status={item.status} />
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="min-w-0 truncate text-sm font-medium" title={item.name}>
              {item.name}
            </span>
            <span className="text-xs tabular-nums text-muted-foreground">
              {formatBytes(item.size, language)}
            </span>
            {item.status === "ready" || item.status === "refused" ? (
              <FormatBadge format={item.detectedFormat} />
            ) : null}
            {item.resumed && item.status !== "failed" ? (
              <Badge variant="info">{t("upload.item.resumed")}</Badge>
            ) : null}
          </div>

          {item.status === "uploading" ||
          item.status === "opening" ||
          item.status === "completing" ? (
            <>
              <ProgressBar
                ratio={item.status === "uploading" ? ratio : null}
                label={t("upload.item.progressLabel", { name: item.name })}
              />
              <p className="text-xs tabular-nums text-muted-foreground" aria-live="off">
                {item.status === "opening" ? t("upload.item.status.opening") : null}
                {item.status === "completing" ? t("upload.item.status.completing") : null}
                {item.status === "uploading"
                  ? t("upload.item.sent", {
                      percent: formatInteger(percent, language),
                      sent: formatBytes(item.uploadedBytes, language),
                      total: formatBytes(item.size, language),
                    })
                  : null}
                {item.retrying
                  ? ` · ${t("upload.item.retrying", {
                      attempt: item.retrying.attempt,
                      seconds: Math.max(1, Math.round(item.retrying.delayMs / 1000)),
                    })}`
                  : null}
              </p>
            </>
          ) : null}
          {item.status === "queued" ? (
            <p className="text-xs text-muted-foreground">{t("upload.item.status.queued")}</p>
          ) : null}
          {item.status === "ready" ? (
            <p className="text-xs text-foreground">{t("upload.item.status.ready")}</p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {item.status === "failed" && item.error && !FINAL_ERRORS.has(item.error) ? (
            <Button variant="outline" size="sm" onClick={() => manager.retry(item.localId)}>
              <RotateCw />
              {t("upload.item.retry")}
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => manager.remove(item.localId)}
            aria-label={t("upload.item.remove", { name: item.name })}
            title={t("upload.item.remove", { name: item.name })}
          >
            <Trash2 />
          </Button>
        </div>
      </div>

      {item.status === "failed" && item.error ? (
        <Alert variant="destructive">
          <CircleX />
          <AlertDescription>
            {t(ERROR_KEY[item.error], { limit: formatBytes(config.maxFileBytes, language) })}
          </AlertDescription>
        </Alert>
      ) : null}
      {item.status === "refused" ? <RefusalNotice item={item} /> : null}
    </li>
  );
}

function RowIcon({ status }: { status: UploadItem["status"] }) {
  const className = "mt-0.5 size-4 shrink-0";
  switch (status) {
    case "ready":
      return <CircleCheck aria-hidden="true" className={cn(className, "text-foreground")} />;
    case "refused":
      return (
        <CircleAlert
          aria-hidden="true"
          className={cn(className, "text-warning-foreground dark:text-warning")}
        />
      );
    case "failed":
      return <CircleX aria-hidden="true" className={cn(className, "text-destructive")} />;
    case "queued":
      return <FileUp aria-hidden="true" className={cn(className, "text-muted-foreground")} />;
    default:
      return (
        <Loader2
          aria-hidden="true"
          className={cn(className, "text-muted-foreground motion-safe:animate-spin")}
        />
      );
  }
}

/** A file the server recognised and does not import (PST/OST, or not a mail file). */
function RefusalNotice({ item }: { item: UploadItem }) {
  const { t } = useTranslation("imports");
  const code = item.refusal?.code ?? "unrecognised";
  return (
    <Alert variant="warning">
      <CircleAlert />
      <AlertTitle>{t(`upload.refusal.${code}.title`)}</AlertTitle>
      <AlertDescription className="space-y-1">
        <p>{t(`upload.refusal.${code}.description`)}</p>
        <p className="text-muted-foreground">{t("upload.refusal.notImported")}</p>
      </AlertDescription>
    </Alert>
  );
}

// --- Earlier uploads -------------------------------------------------------------------

function UnfinishedUploads({
  uploads,
  onUse,
  onDiscard,
  discarding,
}: {
  uploads: readonly ImportUploadDto[];
  onUse: (upload: ImportUploadDto) => void;
  onDiscard: (uploadId: string) => void;
  discarding: boolean;
}) {
  const { t, i18n } = useTranslation("imports");
  const language = i18n.resolvedLanguage ?? i18n.language;
  return (
    <section aria-label={t("upload.unfinished.title")} className="space-y-2">
      <div className="space-y-0.5">
        <h3 className="text-sm font-semibold">{t("upload.unfinished.title")}</h3>
        <p className="text-xs text-muted-foreground">{t("upload.unfinished.description")}</p>
      </div>
      <ul className="divide-y divide-border rounded-lg border border-border">
        {uploads.map((upload) => {
          const complete = upload.status === "ready";
          return (
            <li key={upload.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
              <div className="min-w-0 flex-1 space-y-0.5">
                <p className="truncate text-sm font-medium" title={upload.fileName}>
                  {upload.fileName}
                </p>
                <p className="text-xs tabular-nums text-muted-foreground">
                  {formatBytes(upload.size, language)}
                  {" · "}
                  {complete
                    ? t("upload.unfinished.complete")
                    : t("upload.unfinished.received", {
                        percent: formatInteger(Math.floor(receivedRatio(upload) * 100), language),
                      })}
                  {upload.expiresAt
                    ? ` · ${t("upload.unfinished.expires", {
                        date: formatDateTime(upload.expiresAt, language) ?? "",
                      })}`
                    : ""}
                </p>
                {complete ? null : (
                  <p className="text-xs text-muted-foreground">
                    {t("upload.unfinished.pickAgain")}
                  </p>
                )}
              </div>
              {complete ? (
                <Button variant="outline" size="sm" onClick={() => onUse(upload)}>
                  {t("upload.unfinished.use")}
                </Button>
              ) : null}
              <Button
                variant="ghost"
                size="sm"
                disabled={discarding}
                onClick={() => onDiscard(upload.id)}
              >
                <Trash2 />
                {t("upload.unfinished.discard")}
              </Button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
