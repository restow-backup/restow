import * as React from "react";
import { useTranslation } from "react-i18next";

import type { ExportFormatId, MailExport } from "@/features/exports/api";
import { objectLabel } from "@/features/restore/explorer/entry-icon";

/** How an export is put into words, the same in the list and on the detail page. */
export function useExportText() {
  const { t } = useTranslation("exports");
  return React.useMemo(
    () => ({
      formatShort: (format: ExportFormatId): string => t(`formats.${format}.short`),
      formatLabel: (format: ExportFormatId): string => t(`formats.${format}.label`),
      actor: (actor: MailExport["actor"]): string => actor.name ?? actor.email ?? t("actorUnknown"),
      /** The mailbox an export was taken from, or the archive. */
      source: (item: Pick<MailExport, "origin" | "object">): string =>
        item.origin === "archive"
          ? t("origin.archive")
          : item.object
            ? objectLabel(item.object)
            : t("origin.objectGone"),
      selection: (item: Pick<MailExport, "origin" | "selection">): string => {
        const { folders, items } = item.selection;
        const parts = [
          folders !== null && folders > 0 ? t("selection.folders", { count: folders }) : null,
          items !== null && items > 0 ? t("selection.items", { count: items }) : null,
        ].filter(Boolean);
        if (parts.length > 0) {
          return parts.join(", ");
        }
        return t(item.origin === "archive" ? "selection.allArchive" : "selection.allSnapshot");
      },
    }),
    [t],
  );
}
