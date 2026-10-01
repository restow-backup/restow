import * as React from "react";
import { useTranslation } from "react-i18next";

import type { RestoreJob, SelectionSummary } from "@/features/restore/api";
import { objectLabel } from "@/features/restore/explorer/entry-icon";

/** How a restore request is put into words, the same in the list and on the detail page. */
export function useJobText() {
  const { t } = useTranslation("restore");
  return React.useMemo(
    () => ({
      selection: (selection: SelectionSummary): string => {
        if (selection.all) {
          return t("jobs.selection.all");
        }
        return [
          selection.folders > 0
            ? t("explorer.selection.folders", { count: selection.folders })
            : null,
          selection.items > 0 ? t("explorer.selection.items", { count: selection.items }) : null,
        ]
          .filter(Boolean)
          .join(", ");
      },
      target: (target: RestoreJob["target"]): string =>
        target.type === "other"
          ? t("jobs.target.other", { ref: target.ref ?? "" })
          : t(`jobs.target.${target.type}`),
      mode: (mode: RestoreJob["mode"]): string => t(`jobs.mode.${mode}`),
      actor: (actor: RestoreJob["actor"]): string =>
        actor.name ?? actor.email ?? t("jobs.actorUnknown"),
      object: (job: Pick<RestoreJob, "object">): string =>
        job.object ? objectLabel(job.object) : t("jobs.objectGone"),
    }),
    [t],
  );
}
