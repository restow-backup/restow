import { useBlocker } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { ConfirmDialog } from "@/components/kit";

/**
 * Asks before an in-app navigation leaves the wizard while files are still
 * uploading: leaving unmounts the upload manager, which pauses every upload
 * (use-upload-manager.ts). Closing or reloading the tab is asked by the
 * browser itself (`beforeunload`, in the manager), so this guard only covers
 * navigation inside the app. "Stay" keeps the uploads running.
 */
export function UploadLeaveGuard({ busy }: { busy: boolean }) {
  const { t } = useTranslation("imports");
  const blocker = useBlocker({
    shouldBlockFn: () => true,
    disabled: !busy,
    enableBeforeUnload: false,
    withResolver: true,
  });
  return (
    <ConfirmDialog
      open={blocker.status === "blocked"}
      onOpenChange={(open) => {
        if (!open) {
          blocker.reset?.();
        }
      }}
      title={t("leave.title")}
      description={t("leave.description")}
      cancelLabel={t("leave.stay")}
      confirmLabel={t("leave.confirm")}
      destructive
      onConfirm={() => {
        blocker.proceed?.();
      }}
    />
  );
}
