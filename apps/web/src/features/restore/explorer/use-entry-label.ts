import * as React from "react";
import { useTranslation } from "react-i18next";

import type { ObjectKind } from "@/features/restore/api";
import { type NamedEntry, areaOf, displayName } from "@/features/restore/lib/entries";
import { breadcrumbOf } from "@/features/restore/lib/paths";

/**
 * The label of an entry as the user reads it: translated mailbox areas
 * ("Mail", "Calendar", "Contacts") at the root, subjects for mails, names
 * without storage digests for everything else.
 */
export function useEntryLabel(objectKind: ObjectKind | null): (entry: NamedEntry) => string {
  const { t } = useTranslation("restore");
  return React.useCallback(
    (entry: NamedEntry) => {
      const area = objectKind ? areaOf(entry, objectKind) : null;
      return area ? t(`explorer.areas.${area}`) : displayName(entry);
    },
    [objectKind, t],
  );
}

/** A folder path as readable labels, e.g. "Mail › Inbox › Projects"; the root is named. */
export function useLocationLabel(objectKind: ObjectKind | null): (folderPath: string) => string {
  const { t } = useTranslation("restore");
  const label = useEntryLabel(objectKind);
  return React.useCallback(
    (folderPath: string) => {
      const crumbs = breadcrumbOf(folderPath);
      if (crumbs.length === 0) {
        return t("explorer.rootLocation");
      }
      return crumbs.map((crumb) => label({ kind: "folder", path: crumb.path })).join(" › ");
    },
    [label, t],
  );
}
