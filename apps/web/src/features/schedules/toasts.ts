import type { TFunction } from "i18next";

import { toast } from "@/components/ui/sonner";
import { errorMessageKey } from "@/lib/api";

import type { ScheduleKind } from "./api.js";

/**
 * The feedback of every change on the schedules page, as sonner toasts: what
 * happened in one sentence, or why it failed. `t` is bound to the schedules
 * namespace.
 */

export type ScheduleChange = "created" | "updated" | "deleted" | "enabled" | "disabled";

export function toastChanged(t: TFunction, change: ScheduleChange, kind: ScheduleKind): void {
  toast.success(t(`toasts.${change}`, { kind: t(`kinds.${kind}`) }));
}

/** How many recommended schedules were added (none when all existed). */
export function toastApplied(t: TFunction, created: number): void {
  if (created === 0) {
    toast.info(t("toasts.appliedNone"));
    return;
  }
  toast.success(t("toasts.applied", { count: created }));
}

/** A change that failed, with the mapped cause. */
export function toastFailed(t: TFunction, error: unknown): void {
  toast.error(t("toasts.failed"), { description: t(`common:${errorMessageKey(error)}`) });
}
