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

import type { ProvisionResult } from "../types";
import { ConnectedSetPasswordLinkField } from "./set-password-link-field";

interface CopyLinkDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  result: ProvisionResult | null;
}

/**
 * Shows a freshly (re)issued set-password link once, with a copy button
 * ("Copy new link" / "Resend" on the members panel's pending accounts).
 */
export function CopyLinkDialog({ open, onOpenChange, result }: CopyLinkDialogProps) {
  const { t } = useTranslation(["accounts", "common"]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("accounts:provision.linkDialog.title")}</DialogTitle>
          <DialogDescription>
            {result
              ? t("accounts:provision.linkDialog.description", { email: result.email })
              : null}
          </DialogDescription>
        </DialogHeader>
        {result ? (
          <ConnectedSetPasswordLinkField id="reissued-set-password-link" result={result} />
        ) : null}
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>{t("common:actions.close")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
