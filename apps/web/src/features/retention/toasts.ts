import type { TFunction } from "i18next";

import { toast } from "@/components/ui/sonner";

/**
 * The feedback of a successful change on the retention page, as a sonner
 * toast. `t` is bound to the retention namespace. A failed change is never
 * silent, but it is shown inside the sheet or the ConfirmDialog that
 * triggered it (both keep themselves open with the mapped cause on
 * failure — see apps/web/src/components/kit/confirm-dialog.tsx), so there is
 * no separate failure toast here.
 */

export type PolicyChange = "created" | "updated" | "deleted";

export function toastChanged(t: TFunction, change: PolicyChange, name: string): void {
  toast.success(t(`toasts.${change}`, { name }));
}
