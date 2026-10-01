import { Ban, Download } from "lucide-react";
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
import { type RestoreJob, restoreDownloadUrl } from "@/features/restore/api";
import { isCancellable } from "@/features/restore/lib/jobs";
import { useActiveTenantId, useCancelRestore } from "@/features/restore/use-restore-data";
import { errorMessageKey } from "@/lib/api";
import { formatDateTime } from "@/lib/format";

/**
 * Downloads the ZIP of a finished download restore. A plain link: the browser
 * streams the archive to disk and shows its own progress.
 */
export function DownloadArchiveLink({
  job,
  size = "sm",
}: {
  job: Pick<RestoreJob, "id" | "download">;
  size?: ButtonProps["size"];
}) {
  const { t, i18n } = useTranslation("restore");
  const language = i18n.resolvedLanguage ?? i18n.language;
  const tenantId = useActiveTenantId();
  if (!job.download.available) {
    return null;
  }
  return (
    <a
      href={restoreDownloadUrl(job.id, tenantId)}
      download
      onClick={(event) => event.stopPropagation()}
      className={buttonVariants({ size })}
      title={t("jobs.download.until", {
        date: formatDateTime(job.download.expiresAt, language) ?? "",
      })}
    >
      <Download />
      {t("jobs.download.action")}
    </a>
  );
}

/** Cancels a queued or running restore after a confirmation; what is restored stays. */
export function CancelRestoreButton({
  job,
  size = "sm",
}: {
  job: Pick<RestoreJob, "id" | "status">;
  size?: ButtonProps["size"];
}) {
  const { t } = useTranslation("restore");
  const { t: tAny } = useTranslation();
  const [open, setOpen] = React.useState(false);
  const cancel = useCancelRestore();

  if (!isCancellable(job)) {
    return null;
  }
  const confirm = () =>
    cancel.mutate(job.id, {
      onSuccess: () => {
        setOpen(false);
        toast.success(t("jobs.cancel.done"));
      },
      onError: (error) => {
        setOpen(false);
        toast.error(t("jobs.cancel.failed"), { description: tAny(errorMessageKey(error)) });
      },
    });

  return (
    <>
      <Button
        variant="outline"
        size={size}
        onClick={(event) => {
          event.stopPropagation();
          setOpen(true);
        }}
      >
        <Ban />
        {t("jobs.cancel.action")}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent onClick={(event) => event.stopPropagation()}>
          <DialogHeader>
            <DialogTitle>{t("jobs.cancel.title")}</DialogTitle>
            <DialogDescription>{t("jobs.cancel.description")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={cancel.isPending}>
              {t("jobs.cancel.keep")}
            </Button>
            <Button variant="destructive" onClick={confirm} loading={cancel.isPending}>
              {t("jobs.cancel.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
