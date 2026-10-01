import { useTranslation } from "react-i18next";

import { ConfirmDialog } from "@/components/kit";

import type { RetentionPolicy } from "../api.js";

export interface DeletePolicyDialogProps {
  policy: RetentionPolicy | null;
  onCancel: () => void;
  onConfirm: (policy: RetentionPolicy) => Promise<void>;
}

/**
 * Confirms before a policy is removed. Deleting the tenant default simply
 * stops pruning; deleting an object override does not — the objects it
 * governed fall back to the tenant default, which may prune more, so that
 * case gets its own, different wording (never the "no longer prune" claim).
 */
export function DeletePolicyDialog({ policy, onCancel, onConfirm }: DeletePolicyDialogProps) {
  const { t } = useTranslation("retention");
  return (
    <ConfirmDialog
      open={policy !== null}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      title={t("confirm.deleteTitle")}
      description={t(
        policy?.isDefault ? "confirm.deleteDescription" : "confirm.deleteDescriptionOverride",
        { name: policy?.name ?? "" },
      )}
      confirmLabel={t("confirm.deleteConfirm")}
      destructive
      onConfirm={() => policy && onConfirm(policy)}
    />
  );
}
