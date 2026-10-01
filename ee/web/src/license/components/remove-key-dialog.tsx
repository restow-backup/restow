import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "@/components/ui/sonner";

import type { Edition } from "../edition";
import { licenseErrorMessage } from "../presenters";
import { useRemoveLicense } from "../use-license";

interface RemoveKeyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The edition that applies once the key is gone. */
  fallbackEdition: Edition;
}

/** Confirms removing the installed key and says which edition applies afterwards. */
export function RemoveKeyDialog({ open, onOpenChange, fallbackEdition }: RemoveKeyDialogProps) {
  const { t } = useTranslation("license");
  const { t: tc } = useTranslation();
  const remove = useRemoveLicense();

  const confirm = () => {
    remove.mutate(undefined, {
      onSuccess: () => {
        toast.success(t("toasts.removed"));
        onOpenChange(false);
      },
      onError: (error) => {
        const message = licenseErrorMessage(error);
        toast.error(t(message.key, message.values));
      },
    });
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !remove.isPending && onOpenChange(next)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("remove.title")}</DialogTitle>
          <DialogDescription>
            {t("remove.description", { edition: fallbackEdition })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={remove.isPending}>
            {tc("actions.cancel")}
          </Button>
          <Button variant="destructive" onClick={confirm} loading={remove.isPending}>
            {t("remove.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
