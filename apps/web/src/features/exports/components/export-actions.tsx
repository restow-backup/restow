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
import { type MailExport, exportDownloadUrl } from "@/features/exports/api";
import { downloadState, expiryOf, isCancellable } from "@/features/exports/lib/exports";
import { useActiveTenantId, useCancelExport } from "@/features/exports/use-exports-data";
import { errorMessageKey } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * Downloads the file of a finished export. A plain link: the browser streams
 * the file to disk and shows its own progress. Once the link has expired the
 * button stays, disabled, so it is clear why nothing can be downloaded; the
 * page around it says why.
 */
export function DownloadExportButton({
  item,
  now,
  size = "sm",
  className,
  showWhenPending = false,
}: {
  item: Pick<MailExport, "id" | "status" | "available" | "expiresAt">;
  now: number;
  size?: ButtonProps["size"];
  className?: string;
  /** Render a disabled button while the export has no file yet (the detail page). */
  showWhenPending?: boolean;
}) {
  const { t, i18n } = useTranslation("exports");
  const language = i18n.resolvedLanguage ?? i18n.language;
  const tenantId = useActiveTenantId();
  const state = downloadState(item, now);

  if (state === "none" || (state === "pending" && !showWhenPending)) {
    return null;
  }
  if (state !== "ready") {
    return (
      <Button size={size} className={className} disabled>
        <Download />
        {t("download.action")}
      </Button>
    );
  }
  const expiry = expiryOf(item.expiresAt, now);
  return (
    <a
      href={exportDownloadUrl(item.id, tenantId)}
      download
      onClick={(event) => event.stopPropagation()}
      className={cn(buttonVariants({ size }), className)}
      title={
        expiry.kind === "none"
          ? undefined
          : t("download.until", { date: formatDateTime(item.expiresAt, language) ?? "" })
      }
    >
      <Download />
      {t("download.action")}
    </a>
  );
}

/** Cancels a queued or running export after a confirmation; nothing is kept. */
export function CancelExportButton({
  item,
  size = "sm",
}: {
  item: Pick<MailExport, "id" | "status">;
  size?: ButtonProps["size"];
}) {
  const { t } = useTranslation("exports");
  const { t: tAny } = useTranslation();
  const [open, setOpen] = React.useState(false);
  const cancel = useCancelExport();

  if (!isCancellable(item)) {
    return null;
  }
  const confirm = () =>
    cancel.mutate(item.id, {
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
      <Button
        variant="outline"
        size={size}
        onClick={(event) => {
          event.stopPropagation();
          setOpen(true);
        }}
      >
        <Ban />
        {t("cancel.action")}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent onClick={(event) => event.stopPropagation()}>
          <DialogHeader>
            <DialogTitle>{t("cancel.title")}</DialogTitle>
            <DialogDescription>{t("cancel.description")}</DialogDescription>
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
