import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Download, Trash2 } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { useConfirmIdentity } from "@/components/confirm-identity-dialog";
import { ConfirmDialog } from "@/components/kit";
import { RelativeTime } from "@/components/kit/relative-time";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { startBrowserDownload } from "@/features/restore/files/browser-download";
import { ApiError, errorMessageKey } from "@/lib/api";
import { formatBytes } from "@/lib/format";
import { isRecentSignInRequired } from "@/lib/recent-sign-in";

import { type DumpInfo, deleteDump, requestDumpDownload, type UpdatesView } from "../api";
import { updatesKeys } from "../hooks";

/**
 * The database backups the updater keeps (one is taken before every update). The owner
 * downloads or deletes one; both ask for a recent sign-in, and both are written to the
 * audit log. A backup holds the whole database, the encrypted secrets included, so the
 * download says so first. It is a link the browser saves as it streams in: the api first
 * issues a one-time link (that request is the one that asks to confirm it is you).
 */
export function DumpsList({
  dumps,
  canChange = false,
  busy = false,
}: {
  dumps: readonly DumpInfo[];
  /** The viewer is the provider owner (and this is not the demo). */
  canChange?: boolean;
  /** An update is announced or running: nothing is deleted then. */
  busy?: boolean;
}) {
  const { t, i18n } = useTranslation("updates");
  const { t: tc } = useTranslation();
  const language = i18n.resolvedLanguage ?? i18n.language;
  const queryClient = useQueryClient();
  const identity = useConfirmIdentity();
  const [downloading, setDownloading] = React.useState<DumpInfo | null>(null);
  const [deleting, setDeleting] = React.useState<DumpInfo | null>(null);

  const download = useMutation({ mutationFn: (file: string) => requestDumpDownload(file) });
  const remove = useMutation({
    mutationFn: (file: string) => deleteDump(file),
    onSuccess: (view: UpdatesView) => queryClient.setQueryData(updatesKeys.view, view),
  });

  const startDownload = (dump: DumpInfo) => {
    download.mutate(dump.file, {
      onSuccess: (link) => {
        setDownloading(null);
        startBrowserDownload(link.url);
      },
      onError: (error) => {
        if (isRecentSignInRequired(error)) {
          setDownloading(null);
          identity.ask(() => startDownload(dump));
        }
      },
    });
  };

  const startDelete = (dump: DumpInfo) => {
    remove.mutate(dump.file, {
      onSuccess: () => setDeleting(null),
      onError: (error) => {
        if (isRecentSignInRequired(error)) {
          setDeleting(null);
          identity.ask(() => startDelete(dump));
        }
      },
    });
  };

  const failed = [download, remove].find(
    (mutation) => mutation.isError && !isRecentSignInRequired(mutation.error),
  );

  return (
    <section className="space-y-2" data-slot="dumps">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold">{t("dumps.title")}</h3>
        <p className="text-sm text-muted-foreground">{t("dumps.description")}</p>
      </div>
      {dumps.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-slot="dumps-empty">
          {t("dumps.empty")}
        </p>
      ) : (
        <div className="rounded-md border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("dumps.file")}</TableHead>
                <TableHead className="text-right">{t("dumps.size")}</TableHead>
                <TableHead className="text-right">{t("dumps.created")}</TableHead>
                {canChange ? (
                  <TableHead className="text-right">
                    <span className="sr-only">{t("dumps.actions")}</span>
                  </TableHead>
                ) : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {dumps.map((dump) => (
                <TableRow key={dump.file} data-slot="dump" data-file={dump.file}>
                  <TableCell className="font-mono text-xs [overflow-wrap:anywhere]">
                    {dump.file}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatBytes(dump.bytes, language)}
                  </TableCell>
                  <TableCell className="text-right">
                    <RelativeTime value={dump.createdAt} />
                  </TableCell>
                  {canChange ? (
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={t("dumps.download", { file: dump.file })}
                          disabled={download.isPending}
                          onClick={() => setDownloading(dump)}
                        >
                          <Download />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={t("dumps.delete", { file: dump.file })}
                          disabled={busy || remove.isPending}
                          onClick={() => setDeleting(dump)}
                        >
                          <Trash2 />
                        </Button>
                      </div>
                    </TableCell>
                  ) : null}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {failed ? (
        <p className="text-sm text-destructive" role="alert">
          {failed.error instanceof ApiError &&
          failed.error.problem?.type === "urn:restow:problem:dump-protected"
            ? t("dumps.protected")
            : tc(errorMessageKey(failed.error))}
        </p>
      ) : null}
      <ConfirmDialog
        open={downloading !== null}
        onOpenChange={(open) => {
          if (!open && !download.isPending) {
            setDownloading(null);
          }
        }}
        title={t("dumps.downloadTitle")}
        description={t("dumps.downloadDescription", {
          file: downloading?.file ?? "",
          size: formatBytes(downloading?.bytes ?? 0, language),
        })}
        confirmLabel={t("dumps.downloadAction")}
        pending={download.isPending}
        onConfirm={() => {
          if (downloading) {
            startDownload(downloading);
          }
        }}
      />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open && !remove.isPending) {
            setDeleting(null);
          }
        }}
        title={t("dumps.deleteTitle")}
        description={t("dumps.deleteDescription", { file: deleting?.file ?? "" })}
        confirmLabel={t("dumps.deleteAction")}
        destructive
        pending={remove.isPending}
        onConfirm={() => {
          if (deleting) {
            startDelete(deleting);
          }
        }}
      />
      {identity.dialog}
    </section>
  );
}
