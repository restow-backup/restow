import { useTranslation } from "react-i18next";

import { ConfirmDialog } from "@/components/kit";
import { toast } from "@/components/ui/sonner";
import { storageErrorKey, targetDisplayName } from "../presenters";
import type { StorageTargetDto } from "../types";
import { useDeleteTarget } from "../use-storage";

interface DeleteTargetDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: StorageTargetDto;
}

/**
 * Remove a target from the tenant's setup: a destructive, consequential
 * action (removing a `previous` target can make older backups unreachable —
 * `delete.descriptionPrevious`), so it confirms through the shared
 * AlertDialog like every other destructive action in Restow, not a plain
 * Dialog. Restow stops writing backups to the target; the data already there
 * stays untouched (removing it is the operator's call). The API refuses to
 * remove a primary that holds data, or a `previous` target still holding
 * packs no other target has (`previous_holds_exclusive_data`), and this
 * dialog surfaces that reason instead of pretending the click always works.
 */
export function DeleteTargetDialog({ open, onOpenChange, target }: DeleteTargetDialogProps) {
  const { t } = useTranslation("storage");
  const { t: tc } = useTranslation();
  const remove = useDeleteTarget(target.id);
  const name = targetDisplayName(target, t);

  const confirm = async () => {
    await remove.mutateAsync();
    toast.success(t("toasts.deleted", { name }));
  };

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          remove.reset();
        }
        onOpenChange(next);
      }}
      title={t("delete.title", { name })}
      description={
        <>
          <p>
            {t(
              target.role === "primary"
                ? "delete.descriptionPrimary"
                : target.role === "previous"
                  ? "delete.descriptionPrevious"
                  : "delete.description",
            )}
          </p>
          <p className="text-muted-foreground">{t("delete.dataStays")}</p>
        </>
      }
      confirmLabel={t("delete.confirm")}
      destructive
      // Older backups may live only here: as final as revoking a machine, so the name is typed.
      confirmationText={target.role === "copy" ? undefined : name}
      pending={remove.isPending}
      error={remove.error ? tc(storageErrorKey(remove.error)) : undefined}
      onConfirm={confirm}
    />
  );
}
