import { Link } from "@tanstack/react-router";
import { Ban, Download, MailSearch } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { Button, type ButtonProps, buttonVariants } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "@/components/ui/sonner";
import { RESTORE_PATHS, restoreTo } from "@/features/restore/navigation";
import { errorMessageKey } from "@/lib/api";
import { buildReportJson, downloadTextFile, reportFileName } from "../lib/download";
import { isCancellable } from "../presenters";
import type { ImportDetail, ImportSummary } from "../types";
import { useCancelImport } from "../use-imports";

/** Cancels a queued or running import after a confirmation. */
export function CancelImportButton({
  job,
  size = "sm",
}: {
  job: Pick<ImportSummary, "id" | "status"> & { archive?: boolean };
  size?: ButtonProps["size"];
}) {
  const { t } = useTranslation("imports");
  const { t: tAny } = useTranslation();
  const [open, setOpen] = React.useState(false);
  const cancel = useCancelImport();

  if (!isCancellable(job)) {
    return null;
  }
  const confirm = () =>
    cancel.mutate(job.id, {
      onSuccess: () => {
        setOpen(false);
        toast.success(t("cancel.done"));
      },
      onError: (error) => {
        setOpen(false);
        toast.error(t("cancel.failed"), { description: tAny(errorMessageKey(error)) });
      },
    });

  return (
    <>
      <Button variant="outline" size={size} onClick={() => setOpen(true)}>
        <Ban />
        {t("cancel.action")}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("cancel.title")}</DialogTitle>
            <DialogDescription>{t("cancel.description")}</DialogDescription>
            {job.archive ? (
              <p className="text-sm text-muted-foreground">{t("cancel.archiveNote")}</p>
            ) : null}
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={cancel.isPending}>
              {t("cancel.keep")}
            </Button>
            <Button variant="destructive" onClick={confirm} loading={cancel.isPending}>
              {t("cancel.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Opens the imported mailbox (at the snapshot this import wrote) in the restore explorer. */
export function OpenInExplorerLink({
  detail,
  size = "sm",
}: {
  detail: Pick<ImportDetail, "objectId" | "status" | "report">;
  size?: ButtonProps["size"];
}) {
  const { t } = useTranslation("imports");
  const snapshotId = detail.report?.snapshotId ?? null;
  if (detail.status !== "completed" || snapshotId === null) {
    return null;
  }
  return (
    <Link
      to={restoreTo(RESTORE_PATHS.explorer)}
      search={{ object: detail.objectId, snapshot: snapshotId } as never}
      className={buttonVariants({ size })}
    >
      <MailSearch />
      {t("job.openExplorer")}
    </Link>
  );
}

/** Saves the report of a finished import as a JSON file. */
export function DownloadReportButton({
  detail,
  size = "sm",
}: {
  detail: ImportDetail;
  size?: ButtonProps["size"];
}) {
  const { t } = useTranslation("imports");
  if (!detail.report) {
    return null;
  }
  return (
    <Button
      variant="outline"
      size={size}
      onClick={() =>
        downloadTextFile(reportFileName(detail.name, new Date()), buildReportJson(detail))
      }
    >
      <Download />
      {t("job.downloadReport")}
    </Button>
  );
}
