import { Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { formatDateTime } from "@/lib/format";

import type { EndpointDetail } from "../api.js";
import { useCancelRemoval, useMayDeleteBackups } from "../hooks.js";
import { endpointErrorKey } from "../presenters.js";

/**
 * "Backups will be deleted on <date>" (0.5.0): a provider owner asked to delete every backup of
 * this revoked machine. Shown on the machine page and in File restore until the worker starts,
 * with who asked and why; a provider owner can cancel it from here. Nothing for a machine
 * without a pending deletion.
 */
export function BackupDeletionNotice({
  detail,
}: {
  detail: Pick<EndpointDetail, "id" | "backupDeletion">;
}) {
  const { t, i18n } = useTranslation("endpoints");
  const mayCancel = useMayDeleteBackups();
  const cancel = useCancelRemoval(detail.id);
  const pending = detail.backupDeletion;
  if (!pending) {
    return null;
  }
  const date = formatDateTime(pending.dueAt, i18n.language) ?? pending.dueAt;
  return (
    <Alert variant="destructive" data-slot="backup-deletion">
      <Trash2 />
      <AlertTitle>{t("backupDeletion.title", { date })}</AlertTitle>
      <AlertDescription>
        <p>
          {t("backupDeletion.requested", {
            person: pending.requestedBy,
            date: formatDateTime(pending.requestedAt, i18n.language) ?? pending.requestedAt,
          })}
        </p>
        {pending.reason ? <p>{t("backupDeletion.reason", { reason: pending.reason })}</p> : null}
        {pending.state === "held" ? (
          <p data-slot="backup-deletion-held">
            {t(
              pending.heldBy === "suspicion"
                ? "backupDeletion.heldSuspicion"
                : "backupDeletion.heldLegal",
            )}
          </p>
        ) : null}
        {mayCancel ? (
          <div className="mt-2 space-y-2">
            <Button
              size="sm"
              variant="outline"
              loading={cancel.isPending}
              data-action="cancel-backup-deletion"
              onClick={() =>
                cancel.mutate(undefined, {
                  onSuccess: () => toast.success(t("backupDeletion.cancelled")),
                })
              }
            >
              {t("backupDeletion.cancel")}
            </Button>
            {cancel.isError ? <p>{t(endpointErrorKey(cancel.error))}</p> : null}
          </div>
        ) : (
          <p>{t("backupDeletion.ownerCancels")}</p>
        )}
      </AlertDescription>
    </Alert>
  );
}
